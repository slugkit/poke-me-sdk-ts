import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PokeApiError, PokePushUnavailableError } from '../src/errors.js';
import { PokeMe } from '../src/poke-me.js';
import * as storage from '../src/storage.js';

const BASE = 'https://push-me.io';
const APP = 'my-app';
const CLIENT_KEY = 'ck_test';
const VAPID = 'BAR5YYNBLgus8Y9M1rxPED2qBSkY3T4EKAgaWzCnvm-_ADSsFwFkr9JE11zSRnJiVDc1_AbdVjIohXpC9Ln8dc8';

/**
 * Minimal stand-ins for the browser APIs the SDK touches. Only the surface the
 * SDK actually calls is modelled — a fuller fake would be fiction.
 */
function installBrowserGlobals(permission: NotificationPermission = 'default') {
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.example/s/1',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };

  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };

  const registration = { pushManager } as unknown as ServiceWorkerRegistration;

  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {
    serviceWorker: { ready: Promise.resolve(registration), register: vi.fn() },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    permission,
    requestPermission: vi.fn().mockResolvedValue('granted'),
  });
  vi.stubGlobal('atob', (b64: string) => Buffer.from(b64, 'base64').toString('binary'));

  return { pushManager, subscription, registration };
}

function fetchStub(handlers: Record<string, () => Response>): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [fragment, respond] of Object.entries(handlers)) {
      if (url.includes(fragment)) return respond();
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

const registerOk = () =>
  new Response(JSON.stringify({ device_id: 'dev-1', device_token: 'dt_1' }), { status: 200 });
const configOk = () =>
  new Response(JSON.stringify({ web_push: { vapid_public_key: VAPID } }), { status: 200 });
const empty = () => new Response('', { status: 200 });

beforeEach(async () => {
  vi.unstubAllGlobals();
  await storage.deleteDevice(APP);
});

describe('register', () => {
  it('registers once and remembers the device', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({ '/devices': registerOk });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    expect(await poke.register()).toBe('registered');
    expect(poke.deviceId).toBe('dev-1');
    expect(await poke.register()).toBe('already-registered');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses the persisted device across page loads', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({ '/devices': registerOk });

    const first = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });
    await first.register();

    const second = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });
    expect(second.deviceId).toBe('dev-1');
    expect(await second.register()).toBe('already-registered');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not prompt for notification permission', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({ '/devices': registerOk });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    await poke.register();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });
});

describe('identify', () => {
  it('registers implicitly and persists the binding', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({ '/devices/me/identify': empty, '/devices': registerOk });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    await poke.identify('rc-user-1');
    expect(poke.externalUserId).toBe('rc-user-1');
    expect((await storage.loadDevice(APP))?.externalUserId).toBe('rc-user-1');
  });

  it('clears the binding on unidentify', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({
      '/devices/me/identify': empty,
      '/devices/me/unidentify': empty,
      '/devices': registerOk,
    });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    await poke.identify('rc-user-1');
    await poke.unidentify();
    expect(poke.externalUserId).toBeUndefined();
    expect((await storage.loadDevice(APP))?.externalUserId).toBeUndefined();
  });
});

describe('enableNotifications', () => {
  it('fetches the key, prompts, subscribes, and uploads the subscription', async () => {
    const { pushManager } = installBrowserGlobals();
    const fetch = fetchStub({
      '/client-config': configOk,
      '/push-subscription': empty,
      '/devices': registerOk,
    });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    expect(await poke.enableNotifications()).toBe('subscribed');

    expect(Notification.requestPermission).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    // The key must arrive as bytes; some browsers reject the string form.
    const arg = pushManager.subscribe.mock.calls[0]![0] as PushSubscriptionOptionsInit;
    expect(arg.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect((await storage.loadDevice(APP))?.vapidPublicKey).toBe(VAPID);
  });

  it('reports an unconfigured app rather than failing inside subscribe()', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({
      '/client-config': () => new Response(JSON.stringify({ web_push: null }), { status: 200 }),
      '/devices': registerOk,
    });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    await expect(poke.enableNotifications()).rejects.toBeInstanceOf(PokeApiError);
  });

  it('refuses when permission is already denied, without a network call', async () => {
    installBrowserGlobals('denied');
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    const error = (await poke.enableNotifications().catch((e: unknown) => e)) as PokePushUnavailableError;
    expect(error).toBeInstanceOf(PokePushUnavailableError);
    expect(error.state).toBe('denied');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops a subscription made with a rotated key before re-subscribing', async () => {
    const { pushManager, subscription } = installBrowserGlobals();
    const fetch = fetchStub({
      '/client-config': configOk,
      '/push-subscription': empty,
      '/devices': registerOk,
    });

    // A device already subscribed under a different application server key.
    await storage.saveDevice({
      appRef: APP,
      baseUrl: BASE,
      deviceId: 'dev-1',
      deviceToken: 'dt_1',
      vapidPublicKey: 'BOldKeyOldKeyOldKey',
    });
    pushManager.getSubscription.mockResolvedValue(subscription);

    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });
    expect(await poke.enableNotifications()).toBe('subscribed');

    // subscribe() throws if an existing subscription used a different key.
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalled();
  });

  it('is idempotent when already subscribed under the same key', async () => {
    const { pushManager, subscription } = installBrowserGlobals();
    const fetch = fetchStub({ '/client-config': configOk, '/push-subscription': empty });

    await storage.saveDevice({
      appRef: APP,
      baseUrl: BASE,
      deviceId: 'dev-1',
      deviceToken: 'dt_1',
      vapidPublicKey: VAPID,
    });
    pushManager.getSubscription.mockResolvedValue(subscription);

    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });
    expect(await poke.enableNotifications()).toBe('already-subscribed');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('uninstall', () => {
  it('revokes server-side and forgets the device', async () => {
    installBrowserGlobals();
    const fetch = fetchStub({ '/devices/me': empty, '/devices': registerOk });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY, fetch });

    await poke.register();
    await poke.uninstall();

    expect(poke.deviceId).toBeUndefined();
    expect(await storage.loadDevice(APP)).toBeUndefined();
  });
});

describe('getSupportState', () => {
  it('reports needs-install for an uninstalled Apple web app', async () => {
    vi.stubGlobal('isSecureContext', true);
    // Safari exposes navigator.standalone and withholds PushManager until the
    // site is installed — the two together are the only way to tell it apart
    // from a browser that simply has no push support.
    vi.stubGlobal('navigator', { serviceWorker: {}, standalone: false });
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY });
    expect(poke.getSupportState()).toBe('needs-install');
  });

  it('reports insecure-context off HTTPS', async () => {
    vi.stubGlobal('isSecureContext', false);
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY });
    expect(poke.getSupportState()).toBe('insecure-context');
  });

  it('reports unsupported without a service worker', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', {});
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY });
    expect(poke.getSupportState()).toBe('unsupported');
  });

  it('passes the permission through when supported', async () => {
    installBrowserGlobals('granted');
    const poke = await PokeMe.init({ baseUrl: BASE, appRef: APP, clientKey: CLIENT_KEY });
    expect(poke.getSupportState()).toBe('granted');
  });
});
