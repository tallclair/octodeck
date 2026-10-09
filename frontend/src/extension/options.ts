import { create, fromJson, toJson } from '@bufbuild/protobuf';
import {
  BadgeCountMode,
  NotificationSettingsSchema,
  type NotificationSettings,
} from '../api/octodeck/v1/service_pb';
import type {
  ExtensionMessage,
  ExtensionResponse,
  DaemonStatus,
  NotificationSettingsJson,
} from './types';
import { parseFilterPatterns, serializeFilterPatterns, validateBasePattern, validateFilterPatterns } from '../utils/patterns';
import { validateRepoFilterPatterns } from '../utils/repos';
import { validateLabelFilterPatterns } from '../utils/labels';

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

function sendMessage<T>(msg: ExtensionMessage): Promise<ExtensionResponse<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res: ExtensionResponse<T> | undefined) => {
      resolve(res ?? { ok: false, error: chrome.runtime.lastError?.message || 'No response from background' });
    });
  });
}

// ---------------------------------------------------------------------------
// Settings <-> form mapping
// ---------------------------------------------------------------------------

export type BadgeModeValue = 'inbox' | 'unread' | 'disabled';

/** The notification and badge settings as edited on the options page. */
export interface SettingsForm {
  enabled: boolean;
  /** Pattern textareas: one pattern per line, '!' prefix for excludes. */
  repos: string;
  labels: string;
  authors: string;
  alwaysIncludeMentions: boolean;
  onlyAssignedOrAuthored: boolean;
  ignoreBots: boolean;
  notifyOnNewItems: boolean;
  notifyOnNewActivity: boolean;
  badgeMode: BadgeModeValue;
}

export type SettingsFormErrors = Partial<Record<'repos' | 'labels' | 'authors', string>>;

function badgeModeToValue(mode: BadgeCountMode): BadgeModeValue {
  switch (mode) {
    case BadgeCountMode.UNREAD:
      return 'unread';
    case BadgeCountMode.DISABLED:
      return 'disabled';
    default:
      return 'inbox';
  }
}

function badgeModeFromValue(value: BadgeModeValue): BadgeCountMode {
  switch (value) {
    case 'unread':
      return BadgeCountMode.UNREAD;
    case 'disabled':
      return BadgeCountMode.DISABLED;
    default:
      return BadgeCountMode.INBOX;
  }
}

export function settingsToForm(s: NotificationSettings): SettingsForm {
  return {
    enabled: s.enabled,
    repos: serializeFilterPatterns(s.repoIncludes, s.repoExcludes),
    labels: serializeFilterPatterns(s.labelIncludes, s.labelExcludes),
    authors: serializeFilterPatterns(s.authorIncludes, s.authorExcludes),
    alwaysIncludeMentions: s.alwaysIncludeMentions,
    onlyAssignedOrAuthored: s.onlyAssignedOrAuthored,
    ignoreBots: s.ignoreBots,
    notifyOnNewItems: s.notifyOnNewItems,
    notifyOnNewActivity: s.notifyOnNewActivity,
    badgeMode: badgeModeToValue(s.badgeCountMode),
  };
}

export function formToSettings(form: SettingsForm): NotificationSettings {
  const repos = parseFilterPatterns(form.repos);
  const labels = parseFilterPatterns(form.labels);
  const authors = parseFilterPatterns(form.authors);
  return create(NotificationSettingsSchema, {
    enabled: form.enabled,
    repoIncludes: repos.includes,
    repoExcludes: repos.excludes,
    labelIncludes: labels.includes,
    labelExcludes: labels.excludes,
    authorIncludes: authors.includes,
    authorExcludes: authors.excludes,
    alwaysIncludeMentions: form.alwaysIncludeMentions,
    onlyAssignedOrAuthored: form.onlyAssignedOrAuthored,
    ignoreBots: form.ignoreBots,
    notifyOnNewItems: form.notifyOnNewItems,
    notifyOnNewActivity: form.notifyOnNewActivity,
    badgeCountMode: badgeModeFromValue(form.badgeMode),
  });
}

export function validateSettingsForm(form: SettingsForm): SettingsFormErrors {
  const errors: SettingsFormErrors = {};
  const repos = validateRepoFilterPatterns(form.repos);
  if (repos) errors.repos = repos;
  const labels = validateLabelFilterPatterns(form.labels);
  if (labels) errors.labels = labels;
  const authors = validateFilterPatterns(form.authors, (p) => validateBasePattern(p, 'Author').error);
  if (authors) errors.authors = authors;
  return errors;
}

// ---------------------------------------------------------------------------
// DOM binding
// ---------------------------------------------------------------------------

const CHECKBOXES = {
  enabled: 'notif-enabled',
  alwaysIncludeMentions: 'notif-mentions',
  onlyAssignedOrAuthored: 'notif-assigned',
  ignoreBots: 'notif-ignore-bots',
  notifyOnNewItems: 'notif-new-items',
  notifyOnNewActivity: 'notif-activity',
} as const satisfies Partial<Record<keyof SettingsForm, string>>;

const TEXTAREAS = {
  repos: 'filter-repos',
  labels: 'filter-labels',
  authors: 'filter-authors',
} as const satisfies Partial<Record<keyof SettingsForm, string>>;

const BADGE_RADIOS: Record<BadgeModeValue, string> = {
  inbox: 'badge-mode-inbox',
  unread: 'badge-mode-unread',
  disabled: 'badge-mode-disabled',
};

function input(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function textarea(id: string): HTMLTextAreaElement | null {
  return document.getElementById(id) as HTMLTextAreaElement | null;
}

export function readForm(): SettingsForm {
  const checked = (id: string) => Boolean(input(id)?.checked);
  const text = (id: string) => textarea(id)?.value ?? '';
  const badgeMode =
    (Object.keys(BADGE_RADIOS) as BadgeModeValue[]).find((m) => input(BADGE_RADIOS[m])?.checked) ?? 'inbox';
  return {
    enabled: checked(CHECKBOXES.enabled),
    repos: text(TEXTAREAS.repos),
    labels: text(TEXTAREAS.labels),
    authors: text(TEXTAREAS.authors),
    alwaysIncludeMentions: checked(CHECKBOXES.alwaysIncludeMentions),
    onlyAssignedOrAuthored: checked(CHECKBOXES.onlyAssignedOrAuthored),
    ignoreBots: checked(CHECKBOXES.ignoreBots),
    notifyOnNewItems: checked(CHECKBOXES.notifyOnNewItems),
    notifyOnNewActivity: checked(CHECKBOXES.notifyOnNewActivity),
    badgeMode,
  };
}

export function writeForm(form: SettingsForm): void {
  for (const [key, id] of Object.entries(CHECKBOXES) as [keyof typeof CHECKBOXES, string][]) {
    const el = input(id);
    if (el) el.checked = form[key];
  }
  for (const [key, id] of Object.entries(TEXTAREAS) as [keyof typeof TEXTAREAS, string][]) {
    const el = textarea(id);
    if (el) el.value = form[key];
  }
  const radio = input(BADGE_RADIOS[form.badgeMode]);
  if (radio) radio.checked = true;
  updateFilterPanelVisibility(form.enabled);
}

function updateFilterPanelVisibility(enabled: boolean): void {
  const panel = document.getElementById('filter-options-panel');
  if (panel) panel.style.display = enabled ? 'block' : 'none';
}

function showFormErrors(errors: SettingsFormErrors): void {
  for (const [key, id] of Object.entries(TEXTAREAS) as [keyof typeof TEXTAREAS, string][]) {
    const el = document.getElementById(`${id}-error`);
    if (!el) continue;
    const msg = errors[key];
    el.textContent = msg ?? '';
    el.classList.toggle('show', Boolean(msg));
  }
}

/** Enables editing when the daemon provided the settings, or shows why it can't. */
export function setSettingsAvailable(available: boolean): void {
  for (const id of ['badge-settings', 'notification-settings']) {
    const fieldset = document.getElementById(id) as HTMLFieldSetElement | null;
    if (fieldset) fieldset.disabled = !available;
  }
  document.getElementById('settings-unavailable')?.classList.toggle('show', !available);
}

export async function loadSettings(): Promise<boolean> {
  const res = await sendMessage<NotificationSettingsJson>({ type: 'GET_NOTIFICATION_SETTINGS' });
  if (!res.ok) {
    console.debug('[OctoDeck Options] Failed to load notification settings:', res.error);
    setSettingsAvailable(false);
    return false;
  }
  writeForm(settingsToForm(fromJson(NotificationSettingsSchema, res.data, { ignoreUnknownFields: true })));
  setSettingsAvailable(true);
  return true;
}

export async function saveSettings(): Promise<boolean> {
  const form = readForm();
  updateFilterPanelVisibility(form.enabled);
  const errors = validateSettingsForm(form);
  showFormErrors(errors);
  if (Object.keys(errors).length > 0) {
    return false;
  }
  const settings = toJson(NotificationSettingsSchema, formToSettings(form)) as NotificationSettingsJson;
  const res = await sendMessage<NotificationSettingsJson>({ type: 'SAVE_NOTIFICATION_SETTINGS', settings });
  if (!res.ok) {
    showToast('Failed to save settings: daemon unreachable');
    return false;
  }
  showToast();
  return true;
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

export async function initOptions(): Promise<void> {
  // Populate extension version immediately
  const extVerEl = document.getElementById('extension-version');
  if (extVerEl) {
    extVerEl.textContent = getExtensionVersion();
  }

  // Check Daemon Status
  void sendMessage<DaemonStatus>({ type: 'GET_DAEMON_STATUS' }).then((res) => {
    updateDaemonUI(res.ok ? res.data : { online: false, error: res.error || 'Daemon unreachable' });
  });

  // Every control saves the whole settings message on change.
  const controls = [
    ...Object.values(CHECKBOXES).map(input),
    ...Object.values(BADGE_RADIOS).map(input),
    ...Object.values(TEXTAREAS).map(textarea),
  ];
  for (const control of controls) {
    control?.addEventListener('change', () => {
      void saveSettings();
    });
  }

  await loadSettings();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void initOptions();
  });
}
