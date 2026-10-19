/**
 * Isolated-world bridge for the request mocker.
 *
 * The mocker (`mock.js`) lives in the page's MAIN world and has no chrome.*
 * access, so it can't read the saved mocks itself. This script — a normal
 * isolated content script at `document_start` — reads the mocks for the current
 * origin from storage and hands them to the MAIN world via `postMessage`. It
 * re-pushes whenever the mock list changes, so edits in the popup take effect on
 * the next request without a reload.
 */
(function () {
  if (window.top !== window) return; // top frame only
  // Mocks are per http(s) origin. file://, data:, about: pages have an opaque origin ("null"),
  // where postMessage(…, location.origin) throws ('file://' is not a valid target).
  if (!/^https?:$/.test(location.protocol)) return;

  const MOCKS_KEY = "spaDirectNav.mocks";

  let sent = false;
  function push() {
    try {
      chrome.storage.local.get(MOCKS_KEY, (r) => {
        if (chrome.runtime.lastError) return;
        const all = r[MOCKS_KEY] || [];
        const origin = location.origin;
        const mine = all.filter((m) => m && m.enabled !== false && (!m.site || m.site === origin));
        // Nothing to mock and nothing sent before: stay silent, so mock.js never patches.
        if (!mine.length && !sent) return;
        sent = true;
        window.postMessage({ __spaMock: "config", mocks: mine }, location.origin);
      });
    } catch (_) {
      /* extension context torn down — ignore */
    }
  }

  push();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[MOCKS_KEY]) push();
  });
})();
