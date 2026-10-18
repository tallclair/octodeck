import {
  REJECTED,
  ROUTES,
  classifySender,
  createMessageRouter,
  createRateLimiter,
  type MessageHandlers,
} from '../background/router';
import type { ExtensionMessageType, ExtensionResponse } from '../types';

const ID = 'ext-id';
const ORIGIN = `chrome-extension://${ID}/`;
const github = { id: ID, url: 'https://github.com/o/r/pull/1', tab: { id: 1 } } as chrome.runtime.MessageSender;
const options = { id: ID, url: `${ORIGIN}options.html`, tab: { id: 2 } } as chrome.runtime.MessageSender;
const popupNoTab = { id: ID, url: `${ORIGIN}options.html` } as chrome.runtime.MessageSender;

describe('classifySender', () => {
  it('recognizes GitHub content scripts and extension pages', () => {
    expect(classifySender(github, ID, ORIGIN)).toBe('githubContent');
    expect(classifySender(options, ID, ORIGIN)).toBe('extensionPage');
    expect(classifySender(popupNoTab, ID, ORIGIN)).toBe('extensionPage');
  });

  it.each([
    ['another extension', { ...github, id: 'other' }],
    ['a non-GitHub page', { ...github, url: 'https://evil.example/o/r/pull/1' }],
    ['a GitHub lookalike', { ...github, url: 'https://github.com.evil.example/' }],
    ['GitHub without a tab', { id: ID, url: 'https://github.com/' }],
    ['no url', { id: ID, tab: { id: 1 } }],
  ])('rejects %s', (_name, sender) => {
    expect(classifySender(sender as chrome.runtime.MessageSender, ID, ORIGIN)).toBeNull();
  });
});

describe('createMessageRouter', () => {
  const handlers = Object.fromEntries(
    (Object.keys(ROUTES) as ExtensionMessageType[]).map((t) => [t, vi.fn(async () => `handled ${t}`)])
  ) as unknown as MessageHandlers;
  const mockOf = (t: ExtensionMessageType) => handlers[t] as unknown as ReturnType<typeof vi.fn>;

  const route = (message: unknown, sender: chrome.runtime.MessageSender, allowReport?: (k: string) => boolean) => {
    const router = createMessageRouter(handlers, { runtimeId: ID, extensionOrigin: ORIGIN, allowReport });
    return new Promise<ExtensionResponse>((resolve) => {
      expect(router(message, sender, resolve)).toBe(true);
    });
  };

  beforeEach(() => {
    for (const t of Object.keys(ROUTES) as ExtensionMessageType[]) mockOf(t).mockClear();
  });

  it('dispatches valid messages from allowed contexts', async () => {
    expect(await route({ type: 'GET_ITEM', itemId: 'o/r#1' }, github)).toEqual({ ok: true, data: 'handled GET_ITEM' });
    expect(handlers.GET_ITEM).toHaveBeenCalledWith({ type: 'GET_ITEM', itemId: 'o/r#1' }, github);
    expect(await route({ type: 'GET_DAEMON_STATUS' }, options)).toEqual({ ok: true, data: 'handled GET_DAEMON_STATUS' });
  });

  it('passes only parsed fields to handlers', async () => {
    await route({ type: 'STAR_ITEM', itemId: 'o/r#1', starred: true, extra: 'x' }, github);
    expect(handlers.STAR_ITEM).toHaveBeenCalledWith({ type: 'STAR_ITEM', itemId: 'o/r#1', starred: true }, github);
  });

  it.each([
    ['unknown type', { type: 'GET_CONFIG' }, options],
    ['removed type', { type: 'SYNC_ITEM', itemId: 'o/r#1' }, github],
    ['prototype key', { type: 'constructor' }, github],
    ['non-object', 'GET_ITEM', github],
    ['null', null, github],
    ['missing itemId', { type: 'GET_ITEM' }, github],
    ['oversized itemId', { type: 'GET_ITEM', itemId: 'x'.repeat(300) }, github],
    ['non-boolean starred', { type: 'STAR_ITEM', itemId: 'o/r#1', starred: 'yes' }, github],
    ['non-boolean hideEvents', { type: 'SET_HIDE_EVENTS', hideEvents: 1 }, github],
    ['oversized notes', { type: 'SET_NOTES', itemId: 'o/r#1', notes: 'x'.repeat(20_001) }, github],
    ['array settings', { type: 'SAVE_NOTIFICATION_SETTINGS', settings: [] }, options],
    ['settings from GitHub', { type: 'SAVE_NOTIFICATION_SETTINGS', settings: {} }, github],
    ['daemon status from GitHub', { type: 'GET_DAEMON_STATUS' }, github],
    ['diagnostics read from GitHub', { type: 'GET_DIAGNOSTICS' }, github],
    ['diagnostics clear from GitHub', { type: 'CLEAR_DIAGNOSTICS' }, github],
    ['report from an extension page', { type: 'REPORT_DIAGNOSTIC', report: {} }, options],
    ['malformed report', { type: 'REPORT_DIAGNOSTIC', report: { navId: 'x' } }, github],
    ['foreign sender', { type: 'GET_ITEM', itemId: 'o/r#1' }, { ...github, id: 'other' }],
  ])('rejects %s', async (_name, message, sender) => {
    expect(await route(message, sender as chrome.runtime.MessageSender)).toEqual({ ok: false, error: REJECTED });
    for (const h of Object.values(handlers)) expect(h).not.toHaveBeenCalled();
  });

  it('rate-limits diagnostic reports per tab', async () => {
    const report = {
      navId: 'nav-00000001',
      feature: 'sidebarWidget',
      outcome: 'ok',
      pageKind: 'pr-conversation',
      variant: 'classic',
      path: 'o/r/pull/1',
      diagnostics: [],
    };
    expect(await route({ type: 'REPORT_DIAGNOSTIC', report }, github, () => false)).toEqual({ ok: false, error: 'Rate limited' });
    expect(await route({ type: 'REPORT_DIAGNOSTIC', report }, github, () => true)).toEqual({
      ok: true,
      data: 'handled REPORT_DIAGNOSTIC',
    });
  });

  it('turns handler errors into ok:false and answers once', async () => {
    mockOf('GET_ITEM').mockRejectedValueOnce(new Error('daemon down'));
    const sendResponse = vi.fn();
    const router = createMessageRouter(handlers, { runtimeId: ID, extensionOrigin: ORIGIN });
    router({ type: 'GET_ITEM', itemId: 'o/r#1' }, github, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'daemon down' });
  });

  it('survives a closed response channel', async () => {
    const router = createMessageRouter(handlers, { runtimeId: ID, extensionOrigin: ORIGIN });
    const sendResponse = vi.fn(() => {
      throw new Error('The message port closed');
    });
    expect(() => router({ type: 'GET_HIDE_EVENTS' }, github, sendResponse)).not.toThrow();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  });
});

describe('createRateLimiter', () => {
  it('allows a burst, then refills over time', () => {
    let t = 0;
    const allow = createRateLimiter(3, () => t);
    expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false]);
    expect(allow('b')).toBe(true);
    t += 20_000; // one token per 20s at 3/min
    expect(allow('a')).toBe(true);
    expect(allow('a')).toBe(false);
  });
});
