# AGENTS.md

Instructions for AI coding agents integrating `@poke-me/sdk` into an application, or working on the SDK itself.

Web push fails quietly. Almost every layer reports success independently of whether a notification ever appears, so the usual "it ran without errors" signal is close to worthless here. The rules below are the ones that are easy to get wrong and slow to discover.

## Integrating the SDK

### Never prompt on page load

`enableNotifications()` shows the browser's permission prompt and **must** be called from a user gesture — a click or tap. Do not call it in a `useEffect`, on `DOMContentLoaded`, or anywhere else that runs unprompted.

This is not a style preference. Chrome's quiet-notification UI and Firefox's blocking both penalise sites that prompt on load, and a refusal is close to permanent: the browser will not ask again and the user must reset it in site settings. Wire it to a button the user chose to press.

`register()` and `identify()` never prompt and are safe on every page load. Prefer that split — it lets the application address a user who has not opted in yet.

### Serve the service worker correctly

Three properties, all silent when wrong:

1. **Site root** — `/pokeme-sw.js`, not `/assets/…`. A worker only controls pages at or below its own path.
2. **Fixed, unhashed filename** — the URL is the worker's identity; hashing it orphans the registered worker on each deploy.
3. **`Cache-Control: no-cache`** — a cached worker runs old code indefinitely.

Do not add the worker to the main bundle. Give it its own build producing a **classic script** (IIFE). Module workers exclude Firefox before 111.

### Do not reimplement what the SDK owns

The SDK deliberately handles these; reimplementing them usually means removing them:

- **`pushsubscriptionchange`** — browsers rotate subscriptions unannounced. This event is the only notice, and ignoring it makes installs go dark over weeks with nothing in any log.
- **Credential storage in IndexedDB** — not `localStorage`, which service workers cannot read. The worker needs the device token to answer the event above.
- **VAPID key rotation** — re-subscribing under a new application server key throws unless the old subscription is dropped first.
- **`applicationServerKey` encoding** — passed as bytes, because not every browser accepts the base64 string.

### Distinguish the unavailable states

`getSupportState()` returns `unsupported`, `needs-install`, `insecure-context`, `default`, `granted`, or `denied`. Do not collapse them into a boolean.

`needs-install` in particular is Safari saying the site must be installed first (Add to Home Screen / Add to Dock). On iOS it is the **only** route to web push, so treating it as `unsupported` hides the feature from every iPhone user.

### Surface `isOriginRejected`

A `PokeApiError` with `isOriginRejected` means the page's origin is not registered for the app. The browser logs a CORS error for the same request, which is louder and more misleading. Report the origin problem, not the CORS symptom.

### Setup the application owner must do

The SDK cannot do these, and none are discoverable from a stack trace. Tell the user explicitly rather than leaving them to hit the error:

1. A **Web Push credential** on the app (the dashboard can generate one).
2. The page's **origin registered** on the app — exact `scheme://host[:port]`, no wildcards, no trailing slash. Include the development origin.
3. A **client key** (`ck_…`) — publishable, belongs in the bundle, shown only once.

## Working on the SDK

### Assume nothing about "it worked"

A payload the browser cannot decrypt produces: `201` from the push service, a recorded successful delivery on the server, no `push` event, and no error anywhere. A subscription made against a not-yet-active worker produces exactly the same trace.

When something reports success, ask what would have failed if it had not. Frequently the answer is "nothing", and then the report means nothing.

### Test by consuming the output, not by describing it

This library previously shipped an encryption bug for months. The tests asserted the *shape* of the ciphertext — header lengths, that two calls differ — and a payload nobody could decrypt has exactly the right shape.

For anything a third party consumes and we cannot run in a test — encryption, signatures, wire formats — **structure is not verification**. Something must independently consume the output, and it must not share the implementation's assumptions. `decrypt_roundtrip_test.cpp` in `userver-web-push` is the model: a receiver written from the RFCs against OpenSSL, deliberately not reusing the encryptor's own helpers.

Verify a new regression test by reintroducing the bug and watching it fail.

### Conventions

- TypeScript strict, ESM, **no runtime dependencies** — do not add one without a strong reason.
- Two entry points: `@poke-me/sdk` (page) and `@poke-me/sdk/sw` (service worker). Keep them separate; the worker half must not pull in page-only code.
- Comments explain *why*, especially where behaviour looks arbitrary but encodes a browser constraint. Those comments are the reason the constraint survives the next refactor.
- `npm run typecheck && npm test && npm run build` before proposing a change.

### Releasing

Consumers pin a git tag. Bump the version, tag it, and remember the package needs its `prepare` script so a git install builds `dist/`.
