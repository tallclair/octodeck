/**
 * navigation capability: URL hash access, scroll-and-highlight and the anchor-repair toast
 * (design sections 6.4 and 9.5). DOM changes go through the engine-provided ledger, so they are
 * tagged as OctoDeck nodes / classes and reverted with the session.
 */
import type { FeatureLedger } from '../engine/types';
import type { NavigationCap, ToastHandle } from './types';

export interface NavigationCapDeps {
  doc: Document;
  win: Window;
  /** Ledger bound to the anchorNav feature for the session (engine-provided). */
  navLedger: FeatureLedger;
  /** Hash-only change subscription from the engine's navigation source. */
  onHash: (cb: (hash: string) => void, signal: AbortSignal) => void;
}

/** Class applied to the scrolled-to target; styled (fade-out) in styles/navigation.css. */
export const HIGHLIGHT_CLASS = 'octodeck-gh-anchor-target';
/** Class of the banner toast; styled in styles/navigation.css. */
export const TOAST_CLASS = 'octodeck-gh-toast';
/** How long the highlight class stays on the target. */
export const HIGHLIGHT_MS = 3000;

function decodeHash(raw: string): string {
  const h = raw.startsWith('#') ? raw.slice(1) : raw;
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
}

export function createNavigationCap(deps: NavigationCapDeps): NavigationCap {
  const { doc, win, navLedger } = deps;

  const reducedMotion = (): boolean => {
    try {
      return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      return false;
    }
  };

  return {
    hash: () => decodeHash(win.location.hash),

    onHash: (cb, signal) => deps.onHash(cb, signal),

    scrollToAndHighlight: (target, { signal }) => {
      if (signal.aborted || !target.isConnected) return;
      navLedger.addClass(target, HIGHLIGHT_CLASS);
      // scrollIntoView honours scroll-margin / scroll-padding, which GitHub sets for its sticky header.
      target.scrollIntoView?.({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      const clear = () => navLedger.removeClass(target, HIGHLIGHT_CLASS);
      const timer = win.setTimeout(clear, HIGHLIGHT_MS);
      signal.addEventListener(
        'abort',
        () => {
          win.clearTimeout(timer);
          clear();
        },
        { once: true }
      );
    },

    showToast: (text, { signal }): ToastHandle => {
      const el = navLedger.create('div', 'anchor-toast');
      el.className = TOAST_CLASS;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.textContent = text;
      let dismissed = false;
      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        if (el.isConnected) navLedger.remove(el);
      };
      if (signal.aborted) {
        dismissed = true;
      } else {
        navLedger.insert(el, { appendTo: doc.body });
        signal.addEventListener('abort', dismiss, { once: true });
      }
      return {
        update: (next) => {
          if (!dismissed) el.textContent = next;
        },
        dismiss,
      };
    },
  };
}
