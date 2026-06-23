/**
 * Background service worker.
 *
 * Handles "smart" navigation for cold deep-links: when the SPA server can't
 * serve a deep route on a fresh GET (returns 404), we walk up the path until we
 * find a URL the server DOES serve (the app shell), hard-load that, wait for the
 * app to mount, then soft-navigate (pushState) the rest of the way to the route.
 *
 * Lives in the service worker (not the popup) so the multi-step flow survives
 * the popup closing.
 */

importScripts("lib.js"); // spaFindServableBase / spaIsServable / sameUrl / pathOf / normalizeUrl

const NAV_TIMEOUT_MS = 20000; // safety cap on waiting for a tab to finish loading
const READY_TIMEOUT_MS = 8000; // max time to poll for the SPA router to mount
const READY_POLL_MS = 50; // how often to re-check readiness inside the page

// Logging is gated behind a storage flag (off by default) so we don't spam the
// console with browsed URLs in normal use. Toggle "Debug logging" in the popup.
let DEBUG = false;
chrome.storage.local.get(SPA_DEBUG_KEY, (r) => {
  DEBUG = r[SPA_DEBUG_KEY] === true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SPA_DEBUG_KEY]) DEBUG = changes[SPA_DEBUG_KEY].newValue === true;
});
const dlog = (...a) => {
  if (DEBUG) console.log("[SPA Direct Nav]", ...a);
};

// Records the last main-frame HTTP error per tab so the content script can ask
// "was my load an error?" and only then attempt deep-link recovery.
//
// State lives in chrome.storage.session (not an in-memory Map) so it survives the
// MV3 service worker being evicted between the errored load and the content
// script's document_idle query.
const errKey = (tabId) => `err_${tabId}`;

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.frameId !== 0) return; // top frame only (defensive; type already filters)
    if (details.statusCode >= 400) {
      dlog("main-frame", details.statusCode, details.url);
      chrome.storage.session.set({
        [errKey(details.tabId)]: { url: normalizeUrl(details.url), status: details.statusCode },
      });
    } else {
      chrome.storage.session.remove(errKey(details.tabId)); // a good load clears any stale error
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// Invalidate stale error state as soon as a new top-frame navigation starts.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) chrome.storage.session.remove(errKey(d.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(errKey(tabId)));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "smartNav") {
    smartNav(msg.tabId, msg.target)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === "checkError") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ error: false });
      return false;
    }
    const key = errKey(tabId);
    chrome.storage.session.get(key, (r) => {
      const err = r[key];
      const isError = !!err && err.url === normalizeUrl(msg.url);
      if (isError) chrome.storage.session.remove(key); // consume once
      sendResponse({ error: isError, status: err?.status });
    });
    return true; // async response
  }
});

async function smartNav(tabId, target) {
  dlog("smartNav target:", target, "tabId:", tabId);
  const targetPath = pathOf(target);
  const base = await spaFindServableBase(target, {
    includeFull: true, // the popup target may be directly servable
    onProbe: (c, ok) => dlog("probe", c, "->", ok ? "200" : "not ok"),
  });
  dlog("servable base:", base);

  if (!base) {
    // Nothing on this host responded — just try a plain full load.
    await navigateAndWait(tabId, target);
    notifyToast(tabId, "Loaded " + targetPath, targetPath);
    return { mode: "hard", base: target, message: "No reachable base found — full load." };
  }

  if (sameUrl(base, target)) {
    // Server serves the deep route directly (it has an SPA fallback). Hard load is fine.
    await navigateAndWait(tabId, target);
    notifyToast(tabId, "Loaded " + targetPath, targetPath);
    return { mode: "hard", base, message: "Server serves it directly — full load." };
  }

  // Found a shallower URL the server serves: load it, wait for the app to mount,
  // then route the rest of the way.
  await navigateAndWait(tabId, base);
  const { ready, waitedMs } = await softNavigateInTab(tabId, target);
  notifyToast(tabId, "Deep link recovered — routed to " + targetPath, targetPath);
  const note = ready ? `app ready in ${waitedMs}ms` : `router not detected after ${waitedMs}ms`;
  return {
    mode: "smart",
    base,
    message: `Loaded ${pathOf(base)} → soft-routed to ${pathOf(target)} (${note}).`,
  };
}

/**
 * Fire an in-page confirmation toast in the tab. Runs the call in the shared
 * isolated world where toast.js has already defined window.__spaToast; a missing
 * helper (e.g. a restricted page) is a silent no-op.
 */
function notifyToast(tabId, message, path) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (m, p) => window.__spaToast && window.__spaToast(m, { path: p }),
      args: [message, path || null],
    })
    .catch(() => {});
}

/** Update the tab and resolve once it reports `complete` (or times out). */
function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, NAV_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

/**
 * Inject a poll-until-ready routine: wait for the SPA router/app to mount, then
 * pushState + dispatch events. Returns { ready, waitedMs }. Runs in the page; the
 * returned promise is awaited by executeScript.
 */
async function softNavigateInTab(tabId, target) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageWaitThenSoftNavigate,
    args: [target, READY_TIMEOUT_MS, READY_POLL_MS],
  });
  return result || { ready: false, waitedMs: 0 };
}

/**
 * Page-context function (no external references — it is serialized and injected).
 * Polls for signs that a client-side router has mounted, then performs the
 * History API navigation so the router picks it up.
 */
function pageWaitThenSoftNavigate(full, timeoutMs, intervalMs) {
  const start = Date.now();

  function isReady() {
    // Strong signals: a framework has attached to the DOM.
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && hook.renderers && hook.renderers.size > 0) return true;
    } catch (_) {}
    try {
      if (typeof window.getAllAngularRootElements === "function" &&
          window.getAllAngularRootElements().length > 0) return true;
    } catch (_) {}

    const roots = ["#root", "#app", "#__next", "[data-reactroot]", "[ng-version]", "main", "body > div"];
    for (const sel of roots) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.__vue_app__ || el.__vue__) return true; // Vue 3 / Vue 2
      if (el.childElementCount > 0) return true; // app has rendered something
    }
    return false;
  }

  function navigate() {
    const url = new URL(full);
    history.pushState({}, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  return new Promise((resolve) => {
    (function poll() {
      const ready = isReady();
      if (ready || Date.now() - start >= timeoutMs) {
        navigate();
        resolve({ ready, waitedMs: Date.now() - start });
        return;
      }
      setTimeout(poll, intervalMs);
    })();
  });
}
