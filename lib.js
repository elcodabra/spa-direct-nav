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

// Node-only export for unit tests; skipped in the browser/worker (module is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { spaIsServable, spaFindServableBase, sameUrl, normalizeUrl, pathOf, SPA_DEBUG_KEY };
}
