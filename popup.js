const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "spaDirectNav.history";
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

  // Soft: push the route via the History API inside the page, then notify the SPA router.
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: softNavigate,
      args: [target],
    });
    if (result?.crossOrigin) {
      // Genuinely different host — pushState can't reach it, so fall back to a full load.
      chrome.tabs.update(currentTab.id, { url: target }, () =>
        onNavigated(
          target,
          `Cross-origin (page: ${result.pageOrigin} → target: ${result.targetOrigin}) — full load.`
        )
      );
    } else {
      onNavigated(target, "SPA route updated (soft).");
    }
  } catch (e) {
    setStatus("Could not inject into this page: " + e.message, "error");
  }
}

function onNavigated(target, msg) {
  saveHistory(target);
  setStatus(msg, "ok");
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
