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

const ROUTER_BOOT_MS = 700; // grace period after page load for the SPA router to mount
const NAV_TIMEOUT_MS = 20000; // safety cap on waiting for a tab to finish loading

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "smartNav") {
    smartNav(msg.tabId, msg.target)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // keep the message channel open for the async response
  }
});

async function smartNav(tabId, target) {
  const base = await findServableBase(target);

  if (!base) {
    // Nothing on this host responded — just try a plain full load.
    await navigateAndWait(tabId, target);
    return { mode: "hard", base: target, message: "No reachable base found — full load." };
  }

  if (sameUrl(base, target)) {
    // Server serves the deep route directly (it has an SPA fallback). Hard load is fine.
    await navigateAndWait(tabId, target);
    return { mode: "hard", base, message: "Server serves it directly — full load." };
  }

  // Found a shallower URL the server serves: load it, let the app boot, then route.
  await navigateAndWait(tabId, base);
  await delay(ROUTER_BOOT_MS);
  await softNavigateInTab(tabId, target);
  return {
    mode: "smart",
    base,
    message: `Loaded ${pathOf(base)} → soft-routed to ${pathOf(target)}.`,
  };
}

/**
 * Strip path segments from the end of `target` until the server returns a
 * success status. Returns the deepest servable URL, or null if none respond.
 */
async function findServableBase(target) {
  const u = new URL(target);
  const segs = u.pathname.split("/").filter(Boolean);

  for (let i = segs.length; i >= 0; i--) {
    let candidate;
    if (i === segs.length) {
      // Full target — keep the query so we test exactly what was asked for.
      candidate = u.origin + u.pathname + u.search;
    } else if (i === 0) {
      candidate = u.origin + "/";
    } else {
      candidate = u.origin + "/" + segs.slice(0, i).join("/") + "/";
    }

    if (await isServable(candidate)) {
      return i === segs.length ? target : candidate;
    }
  }
  return null;
}

/** True if the URL responds with a 2xx (cookies included, for auth-gated dev deploys). */
async function isServable(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "include",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
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

/** Inject the pushState + event dispatch into the page so its router reacts. */
async function softNavigateInTab(tabId, target) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (full) => {
      const url = new URL(full);
      history.pushState({}, "", url.pathname + url.search + url.hash);
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    },
    args: [target],
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sameUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash || "/";
  } catch {
    return url;
  }
}
