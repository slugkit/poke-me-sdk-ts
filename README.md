# @poke-me/sdk

Browser client SDK for **poke-me** — web push notifications addressed to your own app's users by an opaque id you already use elsewhere, or to poke-me channels.

It owns the awkward parts of web push for you: the permission dance, the VAPID key, the service-worker plumbing, and the subscription rotation that browsers do behind your back.

- **Chrome / Edge / Firefox** — anywhere the Push API is available.
- **Safari** — iOS/iPadOS 16.4+ and macOS 13.1+, once the site is **installed** (Add to Home Screen / Add to Dock). The SDK reports this as a distinct state so you can prompt for it.

New to web push, or want the full walkthrough — dashboard setup, bundler configs, troubleshooting? **[SETUP.md](SETUP.md)**.
Using an AI coding assistant? **[AGENTS.md](AGENTS.md)**.

## Install

```sh
npm install @poke-me/sdk
```

## Quick start

Two files: your page, and your service worker.

### 1. The page

```ts
import { PokeMe } from '@poke-me/sdk';

const poke = await PokeMe.init({
  baseUrl: 'https://push-me.io',
  appRef: 'your-app',       // your app's slug or UUID
  clientKey: 'ck_…',        // publishable — it ships in your bundle
});

await poke.register();            // on load. No prompt.
await poke.identify(user.id);     // when you know who this is.

// …later, from a click handler:
button.addEventListener('click', async () => {
  await poke.enableNotifications();   // this is what prompts
});
```

### 2. The service worker

```js
// src/pokeme-sw.js
import { pokeMeServiceWorker } from '@poke-me/sdk/sw';

pokeMeServiceWorker();
```

Register it however your app already registers a service worker, or let the SDK do it:

```ts
const poke = await PokeMe.init({
  baseUrl: 'https://push-me.io',
  appRef: 'your-app',
  clientKey: 'ck_…',
  serviceWorker: { url: '/pokeme-sw.js' },
});
```

The worker's **scope** decides which pages it controls, so serve it from the root (`/pokeme-sw.js`) unless you know you want it narrower.

## Before it will work

Three things, all in the dashboard, none discoverable from a stack trace — see [SETUP.md §1](SETUP.md#1-prerequisites-in-the-dashboard):

1. **A Web Push credential** on the app. The dashboard can generate one; there is no third party to fetch it from.
2. **Your origins**, exactly — production, staging, preview, and your dev server (`http://localhost:5173`). A client key in a JS bundle is public, so the origin is what actually authorises a browser.
3. **A client key** (`ck_…`), shown once at creation.

If an origin is missing, requests fail with 403 *and* the browser logs a CORS error. The CORS error is louder and more misleading; check `error.isOriginRejected` to tell them apart.

## Why the lifecycle is split

`register()` and `identify()` never prompt, so you can call them on every page load. Only `enableNotifications()` asks for permission, and **browsers require it to come from a user gesture** — a click or a tap.

This is deliberate. Prompting on page load is the single worst pattern in web push: Chrome's quiet-notification heuristics and Firefox's blocking both penalise it, and users refuse a prompt they have no context for. Refusal is close to permanent — the browser will not ask twice, and un-refusing means digging through site settings.

Registering first also means you can `identify()` a user who has not opted in yet, and your backend can address them without knowing or caring whether they will.

## Checking support first

```ts
switch (poke.getSupportState()) {
  case 'granted':          /* already on */ break;
  case 'default':          showEnableButton(); break;
  case 'denied':           showBlockedHelp(); break;
  case 'needs-install':    showAddToHomeScreenHint(); break;   // Safari
  case 'insecure-context': /* not HTTPS */ break;
  case 'unsupported':      hideTheWholeFeature(); break;
}
```

`needs-install` is not a dead end — it is Safari telling you the site has to be installed first. It is worth handling separately, since on iOS it is the *only* way to get web push at all.

## Handling the push

`pokeMeServiceWorker()` shows a notification for every push and focuses or opens the message's `url` when it is tapped. To take over either:

```js
pokeMeServiceWorker({
  icon: '/icon-192.png',

  render: (payload) => ({
    title: payload.title ?? 'New message',
    body: payload.body,
    icon: '/icon-192.png',
    data: { url: payload.url },
  }),

  onNotificationClick: async (payload) => {
    await clients.openWindow(payload?.url ?? '/inbox');
  },
});
```

Every push **must** produce a notification — browsers enforce this, and a push that shows nothing gets replaced by the browser's own "this site was updated in the background" message. So `render()` returning `null` is supported but rarely what you want.

## What the SDK handles that you would otherwise have to

- **`pushsubscriptionchange`.** Browsers rotate subscriptions on their own schedule, and this event is the only notice. Ignore it and installs go dark over weeks with no error anywhere — no failed request, nothing in your logs, just a slow silent decline. The SDK re-subscribes and re-uploads.
- **Credentials in IndexedDB, not `localStorage`.** The service worker has no `localStorage`, and it needs the device token to answer the event above.
- **VAPID key rotation.** Re-subscribing under a new application server key throws unless the old subscription is dropped first. `enableNotifications()` notices and handles it.
- **The `applicationServerKey` encoding.** Not every browser accepts the base64 string form, and the failure is a rejected promise deep inside `subscribe()`.

## API

| | |
|---|---|
| `PokeMe.init(options)` | Load any persisted registration. No network calls. |
| `poke.register()` | Register this browser. Idempotent, no prompt. |
| `poke.identify(externalUserId)` | Bind the device to one of your users. Safe on every login. |
| `poke.unidentify()` | Clear the binding on logout. Device stays registered. |
| `poke.enableNotifications()` | Prompt, subscribe, upload. **From a user gesture.** |
| `poke.disableNotifications()` | Unsubscribe. Registration and identity survive. |
| `poke.uninstall()` | Revoke server-side and forget the device. |
| `poke.getSupportState()` | What this browser can do, and what the user said. |
| `poke.getChannels()` | Channel subscriptions, if you use the channel surface. |

Errors all extend `PokeError`: `PokeApiError` (HTTP or transport, with `statusCode`, `detail`, `isOriginRejected`), `PokePushUnavailableError` (carries the `state`), `PokeEnvelopeError`.

`PokeApiClient` is exported too, if you want the endpoints without the lifecycle.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
