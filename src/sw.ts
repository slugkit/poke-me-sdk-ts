/**
 * poke-me browser SDK — service-worker entry point.
 *
 * Import this inside your service worker, not in the page:
 *
 * ```js
 * import { pokeMeServiceWorker } from '@poke-me/sdk/sw';
 * pokeMeServiceWorker();
 * ```
 */

export { pokeMeServiceWorker } from './sw/service-worker.js';
export type { ServiceWorkerOptions } from './sw/service-worker.js';

export { parsePushEnvelope } from './envelope.js';
export { PokeEnvelopeError, PokeError } from './errors.js';
export type { AlertPayload, PushPayload, SystemPayload } from './types.js';
