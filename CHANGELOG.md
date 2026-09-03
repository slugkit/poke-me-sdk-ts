## 0.1.0

First release. Browser client for poke-me web push.

* **Page entry point** (`@poke-me/sdk`) — `PokeMe.init` plus the BYOA lifecycle:
  `register` / `identify` / `unidentify` / `enableNotifications` /
  `disableNotifications` / `uninstall`. Registration and identification never
  prompt, so only `enableNotifications` needs a user gesture.
* **Service-worker entry point** (`@poke-me/sdk/sw`) — `pokeMeServiceWorker()`
  installs `push`, `notificationclick` and `pushsubscriptionchange` handlers.
  The last is the one browsers give no other notice of; missing it is how web
  push integrations go silently dark.
* **Support detection** — `getPushSupportState()` separates `needs-install`
  (Safari, before Add to Home Screen / Add to Dock) from `unsupported`, since
  on iOS it is the only route to web push.
* **Envelope parsing** shared by both entry points, matching the poke-me
  message envelope and the other poke-me SDKs.
* Device credentials in IndexedDB so the service worker can read them.
* No runtime dependencies.
