/**
 * Wire types for the poke-me HTTP API and the push envelope.
 *
 * JSON is snake_case on the wire and camelCase here, matching the other
 * poke-me SDKs.
 */

/** Device platforms poke-me can deliver to. This SDK only ever registers `web`. */
export type DevicePlatform = 'ios' | 'android' | 'macos' | 'web';

/** Notification priority, as set by the publisher. */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Routing origin of a push, discriminating which routing fields are present.
 *
 * - `channel` — a poke-me channel broadcast; carries `channelSlug` /
 *   `channelName` / `routingKey`.
 * - `subject` — a unicast to one of your app's end-users; carries `appId` and
 *   `externalUserId` instead.
 */
export type PushOrigin = 'channel' | 'subject';

/** Fields common to every push, whatever its kind or origin. */
export interface PushEnvelopeBase {
  /** Envelope generation. Unknown future fields are ignored, not an error. */
  v: number;
  /** Server-assigned UUIDv7. Sortable by send time, and the natural dedup key. */
  id: string;
  /** When the message was sent (server-assigned). */
  sentAt: Date;
  origin: PushOrigin;
  /** Channel origin only. */
  channelSlug?: string;
  /** Channel origin only. */
  channelName?: string;
  /** Channel origin only. The full `org/namespace/channel` path. */
  routingKey?: string;
  /** Subject origin only. */
  appId?: string;
  /** Subject origin only — the opaque end-user id the publisher addressed. */
  externalUserId?: string;
}

/** A user-facing alert: the kind that becomes a notification. */
export interface AlertPayload extends PushEnvelopeBase {
  kind: 'alert';
  title?: string;
  body?: string;
  priority: MessagePriority;
  /** Tap target. The service worker focuses or opens it on click. */
  url?: string;
  /** OS badge count. Applied best-effort via `navigator.setAppBadge`. */
  badge?: number;
  /**
   * Background update with no UI.
   *
   * Web push cannot express this — browsers require `userVisibleOnly` and
   * enforce it — so poke-me does not deliver silent messages to web devices at
   * all. The field is parsed for envelope parity with the mobile SDKs, and is
   * always `false` in practice on this transport.
   */
  silent: boolean;
  /** Publisher-defined opaque JSON. */
  extras?: Record<string, unknown>;
}

/**
 * A system event the SDK processes without showing anything. Channel origin
 * only. No poke-me endpoint emits these yet; parsed for forward compatibility.
 */
export interface SystemPayload extends PushEnvelopeBase {
  kind: 'system';
  event: string;
  data?: Record<string, unknown>;
}

/** Anything that can arrive on the push channel. */
export type PushPayload = AlertPayload | SystemPayload;

/** Response of `GET /api/v1/apps/{app_ref}/client-config`. */
export interface ClientConfig {
  /** `null` when the app has no active Web Push credential configured. */
  webPush: { vapidPublicKey: string } | null;
}

/** Response of `POST /api/v1/apps/{app_ref}/devices`. */
export interface RegisterDeviceResponse {
  deviceId: string;
  /** Bearer token (`dt_…`) for this device's `/devices/me/*` calls. */
  deviceToken: string;
}

/** The browser subscription triple, as poke-me stores it. */
export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** One of the device's active channel subscriptions. */
export interface DeviceChannel {
  subscriptionId: string;
  channelId: string;
  channelSlug: string;
  channelName: string;
  joinedAt: string;
}
