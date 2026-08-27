import { UrlParser } from '../../logic/urlParser';
import type { ExtensionMessage, ExtensionResponse } from '../types';

let lastReportedItem: string | null = null;
let lastReportedTime = 0;
const THROTTLE_MS = 3000;

export function resetViewTrackerStateForTest(): void {
  lastReportedItem = null;
  lastReportedTime = 0;
}

export function parseCurrentGitHubItem(): {
  owner: string;
  repo: string;
  number: number;
  itemId: string;
  isIssue?: boolean;
  isPullRequest?: boolean;
} | null {
  const href = typeof window !== 'undefined' ? window.location?.href || '' : '';
  const parsed = UrlParser.parse(href);
  if (!parsed) return null;
  const isIssue = href.includes('/issues/') || href.endsWith('/issues');
  const isPullRequest = href.includes('/pull/') || href.endsWith('/pull');
  return {
    ...parsed,
    itemId: `${parsed.owner}/${parsed.repo}#${parsed.number}`,
    isIssue,
    isPullRequest,
  };
}

export async function reportCurrentView(): Promise<void> {
  const item = parseCurrentGitHubItem();
  if (!item) return;

  const now = Date.now();
  if (lastReportedItem === item.itemId && now - lastReportedTime < THROTTLE_MS) {
    return;
  }

  lastReportedItem = item.itemId;
  lastReportedTime = now;

  try {
    const msg: ExtensionMessage = { type: 'VIEW_ITEM', itemId: item.itemId };
    chrome.runtime.sendMessage(msg, (response: ExtensionResponse | undefined) => {
      if (chrome.runtime.lastError) {
        console.debug('[OctoDeck View] Background service worker unavailable:', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok) {
        console.log(`[OctoDeck View] Recorded view timestamp for ${item.itemId}`);
      } else if (response && !response.ok) {
        console.debug(`[OctoDeck View] View recording response error for ${item.itemId}:`, response.error);
      }
    });
  } catch (err) {
    console.debug('[OctoDeck View] Error reporting view:', err);
  }
}

export function initViewTracker(onNavigation?: (itemId: string | null) => void): () => void {
  const handleNavigation = () => {
    const item = parseCurrentGitHubItem();
    reportCurrentView();
    if (onNavigation) {
      onNavigation(item ? item.itemId : null);
    }
  };

  // Initial check
  handleNavigation();

  // Listen to GitHub Turbo events
  document.addEventListener('turbo:load', handleNavigation);
  document.addEventListener('turbo:render', handleNavigation);
  window.addEventListener('popstate', handleNavigation);

  // Intercept history.pushState / history.replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    handleNavigation();
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    handleNavigation();
  };

  // Observe title mutations
  const titleEl = document.querySelector('title');
  let observer: MutationObserver | null = null;
  if (titleEl) {
    observer = new MutationObserver(() => {
      handleNavigation();
    });
    observer.observe(titleEl, { childList: true });
  }

  return () => {
    document.removeEventListener('turbo:load', handleNavigation);
    document.removeEventListener('turbo:render', handleNavigation);
    window.removeEventListener('popstate', handleNavigation);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    if (observer) {
      observer.disconnect();
    }
  };
}
