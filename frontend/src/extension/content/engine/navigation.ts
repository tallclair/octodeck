/**
 * Navigation source: merges every signal that can indicate a same-document navigation on GitHub
 * (docs/internal/extension_dom_engine_design.md 5.1).
 *
 * Primary: the Navigation API (currententrychange / navigatesuccess). Fallbacks: turbo:load,
 * turbo:frame-load, turbo:render, popstate, hashchange and a <head> subtree observer (React
 * updates the title; Turbo may replace <title>). Events are de-duplicated by URL.
 * The history.pushState monkey-patch is intentionally absent: it is dead in the isolated world.
 */

export type NavKind = 'item-change' | 'subroute-change' | 'hash-change';

export interface NavEvent {
  kind: NavKind;
  url: URL;
  prev: URL;
}

/** owner/repo/(pull|issues)/N, or the whole path for non-item pages. */
function itemKey(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 4 && (parts[2] === 'pull' || parts[2] === 'issues')) return parts.slice(0, 4).join('/');
  return parts.join('/');
}

function pathKey(url: URL): string {
  return url.pathname.replace(/\/+$/, '');
}

export function classifyNavigation(prev: URL, next: URL): NavKind | null {
  if (itemKey(prev) !== itemKey(next)) return 'item-change';
  if (pathKey(prev) !== pathKey(next)) return 'subroute-change';
  if (prev.hash !== next.hash) return 'hash-change';
  return null;
}

interface NavigationLike {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

export class NavigationSource {
  private last: URL;
  private readonly cleanups: Array<() => void> = [];
  private headObserver: MutationObserver | null = null;

  constructor(
    private readonly onNavigate: (event: NavEvent) => void,
    /** Same-URL Turbo render (body swap): scopes need re-detection but the session continues. */
    private readonly onSameUrlRender: () => void = () => {},
    private readonly win: Window = window
  ) {
    this.last = new URL(win.location.href);
  }

  start(): void {
    const check = () => this.check();
    const nav = (this.win as unknown as { navigation?: NavigationLike }).navigation;
    if (nav && typeof nav.addEventListener === 'function') {
      for (const type of ['currententrychange', 'navigatesuccess']) {
        nav.addEventListener(type, check);
        this.cleanups.push(() => nav.removeEventListener(type, check));
      }
    }
    for (const type of ['turbo:load', 'turbo:frame-load']) this.listen(this.win.document, type, check);
    this.listen(this.win.document, 'turbo:render', () => {
      if (!this.check()) this.onSameUrlRender();
    });
    this.listen(this.win, 'popstate', check);
    this.listen(this.win, 'hashchange', check);
    this.observeHead(check);
  }

  stop(): void {
    for (const c of this.cleanups.splice(0)) c();
    this.headObserver?.disconnect();
    this.headObserver = null;
  }

  /** Compares the current URL with the last seen one; emits and returns true on a navigation. */
  check(): boolean {
    let next: URL;
    try {
      next = new URL(this.win.location.href);
    } catch {
      return false;
    }
    const kind = classifyNavigation(this.last, next);
    if (!kind) return false;
    const prev = this.last;
    this.last = next;
    this.onNavigate({ kind, url: next, prev });
    return true;
  }

  private listen(target: EventTarget, type: string, cb: () => void): void {
    target.addEventListener(type, cb);
    this.cleanups.push(() => target.removeEventListener(type, cb));
  }

  private observeHead(cb: () => void): void {
    if (typeof MutationObserver === 'undefined') return;
    // Also observe <html> children so a replaced <head> is followed (re-bound on change).
    const doc = this.win.document;
    let observedHead: HTMLHeadElement | null = null;
    const bind = () => {
      this.headObserver?.disconnect();
      observedHead = doc.head;
      if (observedHead) this.headObserver!.observe(observedHead, { childList: true, subtree: true, characterData: true });
      this.headObserver!.observe(doc.documentElement, { childList: true });
    };
    this.headObserver = new MutationObserver(() => {
      if (doc.head !== observedHead) bind();
      cb();
    });
    bind();
  }
}
