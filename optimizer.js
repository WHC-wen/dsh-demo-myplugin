/**
 * The `智能优化` engine: rewrite the prompt with the session's own model.
 *
 * Every failure here is a fallback, never an error the user sees: a missing
 * `llm` or `agentDefaultModel` service, no selected model, a rejected stream,
 * and the {@link REWRITE_TIMEOUT_MS} guard all return '' (or throw, which the
 * route treats the same way) so the rule engine answers instead.
 *
 * The two services are read with `ctx.get` because both are optional: a
 * profile without a model configured still gets the rule engine.
 */

/** Hard ceiling on one polish request; past it the rule engine answers. */
export const REWRITE_TIMEOUT_MS = 45000;

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
export const SYSTEM_PROMPT = [
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

export async function llmRewrite(ctx, text) {
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
