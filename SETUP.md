# Setup guide

Getting `@poke-me/sdk` from nothing to a notification on screen. Roughly fifteen minutes, most of it in the dashboard.

Web push has more moving parts than it looks: a credential, an origin allowlist, a service worker at the right path, a permission prompt at the right moment. Each one fails quietly if you get it wrong, so this guide is ordered to fail loudly and early instead.

---

## 1. Prerequisites, in the dashboard

Three things, all on your app's page. Skip any and the SDK will tell you which — but it is faster to do them first.

### A Web Push credential

**Add credential → Provider: Web Push → Generate one for me.**

You will be asked for a **contact URI** — a `mailto:` or `https:` address that reaches a human. It goes into every request we make to the browser vendors' push services, and it is how they contact you if something is wrong with your sending. Use a monitored role address (`mailto:push@yourcompany.com`), not a personal one and not a black hole.

There is no third party to fetch this key from, unlike APNs or FCM: a VAPID keypair is just a P-256 key, so poke-me mints it. The private half is encrypted at rest and never shown; the public half is what browsers subscribe against.

> Pasting an existing key is supported too — pick **I have a key already** if you are migrating from another provider.

### Your origins

**App settings → allowed origins.** Add every origin you serve the page from, exactly:

```
https://app.example.com
https://staging.example.com
http://localhost:5173
```

Exact `scheme://host[:port]`, no wildcards, no trailing slash, no path. `https://example.com` and `https://www.example.com` are different origins. So are `:443` and no port — write it the way the browser does, which is without the default port.

This is not decoration. A client key ships in your JavaScript bundle and is therefore public; the origin a request arrives from is what actually distinguishes your site from anyone who copied the key out of it.

### A client key

**Client keys → create.** The plaintext `ck_…` is shown **once**. It is publishable — it belongs in your bundle, like a Firebase config or a Sentry DSN — but you still cannot recover it later, so store it wherever you keep build-time config.

---

## 2. Install

```sh
npm install @poke-me/sdk
```

No runtime dependencies.

---

## 3. The service worker

Push notifications are delivered to a **service worker**, not to your page — the page may not even be open. So you need one file that the browser can run on its own.

Create it:

```js
// src/pokeme-sw.js
import { pokeMeServiceWorker } from '@poke-me/sdk/sw';

pokeMeServiceWorker();
```

Three rules about how it must be served, all of which are easy to get wrong and silent when you do:

| Rule | Why |
|---|---|
| **Served from your site root** (`/pokeme-sw.js`) | A worker only controls pages at or below its own path. At `/assets/sw.js` it controls `/assets/**` and nothing else. |
| **A fixed, unhashed filename** | The URL *is* the worker's identity. Content-hashing it orphans the registered one on every deploy. |
| **`Cache-Control: no-cache`** | A cached worker keeps running old code, and the update check is the only thing that replaces it. |

### Bundler configuration

Most bundlers hash and nest output by default, so the worker needs its own small build.

<details>
<summary><b>Vite</b></summary>

A second config, run after the main build:

```ts
// vite.sw.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false, // don't wipe the main build
    lib: {
      entry: 'src/pokeme-sw.js',
      formats: ['iife'],       // a classic script, see below
      name: 'pokemeSw',
      fileName: () => 'pokeme-sw.js',
    },
  },
});
```

```json
{ "scripts": { "build": "vite build && vite build --config vite.sw.config.ts" } }
```
</details>

<details>
<summary><b>webpack</b></summary>

Add a second entry with a fixed name and no hash:

```js
entry: { 'pokeme-sw': './src/pokeme-sw.js' },
output: { filename: '[name].js' },  // no [contenthash] for this one
```
</details>

<details>
<summary><b>Next.js</b></summary>

Bundle the worker separately and emit it into `public/`, e.g. with an `esbuild` step in `prebuild`:

```sh
esbuild src/pokeme-sw.js --bundle --format=iife --outfile=public/pokeme-sw.js
```

Next serves `public/` at the root, so it lands at `/pokeme-sw.js` with the right scope.
</details>

**Classic script or module?** The examples emit a classic script (`iife`). Module service workers (`{ type: 'module' }`) work in current browsers but were unsupported in Firefox before 111, which has had web push far longer than that. A classic script costs nothing and excludes nobody.

---

## 4. The page

```ts
import { PokeMe } from '@poke-me/sdk';

const poke = await PokeMe.init({
  baseUrl: 'https://push-me.io',   // your poke-me deployment
  appRef: 'your-app',              // app slug or UUID
  clientKey: 'ck_…',
  serviceWorker: { url: '/pokeme-sw.js' },
});

// On load. No prompt, no permission needed.
await poke.register();

// Whenever you know who this is. Safe to repeat.
await poke.identify(currentUser.id);
```

Then, **from a click handler** — not on load:

```ts
enableButton.addEventListener('click', async () => {
  try {
    await poke.enableNotifications();
  } catch (err) {
    // See "Handling failure" below.
  }
});
```

### Why the split matters

`register()` and `identify()` never prompt. Only `enableNotifications()` does, and browsers require it to come from a user gesture.

Prompting on page load is the single worst pattern in web push. Chrome's quiet-notification heuristics and Firefox's blocking both penalise sites that do it, users refuse a prompt they have no context for, and **refusal is close to permanent** — the browser will not ask again, and undoing it means digging through site settings. Ask when the user has just done something that makes a notification obviously useful.

Registering first also means you can identify a user, and your backend can address them, before they have opted in. A send to someone who has not enabled notifications simply produces no delivery.

### Check support before showing the button

```ts
switch (poke.getSupportState()) {
  case 'granted':          break;                      // already on
  case 'default':          showEnableButton(); break;
  case 'denied':           showBlockedHelp(); break;
  case 'needs-install':    showAddToHomeScreenHint(); break;
  case 'insecure-context': break;                      // not HTTPS
  case 'unsupported':      hideTheFeature(); break;
}
```

`needs-install` is **not** a dead end — it is Safari saying the site must be installed first (Add to Home Screen on iOS 16.4+, Add to Dock on macOS). On iPhone it is the only route to web push, so it deserves its own prompt rather than being lumped in with `unsupported`.

### Handling failure

```ts
import { PokeApiError, PokePushUnavailableError } from '@poke-me/sdk';

catch (err) {
  if (err instanceof PokePushUnavailableError) {
    // err.state says which: 'denied', 'needs-install', 'unsupported', …
  } else if (err instanceof PokeApiError) {
    if (err.isOriginRejected) {
      // This origin is not in the app's allowed origins. The browser will
      // ALSO log a CORS error for the same request — that one is louder and
      // more misleading. This is the real cause.
    }
    // err.statusCode, err.detail
  }
}
```

---

## 5. Customising the notification

```js
pokeMeServiceWorker({
  icon: '/icons/notification-192.png',

  render: (payload) => ({
    title: payload.title ?? 'New message',
    body: payload.body,
    data: { url: payload.url },
  }),

  onNotificationClick: async (payload) => {
    await clients.openWindow(payload?.url ?? '/inbox');
  },
});
```

Point `icon` at a **real, reachable PNG**. A URL that 404s — or that a catch-all route answers with HTML — is worse than no icon: some browsers ignore it, others refuse the notification.

Every push **must** produce a notification. Browsers enforce this, and one that shows nothing is replaced by the browser's own "this site was updated in the background" message. `render()` may return `null`, but you rarely want it to.

---

## 6. Verify

1. Open your page over **HTTPS** (or `localhost`).
2. Click your enable button, accept the prompt.
3. Send a notification to that user from your backend.

If nothing appears, work down the next section rather than guessing — every layer in web push reports success independently, so "it sent fine" tells you very little.

---

## Troubleshooting

### The push says it was delivered and nothing appears

This is the normal shape of *every* web push failure, because the push service accepts and relays without decrypting, and the browser discards silently. Work from the browser outwards. In your page's console:

```js
(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  console.log('registration:', r);
  console.log('active:', !!r && !!r.active, 'installing:', !!r && !!r.installing);
  const sub = r ? await r.pushManager.getSubscription() : null;
  console.log('endpoint:', sub && sub.endpoint);
  console.log('permission:', Notification.permission);
  if (r) await r.showNotification('Direct test', { body: 'no push involved' });
})();
```

| Result | Meaning |
|---|---|
| `registration: undefined` | The worker was never registered. Check the path and that it is served as JavaScript, not HTML from a catch-all route. |
| `active: false`, `installing: true` | It has not activated. Reload. A subscription made against an installing worker looks valid and receives nothing. |
| "Direct test" **does not** appear | Display is broken, independent of push. Check the OS: notifications allowed for this browser, Do Not Disturb / Focus off. |
| "Direct test" **appears**, pushes do not | The worker is fine; the push is not reaching it. Confirm the `endpoint` above matches what your server has stored. |

### `PokeApiError` with `isOriginRejected`

The origin is not registered for the app. Add it exactly — no trailing slash, no path, and matching scheme and port.

### The permission prompt never appears

`enableNotifications()` must be called from a user gesture. If permission is already `denied`, no call will re-prompt; the user has to reset it in site settings.

### Notifications stop after a while

Browsers rotate subscriptions on their own schedule and announce it only via the `pushsubscriptionchange` event. The SDK handles that for you — but only if the worker is registered and active, so a worker that silently failed to install shows up as a slow, quiet decline over weeks rather than an immediate failure.

### Safari shows nothing on iPhone

iOS only supports web push for **installed** web apps. `getSupportState()` returns `needs-install`; the user must Share → Add to Home Screen, then enable notifications from the installed app.

---

## Reference

| | |
|---|---|
| `PokeMe.init(options)` | Load persisted state. No network calls. |
| `poke.register()` | Register this browser. Idempotent, no prompt. |
| `poke.identify(externalUserId)` | Bind the device to one of your users. |
| `poke.unidentify()` | Clear the binding on logout; stays registered. |
| `poke.enableNotifications()` | Prompt, subscribe, upload. **User gesture required.** |
| `poke.disableNotifications()` | Unsubscribe; registration and identity survive. |
| `poke.uninstall()` | Revoke server-side and forget the device. |
| `poke.getSupportState()` | What this browser can do, and what the user said. |
| `poke.deviceId` / `poke.externalUserId` | Current state, for diagnostics. |

Integrating with an AI coding assistant? See [AGENTS.md](AGENTS.md).
