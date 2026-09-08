const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const web = fs.readFileSync(path.join(root, 'src', 'web', 'App.jsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'web', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'server', 'app.js'), 'utf8');
const agency = fs.readFileSync(path.join(root, 'src', 'server', 'aiAgency.js'), 'utf8');
const modelSettings = fs.readFileSync(path.join(root, 'src', 'server', 'modelSettings.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '008_quick_prompt_tracking.sql'), 'utf8');
const policyMigration = fs.readFileSync(path.join(root, 'migrations', '015_unified_withdrawal_agency.sql'), 'utf8');
const executionRepairMigration = fs.readFileSync(path.join(root, 'migrations', '016_repair_withdrawal_execution.sql'), 'utf8');
const paperAlignmentMigration = fs.readFileSync(path.join(root, 'migrations', '017_paper_alignment.sql'), 'utf8');

test('DrawBreath exposes all three translated Chinese drawing quick prompts and records their keys', () => {
  assert.match(web, /Look at my drawing/);
  assert.match(web, /Please look at my current drawing and tell me what you notice\./);
  assert.match(web, /Give me one suggestion/);
  assert.match(web, /Please consider my idea and current drawing, and give me one small suggestion I can try\./);
  assert.match(web, /Think about the next step/);
  assert.match(web, /Where could I continue drawing next\?/);
  assert.match(server, /\['observe', 'suggest', 'next_step'\]/);
  assert.match(migration, /quick_prompt_key/);
});

test('DrawBreath preserves the staged assistant withdrawal and conversation choices', () => {
  assert.match(server, /nextAssistantState = 'fading'/);
  assert.match(server, /assistant\/withdrawal-complete/);
  assert.match(web, /Start a new conversation/);
  assert.match(web, /Continue the previous conversation/);
  assert.match(web, /assistant-obscured/);
  assert.match(web, /assistantState === 'fading' \|\| assistantState === 'withdrawn'/);
  assert.match(migration, /conversation_id/);
});

test('DrawBreath persists withdrawal evidence and exposes model diagnostics to teachers', () => {
  assert.match(server, /evaluateDrawingFlow\(operations\.rows/);
  assert.match(server, /agency\.decision\.valid === true/);
  assert.match(server, /agency\.decision\.action === 'WITHDRAW'/);
  assert.match(server, /INSERT INTO flow_evaluations/);
  assert.match(server, /INSERT INTO withdrawal_events/);
  assert.match(server, /\/api\/teacher\/tasks\/:id\/ai-decisions/);
  assert.match(server, /\/api\/teacher\/tasks\/:id\/ai-decisions\.xlsx/);
  assert.match(web, /AI Decision Log/);
  assert.match(web, /Download decision Excel/);
  assert.match(web, /\/teacher\/tasks\/\$\{taskId\}\/ai-decisions\.xlsx/);
  assert.match(web, /Trigger and decision evidence/);
  assert.match(web, /Raw model response/);
  assert.match(web, /Beijing time \(UTC\+08:00\)/);
});

test('DrawBreath uses one historical-style model agency with transaction-safe execution', () => {
  assert.match(server, /reviewUnifiedWithdrawal/);
  assert.match(server, /withdrawal_review_request_id/);
  assert.match(server, /withdrawal_review_claimed_at/);
  assert.match(server, /FROM workspaces WHERE id = \$1 AND status = \$2 FOR UPDATE/);
  assert.match(server, /evidenceStillCurrent/);
  assert.match(server, /assistant\/access/);
  assert.match(web, /post\('\/student\/assistant\/access'/);
  assert.match(server, /decisionMode: 'model-agency-with-safety-boundaries'/);
  assert.match(agency, /STAY\|OBSERVE\|WITHDRAW\|CANCEL_WITHDRAWAL/);
  assert.match(agency, /action: 'OBSERVE'/);
  assert.match(agency, /UNUSED_PRESENCE/);
  assert.doesNotMatch(web, /Simplified binary agency/);
  assert.doesNotMatch(web, /Legacy multi-stage gate/);
  assert.doesNotMatch(server, /reviewLightweightWithdrawal/);
  assert.doesNotMatch(server, /reviewLegacyWithdrawal/);
  assert.match(policyMigration, /SET rule_version = 'withdrawal_rules_v1'/);
  assert.match(web, /assistant\/response-complete/);
});

test('DrawBreath reviews on schedule and applies the 450/650 ms hover timings', () => {
  const reviewEffect = web.slice(web.indexOf('const reportAssistantAccess'), web.indexOf("useEffect(() => { if (assistantState !== 'fading')"));
  const pointerHandlers = web.slice(web.indexOf('onPointerEnter={() =>'), web.indexOf('<div className="assistant-title">'));
  const pointerEnter = pointerHandlers.slice(0, pointerHandlers.indexOf('onPointerLeave'));
  const pointerLeave = pointerHandlers.slice(pointerHandlers.indexOf('onPointerLeave'), pointerHandlers.indexOf('onPointerDown'));
  assert.match(reviewEffect, /lastAiAccessActiveSeconds: lastAiAccessAtRef\.current/);
  assert.match(reviewEffect, /nextReviewSeconds = Math\.max\(3, Number\(result\.nextReviewSeconds\)/);
  assert.match(reviewEffect, /timer = setTimeout\(review/);
  assert.doesNotMatch(reviewEffect, /setInterval\(review/);
  assert.match(reviewEffect, /\['fading', 'withdrawn'\]\.includes\(assistantState\)/);
  assert.match(reviewEffect, /\[assistantState, state\.task\.aiPolicy/);
  assert.match(pointerEnter, /setTimeout\(\(\) => \{ setPanelActive\(true\); setAssistantRevealed\(true\); reportAssistantAccess\(\)/);
  assert.match(pointerEnter, /\}, 450\)/);
  assert.doesNotMatch(pointerEnter.split('setTimeout')[0], /reportAssistantAccess\(/);
  assert.match(pointerLeave, /setAssistantRevealed\(false\)/);
  assert.match(pointerLeave, /setTimeout\(\(\) => setAssistantRevealed\(false\), 650\)/);
});

test('DrawBreath can review unused presence and sends the current canvas to the decision agent', () => {
  const unifiedReview = server.slice(server.indexOf('async function reviewUnifiedWithdrawal'), server.indexOf("app.post('/api/student/assistant/review'"));
  assert.match(unifiedReview, /FROM assistant_messages WHERE workspace_id = \$1/);
  assert.match(unifiedReview, /const completedInteractionCount = Math\.min\(/);
  assert.match(unifiedReview, /const safetyBlockReasons = Object\.entries\(safetyRules\)/);
  assert.ok(unifiedReview.indexOf('if (safetyBlockReasons.length)') < unifiedReview.indexOf('const requestId = crypto.randomUUID()'));
  assert.doesNotMatch(unifiedReview, /no-completed-ai-interaction/);
  assert.match(unifiedReview, /currentCanvasAvailable: Boolean\(imageBuffer\)/);
  assert.match(unifiedReview, /judgeAssistantState\(state\.task\.ownerId, pendingReview\.evidence, pendingReview\.imageBuffer\)/);
  assert.match(agency, /UNUSED_PRESENCE/);
  assert.match(agency, /supportEpisodeStatus.*NOT_USED/s);
});

test('DrawBreath masks the entire assistant body except its title', () => {
  assert.match(web, /className="assistant-body"/);
  assert.match(web, /className="assistant-title"/);
  assert.match(web, /className="assistant-conversation"/);
  assert.match(styles, /assistant-obscured \.assistant-maskable/);
  assert.match(styles, /assistant-obscured \.assistant-body::after/);
  assert.doesNotMatch(styles, /assistant-obscured \.assistant-title/);
  assert.doesNotMatch(styles, /assistant-obscured \.assistant-conversation/);
  assert.doesNotMatch(styles, /assistant-obscured::after/);
});

test('DrawBreath lets re-engagement cancel the 2.5-second fade', () => {
  assert.match(server, /assistant\/withdrawal-cancel/);
  assert.match(server, /child-reengaged-during-fade/);
  assert.match(server, /SELECT assistant_state, active_withdrawal_id FROM workspaces WHERE id = \$1 FOR UPDATE/);
  assert.match(web, /const cancelWithdrawal = async/);
  assert.match(web, /onCancel=\{cancelWithdrawal\}/);
  assert.match(web, /if \(settling\) onCancel\(\)/);
});

test('DrawBreath logs drawing-tool changes and defaults to one attempt', () => {
  assert.match(web, /type: 'tool_change'/);
  assert.match(server, /'tool_change'/);
  assert.match(paperAlignmentMigration, /operation_type IN \('stroke', 'erase', 'undo', 'redo', 'clear', 'tool_change'\)/);
  assert.match(paperAlignmentMigration, /new_attempts_allowed SET DEFAULT false/);
});

test('DrawBreath uses the two-choice surface throughout withdrawal', () => {
  const withdrawn = web.slice(web.indexOf('function WithdrawnAssistant'), web.indexOf('export default function App'));
  const reviewRoute = server.slice(server.indexOf("app.post('/api/student/assistant/review'"), server.indexOf("app.post('/api/student/assistant/withdrawal-complete'"));
  assert.match(withdrawn, /Start a new conversation/);
  assert.match(withdrawn, /Continue the previous conversation/);
  assert.doesNotMatch(withdrawn, /className="messages"/);
  assert.doesNotMatch(withdrawn, /className="ask-row"/);
  assert.match(reviewRoute, /assistantState === 'fading' \|\| assistantState === 'withdrawn'/);
  assert.match(reviewRoute, /reviewSuspended: true/);
  assert.doesNotMatch(web, /Conversation options become available/);
});

test('DrawBreath records every AI decision run but keeps failed gates separate', () => {
  const gateFailure = server.slice(server.indexOf('if (safetyBlockReasons.length)'), server.indexOf('const requestId = crypto.randomUUID()', server.indexOf('if (safetyBlockReasons.length)')));
  assert.match(server, /auditStage: 'model-review'/);
  assert.ok((server.match(/recordAiDecision\(/g) || []).length >= 2);
  assert.match(server, /executionStatus: 'decision-returned'/);
  assert.match(server, /execution-transaction-failed/);
  assert.match(server, /async function updateAiDecision/);
  assert.doesNotMatch(gateFailure, /recordAiDecision\(/);
  assert.match(agency, /modelInvoked: false, fallback: true/);
  assert.match(agency, /modelInvoked: true, fallback: true/);
  assert.match(web, /AI decision records/);
  assert.doesNotMatch(web, /Gate only/);
  assert.match(web, /provider not invoked; fallback decision recorded/);
  assert.match(web, /No AI decision records yet/);
});

test('DrawBreath blocks concurrent reviews and assistant responses in the database', () => {
  assert.match(server, /reviewInFlight/);
  assert.match(server, /WITHDRAWAL_REVIEW_LEASE_MILLISECONDS/);
  assert.match(server, /assistant_response_pending/);
  assert.match(server, /assistant_response_request_id/);
  assert.match(policyMigration, /withdrawal_review_request_id/);
  assert.match(policyMigration, /assistant_response_pending/);
});

test('DrawBreath repairs stale withdrawal references before executing a model withdrawal', () => {
  assert.match(server, /async function releaseStaleWithdrawalReference/);
  assert.ok((server.match(/releaseStaleWithdrawalReference\(/g) || []).length >= 3);
  assert.match(server, /executionBlockReasons/);
  assert.match(server, /assistant_state = \$1::varchar/);
  assert.match(server, /CASE WHEN \$1::varchar = 'fading'/);
  assert.match(executionRepairMigration, /stale-visible-withdrawal-reference/);
  assert.match(executionRepairMigration, /active_withdrawal_id = NULL/);
  assert.match(web, /Execution failed/);
  assert.match(web, /Not executed/);
  assert.match(web, /Normalized and execution result/);
});

test('DrawBreath assistant replies and withdrawal decisions share one model resolver', () => {
  assert.match(server, /modelConfig = await runtimeModel\(ownerId\)/);
  assert.match(agency, /model = await runtimeModel\(ownerId\)/);
  assert.match(modelSettings, /ORDER BY priority, created_at, id LIMIT 1/);
  assert.match(modelSettings, /source: 'model-node'/);
  assert.match(server, /modelRoute: agency\.modelRoute/);
});

test('DrawBreath sends recent conversation and canvas imagery to the translated assistant prompt', () => {
  assert.match(server, /Recent conversation:/);
  assert.match(server, /image_url/);
  assert.match(server, /history: state\.messages/);
  assert.match(web, /assistantImage: \(\) => composite\(1200\)/);
  assert.match(web, /image = await canvasRef\.current\?\.assistantImage\?\.\(\) \|\| ''/);
  assert.match(web, /image = canvasRef\.current\?\.overlay\?\.\(\) \|\| ''/);
  assert.match(server, /req\.body\.image \? pngDataBuffer\(req\.body\.image\)/);
});

test('DrawBreath keeps the server-bounded canvas size for high-resolution backgrounds', () => {
  assert.doesNotMatch(web, /setDimensions\(\{ width: image\.naturalWidth/);
  assert.match(web, /className="canvas-stage" ref=\{stageRef\}/);
  assert.match(web, /Math\.min\(availableWidth \/ dimensions\.width, availableHeight \/ dimensions\.height\)/);
  assert.match(web, /aspectRatio: `\$\{dimensions\.width\} \/ \$\{dimensions\.height\}`/);
});

test('DrawBreath matches the Chinese full-board canvas and allows drawing outside the locked frame', () => {
  const canvas = web.slice(web.indexOf('const DrawingCanvas'), web.indexOf('function WithdrawnAssistant'));
  assert.match(web, /const CANVAS_BOARD_SIZE = 1200/);
  assert.match(web, /function lockedBackgroundGeometry/);
  assert.match(web, /Math\.min\(usableSide \/ naturalWidth, usableSide \/ naturalHeight\)/);
  assert.match(web, /context\.strokeRect\(geometry\.frameX, geometry\.frameY, geometry\.frameSide, geometry\.frameSide\)/);
  assert.match(canvas, /backgroundCanvasRef/);
  assert.match(canvas, /className="canvas-background"/);
  assert.match(canvas, /className="canvas-locked-frame"/);
  assert.match(canvas, /className="canvas-drawing"/);
  assert.match(canvas, /drawLockedBackground\(context, backgroundImageRef\.current, output\.width, output\.height\)/);
  assert.match(canvas, /x: \(event\.clientX - rect\.left\) \* dimensions\.width \/ rect\.width/);
  assert.doesNotMatch(canvas, /<img ref=\{backgroundRef\}/);
  assert.match(styles, /canvas-frame \.canvas-background \{[^}]*pointer-events:none; \}/);
  assert.match(styles, /canvas-locked-frame \{[^}]*top:16%; left:16%; width:68%; height:68%; border:2px solid #111/);
});

test('DrawBreath redraws the locked frame into every exported composite', () => {
  const canvas = web.slice(web.indexOf('const DrawingCanvas'), web.indexOf('function StudentStudio'));
  const composite = canvas.slice(canvas.indexOf('const composite'), canvas.indexOf('const saveCopy'));
  assert.match(composite, /drawLockedBackground\(context, backgroundImageRef\.current, output\.width, output\.height\)/);
  assert.match(composite, /context\.drawImage\(canvasRef\.current, 0, 0, output\.width, output\.height\)/);
  assert.ok(composite.indexOf('drawLockedBackground') < composite.indexOf('context.drawImage(canvasRef.current'));
  assert.match(canvas, /assistantImage: \(\) => composite\(1200\)/);
  assert.match(canvas, /processSnapshot: \(\) => composite\(960, 'image\/webp', 0\.68\)/);
  assert.match(canvas, /baselineSnapshot: \(\) => composite\(1200\)/);
  assert.match(web, /const image = await canvasRef\.current\.composite\(\)/);
});

test('DrawBreath keeps the compact desktop canvas while allowing the page to scroll', () => {
  const desktopWorkspace = styles.slice(styles.indexOf('/* Keep the complete drawing workspace within the desktop viewport. */'));
  assert.match(styles, /html \{[^}]*overflow-y:scroll/);
  assert.match(styles, /body,#root \{[^}]*height:auto;[^}]*overflow:visible/);
  assert.match(desktopWorkspace, /\.studio-shell \{ min-height:100dvh;[^}]*overflow:visible/);
  assert.match(desktopWorkspace, /\.studio-grid \{ height:clamp\(520px,calc\(100dvh - 155px\),720px\);[^}]*overflow:visible/);
  assert.doesNotMatch(desktopWorkspace, /\.studio-shell \{ height:100dvh/);
  assert.match(web, /studio-shell-final/);
  const finalPanel = web.slice(web.indexOf("{final ? <section"), web.indexOf(': <div className={`studio-grid'));
  assert.ok(finalPanel.indexOf('Start another attempt') < finalPanel.indexOf('finalImageUrl'));
});

test('DrawBreath degrades visual AI failures without returning a server error', () => {
  assert.match(server, /model configuration could not be loaded/);
  assert.match(server, /visual request failed; retrying without image/);
  assert.match(server, /return await request\(false\)/);
  assert.match(server, /return fallback/);
  assert.match(server, /AbortSignal\.timeout\(60000\)/);
});

test('DrawBreath follows new messages unless the student is browsing history', () => {
  assert.match(web, /followLatestMessageRef/);
  assert.match(web, /list\.scrollHeight - list\.scrollTop - list\.clientHeight <= 48/);
  assert.match(web, /if \(!list \|\| !followLatestMessageRef\.current\) return/);
  assert.match(web, /list\.scrollTop = list\.scrollHeight/);
});

test('DrawBreath shows completed drawing attempts in a modal without external navigation', () => {
  assert.match(web, /View history/);
  assert.match(web, /Completed Drawing History/);
  assert.match(web, /drawing-history-grid/);
  assert.doesNotMatch(web, /href=\{item\.imageUrl\} target="_blank"/);
});

test('DrawBreath keeps branding in identity labels and uses Chinese-equivalent functional wording', () => {
  for (const label of ['Drawing Practice', 'Drawing Complete', 'YOUR DRAWING TASK', 'Creative Assistant', 'Preparing a tip...', "I'm finished drawing", 'Completed Drawing History']) {
    assert.match(web, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(web, /\{displayName\} for Students/);
  assert.match(web, /\{displayName\} Teacher Console/);
  assert.match(web, /\{displayName\} Teacher Sign In/);
  for (const awkwardLabel of ['${displayName} Studio', '${displayName} Studio Partner', '${displayName} drawing history', 'YOUR ${displayName} DRAWING TASK', 'Create a ${displayName} drawing task', 'All ${displayName} tasks']) {
    assert.doesNotMatch(web, new RegExp(awkwardLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('DrawBreath background drawing services do not surface internal failures in the studio', () => {
  const backgroundReview = web.slice(web.indexOf("post('/student/assistant/review'"), web.indexOf("useEffect(() => { if (assistantState !== 'fading')"));
  const withdrawalSync = web.slice(web.indexOf("post('/student/assistant/withdrawal-complete'"), web.indexOf('useEffect(() => { const list = messageListRef.current'));
  assert.match(agency, /try \{\s*model = await runtimeModel\(ownerId\);/);
  assert.match(agency, /model-configuration:/);
  assert.match(backgroundReview, /background review failed/);
  assert.doesNotMatch(backgroundReview, /setError\(/);
  assert.match(withdrawalSync, /withdrawal sync failed/);
  assert.doesNotMatch(withdrawalSync, /setError\(/);
  assert.match(server, /draft saved but process snapshot failed/);
  assert.match(server, /saved: true, snapshotSaved/);
});

test('DrawBreath finalizes the workspace and final snapshot in one transaction', () => {
  const submission = server.slice(server.indexOf("app.post('/api/student/submit'"), server.indexOf("const dist = path.join"));
  assert.match(submission, /await client\.query\('BEGIN'\)/);
  assert.match(submission, /AND status = 'draft' RETURNING id/);
  assert.match(submission, /INSERT INTO canvas_snapshots/);
  assert.match(submission, /await client\.query\('COMMIT'\)/);
  assert.match(submission, /await client\.query\('ROLLBACK'\)/);
  assert.match(submission, /removeStoredFile\(relative\)/);
  assert.match(submission, /removeStoredFile\(snapshotRelative\)/);
});
