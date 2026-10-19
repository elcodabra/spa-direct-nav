/**
 * MAIN-world request mocker.
 *
 * Runs in the page's own JavaScript context (manifest `world: "MAIN"`,
 * `run_at: "document_start"`). Matching requests are answered from a canned
 * response instead of hitting the network, so there is no cross-origin call and
 * no CORS to deal with.
 *
 * Safety rules (a broken wrapper here breaks the whole site, e.g. the Google
 * Cloud console stopped rendering):
 *  - Nothing is patched until the bridge says this origin HAS mocks. Sites without
 *    mocks keep the native fetch / XMLHttpRequest untouched.
 *  - XMLHttpRequest is patched on its PROTOTYPE (open/send), never replaced. A
 *    replacement constructor that returns another object breaks
 *    `class X extends XMLHttpRequest` (Closure, Angular, many SDKs).
 *  - Requests that started before the mocks arrived go to the network (the bridge
 *    answers within the same document_start tick in practice).
 *
 * It owns no chrome.* APIs (the MAIN world has none); the list of mocks for this
 * origin is delivered by the isolated-world `mock-bridge.js` via postMessage.
 * The matcher mirrors `matchMock` in lib.js (kept in sync; lib.js can't be shared
 * into the MAIN world without polluting page globals).
 */
(function () {
  if (window.top !== window) return; // top frame only
  if (!/^https?:$/.test(location.protocol)) return; // mocks exist only for http(s) origins

  let mocks = [];
  let installed = false;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__spaMock !== "config" || !Array.isArray(d.mocks)) return;
    mocks = d.mocks;
    if (mocks.length && !installed) install();
  });

  function match(url, method) {
    if (!mocks.length) return null;
    let pathname, origin;
    try {
      const u = new URL(url, location.href);
      pathname = u.pathname;
      origin = u.origin;
    } catch (_) {
      return null;
    }
    const reqMethod = String(method || "GET").toUpperCase();
    for (const m of mocks) {
      if (!m || m.enabled === false) continue;
      if (m.site && m.site !== origin) continue;
      if (m.method && m.method !== "ANY" && m.method.toUpperCase() !== reqMethod) continue;
      const p = "/" + String(m.path || "").replace(/^\/+/, "");
      if (p === "/") continue;
      const base = p.endsWith("/") ? p.slice(0, -1) : p;
      if (pathname === base || pathname.startsWith(base + "/")) return m;
    }
    return null;
  }

  const bodyText = (m) => (m.body != null ? String(m.body) : "");
  const contentType = (m) => m.contentType || "application/json";
  const delayOf = (m) => {
    const d = Number(m.delay);
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const statusOf = (m) => {
    const s = Number(m.status);
    return Number.isFinite(s) && s >= 100 ? s : 200;
  };
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  function safeJson(t) {
    try {
      return JSON.parse(t);
    } catch (_) {
      return t;
    }
  }

  function install() {
    installed = true;

    /* ---------- fetch ---------- */
    const realFetch = window.fetch;
    if (typeof realFetch === "function") {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === "string" ? input : input && input.url;
          const method = (init && init.method) || (input && input.method) || "GET";
          const m = url && match(url, method);
          if (m) {
            return wait(delayOf(m)).then(
              () =>
                new Response(bodyText(m), {
                  status: statusOf(m),
                  statusText: m.statusText || "",
                  headers: { "Content-Type": contentType(m) },
                })
            );
          }
        } catch (_) {
          /* fall through to the real fetch */
        }
        return realFetch.apply(this, arguments);
      };
    }

    /* ---------- XMLHttpRequest (prototype patch, constructor untouched) ---------- */
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto) return;
    const realOpen = proto.open;
    const realSend = proto.send;
    const META = Symbol("spaMock");

    proto.open = function (method, url) {
      this[META] = { method, url };
      return realOpen.apply(this, arguments);
    };

    proto.send = function () {
      let hit = null;
      const meta = this[META];
      try {
        hit = meta && meta.url && match(meta.url, meta.method);
      } catch (_) {
        hit = null;
      }
      if (!hit) return realSend.apply(this, arguments);

      const xhr = this;
      const status = statusOf(hit);
      const text = bodyText(hit);
      const ct = contentType(hit);
      const define = (k, v) => {
        try {
          Object.defineProperty(xhr, k, { configurable: true, get: () => v });
        } catch (_) {
          /* best effort */
        }
      };
      setTimeout(() => {
        define("readyState", 4);
        define("status", status);
        define("statusText", hit.statusText || "OK");
        define("responseText", text);
        define("response", xhr.responseType === "json" ? safeJson(text) : text);
        define("responseURL", new URL(meta.url, location.href).href);
        xhr.getResponseHeader = (h) => (String(h).toLowerCase() === "content-type" ? ct : null);
        xhr.getAllResponseHeaders = () => "content-type: " + ct + "\r\n";
        // Real events reach both on<type> handlers and addEventListener listeners.
        for (const type of ["readystatechange", "load", "loadend"]) {
          try {
            xhr.dispatchEvent(new ProgressEvent(type));
          } catch (_) {}
        }
      }, delayOf(hit));
    };
  }
})();
