import { PokeApiError } from './errors.js';
import type {
  ClientConfig,
  DeviceChannel,
  RegisterDeviceResponse,
  WebPushSubscription,
} from './types.js';

export interface PokeApiClientOptions {
  /** Origin of your poke-me deployment, e.g. `https://push-me.io`. */
  baseUrl: string;
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Thin typed wrapper over the poke-me HTTP endpoints a browser client uses.
 *
 * Stateless — it holds no credentials. Callers pass the client key or device
 * token per call, which keeps it usable from both the page and the service
 * worker, where the two have different ideas of what is in scope.
 */
export class PokeApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: PokeApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** `GET /api/v1/apps/{app_ref}/client-config` */
  async getClientConfig(appRef: string, clientKey: string): Promise<ClientConfig> {
    const body = await this.#request<{ web_push: { vapid_public_key: string } | null }>(
      `/api/v1/apps/${encodeURIComponent(appRef)}/client-config`,
      { method: 'GET', headers: { 'X-Client-Key': clientKey } },
    );
    return {
      webPush: body.web_push ? { vapidPublicKey: body.web_push.vapid_public_key } : null,
    };
  }

  /**
   * `POST /api/v1/apps/{app_ref}/devices`
   *
   * No push token: a web install addresses a browser subscription, which is
   * registered separately once the user grants permission.
   */
  async registerDevice(
    appRef: string,
    clientKey: string,
    deviceId?: string,
  ): Promise<RegisterDeviceResponse> {
    const body = await this.#request<{ device_id: string; device_token: string }>(
      `/api/v1/apps/${encodeURIComponent(appRef)}/devices`,
      {
        method: 'POST',
        headers: { 'X-Client-Key': clientKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'web', ...(deviceId ? { device_id: deviceId } : {}) }),
      },
    );
    return { deviceId: body.device_id, deviceToken: body.device_token };
  }

  /** `POST /api/v1/devices/me/identify` */
  async identify(deviceToken: string, externalUserId: string): Promise<void> {
    await this.#request(`/api/v1/devices/me/identify`, {
      method: 'POST',
      headers: this.#deviceHeaders(deviceToken),
      body: JSON.stringify({ external_user_id: externalUserId }),
    });
  }

  /** `POST /api/v1/devices/me/unidentify` */
  async unidentify(deviceToken: string): Promise<void> {
    await this.#request(`/api/v1/devices/me/unidentify`, {
      method: 'POST',
      headers: this.#deviceHeaders(deviceToken),
      body: '{}',
    });
  }

  /** `PUT /api/v1/devices/me/push-subscription` */
  async updatePushSubscription(
    deviceToken: string,
    subscription: WebPushSubscription,
  ): Promise<void> {
    await this.#request(`/api/v1/devices/me/push-subscription`, {
      method: 'PUT',
      headers: this.#deviceHeaders(deviceToken),
      body: JSON.stringify(subscription),
    });
  }

  /** `GET /api/v1/devices/me/channels` */
  async getChannels(deviceToken: string): Promise<DeviceChannel[]> {
    const body = await this.#request<{
      items: Array<{
        subscription_id: string;
        channel_id: string;
        channel_slug: string;
        channel_name: string;
        joined_at: string;
      }>;
    }>(`/api/v1/devices/me/channels`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    return (body.items ?? []).map((i) => ({
      subscriptionId: i.subscription_id,
      channelId: i.channel_id,
      channelSlug: i.channel_slug,
      channelName: i.channel_name,
      joinedAt: i.joined_at,
    }));
  }

  /** `DELETE /api/v1/devices/me` — uninstall: revokes the device server-side. */
  async deleteDevice(deviceToken: string): Promise<void> {
    await this.#request(`/api/v1/devices/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
  }

  #deviceHeaders(deviceToken: string): Record<string, string> {
    return { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' };
  }

  async #request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch (cause) {
      // fetch rejects for offline, DNS, and — importantly here — a blocked
      // cross-origin response. The last one is indistinguishable from the
      // others at this level, so the message names it as a possibility.
      throw new PokeApiError(
        `request to ${path} failed (offline, or the response was blocked — check that this origin is registered for the app)`,
        { cause },
      );
    }

    if (!response.ok) {
      throw new PokeApiError(`request to ${path} failed with HTTP ${response.status}`, {
        statusCode: response.status,
        ...(await extractDetail(response)),
      });
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new PokeApiError(`response from ${path} was not valid JSON`, {
        statusCode: response.status,
        cause,
      });
    }
  }
}

/**
 * Pull the human-readable reason out of an error response.
 *
 * poke-me returns `{"error": "..."}`, but the service framework wraps handler
 * errors as `{"code": "400", "message": "{\"error\":\"...\"}"}` — a JSON string
 * containing more JSON. Unwrapping that one level is the difference between a
 * developer seeing "slug is required" and seeing a status code.
 */
async function extractDetail(response: Response): Promise<{ detail?: string }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {};
  }
  if (text === '') return {};

  const fromJson = (value: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object') return undefined;
      const o = parsed as Record<string, unknown>;
      if (typeof o['error'] === 'string') return o['error'];
      if (typeof o['message'] === 'string') return fromJson(o['message']) ?? o['message'];
      return undefined;
    } catch {
      return undefined;
    }
  };

  const detail = fromJson(text) ?? text.slice(0, 500);
  return detail ? { detail } : {};
}
