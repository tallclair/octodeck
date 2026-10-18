/**
 * Preferences for content features (hide events, known bots, Safe mode).
 *
 * Loads in parallel with scope detection and never gates DOM features
 * (docs/internal/extension_dom_engine_design.md 5.2, guarantee 8): current() serves cached or
 * default values until storage answers or a 1s timeout passes; later values arrive via onChange.
 */
import type { ExtensionResponse } from '../../types';
import type { Messenger } from './messaging';
import type { PrefsSnapshot, PrefsSource } from './types';

export const PREFS_TIMEOUT_MS = 1000;
const LOCAL_HIDE_EVENTS_KEY = 'octodeck_hide_events';

function readLocalHideEvents(): boolean {
  try {
    return localStorage.getItem(LOCAL_HIDE_EVENTS_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeLocalHideEvents(hide: boolean): void {
  try {
    localStorage.setItem(LOCAL_HIDE_EVENTS_KEY, String(hide));
  } catch {
    // Storage can be unavailable (privacy modes); the in-memory value still applies.
  }
}

function hasChromeStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
  } catch {
    return false;
  }
}

export class PrefsStore implements PrefsSource {
  private snapshot: PrefsSnapshot = { hideEvents: readLocalHideEvents(), knownBots: [], safeMode: false };
  private readonly listeners = new Set<(p: PrefsSnapshot) => void>();
  private storageListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | null = null;

  constructor(private readonly messenger: Messenger) {}

  current(): PrefsSnapshot {
    return this.snapshot;
  }

  onChange(cb: (prefs: PrefsSnapshot) => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.listeners.add(cb);
    signal.addEventListener('abort', () => this.listeners.delete(cb), { once: true });
  }

  setHideEvents(hide: boolean): void {
    writeLocalHideEvents(hide);
    this.update({ hideEvents: hide });
    void this.messenger.send({ type: 'SET_HIDE_EVENTS', hideEvents: hide });
  }

  /**
   * Starts loading and watching. The returned promise resolves after the first load or the
   * timeout, whichever comes first; callers must not block DOM work on it.
   */
  start(): Promise<void> {
    this.watchStorage();
    const load = this.load().catch(() => {});
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, PREFS_TIMEOUT_MS));
    return Promise.race([load, timeout]);
  }

  stop(): void {
    if (this.storageListener && hasChromeStorage()) chrome.storage.onChanged.removeListener(this.storageListener);
    this.storageListener = null;
    this.listeners.clear();
  }

  private async load(): Promise<void> {
    const [hide, stored] = await Promise.all([
      this.messenger.send<boolean>({ type: 'GET_HIDE_EVENTS' }),
      this.readStorage(),
    ]);
    const patch: Partial<PrefsSnapshot> = {};
    if (hide.ok && typeof hide.data === 'boolean') {
      patch.hideEvents = hide.data;
      writeLocalHideEvents(hide.data);
    }
    if (typeof stored.safe_mode === 'boolean') patch.safeMode = stored.safe_mode;
    if (Array.isArray(stored.known_bots) && stored.known_bots.length > 0) {
      patch.knownBots = stored.known_bots.filter((b): b is string => typeof b === 'string');
    } else {
      const bots: ExtensionResponse<string[]> = await this.messenger.send<string[]>({ type: 'GET_KNOWN_BOTS' });
      if (bots.ok && Array.isArray(bots.data)) patch.knownBots = bots.data;
    }
    this.update(patch);
  }

  private readStorage(): Promise<{ known_bots?: unknown[]; safe_mode?: unknown }> {
    if (!hasChromeStorage()) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['known_bots', 'safe_mode'], (res) => resolve((res ?? {}) as { known_bots?: unknown[]; safe_mode?: unknown }));
      } catch {
        resolve({});
      }
    });
  }

  private watchStorage(): void {
    if (!hasChromeStorage() || this.storageListener) return;
    this.storageListener = (changes, area) => {
      if (area !== 'local') return;
      const patch: Partial<PrefsSnapshot> = {};
      if (changes.hide_events) {
        patch.hideEvents = Boolean(changes.hide_events.newValue);
        writeLocalHideEvents(patch.hideEvents);
      }
      if (changes.known_bots) {
        const v = changes.known_bots.newValue;
        patch.knownBots = Array.isArray(v) ? v.filter((b): b is string => typeof b === 'string') : [];
      }
      if (changes.safe_mode) patch.safeMode = Boolean(changes.safe_mode.newValue);
      if (Object.keys(patch).length > 0) this.update(patch);
    };
    try {
      chrome.storage.onChanged.addListener(this.storageListener);
    } catch {
      this.storageListener = null;
    }
  }

  private update(patch: Partial<PrefsSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    const changed =
      next.hideEvents !== this.snapshot.hideEvents ||
      next.safeMode !== this.snapshot.safeMode ||
      next.knownBots.join('\n') !== this.snapshot.knownBots.join('\n');
    this.snapshot = next;
    if (!changed) return;
    for (const cb of Array.from(this.listeners)) {
      try {
        cb(next);
      } catch {
        // Listener errors are isolated; features wrap their own callbacks with ctx.guard.
      }
    }
  }
}
