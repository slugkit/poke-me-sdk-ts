## 0.1.1

* **Fix: wait for an ACTIVE service worker before subscribing.** `register()`
  resolves as soon as the worker script is fetched and installation begins, but
  push events are only ever delivered to an *active* worker. Subscribing against
  a still-installing registration succeeds, uploads a valid-looking
  subscription, and then silently drops any push that arrives before activation
  — indistinguishable from a broken subscription, and the exact shape of "the
  server says delivered but nothing appeared". `serviceWorker: { url }` now
  awaits `navigator.serviceWorker.ready` after registering.

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
