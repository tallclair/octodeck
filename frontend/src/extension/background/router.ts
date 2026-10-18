/**
 * Message router for chrome.runtime.onMessage (docs/internal/extension_diagnostics_design.md).
 *
 * Every message type declares which contexts may send it and a hand-written payload parser.
 * Content scripts run inside github.com pages and act on page-derived data, so they only get the
 * per-item operations they need; settings, daemon status and diagnostics management are limited to
 * the extension's own pages. Anything unknown, malformed or from the wrong context is rejected
 * without reaching a handler. The listener always answers exactly once.
 */
import { parseFeatureReport } from './diagnostics';
import type { ExtensionMessage, ExtensionMessageType, ExtensionResponse, NotificationSettingsJson } from '../types';

export type SenderContext = 'githubContent' | 'extensionPage';

export type MessageOf<T extends ExtensionMessageType> = Extract<ExtensionMessage, { type: T }>;

export type MessageHandlers = {
  [T in ExtensionMessageType]: (msg: MessageOf<T>, sender: chrome.runtime.MessageSender) => Promise<unknown>;
};

interface Route<T extends ExtensionMessageType> {
  contexts: readonly SenderContext[];
  /** Returns the validated message, or null to reject it. */
  parse(raw: Record<string, unknown>, sender: chrome.runtime.MessageSender): MessageOf<T> | null;
}

const GITHUB_ORIGIN = 'https://github.com';
const MAX_ITEM_ID_CHARS = 256;
const MAX_NOTES_CHARS = 20_000;

/** REPORT_DIAGNOSTIC budget per tab (token bucket). */
export const REPORTS_PER_MINUTE = 30;

export const REJECTED = 'Message rejected';

/** Which kind of extension context sent a message, or null if it isn't ours. */
export function classifySender(sender: chrome.runtime.MessageSender, runtimeId: string, extensionOrigin: string): SenderContext | null {
  if (sender.id !== runtimeId || !sender.url) return null;
  // The options page opens in a tab (options_ui.open_in_tab), so the URL decides, not sender.tab.
  if (sender.url.startsWith(extensionOrigin)) return 'extensionPage';
  let origin: string;
  try {
    origin = new URL(sender.url).origin;
  } catch {
    return null;
  }
  return origin === GITHUB_ORIGIN && sender.tab ? 'githubContent' : null;
}

const isItemId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ITEM_ID_CHARS;

const BOTH = ['githubContent', 'extensionPage'] as const;
const PAGE_ONLY = ['extensionPage'] as const;
const CONTENT_ONLY = ['githubContent'] as const;

function noPayload<T extends ExtensionMessageType>(type: T, contexts: readonly SenderContext[]): Route<T> {
  return { contexts, parse: () => ({ type }) as MessageOf<T> };
}

function itemMessage<T extends 'GET_ITEM' | 'VIEW_ITEM' | 'REFETCH_ITEM'>(type: T): Route<T> {
  return {
    contexts: BOTH,
    parse: (raw) => (isItemId(raw.itemId) ? ({ type, itemId: raw.itemId } as MessageOf<T>) : null),
  };
}

export const ROUTES: { [T in ExtensionMessageType]: Route<T> } = {
  GET_ITEM: itemMessage('GET_ITEM'),
  VIEW_ITEM: itemMessage('VIEW_ITEM'),
  REFETCH_ITEM: itemMessage('REFETCH_ITEM'),
  ACK_ITEM: {
    contexts: BOTH,
    parse: (raw) =>
      isItemId(raw.itemId) && (raw.acked === undefined || typeof raw.acked === 'boolean')
        ? { type: 'ACK_ITEM', itemId: raw.itemId, ...(raw.acked === undefined ? {} : { acked: raw.acked }) }
        : null,
  },
  STAR_ITEM: {
    contexts: BOTH,
    parse: (raw) =>
      isItemId(raw.itemId) && typeof raw.starred === 'boolean' ? { type: 'STAR_ITEM', itemId: raw.itemId, starred: raw.starred } : null,
  },
  SET_NOTES: {
    contexts: BOTH,
    parse: (raw) =>
      isItemId(raw.itemId) && typeof raw.notes === 'string' && raw.notes.length <= MAX_NOTES_CHARS
        ? { type: 'SET_NOTES', itemId: raw.itemId, notes: raw.notes }
        : null,
  },
  OPEN_DASHBOARD: {
    contexts: BOTH,
    parse: (raw) => {
      if (raw.itemId === undefined) return { type: 'OPEN_DASHBOARD' };
      return isItemId(raw.itemId) ? { type: 'OPEN_DASHBOARD', itemId: raw.itemId } : null;
    },
  },
  GET_KNOWN_BOTS: noPayload('GET_KNOWN_BOTS', BOTH),
  GET_HIDE_EVENTS: noPayload('GET_HIDE_EVENTS', BOTH),
  SET_HIDE_EVENTS: {
    contexts: BOTH,
    parse: (raw) => (typeof raw.hideEvents === 'boolean' ? { type: 'SET_HIDE_EVENTS', hideEvents: raw.hideEvents } : null),
  },
  REPORT_DIAGNOSTIC: {
    contexts: CONTENT_ONLY,
    parse: (raw, sender) => {
      const report = parseFeatureReport(raw.report, sender.url);
      return report ? { type: 'REPORT_DIAGNOSTIC', report } : null;
    },
  },
  GET_DAEMON_STATUS: noPayload('GET_DAEMON_STATUS', PAGE_ONLY),
  GET_NOTIFICATION_SETTINGS: noPayload('GET_NOTIFICATION_SETTINGS', PAGE_ONLY),
  SAVE_NOTIFICATION_SETTINGS: {
    contexts: PAGE_ONLY,
    parse: (raw) =>
      typeof raw.settings === 'object' && raw.settings !== null && !Array.isArray(raw.settings)
        ? { type: 'SAVE_NOTIFICATION_SETTINGS', settings: raw.settings as NotificationSettingsJson }
        : null,
  },
  GET_DIAGNOSTICS: noPayload('GET_DIAGNOSTICS', PAGE_ONLY),
  CLEAR_DIAGNOSTICS: noPayload('CLEAR_DIAGNOSTICS', PAGE_ONLY),
};

/** In-memory token bucket per key. Losing it when the worker is suspended is harmless. */
export function createRateLimiter(perMinute: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string): boolean => {
    const t = now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export interface RouterOptions {
  runtimeId: string;
  extensionOrigin: string;
  allowReport?: (key: string) => boolean;
}

/** Builds the chrome.runtime.onMessage listener. */
export function createMessageRouter(handlers: MessageHandlers, opts: RouterOptions) {
  const allowReport = opts.allowReport ?? createRateLimiter(REPORTS_PER_MINUTE);

  return (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (res: ExtensionResponse) => void): boolean => {
    let answered = false;
    const respond = (res: ExtensionResponse): void => {
      if (answered) return;
      answered = true;
      try {
        sendResponse(res);
      } catch (err) {
        console.debug('[OctoDeck BG] Could not send response (channel closed):', err);
      }
    };

    const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
    const route = typeof type === 'string' && Object.hasOwn(ROUTES, type) ? ROUTES[type as ExtensionMessageType] : undefined;
    const context = classifySender(sender, opts.runtimeId, opts.extensionOrigin);
    const parsed =
      route && context && route.contexts.includes(context)
        ? (route.parse as Route<ExtensionMessageType>['parse'])(message as Record<string, unknown>, sender)
        : null;

    if (!parsed) {
      console.debug(`[OctoDeck BG] Rejected message ${String(type)} from ${context ?? 'unknown sender'}`);
      respond({ ok: false, error: REJECTED });
      return true;
    }
    if (parsed.type === 'REPORT_DIAGNOSTIC' && !allowReport(String(sender.tab?.id ?? 'none'))) {
      respond({ ok: false, error: 'Rate limited' });
      return true;
    }

    const handler = handlers[parsed.type] as (msg: ExtensionMessage, sender: chrome.runtime.MessageSender) => Promise<unknown>;
    void (async () => {
      try {
        respond({ ok: true, data: await handler(parsed, sender) });
      } catch (err) {
        console.debug(`[OctoDeck BG] Error handling message ${parsed.type}:`, err);
        respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    // Keep the channel open for the async response.
    return true;
  };
}
