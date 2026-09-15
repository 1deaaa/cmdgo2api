import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAnthropicThinkingToReasoningEffort } from '../reasoning.mjs';

test('maps all Anthropic thinking budget levels', () => {
  const cases = [
    [{ type: 'disabled' }, undefined],
    [{ type: 'none' }, undefined],
    [{ type: 'enabled', budget_tokens: 1_999 }, 'low'],
    [{ type: 'enabled', budget_tokens: 2_000 }, 'low'],
    [{ type: 'enabled', budget_tokens: 5_000 }, 'medium'],
    [{ type: 'enabled', budget_tokens: 10_000 }, 'high'],
    [{ type: 'enabled', budget_tokens: 16_000 }, 'max'],
  ];

  for (const [thinking, expected] of cases) {
    assert.equal(mapAnthropicThinkingToReasoningEffort(thinking), expected);
  }
});

test('preserves adaptive effort, including max', () => {
  assert.equal(
    mapAnthropicThinkingToReasoningEffort({ type: 'adaptive', effort: 'max' }),
    'max',
  );
  assert.equal(
    mapAnthropicThinkingToReasoningEffort({ type: 'adaptive' }),
    'medium',
  );
});
