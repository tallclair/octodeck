import { initViewTracker, parseCurrentGitHubItem } from './content/viewTracker';
import { NoiseCollapser } from './content/noiseCollapser';
import { SidebarSection } from './content/sidebarSection';
import { TimelineMarkers } from './content/timelineMarkers';
import { initActionTracker } from './content/actionTracker';
import type { ExtensionMessage, ExtensionResponse } from './types';

let activeSidebar: SidebarSection | null = null;
let activeCollapser: NoiseCollapser | null = null;
let activeTimelineMarkers: TimelineMarkers | null = null;
let currentItemId: string | null = null;
let debounceTimeout: number | null = null;

const STORAGE_KEY_HIDE_EVENTS = 'octodeck_hide_events';


function getLocalHideEventsPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_HIDE_EVENTS) === 'true';
  } catch {
    return false;
  }
}

function setLocalHideEventsPreference(hide: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_HIDE_EVENTS, String(hide));
  } catch {
    // Ignore storage errors
  }
}

async function fetchGlobalHideEventsPreference(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const msg: ExtensionMessage = { type: 'GET_HIDE_EVENTS' };
      chrome.runtime.sendMessage(msg, (response: ExtensionResponse<boolean> | undefined) => {
        if (response && response.ok && typeof response.data === 'boolean') {
          setLocalHideEventsPreference(response.data);
          resolve(response.data);
        } else {
          resolve(getLocalHideEventsPreference());
        }
      });
    } catch {
      resolve(getLocalHideEventsPreference());
    }
  });
}

function updateGlobalHideEventsPreference(hide: boolean): void {
  setLocalHideEventsPreference(hide);
  try {
    const msg: ExtensionMessage = { type: 'SET_HIDE_EVENTS', hideEvents: hide };
    chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.debug('[OctoDeck] Could not save hide_events via extension message:', err);
  }
}

async function fetchKnownBots(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['known_bots'], (res) => {
          if (res && Array.isArray(res.known_bots) && res.known_bots.length > 0) {
            resolve(res.known_bots);
            return;
          }
          // Fallback to background query
          const msg: ExtensionMessage = { type: 'GET_KNOWN_BOTS' };
          chrome.runtime.sendMessage(msg, (response: ExtensionResponse<string[]> | undefined) => {
            if (response && response.ok && Array.isArray(response.data)) {
              resolve(response.data);
            } else {
              resolve([]);
            }
          });
        });
      } else {
        resolve([]);
      }
    } catch {
      resolve([]);
    }
  });
}

function handleBotDiscovered(login: string): void {
  try {
    const msg: ExtensionMessage = { type: 'ADD_KNOWN_BOTS', logins: [login] };
    chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.debug('[OctoDeck] Could not notify bot discovery:', err);
  }
}

async function handlePageTransition(itemId: string | null) {
  if (activeSidebar) {
    activeSidebar.destroy();
    activeSidebar = null;
  }
  if (activeCollapser) {
    activeCollapser.cleanup();
    activeCollapser = null;
  }
  if (activeTimelineMarkers) {
    activeTimelineMarkers.destroy();
    activeTimelineMarkers = null;
  }

  const currentItem = parseCurrentGitHubItem();
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('octodeck-gh-page-issue', Boolean(currentItem?.isIssue));
    document.body.classList.toggle('octodeck-gh-page-pr', Boolean(currentItem?.isPullRequest));
  }

  if (itemId) {
    console.log(`[OctoDeck] Initializing companion UI for ${itemId}`);
    const hideEvents = await fetchGlobalHideEventsPreference();
    const knownBots = await fetchKnownBots();

    activeCollapser = new NoiseCollapser(document.body, knownBots, handleBotDiscovered);
    activeTimelineMarkers = new TimelineMarkers(document.body);

    activeSidebar = new SidebarSection(
      itemId,
      hideEvents,
      (hide) => {
        updateGlobalHideEventsPreference(hide);
        activeCollapser?.setHideNonCommentEvents(hide);
      },
      (item) => {
        activeTimelineMarkers?.update(item);
      }
    );

    await activeSidebar.init(document.body);
    activeCollapser.run(hideEvents);
  } else {
    console.debug('[OctoDeck] Not on a recognized PR or issue page');
  }
}

function onNavigate(itemId: string | null) {
  if (itemId === currentItemId && activeSidebar) {
    return;
  }
  currentItemId = itemId;

  if (debounceTimeout !== null) {
    clearTimeout(debounceTimeout);
  }
  debounceTimeout = window.setTimeout(() => {
    handlePageTransition(itemId);
  }, 50);
}

export function initGitHubFeatures(): void {
  console.log('[OctoDeck] Companion content script initialized on', window.location.href);

  // Listen for global storage changes from other tabs or background
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.hide_events !== undefined) {
          const newHide = Boolean(changes.hide_events.newValue);
          setLocalHideEventsPreference(newHide);
          activeSidebar?.setHideEvents(newHide);
          activeCollapser?.setHideNonCommentEvents(newHide);
        }
        if (changes.known_bots !== undefined) {
          const newBots = Array.isArray(changes.known_bots.newValue) ? changes.known_bots.newValue : [];
          activeCollapser?.setKnownBots(newBots);
        }
      }
    });
  }

  // Initialize navigation tracking
  initViewTracker((itemId) => {
    onNavigate(itemId);
  });

  // Initialize action tracking for PR/issue user actions
  initActionTracker();

  // Run once immediately
  const initialItem = parseCurrentGitHubItem();
  if (initialItem) {
    onNavigate(initialItem.itemId);
  }
}

export function initContentScript(): void {
  initGitHubFeatures();
}

// Auto-run if loaded in browser context
if (typeof window !== 'undefined') {
  initContentScript();
}
