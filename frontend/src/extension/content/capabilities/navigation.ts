/**
 * navigation capability: URL hash access, scroll-and-highlight and the banner toast used by the
 * anchor-repair and expand-all flows (design sections 6.4 and 9.5). DOM changes go through a
 * ledger (the engine-provided one, or the calling feature's for toasts), so they are tagged as
 * OctoDeck nodes / classes and reverted with the session.
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
/** Class of the toast's text span (the part update() rewrites). */
export const TOAST_TEXT_CLASS = 'octodeck-gh-toast-text';
/** Class of the toast's optional action button. */
export const TOAST_ACTION_CLASS = 'octodeck-gh-toast-action';
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

    showToast: (text, { signal, ledger = navLedger, action }): ToastHandle => {
      // Every node comes from the caller's ledger (tagged, reverted with that feature); text is only
      // ever assigned through textContent.
      const el = ledger.create('div', 'toast');
      el.className = TOAST_CLASS;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const label = ledger.create('span');
      label.className = TOAST_TEXT_CLASS;
      label.textContent = text;
      el.appendChild(label);

      let dismissed = false;
      if (action) {
        // A native <button> is focusable and activates on Enter/Space without extra key handling.
        const button = ledger.create('button');
        button.type = 'button';
        button.className = TOAST_ACTION_CLASS;
        button.textContent = action.label;
        button.addEventListener('click', (event) => {
          event.preventDefault();
          if (!dismissed) action.onClick();
        });
        el.appendChild(button);
      }

      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        if (el.isConnected) ledger.remove(el);
      };
      if (signal.aborted) {
        dismissed = true;
      } else {
        ledger.insert(el, { appendTo: doc.body });
        signal.addEventListener('abort', dismiss, { once: true });
      }
      return {
        update: (next) => {
          if (!dismissed) label.textContent = next;
        },
        dismiss,
      };
    },
  };
}
