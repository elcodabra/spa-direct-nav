"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchMock } = require("../lib.js");

const SITE = "https://app.example.com";
const mock = (over) => ({ id: 1, site: SITE, method: "ANY", path: "/api/users", status: 200, body: "{}", enabled: true, ...over });

test("matches an exact path on the same origin", () => {
  const m = mock();
  assert.equal(matchMock([m], SITE + "/api/users", "GET"), m);
});

test("matches subpaths (segment-aware prefix)", () => {
  const m = mock({ path: "/api" });
  assert.equal(matchMock([m], SITE + "/api/users/42?x=1", "GET"), m);
  assert.equal(matchMock([m], SITE + "/api", "GET"), m);
});

test("does NOT match a look-alike segment", () => {
  const m = mock({ path: "/api" });
  assert.equal(matchMock([m], SITE + "/apixyz", "GET"), null);
});

test("respects the origin", () => {
  const m = mock();
  assert.equal(matchMock([m], "https://other.example.com/api/users", "GET"), null);
  assert.equal(matchMock([m], "http://app.example.com/api/users", "GET"), null); // scheme differs
});

test("ANY method matches any verb; a specific method is enforced", () => {
  assert.ok(matchMock([mock({ method: "ANY" })], SITE + "/api/users", "DELETE"));
  assert.ok(matchMock([mock({ method: "POST" })], SITE + "/api/users", "post"));
  assert.equal(matchMock([mock({ method: "POST" })], SITE + "/api/users", "GET"), null);
});

test("method defaults to GET when not provided on the request", () => {
  assert.ok(matchMock([mock({ method: "GET" })], SITE + "/api/users"));
  assert.equal(matchMock([mock({ method: "POST" })], SITE + "/api/users"), null);
});

test("skips disabled mocks and returns the first enabled match", () => {
  const a = mock({ id: 1, enabled: false });
  const b = mock({ id: 2 });
  assert.equal(matchMock([a, b], SITE + "/api/users", "GET"), b);
});

test("a site-less mock matches any origin", () => {
  const m = mock({ site: undefined });
  assert.ok(matchMock([m], "https://anything.test/api/users", "GET"));
});

test("an empty path never matches the whole origin", () => {
  assert.equal(matchMock([mock({ path: "/" })], SITE + "/anything", "GET"), null);
  assert.equal(matchMock([mock({ path: "" })], SITE + "/anything", "GET"), null);
});

test("malformed request URLs return null", () => {
  assert.equal(matchMock([mock()], "not a url", "GET"), null);
});

test("trailing slash on the mock path is tolerated", () => {
  const m = mock({ path: "/api/users/" });
  assert.equal(matchMock([m], SITE + "/api/users", "GET"), m);
  assert.equal(matchMock([m], SITE + "/api/users/42", "GET"), m);
});
