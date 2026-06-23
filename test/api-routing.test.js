"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApiRoutingRules, escapeRegExp } = require("../lib.js");

const ROUTE = { site: "https://app.example.com", prefix: "/api", target: "https://my-api.dev", enabled: true };

/** Apply a rule's regexFilter + regexSubstitution the way DNR would, to assert the rewrite. */
function applyRedirect(rule, url) {
  const re = new RegExp(rule.condition.regexFilter);
  const m = re.exec(url);
  if (!m) return null;
  return rule.action.redirect.regexSubstitution.replace(/\\(\d)/g, (_, n) => m[Number(n)] || "");
}

test("escapeRegExp escapes regex metacharacters", () => {
  assert.equal(escapeRegExp("a.b+c"), "a\\.b\\+c");
  assert.equal(escapeRegExp("https://x.test"), "https://x\\.test");
});

test("emits a redirect + a CORS rule per enabled route", () => {
  const rules = buildApiRoutingRules([ROUTE], 1);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].action.type, "redirect");
  assert.equal(rules[1].action.type, "modifyHeaders");
  assert.deepEqual(
    rules.map((r) => r.id),
    [1, 2]
  );
});

test("redirect strips the /api prefix and preserves the rest of the path", () => {
  const [redirect] = buildApiRoutingRules([ROUTE], 1);
  assert.equal(applyRedirect(redirect, "https://app.example.com/api/users"), "https://my-api.dev/users");
});

test("redirect preserves nested paths and query strings", () => {
  const [redirect] = buildApiRoutingRules([ROUTE], 1);
  assert.equal(
    applyRedirect(redirect, "https://app.example.com/api/v1/orders?status=open&page=2"),
    "https://my-api.dev/v1/orders?status=open&page=2"
  );
});

test("redirect handles the bare prefix with no trailing path", () => {
  const [redirect] = buildApiRoutingRules([ROUTE], 1);
  assert.equal(applyRedirect(redirect, "https://app.example.com/api"), "https://my-api.dev");
  assert.equal(applyRedirect(redirect, "https://app.example.com/api/"), "https://my-api.dev/");
});

test("redirect does NOT match a different prefix or a look-alike segment", () => {
  const [redirect] = buildApiRoutingRules([ROUTE], 1);
  assert.equal(applyRedirect(redirect, "https://app.example.com/apixyz"), null);
  assert.equal(applyRedirect(redirect, "https://app.example.com/v2/api"), null);
  assert.equal(applyRedirect(redirect, "https://other.example.com/api/users"), null);
});

test("redirect is scheme- and origin-specific (http vs https)", () => {
  const [redirect] = buildApiRoutingRules([ROUTE], 1);
  assert.equal(applyRedirect(redirect, "http://app.example.com/api/users"), null);
});

test("target base path is kept and the prefix swapped onto it", () => {
  const [redirect] = buildApiRoutingRules(
    [{ site: "https://app.example.com", prefix: "/api", target: "https://my-api.dev/v2/" }],
    1
  );
  assert.equal(applyRedirect(redirect, "https://app.example.com/api/users"), "https://my-api.dev/v2/users");
});

test("CORS rule echoes the exact site origin and matches target←site", () => {
  const [, cors] = buildApiRoutingRules([ROUTE], 1);
  assert.deepEqual(cors.condition.requestDomains, ["my-api.dev"]);
  assert.deepEqual(cors.condition.initiatorDomains, ["app.example.com"]);
  const acao = cors.action.responseHeaders.find((h) => h.header === "access-control-allow-origin");
  assert.equal(acao.value, "https://app.example.com");
  const creds = cors.action.responseHeaders.find((h) => h.header === "access-control-allow-credentials");
  assert.equal(creds.value, "true");
});

test("prefix is normalized (extra slashes trimmed)", () => {
  const [redirect] = buildApiRoutingRules([{ ...ROUTE, prefix: "api/" }], 1);
  assert.equal(applyRedirect(redirect, "https://app.example.com/api/users"), "https://my-api.dev/users");
});

test("disabled and malformed routes are skipped", () => {
  const rules = buildApiRoutingRules(
    [
      { ...ROUTE, enabled: false },
      { site: "not a url", prefix: "/api", target: "https://x.dev" },
      { site: "https://a.test", prefix: "/", target: "https://b.test" }, // empty prefix
    ],
    1
  );
  assert.equal(rules.length, 0);
});

test("ids are allocated sequentially across multiple routes from startId", () => {
  const rules = buildApiRoutingRules(
    [ROUTE, { site: "https://two.test", prefix: "/api", target: "https://api.two.test" }],
    10
  );
  assert.deepEqual(
    rules.map((r) => r.id),
    [10, 11, 12, 13]
  );
});
