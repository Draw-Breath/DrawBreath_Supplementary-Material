const { buildXlsx } = require('./excel');

const beijingFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

const beijingTime = (value) => value ? beijingFormatter.format(new Date(value)).replace(' ', 'T') : '';

const decisionColumns = [
  ['id', 'Decision ID'], ['workspaceId', 'Workspace ID'], ['studentName', 'Student name'],
  ['studentNumber', 'Student number'], ['attemptNumber', 'Attempt number'], ['activeSeconds', 'Active seconds'],
  ['action', 'Decision action'], ['confidence', 'Confidence'], ['decisionSummary', 'Decision reason'],
  ['supportNeed', 'Support need'], ['supportEpisodeStatus', 'Support episode status'], ['withdrawalType', 'Withdrawal type'],
  ['valid', 'Valid decision'], ['validationError', 'Validation error'], ['executionStatus', 'Execution status'],
  ['executionReason', 'Execution reason'], ['executionBlockReasons', 'Execution block reasons'],
  ['modelInvoked', 'Model invoked'], ['modelName', 'Model name'], ['modelRoute', 'Model route'],
  ['promptVersion', 'Prompt version'], ['fallback', 'Fallback used'], ['responseError', 'Response error'],
  ['createdAt', 'Created at (UTC)'], ['createdAtBeijing', 'Created at (Beijing)'],
  ['evidenceForWithdrawal', 'Evidence for withdrawal'], ['evidenceAgainstWithdrawal', 'Evidence against withdrawal'],
  ['uncertainties', 'Uncertainties'], ['nextReviewSeconds', 'Next review after seconds'],
  ['evidence', 'Trigger and decision evidence'], ['promptSystem', 'System prompt'], ['promptInput', 'Input prompt'],
  ['rawResponse', 'Raw model response'], ['normalizedDecision', 'Normalized and execution result']
].map(([key, label]) => ({ key, label }));

const evaluationColumns = [
  ['id', 'Evaluation ID'], ['workspaceId', 'Workspace ID'], ['studentName', 'Student name'],
  ['studentNumber', 'Student number'], ['attemptNumber', 'Attempt number'], ['activeSeconds', 'Active seconds'],
  ['windowSeconds', 'Evaluation window seconds'], ['passed', 'Evaluation passed'],
  ['consecutivePasses', 'Consecutive passes'], ['decision', 'Evaluation decision'],
  ['evaluatedAt', 'Evaluated at (UTC)'], ['evaluatedAtBeijing', 'Evaluated at (Beijing)'],
  ['metrics', 'Flow metrics'], ['thresholds', 'Evaluation thresholds']
].map(([key, label]) => ({ key, label }));

async function loadDrawingDecisionLog(database, taskId, { limited = true } = {}) {
  const decisionLimit = limited ? 'LIMIT 500' : '';
  const evaluationLimit = limited ? 'LIMIT 1000' : '';
  const [decisions, evaluations] = await Promise.all([
    database.query(`SELECT d.*, p.display_name, p.student_number, w.attempt_number
      FROM ai_decisions d JOIN workspaces w ON w.id = d.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY d.created_at DESC, d.id DESC ${decisionLimit}`, [taskId]),
    database.query(`SELECT e.*, p.display_name, p.student_number, w.attempt_number
      FROM flow_evaluations e JOIN workspaces w ON w.id = e.workspace_id JOIN participants p ON p.id = w.participant_id
      WHERE w.task_id = $1 ORDER BY e.evaluated_at DESC, e.id DESC ${evaluationLimit}`, [taskId])
  ]);
  return {
    decisions: decisions.rows.map((row) => ({
      id: row.id, workspaceId: row.workspace_id, studentName: row.display_name, studentNumber: row.student_number,
      attemptNumber: row.attempt_number, activeSeconds: row.active_seconds, evidence: row.evidence,
      promptSystem: row.prompt_system, promptInput: row.prompt_input, rawResponse: row.raw_response,
      normalizedDecision: row.normalized_decision, modelName: row.model_name, fallback: row.fallback,
      responseError: row.response_error, createdAt: row.created_at, createdAtBeijing: beijingTime(row.created_at)
    })),
    evaluations: evaluations.rows.map((row) => ({
      id: row.id, workspaceId: row.workspace_id, studentName: row.display_name, studentNumber: row.student_number,
      attemptNumber: row.attempt_number, activeSeconds: row.active_seconds, windowSeconds: row.window_seconds,
      metrics: row.metrics, thresholds: row.thresholds, passed: row.passed,
      consecutivePasses: row.consecutive_passes, decision: row.decision,
      evaluatedAt: row.evaluated_at, evaluatedAtBeijing: beijingTime(row.evaluated_at)
    }))
  };
}

async function buildDrawingDecisionWorkbook(log) {
  const decisions = log.decisions.map((item) => ({
    ...item,
    action: item.normalizedDecision?.action || '',
    confidence: item.normalizedDecision?.confidence ?? null,
    decisionSummary: item.normalizedDecision?.decisionSummary || '',
    supportNeed: item.normalizedDecision?.supportNeed || '',
    supportEpisodeStatus: item.normalizedDecision?.supportEpisodeStatus || '',
    withdrawalType: item.normalizedDecision?.withdrawalType || '',
    valid: item.normalizedDecision?.valid,
    validationError: item.normalizedDecision?.validationError || '',
    executionStatus: item.normalizedDecision?.executionStatus || '',
    executionReason: item.normalizedDecision?.executionReason || '',
    executionBlockReasons: item.normalizedDecision?.executionBlockReasons || [],
    modelInvoked: item.normalizedDecision?.modelInvoked,
    modelRoute: item.normalizedDecision?.modelRoute || {},
    promptVersion: item.normalizedDecision?.promptVersion || '',
    evidenceForWithdrawal: item.normalizedDecision?.evidenceForWithdrawal || [],
    evidenceAgainstWithdrawal: item.normalizedDecision?.evidenceAgainstWithdrawal || [],
    uncertainties: item.normalizedDecision?.uncertainties || [],
    nextReviewSeconds: item.normalizedDecision?.nextReviewSeconds ?? null
  }));
  return buildXlsx([
    { name: 'ai_decisions', columns: decisionColumns, rows: decisions },
    { name: 'review_evaluations', columns: evaluationColumns, rows: log.evaluations }
  ]);
}

module.exports = {
  loadDrawingDecisionLog,
  buildDrawingDecisionWorkbook,
  decisionColumns,
  evaluationColumns
};
