/**
 * 本分支新增：Anthropic 推理参数 → CC `reasoning_effort` 的解析与归一化。
 *
 * 设计约定（目标是降低上游合并成本）：
 *   1. 全部判断集中在本文件，`proxy.mjs` 只保留 import 与两三个调用点；
 *   2. 以官方 Anthropic 协议为准：档位来自 `output_config.effort`
 *      （low / medium / high / xhigh / max，官方 schema 中 `thinking` 没有 effort 字段）；
 *   3. 兼容旧客户端：`thinking.effort`（非官方但生态里存在）与
 *      `thinking.budget_tokens`（旧版 Claude 的预算写法，按阈值推断档位）；
 *   4. 最终按目标模型**已声明**的档位向上归一，避免把上游不认的值放进 wire。
 */

// 档位从低到高的唯一排序来源：归一化、能力表、比较都基于它。
const EFFORT_RANK = Object.freeze(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 各模型族声明的推理档位。
 * 数据来源：官方 CLI `command-code@1.84.0` 内嵌模型目录的 `reasoningEfforts`。
 * 这里只收录已核实的族；未命中的模型走 DEFAULT_EFFORTS。
 */
const MODEL_EFFORT_RULES = Object.freeze([
  { test: /^claude-/i, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) },
  { test: /^deepseek\//i, efforts: Object.freeze(['off', 'high', 'max']) },
]);

// 未知模型的保守集合：CC 文档长期只承诺这四档。
const DEFAULT_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);

// `/provider/v1/models` 返回的运行时能力覆盖静态表；进程内有效。
// 空数组是有效值，表示该模型不支持推理（此时一律不下发 reasoning_effort）。
const runtimeEfforts = new Map();

/** 把任意输入归一为档位名；`none` → `off`，`minimal` → `low`（OpenAI 侧别名）。 */
function normalizeLevel(value) {
  if (typeof value !== 'string') return undefined;
  const level = value.trim().toLowerCase();
  if (!level) return undefined;
  if (level === 'none') return 'off';
  if (level === 'minimal') return 'low';
  return EFFORT_RANK.includes(level) ? level : undefined;
}

/**
 * 注册上游模型目录里声明的档位。
 * @param {Array<{id?: string, reasoningEfforts?: string[]}>} models
 */
export function registerModelEfforts(models) {
  if (!Array.isArray(models)) return;
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || !Array.isArray(model.reasoningEfforts)) continue;
    const efforts = [];
    for (const raw of model.reasoningEfforts) {
      const level = normalizeLevel(raw);
      if (level && !efforts.includes(level)) efforts.push(level);
    }
    // 按从低到高排序，便于阅读与调试（归一化本身不依赖顺序）
    efforts.sort((a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b));
    runtimeEfforts.set(id, Object.freeze(efforts));
  }
}

/**
 * 取某个模型声明的推理档位；返回空数组表示「该模型不支持推理」。
 * @param {string} model
 * @returns {readonly string[]}
 */
export function getSupportedEfforts(model) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (id && runtimeEfforts.has(id)) return runtimeEfforts.get(id);
  for (const rule of MODEL_EFFORT_RULES) {
    if (rule.test.test(id)) return rule.efforts;
  }
  return DEFAULT_EFFORTS;
}

/**
 * 把请求档位夹到模型支持的档位：优先原值，其次向上取最近档（绝不降级），
 * 已到最高时取最高档。无法关闭思考的模型收到 `off` 时返回 undefined。
 * @param {unknown} effort
 * @param {string} model
 * @returns {string|undefined}
 */
export function normalizeReasoningEffort(effort, model) {
  const level = normalizeLevel(effort);
  if (!level) return undefined;

  const supported = getSupportedEfforts(model);
  if (!supported || supported.length === 0) return undefined; // 模型不支持推理
  if (supported.includes(level)) return level;

  // 模型不支持 off（例如 Claude 系）：保持不下发，避免把「关闭思考」误映射成低档思考。
  if (level === 'off') return undefined;

  const target = EFFORT_RANK.indexOf(level);
  let best;
  for (const candidate of supported) {
    const rank = EFFORT_RANK.indexOf(candidate);
    if (rank >= target && (best === undefined || rank < best)) best = rank;
  }
  if (best === undefined) {
    // 请求档位高于所有已声明档：取最高档
    for (const candidate of supported) {
      const rank = EFFORT_RANK.indexOf(candidate);
      if (best === undefined || rank > best) best = rank;
    }
  }
  return best === undefined ? undefined : EFFORT_RANK[best];
}

/** 旧版 Claude 的 budget_tokens → 档位（阈值保持既有行为，便于平滑迁移）。 */
function effortFromBudget(value) {
  const budget = Number(value);
  if (!Number.isFinite(budget)) return undefined;
  if (budget >= 16_000) return 'max';
  if (budget >= 10_000) return 'high';
  if (budget >= 5_000) return 'medium';
  return 'low';
}

/**
 * 解析 Anthropic `/v1/messages` 请求里的推理意图，返回可直接下发的档位。
 *
 * 优先级：
 *   1. `output_config.effort`（官方字段，最高优先）
 *   2. 顶层 `reasoning_effort` / `reasoning.effort`（OpenAI 风格但打到 Anthropic 端点的客户端）
 *   3. `thinking.type === 'disabled' | 'none'` → 尝试 `off`
 *   4. `thinking.effort`（旧客户端兼容）
 *   5. `thinking.type === 'adaptive' | 'between_tools'` 且无档位 → 不下发，交给上游默认
 *   6. `thinking.budget_tokens` → 按阈值推断
 *
 * 返回 undefined 表示「不下发 reasoning_effort」。
 *
 * @param {object} request Anthropic 请求体
 * @param {string} [model]
 * @returns {string|undefined}
 */
export function resolveAnthropicEffort(request, model) {
  if (!request || typeof request !== 'object') return undefined;
  const targetModel = model || request.model;

  // 1. 官方字段优先：effort 与 thinking 是独立旋钮，显式给的档位最可信。
  const outputEffort = normalizeLevel(request.output_config?.effort);
  if (outputEffort) return normalizeReasoningEffort(outputEffort, targetModel);

  // 2. 兼容把 OpenAI 风格参数直接发到 /v1/messages 的客户端。
  const topLevelEffort = normalizeLevel(request.reasoning_effort)
    || normalizeLevel(request.reasoning?.effort);
  if (topLevelEffort) return normalizeReasoningEffort(topLevelEffort, targetModel);

  const thinking = request.thinking;
  if (!thinking || typeof thinking !== 'object') return undefined;

  const type = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';

  // 3. 显式关闭思考：只有声明了 off 的模型才能真正关掉。
  if (type === 'disabled' || type === 'none') {
    return normalizeReasoningEffort('off', targetModel);
  }

  // 4. 旧客户端把档位塞在 thinking.effort 里（官方 schema 无此字段，仅兼容）。
  const legacyEffort = normalizeLevel(thinking.effort);
  if (legacyEffort) return normalizeReasoningEffort(legacyEffort, targetModel);

  // 5. adaptive / between_tools 本身不带档位时，交给上游按模型默认处理，
  //    不再像旧实现那样硬编码 medium（会静默压低一档）。
  if (type === 'adaptive' || type === 'between_tools') return undefined;

  // 6. 旧协议兜底：budget_tokens 阈值推断。
  if (thinking.budget_tokens !== undefined) {
    const fromBudget = effortFromBudget(thinking.budget_tokens);
    if (fromBudget) return normalizeReasoningEffort(fromBudget, targetModel);
  }

  return undefined;
}
