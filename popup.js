const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "spaDirectNav.history";
const AUTO_ENABLED_KEY = "spaDirectNav.autoEnabled";
const AUTO_BLOCK_KEY = "spaDirectNav.autoBlocklist";
const DEBUG_KEY = "spaDirectNav.debug";
const MAX_HISTORY = 12;

let currentTab = null;

init();

async function init() {
  currentTab = await getActiveTab();
  if (currentTab?.url) {
    try {
      $("origin").textContent = new URL(currentTab.url).origin;
    } catch {
      $("origin").textContent = currentTab.url;
    }
  }
  await renderHistory();
  await initAutoToggle();

  $("go").addEventListener("click", navigate);
  $("useCurrent").addEventListener("click", fillCurrentPath);
  $("clear").addEventListener("click", clearHistory);
  $("target").addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigate();
  });
  $("target").focus();
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

function fillCurrentPath() {
  if (!currentTab?.url) return;
  try {
    const u = new URL(currentTab.url);
    $("target").value = u.pathname + u.search + u.hash;
    $("target").focus();
  } catch {
    /* ignore */
  }
}

/** Resolve user input (path or full URL) against the active tab's origin. */
function resolveTarget(input) {
  const value = input.trim();
  if (!value) throw new Error("Enter a path or URL.");
  const base = currentTab?.url;
  // `new URL` handles both absolute URLs and paths resolved against the base.
  return new URL(value, base).href;
}

async function navigate() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let target;
  try {
    target = resolveTarget($("target").value);
  } catch (e) {
    return setStatus(e.message, "error");
  }

  if (!currentTab?.id) return setStatus("No active tab.", "error");

  if (mode === "hard") {
    chrome.tabs.update(currentTab.id, { url: target }, () => {
      onNavigated(target, "Reloaded at target.");
    });
    return;
  }

  // Soft mode.
  // Fast path: already on the target host with the app live → just pushState in place.
  if (sameHostAsCurrent(target)) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: softNavigate,
        args: [target],
      });
      if (result && !result.crossOrigin && !result.notMounted) {
        return onNavigated(target, "SPA route updated (soft).");
      }
      // No live app here (404 shell) or origin drifted — fall through to smart pipeline.
    } catch (e) {
      // injection failed (e.g. a 404 shell) — fall through to the smart pipeline.
    }
  }

  // Cold path: server may 404 the deep route, so find a servable base, load it,
  // then soft-route the rest of the way. Handled in the background worker.
  setStatus("Finding a servable base…", "");
  chrome.runtime.sendMessage(
    { type: "smartNav", tabId: currentTab.id, target },
    (resp) => {
      if (chrome.runtime.lastError) {
        return setStatus(chrome.runtime.lastError.message, "error");
      }
      if (resp?.error) return setStatus(resp.error, "error");
      onNavigated(target, resp?.message || "Done.");
    }
  );
}

/** True when the active tab is already on the same host:port as the target. */
function sameHostAsCurrent(target) {
  try {
    const t = new URL(target);
    const c = new URL(currentTab.url);
    return t.hostname === c.hostname && t.port === c.port;
  } catch {
    return false;
  }
}

function onNavigated(target, msg) {
  saveHistory(target);
  setStatus(msg, "ok");
}

/* ---------- auto-recover controls (global + per-host disable) ---------- */

function getAutoConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTO_ENABLED_KEY, AUTO_BLOCK_KEY], (r) =>
      resolve({
        enabled: r[AUTO_ENABLED_KEY] !== false, // default ON
        blocked: r[AUTO_BLOCK_KEY] || [],
      })
    );
  });
}

async function initAutoToggle() {
  const allBox = $("autoAll");
  const blockBox = $("blockHost");

  let host = "";
  try {
    host = new URL(currentTab.url).hostname;
  } catch {
    /* non-web page */
  }
  $("autoHostName").textContent = host || "this host";

  const { enabled, blocked } = await getAutoConfig();
  allBox.checked = enabled;
  blockBox.checked = !!host && blocked.includes(host);
  blockBox.disabled = !host || !enabled;

  allBox.addEventListener("change", () => {
    chrome.storage.local.set({ [AUTO_ENABLED_KEY]: allBox.checked }, () => {
      blockBox.disabled = !host || !allBox.checked;
      setStatus(
        allBox.checked ? "Auto-fix enabled on all sites." : "Auto-fix turned off.",
        "ok"
      );
    });
  });

  blockBox.addEventListener("change", async () => {
    if (!host) return;
    const { blocked: current } = await getAutoConfig();
    const next = blockBox.checked
      ? [...new Set([...current, host])]
      : current.filter((h) => h !== host);
    chrome.storage.local.set({ [AUTO_BLOCK_KEY]: next }, () => {
      setStatus(
        blockBox.checked ? `Auto-fix disabled on ${host}.` : `Auto-fix re-enabled on ${host}.`,
        "ok"
      );
    });
  });

  const debugBox = $("debugLog");
  chrome.storage.local.get(DEBUG_KEY, (r) => {
    debugBox.checked = r[DEBUG_KEY] === true;
  });
  debugBox.addEventListener("change", () => {
    chrome.storage.local.set({ [DEBUG_KEY]: debugBox.checked }, () => {
      setStatus(debugBox.checked ? "Debug logging on." : "Debug logging off.", "ok");
    });
  });
}

/**
 * Runs in the page context. Uses pushState + a popstate event so common SPA
 * routers (React Router, Vue Router, Angular) pick up the change without a reload.
 */
function softNavigate(target) {
  const url = new URL(target);

  // Compare by HOST only (ignore protocol/default-port noise) so a pasted full
  // URL behaves exactly like its path when it points at the page you're on.
  // dev/preview deploys frequently can't serve deep links on a cold GET, so we
  // must keep same-host navigations on the soft (pushState) path.
  const sameHost = url.hostname === location.hostname && url.port === location.port;
  if (!sameHost) {
    return { crossOrigin: true, pageOrigin: location.origin, targetOrigin: url.origin };
  }

  // Only treat this as a live SPA if something is actually mounted. Otherwise we
  // might be sitting on a 404 / error shell on the same host, where pushState does
  // nothing useful — signal the caller to use the smart (reload-a-base) pipeline.
  const mounted = ["#root", "#app", "#__next", "[data-reactroot]", "[ng-version]", "main", "body > div"]
    .some((sel) => {
      const el = document.querySelector(sel);
      return el && (el.__vue_app__ || el.__vue__ || el.childElementCount > 0);
    });
  if (!mounted) {
    return { crossOrigin: false, notMounted: true, pageOrigin: location.origin };
  }

  // Always navigate within the current origin, even if the typed protocol differed.
  history.pushState({}, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  // Some routers also listen for hashchange.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  return { crossOrigin: false, pageOrigin: location.origin, targetOrigin: url.origin };
}

/* ---------- recent history ---------- */

async function getHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get([HISTORY_KEY], (r) => resolve(r[HISTORY_KEY] || []));
  });
}

async function saveHistory(url) {
  const list = await getHistory();
  const next = [url, ...list.filter((u) => u !== url)].slice(0, MAX_HISTORY);
  chrome.storage.local.set({ [HISTORY_KEY]: next }, renderHistory);
}

async function clearHistory() {
  chrome.storage.local.set({ [HISTORY_KEY]: [] }, renderHistory);
}

async function renderHistory() {
  const list = await getHistory();
  const ul = $("history");
  ul.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.textContent = "No recent navigations.";
    li.style.color = "var(--muted)";
    li.style.cursor = "default";
    ul.appendChild(li);
    return;
  }
  for (const url of list) {
    const li = document.createElement("li");
    let label = url;
    try {
      const u = new URL(url);
      label = u.pathname + u.search + u.hash;
    } catch {
      /* keep raw */
    }
    li.textContent = label;
    li.title = url;
    li.addEventListener("click", () => {
      $("target").value = url;
      navigate();
    });
    ul.appendChild(li);
  }
}

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
