/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ensureBearerToken,
  callDaemonRpc,
  updateBadgeState,
  formatBadgeText,
  computeBadgeCount,
  isItemInbox,
  isItemUnread,
} from '../background';
import { ItemStatus } from '../../api/octodeck/v1/resources_pb';
import { DEFAULT_BASE_URL } from '../../utils/constants';

describe('Extension Background Service Worker', () => {
  let mockStorage: Record<string, any> = {};

  beforeEach(() => {
    mockStorage = {};
    globalThis.fetch = vi.fn();

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn((keys: string[]) => {
            const res: Record<string, any> = {};
            keys.forEach((k) => {
              if (k in mockStorage) res[k] = mockStorage[k];
            });
            return Promise.resolve(res);
          }),
          set: vi.fn((data: Record<string, any>) => {
            mockStorage = { ...mockStorage, ...data };
            return Promise.resolve();
          }),
          remove: vi.fn((key: string) => {
            delete mockStorage[key];
            return Promise.resolve();
          }),
        },
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

  describe('formatBadgeText', () => {
    it('returns empty string when count is 0 or negative', () => {
      expect(formatBadgeText(0, 'inbox')).toBe('');
      expect(formatBadgeText(-5, 'inbox')).toBe('');
    });

    it('returns empty string when badge mode is disabled', () => {
      expect(formatBadgeText(10, 'disabled')).toBe('');
      expect(formatBadgeText(100, 'disabled')).toBe('');
    });

    it('returns count as string for values from 1 to 99', () => {
      expect(formatBadgeText(1, 'inbox')).toBe('1');
      expect(formatBadgeText(42, 'inbox')).toBe('42');
      expect(formatBadgeText(99, 'inbox')).toBe('99');
    });

    it('returns * when count exceeds 99', () => {
      expect(formatBadgeText(100, 'inbox')).toBe('*');
      expect(formatBadgeText(999, 'unread')).toBe('*');
    });
  });

  describe('computeBadgeCount & item classification', () => {
    const testItems: any[] = [
      { id: '1', local: { computedStatus: ItemStatus.NEW } },
      { id: '2', local: { computedStatus: ItemStatus.NEW_ACTIVITY } },
      { id: '3', local: { computedStatus: ItemStatus.IDLE } },
      { id: '4', local: { computedStatus: ItemStatus.NOISE } },
      { id: '5', local: { computedStatus: ItemStatus.ACKED } },
    ];

    it('identifies inbox items (all unacknowledged)', () => {
      expect(isItemInbox(testItems[0])).toBe(true);
      expect(isItemInbox(testItems[1])).toBe(true);
      expect(isItemInbox(testItems[2])).toBe(true);
      expect(isItemInbox(testItems[3])).toBe(true);
      expect(isItemInbox(testItems[4])).toBe(false);
    });

    it('identifies unread/new items (unacknowledged and not idle/noise)', () => {
      expect(isItemUnread(testItems[0])).toBe(true);
      expect(isItemUnread(testItems[1])).toBe(true);
      expect(isItemUnread(testItems[2])).toBe(false); // IDLE
      expect(isItemUnread(testItems[3])).toBe(false); // NOISE
      expect(isItemUnread(testItems[4])).toBe(false); // ACKED
    });

    it('computes correct count based on selected mode', () => {
      expect(computeBadgeCount(testItems, 'inbox')).toBe(4);
      expect(computeBadgeCount(testItems, 'unread')).toBe(2);
      expect(computeBadgeCount(testItems, 'disabled')).toBe(0);
    });
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

  describe('updateBadgeState', () => {
    it('sets red ! badge when daemon is offline', async () => {
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Failed to fetch'));

      await updateBadgeState();

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#dc2626' });
    });

    it('sets orange SETUP badge when daemon is online but no token exists', async () => {
      // /status returns online
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0', gh_authenticated: true }),
      });
      // /auth/companion-token fails
      (globalThis.fetch as any).mockRejectedValueOnce(new Error('Forbidden'));

      await updateBadgeState();

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'SETUP' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#f97316' });
    });

    it('displays inbox count badge when daemon is online and authenticated', async () => {
      mockStorage.bearer_token = 'active-token';
      mockStorage.badge_count_mode = 'inbox';

      // 1. /status
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0', gh_authenticated: true }),
      });
      // 2. /GetItems
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              { id: '1', local: { computedStatus: ItemStatus.NEW } },
              { id: '2', local: { computedStatus: ItemStatus.ACKED } },
              { id: '3', local: { computedStatus: ItemStatus.IDLE } },
            ],
          }),
      });

      await updateBadgeState();

      // 2 unacked items in inbox
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '2' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#2563eb' });
    });

    it('displays unread count badge when unread mode is configured', async () => {
      mockStorage.bearer_token = 'active-token';
      mockStorage.badge_count_mode = 'unread';

      // 1. /status
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0', gh_authenticated: true }),
      });
      // 2. /GetItems
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              { id: '1', local: { computedStatus: ItemStatus.NEW } },
              { id: '2', local: { computedStatus: ItemStatus.ACKED } },
              { id: '3', local: { computedStatus: ItemStatus.IDLE } },
            ],
          }),
      });

      await updateBadgeState();

      // 1 unread (item 1: NEW)
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#2563eb' });
    });

    it('displays * when count exceeds 99', async () => {
      mockStorage.bearer_token = 'active-token';
      mockStorage.badge_count_mode = 'inbox';

      // 1. /status
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0', gh_authenticated: true }),
      });
      // 2. /GetItems with 120 items
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: `item-${i}`,
        local: { computedStatus: ItemStatus.NEW },
      }));
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items }),
      });

      await updateBadgeState();

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '*' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#2563eb' });
    });

    it('clears badge when disabled mode is selected', async () => {
      mockStorage.bearer_token = 'active-token';
      mockStorage.badge_count_mode = 'disabled';

      // 1. /status
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0', gh_authenticated: true }),
      });

      await updateBadgeState();

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
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
        if (url.endsWith('/GetItems')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [] }),
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
        if (url.endsWith('/status') || url.endsWith('/GetItems')) {
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

      expect(promise1).toBe(promise2);

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

  describe('Extension Storage Timestamp Race Condition (FE-02)', () => {
    it('re-reads last_notified_timestamps after GetItems RPC finishes before writing back to storage', async () => {
      const { pollNotifications } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      mockStorage.notification_filters = { enabled: true };
      mockStorage.last_notified_timestamps = { 'old-item': 1000 };

      (globalThis.fetch as any).mockImplementation((url: string) => {
        if (url.endsWith('/GetConfig')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          });
        }
        if (url.endsWith('/GetItems')) {
          // Simulate concurrent storage update while GetItems was in flight
          mockStorage.last_notified_timestamps = { 'old-item': 1000, 'concurrent-item': 9999 };
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  {
                    id: 'new-item',
                    updatedAt: { seconds: 2000n, nanos: 0 },
                    local: { computedStatus: ItemStatus.NEW },
                  },
                ],
              }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      await pollNotifications();

      // Verify that concurrent-item was preserved from the fresh re-read of chrome.storage.local
      expect(mockStorage.last_notified_timestamps).toHaveProperty('concurrent-item', 9999);
      expect(mockStorage.last_notified_timestamps).toHaveProperty('new-item', 2000000);
      expect(mockStorage.last_notified_timestamps).toHaveProperty('old-item', 1000);
    });
  });

  describe('Notification Click Navigation to Dashboard Item Details', () => {
    it('creates notification with octodeck dashboard item URL', async () => {
      const { pollNotifications } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      mockStorage.notification_filters = {
        enabled: true,
        notifyOnNewItems: true,
        notifyOnNewActivity: true,
        ignoreBots: false,
        repos: [],
        labels: [],
        authors: [],
      };
      mockStorage.last_notified_timestamps = { 'item-1': 1000 };

      (globalThis.fetch as any).mockImplementation((url: string) => {
        if (url.endsWith('/GetConfig')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ currentUserLogin: 'my-user' }),
          });
        }
        if (url.endsWith('/GetItems')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  {
                    id: 'PR_kwDO12345',
                    repo: 'kubernetes/kubernetes',
                    number: 141039,
                    title: 'Update checkpoint',
                    author: { login: 'my-user' },
                    updatedAt: { seconds: 3000n, nanos: 0 },
                    local: { computedStatus: ItemStatus.NEW },
                  },
                ],
              }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      await pollNotifications();

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        `${DEFAULT_BASE_URL}/?item=PR_kwDO12345`,
        expect.objectContaining({
          type: 'basic',
          title: expect.stringContaining('kubernetes/kubernetes #141039'),
        })
      );
    });

    it('suppresses notification when update is from self-activity (own comment)', async () => {
      const { pollNotifications } = await import('../background');
      mockStorage.bearer_token = 'valid-token';
      mockStorage.notification_filters = {
        enabled: true,
        notifyOnNewItems: true,
        notifyOnNewActivity: true,
        ignoreBots: true,
        repos: [],
        labels: [],
        authors: [],
      };
      mockStorage.last_notified_timestamps = { 'PR_kwDO12345': 2000000 };

      (globalThis.fetch as any).mockImplementation((url: string) => {
        if (url.endsWith('/GetConfig')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ currentUserLogin: 'my-user' }),
          });
        }
        if (url.endsWith('/GetItems')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  {
                    id: 'PR_kwDO12345',
                    repo: 'kubernetes/kubernetes',
                    number: 141039,
                    title: 'Update checkpoint',
                    author: { login: 'alice' },
                    updatedAt: { seconds: 3000n, nanos: 0 },
                    comments: [
                      {
                        author: { login: 'my-user' },
                        bodyText: 'I reviewed this, looks good!',
                        createdAt: { seconds: 3000n, nanos: 0 },
                      },
                    ],
                  },
                ],
              }),
          });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      await pollNotifications();

      expect(chrome.notifications.create).not.toHaveBeenCalled();
      expect(mockStorage.last_notified_timestamps).toHaveProperty('PR_kwDO12345', 3000000);
    });

    it('navigates existing dashboard tab to item details on notification click', async () => {
      const { handleNotificationClick } = await import('../background');

      // Setup existing dashboard tab
      (chrome.tabs.query as any).mockResolvedValueOnce([{ id: 10, windowId: 5 }]);

      await handleNotificationClick(`${DEFAULT_BASE_URL}/?item=PR_kwDO12345`);

      expect(chrome.tabs.update).toHaveBeenCalledWith(10, {
        url: `${DEFAULT_BASE_URL}/?item=PR_kwDO12345`,
        active: true,
      });
      expect(chrome.windows.update).toHaveBeenCalledWith(5, { focused: true });
      expect(chrome.notifications.clear).toHaveBeenCalledWith(`${DEFAULT_BASE_URL}/?item=PR_kwDO12345`);
    });

    it('creates new dashboard tab when no existing tab is open on notification click', async () => {
      const { handleNotificationClick } = await import('../background');

      (chrome.tabs.query as any).mockResolvedValueOnce([]);

      await handleNotificationClick(`${DEFAULT_BASE_URL}/?item=PR_kwDO99999`);

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: `${DEFAULT_BASE_URL}/?item=PR_kwDO99999`,
      });
      expect(chrome.notifications.clear).toHaveBeenCalledWith(`${DEFAULT_BASE_URL}/?item=PR_kwDO99999`);
    });
  });
});

