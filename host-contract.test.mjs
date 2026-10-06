/**
 * Shape checks on the generated host half, and an end-to-end run of the route.
 *
 * The generated `lib/index.js` is one flat ESM module: the profile resolves it
 * as `exports["."]`, so these tests import it the way Node will and drive the
 * handler it registered with a fake request, a fake response and a fake model.
 * That is the only way to see the browser half's request answered without a
 * running harness — and it is what catches the two halves drifting apart.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAll } from '../scripts/build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = join(ROOT, 'lib', 'index.js');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** A POST request carrying `body`, as the web server hands it to a route. */
function fakeRequest(body, method = 'POST') {
  const request = new EventEmitter();
  request.method = method;
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', body);
    request.emit('end');
  });
  return request;
}

/** A response that records what the handler wrote. */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

/**
 * Run one request through the plugin's own route.
 *
 * `apply` is called with a context whose `webServer.register` captures the route
 * the plugin registers, so the request travels through the registration rather
 * than around it.
 */
async function request(plugin, body, { method = 'POST', services = {} } = {}) {
  const routes = [];
  const context = {
    logger: { warn: () => {} },
    get: (name) => services[name],
    timeout: (callback, ms) => setTimeout(callback, ms),
    effect: (setup) => {
      setup();
      return () => {};
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  };

  plugin.apply(context);
  assert.equal(routes.length, 1, 'apply must register exactly one route');
  const [route] = routes;

  const response = fakeResponse();
  const done = new Promise((settle) => {
    const end = response.end.bind(response);
    response.end = (value) => {
      end(value);
      settle();
    };
  });
  await route.handler(fakeRequest(body, method), response);
  await done;
  return { route, response };
}

function json(response) {
  return JSON.parse(response.body);
}

/** The `llm` service, streaming back `chunks`, as the real one does. */
function fakeLlm(chunks) {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** The `agentDefaultModel` service, with a model selected. */
function fakeDefaults(selection = { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }) {
  return { currentSelection: () => selection };
}

test('lib/index.js is exactly what src/ builds', () => {
  const artifacts = buildAll();
  const expected = artifacts.get(HOST);
  assert.ok(expected !== undefined, 'buildAll must produce lib/index.js');
  assert.equal(readFileSync(HOST, 'utf8'), expected, 'lib/index.js is out of date; run `npm run build`');
});

test('the host half prints nothing and asks for no platform module', () => {
  const source = readFileSync(HOST, 'utf8');
  assert.doesNotMatch(source, /from\s+["'](?!\.)/, 'the host half must import nothing but its own siblings');
  assert.doesNotMatch(source, /require\s*\(/, 'a `type: module` host half has no `require`');
  assert.doesNotMatch(source, /\breact\b/i, 'react belongs to the browser half only');
});

test('the manifest declares the bundle and the client half DSH reads', () => {
  assert.equal(MANIFEST.name, 'dsh-demo-myplugin');
  assert.equal(MANIFEST.main, 'lib/index.js');
  assert.equal(MANIFEST.exports['.'], './lib/index.js');
  assert.equal(MANIFEST.exports['./client'], './lib/client.js');
  assert.equal(MANIFEST.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(MANIFEST.dsh.client.platform, 'web');
  assert.deepEqual(MANIFEST.dsh.client.external, [], 'the bundle has no module-graph edges to declare');
  assert.equal(MANIFEST.private, undefined, 'a package meant to be published cannot be private');
});

test('the manifest ships the sources and keeps every dependency list empty', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(MANIFEST[field], undefined, `${field} must stay empty; this package installs nothing`);
  }
  for (const entry of ['lib/', 'src/', 'scripts/', 'tests/', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(MANIFEST.files.includes(entry), `files must ship ${entry}`);
  }
});

test('the entry point exports the face the profile reads', async () => {
  const plugin = await import(pathToFileURL(HOST).href);
  assert.equal(plugin.name, 'prompt-opt');
  assert.deepEqual(plugin.inject, ['webServer', 'timer']);
  assert.equal(typeof plugin.apply, 'function');
});

test('the route answers the request the browser half sends', async () => {
  const plugin = await import(pathToFileURL(HOST).href);
  // Nine characters, so the rule engine has something to wrap: a prompt of
  // eight or fewer is returned unchanged by design (src/rules.js).
  const { route, response } = await request(plugin, JSON.stringify({ text: '帮我写一个登录页面', mode: 'rule' }));

  assert.equal(route.kind, 'exact');
  assert.equal(route.path, '/api/prompt-opt/optimize');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json/);

  const answer = json(response);
  assert.equal(answer.ok, true);
  assert.equal(answer.engine, 'rule');
  assert.match(answer.text, /# 任务/, 'the rule engine wraps the prompt in the documented structure');
  assert.match(answer.text, /帮我写一个登录页面/);
});

test('a prompt too short to improve comes back untouched, not mangled', async () => {
  const plugin = await import(pathToFileURL(HOST).href);
  const { response } = await request(plugin, JSON.stringify({ text: '写个爬虫', mode: 'rule' }));

  assert.equal(response.status, 200);
  assert.deepEqual(json(response), { ok: true, text: '写个爬虫', engine: 'rule' });
});

test('a non-POST is refused, and an empty prompt is answered without work', async () => {
  const plugin = await import(pathToFileURL(HOST).href);

  const refused = await request(plugin, undefined, { method: 'GET' });
  assert.equal(refused.response.status, 405);
  assert.equal(json(refused.response).ok, false);

  const empty = await request(plugin, JSON.stringify({ text: '   ' }));
  assert.equal(empty.response.status, 200);
  assert.equal(json(empty.response).ok, false);
  assert.match(json(empty.response).error, /输入框/);
});

test('auto mode prefers the model, and falls back to the rules when it fails', async () => {
  const plugin = await import(pathToFileURL(HOST).href);

  const streamed = await request(
    plugin,
    JSON.stringify({ text: '写一个爬虫', mode: 'auto' }),
    {
      services: {
        llm: fakeLlm([{ type: 'text-delta', text: '```\n' }, { type: 'text-delta', text: '你是资深工程师' }, { type: 'finish' }]),
        agentDefaultModel: fakeDefaults(),
      },
    },
  );
  const polished = json(streamed.response);
  assert.equal(polished.engine, 'llm');
  assert.equal(polished.text, '你是资深工程师', 'fences and whitespace are stripped from the model output');

  const noModel = await request(plugin, JSON.stringify({ text: '写一个爬虫', mode: 'auto' }));
  const ruled = json(noModel.response);
  assert.equal(ruled.engine, 'rule', 'without a model the rule engine answers');
  assert.equal(ruled.ok, true);

  const broken = await request(
    plugin,
    JSON.stringify({ text: '写一个爬虫', mode: 'auto' }),
    {
      services: {
        llm: {
          async *stream() {
            throw new Error('provider exploded');
          },
        },
        agentDefaultModel: fakeDefaults(),
      },
    },
  );
  const fallen = json(broken.response);
  assert.equal(broken.response.status, 200);
  assert.equal(fallen.engine, 'rule', 'a rejected stream falls back instead of failing the request');
});

test('an oversized body is refused with 413 instead of buffered', async () => {
  const plugin = await import(pathToFileURL(HOST).href);

  // The cap is 64 KiB of buffered body; anything past it is refused mid-stream.
  const oversized = await request(plugin, 'x'.repeat(64 * 1024 + 1));
  assert.equal(oversized.response.status, 413);
  assert.equal(json(oversized.response).ok, false);
  assert.match(json(oversized.response).error, /过大/);
});
