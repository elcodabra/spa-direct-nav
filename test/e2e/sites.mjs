// End-to-end check of the site lists in a real Chromium with the unpacked extension:
// default blacklist seeded on install, blacklisted hosts get no injection at all, whitelist
// mode, and the popup's Sites tab. Needs playwright (npx playwright install chromium).
//   node test/e2e/sites.mjs
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import assert from 'node:assert/strict';
const ext = process.argv[2] || new URL('../..', import.meta.url).pathname;
const ok = (m) => console.log('  ok', m);
// one server, reachable as 127.0.0.1 (allowed) and localhost (we will list it)
const srv = http.createServer((q, s) => { if (q.url.startsWith('/api')) return s.end('{"real":true}'); s.setHeader('content-type', 'text/html'); s.end('<div id="root"><p>app</p></div>'); }).listen(18951);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/spa-prof-'), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
await new Promise(r => setTimeout(r, 800));
const st = await sw.evaluate(async () => ({ s: await chrome.storage.local.get(null), regs: await chrome.scripting.getRegisteredContentScripts() }));
assert.equal(st.s['spaDirectNav.siteMode'], 'blacklist');
assert.ok(st.s['spaDirectNav.blacklist'].includes('google.com'));
assert.equal(st.regs.length, 3); assert.ok(st.regs[0].excludeMatches.includes('*://*.google.com/*'));
ok(`fresh install: blacklist mode, ${st.s['spaDirectNav.blacklist'].length} default sites, 3 scripts registered with excludes`);

// detect injection by a mock on the page's origin: patched fetch returns the mock
const mocked = async (origin) => { const p = await ctx.newPage(); await p.goto(origin + '/'); await p.waitForTimeout(600);
  const t = await p.evaluate(async () => (await fetch('/api/x')).text()); await p.close(); return t.includes('mock'); };
await sw.evaluate(() => chrome.storage.local.set({ 'spaDirectNav.mocks': [
  { id: 1, site: 'http://127.0.0.1:18951', method: 'ANY', path: '/api', status: 200, body: '{"mock":1}', enabled: true },
  { id: 2, site: 'http://localhost:18951', method: 'ANY', path: '/api', status: 200, body: '{"mock":2}', enabled: true }] }));
assert.equal(await mocked('http://127.0.0.1:18951'), true);
assert.equal(await mocked('http://localhost:18951'), true);
ok('not blacklisted: scripts run (mocks answer) on 127.0.0.1 and localhost');

await sw.evaluate(async () => { const r = await chrome.storage.local.get('spaDirectNav.blacklist'); await chrome.storage.local.set({ 'spaDirectNav.blacklist': [...r['spaDirectNav.blacklist'], 'localhost'] }); });
await new Promise(r => setTimeout(r, 500));
assert.equal(await mocked('http://localhost:18951'), false);
assert.equal(await mocked('http://127.0.0.1:18951'), true);
ok('blacklisting localhost: no injection there (native fetch), other hosts unaffected');

await sw.evaluate(() => chrome.storage.local.set({ 'spaDirectNav.siteMode': 'whitelist', 'spaDirectNav.whitelist': ['localhost'] }));
await new Promise(r => setTimeout(r, 500));
assert.equal(await mocked('http://localhost:18951'), true);
assert.equal(await mocked('http://127.0.0.1:18951'), false);
ok('whitelist mode [localhost]: runs only on localhost');

await sw.evaluate(() => chrome.storage.local.set({ 'spaDirectNav.whitelist': [] }));
await new Promise(r => setTimeout(r, 500));
const regs0 = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
assert.equal(regs0.length, 0); assert.equal(await mocked('http://localhost:18951'), false);
ok('empty whitelist: nothing registered, runs nowhere');

// popup UI (opened as a page, active tab = the localhost page)
await sw.evaluate(() => chrome.storage.local.set({ 'spaDirectNav.siteMode': 'blacklist', 'spaDirectNav.blacklist': ['google.com'] }));
const site = await ctx.newPage(); await site.goto('http://localhost:18951/');
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 340, height: 600 });
await pop.goto(`chrome-extension://${extId}/popup.html`);
// popup reads the active tab of current window: bring site to front first then evaluate with tab override
await pop.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost:18951/*' }); currentTab = t; await renderSites(); });
await pop.click('#tabSitesBtn');
assert.match(await pop.textContent('#siteState'), /Active on localhost/);
await pop.click('#siteHere');
await pop.waitForTimeout(300);
let bl = await sw.evaluate(async () => (await chrome.storage.local.get('spaDirectNav.blacklist'))['spaDirectNav.blacklist']);
assert.deepEqual(bl, ['google.com', 'localhost']);
assert.match(await pop.textContent('#siteState'), /Off on localhost/);
ok('popup "Turn off on this site" adds the host and shows Off');
await pop.fill('#siteInput', 'https://Foo.Example.com:8080/x'); await pop.click('#siteAdd'); await pop.waitForTimeout(200);
await pop.fill('#siteInput', 'nonsense'); await pop.click('#siteAdd'); await pop.waitForTimeout(200);
assert.match(await pop.textContent('#status'), /Enter a host/);
bl = await sw.evaluate(async () => (await chrome.storage.local.get('spaDirectNav.blacklist'))['spaDirectNav.blacklist']);
assert.deepEqual(bl, ['google.com', 'localhost', 'foo.example.com']);
ok('popup add: URL normalized to host, junk rejected');
await pop.click('#siteReset'); await pop.waitForTimeout(200);
bl = await sw.evaluate(async () => (await chrome.storage.local.get('spaDirectNav.blacklist'))['spaDirectNav.blacklist']);
assert.ok(bl.includes('github.com') && bl.includes('foo.example.com'));
ok('"add defaults" merges defaults without dropping user entries');
const tabsW = await pop.evaluate(() => [document.querySelector('.tabs').scrollWidth, document.querySelector('.tabs').clientWidth]);
await pop.screenshot({ path: process.env.SHOT || 'docs/sites.png' });
console.log('  tabs width', tabsW);
// errors in popup?
await ctx.close(); srv.close();
console.log('e2e passed');
