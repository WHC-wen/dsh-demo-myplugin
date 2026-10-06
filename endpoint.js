/**
 * The browser half and the host half of this plugin speak over one same-origin
 * route, so its shape lives in exactly one module and both halves import it.
 * The build inlines this module into the client bundle and copies it next to
 * the host half, which is why a changed path cannot drift between them.
 */

/** Stable Cordis plugin name — the host half's `name`, and the patch row's id. */
export const PLUGIN_NAME = 'prompt-opt';

/** The optimizer endpoint. Absolute, no trailing slash: the web server's route contract. */
export const OPTIMIZE_PATH = '/api/prompt-opt/optimize';

/** The two optimization engines a request may ask for. */
export const MODE_AUTO = 'auto';
export const MODE_RULE = 'rule';

/** `{ text, mode }` as the browser sends it; by construction what the host reads. */
export function optimizeRequest(text, mode) {
  return { text: String(text), mode: mode === MODE_RULE ? MODE_RULE : MODE_AUTO };
}
