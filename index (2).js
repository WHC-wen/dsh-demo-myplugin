/**
 * Host entry point (`exports["."]`).
 *
 * A re-export, nothing else: the profile resolves this file, and everything it
 * needs to see is on the module face. Keeping the entry this thin is what lets
 * `lib/index.js` be generated rather than hand-maintained.
 */

export { apply, name, inject } from './host.js';
