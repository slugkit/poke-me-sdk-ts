import { PokeApiClient } from './api-client.js';
import { PokeApiError, PokePushUnavailableError, type PushSupportState } from './errors.js';
import * as storage from './storage.js';
import { decodeVapidKey, getPushSupportState, toWebPushSubscription } from './support.js';
import type { DeviceChannel } from './types.js';

export interface PokeMeOptions {
  /** Origin of your poke-me deployment, e.g. `https://push-me.io`. */
  baseUrl: string;
  /** Your app's UUID or slug. */
  appRef: string;
  /**
   * The publishable client key (`ck_…`). It ships in your bundle and is public
   * — what actually authorises a browser is the origin the request comes from,
   * which must be registered for the app.
   */
  clientKey: string;
  /**
   * How to get the service worker that receives pushes.
   *
   * Omit it and the SDK waits for `navigator.serviceWorker.ready`, which is
   * right when your build already registers one. Pass `url` to have the SDK
   * register it. Pass `registration` to hand over one you registered yourself.
   */
  serviceWorker?:
    | { url: string; scope?: string }
    | { registration: ServiceWorkerRegistration }
    | undefined;
  /** Injection seam for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** What `register()` did. */
export type RegistrationStatus = 'registered' | 'already-registered';

/** What `enableNotifications()` did. */
export type EnableStatus = 'subscribed' | 'already-subscribed';

/**
 * Browser client for poke-me.
 *
 * The lifecycle is deliberately split so nothing prompts the user before you
 * mean it:
 *
 * ```ts
 * const poke = await PokeMe.init({
 *   baseUrl: 'https://push-me.io',
 *   appRef: 'your-app',
 *   clientKey: 'ck_…',
 * });
 *
 * await poke.register();               // on load — no prompt
 * await poke.identify(user.id);        // when you know who this is
 * // …later, from a click handler:
 * await poke.enableNotifications();    // this is what prompts
 * ```
 *
 * `register()` and `identify()` are safe on every page load. Only
 * `enableNotifications()` shows the permission prompt, and browsers require it
 * to be called from a user gesture.
 */
export class PokeMe {
  readonly #api: PokeApiClient;
  readonly #options: PokeMeOptions;
  #device: storage.StoredDevice | undefined;

  private constructor(options: PokeMeOptions, device: storage.StoredDevice | undefined) {
    this.#options = options;
    this.#device = device;
    this.#api = new PokeApiClient({
      baseUrl: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /** Load any persisted registration for this app. Makes no network calls. */
  static async init(options: PokeMeOptions): Promise<PokeMe> {
    const device = await storage.loadDevice(options.appRef);
    return new PokeMe(options, device);
  }

  /** The server-assigned device id, once registered. */
  get deviceId(): string | undefined {
    return this.#device?.deviceId;
  }

  /** The end-user id this device is currently bound to, if any. */
  get externalUserId(): string | undefined {
    return this.#device?.externalUserId;
  }

  /** Whether this browser can do web push, and what the user has said. */
  getSupportState(): PushSupportState {
    return getPushSupportState();
  }

  /**
   * Register this browser as a device. Idempotent — call it on every load.
   *
   * Shows no prompt and needs no permission: a web device has no push target
   * until `enableNotifications()`, which is exactly what lets you `identify()`
   * a user who has not opted in yet.
   */
  async register(): Promise<RegistrationStatus> {
    if (this.#device) return 'already-registered';

    const response = await this.#api.registerDevice(this.#options.appRef, this.#options.clientKey);
    this.#device = {
      appRef: this.#options.appRef,
      baseUrl: this.#options.baseUrl,
      deviceId: response.deviceId,
      deviceToken: response.deviceToken,
    };
    await storage.saveDevice(this.#device);
    return 'registered';
  }

  /**
   * Bind this device to one of your end-users, by whatever opaque id you
   * already use elsewhere. Safe to call on every resolved login; the server
   * upserts. Registers first if needed.
   */
  async identify(externalUserId: string): Promise<void> {
    const device = await this.#requireDevice();
    await this.#api.identify(device.deviceToken, externalUserId);
    this.#device = { ...device, externalUserId };
    await storage.saveDevice(this.#device);
  }

  /** Clear the user binding, on logout. The device stays registered. */
  async unidentify(): Promise<void> {
    const device = await this.#requireDevice();
    await this.#api.unidentify(device.deviceToken);
    const { externalUserId: _dropped, ...rest } = device;
    this.#device = rest;
    await storage.saveDevice(this.#device);
  }

  /**
   * Ask for notification permission and subscribe this browser to push.
   *
   * **Call this from a user gesture** — a click or tap. Browsers reject or
   * penalise permission prompts that fire on page load, and the accept rate
   * collapses when you ask before the user knows why.
   *
   * Throws `PokePushUnavailableError` when the browser cannot do push or the
   * user has already refused; check `getSupportState()` first to show the right
   * affordance. Throws `PokeApiError` when the app has no Web Push credential
   * configured.
   */
  async enableNotifications(): Promise<EnableStatus> {
    const state = this.getSupportState();
    if (state === 'unsupported' || state === 'insecure-context' || state === 'needs-install') {
      throw new PokePushUnavailableError(`web push is not available here (${state})`, state);
    }
    if (state === 'denied') {
      throw new PokePushUnavailableError(
        'notification permission was refused; the user must change it in browser settings',
        'denied',
      );
    }

    const device = await this.#requireDevice();

    const config = await this.#api.getClientConfig(this.#options.appRef, this.#options.clientKey);
    if (!config.webPush) {
      throw new PokeApiError('this app has no Web Push credential configured', {
        detail: 'add a Web Push (VAPID) credential to the app in the poke-me dashboard',
      });
    }
    const vapidPublicKey = config.webPush.vapidPublicKey;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new PokePushUnavailableError(
        'notification permission was not granted',
        permission === 'denied' ? 'denied' : 'default',
      );
    }

    const registration = await this.#serviceWorkerRegistration();
    const existing = await registration.pushManager.getSubscription();

    // Re-subscribing under a different application server key throws, so an
    // existing subscription from another key has to go first. That happens when
    // the app's VAPID credential is rotated.
    if (existing && device.vapidPublicKey !== vapidPublicKey) {
      await existing.unsubscribe();
    }

    const alreadySubscribed = existing !== null && device.vapidPublicKey === vapidPublicKey;
    const subscription =
      alreadySubscribed && existing
        ? existing
        : await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeVapidKey(vapidPublicKey),
          });

    await this.#api.updatePushSubscription(device.deviceToken, toWebPushSubscription(subscription));
    this.#device = { ...device, vapidPublicKey };
    await storage.saveDevice(this.#device);

    return alreadySubscribed ? 'already-subscribed' : 'subscribed';
  }

  /**
   * Unsubscribe from push. The device stays registered and identified, so
   * `enableNotifications()` can turn it back on without another registration.
   */
  async disableNotifications(): Promise<void> {
    const registration = await this.#serviceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();

    if (this.#device) {
      const { vapidPublicKey: _dropped, ...rest } = this.#device;
      this.#device = rest;
      await storage.saveDevice(this.#device);
    }
  }

  /** Channels this device is subscribed to, if you use the channel surface. */
  async getChannels(): Promise<DeviceChannel[]> {
    const device = await this.#requireDevice();
    return this.#api.getChannels(device.deviceToken);
  }

  /**
   * Revoke this device server-side and forget it locally. The opposite of
   * `register()` — the next `register()` mints a new device.
   */
  async uninstall(): Promise<void> {
    const device = this.#device;
    if (!device) return;
    try {
      await this.disableNotifications();
    } catch {
      // A missing service worker must not block the server-side revoke, which
      // is the part that actually stops pushes.
    }
    await this.#api.deleteDevice(device.deviceToken);
    await storage.deleteDevice(device.appRef);
    this.#device = undefined;
  }

  async #requireDevice(): Promise<storage.StoredDevice> {
    if (!this.#device) await this.register();
    if (!this.#device) throw new PokeApiError('device registration failed');
    return this.#device;
  }

  async #serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    const sw = this.#options.serviceWorker;
    if (sw && 'registration' in sw) return sw.registration;
    if (sw && 'url' in sw) {
      await navigator.serviceWorker.register(sw.url, sw.scope ? { scope: sw.scope } : undefined);
      // register() resolves as soon as the script is fetched and installation
      // begins — but push events are only ever delivered to an ACTIVE worker.
      // Subscribing against a still-installing registration succeeds and then
      // silently drops any push that arrives before it activates, which is
      // indistinguishable from a broken subscription. Wait for activation.
      return navigator.serviceWorker.ready;
    }
    return navigator.serviceWorker.ready;
  }
}
