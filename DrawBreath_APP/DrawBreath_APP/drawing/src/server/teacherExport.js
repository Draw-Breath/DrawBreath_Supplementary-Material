const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { buildXlsx } = require('./excel');
const { CANVAS_EXPORT_CONTRACT } = require('./exportContract');

const TIME_ZONE = 'Asia/Shanghai (UTC+08:00)';
const iso = (value) => value instanceof Date ? value.toISOString() : value || '';
const beijing = (value) => value ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)).replace(' ', 'T') : '';
const json = (value) => value && typeof value === 'object' ? value : {};
const columns = (keys) => keys.map((key) => ({ key, label: key }));
const contractSheets = (rowsByName) => CANVAS_EXPORT_CONTRACT.map(([name, keys]) => ({ name, columns: columns(keys), rows: rowsByName[name] || [] }));
function imageMetadata(relativePath) {
  if (!relativePath) return { fileSize: null, sha256: '' };
  const root = path.resolve(config.uploadRoot); const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) return { fileSize: null, sha256: '' };
  try { const buffer = fs.readFileSync(target); return { fileSize: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }; }
  catch { return { fileSize: null, sha256: '' }; }
}

async function buildDrawingWorkbook(pool, task) {
  const [sessionsResult, operationsResult, snapshotsResult, messagesResult, decisionsResult, flowResult, withdrawalsResult] = await Promise.all([
    pool.query(`SELECT p.student_number, p.created_at AS participant_created_at, w.*,
      (SELECT count(*) FROM canvas_snapshots s WHERE s.workspace_id = w.id)::int AS snapshot_count
      FROM participants p JOIN workspaces w ON w.participant_id = p.id WHERE p.task_id = $1
      ORDER BY p.created_at, w.attempt_number`, [task.id]),
    pool.query(`SELECT p.student_number, w.attempt_number, o.*
      FROM canvas_operations o JOIN workspaces w ON w.id = o.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY p.created_at, w.attempt_number, o.seq`, [task.id]),
    pool.query(`SELECT p.student_number, w.attempt_number, w.assistant_state, s.*,
      row_number() OVER (PARTITION BY w.id ORDER BY s.created_at, s.id)::int AS sample_index
      FROM canvas_snapshots s JOIN workspaces w ON w.id = s.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY p.created_at, w.attempt_number, s.active_seconds, s.created_at`, [task.id]),
    pool.query(`SELECT p.student_number, w.attempt_number, m.*
      FROM assistant_messages m JOIN workspaces w ON w.id = m.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY p.created_at, w.attempt_number, m.id`, [task.id]),
    pool.query(`SELECT p.student_number, w.attempt_number, w.assistant_state, d.*,
      row_number() OVER (PARTITION BY w.id ORDER BY d.created_at, d.id)::int AS decision_index
      FROM ai_decisions d JOIN workspaces w ON w.id = d.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY p.created_at, w.attempt_number, d.active_seconds, d.created_at`, [task.id]),
    pool.query(`SELECT p.student_number, w.attempt_number, e.*
      FROM flow_evaluations e JOIN workspaces w ON w.id = e.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY p.created_at, w.attempt_number, e.active_seconds, e.evaluated_at`, [task.id]),
    pool.query(`SELECT p.student_number, w.attempt_number, e.*
      FROM withdrawal_events e JOIN workspaces w ON w.id = e.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY p.created_at, w.attempt_number, e.withdrawal_number`, [task.id])
  ]);
  const sessions = sessionsResult.rows;
  const operations = operationsResult.rows;
  const snapshots = snapshotsResult.rows;
  const messages = messagesResult.rows;
  const decisions = decisionsResult.rows;
  const flowEvaluations = flowResult.rows;
  const withdrawals = withdrawalsResult.rows;
  const configSnapshot = {
    canvasWidth: task.canvas_width, canvasHeight: task.canvas_height, timeLimitSeconds: task.time_limit_seconds,
    snapshotIntervalSeconds: task.snapshot_interval_seconds, aiAppearSeconds: task.ai_appear_seconds,
    flowWindowSeconds: task.flow_window_seconds, flowIdleSeconds: task.flow_idle_seconds,
    flowEvaluationIntervalSeconds: task.flow_evaluation_interval_seconds, aiMinVisibleSeconds: task.ai_min_visible_seconds,
    flowConsecutivePasses: task.flow_consecutive_passes, aiAccessQuietSeconds: task.ai_access_quiet_seconds,
    withdrawalCandidateSeconds: task.withdrawal_candidate_seconds, withdrawalFadeMilliseconds: task.withdrawal_fade_milliseconds,
    postWithdrawalObservationSeconds: task.post_withdrawal_observation_seconds, reopenCooldownSeconds: task.reopen_cooldown_seconds,
    ruleVersion: task.rule_version, artworkPassScore: task.artwork_pass_score, aiPolicy: task.ai_policy,
    aiLifecycleEnabled: task.ai_lifecycle_enabled, voiceEnabled: task.voice_enabled, newAttemptsAllowed: task.new_attempts_allowed
  };
  const sessionRows = sessions.map((row) => ({ sessionId: row.id, studentCode: row.student_number, condition: '', phase: 'practice',
    attemptNumber: row.attempt_number, theme: task.title, taskPrompt: task.title, status: row.status, textEditable: false,
    ideationTextInitial: '', ideationTextFinal: '', ideationTextVersion: 0, activeSeconds: row.active_seconds,
    completionReason: row.status === 'submitted' ? 'manual' : '', timingStartedAt: iso(row.timing_started_at), timingStartedAtBeijing: beijing(row.timing_started_at),
    submittedAt: iso(row.submitted_at), submittedAtBeijing: beijing(row.submitted_at), lastOperationSeq: row.operation_count,
    assistantState: row.assistant_state, createdAt: iso(row.timing_started_at || row.participant_created_at),
    createdAtBeijing: beijing(row.timing_started_at || row.participant_created_at), updatedAt: iso(row.updated_at),
    updatedAtBeijing: beijing(row.updated_at), configSnapshot, timeZone: TIME_ZONE }));
  const operationRows = operations.map((row) => ({ operationId: row.id, sessionId: row.workspace_id, studentCode: row.student_number,
    phase: 'practice', attemptNumber: row.attempt_number, seq: row.seq, operationType: row.operation_type,
    activeSeconds: row.active_seconds, payload: row.payload, occurredAtClient: iso(row.occurred_at_client),
    occurredAtClientBeijing: beijing(row.occurred_at_client), occurredAt: iso(row.created_at), occurredAtBeijing: beijing(row.created_at), timeZone: TIME_ZONE }));
  const snapshotRows = snapshots.map((row) => ({ ...imageMetadata(row.image_path), snapshotId: row.id, sessionId: row.workspace_id, studentCode: row.student_number,
    phase: 'practice', attemptNumber: row.attempt_number, snapshotKind: row.snapshot_kind, sampleIndex: row.sample_index,
    activeSeconds: row.active_seconds, operationSeq: row.operation_count, mimeType: String(row.image_path || '').toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png',
    filePath: row.image_path, width: task.canvas_width, height: task.canvas_height,
    sceneState: { visualVersion: row.operation_count, snapshotReason: row.snapshot_kind }, assistantState: row.assistant_state,
    capturedAt: iso(row.created_at), capturedAtBeijing: beijing(row.created_at), timeZone: TIME_ZONE }));
  const messageRows = messages.map((row) => ({ messageId: row.id, sessionId: row.workspace_id, studentCode: row.student_number,
    phase: 'practice', attemptNumber: row.attempt_number, role: row.role, source: row.quick_prompt_key ? 'quick_prompt' : 'typed',
    aiCycleId: row.conversation_id, requestId: '', content: row.content, ideationTextVersion: 0, snapshotId: '',
    responseStatus: 'ready', responseError: '', modelSlot: '', modelLabel: '', modelName: '', latencyMs: null,
    activeSeconds: null, createdAt: iso(row.created_at), createdAtBeijing: beijing(row.created_at), timeZone: TIME_ZONE }));
  const decisionRows = decisions.map((row) => { const normalized = json(row.normalized_decision); const evidence = json(row.evidence); return {
    decisionId: row.id, sessionId: row.workspace_id, aiCycleId: '', withdrawalEventId: '', studentCode: row.student_number,
    phase: 'practice', attemptNumber: row.attempt_number, decisionIndex: row.decision_index, requestId: '', activeSeconds: row.active_seconds,
    assistantState: row.assistant_state, evidenceInput: row.evidence, promptSystem: row.prompt_system, promptInput: row.prompt_input,
    rawResponse: row.raw_response, normalizedDecision: row.normalized_decision, action: normalized.action || '', confidence: normalized.confidence || null,
    supportNeed: normalized.supportNeed || '', supportEpisodeStatus: normalized.supportEpisodeStatus || '', withdrawalType: normalized.withdrawalType || '',
    evidenceForWithdrawal: normalized.evidenceForWithdrawal || [], evidenceAgainstWithdrawal: normalized.evidenceAgainstWithdrawal || [],
    uncertainties: normalized.uncertainties || [], nextReviewSeconds: normalized.nextReviewSeconds || null,
    validationStatus: normalized.valid === false ? 'invalid' : 'valid', validationError: normalized.validationError || '',
    executionStatus: normalized.executionStatus || (normalized.action ? 'recorded' : ''), executionReason: normalized.executionReason || normalized.reason || '', snapshotId: evidence.snapshotId || '',
    modelSlot: '', modelLabel: '', modelName: row.model_name, fallback: row.fallback, responseError: row.response_error,
    latencyMs: null, requestedAt: iso(row.created_at), requestedAtBeijing: beijing(row.created_at),
    decidedAt: iso(row.created_at), decidedAtBeijing: beijing(row.created_at), timeZone: TIME_ZONE };
  });
  const flowRows = flowEvaluations.map((row) => ({ evaluationId: row.id, sessionId: row.workspace_id,
    studentCode: row.student_number, phase: 'practice', attemptNumber: row.attempt_number,
    activeSeconds: row.active_seconds, windowSeconds: row.window_seconds, metrics: row.metrics,
    thresholds: row.thresholds, passed: row.passed, consecutivePasses: row.consecutive_passes,
    decision: row.decision, evaluatedAt: iso(row.evaluated_at), evaluatedAtBeijing: beijing(row.evaluated_at), timeZone: TIME_ZONE }));
  const withdrawalRows = withdrawals.map((row) => ({ withdrawalEventId: row.id, sessionId: row.workspace_id,
    aiCycleId: row.conversation_id || '', studentCode: row.student_number, phase: 'practice', attemptNumber: row.attempt_number,
    withdrawalNumber: row.withdrawal_number, status: row.status,
    candidateStartedActiveSeconds: row.candidate_started_active_seconds,
    candidateUpdatedActiveSeconds: row.candidate_updated_active_seconds, fadeStartedActiveSeconds: row.fade_started_active_seconds,
    completedActiveSeconds: row.completed_active_seconds, cancelledActiveSeconds: row.cancelled_active_seconds,
    cancellationReason: row.cancellation_reason, triggerMetrics: row.trigger_metrics, triggerRules: row.trigger_rules,
    createdAt: iso(row.created_at), createdAtBeijing: beijing(row.created_at), completedAt: iso(row.completed_at),
    completedAtBeijing: beijing(row.completed_at), cancelledAt: iso(row.cancelled_at),
    cancelledAtBeijing: beijing(row.cancelled_at), timeZone: TIME_ZONE }));
  const eventRows = operations.map((row) => ({ eventId: row.id, sessionId: row.workspace_id, studentCode: row.student_number,
    phase: 'practice', attemptNumber: row.attempt_number, sequenceNumber: row.seq, eventType: `CANVAS_${String(row.operation_type).toUpperCase()}`,
    currentAiState: '', aiCycleId: '', withdrawalEventId: '', activeSeconds: row.active_seconds, elapsedMs: null,
    occurredAtClient: iso(row.occurred_at_client), occurredAtClientBeijing: beijing(row.occurred_at_client), occurredAt: iso(row.created_at),
    occurredAtBeijing: beijing(row.created_at), systemVersion: '', ruleVersion: task.rule_version, payload: row.payload, timeZone: TIME_ZONE }));
  const integrityRows = sessions.map((row) => { const sessionSnapshots = snapshots.filter((snapshot) => snapshot.workspace_id === row.id); const issues = [];
    if (!sessionSnapshots.some((snapshot) => snapshot.snapshot_kind === 'baseline')) issues.push('MISSING_BASELINE_SNAPSHOT');
    if (row.status === 'submitted' && !sessionSnapshots.some((snapshot) => snapshot.snapshot_kind === 'final')) issues.push('MISSING_FINAL_SNAPSHOT');
    return { sessionId: row.id, studentCode: row.student_number, phase: 'practice', attemptNumber: row.attempt_number,
      eventCount: operations.filter((operation) => operation.workspace_id === row.id).length, snapshotCount: sessionSnapshots.length,
      withdrawalCount: withdrawals.filter((withdrawal) => withdrawal.workspace_id === row.id).length, valid: issues.length === 0, issues: issues.join('|') };
  });
  const practiceRows = eventRows.map((row) => ({ eventId: row.eventId, studentCode: row.studentCode, actorRole: 'student', module: 'drawing',
    actionType: row.eventType, canvasSessionId: row.sessionId, ideationAttemptId: '', payload: row.payload,
    occurredAt: row.occurredAt, occurredAtBeijing: row.occurredAtBeijing, timeZone: TIME_ZONE }));
  const configRows = sessions.map((row) => ({ sessionId: row.id, studentCode: row.student_number, phase: 'practice', configSnapshot }));
  const dictionaryRows = CANVAS_EXPORT_CONTRACT.slice(0, -1).map(([sheet]) => ({ sheet, meaning: `English subsystem data mapped to the same ${sheet} contract used by the Chinese system.` }));
  return buildXlsx(contractSheets({ sessions: sessionRows, canvas_operations: operationRows, snapshot_index: snapshotRows,
    ideation_revisions: [], assistant_messages: messageRows, assistant_events: [], assistant_mask_hovers: [],
    flow_evaluations: flowRows, ai_cycles: [], withdrawal_events: withdrawalRows, agency_decisions: decisionRows, canvas_event_log: eventRows,
    data_integrity: integrityRows, submission_reviews: [], practice_activity_events: practiceRows,
    config_snapshot: configRows, data_dictionary: dictionaryRows }));
}

module.exports = { buildDrawingWorkbook };
