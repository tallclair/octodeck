import { DEFAULT_BASE_URL, DEFAULT_API_BASE_URL } from '../utils/constants';
import type {
  ExtensionMessage,
  ExtensionResponse,
  StoredExtensionData,
  SessionExtensionData,
  DaemonStatus,
  NotificationSettingsJson,
} from './types';
import { OBSOLETE_STORAGE_KEYS } from './types';
import type { Item } from '../api/octodeck/v1/resources_pb';
import type {
  BadgeUpdate,
  GetConfigResponse,
  Notification,
  NotificationSummary,
} from '../api/octodeck/v1/service_pb';
import {
  NotificationStream,
  createDaemonStreamOpener,
  parseCursor,
  serializeCursor,
  type NotificationStreamDeps,
  type StreamStatus,
  type TokenResult,
} from './notificationStream';
import type { Timestamp } from '@bufbuild/protobuf/wkt';

const DASHBOARD_URL = `${DEFAULT_BASE_URL}/`;
/** Periodically makes sure the notification stream is connected (MV3 workers get suspended). */
export const WATCHDOG_ALARM = 'octodeck_stream_watchdog';
/** Alarm used by earlier versions to poll for notifications; cleared on install/update. */
const OBSOLETE_POLL_ALARM = 'octodeck_poll_notifications';
/** Upper bound on remembered notification click targets. */
const MAX_NOTIFICATION_URLS = 200;

async function getStoredData<K extends keyof StoredExtensionData>(keys: K[]): Promise<Pick<StoredExtensionData, K>> {
  return (await chrome.storage.local.get(keys)) as Pick<StoredExtensionData, K>;
}

async function setStoredData(data: Partial<StoredExtensionData>): Promise<void> {
  await chrome.storage.local.set(data);
}

// ---------------------------------------------------------------------------
// Daemon RPC Client Helpers
// ---------------------------------------------------------------------------

let refreshingTokenPromise: Promise<TokenResult> | null = null;

/**
 * Returns the stored bearer token, pairing with the daemon if there is none (or forceRefresh is
 * set). Without a token, reports whether the daemon couldn't be reached or refused to pair.
 */
export async function acquireBearerToken(forceRefresh = false): Promise<TokenResult> {
  if (!forceRefresh) {
    const data = await getStoredData(['bearer_token']);
    if (data.bearer_token) {
      return { token: data.bearer_token };
    }
  }
  return doRefreshToken();
}

export async function ensureBearerToken(forceRefresh = false): Promise<string | null> {
  return (await acquireBearerToken(forceRefresh)).token;
}

function doRefreshToken(): Promise<TokenResult> {
  if (refreshingTokenPromise) {
    return refreshingTokenPromise;
  }

  refreshingTokenPromise = (async (): Promise<TokenResult> => {
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
          return { token: json.access_token };
        }
      }
      // The daemon answered but didn't issue a token.
      return { token: null, reason: 'unpaired' };
    } catch (err) {
      console.debug('[OctoDeck BG] Failed to auto-pair token:', err);
      return { token: null, reason: 'unreachable' };
    } finally {
      refreshingTokenPromise = null;
    }
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
// Toolbar Badge (counts are computed by the daemon and pushed over the stream)
// ---------------------------------------------------------------------------

export function applyBadge(badge: BadgeUpdate): void {
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  chrome.action.setTitle({ title: badge.tooltip || 'Open OctoDeck Dashboard' });
}

export function applyStreamStatus(status: StreamStatus): void {
  switch (status) {
    case 'offline':
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); // Bright red badge
      chrome.action.setTitle({ title: 'OctoDeck daemon is offline' });
      break;
    case 'setup':
      chrome.action.setBadgeText({ text: 'SETUP' });
      chrome.action.setBadgeBackgroundColor({ color: '#f97316' }); // Orange badge
      chrome.action.setTitle({ title: 'Open OctoDeck Dashboard to pair companion extension' });
      break;
    case 'version-mismatch':
      chrome.action.setBadgeText({ text: 'UPD' });
      chrome.action.setBadgeBackgroundColor({ color: '#f97316' }); // Orange badge
      chrome.action.setTitle({
        title: 'OctoDeck daemon and companion extension versions differ; update both to get notifications',
      });
      break;
    case 'connected':
      // The daemon sends the current badge right after connecting.
      break;
  }
}

// ---------------------------------------------------------------------------
// Desktop Notifications (decided by the daemon)
// ---------------------------------------------------------------------------

async function getNotificationUrls(): Promise<Record<string, string>> {
  const data = (await chrome.storage.session.get(['notification_urls'])) as SessionExtensionData;
  return data.notification_urls || {};
}

/**
 * Records where clicking a notification goes. Returns false if the notification was already
 * shown (a replay after reconnect), in which case it shouldn't be shown again.
 */
async function rememberNotificationUrl(id: string, url: string): Promise<boolean> {
  const urls = await getNotificationUrls();
  if (id in urls) return false;
  urls[id] = url;
  // Keys keep insertion order, so the oldest entries are dropped first.
  const ids = Object.keys(urls);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_NOTIFICATION_URLS))) {
    delete urls[old];
  }
  await chrome.storage.session.set({ notification_urls: urls } satisfies SessionExtensionData);
  return true;
}

function createDesktopNotification(id: string, title: string, message: string): void {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon-128.png'),
    title,
    message,
    priority: 1,
  });
}

/**
 * Returns url if it is on the dashboard's origin, otherwise the dashboard itself, so a
 * notification click can never navigate anywhere else.
 */
export function safeDashboardUrl(url: string | undefined): string {
  if (!url) return DASHBOARD_URL;
  try {
    const parsed = new URL(url);
    if (parsed.origin === new URL(DASHBOARD_URL).origin) return parsed.href;
  } catch {
    // Not a valid absolute URL.
  }
  return DASHBOARD_URL;
}

export async function showNotification(notification: Notification): Promise<void> {
  if (!notification.id) return;
  const url = safeDashboardUrl(notification.url);
  if (!(await rememberNotificationUrl(notification.id, url))) return;
  createDesktopNotification(notification.id, notification.title, notification.message);
}

export async function showSummary(summary: NotificationSummary, sentAt: Timestamp | undefined): Promise<void> {
  const id = `summary:${sentAt ? serializeCursor(sentAt) : Date.now()}`;
  const url = safeDashboardUrl(summary.url);
  if (!(await rememberNotificationUrl(id, url))) return;
  createDesktopNotification(id, summary.title || 'OctoDeck', summary.message);
}

/** Opens the URL of a clicked notification in the dashboard tab (exported for testing). */
export async function handleNotificationClick(notificationId: string): Promise<void> {
  const urls = await getNotificationUrls();
  const targetUrl = safeDashboardUrl(urls[notificationId]);
  console.log('[OctoDeck BG] User clicked notification -> navigating to:', targetUrl);

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

// ---------------------------------------------------------------------------
// Notification Stream
// ---------------------------------------------------------------------------

/** How often the resume cursor is written to local storage for messages that showed nothing. */
export const CURSOR_PERSIST_INTERVAL_MS = 60_000;

/**
 * Stores the stream's resume cursor. Every message updates the copy in session storage (cheap,
 * and keeps the worker alive); local storage, which survives a browser restart, is written at
 * most once per CURSOR_PERSIST_INTERVAL_MS and on every message that showed a notification, so
 * a restart never shows a notification twice. Loading prefers the fresher session copy.
 */
export function createCursorStore(
  now: () => number = Date.now
): Pick<NotificationStreamDeps, 'loadCursor' | 'saveCursor'> {
  let lastPersistedAt: number | undefined;
  return {
    async loadCursor() {
      const session = (await chrome.storage.session.get(['last_received_at'])) as SessionExtensionData;
      return (
        parseCursor(session.last_received_at) ??
        parseCursor((await getStoredData(['last_received_at'])).last_received_at)
      );
    },
    async saveCursor(cursor, durable) {
      const value = serializeCursor(cursor);
      await chrome.storage.session.set({ last_received_at: value } satisfies SessionExtensionData);
      const t = now();
      if (durable || lastPersistedAt === undefined || t - lastPersistedAt >= CURSOR_PERSIST_INTERVAL_MS) {
        lastPersistedAt = t;
        await setStoredData({ last_received_at: value });
      }
    },
  };
}

export function createStreamDeps(): NotificationStreamDeps {
  return {
    getToken: (forceRefresh) => acquireBearerToken(forceRefresh),
    clearToken: () => chrome.storage.local.remove('bearer_token'),
    openStream: createDaemonStreamOpener(),
    ...createCursorStore(),
    onNotification: showNotification,
    onSummary: showSummary,
    onBadge: applyBadge,
    onStatus: applyStreamStatus,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  };
}

let notificationStream: NotificationStream | null = null;

function connectNotificationStream(): void {
  notificationStream ??= new NotificationStream(createStreamDeps());
  notificationStream.ensureConnected();
}

/**
 * Creates the watchdog alarm unless it exists. Called whenever the worker starts, so the alarm
 * survives anything that cleared it (alarms aren't guaranteed to persist across browser
 * restarts).
 */
export async function ensureWatchdogAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(WATCHDOG_ALARM))) {
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  }
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

interface ConfigJsonResponse {
  config?: { notificationSettings?: NotificationSettingsJson };
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
          break;
        }
        case 'GET_CONFIG': {
          const resp = await callDaemonRpc<Record<string, never>, GetConfigResponse>('GetConfig', {});
          if (resp.config?.knownBots) {
            await setStoredData({ known_bots: resp.config.knownBots });
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
            // FieldMask's JSON form is a comma-separated string of camelCase paths.
            const resp = await callDaemonRpc<
              { config: { knownBots: string[] }; updateMask: string },
              { config: { knownBots: string[] } }
            >('UpdateConfig', {
              config: { knownBots: merged },
              updateMask: 'knownBots',
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
        case 'GET_NOTIFICATION_SETTINGS': {
          const resp = await callDaemonRpc<Record<string, never>, ConfigJsonResponse>('GetConfig', {});
          safeSendResponse({ ok: true, data: resp.config?.notificationSettings ?? {} });
          break;
        }
        case 'SAVE_NOTIFICATION_SETTINGS': {
          // Only notification_settings is updated, so concurrent edits to other config fields
          // (e.g. from the dashboard) aren't overwritten. FieldMask's JSON form is a
          // comma-separated string of camelCase paths.
          const resp = await callDaemonRpc<
            { config: { notificationSettings: NotificationSettingsJson }; updateMask: string },
            ConfigJsonResponse
          >('UpdateConfig', {
            config: { notificationSettings: message.settings },
            updateMask: 'notificationSettings',
          });
          safeSendResponse({ ok: true, data: resp.config?.notificationSettings ?? message.settings });
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

/** Removes state left by the extension-side notification engine of earlier versions. */
export async function cleanUpObsoleteState(): Promise<void> {
  await chrome.alarms.clear(OBSOLETE_POLL_ALARM);
  await chrome.storage.local.remove([...OBSOLETE_STORAGE_KEYS]);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  // Installation / Update
  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('OctoDeck Companion installed/updated:', details.reason);
    await cleanUpObsoleteState();
    await ensureWatchdogAlarm();
    connectNotificationStream();
    await syncKnownBots();
    const token = await getBearerToken();
    if (!token) {
      chrome.tabs.create({ url: DASHBOARD_URL });
    }
  });

  chrome.runtime.onStartup?.addListener(() => {
    void ensureWatchdogAlarm().catch((err) => console.debug('[OctoDeck BG] Failed to ensure watchdog alarm:', err));
    connectNotificationStream();
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

  // Notification Clicked -> Open OctoDeck Dashboard at the notification's target
  chrome.notifications?.onClicked?.addListener(handleNotificationClick);

  // The watchdog reconnects the stream if the worker was suspended or the daemon restarted.
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) {
      connectNotificationStream();
    }
  });

  // Storage changes listener
  chrome.storage?.onChanged?.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.bearer_token?.newValue) {
      console.log('[OctoDeck BG] Storage bearer_token changed -> connecting notification stream');
      connectNotificationStream();
      syncKnownBots().catch(() => {});
    }
  });

  // Message Router for Content Scripts & Options Page
  chrome.runtime.onMessage.addListener(handleExtensionMessage);

  // Every time the service worker starts (including wake-ups for events), reconnect and make sure
  // the watchdog alarm exists.
  void ensureWatchdogAlarm().catch((err) => console.debug('[OctoDeck BG] Failed to ensure watchdog alarm:', err));
  connectNotificationStream();

  console.log('[OctoDeck BG] Companion background service worker initialized.');
}
