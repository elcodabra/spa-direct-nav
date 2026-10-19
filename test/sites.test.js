"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSiteEntry,
  siteMatchPatterns,
  hostInSiteList,
  siteAllowed,
  buildContentScriptRegistrations,
  DEFAULT_BLACKLIST,
} = require("../lib.js");

test("normalizeSiteEntry: strips scheme, path, port, wildcard and case", () => {
  assert.equal(normalizeSiteEntry("https://App.Example.com:3000/x?y#z"), "app.example.com");
  assert.equal(normalizeSiteEntry("*.example.com"), "example.com");
  assert.equal(normalizeSiteEntry("  example.com/ "), "example.com");
  assert.equal(normalizeSiteEntry("localhost:5173"), "localhost");
  assert.equal(normalizeSiteEntry("127.0.0.1"), "127.0.0.1");
});

test("normalizeSiteEntry: rejects junk", () => {
  for (const bad of ["", "   ", "foo", "a..b", "ex ample.com", "<all_urls>", "*"]) {
    assert.equal(normalizeSiteEntry(bad), null, bad);
  }
});

test("hostInSiteList: exact host and subdomains, not look-alikes", () => {
  const list = ["google.com"];
  assert.equal(hostInSiteList("google.com", list), true);
  assert.equal(hostInSiteList("console.cloud.google.com", list), true);
  assert.equal(hostInSiteList("notgoogle.com", list), false);
  assert.equal(hostInSiteList("google.com.evil.io", list), false);
  assert.equal(hostInSiteList("", list), false);
});

test("siteAllowed: blacklist mode runs everywhere except listed hosts", () => {
  const cfg = { mode: "blacklist", blacklist: ["google.com"], whitelist: ["dev.local.test"] };
  assert.equal(siteAllowed("console.cloud.google.com", cfg), false);
  assert.equal(siteAllowed("wms.tools-dev.hbi.systems", cfg), true);
});

test("siteAllowed: whitelist mode runs only on listed hosts", () => {
  const cfg = { mode: "whitelist", blacklist: [], whitelist: ["hbi.systems"] };
  assert.equal(siteAllowed("wms.tools-dev.hbi.systems", cfg), true);
  assert.equal(siteAllowed("example.com", cfg), false);
  assert.equal(siteAllowed("example.com", { mode: "whitelist", whitelist: [] }), false);
});

test("siteMatchPatterns: host + subdomains; localhost and IPs without the wildcard", () => {
  assert.deepEqual(siteMatchPatterns("example.com"), ["*://example.com/*", "*://*.example.com/*"]);
  assert.deepEqual(siteMatchPatterns("localhost:3000"), ["*://localhost/*"]);
  assert.deepEqual(siteMatchPatterns("10.0.0.1"), ["*://10.0.0.1/*"]);
  assert.deepEqual(siteMatchPatterns("nope"), []);
});

test("registrations: blacklist mode = <all_urls> minus the blacklist, same scope for every script", () => {
  const regs = buildContentScriptRegistrations({ mode: "blacklist", blacklist: ["google.com", "bad entry"], whitelist: [] });
  assert.equal(regs.length, 3);
  for (const r of regs) {
    assert.deepEqual(r.matches, ["<all_urls>"]);
    assert.deepEqual(r.excludeMatches, ["*://google.com/*", "*://*.google.com/*"]);
    assert.equal(r.allFrames, false);
  }
  const main = regs.find((r) => r.id === "spa-mock-main");
  assert.equal(main.world, "MAIN");
  assert.equal(main.runAt, "document_start");
  assert.deepEqual(regs.find((r) => r.id === "spa-content").js, ["toast.js", "lib.js", "content.js"]);
});

test("registrations: empty blacklist has no excludeMatches key", () => {
  const regs = buildContentScriptRegistrations({ mode: "blacklist", blacklist: [] });
  assert.equal("excludeMatches" in regs[0], false);
});

test("registrations: whitelist mode matches only listed hosts; empty whitelist registers nothing", () => {
  const regs = buildContentScriptRegistrations({ mode: "whitelist", whitelist: ["hbi.systems", "localhost"] });
  assert.deepEqual(regs[0].matches, ["*://hbi.systems/*", "*://*.hbi.systems/*", "*://localhost/*"]);
  assert.equal(buildContentScriptRegistrations({ mode: "whitelist", whitelist: [] }).length, 0);
});

test("default blacklist: valid hosts, no duplicates, covers the Google Cloud console", () => {
  assert.ok(DEFAULT_BLACKLIST.length >= 10);
  assert.equal(new Set(DEFAULT_BLACKLIST).size, DEFAULT_BLACKLIST.length);
  for (const h of DEFAULT_BLACKLIST) assert.equal(normalizeSiteEntry(h), h, h);
  assert.equal(hostInSiteList("console.cloud.google.com", DEFAULT_BLACKLIST), true);
  assert.equal(hostInSiteList("localhost", DEFAULT_BLACKLIST), false);
});
