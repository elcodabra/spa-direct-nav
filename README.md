# SPA Direct Nav

A Chrome extension (Manifest V3) for jumping straight to any route in a single-page
application — without hunting through the app's UI to get there.

## What it does

Type a **path** (`/dashboard/settings`) or a **full URL** into the popup and navigate
the active tab there in one of two modes:

- **Soft** — uses the History API (`pushState` + a synthetic `popstate`/`hashchange`)
  so the SPA router (React Router, Vue Router, Angular, etc.) updates the view
  **without a full page reload**. Cross-origin targets automatically fall back to a hard load.
- **Hard** — sets the tab URL directly, performing a normal full page load at the target.

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
| `popup.js` | Resolves the target, injects `softNavigate`, manages recent history |
| `icons/` | Toolbar icons (16/48/128) |

## Permissions

- `tabs` / `activeTab` — read the active tab's URL and update it.
- `scripting` + `host_permissions: <all_urls>` — inject the soft-navigation routine into the page.
- `storage` — keep the local "recent" list.

## Notes / limits

- Soft mode only works **same-origin**. A different host can't be reached via `pushState`,
  so the extension falls back to a full load.
- Soft navigation relies on the router listening to `popstate`/`hashchange`. Most do;
  a few custom routers may need a hard reload instead.
- It cannot inject into restricted pages (`chrome://`, the Web Store, etc.).
