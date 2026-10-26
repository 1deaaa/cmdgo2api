/**
 * 调用日志采集（本分支新增）
 *
 * proxy.mjs 在 forwardToCC 拿到上游响应后调用这里的 instrumentUpstreamResponse：
 * 通过 response.clone() 旁路读取一份上游 NDJSON 流，解析出 token、缓存、首字时间
 * 与错误信息，再交给 adminController.recordRequest 存入内存环形缓冲。
 *
 * 这样 OpenAI / Anthropic / Responses 三个入口都自动拥有日志，proxy.mjs 只增加
 * 一个 import 与 forwardToCC 内的一小段接线，避免在每个 handler 里重复埋点。
 *
 * 注意：本模块只负责采集；持久化、轮转与分页读取由 web/request-log-store.mjs
 * 配合 admin.mjs 完成。
 */

const MAX_ERROR_DETAIL_CHARS = 4000;
// 流式质量统计（本分支新增）：相邻两次上游读取的间隔超过该值视为疑似流停顿。
// 首个 token 之前的等待属于 TTFT（含模型思考时间），不计入停顿。
const STREAM_STALL_GAP_MS = 3000;
// 每条请求最多保留的间隔样本数，防止超长流无限占用内存；样本截断只影响百分位的精度。
const MAX_GAP_SAMPLES = 4000;

/**
 * 网关密钥遮挡：保留首尾各 2 个字符，中间替换为 **。
 * @param {unknown} value
 * @returns {string}
 */
export function maskApiKey(value) {
  const key = String(value ?? '').trim();
  if (!key) return '—';
  if (key.length <= 4) return '*'.repeat(key.length);
  return `${key.slice(0, 2)}**${key.slice(-2)}`;
}

function parseErrorBody(raw) {
  const detail = String(raw ?? '');
  let code = '';
  let message = '';
  try {
    const parsed = JSON.parse(detail);
    const error = parsed && typeof parsed === 'object' ? (parsed.error ?? parsed) : null;
    if (error && typeof error === 'object') {
      code = String(error.code ?? error.type ?? '');
      message = String(error.message ?? '');
    }
    if (!message && parsed && typeof parsed === 'object') message = String(parsed.message ?? '');
  } catch {
    // 非 JSON 错误体（例如反代返回的 HTML）直接保留原文
  }
  return { code, message, detail };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

// 流式质量统计（本分支新增）：把相邻读取间隔归纳为 p50/p95/max 与停顿次数。
function percentileOf(samples, ratio) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index]);
}

function summarizeStreamGaps(chunks, gaps, stallCount) {
  return {
    chunks,
    gapP50Ms: percentileOf(gaps, 0.5),
    gapP95Ms: percentileOf(gaps, 0.95),
    gapMaxMs: gaps.length ? Math.round(Math.max(...gaps)) : null,
    stallCount,
  };
}

function buildBaseEntry(context, startedAt) {
  return {
    at: new Date(startedAt).toISOString(),
    model: String(context.model ?? ''),
    endpoint: String(context.endpoint ?? '') || null,
    reasoningEffort: context.reasoningEffort ?? null,
    accountApiKey: String(context.accountApiKey ?? ''),
    maskedToken: maskApiKey(context.presentedKey),
    httpStatus: 0,
  };
}

/**
 * 仅用于 forwardToCC 在拿到响应之前就失败（DNS、TLS、连接重置、超时等）的场景。
 * @param {object} context
 * @param {unknown} error
 */
export function buildUpstreamFailureEntry(context, error) {
  const startedAt = Number(context?.startedAt) || Date.now();
  const aborted = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
  return {
    ...buildBaseEntry(context, startedAt),
    status: 'error',
    errorCode: aborted ? 'ABORTED' : String(error?.code || error?.name || 'UPSTREAM_ERROR'),
    errorMessage: aborted ? '请求被中止（客户端断开或超时）' : String(error?.message || '无法连接上游'),
    errorDetail: String(error?.stack || error?.message || '').slice(0, MAX_ERROR_DETAIL_CHARS),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 旁路上游响应，解析完成后通过 onRecord 回传一条日志；不改变原始响应内容。
 *
 * @param {Response} response forwardToCC 拿到的上游响应
 * @param {{ model?: string, reasoningEffort?: string|null, presentedKey?: string,
 *           accountApiKey?: string, startedAt?: number }} context
 * @param {(entry: object) => void} onRecord
 * @returns {Response} 原响应（调用方照常读取）
 */
export function instrumentUpstreamResponse(response, context, onRecord) {
  const startedAt = Number(context?.startedAt) || Date.now();
  const base = buildBaseEntry(context, startedAt);
  const report = (entry) => {
    try {
      onRecord?.(entry);
    } catch {
      // 日志写入失败绝不影响代理主流程
    }
  };

  let observer;
  try {
    observer = response.clone();
  } catch {
    return response;
  }

  if (!response.ok) {
    void observeErrorResponse(observer, { ...base, httpStatus: response.status }, startedAt, report);
    return response;
  }
  if (!observer.body) {
    report({ ...base, status: 'success', httpStatus: response.status, durationMs: Date.now() - startedAt });
    return response;
  }

  // stallGapMs 仅测试与调参使用；正常路径使用默认阈值。
  const stallGapMs = Number(context?.stallGapMs) > 0 ? Number(context.stallGapMs) : STREAM_STALL_GAP_MS;
  void observeSuccessStream(observer.body, { ...base, httpStatus: response.status }, startedAt, report, stallGapMs);
  return response;
}

async function observeErrorResponse(observer, base, startedAt, report) {
  let raw = '';
  try {
    raw = await observer.text();
  } catch {
    // 读不到错误体时仍记录状态码
  }
  const parsed = parseErrorBody(raw);
  const fallback = base.httpStatus ? `上游返回 HTTP ${base.httpStatus}` : '上游请求失败';
  report({
    ...base,
    status: 'error',
    errorCode: parsed.code || (base.httpStatus ? `HTTP ${base.httpStatus}` : 'UPSTREAM_ERROR'),
    errorMessage: parsed.message || fallback,
    errorDetail: parsed.detail.slice(0, MAX_ERROR_DETAIL_CHARS),
    durationMs: Date.now() - startedAt,
  });
}

function readProviderEffort(providerOptions) {
  if (!providerOptions || typeof providerOptions !== 'object') return null;
  for (const value of Object.values(providerOptions)) {
    if (value && typeof value === 'object' && typeof value.reasoningEffort === 'string') {
      return value.reasoningEffort;
    }
  }
  return null;
}

async function observeSuccessStream(body, base, startedAt, report, stallGapMs = STREAM_STALL_GAP_MS) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let firstReasoningAt = null;
  let firstTextAt = null;
  let finishAt = null;
  let lastEventAt = startedAt;
  let effectiveEffort = null;
  let provider = '';
  let streamError = null;
  let streamErrorCode = 'UPSTREAM_STREAM_ERROR';
  let sawFinish = false;
  // 流式质量统计（本分支新增）：记录相邻两次网络读取的间隔分布与停顿次数，
  // 供控制台区分「上游停顿」与「下行积压」。
  let prevReadAt = startedAt;
  let chunkCount = 0;
  let stallCount = 0;
  const gaps = [];

  const handleEvent = (event, now) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'start-step') {
      const fromEcho = readProviderEffort(event?.request?.body?.providerOptions);
      if (fromEcho) effectiveEffort = fromEcho;
      return;
    }
    if (event.type === 'reasoning-delta') {
      if (firstReasoningAt == null && String(event.text ?? '').length > 0) firstReasoningAt = now;
      return;
    }
    if (event.type === 'text-delta') {
      if (firstTextAt == null && String(event.text ?? '').length > 0) firstTextAt = now;
      return;
    }
    if (event.type === 'finish-step' || event.type === 'finish') {
      const next = event.totalUsage || event.usage;
      if (next) {
        // finish.totalUsage 通常不含 raw / outputTokenDetails，合并而不是整块覆盖
        usage = {
          ...(usage || {}),
          ...next,
          inputTokenDetails: next.inputTokenDetails || usage?.inputTokenDetails,
          outputTokenDetails: next.outputTokenDetails || usage?.outputTokenDetails,
          cachedInputTokens: next.cachedInputTokens ?? usage?.cachedInputTokens,
        };
      }
      const routing = event?.providerMetadata?.gateway?.routing;
      if (routing?.finalProvider) provider = String(routing.finalProvider);
      sawFinish = true;
      finishAt = now;
      return;
    }
    if (event.type === 'error') {
      const detail = event.error ?? event.message ?? '上游返回错误事件';
      streamError = typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now();
      lastEventAt = now;
      chunkCount += 1;
      // 间隔在本轮事件解析之前计算：产出首个 token 的那次读取天然被排除，
      // 其之前的等待已经由 ttftMs 表达，不应重复计入流中间隔。
      const gap = now - prevReadAt;
      prevReadAt = now;
      if ((firstReasoningAt ?? firstTextAt) !== null && gap >= 0) {
        if (gaps.length < MAX_GAP_SAMPLES) gaps.push(gap);
        if (gap >= stallGapMs) stallCount += 1;
      }
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line), now);
        } catch {
          // 非 JSON 行（心跳、空行）忽略
        }
      }
    }
    if (buffer.trim()) {
      try {
        handleEvent(JSON.parse(buffer.trim()), lastEventAt);
      } catch {
        // 同上
      }
    }
  } catch (error) {
    streamError = streamError || String(error?.message || '读取上游响应失败');
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') streamErrorCode = 'ABORTED';
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // 即使流中途出错，已收集的间隔样本也照常上报，便于定位「卡了多久才断」。
  const streamStats = summarizeStreamGaps(chunkCount, gaps, stallCount);

  if (streamError) {
    const aborted = streamErrorCode === 'ABORTED';
    report({
      ...base,
      ...streamStats,
      status: 'error',
      errorCode: streamErrorCode,
      errorMessage: aborted ? '请求被中止（客户端断开或超时）' : streamError.split('\n')[0].slice(0, 500),
      errorDetail: streamError.slice(0, MAX_ERROR_DETAIL_CHARS),
      durationMs: (finishAt || lastEventAt) - startedAt,
    });
    return;
  }

  if (!sawFinish && !usage) {
    report({
      ...base,
      ...streamStats,
      status: 'error',
      errorCode: 'INCOMPLETE',
      errorMessage: '上游流在 finish 之前结束，未拿到 usage',
      errorDetail: '',
      durationMs: lastEventAt - startedAt,
    });
    return;
  }

  const inputTokens = numberOrZero(usage?.inputTokens);
  const cachedTokens = numberOrZero(usage?.cachedInputTokens ?? usage?.inputTokenDetails?.cacheReadTokens);
  const outputTokens = numberOrZero(usage?.outputTokens);
  const reasoningTokens = numberOrZero(usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens);
  const textTokens = numberOrZero(usage?.outputTokenDetails?.textTokens)
    || Math.max(0, outputTokens - reasoningTokens);
  const endAt = finishAt || lastEventAt;
  const firstTokenAt = firstReasoningAt ?? firstTextAt;
  const generationMs = firstTokenAt ? Math.max(0, endAt - firstTokenAt) : 0;
  const totalMs = Math.max(1, endAt - startedAt);
  // 上游可能把首个 token 与 finish 合并在同一个 chunk 里送达，此时生成时长趋近 0，
  // 直接相除会得到几千 tok/s 的虚高值；不足 200ms 时退化为整体吞吐。
  const speedWindowMs = generationMs >= 200 ? generationMs : totalMs;

  report({
    ...base,
    ...streamStats,
    status: 'success',
    effectiveEffort: effectiveEffort || null,
    provider,
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    textTokens,
    ttftMs: firstTokenAt ? Math.max(0, firstTokenAt - startedAt) : null,
    durationMs: Math.max(0, endAt - startedAt),
    speed: outputTokens > 0 ? outputTokens / (speedWindowMs / 1000) : null,
  });
}
