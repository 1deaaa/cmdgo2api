// 本分支新增：reasoning.mjs 的单元测试。
// 覆盖官方 output_config.effort、旧字段兼容、关闭思考、以及按模型能力归一。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSupportedEfforts,
  normalizeReasoningEffort,
  registerModelEfforts,
  resolveAnthropicEffort,
} from '../reasoning.mjs';

const DEEPSEEK = 'deepseek/deepseek-v4-flash';
const CLAUDE = 'claude-sonnet-5';

test('模型能力表：Claude 五档、DeepSeek 三档、未知模型保守四档', () => {
  assert.deepEqual([...getSupportedEfforts(CLAUDE)], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...getSupportedEfforts(DEEPSEEK)], ['off', 'high', 'max']);
  assert.deepEqual([...getSupportedEfforts('vendor/unknown-model')], ['low', 'medium', 'high', 'max']);
  assert.deepEqual([...getSupportedEfforts('')], ['low', 'medium', 'high', 'max']);
});

test('官方 output_config.effort 生效，并按模型能力向上归一', () => {
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'low' } }, CLAUDE), 'low');
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'xhigh' } }, CLAUDE), 'xhigh');
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'max' } }, CLAUDE), 'max');
  // DeepSeek 只声明 off/high/max：低档向上取 high，xhigh 取 max
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'low' } }, DEEPSEEK), 'high');
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'medium' } }, DEEPSEEK), 'high');
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'xhigh' } }, DEEPSEEK), 'max');
  // 大小写与空白归一
  assert.equal(resolveAnthropicEffort({ output_config: { effort: '  HIGH ' } }, CLAUDE), 'high');
  // null / 非法值不下发
  assert.equal(resolveAnthropicEffort({ output_config: { effort: null } }, CLAUDE), undefined);
  assert.equal(resolveAnthropicEffort({ output_config: { effort: 'ultra' } }, CLAUDE), undefined);
});

test('关闭思考：仅声明了 off 的模型才下发 off', () => {
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'disabled' } }, DEEPSEEK), 'off');
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'none' } }, DEEPSEEK), 'off');
  // Claude 没有 off 档：保持不下发，而不是误映射成低档思考
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'disabled' } }, CLAUDE), undefined);
});

test('adaptive / between_tools 无档位时交给上游默认，不再硬编码 medium', () => {
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'adaptive' } }, CLAUDE), undefined);
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'between_tools' } }, DEEPSEEK), undefined);
  // 但显式给了档位仍然生效
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'adaptive', effort: 'max' } }, CLAUDE), 'max');
  assert.equal(
    resolveAnthropicEffort({ thinking: { type: 'between_tools' }, output_config: { effort: 'high' } }, CLAUDE),
    'high',
  );
});

test('兼容旧客户端的 thinking.effort（非官方字段）', () => {
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'adaptive', effort: 'xhigh' } }, CLAUDE), 'xhigh');
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'adaptive', effort: 'xhigh' } }, DEEPSEEK), 'max');
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'adaptive', effort: 'medium' } }, DEEPSEEK), 'high');
});

test('旧版 budget_tokens 阈值仍按原行为推断', () => {
  const cases = [
    [0, 'low'],
    [1_999, 'low'],
    [2_000, 'low'],
    [5_000, 'medium'],
    [9_999, 'medium'],
    [10_000, 'high'],
    [16_000, 'max'],
    [32_000, 'max'],
  ];
  for (const [budget_tokens, expected] of cases) {
    assert.equal(
      resolveAnthropicEffort({ thinking: { type: 'enabled', budget_tokens } }, CLAUDE),
      expected,
      `budget=${budget_tokens}`,
    );
  }
  // DeepSeek 上低档被归一
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'enabled', budget_tokens: 2_000 } }, DEEPSEEK), 'high');
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'enabled', budget_tokens: 32_000 } }, DEEPSEEK), 'max');
  // 非法预算不下发
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'enabled', budget_tokens: 'abc' } }, CLAUDE), undefined);
  // enabled 但没有预算：不下发
  assert.equal(resolveAnthropicEffort({ thinking: { type: 'enabled' } }, CLAUDE), undefined);
});

test('output_config 优先于 thinking（effort 与 thinking 是独立旋钮）', () => {
  assert.equal(
    resolveAnthropicEffort({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 2_000 } }, CLAUDE),
    'high',
  );
});

test('兼容把 OpenAI 风格参数直接发到 Anthropic 端点的客户端', () => {
  assert.equal(resolveAnthropicEffort({ reasoning_effort: 'high' }, CLAUDE), 'high');
  assert.equal(resolveAnthropicEffort({ reasoning_effort: 'xhigh' }, DEEPSEEK), 'max');
  assert.equal(resolveAnthropicEffort({ reasoning: { effort: 'medium' } }, CLAUDE), 'medium');
  assert.equal(resolveAnthropicEffort({ reasoning: { effort: 'medium' } }, DEEPSEEK), 'high');
  // 官方字段仍然优先
  assert.equal(
    resolveAnthropicEffort({ output_config: { effort: 'low' }, reasoning_effort: 'high' }, CLAUDE),
    'low',
  );
});

test('OpenAI 侧别名：none → off，minimal → low', () => {
  assert.equal(normalizeReasoningEffort('none', DEEPSEEK), 'off');
  assert.equal(normalizeReasoningEffort('minimal', CLAUDE), 'low');
  assert.equal(normalizeReasoningEffort('minimal', DEEPSEEK), 'high');
});

test('运行时能力表覆盖静态表，空数组表示不支持推理', () => {
  registerModelEfforts([
    { id: 'vendor/custom-model', reasoningEfforts: ['low', 'high'] },
    { id: 'vendor/no-reasoning', reasoningEfforts: [] },
  ]);
  assert.deepEqual([...getSupportedEfforts('vendor/custom-model')], ['low', 'high']);
  assert.equal(normalizeReasoningEffort('medium', 'vendor/custom-model'), 'high');
  assert.equal(normalizeReasoningEffort('max', 'vendor/custom-model'), 'high');
  assert.equal(normalizeReasoningEffort('max', 'vendor/no-reasoning'), undefined);
  // 非法/空输入
  assert.equal(normalizeReasoningEffort(undefined, CLAUDE), undefined);
  assert.equal(normalizeReasoningEffort(null, CLAUDE), undefined);
  assert.equal(normalizeReasoningEffort('', CLAUDE), undefined);
});
