import { DEFAULT_BASE_URL, DEFAULT_API_BASE_URL } from '../utils/constants';
import type {
  ExtensionMessage,
  ExtensionResponse,
  StoredExtensionData,
  DaemonStatus,
  BadgeCountMode,
} from './types';
import { DEFAULT_NOTIFICATION_FILTERS, DEFAULT_BADGE_COUNT_MODE } from './types';
import { shouldNotifyItem, buildNotificationContent } from './notifications';
import { ItemStatus, type Item } from '../api/octodeck/v1/resources_pb';
import type { GetConfigResponse, GetItemsResponse } from '../api/octodeck/v1/service_pb';
import { getProtoTimestampMs } from '../logic/timeline';

const DASHBOARD_URL = `${DEFAULT_BASE_URL}/`;
const ALARM_NAME = 'octodeck_poll_notifications';

async function getStoredData<K extends keyof StoredExtensionData>(keys: K[]): Promise<Pick<StoredExtensionData, K>> {
  return (await chrome.storage.local.get(keys)) as Pick<StoredExtensionData, K>;
}

async function setStoredData(data: Partial<StoredExtensionData>): Promise<void> {
  await chrome.storage.local.set(data);
}

// ---------------------------------------------------------------------------
// Daemon RPC Client Helpers
// ---------------------------------------------------------------------------

let refreshingTokenPromise: Promise<string | null> | null = null;

export function ensureBearerToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    return getStoredData(['bearer_token']).then((data) => {
      if (data.bearer_token) {
        return data.bearer_token;
      }
      return doRefreshToken();
    });
  }
  return doRefreshToken();
}

function doRefreshToken(): Promise<string | null> {
  if (refreshingTokenPromise) {
    return refreshingTokenPromise;
  }

  refreshingTokenPromise = (async () => {
    try {
      const res = await fetch(`${DEFAULT_API_BASE_URL}/auth/companion-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (res.ok) {
        const json = await res.json();
        if (json.access_token) {
          await setStoredData({ bearer_token: json.access_token });
          return json.access_token;
        }
      }
    } catch (err) {
      console.debug('[OctoDeck BG] Failed to auto-pair token:', err);
    } finally {
      refreshingTokenPromise = null;
    }
    return null;
  })();

  return refreshingTokenPromise;
}

export async function getBearerToken(): Promise<string | null> {
  return ensureBearerToken();
}

export async function callDaemonRpc<TReq, TRes>(methodName: string, req: TReq, isRetry = false): Promise<TRes> {
  const token = await ensureBearerToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${DEFAULT_API_BASE_URL}/octodeck.v1.OctoDeckService/${methodName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });

  if (res.status === 401 && !isRetry) {
    console.log(`[OctoDeck BG] RPC ${methodName} returned 401 Unauthorized -> attempting token refresh & retry`);
    await chrome.storage.local.remove('bearer_token');
    const freshToken = await ensureBearerToken(true);
    if (freshToken) {
      return callDaemonRpc<TReq, TRes>(methodName, req, true);
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Daemon RPC ${methodName} failed (${res.status}): ${text || res.statusText}`);
  }

  return res.json();
}

export async function checkDaemonStatus(): Promise<DaemonStatus> {
  try {
    const data = await getStoredData(['bearer_token']);
    const headers: Record<string, string> = {};
    if (data.bearer_token) {
      headers['Authorization'] = `Bearer ${data.bearer_token}`;
    }
    const res = await fetch(`${DEFAULT_API_BASE_URL}/status`, { headers });
    if (!res.ok) {
      return { online: false, error: `HTTP ${res.status}` };
    }
    const resData = await res.json();
    return {
      online: true,
      version: resData.version,
      ghAuthenticated: resData.gh_authenticated,
      error: resData.error,
    };
  } catch (err) {
    return { online: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Badge State Management & Item Count Helpers
// ---------------------------------------------------------------------------

export function isItemAcked(item?: Item | null): boolean {
  if (!item || !item.local) return false;
  const s = item.local.computedStatus as unknown;
  return s === ItemStatus.ACKED || s === 5 || s === 'ITEM_STATUS_ACKED' || s === 'ACKED';
}

export function isItemInbox(item?: Item | null): boolean {
  if (!item) return false;
  return !isItemAcked(item);
}

export function isItemUnread(item?: Item | null): boolean {
  if (!item || !item.local) return false;
  const s = item.local.computedStatus as unknown;
  if (s === ItemStatus.ACKED || s === 5 || s === 'ITEM_STATUS_ACKED' || s === 'ACKED') return false;
  if (s === ItemStatus.IDLE || s === 4 || s === 'ITEM_STATUS_IDLE' || s === 'IDLE') return false;
  if (s === ItemStatus.NOISE || s === 6 || s === 'ITEM_STATUS_NOISE' || s === 'NOISE') return false;
  return true;
}

export function computeBadgeCount(items: Item[], mode: BadgeCountMode): number {
  if (mode === 'disabled') return 0;
  if (mode === 'unread') {
    return items.filter(isItemUnread).length;
  }
  return items.filter(isItemInbox).length;
}

export function formatBadgeText(count: number, mode: BadgeCountMode = 'inbox'): string {
  if (mode === 'disabled' || count <= 0) {
    return '';
  }
  if (count > 99) {
    return '*';
  }
  return String(count);
}

export async function updateBadgeState(): Promise<void> {
  const status = await checkDaemonStatus();

  if (!status.online) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); // Bright red badge
    chrome.action.setTitle({ title: 'OctoDeck daemon is offline' });
    return;
  }

  if (status.error === 'Invalid Token') {
    console.log('[OctoDeck BG] Status reported Invalid Token -> refreshing token');
    await chrome.storage.local.remove('bearer_token');
    await ensureBearerToken(true);
  }

  const token = await ensureBearerToken();
  if (!token) {
    chrome.action.setBadgeText({ text: 'SETUP' });
    chrome.action.setBadgeBackgroundColor({ color: '#f97316' }); // Orange badge
    chrome.action.setTitle({ title: 'Open OctoDeck Dashboard to pair companion extension' });
    return;
  }

  const data = await getStoredData(['badge_count_mode']);
  const mode: BadgeCountMode = data.badge_count_mode || DEFAULT_BADGE_COUNT_MODE;

  if (mode === 'disabled') {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Open OctoDeck Dashboard' });
    return;
  }

  try {
    const itemsResp = await callDaemonRpc<Record<string, never>, GetItemsResponse>('GetItems', {});
    const items = itemsResp.items || [];
    const count = computeBadgeCount(items, mode);
    const badgeText = formatBadgeText(count, mode);

    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    chrome.action.setTitle({
      title:
        count > 0
          ? `OctoDeck (${count} ${mode === 'unread' ? 'unread' : 'inbox'} items)`
          : 'Open OctoDeck Dashboard',
    });
  } catch (err) {
    console.debug('[OctoDeck BG] Failed to fetch items for badge count:', err);
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Open OctoDeck Dashboard' });
  }
}

// ---------------------------------------------------------------------------
// Notifications Polling Engine
// ---------------------------------------------------------------------------

export async function pollNotifications(): Promise<void> {
  const token = await getBearerToken();
  if (!token) return;

  const storage = await getStoredData([
    'notification_filters',
    'last_notified_timestamps',
    'last_known_user_login',
  ]);

  const filters = { ...DEFAULT_NOTIFICATION_FILTERS, ...(storage.notification_filters || {}) };
  if (!filters.enabled) return;

  let currentUserLogin = storage.last_known_user_login;
  try {
    const configResp = await callDaemonRpc<Record<string, never>, GetConfigResponse>('GetConfig', {});
    if (configResp.currentUserLogin) {
      currentUserLogin = configResp.currentUserLogin;
      await setStoredData({ last_known_user_login: currentUserLogin });
    }
    if (configResp.config?.knownBots) {
      await setStoredData({ known_bots: configResp.config.knownBots });
    }
  } catch {
    // Non-fatal if config check fails
  }

  let items: Item[] = [];
  try {
    const itemsResp = await callDaemonRpc<Record<string, never>, GetItemsResponse>('GetItems', {});
    items = itemsResp.items || [];
  } catch (err) {
    console.debug('OctoDeck: Failed to fetch items for notifications:', err);
    return;
  }

  const freshStorage = await getStoredData(['last_notified_timestamps']);
  const timestamps: Record<string, number> = {
    ...(storage.last_notified_timestamps || {}),
    ...(freshStorage.last_notified_timestamps || {}),
  };
  const isFirstRun = Object.keys(timestamps).length === 0;

  for (const item of items) {
    if (!item || !item.id) continue;
    const itemId = item.id;
    const itemUpdatedAtMs = getProtoTimestampMs(item.updatedAt);
    const lastNotifiedAt = timestamps[itemId];

    // If first run, record current timestamps without blasting all open items
    if (isFirstRun) {
      timestamps[itemId] = itemUpdatedAtMs;
      continue;
    }

    const shouldNotify = shouldNotifyItem(item, filters, currentUserLogin, lastNotifiedAt);
    if (shouldNotify) {
      const { title, message } = buildNotificationContent(item);
      const dashboardItemUrl = item.id
        ? `${DEFAULT_BASE_URL}/?item=${encodeURIComponent(item.id)}`
        : (item.repo && item.number
            ? `${DEFAULT_BASE_URL}/?item=${encodeURIComponent(`${item.repo}#${item.number}`)}`
            : DASHBOARD_URL);

      chrome.notifications.create(dashboardItemUrl, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-128.png'),
        title,
        message,
        priority: 1,
      });
    }

    timestamps[itemId] = itemUpdatedAtMs;
  }

  await setStoredData({ last_notified_timestamps: timestamps });
}

// ---------------------------------------------------------------------------
// Lifecycle & Event Listeners
// ---------------------------------------------------------------------------

export async function syncKnownBots(): Promise<string[] | null> {
  try {
    const configResp = await callDaemonRpc<Record<string, never>, GetConfigResponse>('GetConfig', {});
    if (configResp.config?.knownBots) {
      await setStoredData({ known_bots: configResp.config.knownBots });
      return configResp.config.knownBots;
    }
    return [];
  } catch (err) {
    console.debug('[OctoDeck BG] Failed to sync known bots:', err);
    return null;
  }
}

const inFlightRefetches = new Map<string, Promise<{ item: Item }>>();

export function handleExtensionMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (res: ExtensionResponse) => void
): boolean {
  console.log(
    `[OctoDeck BG] Message received: ${message.type} from ${
      sender?.tab ? `tab ${sender.tab.id} (${sender.tab.url})` : 'extension context'
    }`
  );

  const safeSendResponse = (res: ExtensionResponse) => {
    try {
      sendResponse(res);
    } catch (err) {
      console.debug('[OctoDeck BG] Could not send response (channel closed):', err);
    }
  };

  (async () => {
    try {
      switch (message.type) {
        case 'GET_ITEM': {
          if (!message.itemId) {
            safeSendResponse({ ok: false, error: 'itemId is required' });
            break;
          }
          const resp = await callDaemonRpc<{ itemId: string }, { item: Item }>('GetItem', { itemId: message.itemId });
          safeSendResponse({ ok: true, data: resp.item });
          break;
        }
        case 'VIEW_ITEM': {
          if (!message.itemId) {
            safeSendResponse({ ok: false, error: 'itemId is required' });
            break;
          }
          const resp = await callDaemonRpc<{ itemId: string }, { item: Item }>('ViewItem', { itemId: message.itemId });
          safeSendResponse({ ok: true, data: resp.item });
          break;
        }
        case 'ACK_ITEM': {
          if (!message.itemId) {
            safeSendResponse({ ok: false, error: 'itemId is required' });
            break;
          }
          const resp = await callDaemonRpc<{ itemId: string; acked?: boolean }, { item: Item }>('AckItem', {
            itemId: message.itemId,
            acked: message.acked,
          });
          safeSendResponse({ ok: true, data: resp.item });
          updateBadgeState().catch(() => {});
          break;
        }
        case 'STAR_ITEM': {
          if (!message.itemId) {
            safeSendResponse({ ok: false, error: 'itemId is required' });
            break;
          }
          const resp = await callDaemonRpc<{ itemId: string; starred: boolean }, { item: Item }>('StarItem', {
            itemId: message.itemId,
            starred: message.starred,
          });
          safeSendResponse({ ok: true, data: resp.item });
          break;
        }
        case 'SET_NOTES': {
          if (!message.itemId) {
            safeSendResponse({ ok: false, error: 'itemId is required' });
            break;
          }
          const resp = await callDaemonRpc<{ itemId: string; notes: string }, { item: Item }>('SetNotes', {
            itemId: message.itemId,
            notes: message.notes,
          });
          safeSendResponse({ ok: true, data: resp.item });
          break;
        }
        case 'REFETCH_ITEM':
        case 'SYNC_ITEM': {
          if (!message.itemId) {
            safeSendResponse({ ok: false, error: 'itemId is required' });
            break;
          }
          let prom = inFlightRefetches.get(message.itemId);
          if (!prom) {
            prom = callDaemonRpc<{ itemId: string }, { item: Item }>('RefetchItem', {
              itemId: message.itemId,
            });
            inFlightRefetches.set(message.itemId, prom);
            prom.finally(() => {
              if (inFlightRefetches.get(message.itemId) === prom) {
                inFlightRefetches.delete(message.itemId);
              }
            });
          }
          const resp = await prom;
          safeSendResponse({ ok: true, data: resp.item });
          updateBadgeState().catch(() => {});
          break;
        }
        case 'GET_CONFIG': {
          const resp = await callDaemonRpc<Record<string, never>, GetConfigResponse>('GetConfig', {});
          if (resp.config?.knownBots) {
            await setStoredData({ known_bots: resp.config.knownBots });
          }
          if (resp.currentUserLogin) {
            await setStoredData({ last_known_user_login: resp.currentUserLogin });
          }
          safeSendResponse({ ok: true, data: resp });
          break;
        }
        case 'GET_KNOWN_BOTS': {
          const data = await getStoredData(['known_bots']);
          if (data.known_bots && data.known_bots.length > 0) {
            safeSendResponse({ ok: true, data: data.known_bots });
          } else {
            const freshBots = await syncKnownBots();
            safeSendResponse({ ok: true, data: freshBots || data.known_bots || [] });
          }
          break;
        }
        case 'ADD_KNOWN_BOTS': {
          const currentBots = await syncKnownBots();
          if (currentBots === null) {
            console.debug('[OctoDeck BG] Aborting ADD_KNOWN_BOTS because backend sync failed');
            safeSendResponse({ ok: false, error: 'Could not sync latest known bots from backend' });
            break;
          }
          const newLogins = (message.logins || []).map((l) => l.trim()).filter(Boolean);
          const merged = Array.from(new Set([...currentBots, ...newLogins]));
          try {
            const resp = await callDaemonRpc<
              { config: { knownBots: string[] }; updateMask: { paths: string[] } },
              { config: { knownBots: string[] } }
            >('UpdateConfig', {
              config: { knownBots: merged },
              updateMask: { paths: ['known_bots'] },
            });
            const updatedBots = resp.config?.knownBots || merged;
            await setStoredData({ known_bots: updatedBots });
            safeSendResponse({ ok: true, data: updatedBots });
          } catch (err) {
            console.debug('[OctoDeck BG] Failed to update known bots in backend:', err);
            safeSendResponse({ ok: false, error: 'Failed to update known bots in backend' });
          }
          break;
        }
        case 'OPEN_DASHBOARD': {
          const targetUrl = message.itemId
            ? `${DASHBOARD_URL}?item=${encodeURIComponent(message.itemId)}`
            : DASHBOARD_URL;
          console.log(`[OctoDeck BG] Opening dashboard tab at ${targetUrl}`);
          chrome.tabs.create({ url: targetUrl });
          safeSendResponse({ ok: true, data: true });
          break;
        }
        case 'GET_DAEMON_STATUS': {
          const status = await checkDaemonStatus();
          safeSendResponse({ ok: true, data: status });
          break;
        }
        case 'GET_NOTIFICATION_FILTERS': {
          const data = await getStoredData(['notification_filters']);
          safeSendResponse({ ok: true, data: data.notification_filters || DEFAULT_NOTIFICATION_FILTERS });
          break;
        }
        case 'SAVE_NOTIFICATION_FILTERS': {
          await setStoredData({ notification_filters: message.filters });
          console.log('[OctoDeck BG] Saved updated notification filters:', message.filters);
          safeSendResponse({ ok: true, data: true });
          break;
        }
        case 'GET_HIDE_EVENTS': {
          const data = await getStoredData(['hide_events']);
          safeSendResponse({ ok: true, data: Boolean(data.hide_events) });
          break;
        }
        case 'SET_HIDE_EVENTS': {
          await setStoredData({ hide_events: message.hideEvents });
          safeSendResponse({ ok: true, data: true });
          break;
        }
        case 'GET_BADGE_COUNT_MODE': {
          const data = await getStoredData(['badge_count_mode']);
          safeSendResponse({ ok: true, data: data.badge_count_mode || DEFAULT_BADGE_COUNT_MODE });
          break;
        }
        case 'SET_BADGE_COUNT_MODE': {
          await setStoredData({ badge_count_mode: message.mode });
          console.log('[OctoDeck BG] Saved updated badge count mode:', message.mode);
          await updateBadgeState();
          safeSendResponse({ ok: true, data: true });
          break;
        }
        default:
          safeSendResponse({ ok: false, error: `Unknown message type` });
      }
    } catch (err) {
      console.debug(`[OctoDeck BG] Error handling message ${message.type}:`, err);
      safeSendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  // Keep channel open for async response
  return true;
}

// Notification Click Handler (exported for testing)
export async function handleNotificationClick(notificationId: string): Promise<void> {
  console.log('[OctoDeck BG] User clicked notification -> navigating to:', notificationId);
  const targetUrl = notificationId.startsWith('http://') || notificationId.startsWith('https://')
    ? notificationId
    : `${DEFAULT_BASE_URL}/?item=${encodeURIComponent(notificationId)}`;

  const tabs = await chrome.tabs.query({ url: `${DEFAULT_BASE_URL}/*` });
  if (tabs.length > 0 && tabs[0].id) {
    await chrome.tabs.update(tabs[0].id, { url: targetUrl, active: true });
    if (tabs[0].windowId) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: targetUrl });
  }
  chrome.notifications?.clear?.(notificationId);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  // Installation / Update
  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('OctoDeck Companion installed/updated:', details.reason);
    await updateBadgeState();
    await syncKnownBots();
    const token = await getBearerToken();
    if (!token) {
      chrome.tabs.create({ url: DASHBOARD_URL });
    }
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  });

  // Action Clicked -> Open or focus running OctoDeck Dashboard tab
  chrome.action?.onClicked?.addListener(async () => {
    const tabs = await chrome.tabs.query({ url: `${DEFAULT_BASE_URL}/*` });
    if (tabs.length > 0 && tabs[0].id) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: DASHBOARD_URL });
    }
  });

  // Notification Clicked -> Open OctoDeck Dashboard with item details
  chrome.notifications?.onClicked?.addListener(handleNotificationClick);

  // Alarms listener
  chrome.alarms?.onAlarm?.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
      await updateBadgeState();
      await pollNotifications();
    }
  });

  // Storage changes listener
  chrome.storage?.onChanged?.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.bearer_token) {
        console.log('[OctoDeck BG] Storage bearer_token changed -> updating badge state');
        updateBadgeState();
        syncKnownBots().catch(() => {});
      }
    }
  });

  // Message Router for Content Scripts & Options Page
  chrome.runtime.onMessage.addListener(handleExtensionMessage);

  console.log('[OctoDeck BG] Companion background service worker initialized.');
}
