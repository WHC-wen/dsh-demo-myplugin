/**
 * The built-in rule engine: pure functions, no I/O, no services.
 *
 * `optimizeRule` is the whole fallback story — when the model is unreachable,
 * misconfigured, or slower than the timeout, this is what still improves the
 * prompt. It is also the `快速重写` mode, which is why it must stay cheap and
 * synchronous.
 *
 * Contract, in the order the checks run:
 *  - a prompt of 8 characters or fewer is returned unchanged (nothing to add);
 *  - a prompt that is already structured (headings, bold lede, labelled
 *    sections) is returned unchanged rather than re-wrapped;
 *  - otherwise the language is detected and the prompt is rewritten with a
 *    role, an explicit task, context, the constraints lifted from the original,
 *    and an output format.
 */

/* ---------------- Language detection ---------------- */
export function cjkCount(s) {
  const m = s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return m ? m.length : 0;
}
export function letterCount(s) {
  const m = s.match(/[A-Za-z]/g);
  return m ? m.length : 0;
}
export function isZh(text) {
  const c = cjkCount(text);
  const a = letterCount(text);
  return c > 0 && c >= Math.max(6, a * 0.25);
}

/* ---------------- Rule engine ---------------- */
export function constraintSentences(text) {
  const re = /(必须|不得|不要|禁止|请勿|不能|不允许|确保|务必|按照|请用|使用.{0,10}格式|要有|must|should|ensure|never|always|without|in .{0,20} format)/i;
  const sents = text.match(/[^。！？!?\n]+[。！？!?]?/g) || [];
  const out = [];
  for (const s of sents) {
    const t = s.trim();
    if (t && re.test(t) && t.length > 3 && out.length < 3) out.push(t);
  }
  return out;
}

export function isStructured(text) {
  return /(^|\n)#{1,6}\s/.test(text)
    || /(^|\n)\*\*[^*\n]{1,24}\*\*/.test(text)
    || /^(角色|任务|背景|要求|输出|限制|目标|Role|Task|Goal|Context|Output|Constraints)[:：]/im.test(text);
}

export function ruleZh(core, body, cons) {
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

export function ruleEn(core, body, cons) {
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

export function optimizeRule(text) {
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
