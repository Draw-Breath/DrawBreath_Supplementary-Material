const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WITHDRAWAL_RULE_VERSION,
  normalizeDecision,
  canEvaluateAssistantWithdrawal,
  evaluateDrawingFlow
} = require('../src/server/canvasPolicy');

test('DrawBreath exposes one historical-style withdrawal rule', () => {
  assert.equal(WITHDRAWAL_RULE_VERSION, 'withdrawal_rules_v1');
});

test('model failures and unsupported withdrawal decisions stay visible', () => {
  assert.equal(normalizeDecision({}).action, 'OBSERVE');
  const unsupported = normalizeDecision({
    action: 'WITHDRAW', supportEpisodeStatus: 'UNRESOLVED',
    withdrawalType: 'NONE', evidenceForWithdrawal: []
  });
  assert.equal(unsupported.action, 'OBSERVE');
  assert.equal(unsupported.valid, false);
});

test('unused-presence and completed post-support withdrawals are accepted', () => {
  const unused = normalizeDecision({
    action: 'WITHDRAW', supportEpisodeStatus: 'NOT_USED',
    withdrawalType: 'UNUSED_PRESENCE', evidenceForWithdrawal: ['The child is working independently.']
  });
  assert.equal(unused.action, 'WITHDRAW');
  assert.equal(unused.valid, true);
  const supported = normalizeDecision({
    action: 'WITHDRAW', supportEpisodeStatus: 'RESOLVED',
    withdrawalType: 'POST_SUPPORT', evidenceForWithdrawal: ['The support request is resolved.']
  });
  assert.equal(supported.action, 'WITHDRAW');
  assert.equal(supported.valid, true);
});

test('the visibility helper enforces lifecycle timing before the route-level interaction gate', () => {
  const base = {
    assistantState: 'visible', visibleSinceActiveSeconds: 100, activeSeconds: 115,
    config: { aiPolicy: 'adaptive', aiLifecycleEnabled: true, aiMinVisibleSeconds: 15 }
  };
  assert.equal(canEvaluateAssistantWithdrawal(base), true);
  assert.equal(canEvaluateAssistantWithdrawal({ ...base, activeSeconds: 114 }), false);
  assert.equal(canEvaluateAssistantWithdrawal({ ...base, assistantState: 'withdrawn' }), false);
  assert.equal(canEvaluateAssistantWithdrawal({ ...base, config: { ...base.config, aiLifecycleEnabled: false } }), false);
});

test('drawing flow remains descriptive model evidence', () => {
  const strokes = [
    { operation_type: 'stroke', active_seconds: 72, payload: { pathLength: 0.7, durationMs: 900, points: [0.1, 0.1, 0.3, 0.2] } },
    { operation_type: 'stroke', active_seconds: 88, payload: { pathLength: 0.8, durationMs: 1000, points: [0.5, 0.4, 0.8, 0.7] } },
    { operation_type: 'stroke', active_seconds: 99, payload: { pathLength: 0.5, durationMs: 700, points: [0.2, 0.8, 0.4, 0.6] } }
  ];
  const result = evaluateDrawingFlow(strokes, {
    activeSeconds: 100,
    config: { flowWindowSeconds: 30, flowEvaluationIntervalSeconds: 15, flowIdleSeconds: 10 }
  });
  assert.equal(result.passed, true);
  const disrupted = evaluateDrawingFlow([
    ...strokes,
    { operation_type: 'undo', active_seconds: 97, payload: {} },
    { operation_type: 'undo', active_seconds: 98, payload: {} },
    { operation_type: 'redo', active_seconds: 99, payload: {} }
  ], { activeSeconds: 100 });
  assert.equal(disrupted.passed, false);
  assert.ok(disrupted.blockReasons.includes('noConsecutiveUndo'));
});

test('an empty drawing window is not mislabeled as erasure', () => {
  const result = evaluateDrawingFlow([], { activeSeconds: 100 });
  assert.equal(result.metrics.eraseCount, 0);
  assert.equal(result.metrics.eraseRatio, 0);
  assert.equal(result.rules.noHighFrequencyErase, true);
});
