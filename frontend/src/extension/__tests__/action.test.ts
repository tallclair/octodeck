import {
  COLORS,
  DEFAULT_TITLE,
  emptyActionState,
  removeTab,
  renderGlobal,
  renderTabTitle,
  resetTab,
  setTabFeature,
  updateActionState,
} from '../background/action';
import type { ActionState } from '../types';

describe('renderGlobal', () => {
  const state = (over: Partial<ActionState> = {}): ActionState => ({ ...emptyActionState(), ...over });
  const connected = { status: 'connected' as const, since: 1 };

  it('shows the daemon badge when healthy', () => {
    expect(renderGlobal(state({ stream: connected, badge: { text: '3', tooltip: 'OctoDeck (3)' } }))).toEqual({
      text: '3',
      color: COLORS.normal,
      title: 'OctoDeck (3)',
    });
    expect(renderGlobal(state())).toEqual({ text: '', color: COLORS.normal, title: DEFAULT_TITLE });
  });

  it('keeps the count but turns amber when GitHub integration is degraded', () => {
    expect(
      renderGlobal(state({ stream: connected, badge: { text: '3', tooltip: 'OctoDeck (3)' }, degraded: ['Ack button', 'Sidebar widget'] }))
    ).toEqual({
      text: '3',
      color: COLORS.degraded,
      title: 'OctoDeck (3)\nGitHub integration limited: Ack button, Sidebar widget. See the extension options.',
    });
  });

  it.each([
    ['offline', '!', COLORS.offline],
    ['setup', 'SETUP', COLORS.attention],
    ['version-mismatch', 'UPD', COLORS.attention],
  ] as const)('gives daemon state %s precedence over everything', (status, text, color) => {
    const g = renderGlobal(state({ stream: { status, since: 1 }, badge: { text: '3', tooltip: 'x' }, degraded: ['Sidebar widget'] }));
    expect(g).toMatchObject({ text, color });
  });
});

describe('tab detail', () => {
  it('adds page detail to the global title', () => {
    expect(renderTabTitle('Global', [])).toBe('Global');
    expect(renderTabTitle('Global', ['Ack button'])).toBe('Global\nOn this page: Ack button paused.');
  });

  it('tracks limited features per page session', () => {
    const s = emptyActionState();
    expect(setTabFeature(s, 1, 'nav-a', 'Sidebar widget', true)).toBe(true);
    expect(setTabFeature(s, 1, 'nav-a', 'Ack button', true)).toBe(true);
    expect(setTabFeature(s, 1, 'nav-a', 'Ack button', true)).toBe(false);
    expect(s.tabs['1'].limited).toEqual(['Ack button', 'Sidebar widget']);
    expect(setTabFeature(s, 1, 'nav-a', 'Ack button', false)).toBe(true);
    expect(s.tabs['1'].limited).toEqual(['Sidebar widget']);
    // A new session on the tab starts over.
    expect(setTabFeature(s, 1, 'nav-b', 'Timeline markers', false)).toBe(true);
    expect(s.tabs['1']).toEqual({ navId: 'nav-b', limited: [] });
  });

  it('resets on load and forgets closed tabs', () => {
    const s = emptyActionState();
    setTabFeature(s, 1, 'nav-a', 'Sidebar widget', true);
    expect(resetTab(s, 1)).toBe(true);
    expect(s.tabs['1']).toEqual({ navId: '', limited: [] });
    expect(resetTab(s, 1)).toBe(false);
    expect(removeTab(s, 1)).toBe(true);
    expect(removeTab(s, 1)).toBe(false);
  });
});

describe('updateActionState', () => {
  let session: Record<string, unknown>;

  beforeEach(() => {
    session = {};
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in session).map((k) => [k, structuredClone(session[k])]))),
          set: vi.fn(async (data: Record<string, unknown>) => Object.assign(session, structuredClone(data))),
        },
      },
      action: {
        setBadgeText: vi.fn(async () => {}),
        setBadgeBackgroundColor: vi.fn(async () => {}),
        // A closed tab rejects; rendering must carry on.
        setTitle: vi.fn(async (d: { tabId?: number }) => {
          if (d.tabId === 99) throw new Error('No tab with id: 99');
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists, renders global and per-tab titles, and serializes updates', async () => {
    await Promise.all([
      updateActionState((s) => {
        s.badge = { text: '1', tooltip: 'One' };
      }),
      updateActionState((s) => {
        s.degraded = ['Sidebar widget'];
        setTabFeature(s, 5, 'nav-a', 'Sidebar widget', true);
        setTabFeature(s, 99, 'nav-b', 'Ack button', true);
      }),
    ]);
    expect(session.action_state).toMatchObject({ badge: { text: '1', tooltip: 'One' }, degraded: ['Sidebar widget'] });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color: COLORS.degraded });
    expect(chrome.action.setTitle).toHaveBeenCalledWith({
      tabId: 5,
      title: 'One\nGitHub integration limited: Sidebar widget. See the extension options.\nOn this page: Sidebar widget paused.',
    });
  });

  it('skips writing when the mutator reports no change', async () => {
    await updateActionState(() => false);
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });
});
