import type { PushSupportState } from './errors.js';
import type { WebPushSubscription } from './types.js';

/**
 * What this browser can do, and what the user has said.
 *
 * Call it before showing any "enable notifications" affordance — the three
 * unavailable states want three different messages, and `needs-install` in
 * particular is a prompt ("add this site to your Home Screen"), not a dead end.
 */
export function getPushSupportState(): PushSupportState {
  if (typeof globalThis === 'undefined') return 'unsupported';
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) return 'insecure-context';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';

  if (!('PushManager' in globalThis)) {
    return needsAppleInstall() ? 'needs-install' : 'unsupported';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Apple ships the Push API only in an installed web app: Add to Home Screen on
 * iOS/iPadOS 16.4+, Add to Dock on macOS Safari 16.1+. In a plain tab
 * `PushManager` is simply absent, which is indistinguishable from an
 * unsupported browser unless you look for the Safari-only `navigator.standalone`
 * — `false` in the tab, `true` once installed.
 */
function needsAppleInstall(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === false;
}

/** Reshape a browser `PushSubscription` into the triple poke-me stores. */
export function toWebPushSubscription(subscription: PushSubscription): WebPushSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error('browser returned an incomplete push subscription');
  }
  return { endpoint: json.endpoint, p256dh, auth };
}

/**
 * Decode a base64url VAPID public key into the `Uint8Array` that
 * `pushManager.subscribe` takes.
 *
 * Some browsers now accept the string directly, but not all of them do, and the
 * failure is a rejected promise deep inside `subscribe()` — so always pass bytes.
 */
export function decodeVapidKey(base64Url: string) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Backed by a plain ArrayBuffer on purpose: `subscribe()` takes a BufferSource,
  // and a Uint8Array over the wider ArrayBufferLike (which could be a
  // SharedArrayBuffer) does not satisfy it.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}
