"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { spaFindServableBase, spaIsServable, sameUrl, normalizeUrl, pathOf } = require("../lib.js");

/** Replace global.fetch with a stub. `okFor` decides which URLs return 2xx. */
function mockFetch(okFor, probed) {
  global.fetch = async (url) => {
    if (probed) probed.push(url);
    return { ok: okFor(url) };
  };
}

test.afterEach(() => {
  delete global.fetch;
});

/* ----------------------------- sameUrl ----------------------------- */

test("sameUrl: ignores the hash", () => {
  assert.equal(sameUrl("https://x.test/a?q=1#top", "https://x.test/a?q=1#bottom"), true);
});

test("sameUrl: distinguishes pathname and query", () => {
  assert.equal(sameUrl("https://x.test/a", "https://x.test/b"), false);
  assert.equal(sameUrl("https://x.test/a?q=1", "https://x.test/a?q=2"), false);
});

test("sameUrl: distinguishes origin", () => {
  assert.equal(sameUrl("https://x.test/a", "https://y.test/a"), false);
  assert.equal(sameUrl("http://x.test/a", "https://x.test/a"), false);
});

test("sameUrl: invalid input falls back to string equality", () => {
  assert.equal(sameUrl("not a url", "not a url"), true);
  assert.equal(sameUrl("not a url", "other"), false);
});

/* --------------------------- normalizeUrl --------------------------- */

test("normalizeUrl: strips the hash, keeps origin+path+search", () => {
  assert.equal(normalizeUrl("https://x.test/a/b?q=1#frag"), "https://x.test/a/b?q=1");
});

test("normalizeUrl: invalid input returned unchanged", () => {
  assert.equal(normalizeUrl("garbage"), "garbage");
});

/* ------------------------------ pathOf ------------------------------ */

test("pathOf: returns path + search + hash", () => {
  assert.equal(pathOf("https://x.test/a/b?q=1#h"), "/a/b?q=1#h");
});

test("pathOf: root path", () => {
  assert.equal(pathOf("https://x.test/"), "/");
});

test("pathOf: invalid input returned unchanged", () => {
  assert.equal(pathOf("garbage"), "garbage");
});

/* ------------------------- spaIsServable --------------------------- */

test("spaIsServable: true on res.ok, false otherwise", async () => {
  mockFetch((u) => u.endsWith("/ok"));
  assert.equal(await spaIsServable("https://x.test/ok"), true);
  assert.equal(await spaIsServable("https://x.test/no"), false);
});

test("spaIsServable: false when fetch throws", async () => {
  global.fetch = async () => {
    throw new Error("network");
  };
  assert.equal(await spaIsServable("https://x.test/x"), false);
});

/* ----------------------- spaFindServableBase ----------------------- */

test("includeFull: returns the full href when the server serves it directly", async () => {
  mockFetch(() => true);
  const base = await spaFindServableBase("https://x.test/a/b/c", { includeFull: true });
  assert.equal(base, "https://x.test/a/b/c");
});

test("strips to the deepest servable ancestor when the deep route 404s", async () => {
  // Only /a/b/ (and shallower) are served.
  mockFetch((u) => u === "https://x.test/a/b/" || u === "https://x.test/a/" || u === "https://x.test/");
  const base = await spaFindServableBase("https://x.test/a/b/c", { includeFull: true });
  assert.equal(base, "https://x.test/a/b/");
});

test("falls back to origin root", async () => {
  mockFetch((u) => u === "https://x.test/");
  const base = await spaFindServableBase("https://x.test/a/b/c", { includeFull: true });
  assert.equal(base, "https://x.test/");
});

test("returns null when nothing responds", async () => {
  mockFetch(() => false);
  const base = await spaFindServableBase("https://x.test/a/b/c", { includeFull: true });
  assert.equal(base, null);
});

test("includeFull:false never probes the full deep URL", async () => {
  const probed = [];
  mockFetch(() => true, probed); // everything servable
  const base = await spaFindServableBase("https://x.test/a/b/c", { includeFull: false, probed });
  // First candidate tested is the parent, not the full path.
  assert.equal(probed.includes("https://x.test/a/b/c"), false);
  assert.equal(base, "https://x.test/a/b/");
});

test("keeps the query only on the full-URL probe", async () => {
  const probed = [];
  mockFetch(() => false, probed);
  await spaFindServableBase("https://x.test/a/b?q=1", { includeFull: true });
  assert.equal(probed[0], "https://x.test/a/b?q=1"); // full keeps query
  assert.equal(probed[1], "https://x.test/a/"); // ancestor drops it
});

test("onProbe is called for each candidate with its result", async () => {
  const calls = [];
  mockFetch((u) => u === "https://x.test/a/");
  const base = await spaFindServableBase("https://x.test/a/b", {
    includeFull: true,
    onProbe: (c, ok) => calls.push([c, ok]),
  });
  assert.equal(base, "https://x.test/a/");
  assert.deepEqual(calls, [
    ["https://x.test/a/b", false],
    ["https://x.test/a/", true],
  ]);
});
