/**
 * MAIN-world request mocker.
 *
 * Runs in the page's own JavaScript context (manifest `world: "MAIN"`,
 * `run_at: "document_start"`) so it can replace `window.fetch` and
 * `XMLHttpRequest` BEFORE the app's code grabs references to them. Matching
 * requests are answered from a canned response instead of hitting the network —
 * which also means there is no cross-origin call and therefore no CORS to deal
 * with.
 *
 * It owns no chrome.* APIs (the MAIN world has none); the list of mocks for this
 * origin is delivered by the isolated-world `mock-bridge.js` via postMessage.
 *
 * The matcher below intentionally mirrors `matchMock` in lib.js (kept in sync;
 * lib.js can't be shared into the MAIN world without polluting page globals).
 */
(function () {
  if (window.top !== window) return; // top frame only

  let mocks = [];

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.__spaMock === "config" && Array.isArray(d.mocks)) mocks = d.mocks;
  });

  function match(url, method) {
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

  function bodyText(m) {
    return m.body != null ? String(m.body) : "";
  }
  function contentType(m) {
    return m.contentType || "application/json";
  }
  function delayOf(m) {
    const d = Number(m.delay);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }
  function statusOf(m) {
    const s = Number(m.status);
    return Number.isFinite(s) && s >= 100 ? s : 200;
  }
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

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

  /* ---------- XMLHttpRequest ---------- */

  const RealXHR = window.XMLHttpRequest;
  if (typeof RealXHR === "function") {
    window.XMLHttpRequest = function () {
      const real = new RealXHR();
      let reqMethod = "GET";
      let reqUrl = "";
      let hit = null;

      const listeners = {};
      const fake = real; // we mutate the real instance only when NOT mocking

      const realOpen = real.open;
      real.open = function (method, url) {
        reqMethod = method;
        reqUrl = url;
        return realOpen.apply(real, arguments);
      };

      const realSend = real.send;
      real.send = function () {
        try {
          hit = reqUrl && match(reqUrl, reqMethod);
        } catch (_) {
          hit = null;
        }
        if (!hit) return realSend.apply(real, arguments);

        // Synthesize a successful load on the real instance's API surface.
        const status = statusOf(hit);
        const text = bodyText(hit);
        const ct = contentType(hit);

        const define = (k, v) => {
          try {
            Object.defineProperty(real, k, { configurable: true, get: () => v });
          } catch (_) {
            /* some props are non-configurable in old engines; best effort */
          }
        };

        setTimeout(() => {
          define("readyState", 4);
          define("status", status);
          define("statusText", hit.statusText || "OK");
          define("responseText", text);
          define("response", real.responseType === "json" ? safeJson(text) : text);
          define("responseURL", reqUrl);
          real.getResponseHeader = (h) =>
            String(h).toLowerCase() === "content-type" ? ct : null;
          real.getAllResponseHeaders = () => "content-type: " + ct + "\r\n";

          dispatch("readystatechange");
          dispatch("load");
          dispatch("loadend");
        }, delayOf(hit));
      };

      // Capture handlers added via addEventListener so we can fire them when mocked.
      const realAdd = real.addEventListener;
      real.addEventListener = function (type, cb) {
        (listeners[type] = listeners[type] || []).push(cb);
        return realAdd.apply(real, arguments);
      };
      function dispatch(type) {
        const ev = { type, target: real, currentTarget: real };
        const on = real["on" + type];
        if (typeof on === "function") {
          try {
            on.call(real, ev);
          } catch (_) {}
        }
        for (const cb of listeners[type] || []) {
          try {
            cb.call(real, ev);
          } catch (_) {}
        }
      }

      return fake;
    };
    // Preserve constants (UNSENT/OPENED/…/DONE) and the prototype chain.
    window.XMLHttpRequest.prototype = RealXHR.prototype;
    Object.assign(window.XMLHttpRequest, RealXHR);
  }

  function safeJson(t) {
    try {
      return JSON.parse(t);
    } catch (_) {
      return t;
    }
  }
})();
