import { PokeApiClient } from '../api-client.js';
import * as storage from '../storage.js';
import type { PushPayload, ReceiptState } from '../types.js';

/**
 * Report what became of a notification, from inside the service worker.
 *
 * Web push is the one transport where all three observations are available in
 * one place: `push` fires when it arrives, `showNotification` resolves when the
 * browser has it, and `notificationclick` fires when the user acts. None of
 * that reaches poke-me on its own — RFC 8030 defines receipts in §10 and no
 * browser push service implements them — so the worker reports.
 *
 * Sent inline rather than buffered, because a service worker is not a process:
 * it is torn down between events, and a debounced buffer would be collected
 * before it ever fired. One small request per event, kept alive by the caller's
 * `waitUntil`, is the only shape that survives. The two states a single push
 * produces (`delivered` and `shown`) go in one request.
 */
export async function reportReceipts(
  payload: Pick<PushPayload, 'id' | 'appId'> | undefined,
  states: ReceiptState[],
): Promise<void> {
  if (!payload?.id || states.length === 0) return;

  const device = await resolveDevice(payload.appId);
  if (!device || device.receiptsDisabled) return;

  const api = new PokeApiClient({ baseUrl: device.baseUrl });
  const receipts = states.map((state) => ({ notificationId: payload.id, state }));

  // Exactly one retry. The endpoint is idempotent per (notification, state), so
  // it cannot double-count — and a receipt is not worth more than that: there
  // is no UI here, no retry queue, and the next push will report itself.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await api.reportReceipts(device.deviceToken, receipts);
      if (!result.receiptsEnabled) {
        // Not a failure — an answer, and one that will not change by asking
        // again.
        await storage.patchDevice(device.appRef, { receiptsDisabled: true });
      }
      return;
    } catch {
      if (attempt === 2) return;
    }
  }
}

/**
 * Which registration this push belongs to.
 *
 * The worker has no `appRef` in hand — it is woken by the browser, not by the
 * page — so it has to work one out. A subject-origin push names its app, and
 * the overwhelmingly common case is a single registration per origin anyway.
 *
 * With several registrations and no match, this gives up rather than guessing.
 * Reporting under the wrong device token would be *safe* — the backend only
 * records a receipt for a delivery that device actually received, and ignores
 * anything else — but it would be a request that can only ever be ignored.
 */
async function resolveDevice(appId: string | undefined): Promise<storage.StoredDevice | undefined> {
  const devices = await storage.loadAllDevices();
  if (devices.length === 1) return devices[0];
  if (!appId) return undefined;
  return devices.find((d) => d.appRef === appId);
}
