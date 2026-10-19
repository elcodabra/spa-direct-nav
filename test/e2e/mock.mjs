// End-to-end check of the request mocker in a real Chromium: fetch + XHR (handlers and
// listeners) + XHR subclasses are mocked, other paths hit the network, and an origin with no
// mocks keeps native fetch/XHR (regression: the old wrapper broke the Google Cloud console).
//   node test/e2e/mock.mjs
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import assert from 'node:assert/strict';
const ext = process.argv[2] || new URL('../..', import.meta.url).pathname;
const srv = http.createServer((q, s) => { if (q.url.startsWith('/api')) { s.end('{"real":true}'); return; } s.setHeader('content-type','text/html'); s.end('<div id="root"><p>app</p></div>'); }).listen(18950);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/spa-prof-'), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await sw.evaluate(() => chrome.storage.local.set({ 'spaDirectNav.mocks': [{ id: 1, site: 'http://127.0.0.1:18950', method: 'ANY', path: '/api/users', status: 201, body: '{"mock":1}', enabled: true }] }));
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:18950/');
await p.waitForTimeout(500);
const r = await p.evaluate(async () => {
  const f = await (await fetch('/api/users/1')).text();
  const f2 = await (await fetch('/api/other')).text();
  const x = await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/api/users'); let ev = []; x.onload = () => ev.push('onload'); x.addEventListener('load', () => ev.push('listener')); x.onloadend = () => res({ status: x.status, text: x.responseText, ready: x.readyState, ev }); x.send(); });
  class Sub extends XMLHttpRequest {}
  const sx = await new Promise((res) => { const x = new Sub(); x.open('GET', '/api/users'); x.onload = () => res({ sub: x instanceof Sub, status: x.status }); x.send(); });
  const real = await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/api/other'); x.onload = () => res(x.responseText); x.send(); });
  return { f, f2, x, sx, real };
});
console.log(JSON.stringify(r));
assert.equal(r.f, '{"mock":1}'); assert.equal(r.f2, '{"real":true}');
assert.equal(r.x.status, 201); assert.equal(r.x.text, '{"mock":1}'); assert.deepEqual(r.x.ev.sort(), ['listener', 'onload']);
assert.equal(r.sx.sub, true); assert.equal(r.sx.status, 201); assert.equal(r.real, '{"real":true}');
// a site with no mocks keeps native fetch/XHR
const p2 = await ctx.newPage(); await p2.goto('http://localhost:18950/'); await p2.waitForTimeout(400);
const nat = await p2.evaluate(() => [/native code/.test(String(fetch)), /native code/.test(String(XMLHttpRequest.prototype.send))]);
assert.deepEqual(nat, [true, true]);
console.log('mock checks passed; unmocked origin keeps native fetch/XHR');
await ctx.close(); srv.close();
