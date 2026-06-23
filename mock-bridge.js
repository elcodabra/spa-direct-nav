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

  const MOCKS_KEY = "spaDirectNav.mocks";

  function push() {
    try {
      chrome.storage.local.get(MOCKS_KEY, (r) => {
        if (chrome.runtime.lastError) return;
        const all = r[MOCKS_KEY] || [];
        const origin = location.origin;
        const mine = all.filter((m) => m && m.enabled !== false && (!m.site || m.site === origin));
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
