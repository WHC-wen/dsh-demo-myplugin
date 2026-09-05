/**
 * Host half of the DSH prompt-optimizer plugin.
 *
 * This file is the validated source of the dynamic Cordis plugin `popt-1`
 * (当前运行于本机 DSH 的 popt-1/pkg-2)。它与客户端半区配对，
 * 通过 harness.handle('prompt-opt:optimize', ...) 提供优化能力。
 *
 * 注意：在 DSH 动态 Cordis 运行器里，`harness` 与 `console` 由宿主注入，
 * 作为全局变量使用（本文件无 import/require）。若改为打包安装，
 * 需自行注入对应的 `harness` 上下文。
 *
 * 优化策略：
 *  - mode='auto'（默认）：调用 ctx.get('llm').stream 用当前会话模型润色；
 *    失败或超时(45s)自动回退到内置规则引擎。
 *  - mode='rule'：直接走内置规则引擎，零 API 成本、瞬时响应。
 */

const SYSTEM_PROMPT = [
  'You are a prompt optimization engine. Take the user prompt and rewrite it so an LLM executes it more reliably.',
  'Output ONLY the optimized prompt text. No fences, no preamble, no explanation, no commentary.',
  'Rules: 1) Keep the original intent, language, terminology and tone; never add facts or requirements the user did not state.',
  '2) Improve clarity and structure: explicit goal, concise role only when the prompt has none, context/assumptions, explicit constraints, steps, and output format when helpful.',
  '3) Be concise; no generic boilerplate or chatty filler.',
  '4) If the prompt is already specific and well structured, only tighten wording and remove ambiguity.',
].join(' ');

/* ---------------- 语言检测 ---------------- */
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

/* ---------------- 规则引擎 ---------------- */
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

/* ---------------- 大模型润色 ---------------- */
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
    ctx.timeout(() => { if (!settled) reject(new Error('优化请求超时')); }, 45000);
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

/**
 * 组装宿主半区插件。加载到 DSH 动态 Cordis 运行器时：
 *   host: hostPlugin
 * 需要 ctx 提供 `timer`（ctx.timeout）与可选 `llm`、`agentDefaultModel`。
 */
export function hostPlugin() {
  return {
    inject: ['timer'],
    apply(ctx) {
      harness.handle('prompt-opt:optimize', async (args) => {
        const req = (args && typeof args === 'object') ? args : {};
        const text = typeof req.text === 'string' ? req.text : '';
        const mode = req.mode === 'rule' ? 'rule' : 'auto';
        const trimmed = text.trim();
        if (!trimmed) return { ok: false, error: '输入框为空,请先输入提示词' };
        if (mode === 'auto') {
          try {
            const out = await llmRewrite(ctx, trimmed);
            if (out) return { ok: true, text: out, engine: 'llm' };
          } catch (err) {
            console.error('[prompt-opt] LLM rewrite failed, falling back to rules:', String((err && err.message) || err));
          }
        }
        return { ok: true, text: optimizeRule(trimmed), engine: 'rule' };
      });
    },
  };
}
