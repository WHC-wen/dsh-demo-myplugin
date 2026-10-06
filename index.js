// ── inlined from src/host.js ──

// ── inlined from src/endpoint.js ──

const PLUGIN_NAME = 'prompt-opt';

/** The optimizer endpoint. Absolute, no trailing slash: the web server's route contract. */
const OPTIMIZE_PATH = '/api/prompt-opt/optimize';

/** The two optimization engines a request may ask for. */
const MODE_AUTO = 'auto';
const MODE_RULE = 'rule';

/** `{ text, mode }` as the browser sends it; by construction what the host reads. */
function optimizeRequest(text, mode) {
  return { text: String(text), mode: mode === MODE_RULE ? MODE_RULE : MODE_AUTO };
}

// ── inlined from src/rules.js ──

function cjkCount(s) {
  const m = s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return m ? m.length : 0;
}
function letterCount(s) {
  const m = s.match(/[A-Za-z]/g);
  return m ? m.length : 0;
}
function isZh(text) {
  const c = cjkCount(text);
  const a = letterCount(text);
  return c > 0 && c >= Math.max(6, a * 0.25);
}

/* ---------------- Rule engine ---------------- */
function constraintSentences(text) {
  const re = /(必须|不得|不要|禁止|请勿|不能|不允许|确保|务必|按照|请用|使用.{0,10}格式|要有|must|should|ensure|never|always|without|in .{0,20} format)/i;
  const sents = text.match(/[^。！？!?\n]+[。！？!?]?/g) || [];
  const out = [];
  for (const s of sents) {
    const t = s.trim();
    if (t && re.test(t) && t.length > 3 && out.length < 3) out.push(t);
  }
  return out;
}

function isStructured(text) {
  return /(^|\n)#{1,6}\s/.test(text)
    || /(^|\n)\*\*[^*\n]{1,24}\*\*/.test(text)
    || /^(角色|任务|背景|要求|输出|限制|目标|Role|Task|Goal|Context|Output|Constraints)[:：]/im.test(text);
}

function ruleZh(core, body, cons) {
  const hasRole = /(你是一位?|你是|作为一名|扮演|你是专业的)/.test(core.slice(0, 120));
  const lines = [];
  if (!hasRole) {
    lines.push('你是一位资深 AI 助手,擅长拆解复杂任务并输出高质量、结构化的结果。', '');
  }
  lines.push('# 任务', core, '');
  lines.push('# 背景与已知条件', body || '围绕任务目标作答;若缺少关键上下文,先说明假设,再继续进行。', '');
  lines.push('# 执行要求');
  if (cons.length) {
    lines.push('原文的约束条件(必须遵守):');
    for (const c of cons) lines.push('- ' + c);
  } else {
    lines.push('- 先确认任务目标,确保理解与用户意图一致');
  }
  lines.push('- 对不确定的内容明确标注假设,不编造信息');
  lines.push('- 若任务较为复杂,分步骤推进,每一步给出结论');
  lines.push('');
  lines.push('# 输出格式');
  lines.push('- 使用清晰的 Markdown 结构(小标题、要点或表格)呈现');
  lines.push('- 直接给出结论与成果,避免与任务无关的铺垫');
  return lines.join('\n');
}

function ruleEn(core, body, cons) {
  const hasRole = /(you are (a|an|my)|act as|you're an)/i.test(core.slice(0, 120));
  const lines = [];
  if (!hasRole) {
    lines.push('You are an experienced AI assistant skilled at breaking down complex tasks and delivering high-quality, well-structured results.', '');
  }
  lines.push('# Task', core, '');
  lines.push('# Context', body || 'Work from the task above; if key context is missing, state your assumptions before continuing.', '');
  lines.push('# Requirements');
  if (cons.length) {
    lines.push('Constraints stated in the original prompt (follow them exactly):');
    for (const c of cons) lines.push('- ' + c);
  } else {
    lines.push('- Confirm the goal first so the result matches the user intent');
  }
  lines.push('- Mark assumptions for anything uncertain; never invent facts');
  lines.push('- For complex tasks, proceed step by step and conclude each step');
  lines.push('');
  lines.push('# Output');
  lines.push('- Present the answer with clear Markdown structure (headings, bullet points, tables when useful)');
  lines.push('- Lead with the conclusion; skip filler unrelated to the task');
  return lines.join('\n');
}

function optimizeRule(text) {
  const t = text.trim();
  if (t.length <= 8) return t;
  if (isStructured(t)) return t;
  const zh = isZh(t);
  const idx = t.indexOf('\n');
  const core = idx < 0 ? t : t.slice(0, idx).trim();
  const body = idx < 0 ? '' : t.slice(idx + 1).trim();
  const cons = constraintSentences(t);
  return zh ? ruleZh(core, body, cons) : ruleEn(core, body, cons);
}

// ── inlined from src/optimizer.js ──

const REWRITE_TIMEOUT_MS = 45000;

/**
 * The instruction the model is polished under.
 *
 * It is deliberately narrow: rewrite the prompt, keep every constraint the user
 * already stated, add only what the prompt is missing, and return the prompt
 * alone. A model that explains itself or answers the prompt would fill the
 * draft with text the user then has to delete — the panel shows the result for
 * review, and the only way to make that useful is to hand back a drop-in
 * replacement.
 */
const SYSTEM_PROMPT = [
  '你是一位提示词工程师。用户会给你一段待优化的提示词,请把它改写成更清晰、更完整、更易执行的版本。',
  '',
  '要求:',
  '1. 保留用户已经写明的全部约束、格式要求、术语与关键信息,不要删改其意图。',
  '2. 补齐缺失的角色设定、任务目标、上下文、输出格式与验收标准;信息确实不足时,写出合理的默认假设,不要反问。',
  '3. 结构清晰:必要时用「# 角色」「# 任务」「# 要求」「# 输出格式」等小节组织。',
  '4. 不要回答问题,不要解释你做了什么,不要输出任何前后缀说明。',
  '',
  '直接输出改写后的提示词正文本身,使用与原文相同的语言。',
].join('\n');

async function llmRewrite(ctx, text) {
  const llm = ctx.get('llm');
  const defaults = ctx.get('agentDefaultModel');
  if (!llm || !defaults) return '';
  const sel = defaults.currentSelection();
  if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string' || !sel.provider || !sel.model) return '';

  const options = {
    provider: sel.provider,
    model: sel.model,
    system: SYSTEM_PROMPT,
    messages: [{ id: 'prompt-opt-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    temperature: 0.3,
    maxTokens: 2048,
  };
  if (typeof sel.reasoningEffort === 'string' && sel.reasoningEffort) options.reasoningEffort = sel.reasoningEffort;

  let settled = false;
  const guard = new Promise((_, reject) => {
    ctx.timeout(() => { if (!settled) reject(new Error('优化请求超时')); }, REWRITE_TIMEOUT_MS);
  });

  async function consume() {
    let out = '';
    for await (const chunk of llm.stream(options)) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out += chunk.text;
        if (out.length > 12000) break;
      } else if (chunk && chunk.type === 'finish') {
        break;
      }
    }
    return out;
  }

  try {
    const out = await Promise.race([consume(), guard]);
    settled = true;
    const cleaned = (out || '').trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    return cleaned || '';
  } catch (err) {
    settled = true;
    throw err;
  }
}

const name = 'prompt-opt';

/** Services the host half needs before it is activated. */
const inject = ['webServer', 'timer'];

/**
 * Largest request body the route will buffer. A prompt is text typed by hand;
 * anything past this is not a prompt, and one request must not be able to make
 * the host allocate without bound.
 */
const MAX_REQUEST_BYTES = 64 * 1024;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache'
  });
  res.end(body);
}

/** POST handler: read body, run the optimizer, return JSON. */
function handleOptimize(ctx, req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  let body = '';
  let refused = false;
  req.on('data', (chunk) => {
    if (refused) return;
    body += chunk;
    if (body.length > MAX_REQUEST_BYTES) {
      refused = true;
      body = '';
      json(res, 413, { ok: false, error: '请求体过大' });
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (refused) return;
    let args = {};
    try { args = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
    const text = typeof args.text === 'string' ? args.text : '';
    const mode = args.mode === MODE_RULE ? MODE_RULE : MODE_AUTO;
    const trimmed = text.trim();
    if (!trimmed) { json(res, 200, { ok: false, error: '输入框为空,请先输入提示词' }); return; }
    if (mode === MODE_AUTO) {
      try {
        const out = await llmRewrite(ctx, trimmed);
        if (out) { json(res, 200, { ok: true, text: out, engine: 'llm' }); return; }
      } catch (err) {
        ctx.logger.warn('[prompt-opt] LLM rewrite failed, falling back to rules:', String((err && err.message) || err));
      }
    }
    json(res, 200, { ok: true, text: optimizeRule(trimmed), engine: 'rule' });
  });
}

/**
 * Plugin body: register the optimize route.
 * @param ctx - plugin context carrying webServer and timer.
 */
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPTIMIZE_PATH,
    handler: (req, res) => handleOptimize(ctx, req, res),
  }), 'prompt-opt: optimize route');
}

export { apply, name, inject };
