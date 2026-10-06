/**
 * Client entry point (`exports["./client"]`), assembled into a
 * `window.__ModuleLoader__.load` registration by `scripts/build.mjs`.
 *
 * A bundle registers a factory; DSH materializes it lazily and reads `apply`
 * and `inject` straight off the module face. Those two are therefore the whole
 * export surface: the build writes them onto `module.exports` itself, because a
 * namespace level would leave the plugin loaded but inert. Every other name
 * here — the slot, the entry id, the style id, the mounter — is internal and
 * stays out of the face.
 *
 * The factory's only platform request is `react`: the shell seeds it as a
 * baseline specifier, so `dsh.client.external` stays empty and this bundle
 * needs nothing else from the module table.
 *
 * Contributions, all hung on the plugin's own fiber so unload removes them:
 *  - the stylesheet, appended to `document.head` and torn down with the plugin;
 *  - one entry in `conversation.input.right` — the right end of the composer's
 *    tool row, left of the send button, the seat the model selector also uses.
 *
 * `slots` is a declared injection, so the service is present by the time
 * `apply` runs. Reading it through `ctx.get` and returning early keeps the
 * plugin inert instead of throwing in a shell that never declared the seat.
 */

import * as React from 'react';
import { PLUGIN_NAME } from './endpoint.js';
import { STYLES } from './styles.js';
import { PromptOptView } from './view.js';

/** The seat this plugin occupies. */
const SLOT = 'conversation.input.right';

/** Stable contribution id, unique within the seat. */
const ENTRY_ID = 'prompt-opt';

/** Attribute marking the element as this plugin's, so teardown can find it again. */
const STYLE_ATTR = 'data-dsh-popt-css';

/** Services the client half needs before it is activated. */
export const inject = ['slots'];

/**
 * Append the stylesheet once and return its removal.
 *
 * Idempotent across a reload: the element carries a marker attribute, so a
 * second apply (or a hot swap that runs before the old fiber is disposed) reuses
 * the stylesheet already in the document instead of stacking a duplicate. The
 * disposer removes the element this call is responsible for, and tolerates a
 * document that no longer holds it.
 *
 * @returns {() => void} disposer removing the element this call owns.
 */
function mountStyles() {
  if (typeof document === 'undefined') return () => {};
  if (document.querySelector(`style[${STYLE_ATTR}]`)) return () => {};
  const element = document.createElement('style');
  element.setAttribute(STYLE_ATTR, '');
  element.setAttribute('data-plugin', PLUGIN_NAME);
  element.textContent = STYLES;
  document.head.appendChild(element);
  return () => {
    if (element.parentNode) element.parentNode.removeChild(element);
  };
}

/**
 * Register the sparkle entry and the panel it opens.
 *
 * @param ctx the client plugin context carrying the `slots` service.
 */
export function apply(ctx) {
  const slots = ctx.get('slots');
  if (slots === undefined) return;

  ctx.effect(() => mountStyles(), 'prompt-opt: stylesheet');
  ctx.effect(
    () => slots.inject(SLOT, () => slots.register(
      { name: SLOT, id: ENTRY_ID, order: 20, label: '优化提示词' },
      (props) => React.createElement(PromptOptView, props),
    )),
    'prompt-opt: composer entry',
  );
}
