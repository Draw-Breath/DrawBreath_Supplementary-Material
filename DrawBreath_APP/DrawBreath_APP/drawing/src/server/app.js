const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { pool } = require('./db');
const { verifyPassword, tokenFor, requireRole } = require('./auth');
const { decrypt, encrypt, runtimeModel } = require('./modelSettings');
const { buildTaskImageArchive } = require('./imageArchive');
const { readImageDimensions } = require('./imageDimensions');
const { judge: judgeAssistantState } = require('./aiAgency');
const {
  WITHDRAWAL_RULE_VERSION,
  canEvaluateAssistantWithdrawal,
  evaluateDrawingFlow,
} = require('./canvasPolicy');
const { DRAWING_CONTINUATION_SYSTEM } = require('./assistantPrompt');
const { groupTeacherAttempts } = require('./teacherDetail');
const { buildDrawingWorkbook } = require('./teacherExport');
const { loadDrawingDecisionLog, buildDrawingDecisionWorkbook } = require('./decisionLog');

const app = express();
const DEFAULT_TASK_PROMPT = 'Create an original drawing by incorporating, extending, or reinterpreting the provided shape.';
const DECISION_REVIEW_INTERVAL_SECONDS = 30;
app.use(express.json({ limit: '18mb' }));
const backgroundRoot = path.join(config.uploadRoot, 'backgrounds');
const workspaceRoot = path.join(config.uploadRoot, 'workspaces');
fs.mkdirSync(backgroundRoot, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: backgroundRoot,
    filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg'}`)
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
});

const cleanText = (value, max = 4000) => String(value || '').trim().slice(0, max);
const databaseText = (value, max = 200000) => String(value || '').replace(/\u0000/g, '').slice(0, max);
const jsonForDatabase = (value) => JSON.stringify(value ?? {}, (_key, item) => {
  if (typeof item === 'bigint') return item.toString();
  if (typeof item === 'string') return item.replace(/\u0000/g, '');
  return item;
});
async function recordAiDecision(database, { workspaceId, activeSeconds, evidence, normalizedDecision, agency = {} }) {
  const decisionId = crypto.randomUUID();
  await database.query(`INSERT INTO ai_decisions (id, workspace_id, active_seconds, evidence, normalized_decision,
    raw_response, prompt_system, prompt_input, model_name, fallback, response_error)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)`,
  [decisionId, workspaceId, activeSeconds, jsonForDatabase(evidence), jsonForDatabase(normalizedDecision),
    jsonForDatabase(agency.raw || {}), databaseText(agency.promptSystem), databaseText(agency.promptInput),
    databaseText(agency.model, 160), agency.fallback === true, databaseText(agency.error, 20000)]);
  return decisionId;
}
async function updateAiDecision(database, decisionId, normalizedDecision) {
  await database.query('UPDATE ai_decisions SET normalized_decision = $1::jsonb WHERE id = $2',
    [jsonForDatabase(normalizedDecision), decisionId]);
}
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const problem = (status, message) => Object.assign(new Error(message), { status });
const publicPath = (relative) => relative ? `${config.basePath}/uploads/${String(relative).replace(/\\/g, '/')}` : '';
const boundedInt = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
const flag = (value, fallback) => value == null ? fallback : value === true || String(value).toLowerCase() === 'true';
const withdrawalRuleVersion = () => WITHDRAWAL_RULE_VERSION;
const studentName = (value) => cleanText(value, 80).normalize('NFKC').replace(/\s+/g, ' ');
const studentKey = (value) => studentName(value).toLocaleLowerCase('en-US');
const csvCell = (value) => { const text = String(value == null ? '' : value); const safe = /^[=+\-@]/.test(text) ? `'${text}` : text; return `"${safe.replace(/"/g, '""')}"`; };
const csvResponse = (res, filename, rows) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`);
};
const removeStoredFile = (relative) => {
  if (!relative) return;
  const target = path.resolve(config.uploadRoot, relative);
  const root = `${path.resolve(config.uploadRoot)}${path.sep}`;
  if (target.startsWith(root)) fs.rmSync(target, { force: true });
};
const readStoredFile = (relative) => {
  if (!relative) return null;
  const target = path.resolve(config.uploadRoot, relative);
  const root = `${path.resolve(config.uploadRoot)}${path.sep}`;
  if (!target.startsWith(root)) return null;
  return fs.readFileSync(target);
};

async function studentAccount(client, input) {
  const name = studentName(input);
  if (Array.from(name).length < 2) throw problem(400, 'Name must contain at least 2 characters.');
  const key = studentKey(name);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`task-platform-student:${key}`]);
  const existing = await client.query('SELECT * FROM student_accounts WHERE student_number_key = $1 FOR UPDATE', [key]);
  if (existing.rowCount) {
    const updated = await client.query('UPDATE student_accounts SET student_number = $1, updated_at = now(), last_login_at = now() WHERE id = $2 RETURNING *', [name, existing.rows[0].id]);
    return updated.rows[0];
  }
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  const inserted = await client.query('INSERT INTO student_accounts (id, student_code, student_number, student_number_key, last_login_at) VALUES ($1, $2, $3, $4, now()) RETURNING *', [crypto.randomUUID(), code, name, key]);
  return inserted.rows[0];
}

async function participantForStudent(client, taskId, account, name) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`task-platform-participant:${taskId}:${studentKey(name)}`]);
  const linked = await client.query('SELECT * FROM participants WHERE task_id = $1 AND student_account_id = $2 FOR UPDATE', [taskId, account.id]);
  if (linked.rowCount) return linked.rows[0];
  const legacy = await client.query(`
    SELECT p.* FROM participants p
    WHERE p.task_id = $1 AND p.student_account_id IS NULL
      AND lower(regexp_replace(btrim(p.student_number), '[[:space:]]+', ' ', 'g')) = $2
    ORDER BY p.created_at, p.id
    LIMIT 1
    FOR UPDATE OF p
  `, [taskId, studentKey(name)]);
  if (!legacy.rowCount) return null;
  const claimed = await client.query(`
    UPDATE participants SET student_account_id = $1
    WHERE id = $2 AND student_account_id IS NULL
    RETURNING *
  `, [account.id, legacy.rows[0].id]);
  return claimed.rows[0] || null;
}

function publicTask(row) {
  return {
    id: row.id, title: row.title, joinCode: row.join_code, status: row.status,
    prompt: row.prompt || DEFAULT_TASK_PROMPT, instructions: row.instructions || '',
    backgroundUrl: publicPath(row.background_path), canvasWidth: row.canvas_width,
    canvasHeight: row.canvas_height, timeLimitSeconds: row.time_limit_seconds, aiEnabled: row.ai_policy !== 'off',
    studentExitEnabled: row.student_exit_enabled !== false, studentWhitelistEnabled: row.student_whitelist_enabled === true,
    voiceEnabled: row.voice_enabled !== false,
    snapshotIntervalSeconds: row.snapshot_interval_seconds ?? 30, aiAppearSeconds: row.ai_appear_seconds ?? 120,
    aiMinVisibleSeconds: row.ai_min_visible_seconds ?? 15,
    flowWindowSeconds: row.flow_window_seconds ?? 30, flowIdleSeconds: row.flow_idle_seconds ?? 10,
    flowEvaluationIntervalSeconds: row.flow_evaluation_interval_seconds ?? 15,
    reopenCooldownSeconds: row.reopen_cooldown_seconds ?? 180,
    flowConsecutivePasses: row.flow_consecutive_passes ?? 3,
    aiAccessQuietSeconds: row.ai_access_quiet_seconds ?? 20,
    withdrawalCandidateSeconds: row.withdrawal_candidate_seconds ?? 15,
    withdrawalFadeMilliseconds: row.withdrawal_fade_milliseconds ?? 2500,
    postWithdrawalObservationSeconds: row.post_withdrawal_observation_seconds ?? 90,
    ruleVersion: WITHDRAWAL_RULE_VERSION, artworkPassScore: row.artwork_pass_score ?? 55,
    aiPolicy: row.ai_policy || 'adaptive',
    aiLifecycleEnabled: row.ai_lifecycle_enabled !== false,
    newAttemptsAllowed: row.new_attempts_allowed === true,
    participantCount: Number(row.participant_count || 0), submittedCount: Number(row.submitted_count || 0), createdAt: row.created_at
  };
}

async function ownedTask(id, ownerId) {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  if (!result.rowCount) throw problem(404, 'Task not found.');
  return result.rows[0];
}

async function workspaceState(participantId) {
  const participantResult = await pool.query(`
    SELECT p.display_name, p.student_number, p.task_id, t.owner_id, t.title, t.prompt, t.instructions, t.background_path,
      t.canvas_width, t.canvas_height, t.time_limit_seconds, t.ai_enabled, t.student_exit_enabled,
      t.voice_enabled,
      t.snapshot_interval_seconds, t.ai_appear_seconds, t.flow_window_seconds, t.flow_idle_seconds,
      t.flow_evaluation_interval_seconds, t.reopen_cooldown_seconds, t.ai_min_visible_seconds,
      t.flow_consecutive_passes, t.ai_access_quiet_seconds, t.withdrawal_candidate_seconds,
      t.withdrawal_fade_milliseconds, t.post_withdrawal_observation_seconds, t.rule_version,
      t.artwork_pass_score, t.ai_policy, t.ai_lifecycle_enabled, t.status AS task_status,
      t.new_attempts_allowed
    FROM participants p JOIN tasks t ON t.id = p.task_id WHERE p.id = $1
  `, [participantId]);
  if (!participantResult.rowCount) throw problem(404, 'Participant not found.');
  const row = participantResult.rows[0];
  const workspaceResult = await pool.query(`SELECT * FROM workspaces WHERE participant_id = $1
    ORDER BY (status = 'draft') DESC, attempt_number DESC LIMIT 1`, [participantId]);
  const workspace = workspaceResult.rows[0] || null;
  const snapshotCount = workspace ? await pool.query('SELECT count(*)::int AS value FROM canvas_snapshots WHERE workspace_id = $1', [workspace.id]) : { rows: [{ value: 0 }] };
  const historyResult = await pool.query(`SELECT id, attempt_number, active_seconds, operation_count,
    final_image_path, submitted_at FROM workspaces WHERE participant_id = $1 AND status = 'submitted'
    ORDER BY attempt_number DESC`, [participantId]);
  const messages = workspace ? await pool.query(`SELECT role, content, quick_prompt_key, conversation_id, created_at
    FROM assistant_messages WHERE workspace_id = $1
      AND ($2::uuid IS NULL OR conversation_id = $2)
    ORDER BY id`, [workspace.id, workspace.active_conversation_id || null]) : { rows: [] };
  return {
    participant: { name: row.display_name, studentNumber: row.student_number },
    task: { id: row.task_id, ownerId: row.owner_id, title: row.title, prompt: row.prompt || DEFAULT_TASK_PROMPT, instructions: row.instructions || '', backgroundUrl: publicPath(row.background_path), canvasWidth: row.canvas_width, canvasHeight: row.canvas_height, timeLimitSeconds: row.time_limit_seconds, aiEnabled: row.ai_policy !== 'off', status: row.task_status, studentExitEnabled: row.student_exit_enabled !== false, voiceEnabled: row.voice_enabled !== false, snapshotIntervalSeconds: row.snapshot_interval_seconds, aiAppearSeconds: row.ai_appear_seconds, aiMinVisibleSeconds: row.ai_min_visible_seconds, flowWindowSeconds: row.flow_window_seconds, flowIdleSeconds: row.flow_idle_seconds, flowEvaluationIntervalSeconds: row.flow_evaluation_interval_seconds, reopenCooldownSeconds: row.reopen_cooldown_seconds, flowConsecutivePasses: row.flow_consecutive_passes, aiAccessQuietSeconds: row.ai_access_quiet_seconds, withdrawalCandidateSeconds: row.withdrawal_candidate_seconds, withdrawalFadeMilliseconds: row.withdrawal_fade_milliseconds, postWithdrawalObservationSeconds: row.post_withdrawal_observation_seconds, ruleVersion: WITHDRAWAL_RULE_VERSION, artworkPassScore: row.artwork_pass_score, aiPolicy: row.ai_policy, aiLifecycleEnabled: row.ai_lifecycle_enabled !== false, newAttemptsAllowed: row.new_attempts_allowed === true },
    workspace: workspace ? { id: workspace.id, attemptNumber: workspace.attempt_number, draftImageUrl: publicPath(workspace.draft_image_path), finalImageUrl: publicPath(workspace.final_image_path), activeSeconds: workspace.active_seconds, operationCount: workspace.operation_count, snapshotCount: Number(snapshotCount.rows[0]?.value || 0), status: workspace.status, timingStartedAt: workspace.timing_started_at, assistantState: workspace.assistant_state || 'hidden', assistantVisibleActiveSeconds: workspace.assistant_visible_active_seconds, lastAiAccessActiveSeconds: workspace.last_ai_access_active_seconds, latestWithdrawalActiveSeconds: workspace.latest_withdrawal_active_seconds, nextAiReviewActiveSeconds: workspace.next_ai_review_active_seconds || 0, flowConsecutivePasses: workspace.flow_consecutive_passes || 0, withdrawalCandidateStartedActiveSeconds: workspace.withdrawal_candidate_started_active_seconds, activeWithdrawalId: workspace.active_withdrawal_id || null, activeConversationId: workspace.active_conversation_id || null, lastAssistantResponseActiveSeconds: workspace.last_assistant_response_active_seconds || 0, lastAssistantResponseOperationSeq: workspace.last_assistant_response_operation_seq || 0, lastAiReviewOperationSeq: workspace.last_ai_review_operation_seq || 0, submittedAt: workspace.submitted_at, updatedAt: workspace.updated_at } : null,
    history: historyResult.rows.map((item) => ({ id: item.id, attemptNumber: item.attempt_number, activeSeconds: item.active_seconds, operationCount: item.operation_count, imageUrl: publicPath(item.final_image_path), submittedAt: item.submitted_at })),
    messages: messages.rows.map((message) => ({ role: message.role, content: message.content, quickPromptKey: message.quick_prompt_key || '', createdAt: message.created_at }))
  };
}

function pngDataBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw problem(400, 'The canvas image is invalid.');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw problem(400, 'The canvas image is too large.');
  return buffer;
}

function snapshotData(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw problem(400, 'The process snapshot is invalid.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw problem(400, 'The process snapshot is too large.');
  return { buffer, extension: match[1] === 'webp' ? 'webp' : 'png' };
}

function saveSnapshotDataUrl(dataUrl, filenameBase) {
  const snapshot = snapshotData(dataUrl);
  const relative = path.join('workspaces', `${filenameBase}.${snapshot.extension}`);
  fs.writeFileSync(path.join(config.uploadRoot, relative), snapshot.buffer);
  return relative;
}

function savePngDataUrl(dataUrl, filename) {
  const buffer = pngDataBuffer(dataUrl);
  fs.writeFileSync(path.join(workspaceRoot, filename), buffer);
  return path.join('workspaces', filename).replace(/\\/g, '/');
}

async function assistantReply({ ownerId, prompt, question, history = [], imageBuffer = null }) {
  const fallback = 'I could not reach the AI service just now. Focus on the part of your drawing that matters most to you, then decide what one relationship, action, or change could make the idea clearer.';
  let modelConfig;
  try { modelConfig = await runtimeModel(ownerId); }
  catch (error) { console.warn('[drawing-assistant] model configuration could not be loaded:', error.message); return fallback; }
  if (!modelConfig.apiKey) return fallback;
  const compactHistory = (Array.isArray(history) ? history : []).slice(-6).map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 500) }));
  const text = `Drawing task: ${prompt}\nRecent conversation: ${JSON.stringify(compactHistory)}\nStudent question: ${question}\nUse the current canvas when available. Give one or two actionable prompts without drawing for the student. Return the decision to the student.`;
  const request = async (includeImage) => {
    const content = includeImage
      ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBuffer.toString('base64')}` } }]
      : text;
    const response = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${modelConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelConfig.model, temperature: 0.7, max_tokens: 300, messages: [
        { role: 'system', content: DRAWING_CONTINUATION_SYSTEM },
        { role: 'user', content }
      ] })
    });
    if (!response.ok) {
      const detail = cleanText(await response.text().catch(() => ''), 500);
      throw new Error(`Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const payload = await response.json();
    const raw = payload.choices?.[0]?.message?.content;
    const reply = typeof raw === 'string' ? cleanText(raw, 2500) : '';
    if (!reply) throw new Error('Provider returned an empty or unsupported response.');
    return reply;
  };
  try {
    return await request(Boolean(imageBuffer));
  } catch (firstError) {
    if (imageBuffer) {
      console.warn('[drawing-assistant] visual request failed; retrying without image:', firstError.message);
      try { return await request(false); }
      catch (textError) { console.warn('[drawing-assistant] text fallback request failed:', textError.message); }
    } else console.warn('[drawing-assistant] request failed:', firstError.message);
    return fallback;
  }
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, mode: 'drawing', database: 'postgresql' });
}));
app.get('/api/config', (_req, res) => res.json({ displayName: config.displayName, homeUrl: config.homeUrl }));
app.use('/uploads', express.static(config.uploadRoot, { fallthrough: false, maxAge: '1h' }));

app.post('/api/teacher/login', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM staff_users WHERE username = $1', [cleanText(req.body.username, 80)]);
  if (!result.rowCount || !verifyPassword(req.body.password, result.rows[0].password_hash)) throw problem(401, 'Incorrect username or password.');
  res.json({ token: tokenFor(result.rows[0].id, 'teacher'), teacher: { id: result.rows[0].id, name: result.rows[0].display_name } });
}));

app.get('/api/teacher/model-nodes', requireRole('teacher'), asyncRoute(async (req, res) => { const result = await pool.query('SELECT id, label, base_url, model_name, enabled, priority, encrypted_api_key <> \'\' AS has_api_key FROM model_nodes WHERE owner_id=$1 ORDER BY priority, created_at', [req.auth.sub]); res.json({ nodes: result.rows.map((row) => ({ id: row.id, label: row.label, baseUrl: row.base_url, model: row.model_name, enabled: row.enabled, priority: row.priority, hasApiKey: row.has_api_key })) }); }));
app.post('/api/teacher/model-nodes', requireRole('teacher'), asyncRoute(async (req, res) => { const label=cleanText(req.body.label,100); const baseUrl=cleanText(req.body.baseUrl,1000).replace(/\/$/,''); const model=cleanText(req.body.model,160); const apiKey=cleanText(req.body.apiKey,1000); if(!label||!baseUrl||!model||!apiKey) throw problem(400,'Label, base URL, model, and API key are required.'); await pool.query('INSERT INTO model_nodes (id,owner_id,label,base_url,model_name,encrypted_api_key,enabled,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),req.auth.sub,label,baseUrl,model,encrypt(apiKey),req.body.enabled!==false,boundedInt(req.body.priority,100,0,10000)]); res.status(201).json({saved:true}); }));
app.patch('/api/teacher/model-nodes/:id', requireRole('teacher'), asyncRoute(async (req,res)=>{ const current=await pool.query('SELECT * FROM model_nodes WHERE id=$1 AND owner_id=$2',[req.params.id,req.auth.sub]); if(!current.rowCount) throw problem(404,'Model node not found.'); const row=current.rows[0]; const label=cleanText(req.body.label,100)||row.label; const baseUrl=(cleanText(req.body.baseUrl,1000)||row.base_url).replace(/\/$/,''); const model=cleanText(req.body.model,160)||row.model_name; const encryptedApiKey=req.body.apiKey?encrypt(cleanText(req.body.apiKey,1000)):row.encrypted_api_key; if(!label||!baseUrl||!model||!encryptedApiKey) throw problem(400,'Label, base URL, model, and API key are required.'); await pool.query('UPDATE model_nodes SET label=$1,base_url=$2,model_name=$3,encrypted_api_key=$4,enabled=$5,priority=$6,updated_at=now() WHERE id=$7',[label,baseUrl,model,encryptedApiKey,req.body.enabled==null?row.enabled:req.body.enabled===true,boundedInt(req.body.priority,row.priority,0,10000),row.id]); res.json({saved:true}); }));
app.delete('/api/teacher/model-nodes/:id', requireRole('teacher'), asyncRoute(async (req,res)=>{ const result=await pool.query('DELETE FROM model_nodes WHERE id=$1 AND owner_id=$2',[req.params.id,req.auth.sub]); if(!result.rowCount) throw problem(404,'Model node not found.'); res.json({deleted:true}); }));
app.post('/api/teacher/model-nodes/:id/test', requireRole('teacher'), asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM model_nodes WHERE id = $1 AND owner_id = $2', [req.params.id, req.auth.sub]);
  if (!result.rowCount) throw problem(404, 'Model node not found.');
  const node = result.rows[0];
  let response;
  try {
    response = await fetch(`${node.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${decrypt(node.encrypted_api_key)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: node.model_name, temperature: 0, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }] })
    });
  } catch (error) { throw problem(502, `Connection failed: ${error.message}`); }
  if (!response.ok) throw problem(502, `Provider returned HTTP ${response.status}.`);
  res.json({ ok: true, message: `${node.label} is reachable.` });
}));

app.get('/api/teacher/tasks', requireRole('teacher'), asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, count(DISTINCT p.id)::int AS participant_count,
      count(DISTINCT p.id) FILTER (WHERE w.status = 'submitted')::int AS submitted_count
    FROM tasks t LEFT JOIN participants p ON p.task_id = t.id LEFT JOIN workspaces w ON w.participant_id = p.id
    WHERE t.owner_id = $1 GROUP BY t.id ORDER BY t.created_at DESC
  `, [req.auth.sub]);
  res.json({ tasks: result.rows.map(publicTask) });
}));

app.post('/api/teacher/tasks', requireRole('teacher'), upload.single('background'), asyncRoute(async (req, res) => {
  const title = cleanText(req.body.title, 160);
  const prompt = cleanText(req.body.prompt, 2000) || DEFAULT_TASK_PROMPT;
  if (!title || !req.file) throw problem(400, 'Course title and drawing background are required.');
  const timeLimit = Math.max(0, Math.min(7200, Number(req.body.timeLimitMinutes ?? 15) * 60));
  const aiPolicy = ['adaptive', 'persistent', 'off'].includes(req.body.aiPolicy) ? req.body.aiPolicy : 'adaptive';
  let imageDimensions;
  try { imageDimensions = readImageDimensions(req.file.path, req.file.mimetype); }
  catch (error) { removeStoredFile(path.join('backgrounds', req.file.filename)); throw problem(400, error.message); }
  let created;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      created = await pool.query(`
        INSERT INTO tasks (id, owner_id, title, join_code, prompt, instructions, background_path, canvas_width,
          canvas_height, time_limit_seconds, ai_enabled, student_exit_enabled, student_whitelist_enabled,
          voice_enabled, intervention_mode, intervention_interval_seconds, max_interventions,
          snapshot_interval_seconds, ai_appear_seconds, flow_window_seconds, flow_idle_seconds,
          flow_evaluation_interval_seconds, withdrawal_seconds, reopen_cooldown_seconds, minimum_operations,
          ai_policy, ai_lifecycle_enabled, ai_min_visible_seconds, flow_consecutive_passes,
          ai_access_quiet_seconds, withdrawal_candidate_seconds, withdrawal_fade_milliseconds,
          post_withdrawal_observation_seconds, rule_version, artwork_pass_score, new_attempts_allowed,
          background_original_name, background_mime_type)
        VALUES ($1, $2, $3, $4, $5, '', $6, $29, $30, $7, $8, $9, $10, $11, 'timer', 120, 0,
          $12, $13, $14, $15, $16, $17, $18, 0, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $31, $32, $33) RETURNING *
      `, [crypto.randomUUID(), req.auth.sub, title, crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(), prompt,
        path.join('backgrounds', req.file.filename).replace(/\\/g, '/'), timeLimit, aiPolicy !== 'off',
        flag(req.body.studentExitEnabled, true), flag(req.body.studentWhitelistEnabled, false), flag(req.body.voiceEnabled, true),
        boundedInt(req.body.snapshotIntervalSeconds, 30, 0, 300), boundedInt(req.body.aiAppearSeconds, 120, 0, 7200),
        boundedInt(req.body.flowWindowSeconds, 30, 0, 1800), boundedInt(req.body.flowIdleSeconds, 10, 0, 600),
        boundedInt(req.body.flowEvaluationIntervalSeconds, 15, 0, 300), boundedInt(req.body.withdrawalCandidateSeconds, 15, 0, 600),
        boundedInt(req.body.reopenCooldownSeconds, 180, 0, 1800), aiPolicy, flag(req.body.aiLifecycleEnabled, true),
        boundedInt(req.body.aiMinVisibleSeconds, 15, 0, 1800), boundedInt(req.body.flowConsecutivePasses, 3, 1, 10),
        boundedInt(req.body.aiAccessQuietSeconds, 20, 0, 600), boundedInt(req.body.withdrawalCandidateSeconds, 15, 0, 600),
        boundedInt(req.body.withdrawalFadeMilliseconds, 2500, 0, 10000), boundedInt(req.body.postWithdrawalObservationSeconds, 90, 0, 1800),
        withdrawalRuleVersion(req.body.ruleVersion), boundedInt(req.body.artworkPassScore, 55, 0, 100), imageDimensions.width, imageDimensions.height,
        flag(req.body.newAttemptsAllowed, false), req.file.originalname || '', req.file.mimetype || 'image/png']);
      break;
    } catch (error) {
      if (error.code !== '23505') {
        removeStoredFile(path.join('backgrounds', req.file.filename));
        throw error;
      }
    }
  }
  if (!created) {
    removeStoredFile(path.join('backgrounds', req.file.filename));
    throw problem(503, 'Could not allocate a join code. Please try again.');
  }
  res.status(201).json({ task: publicTask(created.rows[0]) });
}));

app.patch('/api/teacher/tasks/:id', requireRole('teacher'), asyncRoute(async (req, res) => {
  const current = await ownedTask(req.params.id, req.auth.sub); const status = req.body.status == null ? current.status : cleanText(req.body.status, 20);
  if (!['draft', 'active', 'closed'].includes(status)) throw problem(400, 'Invalid task status.');
  const title = req.body.title == null ? current.title : cleanText(req.body.title, 160);
  const prompt = req.body.prompt == null ? current.prompt : cleanText(req.body.prompt, 2000);
  if (!title) throw problem(400, 'Course title is required.');
  const aiPolicy = ['adaptive', 'persistent', 'off'].includes(req.body.aiPolicy) ? req.body.aiPolicy : current.ai_policy;
  const result = await pool.query(`UPDATE tasks SET status=$1, student_exit_enabled=$2, student_whitelist_enabled=$3,
    voice_enabled=$4, ai_enabled=$5, intervention_mode='timer', intervention_interval_seconds=120,
    max_interventions=0, snapshot_interval_seconds=$6, ai_appear_seconds=$7, flow_window_seconds=$8,
    flow_idle_seconds=$9, flow_evaluation_interval_seconds=$10, withdrawal_seconds=$11,
    reopen_cooldown_seconds=$12, minimum_operations=0, ai_policy=$13, ai_lifecycle_enabled=$14,
    ai_min_visible_seconds=$15, flow_consecutive_passes=$16, ai_access_quiet_seconds=$17,
    withdrawal_candidate_seconds=$18, withdrawal_fade_milliseconds=$19,
    post_withdrawal_observation_seconds=$20, rule_version=$21, artwork_pass_score=$22,
    time_limit_seconds=$23, title=$24, prompt=$25, instructions='', new_attempts_allowed=$26, updated_at=now()
    WHERE id=$27 RETURNING *`, [status,
    flag(req.body.studentExitEnabled, current.student_exit_enabled), flag(req.body.studentWhitelistEnabled, current.student_whitelist_enabled),
    flag(req.body.voiceEnabled, current.voice_enabled), aiPolicy !== 'off',
    boundedInt(req.body.snapshotIntervalSeconds, current.snapshot_interval_seconds, 0, 300),
    boundedInt(req.body.aiAppearSeconds, current.ai_appear_seconds, 0, 7200), boundedInt(req.body.flowWindowSeconds, current.flow_window_seconds, 0, 1800),
    boundedInt(req.body.flowIdleSeconds, current.flow_idle_seconds, 0, 600), boundedInt(req.body.flowEvaluationIntervalSeconds, current.flow_evaluation_interval_seconds, 0, 300),
    boundedInt(req.body.withdrawalCandidateSeconds, current.withdrawal_candidate_seconds, 0, 600), boundedInt(req.body.reopenCooldownSeconds, current.reopen_cooldown_seconds, 0, 1800),
    aiPolicy, flag(req.body.aiLifecycleEnabled, current.ai_lifecycle_enabled),
    boundedInt(req.body.aiMinVisibleSeconds, current.ai_min_visible_seconds, 0, 1800), boundedInt(req.body.flowConsecutivePasses, current.flow_consecutive_passes, 1, 10),
    boundedInt(req.body.aiAccessQuietSeconds, current.ai_access_quiet_seconds, 0, 600), boundedInt(req.body.withdrawalCandidateSeconds, current.withdrawal_candidate_seconds, 0, 600),
    boundedInt(req.body.withdrawalFadeMilliseconds, current.withdrawal_fade_milliseconds, 0, 10000), boundedInt(req.body.postWithdrawalObservationSeconds, current.post_withdrawal_observation_seconds, 0, 1800),
    withdrawalRuleVersion(req.body.ruleVersion, current.rule_version), boundedInt(req.body.artworkPassScore, current.artwork_pass_score, 0, 100),
    boundedInt(req.body.timeLimitSeconds, current.time_limit_seconds, 0, 7200), title, prompt || DEFAULT_TASK_PROMPT,
    flag(req.body.newAttemptsAllowed, current.new_attempts_allowed), req.params.id]);
  res.json({ task: publicTask(result.rows[0]) });
}));

app.delete('/api/teacher/tasks/:id', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const files = await pool.query(`SELECT draft_image_path AS path FROM workspaces WHERE task_id = $1
    UNION SELECT final_image_path AS path FROM workspaces WHERE task_id = $1
    UNION SELECT s.image_path AS path FROM canvas_snapshots s JOIN workspaces w ON w.id = s.workspace_id WHERE w.task_id = $1`, [task.id]);
  await pool.query('DELETE FROM tasks WHERE id = $1', [task.id]);
  removeStoredFile(task.background_path);
  files.rows.forEach((row) => removeStoredFile(row.path));
  res.json({ deleted: true });
}));

app.get('/api/teacher/tasks/:id/whitelist', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const entries = await pool.query('SELECT id, student_number FROM task_student_whitelist WHERE task_id = $1 ORDER BY student_number_key', [task.id]);
  res.json({ enabled: task.student_whitelist_enabled, entries: entries.rows.map((row) => ({ id: row.id, studentNumber: row.student_number })) });
}));

app.put('/api/teacher/tasks/:id/whitelist', requireRole('teacher'), asyncRoute(async (req, res) => {
  await ownedTask(req.params.id, req.auth.sub);
  const names = [...new Map((Array.isArray(req.body.names) ? req.body.names : []).map(studentName).filter((name) => Array.from(name).length >= 2).map((name) => [studentKey(name), name])).entries()];
  if (names.length > 5000) throw problem(400, 'A task list can contain at most 5,000 names.');
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query('DELETE FROM task_student_whitelist WHERE task_id = $1', [req.params.id]); for (const [key, name] of names) await client.query('INSERT INTO task_student_whitelist (id, task_id, student_number, student_number_key) VALUES ($1, $2, $3, $4)', [crypto.randomUUID(), req.params.id, name, key]); await client.query('UPDATE tasks SET student_whitelist_enabled = $1, updated_at = now() WHERE id = $2', [req.body.enabled === true, req.params.id]); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  res.json({ saved: true, count: names.length, enabled: req.body.enabled === true });
}));

app.get('/api/teacher/tasks/:id', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const participants = await pool.query(`SELECT p.id AS participant_id, w.id AS workspace_id, w.attempt_number,
    p.display_name, p.student_number, p.created_at, w.status, w.active_seconds, w.operation_count,
    w.final_image_path, w.draft_image_path, w.submitted_at, w.updated_at,
    (SELECT count(*) FROM canvas_snapshots s WHERE s.workspace_id = w.id)::int AS snapshot_count
    FROM participants p JOIN workspaces w ON w.participant_id = p.id WHERE p.task_id = $1
    ORDER BY p.created_at, w.attempt_number DESC`, [task.id]);
  const detail = groupTeacherAttempts(participants.rows, (row) => ({
    id: row.workspace_id, workspaceId: row.workspace_id, attemptNumber: row.attempt_number,
    status: row.status, activeSeconds: row.active_seconds, operationCount: row.operation_count,
    snapshotCount: Number(row.snapshot_count), imageUrl: publicPath(row.final_image_path || row.draft_image_path),
    submittedAt: row.submitted_at, updatedAt: row.updated_at
  }));
  res.json({ task: publicTask(task), ...detail });
}));

app.get('/api/teacher/tasks/:id/participants/:participantId/snapshots', requireRole('teacher'), asyncRoute(async (req, res) => {
  await ownedTask(req.params.id, req.auth.sub);
  const result = await pool.query(`SELECT s.id, s.image_path, s.snapshot_kind, s.active_seconds, s.operation_count, s.created_at
    FROM canvas_snapshots s JOIN workspaces w ON w.id = s.workspace_id
    WHERE w.task_id = $1 AND w.participant_id = $2 AND ($3::uuid IS NULL OR w.id = $3)
    ORDER BY s.created_at`, [req.params.id, req.params.participantId, req.query.workspaceId || null]);
  res.json({ snapshots: result.rows.map((row) => ({ id: row.id, imageUrl: publicPath(row.image_path), snapshotKind: row.snapshot_kind, activeSeconds: row.active_seconds, operationCount: row.operation_count, createdAt: row.created_at })) });
}));

app.get('/api/teacher/tasks/:id/ai-decisions', requireRole('teacher'), asyncRoute(async (req, res) => {
  await ownedTask(req.params.id, req.auth.sub);
  res.json(await loadDrawingDecisionLog(pool, req.params.id));
}));

app.get('/api/teacher/tasks/:id/ai-decisions.xlsx', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const log = await loadDrawingDecisionLog(pool, task.id, { limited: false });
  const workbook = await buildDrawingDecisionWorkbook(log);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`drawing-ai-decisions-${task.id}.xlsx`)}`);
  res.setHeader('Content-Length', String(workbook.length));
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.send(workbook);
}));

app.get('/api/teacher/tasks/:id/export.csv', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const result = await pool.query(`SELECT p.display_name, p.created_at, w.attempt_number, w.status, w.active_seconds,
    w.operation_count, w.submitted_at, w.updated_at,
    (SELECT count(*) FROM canvas_snapshots s WHERE s.workspace_id = w.id)::int AS snapshot_count
    FROM participants p JOIN workspaces w ON w.participant_id = p.id
    WHERE p.task_id = $1 ORDER BY p.created_at, w.attempt_number`, [task.id]);
  csvResponse(res, `drawing-task-${task.id}.csv`, [
    ['Task', 'Join code', 'Student', 'Attempt', 'Status', 'Active seconds', 'Operations', 'Snapshot count', 'Joined at', 'Submitted at', 'Updated at'],
    ...result.rows.map((row) => [task.title, task.join_code, row.display_name, row.attempt_number, row.status, row.active_seconds, row.operation_count, row.snapshot_count, row.created_at?.toISOString?.() || row.created_at, row.submitted_at?.toISOString?.() || row.submitted_at, row.updated_at?.toISOString?.() || row.updated_at])
  ]);
}));

app.get('/api/teacher/tasks/:id/export.xlsx', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const workbook = await buildDrawingWorkbook(pool, task);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`drawing-task-${task.id}.xlsx`)}`);
  res.setHeader('Content-Length', String(workbook.length));
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.send(workbook);
}));

app.get('/api/teacher/tasks/:id/images.zip', requireRole('teacher'), asyncRoute(async (req, res) => {
  const task = await ownedTask(req.params.id, req.auth.sub);
  const participants = await pool.query(`SELECT p.id AS participant_id, w.id AS workspace_id, w.attempt_number,
    p.display_name, p.student_number, w.status, w.draft_image_path, w.final_image_path, w.submitted_at
    FROM participants p JOIN workspaces w ON w.participant_id = p.id
    WHERE p.task_id = $1 ORDER BY p.created_at`, [task.id]);
  const snapshots = await pool.query(`SELECT s.id, s.image_path, s.snapshot_kind, s.active_seconds, s.operation_count, s.created_at,
    p.id AS participant_id, w.id AS workspace_id, w.attempt_number, p.student_number,
    row_number() OVER (PARTITION BY w.id ORDER BY s.created_at, s.id)::int AS sequence,
    row_number() OVER (PARTITION BY w.id, s.snapshot_kind ORDER BY s.created_at, s.id)::int AS sample_index
    FROM canvas_snapshots s
    JOIN workspaces w ON w.id = s.workspace_id
    JOIN participants p ON p.id = w.participant_id
    WHERE w.task_id = $1 ORDER BY p.created_at, s.created_at, s.id`, [task.id]);
  const archive = await buildTaskImageArchive({ uploadRoot: config.uploadRoot, task, participants: participants.rows, snapshots: snapshots.rows });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${config.displayName}-${task.id}-canvas-images.zip`)}`);
  res.setHeader('Content-Length', String(archive.length));
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Canvas-Snapshot-Count', String(snapshots.rows.length));
  res.send(archive);
}));

app.get('/api/student/open-tasks', asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, title FROM tasks WHERE status = 'active' ORDER BY created_at DESC");
  res.json({ tasks: result.rows.map((row) => ({ id: row.id, title: row.title })) });
}));

app.post('/api/student/join', asyncRoute(async (req, res) => {
  const taskId = cleanText(req.body.taskId, 50); const joinCode = cleanText(req.body.joinCode, 12).toUpperCase(); const name = studentName(req.body.studentNumber);
  if ((!taskId && !joinCode) || Array.from(name).length < 2) throw problem(400, 'Choose an open task or enter a join code, then enter your name.');
  if (req.body.consentConfirmed !== true) throw problem(400, 'Please confirm that your teacher has explained the activity.');
  const client = await pool.connect(); let participant;
  try {
    await client.query('BEGIN');
    const taskResult = await client.query('SELECT * FROM tasks WHERE (id = $1 OR join_code = $2) FOR SHARE', [taskId || null, joinCode || null]);
    if (!taskResult.rowCount) throw problem(404, 'Task not found.');
    const task = taskResult.rows[0];
    if (task.student_whitelist_enabled) { const allowed = await client.query('SELECT 1 FROM task_student_whitelist WHERE task_id = $1 AND student_number_key = $2', [task.id, studentKey(name)]); if (!allowed.rowCount) throw problem(403, 'Your name is not on this task list. Please ask your teacher to check it.'); }
    const account = await studentAccount(client, name);
    const existing = await participantForStudent(client, task.id, account, name);
    if (existing) { if (task.status === 'draft') throw problem(404, 'This task is not open yet.'); const resumed = await client.query('UPDATE participants SET display_name=$1, session_version=session_version+1, consent_confirmed=true, last_seen_at=now() WHERE id=$2 RETURNING *', [name, existing.id]); participant = resumed.rows[0]; await client.query(`INSERT INTO workspaces (id, participant_id, task_id) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE participant_id = $2)`, [crypto.randomUUID(), participant.id, task.id]); }
    else { if (task.status !== 'active') throw problem(404, 'This task is no longer open.'); const inserted = await client.query('INSERT INTO participants (id, task_id, display_name, student_number, student_account_id, consent_confirmed) VALUES ($1, $2, $3, $3, $4, true) RETURNING *', [crypto.randomUUID(), task.id, name, account.id]); participant = inserted.rows[0]; await client.query('INSERT INTO workspaces (id, participant_id, task_id) VALUES ($1, $2, $3)', [crypto.randomUUID(), participant.id, task.id]); }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  res.json({ token: tokenFor(participant.id, 'student', { taskId: participant.task_id, sessionVersion: participant.session_version }), state: await workspaceState(participant.id) });
}));

app.get('/api/student/me', requireRole('student'), asyncRoute(async (req, res) => res.json({ state: await workspaceState(req.auth.sub) })));

app.post('/api/student/attempts', requireRole('student'), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const participant = await client.query(`SELECT p.task_id, t.status AS task_status, t.new_attempts_allowed
      FROM participants p JOIN tasks t ON t.id = p.task_id WHERE p.id = $1 FOR UPDATE OF p`, [req.auth.sub]);
    if (!participant.rowCount || participant.rows[0].task_status !== 'active') throw problem(403, 'This task is not open.');
    const active = await client.query("SELECT id FROM workspaces WHERE participant_id = $1 AND status = 'draft'", [req.auth.sub]);
    if (active.rowCount) throw problem(409, 'Resume the unfinished attempt before starting another one.');
    const completed = await client.query("SELECT count(*)::int AS count, COALESCE(max(attempt_number), 0)::int AS latest FROM workspaces WHERE participant_id = $1", [req.auth.sub]);
    if (completed.rows[0].count > 0 && participant.rows[0].new_attempts_allowed === false) throw problem(403, 'Your teacher has not opened another attempt.');
    await client.query(`INSERT INTO workspaces (id, participant_id, task_id, attempt_number, timing_started_at)
      VALUES ($1, $2, $3, $4, now())`, [crypto.randomUUID(), req.auth.sub, participant.rows[0].task_id, completed.rows[0].latest + 1]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  res.status(201).json({ state: await workspaceState(req.auth.sub) });
}));

app.put('/api/student/time', requireRole('student'), asyncRoute(async (req, res) => {
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  const result = await pool.query(`UPDATE workspaces SET active_seconds = GREATEST(active_seconds, $1),
    timing_started_at = COALESCE(timing_started_at, now()), updated_at = now()
    WHERE participant_id = $2 AND status = 'draft' RETURNING active_seconds`, [activeSeconds, req.auth.sub]);
  if (!result.rowCount) throw problem(409, 'There is no unfinished attempt.');
  res.json({ activeSeconds: result.rows[0].active_seconds });
}));

app.post('/api/student/operations', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const operations = Array.isArray(req.body.operations) ? req.body.operations.slice(0, 500) : [];
  if (!operations.length) return res.json({ saved: 0 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const operation of operations) {
      const type = ['stroke', 'erase', 'undo', 'redo', 'clear', 'tool_change'].includes(operation.type) ? operation.type : '';
      if (!type || !/^[0-9a-f-]{36}$/i.test(String(operation.id || ''))) continue;
      const result = await client.query(`INSERT INTO canvas_operations
        (id, client_operation_id, workspace_id, seq, operation_type, payload, active_seconds, occurred_at_client)
        VALUES ($1,$1,$2,$3,$4,$5::jsonb,$6,$7)
        ON CONFLICT DO NOTHING`, [operation.id, state.workspace.id,
        boundedInt(operation.seq, 1, 1, 1000000), type,
        JSON.stringify(operation.detail && typeof operation.detail === 'object' ? operation.detail : {}),
        boundedInt(operation.activeSeconds, 0, 0, 14400), operation.occurredAt || null]);
      saved += result.rowCount;
    }
    await client.query('COMMIT');
    res.json({ saved });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

const WITHDRAWAL_REVIEW_LEASE_MILLISECONDS = 45_000;

async function releaseStaleWithdrawalReference(client, workspace, activeSeconds) {
  if (!workspace?.active_withdrawal_id || ['fading', 'withdrawn'].includes(workspace.assistant_state)) return false;
  const withdrawalId = workspace.active_withdrawal_id;
  await client.query(`UPDATE withdrawal_events SET status = 'cancelled', cancelled_active_seconds = $1,
    cancellation_reason = 'stale-visible-withdrawal-reference', cancelled_at = now()
    WHERE id = $2 AND workspace_id = $3 AND status IN ('candidate', 'fading')`,
  [activeSeconds, withdrawalId, workspace.id]);
  await client.query(`UPDATE workspaces SET active_withdrawal_id = NULL,
    withdrawal_candidate_started_active_seconds = NULL WHERE id = $1`, [workspace.id]);
  workspace.active_withdrawal_id = null;
  workspace.withdrawal_candidate_started_active_seconds = null;
  return true;
}

async function reviewUnifiedWithdrawal({ req, res, state, activeSeconds, assistantState, justAppeared }) {
  const defaultReviewSeconds = DECISION_REVIEW_INTERVAL_SECONDS;
  const imageBuffer = req.body.image ? pngDataBuffer(req.body.image) : null;
  let pendingReview = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM workspaces WHERE id = $1 AND status = $2 FOR UPDATE', [state.workspace.id, 'draft']);
    const workspace = locked.rows[0];
    if (!workspace) throw problem(409, 'There is no unfinished attempt.');
    await releaseStaleWithdrawalReference(client, workspace, activeSeconds);
    assistantState = workspace.assistant_state || assistantState;
    if (assistantState === 'fading' || assistantState === 'withdrawn') {
      await client.query('COMMIT');
      return res.json({ assistantState, justAppeared: false, reviewed: false, reviewSuspended: true, nextReviewSeconds: null });
    }
    const visibleSince = Number(justAppeared ? activeSeconds : workspace.assistant_visible_active_seconds);
    const visibleSeconds = Number.isFinite(visibleSince) ? Math.max(0, activeSeconds - visibleSince) : 0;
    const reviewDueAt = Number(justAppeared ? activeSeconds + defaultReviewSeconds : workspace.next_ai_review_active_seconds || 0);
    const reviewDue = activeSeconds >= reviewDueAt;
    const claimStartedAt = workspace.withdrawal_review_claimed_at ? new Date(workspace.withdrawal_review_claimed_at).getTime() : 0;
    const reviewInFlight = Boolean(workspace.withdrawal_review_request_id)
      && Number.isFinite(claimStartedAt)
      && Date.now() - claimStartedAt < WITHDRAWAL_REVIEW_LEASE_MILLISECONDS;
    if (!reviewDue || reviewInFlight) {
      await client.query('COMMIT');
      const nextReviewSeconds = reviewInFlight ? 3 : Math.max(3, reviewDueAt - activeSeconds);
      return res.json({ assistantState, justAppeared, reviewed: false, reviewInFlight, nextReviewSeconds });
    }
    const [operations, interactionCounts] = await Promise.all([
      client.query(`SELECT seq, operation_type, payload, active_seconds FROM canvas_operations
        WHERE workspace_id = $1 AND active_seconds >= $2 AND active_seconds <= $3 ORDER BY seq`,
      [workspace.id, Math.max(0, activeSeconds - state.task.flowWindowSeconds), activeSeconds]),
      client.query(`SELECT count(*) FILTER (WHERE role = 'student')::int AS student_count,
        count(*) FILTER (WHERE role = 'assistant')::int AS assistant_count
        FROM assistant_messages WHERE workspace_id = $1`, [workspace.id])
    ]);
    const measured = evaluateDrawingFlow(operations.rows, { activeSeconds, config: state.task });
    const completedInteractionCount = Math.min(
      Number(interactionCounts.rows[0]?.student_count) || 0,
      Number(interactionCounts.rows[0]?.assistant_count) || 0
    );
    const lastAiAccessActiveSeconds = Number(workspace.last_ai_access_active_seconds) || 0;
    const quietSeconds = workspace.last_ai_access_active_seconds == null
      ? visibleSeconds
      : Math.max(0, activeSeconds - lastAiAccessActiveSeconds);
    const safetyRules = {
      assistantVisible: assistantState === 'visible',
      lifecycleEnabled: state.task.aiLifecycleEnabled !== false,
      adaptivePolicy: state.task.aiPolicy === 'adaptive',
      minimumVisibleTime: canEvaluateAssistantWithdrawal({
        assistantState, visibleSinceActiveSeconds: visibleSince, activeSeconds, config: state.task
      }),
      inputInactive: req.body.inputActive !== true,
      panelInactive: req.body.panelActive !== true,
      noPendingResponse: workspace.assistant_response_pending !== true && req.body.responsePending !== true
    };
    const safetyBlockReasons = Object.entries(safetyRules).filter(([, passed]) => !passed).map(([rule]) => rule);
    const referenceSignals = {
      ...measured.rules,
      assistantVisibleLongEnough: safetyRules.minimumVisibleTime,
      noPendingResponse: safetyRules.noPendingResponse,
      inputInactive: safetyRules.inputInactive,
      panelInactive: safetyRules.panelInactive,
      hasCompletedSupport: completedInteractionCount > 0,
      returnedToCanvas: operations.rowCount > 0,
      quietPeriodReached: quietSeconds >= Number(state.task.aiAccessQuietSeconds || 0)
    };
    const metrics = {
      ...measured.metrics,
      visibleSeconds,
      quietSeconds,
      completedInteractionCount,
      aiPanelActive: req.body.panelActive === true,
      aiInputActive: req.body.inputActive === true,
      responsePending: req.body.responsePending === true
    };
    const evidence = {
      policy: { ruleVersion: WITHDRAWAL_RULE_VERSION, decisionMode: 'model-agency-with-safety-boundaries' },
      task: {
        activeSeconds,
        remainingSeconds: state.task.timeLimitSeconds === 0 ? null : Math.max(0, state.task.timeLimitSeconds - activeSeconds)
      },
      assistant: {
        state: assistantState, visibleSeconds, quietSeconds,
        inputActive: req.body.inputActive === true,
        panelActive: req.body.panelActive === true,
        responsePending: req.body.responsePending === true
      },
      supportCycle: completedInteractionCount > 0
        ? { status: 'used', completedInteractionCount, lastResponseActiveSeconds: Number(workspace.last_assistant_response_active_seconds) || 0 }
        : { status: 'not_used', completedInteractionCount: 0 },
      canvasMetrics: metrics,
      referenceSignals,
      recentConversation: state.messages.slice(-6).map((message) => ({
        role: message.role, content: String(message.content).slice(0, 300)
      })),
      dataQuality: { operationWindowSeconds: measured.windowSeconds, operationCount: operations.rowCount, currentCanvasAvailable: Boolean(imageBuffer) }
    };
    if (safetyBlockReasons.length) {
      await client.query(`INSERT INTO flow_evaluations
        (id, workspace_id, active_seconds, window_seconds, metrics, thresholds, passed, consecutive_passes, decision)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,false,0,'not_eligible')`, [crypto.randomUUID(), workspace.id,
        activeSeconds, measured.windowSeconds,
        jsonForDatabase({ ...metrics, referenceSignals, safetyBlockReasons }), jsonForDatabase(measured.thresholds)]);
      await client.query(`UPDATE workspaces SET next_ai_review_active_seconds = $1,
        flow_consecutive_passes = 0, withdrawal_candidate_started_active_seconds = NULL,
        active_seconds = GREATEST(active_seconds, $2), updated_at = now() WHERE id = $3`,
      [activeSeconds + defaultReviewSeconds, activeSeconds, workspace.id]);
      await client.query('COMMIT');
      return res.json({ assistantState, justAppeared, reviewed: false, safetyBlocked: true,
        reviewBlockReasons: safetyBlockReasons, evaluation: measured, nextReviewSeconds: defaultReviewSeconds });
    }
    const requestId = crypto.randomUUID();
    await client.query(`UPDATE workspaces SET withdrawal_review_request_id = $1,
      withdrawal_review_claimed_at = now(), withdrawal_review_active_seconds = $2,
      next_ai_review_active_seconds = $3, active_seconds = GREATEST(active_seconds, $2), updated_at = now()
      WHERE id = $4`, [requestId, activeSeconds, activeSeconds + defaultReviewSeconds, workspace.id]);
    await client.query('COMMIT');
    pendingReview = {
      requestId, workspaceId: workspace.id, activeSeconds, assistantState, visibleSince,
      lastAiAccessActiveSeconds, lastAssistantResponseActiveSeconds: Number(workspace.last_assistant_response_active_seconds) || 0,
      completedInteractionCount, measured, metrics, referenceSignals, evidence, imageBuffer
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const agency = await judgeAssistantState(state.task.ownerId, pendingReview.evidence, pendingReview.imageBuffer);
  const returnedDecision = {
    ...agency.decision,
    ruleVersion: WITHDRAWAL_RULE_VERSION,
    promptVersion: agency.promptVersion,
    modelRoute: agency.modelRoute,
    modelInvoked: agency.modelInvoked === true,
    auditStage: 'model-review',
    executionStatus: 'decision-returned',
    executionReason: 'The model result was recorded before transaction-time safety validation.'
  };
  const decisionRecordId = await recordAiDecision(pool, {
    workspaceId: pendingReview.workspaceId,
    activeSeconds,
    evidence: pendingReview.evidence,
    normalizedDecision: returnedDecision,
    agency
  });
  const executionClient = await pool.connect();
  try {
    await executionClient.query('BEGIN');
    const locked = await executionClient.query('SELECT * FROM workspaces WHERE id = $1 AND status = $2 FOR UPDATE', [pendingReview.workspaceId, 'draft']);
    const workspace = locked.rows[0] || {};
    await releaseStaleWithdrawalReference(executionClient, workspace, activeSeconds);
    const ownsClaim = String(workspace.withdrawal_review_request_id || '') === pendingReview.requestId;
    const currentInteractions = await executionClient.query(`SELECT count(*) FILTER (WHERE role = 'student')::int AS student_count,
      count(*) FILTER (WHERE role = 'assistant')::int AS assistant_count FROM assistant_messages WHERE workspace_id = $1`,
    [pendingReview.workspaceId]);
    const currentCompletedInteractionCount = Math.min(
      Number(currentInteractions.rows[0]?.student_count) || 0,
      Number(currentInteractions.rows[0]?.assistant_count) || 0
    );
    const executionBlockReasons = [
      ...(!ownsClaim ? ['review-lease-superseded'] : []),
      ...(workspace.assistant_state !== 'visible' ? ['assistant-state-changed'] : []),
      ...(workspace.active_withdrawal_id ? ['active-withdrawal-already-present'] : []),
      ...(workspace.assistant_response_pending === true ? ['assistant-response-pending'] : []),
      ...((Number(workspace.last_ai_access_active_seconds) || 0) > pendingReview.lastAiAccessActiveSeconds ? ['assistant-accessed-during-model-call'] : []),
      ...((Number(workspace.last_assistant_response_active_seconds) || 0) !== pendingReview.lastAssistantResponseActiveSeconds ? ['assistant-response-changed'] : []),
      ...(currentCompletedInteractionCount !== pendingReview.completedInteractionCount ? ['conversation-changed'] : [])
    ];
    const evidenceStillCurrent = executionBlockReasons.length === 0;
    const shouldWithdraw = evidenceStillCurrent
      && agency.decision.valid === true
      && agency.decision.action === 'WITHDRAW';
    let nextAssistantState = workspace.assistant_state || assistantState;
    let withdrawalId = workspace.active_withdrawal_id || null;
    if (shouldWithdraw) {
      const withdrawalNumber = await executionClient.query('SELECT COALESCE(max(withdrawal_number), 0)::int + 1 AS value FROM withdrawal_events WHERE workspace_id = $1', [pendingReview.workspaceId]);
      withdrawalId = crypto.randomUUID();
      nextAssistantState = 'fading';
      await executionClient.query(`INSERT INTO withdrawal_events (id, workspace_id, conversation_id, withdrawal_number, status,
        candidate_started_active_seconds, candidate_updated_active_seconds, fade_started_active_seconds,
        trigger_metrics, trigger_rules) VALUES ($1,$2,$3::uuid,$4,'fading',$5,$5,$5,$6::jsonb,$7::jsonb)`,
      [withdrawalId, pendingReview.workspaceId, state.workspace.activeConversationId,
        withdrawalNumber.rows[0].value, activeSeconds,
        jsonForDatabase(pendingReview.metrics), jsonForDatabase(pendingReview.referenceSignals)]);
    }
    const executionReason = shouldWithdraw
      ? 'A valid explicit WITHDRAW decision passed transaction-time safety validation.'
      : !ownsClaim
        ? 'The review lease was superseded before this model result returned.'
        : !evidenceStillCurrent
          ? 'AI interaction or support state changed while the model was running.'
          : agency.fallback
            ? 'The model was unavailable; the safe OBSERVE fallback kept the assistant visible.'
            : agency.decision.valid !== true
              ? 'The model response did not satisfy the withdrawal decision contract.'
              : `The model chose ${agency.decision.action}; the assistant remains visible.`;
    const recordedDecision = {
      ...returnedDecision,
      executionStatus: shouldWithdraw ? 'executed' : !ownsClaim ? 'discarded-superseded-review' : !evidenceStillCurrent ? 'discarded-stale-evidence' : 'kept-visible',
      executionReason,
      executionBlockReasons
    };
    await updateAiDecision(executionClient, decisionRecordId, recordedDecision);
    await executionClient.query(`INSERT INTO flow_evaluations
      (id, workspace_id, active_seconds, window_seconds, metrics, thresholds, passed, consecutive_passes, decision)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [crypto.randomUUID(), pendingReview.workspaceId,
      activeSeconds, pendingReview.measured.windowSeconds,
      jsonForDatabase({ ...pendingReview.metrics, referenceSignals: pendingReview.referenceSignals, decisionId: decisionRecordId }),
      jsonForDatabase(pendingReview.measured.thresholds), shouldWithdraw, shouldWithdraw ? 'withdraw' : 'keep_visible']);
    const nextReviewSeconds = Math.max(3, Number(agency.decision.nextReviewSeconds) || defaultReviewSeconds);
    await executionClient.query(`UPDATE workspaces SET assistant_state = $1::varchar,
      latest_withdrawal_active_seconds = CASE WHEN $1::varchar = 'fading' THEN $2 ELSE latest_withdrawal_active_seconds END,
      active_withdrawal_id = $3, flow_consecutive_passes = 0,
      withdrawal_candidate_started_active_seconds = NULL,
      withdrawal_review_request_id = CASE WHEN withdrawal_review_request_id = $4::uuid THEN NULL ELSE withdrawal_review_request_id END,
      withdrawal_review_claimed_at = CASE WHEN withdrawal_review_request_id = $4::uuid THEN NULL ELSE withdrawal_review_claimed_at END,
      withdrawal_review_active_seconds = CASE WHEN withdrawal_review_request_id = $4::uuid THEN NULL ELSE withdrawal_review_active_seconds END,
      next_ai_review_active_seconds = CASE WHEN withdrawal_review_request_id = $4::uuid THEN $5 ELSE next_ai_review_active_seconds END,
      active_seconds = GREATEST(active_seconds, $2), updated_at = now() WHERE id = $6`,
    [nextAssistantState, activeSeconds, withdrawalId, pendingReview.requestId,
      activeSeconds + nextReviewSeconds, pendingReview.workspaceId]);
    await executionClient.query('COMMIT');
    return res.json({ assistantState: nextAssistantState, justAppeared, reviewed: true,
      decision: recordedDecision, withdrawalId, nextReviewSeconds });
  } catch (error) {
    await executionClient.query('ROLLBACK');
    await updateAiDecision(pool, decisionRecordId, {
      ...returnedDecision,
      executionStatus: 'execution-transaction-failed',
      executionReason: `The model result was recorded, but execution failed: ${String(error.message || error).slice(0, 500)}`
    }).catch((auditError) => console.error('[drawing-agency] decision failure audit update failed:', auditError.message));
    await pool.query(`UPDATE workspaces SET withdrawal_review_request_id = NULL,
      withdrawal_review_claimed_at = NULL, withdrawal_review_active_seconds = NULL
      WHERE id = $1 AND withdrawal_review_request_id = $2::uuid`, [pendingReview.workspaceId, pendingReview.requestId]).catch(() => {});
    throw error;
  } finally {
    executionClient.release();
  }
}

app.post('/api/student/assistant/review', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  let assistantState = state.workspace.assistantState;
  if (state.task.aiPolicy === 'off') assistantState = 'hidden';
  else if (assistantState === 'hidden' && activeSeconds >= state.task.aiAppearSeconds) assistantState = 'visible';
  if (assistantState === 'fading' || assistantState === 'withdrawn') {
    return res.json({ assistantState, justAppeared: false, reviewed: false, reviewSuspended: true, nextReviewSeconds: null });
  }
  const justAppeared = assistantState === 'visible' && state.workspace.assistantState === 'hidden';
  if (justAppeared) await pool.query(`UPDATE workspaces SET assistant_state = 'visible', assistant_visible_active_seconds = $1,
    next_ai_review_active_seconds = $2, updated_at = now() WHERE id = $3`, [activeSeconds, activeSeconds + Math.max(3, state.task.flowEvaluationIntervalSeconds), state.workspace.id]);
  return reviewUnifiedWithdrawal({ req, res, state, activeSeconds, assistantState, justAppeared });
}));

app.post('/api/student/assistant/withdrawal-complete', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT assistant_state, active_withdrawal_id FROM workspaces WHERE id = $1 FOR UPDATE', [state.workspace.id]);
    const workspace = locked.rows[0];
    if (!workspace || workspace.assistant_state !== 'fading' || !workspace.active_withdrawal_id) {
      await client.query('COMMIT');
      return res.json({ assistantState: workspace?.assistant_state || state.workspace.assistantState, completed: false });
    }
    const completed = await client.query(`UPDATE withdrawal_events SET status = 'withdrawn', completed_active_seconds = $1,
      completed_at = now() WHERE id = $2 AND workspace_id = $3 AND status = 'fading' RETURNING id`,
    [activeSeconds, workspace.active_withdrawal_id, state.workspace.id]);
    if (completed.rowCount) await client.query(`UPDATE workspaces SET assistant_state = 'withdrawn',
      flow_consecutive_passes = 0, withdrawal_candidate_started_active_seconds = NULL,
      active_seconds = GREATEST(active_seconds, $1), updated_at = now() WHERE id = $2`,
    [activeSeconds, state.workspace.id]);
    await client.query('COMMIT');
    return res.json({ assistantState: completed.rowCount ? 'withdrawn' : workspace.assistant_state, completed: completed.rowCount === 1 });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/student/assistant/withdrawal-cancel', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  if (state.workspace.assistantState !== 'fading' || !state.workspace.activeWithdrawalId) {
    return res.json({ assistantState: state.workspace.assistantState, cancelled: false });
  }
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT assistant_state, active_withdrawal_id FROM workspaces WHERE id = $1 FOR UPDATE', [state.workspace.id]);
    const workspace = locked.rows[0];
    if (!workspace || workspace.assistant_state !== 'fading' || !workspace.active_withdrawal_id) {
      await client.query('COMMIT');
      return res.json({ assistantState: workspace?.assistant_state || state.workspace.assistantState, cancelled: false });
    }
    const cancelled = await client.query(`UPDATE withdrawal_events SET status = 'cancelled',
      cancelled_active_seconds = $1, cancellation_reason = 'child-reengaged-during-fade', cancelled_at = now()
      WHERE id = $2 AND workspace_id = $3 AND status = 'fading' RETURNING id`,
    [activeSeconds, workspace.active_withdrawal_id, state.workspace.id]);
    if (cancelled.rowCount) await client.query(`UPDATE workspaces SET assistant_state = 'visible',
      assistant_visible_active_seconds = $1, last_ai_access_active_seconds = $1,
      active_withdrawal_id = NULL, next_ai_review_active_seconds = $2,
      active_seconds = GREATEST(active_seconds, $1), updated_at = now() WHERE id = $3`,
    [activeSeconds, activeSeconds + DECISION_REVIEW_INTERVAL_SECONDS, state.workspace.id]);
    await client.query('COMMIT');
    res.json({ assistantState: cancelled.rowCount ? 'visible' : state.workspace.assistantState, cancelled: cancelled.rowCount === 1 });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/student/assistant/access', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  if (state.workspace.assistantState === 'fading' || state.workspace.assistantState === 'withdrawn') {
    return res.json({ assistantState: state.workspace.assistantState });
  }
  await pool.query(`UPDATE workspaces SET last_ai_access_active_seconds = GREATEST(COALESCE(last_ai_access_active_seconds, 0), $1),
    next_ai_review_active_seconds = GREATEST(next_ai_review_active_seconds, $2),
    active_seconds = GREATEST(active_seconds, $1), updated_at = now() WHERE id = $3`,
  [activeSeconds, activeSeconds + Math.max(3, state.task.flowEvaluationIntervalSeconds), state.workspace.id]);
  res.json({ assistantState: state.workspace.assistantState });
}));

app.post('/api/student/assistant/reopen', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  if (state.workspace.assistantState !== 'withdrawn') throw problem(409, 'The assistant has not finished stepping back yet.');
  const kind = req.body.kind === 'history' ? 'history' : 'new_question';
  const conversationId = kind === 'history'
    ? state.workspace.activeConversationId || crypto.randomUUID()
    : crypto.randomUUID();
  await pool.query(`UPDATE workspaces SET assistant_state = 'visible', assistant_visible_active_seconds = $1,
    last_ai_access_active_seconds = $1, next_ai_review_active_seconds = $2,
    flow_consecutive_passes = 0, withdrawal_candidate_started_active_seconds = NULL,
    active_withdrawal_id = NULL, active_conversation_id = $3, updated_at = now() WHERE id = $4`,
  [activeSeconds, activeSeconds + Math.max(3, state.task.flowEvaluationIntervalSeconds), conversationId, state.workspace.id]);
  const messages = kind === 'history' ? state.messages : [];
  res.json({ assistantState: 'visible', conversationId, messages });
}));

app.put('/api/student/work', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub); if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const relative = savePngDataUrl(req.body.image, `${state.workspace.id}-draft.png`);
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  const operationCount = Math.max(0, Math.min(1000000, Number(req.body.operationCount) || 0));
  await pool.query('UPDATE workspaces SET draft_image_path = $1, active_seconds = GREATEST(active_seconds, $2), operation_count = GREATEST(operation_count, $3), updated_at = now() WHERE id = $4', [relative, activeSeconds, operationCount, state.workspace.id]);
  const captureSnapshot = req.body.captureSnapshot === true;
  const snapshotKind = ['baseline', 'interval'].includes(req.body.snapshotKind) ? req.body.snapshotKind : 'interval';
  let snapshotSaved = false;
  let snapshotRelative = '';
  try {
    if (!captureSnapshot) return res.json({ saved: true, snapshotSaved, imageUrl: publicPath(relative), updatedAt: new Date().toISOString() });
    snapshotRelative = saveSnapshotDataUrl(req.body.snapshotImage || req.body.image, `${state.workspace.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    await pool.query('INSERT INTO canvas_snapshots (workspace_id, image_path, active_seconds, operation_count, snapshot_kind) VALUES ($1, $2, $3, $4, $5)', [state.workspace.id, snapshotRelative, activeSeconds, operationCount, snapshotKind]);
  } catch (error) {
    snapshotSaved = false;
    if (snapshotRelative) {
      try { removeStoredFile(snapshotRelative); }
      catch (cleanupError) { console.warn('[drawing-save] failed snapshot could not be removed:', cleanupError.message); }
    }
    console.warn('[drawing-save] draft saved but process snapshot failed:', error.message);
  }
  res.json({ saved: true, snapshotSaved, imageUrl: publicPath(relative), updatedAt: new Date().toISOString() });
}));

app.post('/api/student/assistant', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub); if (!state.task.aiEnabled) throw problem(403, 'AI support is not enabled for this task.'); if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const quickPromptKey = ['observe', 'suggest', 'next_step'].includes(req.body.quickPromptKey) ? req.body.quickPromptKey : '';
  const question = cleanText(req.body.question, 1000) || 'Help me think about my drawing.';
  const imageBuffer = req.body.image ? pngDataBuffer(req.body.image) : state.workspace.draftImageUrl ? (() => { try { return readStoredFile(state.workspace.draftImageUrl.split('/uploads/').pop()); } catch { return null; } })() : null;
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || state.workspace.activeSeconds || 0));
  const requestId = crypto.randomUUID();
  let conversationId = state.workspace.activeConversationId || crypto.randomUUID();
  const claimClient = await pool.connect();
  try {
    await claimClient.query('BEGIN');
    const locked = await claimClient.query('SELECT * FROM workspaces WHERE id = $1 AND status = $2 FOR UPDATE', [state.workspace.id, 'draft']);
    const workspace = locked.rows[0];
    if (!workspace) throw problem(409, 'There is no unfinished attempt.');
    if (workspace.assistant_state === 'fading' || workspace.assistant_state === 'withdrawn') throw problem(409, 'Choose a conversation option before asking the assistant again.');
    if (workspace.assistant_response_pending) throw problem(409, 'The assistant is already preparing a response.');
    conversationId = workspace.active_conversation_id || conversationId;
    await claimClient.query(`UPDATE workspaces SET assistant_response_pending = true,
      assistant_response_request_id = $1, last_ai_access_active_seconds = $2,
      next_ai_review_active_seconds = GREATEST(next_ai_review_active_seconds, $3),
      active_seconds = GREATEST(active_seconds, $2), updated_at = now() WHERE id = $4`,
    [requestId, activeSeconds, activeSeconds + Math.max(3, state.task.flowEvaluationIntervalSeconds), workspace.id]);
    await claimClient.query('COMMIT');
  } catch (error) {
    await claimClient.query('ROLLBACK');
    throw error;
  } finally {
    claimClient.release();
  }
  try {
    const reply = await assistantReply({ ownerId: state.task.ownerId, prompt: state.task.prompt, question, history: state.messages, imageBuffer });
    const responseClient = await pool.connect();
    try {
      await responseClient.query('BEGIN');
      const locked = await responseClient.query('SELECT assistant_response_request_id FROM workspaces WHERE id = $1 FOR UPDATE', [state.workspace.id]);
      if (String(locked.rows[0]?.assistant_response_request_id || '') !== requestId) throw problem(409, 'The assistant response request was superseded.');
      await responseClient.query(`INSERT INTO assistant_messages (workspace_id, role, content, quick_prompt_key, conversation_id)
        VALUES ($1, 'student', $2, $4, $5), ($1, 'assistant', $3, '', $5)`,
      [state.workspace.id, question, reply, quickPromptKey, conversationId]);
      await responseClient.query(`UPDATE workspaces SET active_conversation_id = COALESCE(active_conversation_id, $1),
        assistant_response_pending = false, assistant_response_request_id = NULL,
        last_ai_access_active_seconds = $2, updated_at = now() WHERE id = $3`,
      [conversationId, activeSeconds, state.workspace.id]);
      await responseClient.query('COMMIT');
    } catch (error) {
      await responseClient.query('ROLLBACK');
      throw error;
    } finally {
      responseClient.release();
    }
    res.json({ reply });
  } catch (error) {
    await pool.query(`UPDATE workspaces SET assistant_response_pending = false, assistant_response_request_id = NULL
      WHERE id = $1 AND assistant_response_request_id = $2::uuid`, [state.workspace.id, requestId]).catch(() => {});
    throw error;
  }
}));

app.post('/api/student/assistant/response-complete', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub);
  if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0));
  const operationSeq = Math.max(0, Math.min(1000000, Number(req.body.operationSeq) || 0));
  const completed = await pool.query(`SELECT count(*) FILTER (WHERE role = 'student')::int AS student_count,
    count(*) FILTER (WHERE role = 'assistant')::int AS assistant_count
    FROM assistant_messages WHERE workspace_id = $1`, [state.workspace.id]);
  const completedCount = Math.min(
    Number(completed.rows[0]?.student_count) || 0,
    Number(completed.rows[0]?.assistant_count) || 0
  );
  if (completedCount < 1) throw problem(409, 'There is no completed assistant response to acknowledge.');
  await pool.query(`UPDATE workspaces SET last_assistant_response_active_seconds = $1,
    last_assistant_response_operation_seq = $2,
    last_ai_access_active_seconds = GREATEST(COALESCE(last_ai_access_active_seconds, 0), $1),
    next_ai_review_active_seconds = $3, flow_consecutive_passes = 0,
    withdrawal_candidate_started_active_seconds = NULL,
    active_seconds = GREATEST(active_seconds, $1), updated_at = now() WHERE id = $4`,
  [activeSeconds, operationSeq, activeSeconds + Math.max(3, state.task.flowEvaluationIntervalSeconds), state.workspace.id]);
  res.json({ acknowledged: true, activeSeconds, operationSeq });
}));

app.post('/api/student/submit', requireRole('student'), asyncRoute(async (req, res) => {
  const state = await workspaceState(req.auth.sub); if (!state.workspace || state.workspace.status !== 'draft') throw problem(409, 'There is no unfinished attempt.');
  let relative = '';
  let snapshotRelative = '';
  try {
    relative = savePngDataUrl(req.body.image, `${state.workspace.id}-final.png`);
    snapshotRelative = savePngDataUrl(req.body.image, `${state.workspace.id}-${Date.now()}-final-${crypto.randomBytes(3).toString('hex')}.png`);
  } catch (error) {
    removeStoredFile(relative);
    removeStoredFile(snapshotRelative);
    throw error;
  }
  const activeSeconds = Math.max(0, Math.min(14400, Number(req.body.activeSeconds) || 0)); const operationCount = Math.max(0, Math.min(1000000, Number(req.body.operationCount) || 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const submitted = await client.query("UPDATE workspaces SET final_image_path = $1, active_seconds = GREATEST(active_seconds, $2), operation_count = GREATEST(operation_count, $3), status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $4 AND status = 'draft' RETURNING id", [relative, activeSeconds, operationCount, state.workspace.id]);
    if (!submitted.rowCount) throw problem(409, 'This drawing is already final.');
    await client.query("INSERT INTO canvas_snapshots (workspace_id, image_path, active_seconds, operation_count, snapshot_kind) VALUES ($1, $2, $3, $4, 'final')", [state.workspace.id, snapshotRelative, activeSeconds, operationCount]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    removeStoredFile(relative);
    removeStoredFile(snapshotRelative);
    throw error;
  } finally { client.release(); }
  res.json({ state: await workspaceState(req.auth.sub) });
}));

const dist = path.join(__dirname, '..', '..', 'dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html')));
app.use((error, _req, res, _next) => { console.error(error); res.status(error.status || (error instanceof multer.MulterError ? 400 : 500)).json({ error: error.status ? error.message : error instanceof multer.MulterError ? 'The uploaded image is too large.' : 'The server could not complete this request.' }); });
module.exports = app;
