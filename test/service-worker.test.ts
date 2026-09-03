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
