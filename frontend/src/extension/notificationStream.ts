import { create, toJson, fromJson } from '@bufbuild/protobuf';
import { TimestampSchema, type Timestamp } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import {
  OctoDeckService,
  WatchNotificationsRequestSchema,
  type BadgeUpdate,
  type Notification,
  type NotificationSummary,
  type WatchNotificationsRequest,
  type WatchNotificationsResponse,
} from '../api/octodeck/v1/service_pb';
import { DEFAULT_API_BASE_URL } from '../utils/constants';

/**
 * Connection state of the notification stream, as reflected on the toolbar badge:
 * - connected: the daemon is streaming; badge updates come from the daemon.
 * - offline: the daemon could not be reached.
 * - setup: the daemon is reachable but the extension isn't paired with it (no bearer token).
 * - version-mismatch: the daemon doesn't implement the notification stream (it is older or newer
 *   than the extension).
 */
export type StreamStatus = 'connected' | 'offline' | 'setup' | 'version-mismatch';

/** Reconnect delays grow exponentially from the initial to the maximum backoff. */
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
/** Reconnect delay after a version mismatch, which only an upgrade fixes. */
export const VERSION_MISMATCH_BACKOFF_MS = 10 * 60_000;

/** The bearer token, or why there isn't one. */
export type TokenResult = { token: string } | { token: null; reason: 'unpaired' | 'unreachable' };

export interface OpenStreamOptions {
  token: string;
  signal: AbortSignal;
}

/** Dependencies of NotificationStream, injectable for tests. */
export interface NotificationStreamDeps {
  /** Returns the bearer token, pairing with the daemon if needed (or forced). */
  getToken(forceRefresh?: boolean): Promise<TokenResult>;
  /** Forgets the cached bearer token after the daemon rejected it. */
  clearToken(): Promise<void>;
  openStream(req: WatchNotificationsRequest, opts: OpenStreamOptions): AsyncIterable<WatchNotificationsResponse>;
  /** Loads the resume cursor: the sent_at of the last message received. */
  loadCursor(): Promise<Timestamp | undefined>;
  /**
   * Saves the resume cursor. durable is set for messages that showed something (a notification
   * or summary), whose cursor must survive a browser restart so they aren't shown again.
   */
  saveCursor(cursor: Timestamp, durable: boolean): Promise<void>;
  onNotification(notification: Notification): Promise<void>;
  onSummary(summary: NotificationSummary, sentAt: Timestamp | undefined): Promise<void>;
  onBadge(badge: BadgeUpdate): void;
  onStatus(status: StreamStatus): void;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

/**
 * Holds the WatchNotifications server stream open and dispatches its messages.
 *
 * The daemon decides notifications and badge counts; this client only shows them. Every message
 * carries a sent_at cursor that is saved after the message is handled, so that a reconnect
 * (including after the service worker was suspended) resumes from the last message received and
 * the daemon replays whatever was missed. Saving the cursor on each heartbeat also keeps the
 * Manifest V3 service worker alive while the stream is open.
 */
export class NotificationStream {
  private readonly deps: NotificationStreamDeps;
  private running = false;
  private stopped = false;
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  /** Set while waiting out VERSION_MISMATCH_BACKOFF_MS, which ensureConnected doesn't cut short. */
  private holdingRetry = false;

  constructor(deps: NotificationStreamDeps) {
    this.deps = deps;
  }

  /** Whether a connection attempt or stream is currently active. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Connects unless already connected or connecting. A pending reconnect is brought forward, so
   * lifecycle events and the watchdog alarm reconnect promptly, except after a version mismatch.
   */
  ensureConnected(): void {
    this.stopped = false;
    if (this.running) return;
    if (this.retryTimer !== null) {
      if (this.holdingRetry) return;
      this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
    });
  }

  /** Closes the stream and cancels any pending reconnect. */
  stop(): void {
    this.stopped = true;
    this.holdingRetry = false;
    if (this.retryTimer !== null) {
      this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    this.abort?.abort();
  }

  private async run(): Promise<void> {
    let retriedAuth = false;
    let forceRefresh = false;
    for (;;) {
      let result: TokenResult;
      try {
        result = await this.deps.getToken(forceRefresh);
      } catch (err) {
        console.debug('[OctoDeck BG] Failed to get bearer token:', err);
        result = { token: null, reason: 'unreachable' };
      }
      if (this.stopped) return;
      if (result.token === null) {
        this.deps.onStatus(result.reason === 'unpaired' ? 'setup' : 'offline');
        this.scheduleReconnect();
        return;
      }

      const outcome = await this.stream(result.token);
      if (this.stopped) return;
      if (outcome === 'unauthenticated' && !retriedAuth) {
        // The daemon no longer accepts the token (e.g. its database was reset): re-pair once.
        retriedAuth = true;
        forceRefresh = true;
        await this.deps.clearToken();
        continue;
      }
      if (outcome === 'unimplemented') {
        this.deps.onStatus('version-mismatch');
        this.scheduleReconnect(VERSION_MISMATCH_BACKOFF_MS);
        return;
      }
      if (outcome !== 'disconnected') {
        // Never got a message: the daemon is unreachable (or still rejects us).
        this.deps.onStatus('offline');
      }
      this.scheduleReconnect();
      return;
    }
  }

  /**
   * Streams until the connection ends. Returns 'disconnected' if at least one message was
   * received, otherwise why connecting failed.
   */
  private async stream(token: string): Promise<'disconnected' | 'unauthenticated' | 'unimplemented' | 'failed'> {
    const abort = new AbortController();
    this.abort = abort;
    let connected = false;
    try {
      const cursor = await this.deps.loadCursor();
      const req = create(WatchNotificationsRequestSchema, { lastReceivedAt: cursor });
      for await (const msg of this.deps.openStream(req, { token, signal: abort.signal })) {
        if (!connected) {
          connected = true;
          this.backoffMs = INITIAL_BACKOFF_MS;
          this.deps.onStatus('connected');
        }
        await this.handle(msg);
      }
    } catch (err) {
      if (!connected) {
        switch (ConnectError.from(err).code) {
          case Code.Unauthenticated:
            return 'unauthenticated';
          case Code.Unimplemented:
            return 'unimplemented';
        }
      }
      if (!abort.signal.aborted) {
        console.debug('[OctoDeck BG] Notification stream ended:', err);
      }
    } finally {
      if (this.abort === abort) this.abort = null;
    }
    return connected ? 'disconnected' : 'failed';
  }

  private async handle(msg: WatchNotificationsResponse): Promise<void> {
    const event = msg.event;
    switch (event.case) {
      case 'notification':
        await this.deps.onNotification(event.value);
        break;
      case 'summary':
        await this.deps.onSummary(event.value, msg.sentAt);
        break;
      case 'badge':
        this.deps.onBadge(event.value);
        break;
      case 'heartbeat':
      case undefined:
        break;
    }
    // Advance the cursor only after the message has been handled, so a notification is never
    // skipped by a reconnect.
    if (msg.sentAt) {
      const durable = event.case === 'notification' || event.case === 'summary';
      await this.deps.saveCursor(msg.sentAt, durable);
    }
  }

  /** Schedules a reconnect after the next backoff delay, or after holdMs (not cut short). */
  private scheduleReconnect(holdMs?: number): void {
    if (this.stopped) return;
    let delay = holdMs;
    if (delay === undefined) {
      delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
    this.holdingRetry = holdMs !== undefined;
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.holdingRetry = false;
      this.ensureConnected();
    }, delay);
  }
}

/** Serializes a cursor for chrome.storage, keeping nanosecond precision. */
export function serializeCursor(cursor: Timestamp): string {
  return toJson(TimestampSchema, cursor) as string;
}

/** Parses a stored cursor; returns undefined for missing or malformed values. */
export function parseCursor(value: unknown): Timestamp | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return fromJson(TimestampSchema, value);
  } catch {
    return undefined;
  }
}

/** Opens WatchNotifications against the local daemon with the Connect protocol. */
export function createDaemonStreamOpener(
  baseUrl: string = DEFAULT_API_BASE_URL
): NotificationStreamDeps['openStream'] {
  const client = createClient(OctoDeckService, createConnectTransport({ baseUrl }));
  return (req, { token, signal }) =>
    client.watchNotifications(req, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
}
