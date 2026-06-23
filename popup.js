const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "spaDirectNav.history";
const AUTO_ENABLED_KEY = "spaDirectNav.autoEnabled";
const AUTO_BLOCK_KEY = "spaDirectNav.autoBlocklist";
const DEBUG_KEY = "spaDirectNav.debug";
const API_ROUTES_KEY = "spaDirectNav.apiRoutes";
const MOCKS_KEY = "spaDirectNav.mocks";
const MAX_HISTORY = 12;

let currentTab = null;
let currentOrigin = null;

init();

async function init() {
  currentTab = await getActiveTab();
  if (currentTab?.url) {
    try {
      currentOrigin = new URL(currentTab.url).origin;
      $("origin").textContent = currentOrigin;
    } catch {
      $("origin").textContent = currentTab.url;
    }
  }
  await renderHistory();
  await initAutoToggle();
  await initApiRouting();
  await initMocks();
  initTabs();

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

/* ---------- tabs ---------- */

function initTabs() {
  const tabs = [
    { btn: $("tabNavBtn"), panel: $("tab-nav"), focus: () => $("target").focus() },
    { btn: $("tabRecentBtn"), panel: $("tab-recent"), focus: () => {} },
    { btn: $("tabApiBtn"), panel: $("tab-api"), focus: () => !$("apiPrefix").disabled && $("apiPrefix").focus() },
    { btn: $("tabMockBtn"), panel: $("tab-mock"), focus: () => !$("mockPath").disabled && $("mockPath").focus() },
  ];

  function select(name) {
    for (const t of tabs) {
      const on = t.btn.dataset.tab === name;
      t.btn.classList.toggle("active", on);
      t.btn.setAttribute("aria-selected", String(on));
      t.panel.hidden = !on;
      if (on) t.focus();
    }
  }

  for (const t of tabs) t.btn.addEventListener("click", () => select(t.btn.dataset.tab));
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
    const tabId = currentTab.id;
    chrome.tabs.update(tabId, { url: target }, () => {
      // The page reloads, so toast.js re-installs; fire once it finishes loading.
      const onDone = (id, info) => {
        if (id !== tabId || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(onDone);
        toastInTab(tabId, "Reloaded —", target);
      };
      chrome.tabs.onUpdated.addListener(onDone);
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
        toastInTab(currentTab.id, "Jumped to", target);
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

/** Path portion of a URL, for compact toast/status text. */
function shortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash || "/";
  } catch {
    return url;
  }
}

/**
 * Show an in-page confirmation toast in the given tab. Calls window.__spaToast,
 * which toast.js defines in the shared isolated world; no-ops if it's absent
 * (e.g. a restricted page) or injection isn't allowed.
 */
function toastInTab(tabId, label, target) {
  const path = shortPath(target);
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (m, p) => window.__spaToast && window.__spaToast(m, { path: p }),
      args: [label + " " + path, path],
    })
    .catch(() => {});
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

/* ---------- per-site API routing ---------- */

function getApiRoutes() {
  return new Promise((resolve) => {
    chrome.storage.local.get(API_ROUTES_KEY, (r) => resolve(r[API_ROUTES_KEY] || []));
  });
}

function setApiRoutes(routes) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [API_ROUTES_KEY]: routes }, resolve);
  });
}

async function initApiRouting() {
  $("apiSite").textContent = currentOrigin || "this site";

  const addBtn = $("apiAdd");
  const prefixEl = $("apiPrefix");
  const targetEl = $("apiTarget");

  // No usable origin (chrome:// etc.) → routing can't apply here.
  if (!currentOrigin || !/^https?:$/.test(new URL(currentOrigin).protocol)) {
    prefixEl.disabled = targetEl.disabled = addBtn.disabled = true;
  }

  addBtn.addEventListener("click", addApiRoute);
  targetEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addApiRoute();
  });

  await renderApiRoutes();
}

async function addApiRoute() {
  const prefix = $("apiPrefix").value.trim() || "/api";
  const targetRaw = $("apiTarget").value.trim();
  if (!currentOrigin) return setStatus("No site for routing here.", "error");
  if (!/^\//.test(prefix)) return setStatus("Path must start with “/”.", "error");

  let target;
  try {
    target = new URL(targetRaw);
    if (!/^https?:$/.test(target.protocol)) throw new Error();
  } catch {
    return setStatus("Enter a full target URL (https://…).", "error");
  }

  const routes = await getApiRoutes();
  const route = { id: Date.now(), site: currentOrigin, prefix, target: target.href, enabled: true };
  // Replace any existing rule with the same site + prefix.
  const next = routes.filter((r) => !(r.site === route.site && r.prefix === route.prefix));
  next.push(route);
  await setApiRoutes(next);

  $("apiTarget").value = "";
  $("apiPrefix").value = "";
  setStatus(`Routing ${shortPath(route.site + route.prefix)} → ${target.host}.`, "ok");
  await renderApiRoutes();
}

async function removeApiRoute(id) {
  const routes = await getApiRoutes();
  await setApiRoutes(routes.filter((r) => r.id !== id));
  await renderApiRoutes();
}

async function renderApiRoutes() {
  const routes = await getApiRoutes();
  const ul = $("apiList");
  ul.innerHTML = "";

  if (!routes.length) {
    const li = document.createElement("li");
    li.className = "api-empty";
    li.textContent = "No routes yet.";
    ul.appendChild(li);
    return;
  }

  // Current site first, then the rest, so the relevant rules are on top.
  const sorted = [...routes].sort((a, b) =>
    (a.site === currentOrigin ? 0 : 1) - (b.site === currentOrigin ? 0 : 1)
  );

  for (const r of sorted) {
    const li = document.createElement("li");
    li.className = "api-item" + (r.site === currentOrigin ? " here" : "");

    const text = document.createElement("span");
    text.className = "api-text";
    const fromHost = (() => {
      try {
        return new URL(r.site).host;
      } catch {
        return r.site;
      }
    })();
    const toHost = (() => {
      try {
        return new URL(r.target).host;
      } catch {
        return r.target;
      }
    })();
    text.textContent = `${fromHost}${r.prefix} → ${toHost}`;
    text.title = `${r.site}${r.prefix}  →  ${r.target}`;

    const del = document.createElement("button");
    del.className = "api-del";
    del.textContent = "✕";
    del.title = "Remove this route";
    del.addEventListener("click", () => removeApiRoute(r.id));

    li.appendChild(text);
    li.appendChild(del);
    ul.appendChild(li);
  }
}

/* ---------- mock API ---------- */

function getMocks() {
  return new Promise((resolve) => {
    chrome.storage.local.get(MOCKS_KEY, (r) => resolve(r[MOCKS_KEY] || []));
  });
}

function setMocks(mocks) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [MOCKS_KEY]: mocks }, resolve);
  });
}

async function initMocks() {
  $("mockSite").textContent = currentOrigin || "this site";

  const disabled = !currentOrigin || !/^https?:$/.test(new URL(currentOrigin).protocol);
  if (disabled) {
    $("mockPath").disabled = $("mockStatus").disabled = $("mockBody").disabled = $("mockMethod").disabled = $(
      "mockAdd"
    ).disabled = true;
  }

  $("mockAdd").addEventListener("click", addMock);
  await renderMocks();
}

async function addMock() {
  if (!currentOrigin) return setStatus("No site for mocking here.", "error");

  const path = $("mockPath").value.trim();
  if (!/^\//.test(path)) return setStatus("Path must start with “/”.", "error");

  const status = Number($("mockStatus").value) || 200;
  if (status < 100 || status > 599) return setStatus("Status must be 100–599.", "error");

  const body = $("mockBody").value;
  // Warn (don't block) if a JSON-looking body doesn't parse — text/plain mocks are fine too.
  let contentType = "application/json";
  if (body.trim() && !/^[\[{]/.test(body.trim())) contentType = "text/plain";

  const method = $("mockMethod").value || "ANY";
  const mocks = await getMocks();
  const mock = { id: Date.now(), site: currentOrigin, method, path, status, body, contentType, enabled: true };
  // Replace an existing mock for the same site + method + path.
  const next = mocks.filter((m) => !(m.site === mock.site && m.method === mock.method && m.path === mock.path));
  next.push(mock);
  await setMocks(next);

  $("mockPath").value = "";
  $("mockBody").value = "";
  $("mockStatus").value = "200";
  setStatus(`Mocking ${method} ${path} → ${status}.`, "ok");
  await renderMocks();
}

async function removeMock(id) {
  const mocks = await getMocks();
  await setMocks(mocks.filter((m) => m.id !== id));
  await renderMocks();
}

async function renderMocks() {
  const mocks = await getMocks();
  const ul = $("mockList");
  ul.innerHTML = "";

  if (!mocks.length) {
    const li = document.createElement("li");
    li.className = "api-empty";
    li.textContent = "No mocks yet.";
    ul.appendChild(li);
    return;
  }

  const sorted = [...mocks].sort((a, b) =>
    (a.site === currentOrigin ? 0 : 1) - (b.site === currentOrigin ? 0 : 1)
  );

  for (const m of sorted) {
    const li = document.createElement("li");
    li.className = "api-item" + (m.site === currentOrigin ? " here" : "");

    const text = document.createElement("span");
    text.className = "api-text";
    const host = (() => {
      try {
        return new URL(m.site).host;
      } catch {
        return m.site;
      }
    })();
    text.textContent = `${m.method} ${m.path} → ${m.status}`;
    text.title = `${m.method} ${host}${m.path}  →  ${m.status}\n${(m.body || "").slice(0, 300)}`;

    const del = document.createElement("button");
    del.className = "api-del";
    del.textContent = "✕";
    del.title = "Remove this mock";
    del.addEventListener("click", () => removeMock(m.id));

    li.appendChild(text);
    li.appendChild(del);
    ul.appendChild(li);
  }
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
