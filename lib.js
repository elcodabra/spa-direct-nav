/**
 * Shared helpers used by BOTH the background service worker (via importScripts)
 * and the content script (loaded before content.js in the same isolated world).
 *
 * Keeping the path-walking logic here ensures the popup-driven "smart" navigation
 * and the address-bar auto-fix agree on exactly which base they pick.
 *
 * Pure (no chrome.* / DOM references) so it can also be unit-tested under Node —
 * see the CommonJS export guard at the bottom.
 */

const SPA_DEBUG_KEY = "spaDirectNav.debug"; // storage.local flag gating console logs

/** True if the URL responds with a 2xx. Cookies are sent (auth-gated dev deploys). */
function spaIsServable(url) {
  return fetch(url, { method: "GET", redirect: "follow", credentials: "include", cache: "no-store" })
    .then((res) => res.ok)
    .catch(() => false);
}

/**
 * Walk up the path of `href`, probing each ancestor, and return the deepest URL
 * the server serves with a 2xx (or null if none respond).
 *
 * @param {string} href - the full deep URL to recover.
 * @param {object} [opts]
 * @param {boolean} [opts.includeFull=false] - also test the full URL first. The
 *   background popup flow wants this (the target may be directly servable); the
 *   content script does not (it only runs after the page already errored).
 * @param {(candidate: string, ok: boolean) => void} [opts.onProbe] - probe callback (logging).
 */
async function spaFindServableBase(href, opts) {
  const includeFull = !!(opts && opts.includeFull);
  const onProbe = (opts && opts.onProbe) || function () {};
  const u = new URL(href);
  const segs = u.pathname.split("/").filter(Boolean);

  const start = includeFull ? segs.length : segs.length - 1;
  for (let i = start; i >= 0; i--) {
    let candidate;
    if (i === segs.length) {
      candidate = u.origin + u.pathname + u.search; // full target — keep the query
    } else if (i === 0) {
      candidate = u.origin + "/";
    } else {
      candidate = u.origin + "/" + segs.slice(0, i).join("/") + "/";
    }

    const ok = await spaIsServable(candidate);
    onProbe(candidate, ok);
    if (ok) return i === segs.length ? u.href : candidate;
  }
  return null;
}

/** Same target ignoring hash (origin + pathname + search). */
function sameUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

/** Canonical form for comparing two URLs: origin + pathname + search (no hash). */
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname + x.search;
  } catch {
    return u;
  }
}

/** Human-readable path of a URL for status messages. */
function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash || "/";
  } catch {
    return url;
  }
}

const API_ROUTES_KEY = "spaDirectNav.apiRoutes"; // storage.local: array of {id, site, prefix, target, enabled}
const MOCKS_KEY = "spaDirectNav.mocks"; // storage.local: array of {id, site, method, path, status, body, contentType, delay, enabled}

/**
 * Find the first mock that matches a request, or null.
 *
 * A mock `{ site, method, path }` matches when the request's origin equals
 * `site` (when set), the method matches (`ANY`/empty = any), and the request
 * pathname equals `path` or sits underneath it (segment-aware prefix, so `/api`
 * matches `/api/users` but NOT `/apixyz`).
 *
 * Pure — shared by the unit tests and mirrored by the MAIN-world `mock.js`.
 *
 * @param {Array<object>} mocks
 * @param {string} url - the request URL.
 * @param {string} [method="GET"]
 */
function matchMock(mocks, url, method) {
  let pathname, origin;
  try {
    const u = new URL(url);
    pathname = u.pathname;
    origin = u.origin;
  } catch {
    return null;
  }
  const reqMethod = String(method || "GET").toUpperCase();

  for (const m of mocks || []) {
    if (!m || m.enabled === false) continue;
    if (m.site && m.site !== origin) continue;
    if (m.method && m.method !== "ANY" && m.method.toUpperCase() !== reqMethod) continue;

    const p = "/" + String(m.path || "").replace(/^\/+/, "");
    if (p === "/") continue; // an empty path would match the whole origin
    const base = p.endsWith("/") ? p.slice(0, -1) : p;
    if (pathname === base || pathname.startsWith(base + "/")) return m;
  }
  return null;
}

/** Escape a string for safe literal use inside a regular expression. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build declarativeNetRequest dynamic rules for the per-site API-routing feature.
 *
 * For each enabled route `{ site, prefix, target }` it emits TWO rules:
 *   1. redirect — `<site><prefix>/rest…`  →  `<target>/rest…`  (the prefix is
 *      stripped; query and the remaining path are preserved via a capture group).
 *   2. modifyHeaders — adds permissive `Access-Control-*` headers to the target's
 *      responses for requests the site initiated, so the now-cross-origin call
 *      isn't blocked by CORS.
 *
 * Pure (no `chrome.*`), so the regex/strip logic is unit-testable under Node.
 *
 * @param {Array<{site:string, prefix:string, target:string, enabled?:boolean}>} routes
 * @param {number} [startId=1] - first rule id to allocate (two ids consumed per route).
 * @returns {Array<object>} dynamic-rule objects ready for `updateDynamicRules`.
 */
function buildApiRoutingRules(routes, startId) {
  let id = startId || 1;
  const rules = [];
  const RESOURCE_TYPES = ["xmlhttprequest", "other", "websocket"];

  for (const r of routes || []) {
    if (!r || r.enabled === false) continue;

    let site, target;
    try {
      site = new URL(r.site);
      target = new URL(r.target);
    } catch {
      continue; // skip malformed entries instead of poisoning the whole rule set
    }

    const prefix = "/" + String(r.prefix || "").replace(/^\/+|\/+$/g, ""); // normalize to "/api"
    if (prefix === "/") continue; // an empty prefix would capture the whole origin

    const origin = site.origin; // e.g. https://app.example.com
    const targetBase = target.origin + target.pathname.replace(/\/+$/, ""); // drop trailing slash

    rules.push({
      id: id++,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: targetBase + "\\1" } },
      condition: {
        // ^<origin>/api(/rest…)?$  — group 1 is the remainder (path + query), or empty.
        regexFilter: "^" + escapeRegExp(origin) + escapeRegExp(prefix) + "(/.*)?$",
        resourceTypes: RESOURCE_TYPES,
      },
    });

    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "access-control-allow-origin", operation: "set", value: origin },
          { header: "access-control-allow-credentials", operation: "set", value: "true" },
          { header: "access-control-allow-methods", operation: "set", value: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
          { header: "access-control-allow-headers", operation: "set", value: "Content-Type, Authorization, X-Requested-With" },
        ],
      },
      condition: {
        requestDomains: [target.hostname],
        initiatorDomains: [site.hostname],
        resourceTypes: RESOURCE_TYPES,
      },
    });
  }
  return rules;
}

/* ---------- where the extension runs: blacklist / whitelist ---------- */

const SITE_MODE_KEY = "spaDirectNav.siteMode"; // "blacklist" (default): everywhere except; "whitelist": only on
const BLACKLIST_KEY = "spaDirectNav.blacklist"; // array of hosts, each also covers its subdomains
const WHITELIST_KEY = "spaDirectNav.whitelist";

// Everyday sites where the extension has nothing to fix and only adds risk (big apps that
// wrap XHR/fetch themselves, auth pages). Seeded once on install; editable in the popup.
const DEFAULT_BLACKLIST = [
  "google.com", "youtube.com", "gmail.com",
  "github.com", "gitlab.com", "atlassian.net", "linear.app", "notion.so", "figma.com",
  "slack.com", "telegram.org", "whatsapp.com",
  "chatgpt.com", "openai.com", "claude.ai", "anthropic.com",
  "vercel.com", "amplitude.com", "upstash.com",
  "yandex.ru", "ya.ru",
  "apple.com", "icloud.com", "microsoft.com", "live.com", "office.com",
  "paypal.com", "stripe.com",
];

/**
 * Turn what a user types ("https://App.Example.com:3000/x", "*.example.com", "example.com")
 * into a bare lowercase host, or null if it is not a usable host.
 */
function normalizeSiteEntry(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/[/?#].*$/, ""); // path, query, hash
  s = s.replace(/^.*@/, ""); // credentials
  s = s.replace(/:\d+$/, ""); // port (match patterns ignore ports)
  s = s.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9.-]+$/.test(s) || s.includes("..")) return null;
  if (s !== "localhost" && !s.includes(".")) return null;
  return s;
}

const isIpv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/** Chrome match patterns for a host and all its subdomains. */
function siteMatchPatterns(host) {
  const h = normalizeSiteEntry(host);
  if (!h) return [];
  const out = [`*://${h}/*`];
  if (h !== "localhost" && !isIpv4(h)) out.push(`*://*.${h}/*`);
  return out;
}

/** True if `hostname` is one of the list's hosts or a subdomain of one. */
function hostInSiteList(hostname, list) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return (list || []).some((entry) => {
    const e = normalizeSiteEntry(entry);
    return !!e && (h === e || h.endsWith("." + e));
  });
}

/** Does the extension run on this hostname under the given settings? */
function siteAllowed(hostname, cfg) {
  const mode = cfg && cfg.mode === "whitelist" ? "whitelist" : "blacklist";
  return mode === "whitelist"
    ? hostInSiteList(hostname, cfg.whitelist)
    : !hostInSiteList(hostname, cfg && cfg.blacklist);
}

/**
 * The content scripts as `chrome.scripting.registerContentScripts` entries, scoped by the
 * site lists: blacklist mode = all URLs minus excludeMatches; whitelist mode = only the
 * listed hosts (nothing at all when the whitelist is empty).
 */
function buildContentScriptRegistrations(cfg) {
  const mode = cfg && cfg.mode === "whitelist" ? "whitelist" : "blacklist";
  const patterns = (list) => [...new Set((list || []).flatMap(siteMatchPatterns))];
  let scope;
  if (mode === "whitelist") {
    const matches = patterns(cfg.whitelist);
    if (!matches.length) return [];
    scope = { matches };
  } else {
    const excludeMatches = patterns(cfg && cfg.blacklist);
    scope = excludeMatches.length ? { matches: ["<all_urls>"], excludeMatches } : { matches: ["<all_urls>"] };
  }
  const base = { allFrames: false, persistAcrossSessions: true, ...scope };
  return [
    { id: "spa-mock-main", js: ["mock.js"], runAt: "document_start", world: "MAIN", ...base },
    { id: "spa-mock-bridge", js: ["mock-bridge.js"], runAt: "document_start", ...base },
    { id: "spa-content", js: ["toast.js", "lib.js", "content.js"], runAt: "document_idle", ...base },
  ];
}

// Node-only export for unit tests; skipped in the browser/worker (module is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeSiteEntry,
    siteMatchPatterns,
    hostInSiteList,
    siteAllowed,
    buildContentScriptRegistrations,
    DEFAULT_BLACKLIST,
    SITE_MODE_KEY,
    BLACKLIST_KEY,
    WHITELIST_KEY,
    spaIsServable,
    spaFindServableBase,
    sameUrl,
    normalizeUrl,
    pathOf,
    escapeRegExp,
    buildApiRoutingRules,
    matchMock,
    SPA_DEBUG_KEY,
    API_ROUTES_KEY,
    MOCKS_KEY,
  };
}
