import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Archive, ArrowLeft, ArrowRight, BookOpen, Brush, Check, Clock, Download, Eraser, GraduationCap, History, Image, LoaderCircle, LogOut, MessageCircle, Mic, Palette, Plus, RefreshCw, RotateCcw, RotateCw, Send, Settings, Sparkles, Trash2, Users, X } from 'lucide-react';
import { api, download, downloadZip, patch, post, put } from './api';
import { BrandProvider, useBrand } from './BrandContext';
import ModelSettings from './ModelSettings';

const TEACHER_TOKEN = 'task_platform_drawing_teacher_token';
const STUDENT_TOKEN = 'task_platform_drawing_student_token';
const WITHDRAWAL_RULE = 'withdrawal_rules_v1';
const isStudentStudioState = (state) => Boolean(state?.task && state?.workspace
  && Number.isFinite(Number(state.workspace.activeSeconds))
  && Array.isArray(state.history) && Array.isArray(state.messages));
const DEFAULT_DRAWING_SETTINGS = Object.freeze({
  timeLimitMinutes: 15, snapshotIntervalSeconds: 30, aiAppearSeconds: 120, aiMinVisibleSeconds: 15,
  flowWindowSeconds: 30, flowEvaluationIntervalSeconds: 15, flowIdleSeconds: 10,
  reopenCooldownSeconds: 180, flowConsecutivePasses: 3, aiAccessQuietSeconds: 20,
  withdrawalCandidateSeconds: 15, withdrawalFadeMilliseconds: 2500,
  postWithdrawalObservationSeconds: 90, ruleVersion: WITHDRAWAL_RULE, artworkPassScore: 55,
  aiLifecycleEnabled: true, aiPolicy: 'adaptive'
});
const DRAWING_DRAFT_SAVE_DELAY_MS = 800;
const CANVAS_BOARD_SIZE = 1200;
const DEFAULT_TASK_PROMPT = 'Create an original drawing by incorporating, extending, or reinterpreting the provided shape.';

function lockedBackgroundGeometry(image, width, height) {
  const frameSide = Math.round(Math.min(width, height) * 0.68);
  const frameX = Math.round((width - frameSide) / 2);
  const frameY = Math.round((height - frameSide) / 2);
  const padding = Math.max(16, Math.round(frameSide * 0.035));
  const usableSide = frameSide - padding * 2;
  const naturalWidth = Math.max(1, Number(image?.naturalWidth) || 1);
  const naturalHeight = Math.max(1, Number(image?.naturalHeight) || 1);
  const scale = Math.min(usableSide / naturalWidth, usableSide / naturalHeight);
  const imageWidth = Math.max(1, Math.round(naturalWidth * scale));
  const imageHeight = Math.max(1, Math.round(naturalHeight * scale));
  return {
    frameSide,
    frameX,
    frameY,
    imageWidth,
    imageHeight,
    imageX: Math.round(frameX + (frameSide - imageWidth) / 2),
    imageY: Math.round(frameY + (frameSide - imageHeight) / 2)
  };
}

function drawLockedBackground(context, image, width, height) {
  const geometry = lockedBackgroundGeometry(image, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.save();
  context.fillStyle = '#f7f7f5';
  context.fillRect(geometry.frameX, geometry.frameY, geometry.frameSide, geometry.frameSide);
  if (image) context.drawImage(image, geometry.imageX, geometry.imageY, geometry.imageWidth, geometry.imageHeight);
  context.lineWidth = Math.max(4, Math.round(geometry.frameSide * 0.006));
  context.strokeStyle = '#111111';
  context.strokeRect(geometry.frameX, geometry.frameY, geometry.frameSide, geometry.frameSide);
  context.restore();
  return geometry;
}
function createClientOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
async function copyText(value) { if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value); const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select(); const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error('Copy failed.'); }
function dictate(onResult, onError) { const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!Recognition) return onError('Speech input is not supported by this browser.'); const recognition = new Recognition(); recognition.lang = 'en-US'; recognition.interimResults = false; recognition.onresult = (event) => onResult(event.results?.[0]?.[0]?.transcript || ''); recognition.onerror = () => onError('Speech input could not be completed.'); recognition.start(); }
function Button({ icon: Icon, children, kind = 'primary', ...props }) { return <button className={`button ${kind}`} {...props}>{Icon && <Icon size={18} />}{children}</button>; }
function Modal({ title, children, onClose, wide = false }) { return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button type="button" className="modal-close" title="Close" onClick={onClose}><X size={22} /></button></header>{children}</section></div>; }
const prettyJson = (value) => JSON.stringify(value ?? {}, null, 2);
const decisionSourceLabel = (item) => item.fallback ? 'Fallback' : item.modelName || 'Model';
const decisionExecution = (item) => {
  const status = item.normalizedDecision?.executionStatus || 'recorded';
  if (status === 'executed') return { label: 'Executed', tone: 'executed' };
  if (status === 'execution-transaction-failed') return { label: 'Execution failed', tone: 'failed' };
  if (status === 'decision-returned') return { label: 'Execution pending', tone: 'pending' };
  if (status === 'kept-visible' && item.normalizedDecision?.action !== 'WITHDRAW') return { label: 'Kept visible', tone: 'visible' };
  if (status.startsWith('discarded-') || item.normalizedDecision?.action === 'WITHDRAW') return { label: 'Not executed', tone: 'failed' };
  return { label: 'Recorded', tone: 'visible' };
};
const modelAuditPlaceholder = (item) => item.fallback && item.normalizedDecision?.modelInvoked === false
  ? '(provider not invoked; fallback decision recorded)'
  : '(empty)';

function DrawingSettingsFields({ form, setForm, creation = false }) {
  const minutes = creation ? form.timeLimitMinutes : Math.round(form.timeLimitSeconds / 60);
  const setMinutes = (value) => setForm({ ...form, ...(creation ? { timeLimitMinutes: value } : { timeLimitSeconds: value * 60 }) });
  return <>
    <fieldset><legend>Canvas recording</legend><div className="form-row three">
      <label>Canvas time limit (minutes)<input type="number" min="0" max="120" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /><small>0 means unlimited.</small></label>
      <label>Snapshot interval (seconds)<input type="number" min="0" max="300" value={form.snapshotIntervalSeconds} onChange={(e) => setForm({ ...form, snapshotIntervalSeconds: Number(e.target.value) })} /><small>0 disables periodic snapshots.</small></label>
    </div></fieldset>
    <fieldset className={creation ? '' : 'settings-ai-lifecycle'}><legend>AI lifecycle</legend>
      <label className="toggle-row"><input type="checkbox" checked={form.aiLifecycleEnabled !== false} onChange={(e) => setForm({ ...form, aiLifecycleEnabled: e.target.checked })} /><span><strong>AI timed appearance and adaptive withdrawal</strong><small>When off, AI still appears at the configured time and then remains available.</small></span></label>
      <div className="form-row three">
        <label>AI policy<select value={form.aiPolicy} onChange={(e) => setForm({ ...form, aiPolicy: e.target.value })}><option value="adaptive">Adaptive withdrawal</option><option value="persistent">Persistent after appearance</option><option value="off">Off</option></select></label>
        <label>First appearance (seconds)<input type="number" min="0" max="7200" value={form.aiAppearSeconds} onChange={(e) => setForm({ ...form, aiAppearSeconds: Number(e.target.value) })} /></label>
        <label>Minimum visible time (seconds)<input type="number" min="0" max="1800" value={form.aiMinVisibleSeconds} onChange={(e) => setForm({ ...form, aiMinVisibleSeconds: Number(e.target.value) })} /></label>
        <label>Flow observation window (seconds)<input type="number" min="0" max="1800" value={form.flowWindowSeconds} onChange={(e) => setForm({ ...form, flowWindowSeconds: Number(e.target.value) })} /></label>
        <label>Flow evaluation interval (seconds)<input type="number" min="0" max="300" value={form.flowEvaluationIntervalSeconds} onChange={(e) => setForm({ ...form, flowEvaluationIntervalSeconds: Number(e.target.value) })} /></label>
        <label>Maximum drawing idle time (seconds)<input type="number" min="0" max="600" value={form.flowIdleSeconds} onChange={(e) => setForm({ ...form, flowIdleSeconds: Number(e.target.value) })} /><small>Used as evidence for the model, not as a hard withdrawal gate.</small></label>
        <label>AI access quiet reference (seconds)<input type="number" min="0" max="600" value={form.aiAccessQuietSeconds} onChange={(e) => setForm({ ...form, aiAccessQuietSeconds: Number(e.target.value) })} /><small>Used as model evidence; reaching it does not automatically withdraw the assistant.</small></label>
        <label>Withdrawal fade duration (milliseconds)<input type="number" min="0" max="10000" value={form.withdrawalFadeMilliseconds} onChange={(e) => setForm({ ...form, withdrawalFadeMilliseconds: Number(e.target.value) })} /></label>
        <label>Post-withdrawal observation (seconds)<input type="number" min="0" max="1800" value={form.postWithdrawalObservationSeconds} onChange={(e) => setForm({ ...form, postWithdrawalObservationSeconds: Number(e.target.value) })} /></label>
      </div>
    </fieldset>
  </>;
}

function Home({ onRole }) {
  const { displayName } = useBrand();
  return <main className="home-page"><header className="home-header"><div className="wordmark"><Brush size={27} /><strong>{displayName}</strong></div></header>
    <section className="home-content"><span className="eyebrow">DRAWING WITH {displayName}</span><h1>{displayName}</h1><p>Give the drawing time to breathe. Choose how you want to begin.</p><div className="role-grid">
      <button className="role-card student" onClick={() => onRole('student')}><GraduationCap size={35} /><span><strong>{displayName} for Students</strong><small>Join a task and start drawing</small></span><ArrowRight /></button>
      <button className="role-card teacher" onClick={() => onRole('teacher')}><BookOpen size={35} /><span><strong>{displayName} Teacher Console</strong><small>Create tasks and review artwork</small></span><ArrowRight /></button>
    </div></section></main>;
}

function TeacherLogin({ onSuccess, onBack }) {
  const { displayName } = useBrand();
  const [form, setForm] = useState({ username: 'teacher', password: '' }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await post('/teacher/login', form); localStorage.setItem(TEACHER_TOKEN, result.token); onSuccess(result.token); } catch (caught) { setError(caught.message); } finally { setBusy(false); } };
  return <main className="center-page"><Button kind="ghost back" icon={ArrowLeft} onClick={onBack}>Back</Button><form className="panel login-panel" onSubmit={submit}><BookOpen className="panel-icon" size={31} /><h1>{displayName} Teacher Sign In</h1><p className="muted">Manage drawing tasks and submitted artwork.</p>{error && <div className="error">{error}</div>}<label>Username<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label><label>Password<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label><Button icon={busy ? LoaderCircle : ArrowRight} disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</Button></form></main>;
}

function CreateTask({ token, onCreated, onCancel }) {
  const [form, setForm] = useState({ title: '', prompt: DEFAULT_TASK_PROMPT, background: null, voiceEnabled: true, studentExitEnabled: true, newAttemptsAllowed: false, studentWhitelistEnabled: false, ...DEFAULT_DRAWING_SETTINGS }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(''); const body = new FormData(); Object.entries(form).forEach(([key, value]) => body.append(key, value)); try { const result = await api('/teacher/tasks', { method: 'POST', body }, token); onCreated(result.task); } catch (caught) { setError(caught.message); } finally { setBusy(false); } };
  return <form className="panel task-form" onSubmit={submit}><div className="panel-heading"><div><span className="eyebrow">NEW TASK</span><h2>Create a drawing task</h2></div><Button type="button" kind="ghost" onClick={onCancel}>Cancel</Button></div>{error && <div className="error">{error}</div>}
    <label>Course title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
    <label>Drawing task instructions<textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} required /></label>
    <label className="upload-field"><Image size={25} /><span><strong>Drawing background</strong><small>PNG, JPG, or WebP. Student tools only affect the drawing layer.</small></span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setForm({ ...form, background: e.target.files?.[0] || null })} required /></label>
    <DrawingSettingsFields form={form} setForm={setForm} creation />
    <fieldset><legend>Student access</legend><label className="toggle-row"><input type="checkbox" checked={form.studentExitEnabled} onChange={(e) => setForm({ ...form, studentExitEnabled: e.target.checked })} /><span>Allow students to leave the task</span></label><label className="toggle-row"><input type="checkbox" checked={form.newAttemptsAllowed} onChange={(e) => setForm({ ...form, newAttemptsAllowed: e.target.checked })} /><span>Allow another attempt after submission</span></label><label className="toggle-row"><input type="checkbox" checked={form.voiceEnabled} onChange={(e) => setForm({ ...form, voiceEnabled: e.target.checked })} /><span>Enable student voice tools</span></label></fieldset><Button icon={Plus} disabled={busy}>{busy ? 'Creating...' : 'Create task'}</Button>
  </form>;
}

function ClassroomSettings({ token, task, onSaved }) {
  const [form, setForm] = useState({ ...task }); const [names, setNames] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { api(`/teacher/tasks/${task.id}/whitelist`, {}, token).then((result) => setNames(result.entries.map((entry) => entry.studentNumber).join('\n'))).catch((error) => setMessage(error.message)); }, [task.id]);
  const save = async () => { setBusy(true); setMessage(''); try { await patch(`/teacher/tasks/${task.id}`, form, token); await put(`/teacher/tasks/${task.id}/whitelist`, { enabled: form.studentWhitelistEnabled, names: names.split(/\r?\n|,/).map((name) => name.trim()).filter(Boolean) }, token); setMessage('Settings saved.'); onSaved(); } catch (error) { setMessage(error.message); } finally { setBusy(false); } };
  return <section className="settings-band"><div className="panel-heading"><div><span className="eyebrow">TASK CONFIGURATION</span><h2>Canvas, classroom, and AI settings</h2></div><Button icon={Check} onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</Button></div>{message && <div className={message === 'Settings saved.' ? 'success' : 'error'}>{message}</div>}<div className="settings-grid">
    <fieldset><legend>Task content</legend><label>Course title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><label>Drawing task instructions<textarea value={form.prompt || ''} onChange={(e) => setForm({ ...form, prompt: e.target.value })} required /></label></fieldset><fieldset><legend>Classroom access</legend><label className="toggle-row"><input type="checkbox" checked={form.studentExitEnabled} onChange={(e) => setForm({ ...form, studentExitEnabled: e.target.checked })} /><span>Allow students to leave</span></label><label className="toggle-row"><input type="checkbox" checked={form.newAttemptsAllowed === true} onChange={(e) => setForm({ ...form, newAttemptsAllowed: e.target.checked })} /><span>Allow another attempt after submission</span></label><label className="toggle-row"><input type="checkbox" checked={form.voiceEnabled} onChange={(e) => setForm({ ...form, voiceEnabled: e.target.checked })} /><span>Enable voice tools</span></label><label className="toggle-row"><input type="checkbox" checked={form.studentWhitelistEnabled} onChange={(e) => setForm({ ...form, studentWhitelistEnabled: e.target.checked })} /><span>Require class-list membership</span></label>{form.studentWhitelistEnabled && <label>Class list <small>{names.split(/\r?\n|,/).filter((name) => name.trim()).length} names, one per line</small><textarea value={names} onChange={(e) => setNames(e.target.value)} /></label>}</fieldset>
    <DrawingSettingsFields form={form} setForm={setForm} />
  </div></section>;
}

function TaskDetail({ token, taskId, onBack, onChanged }) {
  const { displayName } = useBrand();
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [decisionLog, setDecisionLog] = useState(null); const [decisionBusy, setDecisionBusy] = useState(false);
  const load = async () => { try { setData(await api(`/teacher/tasks/${taskId}`, {}, token)); } catch (caught) { setError(caught.message); } };
  useEffect(() => { load(); const timer = setInterval(load, 10000); return () => clearInterval(timer); }, [taskId]);
  const setStatus = async (status) => { try { await patch(`/teacher/tasks/${taskId}`, { status }, token); await load(); onChanged(); } catch (caught) { setError(caught.message); } };
  const copyCode = async () => { try { await copyText(task.joinCode); setError(''); } catch { setError('The join code could not be copied.'); } };
  const exportTask = async () => { const filename = `${displayName}-${task.title}`.replace(/[\\/:*?"<>|]+/g, '-'); try { await download(`/teacher/tasks/${taskId}/export.xlsx`, `${filename}.xlsx`, token); } catch (caught) { setError(caught.message); } };
  const exportImages = async () => { const filename = `${displayName}-${task.title}`.replace(/[\\/:*?"<>|]+/g, '-'); try { await downloadZip(`/teacher/tasks/${taskId}/images.zip`, `${filename}-images.zip`, token); } catch (caught) { setError(caught.message); } };
  const exportDecisionLog = async () => { const filename = `${displayName}-${task.title}-AI-decisions`.replace(/[\\/:*?"<>|]+/g, '-'); try { await download(`/teacher/tasks/${taskId}/ai-decisions.xlsx`, `${filename}.xlsx`, token); } catch (caught) { setError(caught.message); } };
  const viewDecisions = async () => { setDecisionBusy(true); setError(''); try { setDecisionLog(await api(`/teacher/tasks/${taskId}/ai-decisions`, {}, token)); } catch (caught) { setError(caught.message); } finally { setDecisionBusy(false); } };
  const deleteTask = async () => { if (!window.confirm(`Delete "${task.title}" and all student artwork? This cannot be undone.`)) return; try { await api(`/teacher/tasks/${taskId}`, { method: 'DELETE' }, token); await onChanged(); onBack(); } catch (caught) { setError(caught.message); } };
  if (!data) return <div className="loading"><LoaderCircle size={24} />Loading task...</div>; const { task, participants, summary } = data;
  return <section><Button kind="ghost" icon={ArrowLeft} onClick={onBack}>All tasks</Button><div className="detail-header"><div><span className={`status ${task.status}`}>{task.status}</span><h1>{task.title}</h1><p>{task.prompt}</p></div><div className="task-actions"><button className="join-code" onClick={copyCode} title="Copy join code"><small>JOIN CODE</small><strong>{task.joinCode}</strong></button><Button kind="secondary" icon={Sparkles} onClick={viewDecisions} disabled={decisionBusy}>{decisionBusy ? 'Loading...' : 'AI decision log'}</Button><Button kind="secondary" icon={Download} onClick={exportTask}>Export Excel</Button><Button kind="secondary" icon={Archive} onClick={exportImages}>Export images ZIP</Button>{task.status !== 'active' && <Button icon={Check} onClick={() => setStatus('active')}>Open task</Button>}{task.status === 'active' && <Button kind="secondary" onClick={() => setStatus('closed')}>Close task</Button>}{task.status === 'closed' && <Button kind="secondary" onClick={() => setStatus('active')}>Reopen</Button>}<button className="icon-danger bordered" title="Delete task" onClick={deleteTask}><Trash2 size={19} /></button></div></div>
    {error && <div className="error">{error}</div>}<div className="task-reference"><img src={task.backgroundUrl} alt="Drawing background" /><div><small>DRAWING BACKGROUND</small><strong>{task.title}</strong></div></div>
    <ClassroomSettings token={token} task={task} onSaved={load} /><div className="summary-strip"><span><Users size={19} /><strong>{summary.joinedCount}</strong> joined</span><span><Check size={19} /><strong>{summary.submittedCount}</strong> submitted</span><span><strong>{summary.attemptCount}</strong> attempts</span><Button kind="ghost" icon={RefreshCw} onClick={load}>Refresh</Button></div>
    <div className="student-artwork-list">{participants.map((participant) => <section className="student-artworks" key={participant.id}><header><span><strong>{participant.name}</strong><small>{participant.studentNumber} | Joined {new Date(participant.joinedAt).toLocaleString()}</small></span><span>{participant.attempts.length} {participant.attempts.length === 1 ? 'attempt' : 'attempts'}</span></header><div className="art-grid">{participant.attempts.map((attempt) => <ArtworkCard key={attempt.id} item={{ ...attempt, participantId: participant.id, name: participant.name }} token={token} taskId={taskId} backgroundUrl={task.backgroundUrl} />)}</div></section>)}</div>
    {!participants.length && <div className="empty"><Users size={33} /><h3>No students yet</h3><p>Open the task and share the join code.</p></div>}
    {decisionLog && <Modal title="AI Decision Log" onClose={() => setDecisionLog(null)} wide><div className="decision-log-summary"><span><strong>{decisionLog.decisions.length}</strong> AI decision records</span><span><strong>{decisionLog.evaluations.length}</strong> review evaluations</span><Button kind="secondary" icon={Download} onClick={exportDecisionLog}>Download decision Excel</Button></div><div className="decision-log-list">{decisionLog.decisions.map((item) => <details className="decision-record" key={item.id}><summary><span><strong>{item.normalizedDecision?.action || 'UNKNOWN'}</strong><span className={`decision-execution ${decisionExecution(item).tone}`}>{decisionExecution(item).label}</span><small>{item.studentName} | Attempt {item.attemptNumber} | {item.activeSeconds}s</small></span><span><small>Beijing time (UTC+08:00): {item.createdAtBeijing}</small><span className={`decision-source ${item.fallback ? 'fallback' : ''}`}>{decisionSourceLabel(item)}</span></span></summary><div className="decision-record-grid"><section><h3>Trigger and decision evidence</h3><pre>{prettyJson(item.evidence)}</pre></section><section><h3>System prompt</h3><pre>{item.promptSystem || modelAuditPlaceholder(item)}</pre><h3>Input prompt</h3><pre>{item.promptInput || modelAuditPlaceholder(item)}</pre></section><section><h3>Raw model response</h3><pre>{item.normalizedDecision?.modelInvoked === false ? modelAuditPlaceholder(item) : prettyJson(item.rawResponse)}</pre><h3>Normalized and execution result</h3><pre>{prettyJson(item.normalizedDecision)}</pre>{item.responseError && <div className="error">{item.responseError}</div>}</section></div></details>)}{!decisionLog.decisions.length && <div className="empty"><Sparkles size={30} /><h3>No AI decision records yet</h3><p>Safety-boundary evaluations remain separate. A record appears here only after the model decision stage is reached.</p></div>}<details className="decision-record evaluations"><summary><strong>Review evaluations ({decisionLog.evaluations.length})</strong></summary><div className="evaluation-table">{decisionLog.evaluations.map((item) => <article key={item.id}><header><strong>{item.decision}</strong><small>{item.studentName} | Attempt {item.attemptNumber} | {item.activeSeconds}s | Beijing time (UTC+08:00): {item.evaluatedAtBeijing}</small></header><p>{item.decision === 'not_eligible' ? 'A live interaction safety boundary deferred model review.' : item.decision === 'withdraw' ? 'A valid model withdrawal decision was executed.' : 'The model kept the assistant visible.'}</p><pre>{prettyJson({ metrics: item.metrics, thresholds: item.thresholds })}</pre></article>)}</div></details></div></Modal>}
  </section>;
}

function ArtworkCard({ item, token, taskId, backgroundUrl }) {
  const [snapshots, setSnapshots] = useState(null); const [error, setError] = useState('');
  const toggleSnapshots = async () => { if (snapshots) return setSnapshots(null); try { setSnapshots((await api(`/teacher/tasks/${taskId}/participants/${item.participantId}/snapshots?workspaceId=${encodeURIComponent(item.id)}`, {}, token)).snapshots); } catch (caught) { setError(caught.message); } };
  return <article className="art-card"><div className="art-preview">{item.imageUrl ? <><img className="preview-background" src={backgroundUrl} alt="" /><img className="preview-drawing" src={`${item.imageUrl}?v=${encodeURIComponent(item.updatedAt || '')}`} alt={`${item.name}'s drawing, attempt ${item.attemptNumber}`} /></> : <Image size={34} />}</div><div className="art-meta"><span><strong>Attempt {item.attemptNumber}</strong><small>Updated {new Date(item.updatedAt).toLocaleString()}</small></span><span className={`status ${item.status}`}>{item.status}</span><small>{item.operationCount} operations | {Math.floor(item.activeSeconds / 60)} min</small><button className="snapshot-toggle" onClick={toggleSnapshots}>{snapshots ? 'Hide timeline' : `View ${item.snapshotCount} snapshots`}</button>{error && <small className="save-error">{error}</small>}</div>{snapshots && <div className="snapshot-strip">{snapshots.map((snapshot) => <a href={snapshot.imageUrl} target="_blank" rel="noreferrer" key={snapshot.id} title={`${snapshot.activeSeconds}s, ${snapshot.operationCount} operations`}><span className="snapshot-canvas"><img src={backgroundUrl} alt="" /><img src={snapshot.imageUrl} alt={`Snapshot at ${snapshot.activeSeconds} seconds`} /></span><small>{snapshot.snapshotKind} | {Math.floor(snapshot.activeSeconds / 60)}:{String(snapshot.activeSeconds % 60).padStart(2, '0')}</small></a>)}{!snapshots.length && <p>No saved snapshots yet.</p>}</div>}</article>;
}

function TeacherDashboard({ token, onExit }) {
  const { displayName } = useBrand();
  const [tasks, setTasks] = useState([]); const [creating, setCreating] = useState(false); const [selected, setSelected] = useState(''); const [configuring, setConfiguring] = useState(false); const [error, setError] = useState('');
  const load = async () => { try { setTasks((await api('/teacher/tasks', {}, token)).tasks); } catch (caught) { setError(caught.message); } }; useEffect(() => { load(); }, []);
  if (configuring) return <main className="app-shell"><ModelSettings token={token} onBack={() => setConfiguring(false)} /></main>;
  if (selected) return <main className="app-shell"><TaskDetail token={token} taskId={selected} onBack={() => setSelected('')} onChanged={load} /></main>;
  return <main className="app-shell"><header className="app-header"><div><span className="eyebrow">{displayName} TEACHER CONSOLE</span><h1>{displayName} Tasks</h1></div><div className="header-actions"><Button kind="secondary" icon={Settings} onClick={() => setConfiguring(true)}>Model settings</Button><Button kind="ghost" icon={LogOut} onClick={onExit}>Sign out</Button></div></header>{error && <div className="error">{error}</div>}{creating ? <CreateTask token={token} onCancel={() => setCreating(false)} onCreated={(task) => { setCreating(false); load(); setSelected(task.id); }} /> : <><div className="toolbar"><p>Create and manage drawing tasks in {displayName}.</p><Button icon={Plus} onClick={() => setCreating(true)}>New task</Button></div><div className="task-list">{tasks.map((task) => <button className="task-row" key={task.id} onClick={() => setSelected(task.id)}><span className={`status ${task.status}`}>{task.status}</span><span><strong>{task.title}</strong><small>{task.studentWhitelistEnabled ? 'Class list required' : 'Open class'}</small></span><span><Users size={18} />{task.participantCount}</span><span><Check size={18} />{task.submittedCount}</span><ArrowRight size={20} /></button>)}</div>{!tasks.length && <div className="empty"><Palette size={34} /><h3>Create your first drawing task</h3><p>Add a drawing background and configure the activity.</p></div>}</>}</main>;
}

function StudentJoin({ onJoined, onBack }) {
  const { displayName } = useBrand();
  const [form, setForm] = useState({ taskId: '', joinCode: '', studentNumber: '', consentConfirmed: false }); const [tasks, setTasks] = useState([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const loadTasks = async () => { setError(''); try { setTasks((await api('/student/open-tasks')).tasks); } catch (caught) { setError(caught.message); } }; useEffect(() => { loadTasks(); }, []); useEffect(() => { if (tasks.length && !form.taskId && !form.joinCode) setForm((current) => ({ ...current, taskId: tasks[0].id })); }, [tasks]);
  const submit = async (event) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await post('/student/join', form); if (!isStudentStudioState(result.state)) throw new Error('Your drawing workspace could not be opened. Please join the task again.'); localStorage.setItem(STUDENT_TOKEN, result.token); onJoined(result.token, result.state); } catch (caught) { setError(caught.message); } finally { setBusy(false); } };
  return <main className="center-page"><Button kind="ghost back" icon={ArrowLeft} onClick={onBack}>Back</Button><form className="panel join-panel" onSubmit={submit}><GraduationCap className="panel-icon" size={31} /><h1>Join {displayName}</h1><p className="muted">Select a task or enter the join code from your teacher.</p>{error && <div className="error">{error}</div>}<label>Open task<select value={form.taskId} onChange={(e) => setForm({ ...form, taskId: e.target.value, joinCode: '' })} disabled={!tasks.length}><option value="">{tasks.length ? 'Select a task' : 'No tasks are currently open'}</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><Button type="button" kind="ghost" icon={RefreshCw} onClick={loadTasks}>Refresh task list</Button><div className="join-divider"><span>or</span></div><label>Join code<input value={form.joinCode} onChange={(e) => setForm({ ...form, joinCode: e.target.value.toUpperCase(), taskId: '' })} maxLength="12" autoCapitalize="characters" placeholder="Enter the code from your teacher" /></label><label>Name<input value={form.studentNumber} onChange={(e) => setForm({ ...form, studentNumber: e.target.value })} minLength="2" maxLength="40" autoComplete="username" required /></label><div className="protocol-note">AI use and drawing activity may be recorded for classroom review. Use AI support when it is genuinely helpful.</div><label className="toggle-row"><input type="checkbox" checked={form.consentConfirmed} onChange={(e) => setForm({ ...form, consentConfirmed: e.target.checked })} /><span>My teacher has explained today's activity, and I agree to participate.</span></label><Button icon={busy ? LoaderCircle : ArrowRight} disabled={busy || (!form.taskId && !form.joinCode.trim()) || !form.consentConfirmed || form.studentNumber.trim().length < 2}>{busy ? 'Joining...' : 'Start task'}</Button></form></main>;
}

const DRAWING_COLORS = ['#111111', '#d83b3b', '#2474c6', '#e7b416', '#238b57', '#7b4db3'];
const DRAWING_WIDTHS = [4, 8, 14, 24];
const QUICK_ASSISTANT_PROMPTS = [
  { key: 'observe', label: 'Look at my drawing', message: 'Please look at my current drawing and tell me what you notice.' },
  { key: 'suggest', label: 'Give me one suggestion', message: 'Please consider my idea and current drawing, and give me one small suggestion I can try.' },
  { key: 'next_step', label: 'Think about the next step', message: 'Where could I continue drawing next?' }
];
const DrawingCanvas = forwardRef(function DrawingCanvas({ task, draftUrl, disabled, onChange }, ref) {
  const canvasRef = useRef(null); const backgroundCanvasRef = useRef(null); const backgroundImageRef = useRef(null); const stageRef = useRef(null); const [dimensions] = useState({ width: CANVAS_BOARD_SIZE, height: CANVAS_BOARD_SIZE }); const [backgroundReady, setBackgroundReady] = useState(false); const [displaySize, setDisplaySize] = useState(null); const [tool, setTool] = useState('brush'); const [color, setColor] = useState(DRAWING_COLORS[0]); const [size, setSize] = useState(DRAWING_WIDTHS[1]); const [history, setHistory] = useState([]); const [future, setFuture] = useState([]); const drawing = useRef(false); const last = useRef(null); const stroke = useRef(null);
  const snapshot = () => canvasRef.current.toDataURL('image/png');
  const restore = (url) => new Promise((resolve) => { const canvas = canvasRef.current; const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height); if (!url) return resolve(); const image = new window.Image(); image.crossOrigin = 'anonymous'; image.onload = () => { const isFullBoardDraft = image.naturalWidth === dimensions.width && image.naturalHeight === dimensions.height; if (isFullBoardDraft || !backgroundImageRef.current) context.drawImage(image, 0, 0, canvas.width, canvas.height); else { const geometry = lockedBackgroundGeometry(backgroundImageRef.current, canvas.width, canvas.height); context.drawImage(image, geometry.imageX, geometry.imageY, geometry.imageWidth, geometry.imageHeight); } resolve(); }; image.onerror = resolve; image.src = url; });
  useEffect(() => {
    let cancelled = false;
    setBackgroundReady(false);
    backgroundImageRef.current = null;
    const backgroundCanvas = backgroundCanvasRef.current;
    drawLockedBackground(backgroundCanvas.getContext('2d'), null, backgroundCanvas.width, backgroundCanvas.height);
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      backgroundImageRef.current = image;
      const canvas = backgroundCanvasRef.current;
      drawLockedBackground(canvas.getContext('2d'), image, canvas.width, canvas.height);
      setBackgroundReady(true);
    };
    image.onerror = () => { if (!cancelled) setBackgroundReady(false); };
    image.src = task.backgroundUrl;
    return () => { cancelled = true; };
  }, [task.backgroundUrl, dimensions.width, dimensions.height]);
  useEffect(() => { if (backgroundReady) restore(draftUrl); }, [draftUrl, backgroundReady, dimensions.width, dimensions.height]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = () => {
      if (window.matchMedia('(max-width: 980px)').matches) {
        setDisplaySize(null);
        return;
      }
      const availableWidth = stage.clientWidth;
      const availableHeight = stage.clientHeight;
      if (!availableWidth || !availableHeight) return;
      const scale = Math.min(availableWidth / dimensions.width, availableHeight / dimensions.height);
      const next = {
        width: Math.max(1, Math.floor(dimensions.width * scale)),
        height: Math.max(1, Math.floor(dimensions.height * scale))
      };
      setDisplaySize((current) => current?.width === next.width && current?.height === next.height ? current : next);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(stage);
    window.addEventListener('resize', update);
    update();
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [dimensions.width, dimensions.height]);
  const point = (event) => { const rect = canvasRef.current.getBoundingClientRect(); return { x: (event.clientX - rect.left) * dimensions.width / rect.width, y: (event.clientY - rect.top) * dimensions.height / rect.height }; };
  const start = (event) => { if (disabled) return; event.currentTarget.setPointerCapture(event.pointerId); setHistory((items) => [...items.slice(-19), snapshot()]); setFuture([]); drawing.current = true; last.current = point(event); stroke.current = { startedAt: performance.now(), pathLength: 0, points: [last.current.x / dimensions.width, last.current.y / dimensions.height] }; };
  const move = (event) => { if (!drawing.current || disabled) return; const next = point(event); const previous = last.current; const context = canvasRef.current.getContext('2d'); context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = size; context.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : color; context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'; context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(next.x, next.y); context.stroke(); const diagonal = Math.max(1, Math.hypot(dimensions.width, dimensions.height)); stroke.current.pathLength += Math.hypot(next.x - previous.x, next.y - previous.y) / diagonal; stroke.current.points.push(next.x / dimensions.width, next.y / dimensions.height); last.current = next; };
  const end = () => { if (!drawing.current) return; drawing.current = false; last.current = null; const detail = stroke.current || { startedAt: performance.now(), pathLength: 0, points: [] }; stroke.current = null; onChange(snapshot(), { type: tool === 'eraser' ? 'erase' : 'stroke', color, width: size, pathLength: detail.pathLength, durationMs: Math.max(0, performance.now() - detail.startedAt), points: detail.points.slice(-80) }); };
  const undo = async () => { if (!history.length || disabled) return; const current = snapshot(); const previous = history[history.length - 1]; setHistory((items) => items.slice(0, -1)); setFuture((items) => [...items.slice(-19), current]); await restore(previous); onChange(snapshot(), { type: 'undo' }); };
  const redo = async () => { if (!future.length || disabled) return; const current = snapshot(); const next = future[future.length - 1]; setFuture((items) => items.slice(0, -1)); setHistory((items) => [...items.slice(-19), current]); await restore(next); onChange(snapshot(), { type: 'redo' }); };
  const clear = () => { if (disabled || !window.confirm('Clear all of your drawing marks?')) return; setHistory((items) => [...items.slice(-19), snapshot()]); setFuture([]); restore('').then(() => onChange(snapshot(), { type: 'clear', pathLength: 1, durationMs: 0, points: [] })); };
  const changeTool = (nextTool) => { if (nextTool === tool) return; setTool(nextTool); onChange(snapshot(), { type: 'tool_change', property: 'tool', value: nextTool, visual: false }); };
  const changeColor = (nextColor) => { if (nextColor === color) return; setColor(nextColor); onChange(snapshot(), { type: 'tool_change', property: 'color', value: nextColor, visual: false }); };
  const changeWidth = (nextSize) => { if (nextSize === size) return; setSize(nextSize); onChange(snapshot(), { type: 'tool_change', property: 'width', value: nextSize, visual: false }); };
  const composite = async (maximumSide = Number.POSITIVE_INFINITY, mimeType = 'image/png', quality) => { const scale = Math.min(1, maximumSide / Math.max(dimensions.width, dimensions.height)); const output = document.createElement('canvas'); output.width = Math.max(1, Math.round(dimensions.width * scale)); output.height = Math.max(1, Math.round(dimensions.height * scale)); const context = output.getContext('2d'); drawLockedBackground(context, backgroundImageRef.current, output.width, output.height); context.drawImage(canvasRef.current, 0, 0, output.width, output.height); return output.toDataURL(mimeType, quality); };
  const saveCopy = async () => { const anchor = document.createElement('a'); anchor.href = await composite(); anchor.download = `${task.title || 'drawing'}.png`; anchor.click(); };
  useImperativeHandle(ref, () => ({ overlay: snapshot, composite: () => composite(), assistantImage: () => composite(1200), processSnapshot: () => composite(960, 'image/webp', 0.68), baselineSnapshot: () => composite(1200), snapshotReady: () => backgroundReady }));
  const frameStyle = displaySize
    ? { aspectRatio: `${dimensions.width} / ${dimensions.height}`, width: `${displaySize.width}px`, height: `${displaySize.height}px` }
    : { aspectRatio: `${dimensions.width} / ${dimensions.height}` };
  return <div className="canvas-tool"><div className="canvas-toolbar"><button className={tool === 'brush' ? 'active' : ''} title="Brush" onClick={() => changeTool('brush')}><Brush size={20} /></button><button className={tool === 'eraser' ? 'active' : ''} title="Eraser" onClick={() => changeTool('eraser')}><Eraser size={20} /></button><div className="color-swatches" aria-label="Brush color">{DRAWING_COLORS.map((item) => <button type="button" key={item} className={color === item ? 'active' : ''} style={{ '--swatch': item }} title={`Use ${item}`} onClick={() => changeColor(item)} />)}</div><div className="canvas-width-tools" aria-label="Brush width">{DRAWING_WIDTHS.map((item) => <button type="button" key={item} className={size === item ? 'active' : ''} title={`Brush width ${item}`} aria-label={`Select brush width ${item}`} onClick={() => changeWidth(item)}><span style={{ width: Math.max(4, item), height: Math.max(4, item) }} /></button>)}</div><button title="Undo" onClick={undo} disabled={!history.length}><RotateCcw size={20} /></button><button title="Redo" onClick={redo} disabled={!future.length}><RotateCw size={20} /></button><button title="Download a copy" onClick={saveCopy}><Download size={20} /></button><button title="Clear drawing" onClick={clear}><Trash2 size={20} /></button></div><div className="canvas-stage" ref={stageRef}><div className="canvas-frame" style={frameStyle}><canvas ref={backgroundCanvasRef} className="canvas-background" width={dimensions.width} height={dimensions.height} aria-hidden="true" /><span className="canvas-locked-frame" aria-hidden="true" /><canvas ref={canvasRef} className="canvas-drawing" width={dimensions.width} height={dimensions.height} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label="Drawing canvas" /></div></div></div>;
});

function StudentStudio({ token, initialState, onExit }) {
  const { displayName } = useBrand();
  const [state, setState] = useState(initialState); const [seconds, setSeconds] = useState(initialState.workspace.activeSeconds); const [operations, setOperations] = useState(initialState.workspace.operationCount); const [saveState, setSaveState] = useState('Saved'); const [pendingImage, setPendingImage] = useState(''); const [question, setQuestion] = useState(''); const [messages, setMessages] = useState(initialState.messages); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [assistantState, setAssistantState] = useState(initialState.workspace.assistantState || 'hidden'); const [assistantRevealed, setAssistantRevealed] = useState(initialState.task.aiLifecycleEnabled === false); const [lastAiAccessAt, setLastAiAccessAt] = useState(Number(initialState.workspace.lastAiAccessActiveSeconds) || 0); const [inputActive, setInputActive] = useState(false); const [panelActive, setPanelActive] = useState(false); const [historyOpen, setHistoryOpen] = useState(false); const canvasRef = useRef(null); const messageListRef = useRef(null); const followLatestMessageRef = useRef(true); const secondsRef = useRef(seconds); const operationsRef = useRef(operations); const pendingRef = useRef(pendingImage); const lastSavedRef = useRef(''); const saveBusyRef = useRef(false); const savePromiseRef = useRef(null); const reviewBusyRef = useRef(false); const revealTimerRef = useRef(null); const hideTimerRef = useRef(null); const clockOriginMsRef = useRef(Date.now() - Math.max(0, Number(initialState.workspace.activeSeconds) || 0) * 1000); const lastAiAccessAtRef = useRef(Number(initialState.workspace.lastAiAccessActiveSeconds) || 0); const lastSnapshotActiveSecondsRef = useRef(initialState.workspace.activeSeconds); const snapshotBusyRef = useRef(false); const baselineStartedRef = useRef(Number(initialState.workspace.snapshotCount || 0) > 0); const inputActiveRef = useRef(inputActive); const panelActiveRef = useRef(panelActive); const busyRef = useRef(busy); secondsRef.current = seconds; operationsRef.current = operations; pendingRef.current = pendingImage; lastAiAccessAtRef.current = lastAiAccessAt; inputActiveRef.current = inputActive; panelActiveRef.current = panelActive; busyRef.current = busy;
  const pendingOperationsRef = useRef([]); const operationFlushBusyRef = useRef(false); const operationFlushPromiseRef = useRef(null); const operationSeqRef = useRef(initialState.workspace.operationCount);
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => { const changed = () => { const visible = document.visibilityState === 'visible'; setPageVisible(visible); if (!visible && state.workspace.status === 'draft') { put('/student/time', { activeSeconds: secondsRef.current }, token).catch(() => {}); saveLatest(false).catch(() => {}); } }; document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); }, [state.workspace.status, token]);
  useEffect(() => { if (state.workspace.status !== 'draft') return undefined; const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - clockOriginMsRef.current) / 1000))); update(); const timer = setInterval(update, 250); return () => clearInterval(timer); }, [state.workspace.id, state.workspace.status]);
  useEffect(() => { if (state.workspace.status !== 'draft') return; const timer = setInterval(() => put('/student/time', { activeSeconds: secondsRef.current }, token).catch(() => {}), 5000); return () => clearInterval(timer); }, [state.workspace.id, state.workspace.status, token]);
  const flushOperations = () => { if (operationFlushBusyRef.current) return operationFlushPromiseRef.current || Promise.resolve(); if (!pendingOperationsRef.current.length) return Promise.resolve(); operationFlushBusyRef.current = true; const request = (async () => { while (pendingOperationsRef.current.length) { const batch = pendingOperationsRef.current.slice(0, 100); await post('/student/operations', { operations: batch }, token); pendingOperationsRef.current.splice(0, batch.length); } })(); operationFlushPromiseRef.current = request; return request.catch((caught) => { console.warn('[drawing-operations] save failed:', caught.message); throw caught; }).finally(() => { operationFlushBusyRef.current = false; if (operationFlushPromiseRef.current === request) operationFlushPromiseRef.current = null; }); };
  useEffect(() => { if (state.workspace.status !== 'draft') return undefined; const timer = setInterval(() => flushOperations().catch(() => {}), 800); return () => { clearInterval(timer); flushOperations().catch(() => {}); }; }, [state.workspace.id, state.workspace.status, token]);
  useEffect(() => { if (pendingImage && pendingImage !== lastSavedRef.current) setSaveState('Unsaved'); }, [pendingImage]);
  async function saveLatest(captureSnapshot = false, snapshotKind = 'interval') { const image = pendingRef.current || lastSavedRef.current || (captureSnapshot ? canvasRef.current?.overlay?.() : ''); if (!image || (!captureSnapshot && image === lastSavedRef.current)) return; if (saveBusyRef.current) return savePromiseRef.current; const savedAtActiveSeconds = secondsRef.current; const snapshotImage = captureSnapshot ? await (snapshotKind === 'baseline' ? canvasRef.current?.baselineSnapshot?.() : canvasRef.current?.processSnapshot?.()) : ''; saveBusyRef.current = true; if (!captureSnapshot) setSaveState('Saving...'); const request = put('/student/work', { image, snapshotImage, activeSeconds: savedAtActiveSeconds, operationCount: operationsRef.current, captureSnapshot, snapshotKind }, token); savePromiseRef.current = request; try { await request; lastSavedRef.current = image; if (captureSnapshot) lastSnapshotActiveSecondsRef.current = savedAtActiveSeconds; setSaveState(!pendingRef.current || pendingRef.current === image ? 'Saved' : 'Unsaved'); setError(''); } catch (caught) { setSaveState('Save failed'); setError(caught.message); throw caught; } finally { saveBusyRef.current = false; if (savePromiseRef.current === request) savePromiseRef.current = null; } }
  useEffect(() => { if (state.workspace.status !== 'draft' || !pendingImage || pendingImage === lastSavedRef.current) return undefined; const timer = setTimeout(() => saveLatest(false).catch(() => {}), DRAWING_DRAFT_SAVE_DELAY_MS); return () => clearTimeout(timer); }, [pendingImage, state.workspace.status, token]);
  useEffect(() => { if (state.workspace.status !== 'draft' || baselineStartedRef.current) return undefined; const timer = setInterval(() => { if (baselineStartedRef.current || !canvasRef.current?.snapshotReady?.() || saveBusyRef.current) return; baselineStartedRef.current = true; saveLatest(true, 'baseline').catch(() => { baselineStartedRef.current = false; }); }, 500); return () => clearInterval(timer); }, [state.workspace.status, token]);
  useEffect(() => { if (state.workspace.status !== 'draft' || !pageVisible) return undefined; const interval = Math.max(0, Number(state.task.snapshotIntervalSeconds) || 0); if (!interval) return undefined; const timer = setInterval(() => { const active = secondsRef.current; if (active < lastSnapshotActiveSecondsRef.current + interval || snapshotBusyRef.current || saveBusyRef.current) return; snapshotBusyRef.current = true; saveLatest(true).catch(() => {}).finally(() => { snapshotBusyRef.current = false; }); }, 1000); return () => clearInterval(timer); }, [pageVisible, state.task.snapshotIntervalSeconds, state.workspace.status, token]);
  const reportAssistantAccess = (active = secondsRef.current, persist = true) => { const bounded = Math.max(0, Number(active) || 0); lastAiAccessAtRef.current = bounded; setLastAiAccessAt(bounded); if (!persist) return Promise.resolve({ assistantState }); return post('/student/assistant/access', { activeSeconds: bounded }, token).then((result) => { setAssistantState(result.assistantState); return result; }); };
  useEffect(() => {
    if (state.workspace.status !== 'draft' || state.task.aiPolicy === 'off' || ['fading', 'withdrawn'].includes(assistantState)) return undefined;
    let cancelled = false;
    let timer = null;
    const defaultReviewSeconds = 30;
    const schedule = (delaySeconds = defaultReviewSeconds) => {
      if (cancelled) return;
      clearTimeout(timer);
      const requestedDelay = Number(delaySeconds);
      timer = setTimeout(review, Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : defaultReviewSeconds) * 1000);
    };
    const review = async () => {
      if (cancelled) return;
      if (reviewBusyRef.current) return schedule(defaultReviewSeconds);
      reviewBusyRef.current = true;
      const active = secondsRef.current;
      let nextReviewSeconds = defaultReviewSeconds;
      try {
        await flushOperations();
        let image = '';
        try { image = await canvasRef.current?.assistantImage?.() || ''; } catch { image = ''; }
        const result = await post('/student/assistant/review', { activeSeconds: active, inputActive: inputActiveRef.current, panelActive: panelActiveRef.current, responsePending: busyRef.current, lastAiAccessActiveSeconds: lastAiAccessAtRef.current, image }, token);
        nextReviewSeconds = Math.max(3, Number(result.nextReviewSeconds) || defaultReviewSeconds);
        if (cancelled) return;
        if (result.assistantState === 'fading' || result.assistantState === 'withdrawn') setAssistantRevealed(false);
        setAssistantState(result.assistantState);
      } catch (caught) {
        console.warn('[drawing-assistant] background review failed:', caught.message);
      } finally {
        reviewBusyRef.current = false;
        schedule(nextReviewSeconds);
      }
    };
    schedule(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [assistantState, state.task.aiPolicy, state.task.flowEvaluationIntervalSeconds, state.workspace.id, state.workspace.status, token]);
  useEffect(() => { if (assistantState !== 'fading') return undefined; const timer = setTimeout(() => post('/student/assistant/withdrawal-complete', { activeSeconds: secondsRef.current }, token).then((result) => setAssistantState(result.assistantState)).catch((caught) => console.warn('[drawing-assistant] withdrawal sync failed:', caught.message)), Math.max(0, state.task.withdrawalFadeMilliseconds || 2500)); return () => clearTimeout(timer); }, [assistantState, state.task.withdrawalFadeMilliseconds, token]);
  useEffect(() => { const list = messageListRef.current; if (!list || !followLatestMessageRef.current) return; window.requestAnimationFrame(() => { if (followLatestMessageRef.current) list.scrollTop = list.scrollHeight; }); }, [messages, busy]);
  useEffect(() => () => { clearTimeout(revealTimerRef.current); clearTimeout(hideTimerRef.current); }, []);
  const changed = (image, detail = { type: 'stroke' }) => { const activeSeconds = secondsRef.current; const seq = operationSeqRef.current + 1; operationSeqRef.current = seq; pendingOperationsRef.current.push({ id: createClientOperationId(), seq, type: detail.type, detail, activeSeconds, occurredAt: new Date().toISOString() }); if (detail.visual !== false) setPendingImage(image); setOperations(seq); };
  const ask = async (prompt = null) => { const sent = prompt?.message || question.trim(); if (!sent || busy) return; setQuestion(''); setBusy(true); reportAssistantAccess(secondsRef.current, false); setMessages((items) => [...items, { role: 'student', content: sent, quickPromptKey: prompt?.key || '' }]); try { let image = ''; try { image = await canvasRef.current?.assistantImage?.() || ''; } catch { image = canvasRef.current?.overlay?.() || ''; } const result = await post('/student/assistant', { question: sent, quickPromptKey: prompt?.key || '', activeSeconds: secondsRef.current, image }, token); setMessages((items) => [...items, { role: 'assistant', content: result.reply }]); const responseActiveSeconds = secondsRef.current; reportAssistantAccess(responseActiveSeconds, false); await post('/student/assistant/response-complete', { activeSeconds: responseActiveSeconds, operationSeq: operationSeqRef.current }, token).catch((caught) => console.warn('[drawing-assistant] response acknowledgement failed:', caught.message)); } catch (caught) { setError(caught.message); } finally { setBusy(false); } };
  const submit = async (timedOut = false) => { if (!timedOut && !window.confirm('Submit this drawing? You will not be able to edit it afterward.')) return; if (!canvasRef.current) return; setBusy(true); try { if (savePromiseRef.current) await savePromiseRef.current.catch(() => {}); await flushOperations(); const image = await canvasRef.current.composite(); const result = await post('/student/submit', { image, activeSeconds: secondsRef.current, operationCount: operationsRef.current }, token); setState(result.state); setSaveState('Saved'); } catch (caught) { setError(caught.message); } finally { setBusy(false); } };
  const startAttempt = async () => { setBusy(true); setError(''); try { const result = await post('/student/attempts', {}, token); const activeSeconds = Number(result.state.workspace.activeSeconds) || 0; setHistoryOpen(false); setState(result.state); setSeconds(activeSeconds); clockOriginMsRef.current = Date.now() - activeSeconds * 1000; setOperations(result.state.workspace.operationCount); operationSeqRef.current = result.state.workspace.operationCount; pendingOperationsRef.current = []; setPendingImage(''); lastSavedRef.current = ''; lastSnapshotActiveSecondsRef.current = activeSeconds; baselineStartedRef.current = Number(result.state.workspace.snapshotCount || 0) > 0; followLatestMessageRef.current = true; setMessages(result.state.messages); setAssistantState(result.state.workspace.assistantState || 'hidden'); setAssistantRevealed(result.state.task.aiLifecycleEnabled === false); setLastAiAccessAt(Number(result.state.workspace.lastAiAccessActiveSeconds) || 0); } catch (caught) { setError(caught.message); } finally { setBusy(false); } };
  const reopenAssistant = async (kind) => { try { const result = await post('/student/assistant/reopen', { kind, activeSeconds: secondsRef.current }, token); setAssistantState('visible'); followLatestMessageRef.current = true; setMessages(result.messages || []); setQuestion(''); setAssistantRevealed(true); setLastAiAccessAt(secondsRef.current); } catch (caught) { setError(caught.message); } };
  const cancelWithdrawal = async () => { if (assistantState !== 'fading') return; setAssistantState('visible'); setAssistantRevealed(true); setPanelActive(true); try { const result = await post('/student/assistant/withdrawal-cancel', { activeSeconds: secondsRef.current }, token); if (!result.cancelled && result.assistantState !== 'visible') setAssistantState(result.assistantState); } catch (caught) { setError(caught.message); setAssistantState('fading'); } };
  useEffect(() => { if (state.workspace.status === 'draft' && state.task.timeLimitSeconds > 0 && seconds >= state.task.timeLimitSeconds && !busy) submit(true); }, [seconds, state.workspace.status]);
  const remaining = state.task.timeLimitSeconds > 0 ? Math.max(0, state.task.timeLimitSeconds - seconds) : null; const final = state.workspace.status === 'submitted';
  const assistantEnabled = state.task.aiPolicy !== 'off'; const assistantAvailable = assistantEnabled && (assistantState !== 'hidden' || seconds >= state.task.aiAppearSeconds); const assistantHidden = assistantState === 'fading' || assistantState === 'withdrawn';
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); }, [state.workspace.id, state.workspace.status]);
  return <main className={`studio-shell ${final ? 'studio-shell-final' : ''}`}><header className="studio-header"><div><span className="eyebrow">{displayName} | {state.task.title}</span><h1>{final ? 'Drawing Complete' : 'Drawing Practice'}</h1></div><div className="studio-meta"><span><Clock size={16} />{remaining == null ? 'Unlimited' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}</span><span className={saveState === 'Save failed' ? 'save-error' : ''}>{saveState}</span>{state.task.studentExitEnabled && <Button kind="ghost" icon={LogOut} onClick={onExit}>Leave</Button>}</div></header><section className="prompt-band"><Palette size={25} /><div><small>YOUR DRAWING TASK</small><strong>{state.task.prompt || state.task.title}</strong></div>{!final && <Button icon={Send} onClick={() => submit(false)} disabled={busy}>I'm finished drawing</Button>}</section>{error && <div className="error">{error}</div>}
    {final ? <section className="final-panel"><Check size={42} /><h2>Your artwork has been submitted.</h2><div className="history-trigger-row"><Button kind="secondary" icon={History} onClick={() => setHistoryOpen(true)}>View history</Button>{state.task.newAttemptsAllowed && <Button icon={Plus} onClick={startAttempt} disabled={busy}>Start another attempt</Button>}</div><img src={state.workspace.finalImageUrl} alt="Your submitted drawing" /></section> : <div className={`studio-grid ${assistantEnabled ? '' : 'single'}`}>
      <DrawingCanvas ref={canvasRef} task={state.task} draftUrl={state.workspace.draftImageUrl ? `${state.workspace.draftImageUrl}?v=${encodeURIComponent(state.workspace.updatedAt || '')}` : ''} onChange={changed} />
      {assistantEnabled && (!assistantAvailable
        ? <aside className="assistant-panel assistant-locked" aria-label="Creative Assistant unavailable" />
        : assistantHidden
          ? <WithdrawnAssistant state={assistantState} revealed={assistantRevealed} onReveal={() => setAssistantRevealed(true)} onHide={() => setAssistantRevealed(false)} onCancel={cancelWithdrawal} onReopen={reopenAssistant} />
          : <aside className={`assistant-panel assistant-live ${state.task.aiLifecycleEnabled !== false && !assistantRevealed ? 'assistant-obscured' : ''}`} onPointerEnter={() => { clearTimeout(hideTimerRef.current); if (state.task.aiLifecycleEnabled === false) return; clearTimeout(revealTimerRef.current); revealTimerRef.current = setTimeout(() => { setPanelActive(true); setAssistantRevealed(true); reportAssistantAccess().catch(() => {}); }, 450); }} onPointerLeave={() => { setPanelActive(false); clearTimeout(revealTimerRef.current); if (state.task.aiLifecycleEnabled !== false) { clearTimeout(hideTimerRef.current); hideTimerRef.current = setTimeout(() => setAssistantRevealed(false), 650); } }} onPointerDown={() => { clearTimeout(revealTimerRef.current); clearTimeout(hideTimerRef.current); setPanelActive(true); setAssistantRevealed(true); reportAssistantAccess().catch(() => {}); }}>
            <div className="assistant-title"><Sparkles size={21} /><div><strong>Creative Assistant</strong><small>{state.task.voiceEnabled ? 'Type or speak your question' : 'Type a question about your drawing'}</small></div></div>
            <div className="assistant-body">{state.task.aiLifecycleEnabled !== false && !assistantRevealed && <p className="assistant-hover-hint">AI is available. Hover to view.</p>}<div className="assistant-maskable"><p className="assistant-reminder">Use AI carefully. It offers small tips and does not create the work for you.</p><div className="assistant-conversation"><div className="messages" ref={messageListRef} onScroll={(event) => { const list = event.currentTarget; followLatestMessageRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 48; }}>{!messages.length && <p>If you feel stuck, describe where you are in your drawing. The assistant will offer one small suggestion without drawing for you.</p>}{messages.map((message, index) => <div className={`message ${message.role}`} key={index}>{message.content}</div>)}{busy && <div className="message assistant"><LoaderCircle size={17} />Preparing a tip...</div>}</div></div><div className="quick-prompts" aria-label="Quick questions">{QUICK_ASSISTANT_PROMPTS.map((prompt) => <button type="button" key={prompt.key} disabled={busy} onClick={() => ask(prompt)}>{prompt.label}</button>)}</div><div className="ask-row"><textarea value={question} onFocus={() => { setInputActive(true); setPanelActive(true); setAssistantRevealed(true); reportAssistantAccess().catch(() => {}); }} onBlur={() => setInputActive(false)} onChange={(e) => setQuestion(e.target.value)} placeholder="Enter your question" />{state.task.voiceEnabled && <button title="Dictate question" onClick={() => dictate((text) => setQuestion((current) => `${current}${current && text ? ' ' : ''}${text}`), setError)}><Mic size={19} /></button>}<button title="Send question" onClick={() => ask()} disabled={busy || !question.trim()}><Send size={19} /></button></div></div></div>
          </aside>)}
    </div>}
    {historyOpen && <Modal title="Completed Drawing History" onClose={() => setHistoryOpen(false)} wide><div className="drawing-history-grid">{state.history.map((item) => <article key={item.id}><div className="drawing-history-image"><img src={item.imageUrl} alt={`Attempt ${item.attemptNumber}`} /></div><footer><strong>Attempt {item.attemptNumber}</strong><small>{Math.floor(item.activeSeconds / 60)}:{String(item.activeSeconds % 60).padStart(2, '0')}</small></footer></article>)}</div></Modal>}
  </main>;
}

function WithdrawnAssistant({ state, revealed, onReveal, onHide, onCancel, onReopen }) {
  const settling = state === 'fading';
  return <aside className={`assistant-panel assistant-withdrawn ${!revealed ? 'assistant-obscured' : ''}`} onPointerEnter={() => { onReveal(); if (settling) onCancel(); }} onPointerLeave={onHide}>
    <div className="assistant-title"><Sparkles size={21} /><div><strong>Creative Assistant</strong><small>{settling ? 'Stepping back from your drawing' : 'Available again when you choose'}</small></div></div>
    <div className="assistant-body">{!revealed && <p className="assistant-hover-hint">AI has stepped back. Hover for options.</p>}<div className="assistant-maskable reopen-options">
      <button type="button" disabled={settling} onClick={() => onReopen('new_question')}><MessageCircle size={20} /><span>Start a new conversation<small>Do not display or use earlier messages</small></span></button>
      <button type="button" disabled={settling} onClick={() => onReopen('history')}><History size={20} /><span>Continue the previous conversation<small>Restore the messages and continue</small></span></button>
    </div></div>
  </aside>;
}

export default function App() {
  const [config, setConfig] = useState({ displayName: 'DrawBreath', homeUrl: '/' }); const [role, setRole] = useState(''); const [teacherToken, setTeacherToken] = useState(() => localStorage.getItem(TEACHER_TOKEN) || ''); const [studentToken, setStudentToken] = useState(() => localStorage.getItem(STUDENT_TOKEN) || ''); const [studentState, setStudentState] = useState(null);
  useEffect(() => { api('/config').then(setConfig).catch(() => {}); }, []);
  useEffect(() => {
    if (!studentToken || studentState || role) return undefined;
    let active = true;
    api('/student/me', {}, studentToken).then((result) => {
      if (!active) return;
      if (!isStudentStudioState(result.state)) throw new Error('Incomplete drawing workspace state.');
      setStudentState(result.state);
      setRole('student');
    }).catch(() => {
      if (!active) return;
      localStorage.removeItem(STUDENT_TOKEN);
      setStudentToken('');
      setStudentState(null);
    });
    return () => { active = false; };
  }, [role, studentState, studentToken]);
  useEffect(() => { document.title = config.displayName; }, [config.displayName]);
  const teacherExit = () => { localStorage.removeItem(TEACHER_TOKEN); setTeacherToken(''); setRole(''); }; const studentExit = () => { localStorage.removeItem(STUDENT_TOKEN); setStudentToken(''); setStudentState(null); setRole(''); };
  useEffect(() => { const expired = (event) => { if (event.detail?.token === teacherToken) teacherExit(); if (event.detail?.token === studentToken) studentExit(); }; window.addEventListener('task-platform:unauthorized', expired); return () => window.removeEventListener('task-platform:unauthorized', expired); }, [teacherToken, studentToken]);
  let screen = <Home onRole={setRole} />;
  if (role === 'teacher') screen = teacherToken ? <TeacherDashboard token={teacherToken} onExit={teacherExit} /> : <TeacherLogin onSuccess={setTeacherToken} onBack={() => setRole('')} />;
  if (role === 'student') screen = studentToken && studentState ? <StudentStudio token={studentToken} initialState={studentState} onExit={studentExit} /> : <StudentJoin onJoined={(token, state) => { setStudentToken(token); setStudentState(state); }} onBack={() => setRole('')} />;
  return <BrandProvider displayName={config.displayName}>{screen}</BrandProvider>;
}
