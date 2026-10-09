/* eslint-disable @typescript-eslint/no-explicit-any */
// Guard (decision D5): the extension worker must never call the GetItems RPC. Badge and
// notification decisions run in the daemon; a future caller would also have to send triage:all,
// because GetItems now scopes to triage:inbox by default.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const GET_ITEMS = /\/octodeck\.v1\.OctoDeckService\/GetItems(\?|$)/;

// Non-test extension sources, loaded as raw text by Vite at transform time.
const extensionSources = import.meta.glob<string>(['../**/*.ts', '!../**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('extension worker never calls GetItems', () => {
  it('has no GetItems reference in extension source', () => {
    const files = Object.keys(extensionSources);
    expect(files).toContain('../background.ts');
    for (const [file, src] of Object.entries(extensionSources)) {
      expect(src, file).not.toMatch(/\bGetItems\b|\bgetItems\b/);
    }
  });

  describe('runtime', () => {
    const listeners: Record<string, ((...args: any[]) => unknown)[]> = {};
    const event = (name: string) => ({
      addListener: vi.fn((fn: (...args: any[]) => unknown) => {
        (listeners[name] ??= []).push(fn);
      }),
    });
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.resetModules();
      fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      const store: Record<string, unknown> = { bearer_token: 'tok' };
      const area = {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))),
        set: vi.fn(async (d: Record<string, unknown>) => void Object.assign(store, d)),
        remove: vi.fn(async () => {}),
      };
      vi.stubGlobal('chrome', {
        storage: { local: area, session: area, onChanged: event('storage.onChanged') },
        action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn(), onClicked: event('action.onClicked') },
        alarms: { create: vi.fn(), get: vi.fn(async () => undefined), clear: vi.fn(async () => true), onAlarm: event('alarms.onAlarm') },
        notifications: { create: vi.fn(), clear: vi.fn(), onClicked: event('notifications.onClicked') },
        tabs: { query: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
        windows: { update: vi.fn() },
        runtime: {
          onInstalled: event('runtime.onInstalled'),
          onStartup: event('runtime.onStartup'),
          onMessage: event('runtime.onMessage'),
          getURL: vi.fn((p: string) => p),
        },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const k of Object.keys(listeners)) delete listeners[k];
    });

    it('issues no GetItems request across startup, install, alarms and every message type', async () => {
      await import('../background');
      expect(listeners['runtime.onMessage']).toHaveLength(1);

      await listeners['runtime.onInstalled']?.[0]?.({ reason: 'install' });
      listeners['runtime.onStartup']?.[0]?.();
      listeners['alarms.onAlarm']?.[0]?.({ name: 'octodeck_stream_watchdog' });
      const onMessage = listeners['runtime.onMessage'][0];
      const types = [
        'GET_ITEM', 'VIEW_ITEM', 'ACK_ITEM', 'STAR_ITEM', 'SET_NOTES', 'REFETCH_ITEM', 'SYNC_ITEM',
        'GET_CONFIG', 'GET_KNOWN_BOTS', 'ADD_KNOWN_BOTS', 'GET_DAEMON_STATUS',
        'GET_NOTIFICATION_SETTINGS', 'SAVE_NOTIFICATION_SETTINGS', 'GET_HIDE_EVENTS', 'SET_HIDE_EVENTS',
      ];
      for (const type of types) {
        await new Promise<void>((resolve) => {
          const keepOpen = onMessage({ type, itemId: 'o/r#1', bots: ['x'], settings: {} }, {}, () => resolve());
          if (keepOpen !== true) resolve();
        });
      }
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

      const urls = fetchMock.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
      expect(urls.some((u) => u.includes('/octodeck.v1.OctoDeckService/'))).toBe(true); // sanity: RPCs were observed
      expect(urls.filter((u) => GET_ITEMS.test(u))).toEqual([]);
    });
  });
});
