const DEFAULT_CONFIG = Object.freeze({
  aiAppearSeconds: 120, aiMinVisibleSeconds: 15, flowWindowSeconds: 30,
  flowEvaluationIntervalSeconds: 15, flowIdleSeconds: 10, aiReopenCooldownSeconds: 180,
  flowConsecutivePasses: 3, aiAccessQuietSeconds: 20, withdrawalCandidateSeconds: 15,
  aiLifecycleEnabled: true, aiPolicy: 'adaptive'
});

const WITHDRAWAL_RULE_VERSION = 'withdrawal_rules_v1';

function normalize(source = {}) {
  const number = (key, fallback, min, max) => Number.isFinite(Number(source[key])) ? Math.max(min, Math.min(max, Math.round(Number(source[key])))) : fallback;
  return {
    aiAppearSeconds: number('aiAppearSeconds', DEFAULT_CONFIG.aiAppearSeconds, 0, 7200),
    aiMinVisibleSeconds: number('aiMinVisibleSeconds', DEFAULT_CONFIG.aiMinVisibleSeconds, 0, 1800),
    flowWindowSeconds: number('flowWindowSeconds', DEFAULT_CONFIG.flowWindowSeconds, 0, 1800),
    flowEvaluationIntervalSeconds: number('flowEvaluationIntervalSeconds', DEFAULT_CONFIG.flowEvaluationIntervalSeconds, 1, 300),
    flowIdleSeconds: number('flowIdleSeconds', DEFAULT_CONFIG.flowIdleSeconds, 0, 600),
    aiReopenCooldownSeconds: number('reopenCooldownSeconds', DEFAULT_CONFIG.aiReopenCooldownSeconds, 0, 1800),
    flowConsecutivePasses: number('flowConsecutivePasses', DEFAULT_CONFIG.flowConsecutivePasses, 1, 10),
    aiAccessQuietSeconds: number('aiAccessQuietSeconds', DEFAULT_CONFIG.aiAccessQuietSeconds, 0, 600),
    withdrawalCandidateSeconds: number('withdrawalCandidateSeconds', DEFAULT_CONFIG.withdrawalCandidateSeconds, 0, 600),
    aiLifecycleEnabled: source.aiLifecycleEnabled !== false,
    aiPolicy: ['off', 'persistent', 'adaptive'].includes(source.aiPolicy) ? source.aiPolicy : DEFAULT_CONFIG.aiPolicy
  };
}

function canEvaluateAssistantWithdrawal({ assistantState, visibleSinceActiveSeconds, activeSeconds, config } = {}) {
  const settings = normalize(config);
  const active = Math.max(0, Number(activeSeconds) || 0);
  const visibleSince = Number(visibleSinceActiveSeconds);
  return assistantState === 'visible'
    && settings.aiLifecycleEnabled
    && settings.aiPolicy === 'adaptive'
    && Number.isFinite(visibleSince)
    && active - visibleSince >= settings.aiMinVisibleSeconds;
}

function normalizeDecision(raw) {
  const actions = new Set(['STAY', 'OBSERVE', 'WITHDRAW', 'CANCEL_WITHDRAWAL']);
  const episodes = new Set(['NOT_USED', 'UNRESOLVED', 'PARTIALLY_RESOLVED', 'RESOLVED']);
  const types = new Set(['NONE', 'UNUSED_PRESENCE', 'POST_SUPPORT']);
  const needs = new Set(['LOW', 'MEDIUM', 'HIGH', 'UNCERTAIN']);
  const list = (value) => Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8) : [];
  const action = actions.has(raw?.action) ? raw.action : 'OBSERVE';
  const supportEpisodeStatus = episodes.has(raw?.supportEpisodeStatus) ? raw.supportEpisodeStatus : 'UNRESOLVED';
  let withdrawalType = types.has(raw?.withdrawalType) ? raw.withdrawalType : 'NONE';
  const evidenceForWithdrawal = list(raw?.evidenceForWithdrawal);
  const unusedPresence = supportEpisodeStatus === 'NOT_USED' && withdrawalType === 'UNUSED_PRESENCE';
  const postSupport = ['PARTIALLY_RESOLVED', 'RESOLVED'].includes(supportEpisodeStatus)
    && withdrawalType === 'POST_SUPPORT';
  const valid = action !== 'WITHDRAW' || (evidenceForWithdrawal.length > 0 && (unusedPresence || postSupport));
  if (!valid) withdrawalType = 'NONE';
  return {
    action: valid ? action : 'OBSERVE',
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
    decisionSummary: String(raw?.decisionSummary || '').trim().slice(0, 500),
    supportNeed: needs.has(raw?.supportNeed) ? raw.supportNeed : 'UNCERTAIN',
    supportEpisodeStatus,
    withdrawalType,
    evidenceForWithdrawal,
    evidenceAgainstWithdrawal: list(raw?.evidenceAgainstWithdrawal),
    uncertainties: list(raw?.uncertainties),
    nextReviewSeconds: Math.max(3, Math.min(60, Math.round(Number(raw?.nextReviewSeconds) || 8))),
    valid,
    validationError: valid ? '' : 'WITHDRAW requires evidence for a consistent unused-presence or post-support pathway.'
  };
}

function evaluateDrawingFlow(operations = [], options = {}) {
  const activeSeconds = Math.max(0, Number(options.activeSeconds) || 0);
  const config = normalize(options.config || {});
  const windowStart = Math.max(0, activeSeconds - config.flowWindowSeconds);
  const relevant = operations.filter((operation) => {
    const at = Number(operation.active_seconds ?? operation.activeSeconds);
    return at >= windowStart && at <= activeSeconds;
  });
  const drawing = relevant.filter((operation) => ['stroke', 'erase'].includes(operation.operation_type || operation.operationType));
  const bucketSize = Math.max(1, config.flowEvaluationIntervalSeconds);
  const bucketCount = Math.max(1, Math.ceil(config.flowWindowSeconds / bucketSize));
  const activeBuckets = new Set(drawing.map((operation) => {
    const at = Number(operation.active_seconds ?? operation.activeSeconds);
    return Math.min(bucketCount - 1, Math.max(0, Math.floor((at - windowStart) / bucketSize)));
  }));
  const payload = (operation) => operation.payload && typeof operation.payload === 'object' ? operation.payload : {};
  const pathLength = (operation) => Math.max(0, Number(payload(operation).pathLength) || 0);
  const strokes = drawing.filter((operation) => (operation.operation_type || operation.operationType) === 'stroke');
  const erases = drawing.filter((operation) => (operation.operation_type || operation.operationType) === 'erase');
  const penPathLength = strokes.reduce((sum, operation) => sum + pathLength(operation), 0);
  const erasePathLength = erases.reduce((sum, operation) => sum + pathLength(operation), 0);
  const undoRedoCount = relevant.filter((operation) => ['undo', 'redo'].includes(operation.operation_type || operation.operationType)).length;
  const regionCounts = new Map();
  drawing.forEach((operation) => {
    const points = Array.isArray(payload(operation).points) ? payload(operation).points : [];
    if (points.length < 2) return;
    let x = 0; let y = 0; let count = 0;
    for (let index = 0; index + 1 < points.length; index += 2) {
      x += Number(points[index]) || 0;
      y += Number(points[index + 1]) || 0;
      count += 1;
    }
    const region = `${Math.max(0, Math.min(5, Math.floor((x / Math.max(1, count)) * 6)))}:${Math.max(0, Math.min(5, Math.floor((y / Math.max(1, count)) * 6)))}`;
    regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
  });
  const sameRegionRevisionCount = Math.max(0, Math.max(0, ...regionCounts.values()) - 1);
  const drawingTimes = drawing.map((operation) => Number(operation.active_seconds ?? operation.activeSeconds) || 0).sort((left, right) => left - right);
  const lastDrawingAt = drawingTimes.length ? drawingTimes[drawingTimes.length - 1] : 0;
  const idleSeconds = drawing.length ? Math.max(0, activeSeconds - lastDrawingAt) : config.flowWindowSeconds;
  const eraseRatio = penPathLength + erasePathLength > 0 ? erasePathLength / (penPathLength + erasePathLength) : 0;
  const netCanvasProgress = Math.max(0, penPathLength - erasePathLength);
  const minimumActiveBuckets = Math.max(1, Math.ceil(bucketCount * 0.6));
  const thresholds = {
    minimumActiveBuckets,
    minimumPenPathLength: 1.2,
    maximumUndoRedoCount: 2,
    maximumEraseRatio: 0.3,
    maximumIdleSeconds: config.flowIdleSeconds,
    minimumNetCanvasProgress: 0.4,
    maximumSameRegionRevisionCount: 4
  };
  const rules = {
    effectiveDrawing: activeBuckets.size >= thresholds.minimumActiveBuckets && penPathLength >= thresholds.minimumPenPathLength,
    canvasProgressing: netCanvasProgress >= thresholds.minimumNetCanvasProgress,
    noConsecutiveUndo: undoRedoCount <= thresholds.maximumUndoRedoCount,
    noHighFrequencyErase: eraseRatio <= thresholds.maximumEraseRatio,
    noRepeatedRegionRevision: sameRegionRevisionCount <= thresholds.maximumSameRegionRevisionCount,
    noLongIdle: idleSeconds <= thresholds.maximumIdleSeconds
  };
  const blockReasons = Object.entries(rules).filter(([, passed]) => !passed).map(([rule]) => rule);
  return {
    passed: blockReasons.length === 0,
    rules,
    blockReasons,
    metrics: {
      activeBuckets: activeBuckets.size,
      bucketCount,
      penPathLength,
      erasePathLength,
      eraseRatio,
      netCanvasProgress,
      canvasChangeRatio: penPathLength + erasePathLength > 0 ? netCanvasProgress / (penPathLength + erasePathLength) : 0,
      undoRedoCount,
      undoCount: relevant.filter((operation) => (operation.operation_type || operation.operationType) === 'undo').length,
      eraseCount: erases.length,
      strokeCount: strokes.length,
      sameRegionRevisionCount,
      meanInterStrokeIntervalSeconds: drawingTimes.length < 2 ? null : drawingTimes.slice(1).reduce((sum, value, index) => sum + Math.max(0, value - drawingTimes[index]), 0) / (drawingTimes.length - 1),
      effectiveDrawingDurationMs: drawing.reduce((sum, operation) => sum + Math.max(0, Number(payload(operation).durationMs) || 0), 0),
      idleSeconds,
      operationCount: relevant.length
    },
    thresholds,
    windowStart,
    windowSeconds: config.flowWindowSeconds
  };
}

module.exports = {
  WITHDRAWAL_RULE_VERSION,
  normalize,
  canEvaluateAssistantWithdrawal,
  normalizeDecision,
  evaluateDrawingFlow
};
