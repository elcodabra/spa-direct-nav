/**
 * In-page toast shown whenever SPA Direct Nav performs — or recovers — a
 * navigation, so the user gets visible confirmation that the extension acted.
 *
 * Loaded as a content script on every top frame, it exposes `window.__spaToast`
 * in the extension's isolated world. Because content scripts and default-world
 * `chrome.scripting.executeScript` injections share that world, the popup and the
 * background worker can trigger a toast with a one-liner:
 *
 *     chrome.scripting.executeScript({ target: { tabId },
 *       func: (m) => window.__spaToast && window.__spaToast(m), args: [message] });
 *
 * The UI lives in a Shadow DOM so the host page's CSS can never touch it.
 */
(function () {
  if (window.top !== window) return; // top frame only
  if (window.__spaToast) return; // already installed on this page

  let shadow = null;
  let wrap = null;
  let hideTimer = null;

  function ensureHost() {
    if (wrap && document.documentElement.contains(wrap.getRootNode().host)) return;

    const host = document.createElement("div");
    host.id = "spa-direct-nav-toast-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;inset:auto 0 0 0;pointer-events:none;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .wrap{position:fixed;left:50%;bottom:24px;
              transform:translateX(-50%) translateY(12px);
              display:flex;align-items:center;gap:10px;max-width:90vw;
              background:#1d2a22;border:1px solid #2f5a3f;color:#6fcf97;
              font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
              padding:10px 15px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.4);
              opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:auto;}
        .wrap.show{opacity:1;transform:translateX(-50%) translateY(0);}
        .check{flex:0 0 auto;width:17px;height:17px;border-radius:50%;background:#2f5a3f;
               color:#bff0d0;display:flex;align-items:center;justify-content:center;font-size:11px;}
        .msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .msg .path{color:#bff0d0;font-weight:700;}
        .brand{color:#5e7a6a;font-weight:600;margin-left:6px;}
      </style>
      <div class="wrap"><span class="check">&#10003;</span><span class="msg"></span></div>`;
    (document.body || document.documentElement).appendChild(host);
    wrap = shadow.querySelector(".wrap");
  }

  /**
   * Show a confirmation toast.
   * @param {string} message  Plain text; the LAST whitespace-separated token that
   *   looks like a path/URL is emphasized. Set via textContent — never HTML.
   * @param {{duration?:number, path?:string}} [opts]
   */
  window.__spaToast = function (message, opts) {
    try {
      ensureHost();
      const msgEl = shadow.querySelector(".msg");
      msgEl.textContent = "";

      const path = opts && opts.path;
      if (path && message.endsWith(path)) {
        msgEl.appendChild(document.createTextNode(message.slice(0, -path.length)));
        const b = document.createElement("span");
        b.className = "path";
        b.textContent = path;
        msgEl.appendChild(b);
      } else {
        msgEl.textContent = String(message);
      }

      const brand = document.createElement("span");
      brand.className = "brand";
      brand.textContent = "· SPA Direct Nav";
      msgEl.appendChild(brand);

      wrap.classList.remove("show");
      void wrap.offsetWidth; // restart the enter transition
      requestAnimationFrame(() => wrap.classList.add("show"));

      clearTimeout(hideTimer);
      const ttl = (opts && opts.duration) || 3500;
      hideTimer = setTimeout(() => wrap.classList.remove("show"), ttl);
    } catch (_) {
      /* never break the host page */
    }
  };
})();
