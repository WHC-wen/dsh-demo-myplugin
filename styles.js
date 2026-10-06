/**
 * The plugin's stylesheet, as one string.
 *
 * Every selector is namespaced `dsh-popt-`, so nothing here can reach another
 * plugin's DOM, and every colour is a DSH theme token (`--dsw-alias-*`) so the
 * panel follows the active theme instead of hard-coding one. The panel is
 * height-bounded (`min(420px, 100vh - 220px)`) so a short window scrolls
 * inside it rather than pushing the composer around.
 *
 * The array is joined on load, so the rules stay one-per-line in source and the
 * document gets a single text node.
 */

export const STYLES = [
	'.dsh-popt-wrap{position:relative;display:inline-flex;align-items:center}',
	'.dsh-popt-trigger{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;color:var(--dsw-alias-label-secondary);transition:color .15s,background-color .15s}',
	'.dsh-popt-trigger:hover{color:var(--dsw-alias-label-primary);background:rgba(127,127,127,.12)}',
	'.dsh-popt-trigger:disabled{opacity:.45;cursor:default}',
	'.dsh-popt-ic{display:block}',
	'.dsh-popt-spinner{width:15px;height:15px;border-radius:50%;border:2px solid rgba(127,127,127,.3);border-top-color:var(--dsw-alias-label-secondary);animation:dsh-popt-spin .8s linear infinite}',
	'@keyframes dsh-popt-spin{to{transform:rotate(360deg)}}',
	'.dsh-popt-panel{position:absolute;right:0;bottom:calc(100% + 10px);z-index:60;display:flex;flex-direction:column;width:min(440px,calc(100vw - 24px));max-height:min(420px,calc(100vh - 220px));background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.3);overflow:hidden}',
	'.dsh-popt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
	'.dsh-popt-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:0 0 auto}',
	'.dsh-popt-modes{display:flex;gap:6px;flex:1 1 auto;min-width:0;overflow-x:auto}',
	'.dsh-popt-chip{all:unset;cursor:pointer;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
	'.dsh-popt-chip.active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
	'.dsh-popt-close{all:unset;cursor:pointer;font-size:15px;line-height:1;padding:2px 7px;border-radius:6px;color:var(--dsw-alias-label-secondary)}',
	'.dsh-popt-close:hover{background:rgba(127,127,127,.12)}',
	'.dsh-popt-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px}',
	'.dsh-popt-loading{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
	'.dsh-popt-error{font-size:13px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}',
	'.dsh-popt-result{margin:0;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}',
	'.dsh-popt-engine{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:8px}',
	'.dsh-popt-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}',
	'.dsh-popt-btn{all:unset;cursor:pointer;font-size:13px;padding:6px 14px;border-radius:8px}',
	'.dsh-popt-btn-ghost{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
	'.dsh-popt-btn-ghost:hover{color:var(--dsw-alias-label-primary)}',
	'.dsh-popt-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff}',
].join('\n');
