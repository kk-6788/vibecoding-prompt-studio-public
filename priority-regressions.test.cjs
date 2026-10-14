const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app() {
  const elements = {};
  const el = id => elements[id] ||= { value: '', innerHTML: '', textContent: '' };
  const sandbox = {
    document: { getElementById: el, body: { removeAttribute() {}, setAttribute() {} } },
    navigator: {}, alert() {}, localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1], sandbox);
  el('wpm').value = '250';
  el('duration').value = '8';
  return { sandbox, el };
}

for (const removed of [0, 1]) {
  test(`PRM-01: deleting character ${removed + 1} preserves surviving dialogue identities`, () => {
    const { sandbox: s, el } = app();
    s.addChar(); s.addChar();
    const ids = Array.from(s.chars, c => c.id);
    s.lines = ids.map((id, i) => ({ speakerId: id, emotion: '随口', text: `line-${i}` }));
    s.delChar(removed);
    ids.forEach((id, i) => assert.equal(s.lines[i].speakerId, i === removed ? null : id));
    const prompt = s.buildPrompt();
    assert.ok(prompt.includes(`（未选说话人）（随口）：『line-${removed}』`));
    s.chars.forEach(c => {
      const originalIndex = ids.indexOf(c.id);
      assert.ok(prompt.includes(`${c.name}（随口）：『line-${originalIndex}』`));
      assert.ok(el('lineList').innerHTML.includes(`value="${c.id}" selected`));
    });
    s.addChar();
    assert.equal(s.lines[removed].speakerId, null, 'adding must not reassign an orphaned line');
    assert.equal(new Set(Array.from(s.chars, c => c.id)).size, 3);
  });
}
test('PRM-01: initial, demo, clear, and add paths have stable unique IDs', () => {
  const { sandbox: s } = app();
  assert.ok(Number.isInteger(s.chars[0].id));
  s.loadDemo();
  s.lines.forEach((l, i) => assert.equal(l.speakerId, s.chars[i].id));
  s.addChar();
  assert.equal(new Set(Array.from(s.chars, c => c.id)).size, 3);
  s.clearAll(); s.addChar(); s.addLine();
  assert.equal(new Set(Array.from(s.chars, c => c.id)).size, 2);
  s.lines.forEach(l => assert.equal(l.speakerId, null));
});
for (const value of ['-100', '0', '', '99', '401', 'Infinity', 'NaN', '250x']) {
  test(`PRM-02: invalid speech rate ${JSON.stringify(value)} never gets a green timing result`, () => {
    const { sandbox: s, el } = app();
    s.lines[0].text = '一段用来测试语速的台词';
    el('wpm').value = value;
    s.render();
    assert.match(el('chkList').innerHTML, /语速须为 100–400/);
    assert.doesNotMatch(el('chkList').innerHTML, /语速合适/);
  });
}
for (const value of ['100', '250', '400']) {
  test(`PRM-02: valid speech rate ${value} computes timing`, () => {
    const { sandbox: s, el } = app();
    s.lines[0].text = '你好';
    el('wpm').value = value;
    s.render();
    assert.doesNotMatch(el('chkList').innerHTML, /语速须为/);
    assert.match(el('chkList').innerHTML, /语速合适/);
  });
}

function worker() {
  const handlers = {}, stored = new Map(), writes = [];
  let nextResponse;
  const cache = {
    async match(key) { return stored.get(typeof key === 'string' ? key : key.url)?.clone(); },
    async put(key, res) {
      writes.push([typeof key === 'string' ? key : key.url, res.status]);
      stored.set(typeof key === 'string' ? key : key.url, res);
    }
  };
  const sandbox = {
    self: { location: new URL('https://example.test/studio/sw.js'), addEventListener(type, cb) { handlers[type] = cb; } },
    URL,
    caches: { async open() { return cache; } },
    fetch() { return nextResponse instanceof Error ? Promise.reject(nextResponse) : Promise.resolve(nextResponse); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'), sandbox);
  return {
    stored, writes,
    async fetch(response, { mode = 'navigate', url = 'https://example.test/studio/' } = {}) {
      nextResponse = response;
      const pending = [];
      let responsePromise;
      handlers.fetch({ request: { method: 'GET', mode, url },
        respondWith(p) { responsePromise = p; }, waitUntil(p) { pending.push(p); } });
      assert.ok(pending.length > 0, 'cache work must extend worker lifetime synchronously');
      const result = await responsePromise;
      await Promise.all(pending);
      return result;
    }
  };
}
function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
for (const status of [404, 503]) {
  test(`PRM-03: HTTP ${status} followed by offline keeps last good home`, async () => {
    const w = worker();
    w.stored.set('./index.html', html('last good'));
    const failed = await w.fetch(html('server error', status));
    assert.equal(await failed.text(), 'last good');
    assert.equal(w.writes.length, 0);
    const offline = await w.fetch(new Error('offline'));
    assert.equal(await offline.text(), 'last good');
  });
}
test('PRM-03: valid home refresh persists through offline navigation', async () => {
  const w = worker();
  assert.equal(await (await w.fetch(html('new good'))).text(), 'new good');
  assert.deepEqual(w.writes, [['./index.html', 200]]);
  assert.equal(await (await w.fetch(new Error('offline'))).text(), 'new good');
});
test('PRM-03: wrong content type, non-home and redirected pages cannot replace home', async () => {
  const w = worker();
  w.stored.set('./index.html', html('last good'));
  await w.fetch(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await w.fetch(html('other'), { url: 'https://example.test/studio/other.html' });
  const redirect = html('login');
  Object.defineProperty(redirect, 'redirected', { value: true });
  await w.fetch(redirect);
  assert.equal(w.writes.length, 0);
  assert.equal(await (await w.fetch(new Error('offline'))).text(), 'last good');
});
test('PRM-03: no saved home returns original HTTP error and failed assets are not cached', async () => {
  const w = worker();
  assert.equal((await w.fetch(html('missing', 404))).status, 404);
  assert.equal((await w.fetch(new Response('missing', { status: 404 }), {
    mode: 'no-cors', url: 'https://example.test/studio/icon.png'
  })).status, 404);
  assert.equal(w.writes.length, 0);
});
