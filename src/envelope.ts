import { PokeEnvelopeError } from './errors.js';
import type {
  AlertPayload,
  MessagePriority,
  PushOrigin,
  PushPayload,
  SystemPayload,
} from './types.js';

/**
 * Parse the JSON poke-me puts in a web push into a typed payload.
 *
 * Web push carries the envelope verbatim (unlike FCM, which stringifies every
 * value), so this parser can trust native JSON types. It throws
 * `PokeEnvelopeError` rather than returning a half-built object: a malformed
 * envelope is a bug worth surfacing, not something to paper over.
 */
export function parsePushEnvelope(raw: unknown): PushPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PokeEnvelopeError('push payload is not a JSON object');
  }
  const o = raw as Record<string, unknown>;

  const base = {
    v: requireNumber(o, 'v'),
    id: requireString(o, 'id'),
    sentAt: new Date(requireNumber(o, 'sent_at')),
    origin: parseOrigin(o['origin']),
    ...optionalString(o, 'channel_slug', 'channelSlug'),
    ...optionalString(o, 'channel_name', 'channelName'),
    ...optionalString(o, 'routing_key', 'routingKey'),
    ...optionalString(o, 'app_id', 'appId'),
    ...optionalString(o, 'external_user_id', 'externalUserId'),
  };

  // `kind` is absent on envelopes older than the field; those were all alerts.
  const kind = o['kind'] === undefined ? 'alert' : requireString(o, 'kind');

  if (kind === 'system') {
    return {
      ...base,
      kind: 'system',
      event: requireString(o, 'event'),
      ...optionalObject(o, 'data', 'data'),
    } satisfies SystemPayload;
  }
  if (kind !== 'alert') {
    throw new PokeEnvelopeError(`unknown envelope kind: ${kind}`);
  }

  return {
    ...base,
    kind: 'alert',
    priority: parsePriority(o['priority']),
    silent: o['silent'] === true,
    ...optionalString(o, 'title', 'title'),
    ...optionalString(o, 'body', 'body'),
    ...optionalString(o, 'url', 'url'),
    ...optionalNumber(o, 'badge', 'badge'),
    ...optionalObject(o, 'extras', 'extras'),
  } satisfies AlertPayload;
}

function parseOrigin(value: unknown): PushOrigin {
  // Absent means channel: envelopes predating the field were all broadcasts.
  if (value === undefined || value === null || value === 'channel') return 'channel';
  if (value === 'subject') return 'subject';
  throw new PokeEnvelopeError(`invalid origin: ${String(value)}`);
}

function parsePriority(value: unknown): MessagePriority {
  if (value === undefined || value === null) return 'normal';
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'critical') {
    return value;
  }
  throw new PokeEnvelopeError(`invalid priority: ${String(value)}`);
}

function requireString(o: Record<string, unknown>, key: string): string {
  const value = o[key];
  if (typeof value !== 'string') {
    throw new PokeEnvelopeError(`missing or non-string field: ${key}`);
  }
  return value;
}

function requireNumber(o: Record<string, unknown>, key: string): number {
  const value = o[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PokeEnvelopeError(`missing or non-numeric field: ${key}`);
  }
  return value;
}

function optionalString<K extends string>(
  o: Record<string, unknown>,
  key: string,
  as: K,
): Record<K, string> | Record<string, never> {
  const value = o[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') {
    throw new PokeEnvelopeError(`non-string field: ${key}`);
  }
  return { [as]: value } as Record<K, string>;
}

function optionalNumber<K extends string>(
  o: Record<string, unknown>,
  key: string,
  as: K,
): Record<K, number> | Record<string, never> {
  const value = o[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PokeEnvelopeError(`non-numeric field: ${key}`);
  }
  return { [as]: value } as Record<K, number>;
}

function optionalObject<K extends string>(
  o: Record<string, unknown>,
  key: string,
  as: K,
): Record<K, Record<string, unknown>> | Record<string, never> {
  const value = o[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PokeEnvelopeError(`non-object field: ${key}`);
  }
  return { [as]: value as Record<string, unknown> } as Record<K, Record<string, unknown>>;
}
