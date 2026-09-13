import { PokeApiClient } from '../api-client.js';
import { parsePushEnvelope } from '../envelope.js';
import * as storage from '../storage.js';
import { decodeVapidKey, toWebPushSubscription } from '../support.js';
import type { AlertPayload, PushPayload, ReceiptState } from '../types.js';
import { reportReceipts } from './receipts.js';

declare const self: ServiceWorkerGlobalScope;

export interface ServiceWorkerOptions {
  /**
   * Shape the notification. Return `null` to show nothing — but see the note
   * on `push` below: browsers require every push to produce a notification, and
   * suppressing one makes the browser show its own "site updated in the
   * background" message instead.
   */
  render?: (
    payload: AlertPayload,
  ) => (NotificationOptions & { title: string }) | null | Promise<(NotificationOptions & { title: string }) | null>;
  /** Icon for notifications that do not set one. */
  icon?: string;
  /** Badge image (monochrome, Android). */
  badge?: string;
  /** Title to fall back to when a payload somehow has neither title nor body. */
  fallbackTitle?: string;
  /**
   * Called for every parsed push, before the notification is shown. Use it to
   * update caches or post a message to open pages.
   */
  onPush?: (payload: PushPayload) => void | Promise<void>;
  /**
   * Handle a notification tap yourself. The default focuses an open page on the
   * payload's `url`, or opens one.
   */
  onNotificationClick?: (
    payload: AlertPayload | undefined,
    event: NotificationEvent,
  ) => void | Promise<void>;
  /**
   * Tell poke-me what became of each notification: `delivered` when the push
   * arrives, `shown` once the browser has the notification, `opened` on a
   * click. Nothing else can tell you — RFC 8030 defines push receipts and no
   * browser push service implements them.
   *
   * On by default. Each event costs one small request, made inside the same
   * `waitUntil` the worker is already held open by, retried once and then
   * dropped. A receipt that never arrives means the device did not report one,
   * never that the notification failed.
   *
   * Receipts are a paid poke-me feature; an unentitled plan is told so once and
   * the SDK stops reporting on its own, so leaving this on costs nothing.
   */
  reportReceipts?: boolean;
}

/**
 * Install poke-me's push handlers in your service worker.
 *
 * ```js
 * import { pokeMeServiceWorker } from '@poke-me/sdk/sw';
 * pokeMeServiceWorker();
 * ```
 *
 * Registers three listeners: `push`, `notificationclick`, and
 * `pushsubscriptionchange`. Call it at the top level of your worker, not inside
 * another event handler — listeners added later than the first event loop turn
 * are not guaranteed to fire.
 */
export function pokeMeServiceWorker(options: ServiceWorkerOptions = {}): void {
  self.addEventListener('push', (event) => {
    event.waitUntil(handlePush(event, options));
  });

  self.addEventListener('notificationclick', (event) => {
    event.waitUntil(handleNotificationClick(event, options));
  });

  // The browser rotates subscriptions on its own schedule and this event is the
  // only notice. Ignore it and installs go dark over weeks, with no error
  // anywhere and nothing in your logs — which is why the SDK owns it rather
  // than leaving it to integrators.
  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(handleSubscriptionChange(event as PushSubscriptionChangeEvent));
  });
}

async function handlePush(event: PushEvent, options: ServiceWorkerOptions): Promise<void> {
  let payload: PushPayload | undefined;
  try {
    payload = parsePushEnvelope(event.data?.json());
  } catch {
    // Fall through with no payload: a notification still has to be shown.
  }

  // Both states this event can produce, collected and sent as one request at
  // the end. `delivered` is true the moment the envelope parsed; `shown` only
  // once the browser has actually accepted the notification.
  const observed: ReceiptState[] = payload ? ['delivered'] : [];

  if (payload) {
    try {
      await options.onPush?.(payload);
    } catch {
      // A consumer hook must not stop the notification from being shown.
    }
  }

  // System events carry no UI. None are emitted today; if one arrives, showing
  // something generic is better than the browser's own fallback banner.
  const alert: AlertPayload | undefined = payload?.kind === 'alert' ? payload : undefined;

  const spec = alert && options.render ? await options.render(alert) : undefined;
  if (spec === null) {
    // The consumer suppressed the notification. It arrived — that is worth
    // reporting — but nothing was shown, and saying otherwise would put a
    // display in the record that never happened.
    await maybeReport(options, payload, observed);
    return;
  }

  const title =
    spec?.title ?? alert?.title ?? alert?.body ?? options.fallbackTitle ?? 'New notification';

  const notification: NotificationOptions = spec
    ? { ...spec }
    : {
        ...(alert?.title && alert.body ? { body: alert.body } : {}),
        ...(options.icon ? { icon: options.icon } : {}),
        ...(options.badge ? { badge: options.badge } : {}),
        // Collapse repeats of the same message rather than stacking them.
        ...(alert ? { tag: alert.id } : {}),
        data: alert ? { pokeme: alert } : {},
      };

  await self.registration.showNotification(title, notification);
  observed.push('shown');

  if (alert?.badge !== undefined) {
    // Chromium PWAs only, and only when installed. Never worth failing a push over.
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void> };
    try {
      await nav.setAppBadge?.(alert.badge);
    } catch {
      /* best effort */
    }
  }

  await maybeReport(options, payload, observed);
}

/** Report unless the consumer turned receipts off. Never throws. */
async function maybeReport(
  options: ServiceWorkerOptions,
  payload: PushPayload | undefined,
  states: ReceiptState[],
): Promise<void> {
  if (options.reportReceipts === false) return;
  try {
    await reportReceipts(payload, states);
  } catch {
    // Telemetry must not be able to fail a push.
  }
}

async function handleNotificationClick(
  event: NotificationEvent,
  options: ServiceWorkerOptions,
): Promise<void> {
  event.notification.close();

  const data = event.notification.data as { pokeme?: AlertPayload } | undefined;
  const payload = data?.pokeme;

  // Reported before the consumer's handler runs, and not inside it: a handler
  // that navigates away or throws must not cost the receipt. This is the
  // strongest evidence poke-me can offer that a person actually saw something.
  await maybeReport(options, payload, ['opened']);

  if (options.onNotificationClick) {
    await options.onNotificationClick(payload, event);
    return;
  }

  const target = new URL(payload?.url ?? '/', self.registration.scope).href;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  const existing = clients.find((c) => c.url === target) ?? clients[0];
  if (existing) {
    await existing.focus();
    if (existing.url !== target && 'navigate' in existing) {
      await (existing as WindowClient).navigate(target);
    }
    return;
  }
  await self.clients.openWindow(target);
}

async function handleSubscriptionChange(event: PushSubscriptionChangeEvent): Promise<void> {
  const devices = await storage.loadAllDevices();

  for (const device of devices) {
    if (!device.vapidPublicKey) continue;

    try {
      // `event.newSubscription` is populated by some browsers and not others,
      // so re-subscribing from the stored key is the path that works
      // everywhere rather than the one that reads better.
      const subscription =
        event.newSubscription ??
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(device.vapidPublicKey),
        }));

      const api = new PokeApiClient({ baseUrl: device.baseUrl });
      await api.updatePushSubscription(device.deviceToken, toWebPushSubscription(subscription));
    } catch {
      // Nothing useful to do here: there is no UI, no retry queue, and the next
      // enableNotifications() from the page will repair it. Swallowing keeps one
      // broken registration from aborting the others.
    }
  }
}

/** Not in every lib.dom yet; the browsers that fire it define these fields. */
interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly newSubscription?: PushSubscription | null;
  readonly oldSubscription?: PushSubscription | null;
}
