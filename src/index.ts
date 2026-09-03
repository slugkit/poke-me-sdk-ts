/**
 * poke-me browser SDK — page entry point.
 *
 * The service-worker half lives at `@poke-me/sdk/sw`.
 */

export { PokeMe } from './poke-me.js';
export type { PokeMeOptions, RegistrationStatus, EnableStatus } from './poke-me.js';

export { PokeApiClient } from './api-client.js';
export type { PokeApiClientOptions } from './api-client.js';

export { parsePushEnvelope } from './envelope.js';
export { getPushSupportState, toWebPushSubscription, decodeVapidKey } from './support.js';

export {
  PokeError,
  PokeApiError,
  PokeEnvelopeError,
  PokePushUnavailableError,
} from './errors.js';
export type { PushSupportState } from './errors.js';

export type {
  AlertPayload,
  ClientConfig,
  DeviceChannel,
  DevicePlatform,
  MessagePriority,
  PushEnvelopeBase,
  PushOrigin,
  PushPayload,
  RegisterDeviceResponse,
  SystemPayload,
  WebPushSubscription,
} from './types.js';
