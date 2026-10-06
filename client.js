window.__ModuleLoader__.load({
	id: "dsh-demo-myplugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		// ── inlined from src\endpoint.js ──
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


		// ── inlined from src\styles.js ──
		const STYLES = [
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


		// ── inlined from src\view.js ──
		function SparkleIcon() {
			return React.createElement('svg', { className: 'dsh-popt-ic', width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
				React.createElement('path', { d: 'M10 4C10.8 7.2 12.8 9.2 16 10C12.8 10.8 10.8 12.8 10 16C9.2 12.8 7.2 10.8 4 10C7.2 9.2 9.2 7.2 10 4Z' }),
				React.createElement('path', { d: 'M17.8 3.6C18.3 5.4 19.2 6.3 21 6.8C19.2 7.3 18.3 8.2 17.8 10C17.3 8.2 16.4 7.3 14.6 6.8C16.4 6.3 17.3 5.4 17.8 3.6Z' }),
			);
		}

		function PromptOptView(props) {
			const [open, setOpen] = React.useState(false);
			const [loading, setLoading] = React.useState(false);
			const [result, setResult] = React.useState('');
			const [engine, setEngine] = React.useState('');
			const [error, setError] = React.useState('');
			const [mode, setMode] = React.useState('auto');
			const input = props.input || null;
			const busy = input ? input.phase !== 'plain' : false;
			const actions = props.inputActions;

			const run = (m) => {
				const text = input ? String(input.draft || '') : '';
				if (!text.trim()) {
					setResult(''); setEngine(''); setError('输入框为空,请先输入提示词再优化'); setMode(m); setOpen(true);
					return;
				}
				setMode(m); setLoading(true); setError(''); setOpen(true);
				fetch(OPTIMIZE_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(optimizeRequest(text, m)),
				}).then((r) => r.json()).then((res) => {
					setLoading(false);
					if (res && res.ok === true && typeof res.text === 'string' && res.text) {
						setResult(res.text); setEngine(res.engine === 'llm' ? '已由大模型润色' : '已由规则引擎重写');
					} else {
						setError((res && res.error) || '优化失败,请稍后重试');
					}
				}).catch((err) => {
					setLoading(false);
					setError(String((err && err.message) || err || '优化失败'));
				});
			};

			const replace = () => {
				if (!result || !actions || typeof actions.setDraft !== 'function') return;
				actions.setDraft(result);
				setOpen(false);
			};

			const panel = open ? React.createElement('div', { className: 'dsh-popt-panel' },
				React.createElement('div', { className: 'dsh-popt-head' },
					React.createElement('span', { className: 'dsh-popt-title' }, '提示词优化'),
					React.createElement('div', { className: 'dsh-popt-modes' },
						React.createElement('button', { className: 'dsh-popt-chip' + (mode === 'auto' ? ' active' : ''), onClick: () => run('auto') }, '智能优化'),
						React.createElement('button', { className: 'dsh-popt-chip' + (mode === 'rule' ? ' active' : ''), onClick: () => run('rule') }, '快速重写'),
					),
					React.createElement('button', { className: 'dsh-popt-close', title: '关闭', 'aria-label': '关闭', onClick: () => setOpen(false) }, '×'),
				),
				React.createElement('div', { className: 'dsh-popt-body' },
					loading
						? React.createElement('div', { className: 'dsh-popt-loading' }, React.createElement('span', { className: 'dsh-popt-spinner' }), '正在优化提示词…')
						: error
							? React.createElement('div', { className: 'dsh-popt-error' }, error)
							: React.createElement(React.Fragment, null,
								React.createElement('pre', { className: 'dsh-popt-result' }, result),
								React.createElement('div', { className: 'dsh-popt-engine' }, engine),
							),
				),
				React.createElement('div', { className: 'dsh-popt-foot' },
					React.createElement('button', { className: 'dsh-popt-btn dsh-popt-btn-ghost', onClick: () => setOpen(false) }, '取消'),
					result && !error && !loading ? React.createElement('button', { className: 'dsh-popt-btn dsh-popt-btn-primary', onClick: replace }, '替换原文') : null,
				),
			) : null;

			return React.createElement('div', { className: 'dsh-popt-wrap' },
				React.createElement('button', {
					className: 'dsh-popt-trigger',
					title: '优化提示词',
					'aria-label': '优化提示词',
					disabled: busy || loading,
					onClick: () => run(mode),
				}, loading ? React.createElement('span', { className: 'dsh-popt-spinner' }) : SparkleIcon()),
				panel,
			);
		}


		// ── inlined from src\client.js ──
		const SLOT = 'conversation.input.right';

		/** Stable contribution id, unique within the seat. */
		const ENTRY_ID = 'prompt-opt';

		/** Attribute marking the element as this plugin's, so teardown can find it again. */
		const STYLE_ATTR = 'data-dsh-popt-css';

		/** Services the client half needs before it is activated. */
		const inject = ['slots'];

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
		function apply(ctx) {
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


		Object.assign(module.exports, { "inject": inject, "apply": apply });
		exports.default = module.exports;

		return module.exports;
	},
});
