/* eslint-disable @typescript-eslint/no-explicit-any */
// The daemon is the only writer of known bots (it adds bots discovered during sync), so the
// worker must keep its chrome.storage.local copy fresh; content scripts follow storage changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const GET_CONFIG = /\/octodeck\.v1\.OctoDeckService\/GetConfig(\?|$)/;
const WATCHDOG = 'octodeck_stream_watchdog';

describe('known bots refresh', () => {
  const listeners: Record<string, ((...args: any[]) => unknown)[]> = {};
  const event = (name: string) => ({
    addListener: vi.fn((fn: (...args: any[]) => unknown) => {
      (listeners[name] ??= []).push(fn);
    }),
  });
  let store: Record<string, unknown>;
  let daemonBots: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  const urlOf = (input: unknown) => (input instanceof Request ? input.url : String(input));
  const getConfigCalls = () => fetchMock.mock.calls.filter(([input]) => GET_CONFIG.test(urlOf(input))).length;

  beforeEach(() => {
    vi.resetModules();
    daemonBots = ['k8s-ci-robot'];
    fetchMock = vi.fn(async (input: unknown) => {
      const body = GET_CONFIG.test(urlOf(input)) ? { config: { knownBots: daemonBots } } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    store = { bearer_token: 'tok' };
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

  it('refreshes known bots when the service worker starts', async () => {
    await import('../background');
    await vi.waitFor(() => expect(store.known_bots).toEqual(['k8s-ci-robot']));
  });

  it('refreshes known bots on every watchdog alarm', async () => {
    await import('../background');
    await vi.waitFor(() => expect(store.known_bots).toEqual(['k8s-ci-robot']));
    const before = getConfigCalls();

    // The daemon discovered a new bot during sync.
    daemonBots = ['k8s-ci-robot', 'kubernetes-prow'];
    listeners['alarms.onAlarm']?.[0]?.({ name: WATCHDOG });

    await vi.waitFor(() => expect(store.known_bots).toEqual(['k8s-ci-robot', 'kubernetes-prow']));
    expect(getConfigCalls()).toBeGreaterThan(before);
  });
});
