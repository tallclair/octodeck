/**
 * The toolbar action (badge, color, tooltip) rendered from one persisted state, so the daemon
 * stream status, the daemon's badge counts and GitHub-integration health never overwrite each
 * other, and the state survives service-worker restarts (chrome.storage.session).
 *
 * Precedence: daemon offline / setup / version mismatch > degraded GitHub integration (amber, the
 * daemon's count is kept) > the daemon's badge. Tabs whose current page has limited features get a
 * tab-specific tooltip that adds that detail to the global one.
 */
import type { ActionState, DaemonStreamStatus, SessionExtensionData } from '../types';

export const COLORS = {
  normal: '#2563eb',
  offline: '#dc2626',
  attention: '#f97316',
  degraded: '#d97706',
} as const;

export const DEFAULT_TITLE = 'Open OctoDeck Dashboard';

export function emptyActionState(): ActionState {
  return { stream: null, badge: null, degraded: [], tabs: {} };
}

export interface RenderedAction {
  text: string;
  color: string;
  title: string;
}

const STREAM_STATES: Record<Exclude<DaemonStreamStatus, 'connected'>, RenderedAction> = {
  offline: { text: '!', color: COLORS.offline, title: 'OctoDeck daemon is offline' },
  setup: { text: 'SETUP', color: COLORS.attention, title: 'Open OctoDeck Dashboard to pair companion extension' },
  'version-mismatch': {
    text: 'UPD',
    color: COLORS.attention,
    title: 'OctoDeck daemon and companion extension versions differ; update both to get notifications',
  },
};

/** Computes the global badge from the state (pure). */
export function renderGlobal(state: ActionState): RenderedAction {
  const stream = state.stream?.status;
  if (stream && stream !== 'connected') return STREAM_STATES[stream];
  const text = state.badge?.text ?? '';
  const baseTitle = state.badge?.tooltip || DEFAULT_TITLE;
  if (state.degraded.length === 0) return { text, color: COLORS.normal, title: baseTitle };
  return {
    text,
    color: COLORS.degraded,
    title: `${baseTitle}\nGitHub integration limited: ${state.degraded.join(', ')}. See the extension options.`,
  };
}

/** Tooltip for a tab whose current page has limited features (pure). */
export function renderTabTitle(globalTitle: string, limited: readonly string[]): string {
  return limited.length === 0 ? globalTitle : `${globalTitle}\nOn this page: ${limited.join(', ')} paused.`;
}

/** Runs a chrome.action call, ignoring failures (e.g. a tab closed in the meantime). */
function quietly(call: () => unknown): Promise<void> {
  return Promise.resolve()
    .then(call)
    .then(
      () => undefined,
      () => undefined
    );
}

/** Applies the state to chrome.action. */
export async function applyActionState(state: ActionState): Promise<void> {
  const g = renderGlobal(state);
  await Promise.all([
    quietly(() => chrome.action.setBadgeText({ text: g.text })),
    quietly(() => chrome.action.setBadgeBackgroundColor({ color: g.color })),
    quietly(() => chrome.action.setTitle({ title: g.title })),
    ...Object.entries(state.tabs).map(([tabId, tab]) =>
      quietly(() => chrome.action.setTitle({ tabId: Number(tabId), title: renderTabTitle(g.title, tab.limited) }))
    ),
  ]);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serialized read-modify-write of the action state, followed by a render. The mutator may return
 * false to skip writing and rendering (nothing changed).
 */
export function updateActionState(mutate: (state: ActionState) => boolean | void): Promise<ActionState> {
  const run = queue.then(async () => {
    const { action_state } = (await chrome.storage.session.get(['action_state'])) as SessionExtensionData;
    const state = action_state ?? emptyActionState();
    if (mutate(state) === false) return state;
    await chrome.storage.session.set({ action_state: state } satisfies SessionExtensionData);
    await applyActionState(state);
    return state;
  });
  queue = run.catch((err) => console.debug('[OctoDeck BG] Failed to update toolbar state:', err));
  return run;
}

/** Reads the current action state (for the options page snapshot). */
export async function readActionState(): Promise<ActionState> {
  const { action_state } = (await chrome.storage.session.get(['action_state'])) as SessionExtensionData;
  return action_state ?? emptyActionState();
}

/**
 * Records the latest page session's limited features for a tab. A new navId replaces the tab's
 * previous list; the same navId updates one feature.
 */
export function setTabFeature(state: ActionState, tabId: number, navId: string, label: string, limited: boolean): boolean {
  const key = String(tabId);
  const current = state.tabs[key];
  const tab = current && current.navId === navId ? current : { navId, limited: [] };
  const has = tab.limited.includes(label);
  if (current === tab && has === limited) return false;
  tab.limited = limited ? [...new Set([...tab.limited, label])].sort() : tab.limited.filter((l) => l !== label);
  state.tabs[key] = tab;
  return true;
}

/**
 * Forgets a tab's page detail when it starts loading a new document. The entry is kept (empty) so
 * the next render overwrites the tab-specific tooltip with the global one.
 */
export function resetTab(state: ActionState, tabId: number): boolean {
  const key = String(tabId);
  const tab = state.tabs[key];
  if (!tab || tab.limited.length === 0) return false;
  state.tabs[key] = { navId: '', limited: [] };
  return true;
}

/** Drops a closed tab (Chrome clears tab-specific action settings itself). */
export function removeTab(state: ActionState, tabId: number): boolean {
  const key = String(tabId);
  if (!(key in state.tabs)) return false;
  delete state.tabs[key];
  return true;
}
