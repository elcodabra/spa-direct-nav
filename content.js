/**
 * Content script — address-bar deep-link recovery.
 *
 * Runs in the page (isolated world) on hosts the user has enabled. When the
 * server can't serve a deep SPA route on a cold load (404 shell, no app mounts),
 * this walks up the path to a URL the server DOES serve, redirects there, and
 * once that base mounts, soft-routes (pushState) back to the original deep URL.
 *
 * Note: content scripts can't read page JS globals (React/Vue internals), so
 * "mounted" is detected purely from the DOM — an app container that has rendered
 * children. fetch() here is same-origin, so auth cookies are sent normally.
 */
(function () {
  if (window.top !== window) return; // top frame only

  const HOSTS_KEY = "spaDirectNav.autoHosts";
  const PENDING_KEY = "spaDirectNav.pendingRoute";
  const MOUNT_TIMEOUT_FRESH = 4000; // wait this long for a fresh load to mount
  const MOUNT_TIMEOUT_AFTER_REDIRECT = 9000; // give the base page longer to boot
  const POLL_MS = 100;

  // App-specific containers only. Deliberately NOT `main`/`body > div`, which
  // generic 404/error pages also have (would cause false "mounted" positives).
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

  async function isServable(url) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Walk up the path (excluding the current full path) to the deepest ancestor
  // the server serves with a 2xx.
  async function findServableBase() {
    const u = new URL(location.href);
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) {
      const candidate =
        i === 0 ? u.origin + "/" : u.origin + "/" + segs.slice(0, i).join("/") + "/";
      if (await isServable(candidate)) return candidate;
    }
    return null;
  }

  function hostEnabled(hosts) {
    return hosts.some((h) =>
      h.startsWith("*.") ? location.hostname.endsWith(h.slice(1)) : location.hostname === h
    );
  }

  function getHosts() {
    return new Promise((resolve) => {
      chrome.storage.local.get([HOSTS_KEY], (r) => resolve(r[HOSTS_KEY] || []));
    });
  }

  (async function main() {
    const hosts = await getHosts();
    if (!hostEnabled(hosts)) return;

    const here = location.pathname + location.search + location.hash;

    // Returning from our own redirect: wait for the base app to mount, then
    // soft-route to the deep path we stashed before redirecting.
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_KEY);
      const ok = await waitForMount(MOUNT_TIMEOUT_AFTER_REDIRECT);
      if (ok && pending !== here) softRoute(pending);
      return;
    }

    // Fresh load. If the app mounts on its own, this wasn't a broken deep link.
    if (await waitForMount(MOUNT_TIMEOUT_FRESH)) return;

    // App never mounted → treat as a server 404 for a deep route and recover.
    if (here === "/") return; // nothing left to strip
    const base = await findServableBase();
    if (!base || new URL(base).pathname === location.pathname) return; // can't help

    sessionStorage.setItem(PENDING_KEY, here);
    location.replace(base);
  })();
})();
