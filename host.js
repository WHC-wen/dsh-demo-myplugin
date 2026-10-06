/**
 * The host half: one same-origin route that optimizes a prompt.
 *
 *   POST /api/prompt-opt/optimize   { text, mode } -> { ok, text, engine }
 *
 * The browser half calls it with `fetch`, which is the whole reason the host
 * half exists — the rule engine and the model live in the `dsh` process, not in
 * the page. `webServer` and `timer` are declared hard injections: the route
 * cannot be registered without a server, and the polish needs a timer for its
 * timeout guard. The route's disposer is returned from `ctx.effect`, so
 * unloading the plugin removes it.
 *
 * The optimizer's two services (`llm`, `agentDefaultModel`) are read with
 * `ctx.get` because both are optional: a profile without a model configured
 * still gets the rule engine, and the route still answers.
 */

import { MODE_AUTO, MODE_RULE, OPTIMIZE_PATH } from './endpoint.js';
import { optimizeRule } from './rules.js';
import { llmRewrite } from './optimizer.js';

/** Stable Cordis plugin name — the host half's face, and the patch row's id. */
export const name = 'prompt-opt';

/** Services the host half needs before it is activated. */
export const inject = ['webServer', 'timer'];

/**
 * Largest request body the route will buffer. A prompt is text typed by hand;
 * anything past this is not a prompt, and one request must not be able to make
 * the host allocate without bound.
 */
export const MAX_REQUEST_BYTES = 64 * 1024;

export function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache'
  });
  res.end(body);
}

/** POST handler: read body, run the optimizer, return JSON. */
export function handleOptimize(ctx, req, res) {
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
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPTIMIZE_PATH,
    handler: (req, res) => handleOptimize(ctx, req, res),
  }), 'prompt-opt: optimize route');
}
