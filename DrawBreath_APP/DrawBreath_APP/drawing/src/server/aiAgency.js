const { runtimeModel } = require('./modelSettings');
const { normalizeDecision } = require('./canvasPolicy');

const DECISION_PROMPT_VERSION = 'canvas-agency-v3-en';
const DECISION_SYSTEM = `You are the AI scaffolding-timing decision maker in a children's open-ended drawing-continuation task. You only determine whether the current action should be STAY, OBSERVE, WITHDRAW, or CANCEL_WITHDRAWAL; you do not generate content for the student. Canvas, conversation, access, and timing data are interpretable reference evidence, not hard rules. Do not withdraw while the student is actively typing, reading, or waiting for a response. When there is no direct support need and credible independent progress is present, prefer making room promptly. Never interpret a single undo, erasure, or brief pause as evidence of the student's ability or psychological state. Return strict JSON only.`;

async function judge(ownerId, evidence, imageBuffer = null) {
  const promptInput = `Current evidence: ${JSON.stringify(evidence)}\nReturn: {"action":"STAY|OBSERVE|WITHDRAW|CANCEL_WITHDRAWAL","confidence":0.0,"decisionSummary":"no more than 160 characters","supportNeed":"LOW|MEDIUM|HIGH|UNCERTAIN","supportEpisodeStatus":"NOT_USED|UNRESOLVED|PARTIALLY_RESOLVED|RESOLVED","withdrawalType":"NONE|UNUSED_PRESENCE|POST_SUPPORT","evidenceForWithdrawal":[],"evidenceAgainstWithdrawal":[],"uncertainties":[],"nextReviewSeconds":3,"studentVisibleMessage":null}`;
  const fallback = normalizeDecision({
    action: 'OBSERVE', supportNeed: 'UNCERTAIN', supportEpisodeStatus: 'UNRESOLVED',
    withdrawalType: 'NONE', uncertainties: ['model-unavailable'], nextReviewSeconds: 8
  });
  let model;
  try {
    model = await runtimeModel(ownerId);
  } catch (error) {
    return {
      decision: fallback, raw: {}, promptInput, promptSystem: DECISION_SYSTEM,
      promptVersion: DECISION_PROMPT_VERSION, model: '',
      modelRoute: { source: 'unresolved', nodeId: '' }, modelInvoked: false,
      fallback: true, error: `model-configuration: ${String(error.message || error).slice(0, 900)}`
    };
  }
  const modelRoute = { source: model.source || 'environment', nodeId: model.nodeId || '', model: model.model || '' };
  if (!model.apiKey) {
    return {
      decision: fallback, raw: {}, promptInput, promptSystem: DECISION_SYSTEM,
      promptVersion: DECISION_PROMPT_VERSION, model: model.model || '', modelRoute,
      modelInvoked: false, fallback: true, error: 'model-unavailable'
    };
  }
  const request = async (includeImage) => {
    const content = includeImage
      ? [{ type: 'text', text: promptInput }, { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBuffer.toString('base64')}` } }]
      : promptInput;
    const response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${model.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: DECISION_SYSTEM }, { role: 'user', content }]
      })
    });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
    const payload = await response.json();
    const raw = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
    return raw;
  };
  try {
    let raw;
    try { raw = await request(Boolean(imageBuffer)); }
    catch (visualError) {
      if (!imageBuffer) throw visualError;
      raw = await request(false);
    }
    return { decision: normalizeDecision(raw), raw, promptInput, promptSystem: DECISION_SYSTEM,
      promptVersion: DECISION_PROMPT_VERSION, model: model.model, modelRoute,
      modelInvoked: true, fallback: false, error: '' };
  } catch (error) {
    return {
      decision: fallback, raw: {}, promptInput, promptSystem: DECISION_SYSTEM,
      promptVersion: DECISION_PROMPT_VERSION, model: model.model, modelRoute,
      modelInvoked: true, fallback: true, error: String(error.message || error).slice(0, 1000)
    };
  }
}

module.exports = { DECISION_SYSTEM, DECISION_PROMPT_VERSION, judge };
