# SPA Direct Nav

A Chrome extension (Manifest V3) for jumping straight to any route in a single-page
application — without hunting through the app's UI to get there.

## What it does

Type a **path** (`/dashboard/settings`) or a **full URL** into the popup and navigate
the active tab there in one of two modes:

- **Soft** — updates the SPA route **without a full reload**:
  - If you're already on the target host, it calls the History API in place
    (`pushState` + synthetic `popstate`/`hashchange`) so the router (React Router,
    Vue Router, Angular, …) re-renders instantly.
  - For a **cold deep-link** (a different tab, or a server that 404s the deep route
    on a fresh GET — common with feature-branch/preview deploys), it runs a
    **probe-and-strip** pipeline in the background worker: it walks up the path
    (`/a/b/c` → `/a/b/` → `/a/` → `/`), finds the deepest URL the server actually
    serves (the app shell), hard-loads that, **polls in-page until the router
    actually mounts** (framework markers, with a rendered-content fallback and an
    8s cap), then soft-routes the rest of the way to the full URL.
- **Hard** — sets the tab URL directly, performing a normal full page load at the target.

### Address-bar auto-fix (universal, no popup needed)

**On by default for all sites.** When you **paste a deep URL into the address bar**
(or refresh, or open a shared link) and the server returns a 404, the extension fixes
it automatically — no popup interaction.

How it stays safe across every site:

1. The background worker observes main-frame responses via `webRequest` and remembers
   when a navigation returned a 4xx/5xx.
2. The content script only attempts recovery when the background confirms **this exact
   load was an HTTP error** — so normal pages cost almost nothing and aren't touched.
3. Before redirecting, it verifies the servable base is actually an **SPA shell**
   (an empty `#root`/`#app`/`#__next` mount, `data-reactroot`, or `ng-version`), so a
   genuine 404 on a non-SPA site is left exactly as the server returned it.
4. It then walks up to that base, reloads, and soft-routes (`pushState`) back to your
   deep URL. `fetch` probes run in the page → same-origin → your auth cookies are sent.

Controls in the popup:
- **Auto-fix deep links on all sites** — global on/off (default on).
- **Disable on \<host\>** — per-host opt-out (blocklist).

Other niceties:

- **Current** button fills the box with the active page's path.
- **Recent** list remembers your last navigations (stored locally) for one-click repeat.
- Paths resolve against the active tab's origin, so you rarely need to type the host.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`spa-direct-nav`).
4. Pin the extension and click its icon on any SPA.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, action/popup wiring |
| `popup.html` / `popup.css` | Popup UI |
| `popup.js` | Resolves the target, runs the in-place soft path, manages recent history |
| `background.js` | Service worker: probe-and-strip base finder + cold soft-route pipeline |
| `content.js` | Address-bar auto-fix on enabled hosts (detect 404 shell → recover) |
| `icons/` | Toolbar icons (16/48/128) |

## Permissions

- `tabs` / `activeTab` — read the active tab's URL and update it.
- `scripting` + `host_permissions: <all_urls>` — inject the soft-navigation routine into the page.
- `webRequest` — observe main-frame HTTP status so auto-fix only fires on real errors.
- `webNavigation` — invalidate stale error state when a new top-frame navigation starts.
- `storage` — keep the recent list and auto-fix settings; error state lives in
  `storage.session` so it survives the service worker being evicted.

## Notes / limits

- Soft mode only works **same-origin**. A different host can't be reached via `pushState`,
  so the extension falls back to a full load.
- Soft navigation relies on the router listening to `popstate`/`hashchange`. React Router,
  Vue Router and Angular react to these; a few routers (e.g. **Next.js App Router**) drive
  navigation through their own history wrapper and may ignore a synthetic `popstate` — for
  those, use **Hard** mode.
- **Auth-gated dev sites:** if a deep link 404s but the servable base redirects to an SSO
  login page that is itself an SPA, auto-fix may route into the login shell. Disable auto-fix
  on that host if this is noisy.
- The redirect→soft-route recovery only attempts **one** redirect per chain (a `sessionStorage`
  guard) to avoid loops; if the chosen base also errors, it leaves the page as-is.
- It cannot inject into restricted pages (`chrome://`, the Web Store, etc.).
