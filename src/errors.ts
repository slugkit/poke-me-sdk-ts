/** Errors thrown by the SDK. All extend `PokeError`, so one catch covers them. */

export class PokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A poke-me HTTP request failed — either at the transport level (offline, DNS,
 * CORS, timeout) or with a 4xx/5xx response.
 */
export class PokeApiError extends PokeError {
  /** HTTP status, or `undefined` for a transport failure. */
  readonly statusCode: number | undefined;
  /** Server-supplied explanation, when the response carried one. */
  readonly detail: string | undefined;

  constructor(
    message: string,
    options: { statusCode?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.statusCode = options.statusCode;
    this.detail = options.detail;
  }

  /** No HTTP response at all. Usually offline, or a CORS/origin rejection. */
  get isTransportError(): boolean {
    return this.statusCode === undefined;
  }

  get isClientError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 400 && this.statusCode < 500;
  }

  get isServerError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 500;
  }

  /**
   * The origin this page is served from is not registered for the app.
   *
   * Distinguished from a bad credential because the fix is completely
   * different: add the origin to the app's allowed origins in the poke-me
   * dashboard. A browser will separately log a CORS failure for the same
   * request, which is the more visible symptom and the more misleading one.
   */
  get isOriginRejected(): boolean {
    return this.statusCode === 403;
  }
}

/** A push envelope did not have the shape the SDK expects. */
export class PokeEnvelopeError extends PokeError {}

/**
 * Web push cannot be set up in this browser, or the user has not allowed it.
 * `state` says which, so the caller can show the right prompt.
 */
export class PokePushUnavailableError extends PokeError {
  readonly state: PushSupportState;

  constructor(message: string, state: PushSupportState) {
    super(message);
    this.state = state;
  }
}

/**
 * Whether this browser can do web push, and whether the user has said yes.
 *
 * - `unsupported` — no service worker or Push API here at all.
 * - `needs-install` — Apple: push works only once the site is installed (Add to
 *   Home Screen on iOS 16.4+, Add to Dock on macOS Safari 16.1+). This is a
 *   prompt-the-user state, not a dead end, which is why it is not `unsupported`.
 * - `insecure-context` — not HTTPS and not localhost.
 * - `default` — supported, not yet asked.
 * - `granted` / `denied` — the user's answer.
 */
export type PushSupportState =
  | 'unsupported'
  | 'needs-install'
  | 'insecure-context'
  | 'default'
  | 'granted'
  | 'denied';
