/**
 * Content script — universal address-bar deep-link recovery.
 *
 * Runs on every site (unless globally disabled or the host is blocklisted), but
 * stays cheap: it only attempts recovery when the BACKGROUND confirms this page
 * load returned an HTTP error (4xx/5xx) for the main frame. That status signal is
 * what makes "all SPA sites" safe — normal pages and genuine 404s on non-SPA
 * sites are left alone.
 *
 * Recovery: walk up the path to a URL the server serves, verify it's actually an
 * SPA shell, redirect there, then soft-route (pushState) back to the deep URL.
 * fetch() here is same-origin, so auth cookies are sent normally.
 */
(function () {
  if (window.top !== window) return; // top frame only

  const ENABLED_KEY = "spaDirectNav.autoEnabled"; // default true
  const BLOCK_KEY = "spaDirectNav.autoBlocklist"; // array of host patterns
  const PENDING_KEY = "spaDirectNav.pendingRoute";
  const ATTEMPT_KEY = "spaDirectNav.recoverAttempted"; // loop guard (sessionStorage)
  const BASE_CACHE_KEY = "spaDirectNav.baseCache"; // memoized servable base path (per origin/tab)
  const MOUNT_TIMEOUT = 9000;
  const POLL_MS = 100;

  const APP_ROOTS = ["#root", "#app", "#__next", "[data-reactroot]", "[ng-version]"];

  function isMounted() {
    for (const sel of APP_ROOTS) {
      const el = document.querySelector(sel);
      if (el && el.childElementCount > 0) return true;
    }
    return false;
  }

  function waitForMount(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        if (isMounted()) return resolve(true);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(poll, POLL_MS);
      })();
    });
  }

  function softRoute(pathLike) {
    const url = new URL(pathLike, location.origin);
    history.pushState({}, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  // Fetch a candidate base and check that it looks like an SPA shell, so we never
  // hijack a normal multi-page site's 404 into a confusing redirect.
  async function looksLikeSpa(url) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", cache: "no-store" });
      if (!res.ok) return false;
      const html = await res.text();
      return (
        /<div[^>]+id=["'](root|app|__next)["']/i.test(html) ||
        /\sdata-reactroot/i.test(html) ||
        /\sng-version=/i.test(html)
      );
    } catch {
      return false;
    }
  }

  function hostBlocked(list) {
    return list.some((h) =>
      h.startsWith("*.") ? location.hostname.endsWith(h.slice(1)) : location.hostname === h
    );
  }

  function getConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([ENABLED_KEY, BLOCK_KEY, SPA_DEBUG_KEY], (r) =>
        resolve({
          enabled: r[ENABLED_KEY] !== false,
          blocked: r[BLOCK_KEY] || [],
          debug: r[SPA_DEBUG_KEY] === true,
        })
      );
    });
  }

  function wasErrorLoad() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "checkError", url: location.href }, (resp) => {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(Boolean(resp?.error));
        });
      } catch {
        resolve(false);
      }
    });
  }

  (async function main() {
    const { enabled, blocked, debug } = await getConfig();
    const log = debug ? (...a) => console.log("[SPA Direct Nav · content]", ...a) : () => {};
    log("injected on", location.href);
    if (!enabled) return log("disabled globally — skip");
    if (hostBlocked(blocked)) return log("host blocklisted — skip", location.hostname);

    const here = location.pathname + location.search + location.hash;

    // Half 2: we previously redirected to a base — soft-route to the stashed path.
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_KEY);
      log("returned from redirect — waiting for app to mount, then routing to", pending);
      const ok = await waitForMount(MOUNT_TIMEOUT);
      if (ok && pending !== here) {
        log("mounted — soft-routing to", pending);
        softRoute(pending);
        if (window.__spaToast) window.__spaToast("Deep link recovered — routed to " + pending, { path: pending });
        sessionStorage.removeItem(ATTEMPT_KEY); // success — reset the loop guard
      } else {
        log("not mounted in time (ok=" + ok + ") — clearing base cache, leaving page");
        sessionStorage.removeItem(BASE_CACHE_KEY); // the cached base may be stale — re-probe next time
      }
      return;
    }

    // Half 1.
    // Fast exit: a mounted app is never a broken deep link, so skip the background
    // round-trip entirely (the common case while browsing an SPA).
    if (here === "/" || isMounted()) return sessionStorage.removeItem(ATTEMPT_KEY);

    // Only act if this load was an actual HTTP error.
    const isError = await wasErrorLoad();
    if (!isError) {
      sessionStorage.removeItem(ATTEMPT_KEY); // a normal load resets the loop guard
      return log("load was not an HTTP error — nothing to do");
    }
    log("HTTP error load detected at", here, "— attempting recovery");

    // Loop guard: never redirect more than once per recovery chain. If the base we
    // picked also errors, bail instead of ricocheting between bases.
    if (sessionStorage.getItem(ATTEMPT_KEY)) {
      return log("already attempted a recovery redirect — bailing to avoid a loop");
    }

    // Cache hit: reuse a base discovered earlier this session for the same deploy,
    // skipping the probe walk and the SPA-shell fetch.
    let base = null;
    const cached = sessionStorage.getItem(BASE_CACHE_KEY);
    if (cached && here.startsWith(cached) && location.pathname !== cached) {
      base = location.origin + cached;
      log("base cache hit —", base);
    } else {
      base = await spaFindServableBase(location.href, {
        includeFull: false, // page already errored — no point retesting the full URL
        onProbe: (c, ok) => log("probe", c, "->", ok ? "200" : "not ok"),
      });
      log("servable base:", base);
      if (!base || new URL(base).pathname === location.pathname) return log("no usable base — give up");
      if (!(await looksLikeSpa(base))) return log("base is not an SPA shell — leave 404 as-is");
      sessionStorage.setItem(BASE_CACHE_KEY, new URL(base).pathname); // memoize for next time
    }

    log("stashing", here, "and redirecting to base", base);
    sessionStorage.setItem(ATTEMPT_KEY, "1");
    sessionStorage.setItem(PENDING_KEY, here);
    location.replace(base);
  })();
})();
