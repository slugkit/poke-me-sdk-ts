import { describe, expect, it } from 'vitest';

import { parsePushEnvelope } from '../src/envelope.js';
import { PokeEnvelopeError } from '../src/errors.js';

/** A subject-origin alert, exactly as the fan-out worker serialises it. */
const subjectAlert = {
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
  extras: { thread_id: '7' },
};

const channelAlert = {
  v: 1,
  id: '019d8200-0e00-7000-8000-000000000002',
  sent_at: 1_767_225_600_000,
  kind: 'alert',
  origin: 'channel',
  channel_slug: 'releases',
  channel_name: 'Releases',
  routing_key: 'acme/apps/web/releases',
  priority: 'high',
  title: 'v2.1 shipped',
  body: 'Changelog inside',
};

describe('parsePushEnvelope', () => {
  it('parses a subject-origin alert', () => {
    const payload = parsePushEnvelope(subjectAlert);
    expect(payload.kind).toBe('alert');
    expect(payload.origin).toBe('subject');
    expect(payload.id).toBe(subjectAlert.id);
    expect(payload.sentAt.toISOString()).toBe(new Date(subjectAlert.sent_at).toISOString());
    expect(payload.appId).toBe(subjectAlert.app_id);
    expect(payload.externalUserId).toBe('rc-user-1');
    if (payload.kind !== 'alert') throw new Error('expected an alert');
    expect(payload.title).toBe('Re: your feedback');
    expect(payload.badge).toBe(3);
    expect(payload.extras).toEqual({ thread_id: '7' });
    expect(payload.silent).toBe(false);
  });

  it('parses a channel-origin alert with its routing fields', () => {
    const payload = parsePushEnvelope(channelAlert);
    expect(payload.origin).toBe('channel');
    expect(payload.channelSlug).toBe('releases');
    expect(payload.channelName).toBe('Releases');
    expect(payload.routingKey).toBe('acme/apps/web/releases');
    expect(payload.appId).toBeUndefined();
  });

  it('omits absent optional fields rather than setting them null', () => {
    const payload = parsePushEnvelope(channelAlert);
    expect('url' in payload).toBe(false);
    expect('badge' in payload).toBe(false);
  });

  it('treats a missing origin as channel', () => {
    // Envelopes predating the origin field were all broadcasts.
    const { origin: _dropped, ...withoutOrigin } = channelAlert;
    expect(parsePushEnvelope(withoutOrigin).origin).toBe('channel');
  });

  it('treats a missing kind as alert', () => {
    const { kind: _dropped, ...withoutKind } = channelAlert;
    expect(parsePushEnvelope(withoutKind).kind).toBe('alert');
  });

  it('defaults priority to normal', () => {
    const { priority: _dropped, ...withoutPriority } = channelAlert;
    const payload = parsePushEnvelope(withoutPriority);
    if (payload.kind !== 'alert') throw new Error('expected an alert');
    expect(payload.priority).toBe('normal');
  });

  it('ignores unknown fields so a newer server does not break an older SDK', () => {
    const payload = parsePushEnvelope({ ...channelAlert, some_future_field: 'whatever' });
    expect(payload.id).toBe(channelAlert.id);
  });

  it('parses a system event', () => {
    const payload = parsePushEnvelope({
      v: 1,
      id: '019d8200-0e00-7000-8000-000000000003',
      sent_at: 1_767_225_600_000,
      kind: 'system',
      origin: 'channel',
      channel_slug: 'releases',
      event: 'subscription_revoked',
      data: { reason: 'unregistered' },
    });
    if (payload.kind !== 'system') throw new Error('expected a system payload');
    expect(payload.event).toBe('subscription_revoked');
    expect(payload.data).toEqual({ reason: 'unregistered' });
  });

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(() => parsePushEnvelope(raw)).toThrow(PokeEnvelopeError);
  });

  it.each(['id', 'v', 'sent_at'])('rejects a missing %s', (field) => {
    const raw: Record<string, unknown> = { ...channelAlert };
    delete raw[field];
    expect(() => parsePushEnvelope(raw)).toThrow(PokeEnvelopeError);
  });

  it('rejects an unknown origin', () => {
    expect(() => parsePushEnvelope({ ...channelAlert, origin: 'wat' })).toThrow(PokeEnvelopeError);
  });

  it('rejects an unknown kind', () => {
    expect(() => parsePushEnvelope({ ...channelAlert, kind: 'wat' })).toThrow(PokeEnvelopeError);
  });

  it('rejects an unknown priority', () => {
    expect(() => parsePushEnvelope({ ...channelAlert, priority: 'urgent' })).toThrow(
      PokeEnvelopeError,
    );
  });

  it('rejects a field of the wrong type', () => {
    expect(() => parsePushEnvelope({ ...channelAlert, title: 42 })).toThrow(PokeEnvelopeError);
    expect(() => parsePushEnvelope({ ...channelAlert, extras: [1, 2] })).toThrow(PokeEnvelopeError);
  });
});
