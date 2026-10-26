/**
 * 下行连接质量探针（本分支新增）
 *
 * admin.mjs 的 handle() 在每个请求进入路由前调用 maybeAttachDownstreamProbe：
 * 对流式 API 路径（/v1/chat/completions、/v1/messages、/v1/responses）包装
 * response.write，统计「网关 → 终端客户端」这一段的写积压——
 * res.write() 返回 false 说明客户端 socket 缓冲已满（消费跟不上），
 * 它到 'drain' 之间的等待时长就是下行网络拥塞的直接证据。
 *
 * 与 request-log.mjs 的上游旁路采集互补：同一条流上，
 * 上游到达间隔大而下行无积压 → 卡顿在上游；上游正常而频繁积压 → 卡顿在客户端网络。
 *
 * 设计约束：
 * - proxy.mjs 零改动：探针挂在 adminController.handle() 已有的请求入口上；
 * - 只旁听不干预：不改变 write 返回值与事件时序，waitDrain 照常工作；
 * - 只记录计数与毫秒数，不记录任何请求内容或密钥；
 * - 被 403/429 等拒绝的请求没有流式写出（bytesWritten 为 0），不进入统计样本。
 */

import { randomBytes } from 'crypto';

const PROBED_PATHS = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses']);
const MAX_RECENT_RECORDS = 60;

const activeRecords = new Set();
const recentRecords = []; // 最新在前

export function maybeAttachDownstreamProbe(request, response, pathname) {
  if (!request || !response || response._forkStreamProbe) return;
  if (request.method !== 'POST' || !PROBED_PATHS.has(pathname)) return;

  const record = {
    id: `stream-${randomBytes(6).toString('hex')}`,
    path: String(pathname || ''),
    startedAt: new Date().toISOString(),
    active: true,
    bytesWritten: 0,
    backpressureEvents: 0,
    drainWaitMs: 0,
    maxDrainWaitMs: 0,
    maxBufferedBytes: 0,
    durationMs: null,
    endedAt: null,
  };
  // 挂在 response 上防止重复包装；属性名带 fork 前缀便于识别本分支新增。
  response._forkStreamProbe = record;
  activeRecords.add(record);

  let pendingSince = 0;
  const originalWrite = response.write.bind(response);
  response.write = (chunk, ...rest) => {
    const ok = originalWrite(chunk, ...rest);
    try {
      if (chunk) {
        if (typeof chunk === 'string') record.bytesWritten += Buffer.byteLength(chunk);
        else if (chunk.length !== undefined) record.bytesWritten += chunk.length; // Buffer / Uint8Array
      }
      if (!ok) {
        record.backpressureEvents += 1;
        record.maxBufferedBytes = Math.max(record.maxBufferedBytes, response.writableLength || 0);
        pendingSince = Date.now();
      }
    } catch {
      // 探针自身异常绝不影响转发主流程
    }
    return ok;
  };

  response.on('drain', () => {
    try {
      if (!pendingSince) return;
      const waited = Date.now() - pendingSince;
      pendingSince = 0;
      record.drainWaitMs += waited;
      if (waited > record.maxDrainWaitMs) record.maxDrainWaitMs = waited;
    } catch {
      // ignore
    }
  });

  // close 对正常结束与客户端断连都会触发，在这里统一收口。
  response.once('close', () => {
    activeRecords.delete(record);
    if (!record.active) return;
    record.active = false;
    record.endedAt = new Date().toISOString();
    record.durationMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
    if (record.bytesWritten > 0) {
      recentRecords.unshift(record);
      if (recentRecords.length > MAX_RECENT_RECORDS) recentRecords.length = MAX_RECENT_RECORDS;
    }
  });
}

function publicRecord(record) {
  return {
    id: record.id,
    path: record.path,
    startedAt: record.startedAt,
    active: record.active,
    bytesWritten: record.bytesWritten,
    backpressureEvents: record.backpressureEvents,
    drainWaitMs: record.drainWaitMs,
    maxDrainWaitMs: record.maxDrainWaitMs,
    maxBufferedBytes: record.maxBufferedBytes,
    durationMs: record.durationMs,
    endedAt: record.endedAt,
  };
}

/** 供 /admin/api/stream-quality 聚合输出：在途流 + 最近已结束流 + 汇总。 */
export function snapshotStreamMetrics() {
  const samples = recentRecords.map(publicRecord);
  return {
    generatedAt: new Date().toISOString(),
    active: [...activeRecords].map(publicRecord),
    recent: samples,
    summary: {
      sampleSize: samples.length,
      streamsWithBackpressure: samples.filter((item) => item.backpressureEvents > 0).length,
      backpressureEvents: samples.reduce((sum, item) => sum + item.backpressureEvents, 0),
      totalDrainWaitMs: samples.reduce((sum, item) => sum + item.drainWaitMs, 0),
      maxDrainWaitMs: samples.reduce((max, item) => Math.max(max, item.maxDrainWaitMs), 0),
    },
  };
}
