## 0.2.0

* **Delivery receipts** — the SDK now tells poke-me what became of each
  notification. Nothing else can: RFC 8030 defines push receipts in §10 and no
  browser push service implements them. On by default; pass
  `pokeMeServiceWorker({ reportReceipts: false })` to send none.

  Three states, reported **independently** rather than as a progression:
  `delivered` when the `push` event fires and the envelope parses, `shown` once
  `showNotification` resolves, `opened` on `notificationclick`. A push whose
  notification `render()` suppressed is `delivered` and never `shown` — saying
  otherwise would put a display in the record that never happened.

  `opened` is reported *before* the consumer's `onNotificationClick` runs: a
  handler that navigates away or throws must not cost the receipt.

  Sent inline, one small request per event inside the `waitUntil` the worker is
  already held open by, retried exactly once and then dropped. No buffer and no
  timer — a service worker is not a process, it is torn down between events, and
  a debounced batch would be collected before it ever flushed. The two states
  one push produces go in a single request.

  Receipts are a paid poke-me feature. An unentitled plan is told so once, and
  the flag is persisted **with the device** rather than held in a module
  variable — the worker is torn down between events, so an in-memory flag would
  be forgotten on every push and the origin would report a billing decision for
  ever.

  New: `poke.reportReceipt(id, state)` on the page, for an in-page surface the
  worker cannot see; `PokeApiClient.reportReceipts`; the `ReceiptState`,
  `Receipt` and `ReportReceiptsResult` types.

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
