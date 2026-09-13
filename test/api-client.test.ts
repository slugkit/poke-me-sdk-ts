import { describe, expect, it, vi } from 'vitest';

import { PokeApiClient } from '../src/api-client.js';
import { PokeApiError } from '../src/errors.js';

const BASE = 'https://push-me.io';
const CLIENT_KEY = 'ck_test';
const DEVICE_TOKEN = 'dt_test';

function clientWith(fetchImpl: typeof globalThis.fetch): PokeApiClient {
  return new PokeApiClient({ baseUrl: BASE, fetch: fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PokeApiClient', () => {
  it('registers a web device without a push token', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ device_id: 'dev-1', device_token: 'dt_1' }));

    const result = await clientWith(fetchMock).registerDevice('my-app', CLIENT_KEY);

    expect(result).toEqual({ deviceId: 'dev-1', deviceToken: 'dt_1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/apps/my-app/devices`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ platform: 'web' });
    expect((init as RequestInit).headers).toMatchObject({ 'X-Client-Key': CLIENT_KEY });
  });

  it('passes a known device id back for idempotent re-registration', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ device_id: 'dev-1', device_token: 'dt_1' }));

    await clientWith(fetchMock).registerDevice('my-app', CLIENT_KEY, 'dev-1');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ platform: 'web', device_id: 'dev-1' });
  });

  it('maps client-config to camelCase', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ web_push: { vapid_public_key: 'BKey' } }));

    const config = await clientWith(fetchMock).getClientConfig('my-app', CLIENT_KEY);
    expect(config).toEqual({ webPush: { vapidPublicKey: 'BKey' } });
  });

  it('surfaces an unconfigured app as webPush: null', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ web_push: null }));

    const config = await clientWith(fetchMock).getClientConfig('my-app', CLIENT_KEY);
    expect(config.webPush).toBeNull();
  });

  it('escapes the app ref into the path', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ web_push: null }));

    await clientWith(fetchMock).getClientConfig('weird ref/../x', CLIENT_KEY);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${BASE}/api/v1/apps/weird%20ref%2F..%2Fx/client-config`,
    );
  });

  it('sends the subscription triple as the server expects it', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status: 200 }));

    await clientWith(fetchMock).updatePushSubscription(DEVICE_TOKEN, {
      endpoint: 'https://push.example/s/1',
      p256dh: 'p',
      auth: 'a',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/devices/me/push-subscription`);
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${DEVICE_TOKEN}`,
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      endpoint: 'https://push.example/s/1',
      p256dh: 'p',
      auth: 'a',
    });
  });

  it('trims a trailing slash off the base url', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ web_push: null }));

    await new PokeApiClient({ baseUrl: `${BASE}///`, fetch: fetchMock }).getClientConfig(
      'a',
      CLIENT_KEY,
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/api/v1/apps/a/client-config`);
  });

  describe('errors', () => {
    it('wraps a transport failure', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new TypeError('Failed to fetch'));

      const error = await clientWith(fetchMock)
        .getClientConfig('a', CLIENT_KEY)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PokeApiError);
      expect((error as PokeApiError).isTransportError).toBe(true);
      expect((error as PokeApiError).statusCode).toBeUndefined();
    });

    it('flags a 403 as an origin rejection', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse({ error: 'origin is not registered for this app' }, 403));

      const error = (await clientWith(fetchMock)
        .registerDevice('a', CLIENT_KEY)
        .catch((e: unknown) => e)) as PokeApiError;

      expect(error.statusCode).toBe(403);
      expect(error.isOriginRejected).toBe(true);
      expect(error.detail).toBe('origin is not registered for this app');
    });

    it('unwraps the framework\'s doubly-encoded error body', async () => {
      // The service framework wraps handler errors as a JSON string inside
      // JSON; without unwrapping, the useful message is invisible.
      const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        jsonResponse(
          { code: '400', message: JSON.stringify({ error: 'missing field: platform' }) },
          400,
        ),
      );

      const error = (await clientWith(fetchMock)
        .registerDevice('a', CLIENT_KEY)
        .catch((e: unknown) => e)) as PokeApiError;

      expect(error.detail).toBe('missing field: platform');
      expect(error.isClientError).toBe(true);
    });

    it('falls back to the raw body when it is not JSON', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('gateway exploded', { status: 502 }));

      const error = (await clientWith(fetchMock)
        .registerDevice('a', CLIENT_KEY)
        .catch((e: unknown) => e)) as PokeApiError;

      expect(error.detail).toBe('gateway exploded');
      expect(error.isServerError).toBe(true);
    });
  });

  it('tolerates an empty success body', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 200 }));

    await expect(clientWith(fetchMock).unidentify(DEVICE_TOKEN)).resolves.toBeUndefined();
  });
});

describe('reportReceipts', () => {
  it('maps the wire shape and defaults the clock', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ recorded: 1, ignored: 0, receipts_enabled: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new PokeApiClient({ baseUrl: BASE, fetch: fetchMock });

    const result = await api.reportReceipts('dt_1', [
      { notificationId: '019d-a', state: 'opened', at: 1_757_577_243_120 },
      { notificationId: '019d-b', state: 'delivered' },
    ]);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.receipts[0]).toEqual({
      notification_id: '019d-a',
      state: 'opened',
      at: 1_757_577_243_120,
    });
    expect(body.receipts[1].at).toBeGreaterThan(1_700_000_000_000);
    expect(result).toEqual({ recorded: 1, ignored: 0, receiptsEnabled: true });
  });

  it('treats a missing receipts_enabled as enabled', async () => {
    // A backend that has never heard of the flag is one where receipts work.
    // Reading absence as "off" would silence the SDK against it for ever.
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ recorded: 1, ignored: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new PokeApiClient({ baseUrl: BASE, fetch: fetchMock });

    const result = await api.reportReceipts('dt_1', [
      { notificationId: '019d-a', state: 'delivered' },
    ]);
    expect(result.receiptsEnabled).toBe(true);
  });
});
