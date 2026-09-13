import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as storage from '../src/storage.js';

const BASE = 'https://push-me.io';
const APP = 'my-app';
const VAPID = 'BAR5YYNBLgus8Y9M1rxPED2qBSkY3T4EKAgaWzCnvm-_ADSsFwFkr9JE11zSRnJiVDc1_AbdVjIohXpC9Ln8dc8';

const alertEnvelope = {
  v: 1,
  id: '019d8200-0e00-7000-8000-000000000001',
  sent_at: 1_767_225_600_000,
  kind: 'alert',
  origin: 'subject',
  app_id: '019d8200-0a00-7000-8000-000000000001',
  external_user_id: 'rc-user-1',
  priority: 'normal',
  title: 'Re: your feedback',
  body: 'Fixed in 1.4.2',
  url: 'https://example.test/threads/7',
  badge: 3,
};

type Listener = (event: unknown) => void;

/**
 * A service-worker global with just the surface the SDK uses. Listeners are
 * captured so a test can fire an event the way the browser would.
 */
function installServiceWorkerGlobals() {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(null);
  const matchAll = vi.fn().mockResolvedValue([]);
  const subscribe = vi.fn().mockResolvedValue({
    toJSON: () => ({
      endpoint: 'https://push.example/s/rotated',
      keys: { p256dh: 'p-new', auth: 'a-new' },
    }),
  });
  const setAppBadge = vi.fn().mockResolvedValue(undefined);

  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: {
      scope: 'https://example.test/',
      showNotification,
      pushManager: { subscribe },
    },
    clients: { matchAll, openWindow },
  };

  vi.stubGlobal('self', self);
  vi.stubGlobal('navigator', { setAppBadge });
  vi.stubGlobal('atob', (b64: string) => Buffer.from(b64, 'base64').toString('binary'));

  const fire = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    if (!listener) throw new Error(`no listener registered for ${type}`);
    listener({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };

  return { fire, showNotification, openWindow, matchAll, subscribe, setAppBadge };
}

/** Imported fresh per test so listeners attach to the current fake global. */
async function loadServiceWorker() {
  vi.resetModules();
  return import('../src/sw/service-worker.js');
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await storage.deleteDevice(APP);
});

describe('push', () => {
  it('shows a notification carrying the parsed payload', async () => {
    const { fire, showNotification } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();

    await fire('push', { data: { json: () => alertEnvelope } });

    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0]!;
    expect(title).toBe('Re: your feedback');
    expect(options.body).toBe('Fixed in 1.4.2');
    expect(options.tag).toBe(alertEnvelope.id);
    expect(options.data.pokeme.externalUserId).toBe('rc-user-1');
  });

  it('applies the badge best-effort', async () => {
    const { fire, setAppBadge } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();

    await fire('push', { data: { json: () => alertEnvelope } });
    expect(setAppBadge).toHaveBeenCalledWith(3);
  });

  it('still shows a notification when the payload is unparseable', async () => {
    // Browsers require every push to produce a notification; suppressing one
    // makes the browser post its own "site updated in the background" banner.
    const { fire, showNotification } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({ fallbackTitle: 'Something happened' });

    await fire('push', {
      data: {
        json: () => {
          throw new Error('not json');
        },
      },
    });

    expect(showNotification).toHaveBeenCalledWith('Something happened', expect.anything());
  });

  it('lets render() override the notification', async () => {
    const { fire, showNotification } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({
      render: (payload) => ({ title: `[${payload.priority}] ${payload.title ?? ''}`, body: 'custom' }),
    });

    await fire('push', { data: { json: () => alertEnvelope } });
    expect(showNotification).toHaveBeenCalledWith(
      '[normal] Re: your feedback',
      expect.objectContaining({ body: 'custom' }),
    );
  });

  it('does not let a failing onPush hook swallow the notification', async () => {
    const { fire, showNotification } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({
      onPush: () => {
        throw new Error('consumer bug');
      },
    });

    await fire('push', { data: { json: () => alertEnvelope } });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});

describe('notificationclick', () => {
  it('opens the payload url when no window is open', async () => {
    const { fire, openWindow } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();

    const close = vi.fn();
    await fire('notificationclick', {
      notification: { close, data: { pokeme: { url: 'https://example.test/threads/7' } } },
    });

    expect(close).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith('https://example.test/threads/7');
  });

  it('focuses an already-open window on the same url', async () => {
    const { fire, matchAll, openWindow } = installServiceWorkerGlobals();
    const focus = vi.fn().mockResolvedValue(undefined);
    matchAll.mockResolvedValue([{ url: 'https://example.test/threads/7', focus }]);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();

    await fire('notificationclick', {
      notification: { close: vi.fn(), data: { pokeme: { url: 'https://example.test/threads/7' } } },
    });

    expect(focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('falls back to the worker scope when the payload has no url', async () => {
    const { fire, openWindow } = installServiceWorkerGlobals();
    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();

    await fire('notificationclick', { notification: { close: vi.fn(), data: {} } });
    expect(openWindow).toHaveBeenCalledWith('https://example.test/');
  });
});

describe('pushsubscriptionchange', () => {
  it('re-subscribes and uploads the new subscription', async () => {
    // The browser rotates subscriptions unprompted and this event is the only
    // notice. Miss it and the install goes dark with no error anywhere.
    const { fire, subscribe } = installServiceWorkerGlobals();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await storage.saveDevice({
      appRef: APP,
      baseUrl: BASE,
      deviceId: 'dev-1',
      deviceToken: 'dt_1',
      vapidPublicKey: VAPID,
    });

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('pushsubscriptionchange', {});

    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/devices/me/push-subscription`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer dt_1' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      endpoint: 'https://push.example/s/rotated',
      p256dh: 'p-new',
      auth: 'a-new',
    });
  });

  it('prefers the subscription the browser supplies', async () => {
    const { fire, subscribe } = installServiceWorkerGlobals();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await storage.saveDevice({
      appRef: APP,
      baseUrl: BASE,
      deviceId: 'dev-1',
      deviceToken: 'dt_1',
      vapidPublicKey: VAPID,
    });

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('pushsubscriptionchange', {
      newSubscription: {
        toJSON: () => ({
          endpoint: 'https://push.example/s/given',
          keys: { p256dh: 'p-given', auth: 'a-given' },
        }),
      },
    });

    expect(subscribe).not.toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.endpoint).toBe('https://push.example/s/given');
  });

  it('does nothing for a device that never subscribed', async () => {
    const { fire, subscribe } = installServiceWorkerGlobals();
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await storage.saveDevice({
      appRef: APP,
      baseUrl: BASE,
      deviceId: 'dev-1',
      deviceToken: 'dt_1',
    });

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('pushsubscriptionchange', {});

    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps going when one registration fails', async () => {
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await storage.saveDevice({
      appRef: APP,
      baseUrl: BASE,
      deviceId: 'dev-1',
      deviceToken: 'dt_1',
      vapidPublicKey: VAPID,
    });
    await storage.saveDevice({
      appRef: 'other-app',
      baseUrl: BASE,
      deviceId: 'dev-2',
      deviceToken: 'dt_2',
      vapidPublicKey: VAPID,
    });

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await expect(fire('pushsubscriptionchange', {})).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await storage.deleteDevice('other-app');
  });
});

/**
 * Web push is the one transport where all three observations are available in
 * one place — `push`, `showNotification`, `notificationclick` — and none of
 * them reaches poke-me on its own. RFC 8030 defines receipts in §10 and no
 * browser push service implements them, so the worker reports.
 */
describe('delivery receipts', () => {
  const device = {
    appRef: APP,
    baseUrl: BASE,
    deviceId: 'dev-1',
    deviceToken: 'dt_1',
    vapidPublicKey: VAPID,
  };

  function stubFetch(
    body: Record<string, unknown> = { recorded: 1, ignored: 0, receipts_enabled: true },
    init: ResponseInit = { status: 200, headers: { 'content-type': 'application/json' } },
  ) {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(body), init));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function receiptCalls(fetchMock: ReturnType<typeof stubFetch>) {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/v1/devices/me/receipts'),
    );
  }

  it('reports delivered and shown as one request per push', async () => {
    // A service worker is not a process — it is torn down between events — so
    // a buffer with a timer would be collected before it ever flushed. One
    // request per event, inside the waitUntil that already holds the worker
    // open, is the only shape that survives.
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('push', { data: { json: () => alertEnvelope } });

    const calls = receiptCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/devices/me/receipts`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer dt_1' });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.receipts.map((r: { state: string }) => r.state)).toEqual(['delivered', 'shown']);
    expect(body.receipts[0].notification_id).toBe(alertEnvelope.id);
    // Milliseconds since the epoch, the unit the envelope's sent_at uses.
    expect(body.receipts[0].at).toBeGreaterThan(1_700_000_000_000);
  });

  it('reports opened on a click', async () => {
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('notificationclick', {
      notification: { close: vi.fn(), data: { pokeme: { id: alertEnvelope.id } } },
    });

    const body = JSON.parse((receiptCalls(fetchMock)[0]![1] as RequestInit).body as string);
    expect(body.receipts).toEqual([
      { notification_id: alertEnvelope.id, state: 'opened', at: expect.any(Number) },
    ]);
  });

  it('reports opened even when the consumer handles the click', async () => {
    // Reported before the handler runs: one that navigates away or throws must
    // not cost the receipt.
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({
      onNotificationClick: () => {
        throw new Error('consumer exploded');
      },
    });
    await expect(
      fire('notificationclick', {
        notification: { close: vi.fn(), data: { pokeme: { id: alertEnvelope.id } } },
      }),
    ).rejects.toThrow('consumer exploded');

    expect(receiptCalls(fetchMock)).toHaveLength(1);
  });

  it('does not claim shown when render() suppressed the notification', async () => {
    // It arrived — worth reporting — but nothing was displayed, and saying
    // otherwise would put a display in the record that never happened.
    const { fire, showNotification } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({ render: () => null });
    await fire('push', { data: { json: () => alertEnvelope } });

    expect(showNotification).not.toHaveBeenCalled();
    const body = JSON.parse((receiptCalls(fetchMock)[0]![1] as RequestInit).body as string);
    expect(body.receipts.map((r: { state: string }) => r.state)).toEqual(['delivered']);
  });

  it('reports nothing for an unparseable push', async () => {
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({ fallbackTitle: 'Something happened' });
    await fire('push', {
      data: {
        json: () => {
          throw new Error('not json');
        },
      },
    });

    expect(receiptCalls(fetchMock)).toHaveLength(0);
  });

  it('reports nothing before the device has registered', async () => {
    // A receipt is addressed by the device token. Without one there is nothing
    // to report as.
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('push', { data: { json: () => alertEnvelope } });

    expect(receiptCalls(fetchMock)).toHaveLength(0);
  });

  it('reportReceipts: false sends none', async () => {
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch();
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker({ reportReceipts: false });
    await fire('push', { data: { json: () => alertEnvelope } });

    expect(receiptCalls(fetchMock)).toHaveLength(0);
  });

  it('remembers receipts_enabled: false across worker restarts', async () => {
    // The worker is torn down between events, so a flag in a module variable
    // would be forgotten on every push and the origin would report a billing
    // decision for ever. It is persisted with the device.
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = stubFetch({ recorded: 0, ignored: 2, receipts_enabled: false });
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('push', { data: { json: () => alertEnvelope } });
    expect(receiptCalls(fetchMock)).toHaveLength(1);
    expect((await storage.loadDevice(APP))?.receiptsDisabled).toBe(true);

    // A fresh worker, as after a teardown.
    const restarted = installServiceWorkerGlobals();
    const second = await loadServiceWorker();
    second.pokeMeServiceWorker();
    await restarted.fire('push', { data: { json: () => alertEnvelope } });

    expect(receiptCalls(fetchMock)).toHaveLength(1);
  });

  it('retries a failure exactly once, then drops it', async () => {
    // Idempotent per (notification, state), so the retry cannot double-count —
    // and there is no UI here and no retry queue, so the second failure is the
    // end of it.
    const { fire } = installServiceWorkerGlobals();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('push', { data: { json: () => alertEnvelope } });

    expect(receiptCalls(fetchMock)).toHaveLength(2);
  });

  it('a failing report does not stop the notification', async () => {
    const { fire, showNotification } = installServiceWorkerGlobals();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    await storage.saveDevice(device);

    const { pokeMeServiceWorker } = await loadServiceWorker();
    pokeMeServiceWorker();
    await fire('push', { data: { json: () => alertEnvelope } });

    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
