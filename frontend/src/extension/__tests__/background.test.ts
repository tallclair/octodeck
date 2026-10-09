/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { create, fromJson } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  acquireBearerToken,
  ensureBearerToken,
  callDaemonRpc,
  createCursorStore,
  ensureWatchdogAlarm,
  safeDashboardUrl,
  CURSOR_PERSIST_INTERVAL_MS,
  WATCHDOG_ALARM,
  applyBadge,
  applyStreamStatus,
  showNotification,
  showSummary,
  handleNotificationClick,
  cleanUpObsoleteState,
} from '../background';
import { ItemStatus } from '../../api/octodeck/v1/resources_pb';
import {
  BadgeCountMode,
  BadgeUpdateSchema,
  NotificationSchema,
  NotificationSummarySchema,
  UpdateConfigRequestSchema,
} from '../../api/octodeck/v1/service_pb';
import { DEFAULT_BASE_URL } from '../../utils/constants';

describe('Extension Background Service Worker', () => {
  let mockStorage: Record<string, any> = {};
  let mockSession: Record<string, any> = {};

  const storageArea = (getStore: () => Record<string, any>, setStore: (s: Record<string, any>) => void) => ({
    get: vi.fn((keys: string[]) => {
      const store = getStore();
      const res: Record<string, any> = {};
      keys.forEach((k) => {
        if (k in store) res[k] = store[k];
      });
      return Promise.resolve(res);
    }),
    set: vi.fn((data: Record<string, any>) => {
      setStore({ ...getStore(), ...data });
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const store = { ...getStore() };
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      setStore(store);
      return Promise.resolve();
    }),
  });

  beforeEach(() => {
    mockStorage = {};
    mockSession = {};
    globalThis.fetch = vi.fn();

    (globalThis as any).chrome = {
      storage: {
        local: storageArea(() => mockStorage, (s) => (mockStorage = s)),
        session: storageArea(() => mockSession, (s) => (mockSession = s)),
        onChanged: {
          addListener: vi.fn(),
        },
      },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
        setTitle: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      alarms: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(true),
        onAlarm: { addListener: vi.fn() },
      },
      notifications: {
        create: vi.fn(),
        clear: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
      },
      windows: {
        update: vi.fn(),
      },
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        getURL: vi.fn((path: string) => path),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ensureBearerToken', () => {
    it('returns existing cached token if present and not forced', async () => {
      mockStorage.bearer_token = 'cached-token-123';
      const token = await ensureBearerToken(false);
      expect(token).toBe('cached-token-123');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('auto-pairs with daemon when no token is cached', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'newly-paired-token-456' }),
      });

      const token = await ensureBearerToken();
      expect(token).toBe('newly-paired-token-456');
      expect(mockStorage.bearer_token).toBe('newly-paired-token-456');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/auth/companion-token'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('forces refresh when forceRefresh is true even if token was cached', async () => {
      mockStorage.bearer_token = 'old-stale-token';
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'fresh-refreshed-token-789' }),
      });

      const token = await ensureBearerToken(true);
      expect(token).toBe('fresh-refreshed-token-789');
      expect(mockStorage.bearer_token).toBe('fresh-refreshed-token-789');
    });

    it('returns null if auto-pairing fails', async () => {
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Connection refused'));

      const token = await ensureBearerToken();
      expect(token).toBeNull();
      expect(mockStorage.bearer_token).toBeUndefined();
    });
  });

  describe('acquireBearerToken', () => {
    it('reports unreachable when the daemon cannot be contacted', async () => {
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Connection refused'));
      expect(await acquireBearerToken()).toEqual({ token: null, reason: 'unreachable' });
    });

    it('reports unpaired when the daemon refuses to issue a token', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 403 });
      expect(await acquireBearerToken()).toEqual({ token: null, reason: 'unpaired' });
    });

    it('reports unpaired when the daemon answers without a token', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      expect(await acquireBearerToken()).toEqual({ token: null, reason: 'unpaired' });
    });
  });

  describe('callDaemonRpc', () => {
    it('executes successful RPC call with Bearer token', async () => {
      mockStorage.bearer_token = 'valid-token';
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ item: { id: 'k8s#100' } }),
      });

      const res = await callDaemonRpc<{ itemId: string }, { item: any }>('GetItem', { itemId: 'k8s#100' });
      expect(res.item.id).toBe('k8s#100');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('octodeck.v1.OctoDeckService/GetItem'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        })
      );
    });

    it('automatically re-pairs and retries on 401 Unauthorized (e.g. database wipe)', async () => {
      mockStorage.bearer_token = 'stale-invalid-token';

      // 1st call -> 401 Unauthorized
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      // 2nd call -> auto-pairing /auth/companion-token
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'brand-new-token-after-wipe' }),
      });

      // 3rd call -> retried RPC GetItem succeeds
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ item: { id: 'k8s#100', title: 'Restored' } }),
      });

      const res = await callDaemonRpc<{ itemId: string }, { item: any }>('GetItem', { itemId: 'k8s#100' });
      expect(res.item.title).toBe('Restored');
      expect(mockStorage.bearer_token).toBe('brand-new-token-after-wipe');
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('throws formatted error if retry fails or non-401 error occurs', async () => {
      mockStorage.bearer_token = 'valid-token';
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(
        callDaemonRpc('GetItem', { itemId: 'k8s#100' })
      ).rejects.toThrow('Daemon RPC GetItem failed (500): Internal server error');
    });
  });

  describe('known bots synchronization', () => {
    it('syncKnownBots fetches knownBots from GetConfig and saves to chrome.storage.local', async () => {
      const { syncKnownBots } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            config: {
              knownBots: ['k8s-ci-robot', 'kubernetes-prow'],
            },
          }),
      });

      const bots = await syncKnownBots();
      expect(bots).toEqual(['k8s-ci-robot', 'kubernetes-prow']);
      expect(mockStorage.known_bots).toEqual(['k8s-ci-robot', 'kubernetes-prow']);
    });

    it('syncs latest known bots from daemon before updating config in ADD_KNOWN_BOTS', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';

      // 1. GetConfig (sync before write)
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            config: {
              knownBots: ['k8s-ci-robot', 'renovate'],
            },
          }),
      });

      // 2. UpdateConfig
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            config: {
              knownBots: ['k8s-ci-robot', 'new-bot', 'renovate'],
            },
          }),
      });

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage(
          { type: 'ADD_KNOWN_BOTS', logins: ['new-bot'] },
          {} as any,
          (res: any) => resolve(res)
        );
      });

      expect(response.ok).toBe(true);
      expect(response.data).toEqual(['k8s-ci-robot', 'new-bot', 'renovate']);
      expect(mockStorage.known_bots).toEqual(['k8s-ci-robot', 'new-bot', 'renovate']);

      // The update is masked to known_bots, with the FieldMask in its protojson string form
      // (the daemon's JSON decoder rejects the object form).
      const [url, init] = (globalThis.fetch as any).mock.calls[1];
      expect(url).toContain('/octodeck.v1.OctoDeckService/UpdateConfig');
      const body = JSON.parse(init.body);
      expect(body.updateMask).toBe('knownBots');
      const decoded = fromJson(UpdateConfigRequestSchema, body);
      expect(decoded.updateMask?.paths).toEqual(['known_bots']);
      expect(decoded.config?.knownBots).toEqual(['k8s-ci-robot', 'renovate', 'new-bot']);
    });

    it('returns null and does not overwrite storage when syncKnownBots fails', async () => {
      const { syncKnownBots } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      mockStorage.known_bots = ['existing-bot'];
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const bots = await syncKnownBots();
      expect(bots).toBeNull();
      expect(mockStorage.known_bots).toEqual(['existing-bot']);
    });

    it('aborts ADD_KNOWN_BOTS when backend sync fails and leaves storage untouched', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      mockStorage.known_bots = ['existing-bot'];

      // GetConfig fails
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Daemon offline'));

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage(
          { type: 'ADD_KNOWN_BOTS', logins: ['some-bot'] },
          {} as any,
          (res: any) => resolve(res)
        );
      });

      expect(response.ok).toBe(false);
      expect(response.error).toContain('Could not sync latest known bots from backend');
      expect(mockStorage.known_bots).toEqual(['existing-bot']);
    });

    it('aborts ADD_KNOWN_BOTS when UpdateConfig fails and leaves storage untouched', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      mockStorage.known_bots = ['existing-bot'];

      // 1. GetConfig succeeds
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            config: {
              knownBots: ['existing-bot'],
            },
          }),
      });

      // 2. UpdateConfig fails
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Update failed'));

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage(
          { type: 'ADD_KNOWN_BOTS', logins: ['some-bot'] },
          {} as any,
          (res: any) => resolve(res)
        );
      });

      expect(response.ok).toBe(false);
      expect(response.error).toContain('Failed to update known bots in backend');
      expect(mockStorage.known_bots).toEqual(['existing-bot']);
    });
  });

  describe('Action Refetch / Sync extension messages (REFETCH_ITEM, SYNC_ITEM)', () => {
    it('handles REFETCH_ITEM message by invoking the daemon RefetchItem ConnectRPC endpoint', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';

      (globalThis.fetch as any).mockImplementation((url: string, opts: any) => {
        if (url.endsWith('/octodeck.v1.OctoDeckService/RefetchItem')) {
          const body = JSON.parse(opts.body);
          expect(body).toEqual({ itemId: 'tallclair/octodeck#101' });
          expect(opts.headers?.Authorization).toBe('Bearer valid-token');
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                item: {
                  id: 'tallclair/octodeck#101',
                  title: 'Updated PR after user action',
                  local: { computedStatus: ItemStatus.ACKED },
                },
              }),
          });
        }
        if (url.endsWith('/status')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: '2.0.0', gh_authenticated: true }),
          });
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      });

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage(
          { type: 'REFETCH_ITEM', itemId: 'tallclair/octodeck#101' },
          {} as any,
          (res: any) => resolve(res)
        );
      });

      expect(response.ok).toBe(true);
      expect(response.data).toEqual({
        id: 'tallclair/octodeck#101',
        title: 'Updated PR after user action',
        local: { computedStatus: ItemStatus.ACKED },
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/octodeck.v1.OctoDeckService/RefetchItem'),
        expect.any(Object)
      );
    });

    it('handles SYNC_ITEM message by invoking the daemon RefetchItem ConnectRPC endpoint', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';

      (globalThis.fetch as any).mockImplementation((url: string, opts: any) => {
        if (url.endsWith('/octodeck.v1.OctoDeckService/RefetchItem')) {
          const body = JSON.parse(opts.body);
          expect(body).toEqual({ itemId: 'tallclair/octodeck#202' });
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                item: {
                  id: 'tallclair/octodeck#202',
                  title: 'Sync item',
                },
              }),
          });
        }
        if (url.endsWith('/status')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      });

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage(
          { type: 'SYNC_ITEM', itemId: 'tallclair/octodeck#202' },
          {} as any,
          (res: any) => resolve(res)
        );
      });

      expect(response.ok).toBe(true);
      expect(response.data.id).toBe('tallclair/octodeck#202');
    });
  });

  describe('Concurrent HTTP 401 Token Refresh Thundering Herd (FE-03)', () => {
    it('shares the same in-flight token refresh promise when ensureBearerToken(true) is called concurrently', async () => {
      let resolveFetch: (value: any) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });

      (globalThis.fetch as any).mockImplementationOnce(() => fetchPromise);

      // Launch two concurrent calls to ensureBearerToken(true)
      const promise1 = ensureBearerToken(true);
      const promise2 = ensureBearerToken(true);

      // Both calls wait on the same in-flight pairing request.
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      resolveFetch!({
        ok: true,
        json: () => Promise.resolve({ access_token: 'shared-fresh-token' }),
      });

      const [token1, token2] = await Promise.all([promise1, promise2]);
      expect(token1).toBe('shared-fresh-token');
      expect(token2).toBe('shared-fresh-token');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('badge', () => {
    it('applies the badge pushed by the daemon', () => {
      applyBadge(
        create(BadgeUpdateSchema, {
          count: 3,
          mode: BadgeCountMode.INBOX,
          text: '3',
          tooltip: 'OctoDeck (3 inbox items)',
        })
      );
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '3' });
      expect(chrome.action.setTitle).toHaveBeenCalledWith({ title: 'OctoDeck (3 inbox items)' });
    });

    it('clears the badge text when the daemon sends an empty badge', () => {
      applyBadge(create(BadgeUpdateSchema, { mode: BadgeCountMode.DISABLED, text: '', tooltip: '' }));
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(chrome.action.setTitle).toHaveBeenCalledWith({ title: 'Open OctoDeck Dashboard' });
    });

    it('sets red ! badge when the daemon is offline', () => {
      applyStreamStatus('offline');
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#dc2626' });
    });

    it('sets orange SETUP badge when the extension is not paired', () => {
      applyStreamStatus('setup');
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'SETUP' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#f97316' });
    });

    it('sets orange UPD badge when daemon and extension versions differ', () => {
      applyStreamStatus('version-mismatch');
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'UPD' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#f97316' });
    });

    it('leaves the badge alone on connect (the daemon sends it)', () => {
      applyStreamStatus('connected');
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
    });
  });

  describe('desktop notifications', () => {
    const itemUrl = `${DEFAULT_BASE_URL}/?item=PR_kwDO12345`;
    const notification = () =>
      create(NotificationSchema, {
        id: 'PR_kwDO12345@1700000000000',
        itemId: 'PR_kwDO12345',
        title: 'kubernetes/kubernetes #100',
        message: 'New activity: Fix kubelet',
        url: itemUrl,
      });

    it('shows the notification under its daemon-assigned id', async () => {
      await showNotification(notification());
      expect(chrome.notifications.create).toHaveBeenCalledWith(
        'PR_kwDO12345@1700000000000',
        expect.objectContaining({
          type: 'basic',
          title: 'kubernetes/kubernetes #100',
          message: 'New activity: Fix kubelet',
        })
      );
      expect(mockSession.notification_urls).toEqual({ 'PR_kwDO12345@1700000000000': itemUrl });
    });

    it('does not show the same notification twice (replayed after reconnect)', async () => {
      await showNotification(notification());
      await showNotification(notification());
      expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    });

    it('bounds the remembered click targets', async () => {
      for (let i = 0; i < 205; i++) {
        await showNotification(create(NotificationSchema, { id: `n${i}`, url: itemUrl }));
      }
      const ids = Object.keys(mockSession.notification_urls);
      expect(ids).toHaveLength(200);
      expect(ids[0]).toBe('n5');
    });

    it('shows a catch-up summary that opens the inbox', async () => {
      const inbox = `${DEFAULT_BASE_URL}/?triage=inbox`;
      await showSummary(
        create(NotificationSummarySchema, { count: 5, title: 'OctoDeck', message: '5 items need your attention', url: inbox }),
        timestampFromMs(1700000000000)
      );
      expect(chrome.notifications.create).toHaveBeenCalledWith(
        expect.stringMatching(/^summary:/),
        expect.objectContaining({ message: '5 items need your attention' })
      );
      expect(Object.values(mockSession.notification_urls)).toEqual([inbox]);
    });

    it('navigates an existing dashboard tab to the notification target on click', async () => {
      await showNotification(notification());
      (chrome.tabs.query as any).mockResolvedValueOnce([{ id: 7, windowId: 3 }]);

      await handleNotificationClick('PR_kwDO12345@1700000000000');

      expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: itemUrl, active: true });
      expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
      expect(chrome.notifications.clear).toHaveBeenCalledWith('PR_kwDO12345@1700000000000');
    });

    it('opens a new dashboard tab when none is open', async () => {
      await showNotification(notification());
      await handleNotificationClick('PR_kwDO12345@1700000000000');
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: itemUrl });
    });

    it('falls back to the dashboard for unknown notifications', async () => {
      await handleNotificationClick('unknown');
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${DEFAULT_BASE_URL}/` });
    });

    it('only allows click targets on the dashboard origin', () => {
      expect(safeDashboardUrl(itemUrl)).toBe(itemUrl);
      expect(safeDashboardUrl('https://evil.example.com/phish')).toBe(`${DEFAULT_BASE_URL}/`);
      expect(safeDashboardUrl('javascript:alert(1)')).toBe(`${DEFAULT_BASE_URL}/`);
      expect(safeDashboardUrl('not a url')).toBe(`${DEFAULT_BASE_URL}/`);
      expect(safeDashboardUrl(undefined)).toBe(`${DEFAULT_BASE_URL}/`);
    });

    it('stores the dashboard instead of a foreign notification url', async () => {
      await showNotification(create(NotificationSchema, { id: 'n1', url: 'https://evil.example.com/' }));
      expect(mockSession.notification_urls).toEqual({ n1: `${DEFAULT_BASE_URL}/` });
    });

    it('does not navigate to a foreign stored url on click', async () => {
      mockSession.notification_urls = { n1: 'https://evil.example.com/' };
      await handleNotificationClick('n1');
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${DEFAULT_BASE_URL}/` });
    });
  });

  describe('cursor store', () => {
    const cursor = (ms: number) => timestampFromMs(ms);

    it('writes session storage on every save and local storage at most once per interval', async () => {
      let now = 1_000_000;
      const store = createCursorStore(() => now);

      await store.saveCursor(cursor(1000), false);
      const first = mockStorage.last_received_at;
      expect(first).toBeDefined();
      expect(mockSession.last_received_at).toBe(first);

      now += 1000;
      await store.saveCursor(cursor(2000), false);
      expect(mockStorage.last_received_at).toBe(first);
      expect(mockSession.last_received_at).not.toBe(first);

      now += CURSOR_PERSIST_INTERVAL_MS;
      await store.saveCursor(cursor(3000), false);
      expect(mockStorage.last_received_at).toBe(mockSession.last_received_at);
    });

    it('always persists durable cursors locally', async () => {
      const now = 1_000_000;
      const store = createCursorStore(() => now);
      await store.saveCursor(cursor(1000), false);
      await store.saveCursor(cursor(2000), true);
      expect(mockStorage.last_received_at).toBe(mockSession.last_received_at);
    });

    it('loads the session cursor in preference to the local one', async () => {
      const writer = createCursorStore(() => 0);
      await writer.saveCursor(cursor(1000), true);
      const local = mockStorage.last_received_at;
      await writer.saveCursor(cursor(5000), false);

      expect((await createCursorStore().loadCursor())?.seconds).toBe(5n);

      mockSession = {};
      mockStorage.last_received_at = local;
      expect((await createCursorStore().loadCursor())?.seconds).toBe(1n);
    });
  });

  describe('watchdog alarm', () => {
    it('creates the alarm when it is missing', async () => {
      await ensureWatchdogAlarm();
      expect(chrome.alarms.create).toHaveBeenCalledWith(WATCHDOG_ALARM, { periodInMinutes: 1 });
    });

    it('keeps an existing alarm', async () => {
      (chrome.alarms.get as any).mockResolvedValueOnce({ name: WATCHDOG_ALARM, periodInMinutes: 1 });
      await ensureWatchdogAlarm();
      expect(chrome.alarms.create).not.toHaveBeenCalled();
    });
  });

  describe('notification settings bridge', () => {
    it('reads notification settings from the daemon config', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ config: { notificationSettings: { enabled: true, repoExcludes: ['a/b'] } } }),
      });

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage({ type: 'GET_NOTIFICATION_SETTINGS' }, {} as any, resolve);
      });

      expect(response).toEqual({ ok: true, data: { enabled: true, repoExcludes: ['a/b'] } });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/octodeck.v1.OctoDeckService/GetConfig'),
        expect.any(Object)
      );
    });

    it('saves notification settings with a field mask limited to notification_settings', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      const settings = { enabled: false, badgeCountMode: 'BADGE_COUNT_MODE_UNREAD' };
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ config: { notificationSettings: settings } }),
      });

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage({ type: 'SAVE_NOTIFICATION_SETTINGS', settings }, {} as any, resolve);
      });

      expect(response).toEqual({ ok: true, data: settings });
      const [url, opts] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toContain('/octodeck.v1.OctoDeckService/UpdateConfig');
      expect(JSON.parse(opts.body)).toEqual({
        config: { notificationSettings: settings },
        updateMask: 'notificationSettings',
      });
    });

    it('reports failure when the daemon is unreachable', async () => {
      const { handleExtensionMessage } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Failed to fetch'));

      const response = await new Promise<any>((resolve) => {
        handleExtensionMessage({ type: 'GET_NOTIFICATION_SETTINGS' }, {} as any, resolve);
      });
      expect(response.ok).toBe(false);
    });
  });

  describe('cleanUpObsoleteState', () => {
    it('clears the legacy poll alarm and storage keys', async () => {
      mockStorage = {
        bearer_token: 'keep',
        known_bots: ['keep-bot'],
        notification_filters: {},
        last_notified_timestamps: {},
        last_known_user_login: 'me',
        badge_count_mode: 'inbox',
      };
      await cleanUpObsoleteState();
      expect(chrome.alarms.clear).toHaveBeenCalledWith('octodeck_poll_notifications');
      expect(mockStorage).toEqual({ bearer_token: 'keep', known_bots: ['keep-bot'] });
    });
  });
});
