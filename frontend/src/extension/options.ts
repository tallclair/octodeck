import type {
  ExtensionMessage,
  ExtensionResponse,
  NotificationFilters,
  DaemonStatus,
  BadgeCountMode,
} from './types';
import { DEFAULT_NOTIFICATION_FILTERS, DEFAULT_BADGE_COUNT_MODE } from './types';

let currentFilters: NotificationFilters = { ...DEFAULT_NOTIFICATION_FILTERS };
let currentBadgeMode: BadgeCountMode = DEFAULT_BADGE_COUNT_MODE;
let toastTimeout: number | null = null;

function showToast(msg: string = 'Settings saved') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  toastTimeout = window.setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

function parseListInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function formatListInput(list: string[]): string {
  return (list || []).join('\n');
}

async function saveFilters() {
  const notifEnabled = (document.getElementById('notif-enabled') as HTMLInputElement).checked;
  const reposInput = (document.getElementById('filter-repos') as HTMLTextAreaElement).value;
  const labelsInput = (document.getElementById('filter-labels') as HTMLTextAreaElement).value;
  const authorsInput = (document.getElementById('filter-authors') as HTMLTextAreaElement).value;
  const assignedOnly = (document.getElementById('notif-assigned') as HTMLInputElement).checked;
  const ignoreBots = (document.getElementById('notif-ignore-bots') as HTMLInputElement).checked;
  const newItems = (document.getElementById('notif-new-items') as HTMLInputElement).checked;
  const activity = (document.getElementById('notif-activity') as HTMLInputElement).checked;

  currentFilters = {
    ...currentFilters,
    enabled: notifEnabled,
    repos: parseListInput(reposInput),
    labels: parseListInput(labelsInput),
    authors: parseListInput(authorsInput),
    onlyAssignedOrAuthored: assignedOnly,
    ignoreBots: ignoreBots,
    notifyOnNewItems: newItems,
    notifyOnNewActivity: activity,
  };

  const msg: ExtensionMessage = {
    type: 'SAVE_NOTIFICATION_FILTERS',
    filters: currentFilters,
  };

  chrome.runtime.sendMessage(msg, (res: ExtensionResponse | undefined) => {
    if (res && res.ok) {
      showToast();
    }
  });
}

async function saveBadgeMode(mode: BadgeCountMode) {
  currentBadgeMode = mode;
  const msg: ExtensionMessage = {
    type: 'SET_BADGE_COUNT_MODE',
    mode: currentBadgeMode,
  };

  chrome.runtime.sendMessage(msg, (res: ExtensionResponse | undefined) => {
    if (res && res.ok) {
      showToast();
    }
  });
}

function setMode(mode: 'include' | 'exclude') {
  currentFilters.filterMode = mode;
  const btnExclude = document.getElementById('mode-exclude');
  const btnInclude = document.getElementById('mode-include');

  if (mode === 'exclude') {
    btnExclude?.classList.add('active');
    btnInclude?.classList.remove('active');
  } else {
    btnInclude?.classList.add('active');
    btnExclude?.classList.remove('active');
  }
  saveFilters();
}

export function getExtensionVersion(): string {
  try {
    const manifest = typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.() : undefined;
    return (
      manifest?.version_name ||
      manifest?.version ||
      (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown')
    );
  } catch {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  }
}

export function updateDaemonUI(status: DaemonStatus): void {
  const badge = document.getElementById('daemon-badge');
  const info = document.getElementById('daemon-info');
  const extVerEl = document.getElementById('extension-version');
  const daemonVerEl = document.getElementById('daemon-version');
  const mismatchWarn = document.getElementById('version-mismatch-warning');
  const warnExtVer = document.getElementById('warn-ext-version');
  const warnDaemonVer = document.getElementById('warn-daemon-version');

  const extVersion = getExtensionVersion();
  if (extVerEl) {
    extVerEl.textContent = extVersion;
  }

  if (daemonVerEl) {
    daemonVerEl.textContent = status.online ? (status.version || 'unknown') : 'Unavailable';
  }

  if (status.online) {
    if (badge) {
      badge.className = 'status-badge status-online';
      badge.textContent = `Online (v${status.version || 'unknown'})`;
    }
    if (info) {
      info.textContent = status.ghAuthenticated
        ? 'Connected to local daemon. GitHub authenticated.'
        : 'Connected to local daemon. Upstream GitHub authentication required.';
    }

    if (mismatchWarn) {
      if (status.version && status.version !== extVersion) {
        mismatchWarn.style.display = 'block';
        if (warnExtVer) warnExtVer.textContent = extVersion;
        if (warnDaemonVer) warnDaemonVer.textContent = status.version;
      } else {
        mismatchWarn.style.display = 'none';
      }
    }
  } else {
    if (badge) {
      badge.className = 'status-badge status-offline';
      badge.textContent = 'Offline';
    }
    if (info) {
      info.textContent = `Unable to connect to local OctoDeck daemon: ${status.error || 'Connection refused'}. Run 'octodeck serve'.`;
    }
    if (mismatchWarn) {
      mismatchWarn.style.display = 'none';
    }
  }
}

async function init() {
  // Populate extension version immediately
  const extVerEl = document.getElementById('extension-version');
  if (extVerEl) {
    extVerEl.textContent = getExtensionVersion();
  }

  // Check Daemon Status
  chrome.runtime.sendMessage({ type: 'GET_DAEMON_STATUS' }, (res: ExtensionResponse<DaemonStatus> | undefined) => {
    if (res && res.ok) {
      updateDaemonUI(res.data);
    } else {
      updateDaemonUI({ online: false, error: res?.error || 'Daemon unreachable' });
    }
  });

  // Load Badge Mode
  chrome.runtime.sendMessage({ type: 'GET_BADGE_COUNT_MODE' }, (res: ExtensionResponse<BadgeCountMode> | undefined) => {
    if (res && res.ok) {
      currentBadgeMode = res.data;
    }
    const radioInbox = document.getElementById('badge-mode-inbox') as HTMLInputElement | null;
    const radioUnread = document.getElementById('badge-mode-unread') as HTMLInputElement | null;
    const radioDisabled = document.getElementById('badge-mode-disabled') as HTMLInputElement | null;

    if (currentBadgeMode === 'unread' && radioUnread) {
      radioUnread.checked = true;
    } else if (currentBadgeMode === 'disabled' && radioDisabled) {
      radioDisabled.checked = true;
    } else if (radioInbox) {
      radioInbox.checked = true;
    }

    const badgeRadios = [radioInbox, radioUnread, radioDisabled];
    for (const radio of badgeRadios) {
      radio?.addEventListener('change', () => {
        if (radio.checked) {
          saveBadgeMode(radio.value as BadgeCountMode);
        }
      });
    }
  });

  // Load Filters
  chrome.runtime.sendMessage({ type: 'GET_NOTIFICATION_FILTERS' }, (res: ExtensionResponse<NotificationFilters> | undefined) => {
    if (res && res.ok) {
      currentFilters = res.data;
    }

    const notifEnabled = document.getElementById('notif-enabled') as HTMLInputElement;
    const filterPanel = document.getElementById('filter-options-panel');
    const reposInput = document.getElementById('filter-repos') as HTMLTextAreaElement;
    const labelsInput = document.getElementById('filter-labels') as HTMLTextAreaElement;
    const authorsInput = document.getElementById('filter-authors') as HTMLTextAreaElement;
    const assignedOnly = document.getElementById('notif-assigned') as HTMLInputElement;
    const ignoreBots = document.getElementById('notif-ignore-bots') as HTMLInputElement;
    const newItems = document.getElementById('notif-new-items') as HTMLInputElement;
    const activity = document.getElementById('notif-activity') as HTMLInputElement;

    if (notifEnabled) notifEnabled.checked = currentFilters.enabled;
    if (filterPanel) filterPanel.style.display = currentFilters.enabled ? 'block' : 'none';

    setMode(currentFilters.filterMode);

    if (reposInput) reposInput.value = formatListInput(currentFilters.repos);
    if (labelsInput) labelsInput.value = formatListInput(currentFilters.labels);
    if (authorsInput) authorsInput.value = formatListInput(currentFilters.authors);
    if (assignedOnly) assignedOnly.checked = currentFilters.onlyAssignedOrAuthored;
    if (ignoreBots) ignoreBots.checked = currentFilters.ignoreBots;
    if (newItems) newItems.checked = currentFilters.notifyOnNewItems;
    if (activity) activity.checked = currentFilters.notifyOnNewActivity;

    // Attach listeners
    notifEnabled?.addEventListener('change', () => {
      if (filterPanel) filterPanel.style.display = notifEnabled.checked ? 'block' : 'none';
      saveFilters();
    });

    document.getElementById('mode-exclude')?.addEventListener('click', () => setMode('exclude'));
    document.getElementById('mode-include')?.addEventListener('click', () => setMode('include'));

    const textInputs = [reposInput, labelsInput, authorsInput];
    for (const input of textInputs) {
      input?.addEventListener('change', () => saveFilters());
    }

    const checkInputs = [assignedOnly, ignoreBots, newItems, activity];
    for (const input of checkInputs) {
      input?.addEventListener('change', () => saveFilters());
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
