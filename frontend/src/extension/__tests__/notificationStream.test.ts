import { describe, it, expect, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  BadgeUpdateSchema,
  HeartbeatSchema,
  NotificationSchema,
  NotificationSummarySchema,
  WatchNotificationsResponseSchema,
  type WatchNotificationsRequest,
  type WatchNotificationsResponse,
} from '../../api/octodeck/v1/service_pb';
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  NotificationStream,
  VERSION_MISMATCH_BACKOFF_MS,
  parseCursor,
  serializeCursor,
  type NotificationStreamDeps,
  type StreamStatus,
  type TokenResult,
} from '../notificationStream';

function notificationMsg(id: string, ms: number): WatchNotificationsResponse {
  return create(WatchNotificationsResponseSchema, {
    sentAt: timestampFromMs(ms),
    event: { case: 'notification', value: create(NotificationSchema, { id }) },
  });
}

function badgeMsg(text: string, ms: number): WatchNotificationsResponse {
  return create(WatchNotificationsResponseSchema, {
    sentAt: timestampFromMs(ms),
    event: { case: 'badge', value: create(BadgeUpdateSchema, { text }) },
  });
}

function heartbeatMsg(ms: number): WatchNotificationsResponse {
  return create(WatchNotificationsResponseSchema, {
    sentAt: timestampFromMs(ms),
    event: { case: 'heartbeat', value: create(HeartbeatSchema, {}) },
  });
}

function summaryMsg(count: number, ms: number): WatchNotificationsResponse {
  return create(WatchNotificationsResponseSchema, {
    sentAt: timestampFromMs(ms),
    event: { case: 'summary', value: create(NotificationSummarySchema, { count }) },
  });
}

type Script = WatchNotificationsResponse[] | Error;

/** Builds deps whose streams replay the given scripts, one per connection attempt. */
function fakeDeps(scripts: Script[], tokenResult: TokenResult = { token: 'tok' }) {
  const events: string[] = [];
  const statuses: StreamStatus[] = [];
  const requests: WatchNotificationsRequest[] = [];
  const tokens: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let cursor: Timestamp | undefined;
  let attempt = 0;

  const deps: NotificationStreamDeps = {
    getToken: vi.fn(async () => tokenResult),
    clearToken: vi.fn(async () => {}),
    openStream: (req, opts) => {
      requests.push(req);
      tokens.push(opts.token);
      const script = scripts[attempt++] ?? new Error('no more scripts');
      return (async function* () {
        if (script instanceof Error) throw script;
        for (const msg of script) yield msg;
      })();
    },
    loadCursor: async () => cursor,
    saveCursor: async (c, durable) => {
      cursor = c;
      events.push(`cursor:${Number(c.seconds) * 1000 + c.nanos / 1e6}${durable ? ':durable' : ''}`);
    },
    onNotification: async (n) => {
      events.push(`notification:${n.id}`);
    },
    onSummary: async (s) => {
      events.push(`summary:${s.count}`);
    },
    onBadge: (b) => {
      events.push(`badge:${b.text}`);
    },
    onStatus: (s) => {
      statuses.push(s);
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: vi.fn(),
  };
  return { deps, events, statuses, requests, tokens, timers, getCursor: () => cursor };
}

/** Waits until the stream finishes its current connection attempt. */
async function settle(stream: NotificationStream): Promise<void> {
  for (let i = 0; i < 100 && stream.isRunning; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(stream.isRunning).toBe(false);
}

describe('NotificationStream', () => {
  it('dispatches messages and saves the cursor after each one', async () => {
    const f = fakeDeps([[badgeMsg('2', 1000), notificationMsg('n1', 2000), summaryMsg(5, 3000), heartbeatMsg(4000)]]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);

    expect(f.events).toEqual([
      'badge:2',
      'cursor:1000',
      'notification:n1',
      'cursor:2000:durable',
      'summary:5',
      'cursor:3000:durable',
      'cursor:4000',
    ]);
    expect(f.statuses[0]).toBe('connected');
    expect(f.tokens).toEqual(['tok']);
  });

  it('resumes from the saved cursor on reconnect', async () => {
    const f = fakeDeps([[badgeMsg('1', 1000), heartbeatMsg(5000)], [badgeMsg('1', 6000)]]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    expect(f.requests[0].lastReceivedAt).toBeUndefined();

    // The stream ended after connecting: a reconnect is scheduled at the initial backoff,
    // without flagging the daemon offline.
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0].ms).toBe(INITIAL_BACKOFF_MS);
    expect(f.statuses).toEqual(['connected']);

    f.timers[0].fn();
    await settle(stream);
    expect(f.requests[1].lastReceivedAt).toEqual(timestampFromMs(5000));
  });

  it('marks the daemon offline and backs off exponentially while unreachable', async () => {
    const f = fakeDeps([new Error('Failed to fetch'), new Error('Failed to fetch'), new Error('Failed to fetch')]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    f.timers[0].fn();
    await settle(stream);
    f.timers[1].fn();
    await settle(stream);

    expect(f.statuses).toEqual(['offline', 'offline', 'offline']);
    expect(f.timers.map((t) => t.ms)).toEqual([INITIAL_BACKOFF_MS, INITIAL_BACKOFF_MS * 2, INITIAL_BACKOFF_MS * 4]);
  });

  it('caps the backoff and resets it after a successful connection', async () => {
    const failures: Script[] = Array.from({ length: 10 }, () => new Error('down'));
    const f = fakeDeps([...failures, [badgeMsg('0', 1000)], new Error('down')]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    for (let i = 0; i < 11; i++) {
      f.timers[i].fn();
      await settle(stream);
    }
    expect(Math.max(...f.timers.map((t) => t.ms))).toBe(MAX_BACKOFF_MS);
    // Attempt 11 connected, so its reconnect uses the initial backoff and the following
    // failure starts doubling again from there.
    expect(f.timers[10].ms).toBe(INITIAL_BACKOFF_MS);
    expect(f.timers[11].ms).toBe(INITIAL_BACKOFF_MS * 2);
  });

  it('shows SETUP and retries later when not paired', async () => {
    const f = fakeDeps([], { token: null, reason: 'unpaired' });
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    expect(f.statuses).toEqual(['setup']);
    expect(f.requests).toHaveLength(0);
    expect(f.timers).toHaveLength(1);
  });

  it('shows offline, not SETUP, when pairing fails because the daemon is unreachable', async () => {
    const f = fakeDeps([], { token: null, reason: 'unreachable' });
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    expect(f.statuses).toEqual(['offline']);
    expect(f.requests).toHaveLength(0);
    expect(f.timers).toHaveLength(1);
  });

  it('reports a version mismatch when the daemon lacks the stream, and waits longer to retry', async () => {
    const f = fakeDeps([new ConnectError('no such method', Code.Unimplemented), [badgeMsg('0', 1000)]]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    expect(f.statuses).toEqual(['version-mismatch']);
    expect(f.timers.map((t) => t.ms)).toEqual([VERSION_MISMATCH_BACKOFF_MS]);

    // The watchdog doesn't cut the long wait short.
    stream.ensureConnected();
    await settle(stream);
    expect(f.requests).toHaveLength(1);
    expect(f.deps.clearTimer).not.toHaveBeenCalled();

    f.timers[0].fn();
    await settle(stream);
    expect(f.requests).toHaveLength(2);
    expect(f.statuses).toEqual(['version-mismatch', 'connected']);
  });

  it('re-pairs once when the daemon rejects the token', async () => {
    const f = fakeDeps([new ConnectError('bad token', Code.Unauthenticated), [badgeMsg('0', 1000)]]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);

    expect(f.deps.clearToken).toHaveBeenCalledTimes(1);
    expect(f.deps.getToken).toHaveBeenLastCalledWith(true);
    expect(f.requests).toHaveLength(2);
    expect(f.statuses).toEqual(['connected']);
  });

  it('gives up re-pairing after one attempt', async () => {
    const unauth = () => new ConnectError('bad token', Code.Unauthenticated);
    const f = fakeDeps([unauth(), unauth()]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    expect(f.deps.clearToken).toHaveBeenCalledTimes(1);
    expect(f.statuses).toEqual(['offline']);
  });

  it('ensureConnected is a no-op while connected and brings a pending reconnect forward', async () => {
    const f = fakeDeps([new Error('down'), [badgeMsg('0', 1000)]]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    stream.ensureConnected();
    await settle(stream);
    expect(f.requests).toHaveLength(1);

    // The watchdog fires before the backoff timer.
    stream.ensureConnected();
    expect(f.deps.clearTimer).toHaveBeenCalledTimes(1);
    await settle(stream);
    expect(f.requests).toHaveLength(2);
  });

  it('stop cancels reconnects', async () => {
    const f = fakeDeps([new Error('down')]);
    const stream = new NotificationStream(f.deps);
    stream.ensureConnected();
    await settle(stream);
    stream.stop();
    expect(f.deps.clearTimer).toHaveBeenCalled();
  });
});

describe('cursor serialization', () => {
  it('round-trips with nanosecond precision', () => {
    const ts = timestampFromMs(1700000000123);
    ts.nanos += 456;
    const parsed = parseCursor(serializeCursor(ts));
    expect(parsed?.seconds).toBe(ts.seconds);
    expect(parsed?.nanos).toBe(ts.nanos);
  });

  it('ignores missing or malformed values', () => {
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor('')).toBeUndefined();
    expect(parseCursor('not a time')).toBeUndefined();
    expect(parseCursor(42)).toBeUndefined();
  });
});
