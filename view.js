/**
 * The React half: the sparkle entry and the panel it opens.
 *
 * The component is a pure function of the props the slot hands it — the live
 * draft (`props.input.draft`, `props.input.phase`) and the composer's
 * `inputActions` — and it reports progress through its own state. The one
 * write it performs on the composer is `inputActions.setDraft(result)`, the
 * atomic draft write, so replacing the text never interrupts the input stream.
 *
 * The request goes to the path and carries the shape `src/endpoint.js` defines,
 * which is the same module the host registers its route from — the browser and
 * the host cannot drift apart.
 */

import { OPTIMIZE_PATH, optimizeRequest } from './endpoint.js';

export function SparkleIcon() {
	return React.createElement('svg', { className: 'dsh-popt-ic', width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
		React.createElement('path', { d: 'M10 4C10.8 7.2 12.8 9.2 16 10C12.8 10.8 10.8 12.8 10 16C9.2 12.8 7.2 10.8 4 10C7.2 9.2 9.2 7.2 10 4Z' }),
		React.createElement('path', { d: 'M17.8 3.6C18.3 5.4 19.2 6.3 21 6.8C19.2 7.3 18.3 8.2 17.8 10C17.3 8.2 16.4 7.3 14.6 6.8C16.4 6.3 17.3 5.4 17.8 3.6Z' }),
	);
}

export function PromptOptView(props) {
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
