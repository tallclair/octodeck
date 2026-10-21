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
  DiagnosticsSnapshot,
  FeatureHealthState,
  NotificationSettingsJson,
  StoredExtensionData,
} from './types';
import {
  FEATURE_LABELS,
  buildDiagnosticsExport,
  describeContext,
  featureNames,
  formatDiagnosticsMarkdown,
} from './background/diagnostics';
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

// ---------------------------------------------------------------------------
// GitHub compatibility panel (drift health, records, export, Safe mode)
// ---------------------------------------------------------------------------

/** Browser name and major version for reports, e.g. 'Chrome 131'. */
export function browserLabel(nav: Navigator = navigator): string {
  const brands = (nav as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData
    ?.brands;
  const brand = brands?.find((b) => /chrom/i.test(b.brand) && !/not/i.test(b.brand));
  if (brand) return `${brand.brand} ${brand.version}`;
  const m = /Chrome\/(\d+)/.exec(nav.userAgent);
  return m ? `Chrome ${m[1]}` : nav.userAgent.slice(0, 60);
}

let lastSnapshot: DiagnosticsSnapshot | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatTime(ms: number | undefined): string {
  return ms === undefined ? '' : new Date(ms).toLocaleString();
}

function healthStatusText(h: FeatureHealthState): { text: string; className: string } {
  if (h.state === 'degraded') return { text: `Paused: page layout not recognized (since ${formatTime(h.since)})`, className: 'compat-state-degraded' };
  if (h.consecutiveFailures > 0) return { text: `Not recognized on ${h.consecutiveFailures} recent page(s)`, className: '' };
  return { text: 'OK', className: 'compat-state-healthy' };
}

/** Renders the panel from a snapshot (all page-derived strings go through textContent). */
export function renderDiagnostics(snapshot: DiagnosticsSnapshot): void {
  lastSnapshot = snapshot;
  const badge = document.getElementById('compat-badge');
  const table = document.getElementById('compat-health') as HTMLTableElement | null;
  const empty = document.getElementById('compat-empty');
  const recordsEl = document.getElementById('compat-records');

  const degraded = snapshot.health.some((h) => h.state === 'degraded');
  if (badge) {
    badge.textContent = snapshot.health.length === 0 ? 'No data yet' : degraded ? 'Limited' : 'OK';
    badge.className = `status-badge ${degraded ? 'status-warning' : 'status-online'}`;
  }

  if (table) {
    const body = table.tBodies[0];
    body.replaceChildren(
      ...snapshot.health.map((h) => {
        const row = el('tr');
        const status = healthStatusText(h);
        row.append(el('td', FEATURE_LABELS[h.feature]), el('td', h.variant), el('td', status.text, status.className));
        return row;
      })
    );
    table.style.display = snapshot.health.length > 0 ? '' : 'none';
  }
  if (empty) empty.style.display = snapshot.health.length > 0 ? 'none' : '';

  if (recordsEl) {
    recordsEl.replaceChildren(
      ...snapshot.records.map((r) => {
        const details = el('details');
        const where = [r.scope, r.anchor].filter(Boolean).join(' / ');
        details.append(
          el('summary', `${featureNames(r)}: ${r.code}${where ? ` (${where})` : ''}, ${r.count}×`),
          el(
            'div',
            `Layout ${r.variant}, ${r.pageKind}, ${r.resolution}. Seen ${formatTime(r.firstSeen)} to ${formatTime(r.lastSeen)}. Extension ${r.extVersion}.`,
            'record-meta'
          )
        );
        if (r.samplePaths.length > 0) details.append(el('div', `Pages: ${r.samplePaths.join(', ')}`, 'record-meta'));
        if (r.message) details.append(el('div', `Message: ${r.message}`, 'record-meta'));
        if (r.lastContext) details.append(el('div', `Last seen ${describeContext(r.lastContext)}.`, 'record-meta'));
        if (r.fingerprint) details.append(el('pre', r.fingerprint));
        return details;
      })
    );
  }
}

export async function loadDiagnostics(): Promise<void> {
  const res = await sendMessage<DiagnosticsSnapshot>({ type: 'GET_DIAGNOSTICS' });
  if (!res.ok) {
    console.debug('[OctoDeck Options] Failed to load diagnostics:', res.error);
    return;
  }
  renderDiagnostics(res.data);
}

function reportEnvironment() {
  return { browser: browserLabel(), generatedAt: Date.now() };
}

export async function copyDiagnosticsReport(): Promise<boolean> {
  if (!lastSnapshot) await loadDiagnostics();
  if (!lastSnapshot) return false;
  try {
    await navigator.clipboard.writeText(formatDiagnosticsMarkdown(lastSnapshot, reportEnvironment()));
    showToast('Report copied');
    return true;
  } catch (err) {
    console.debug('[OctoDeck Options] Clipboard write failed:', err);
    showToast('Could not copy the report');
    return false;
  }
}

export async function downloadDiagnosticsReport(): Promise<void> {
  if (!lastSnapshot) await loadDiagnostics();
  if (!lastSnapshot) return;
  const data = buildDiagnosticsExport(lastSnapshot, reportEnvironment());
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `octodeck-diagnostics-${data.generatedAt.slice(0, 10).replace(/-/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function clearDiagnostics(): Promise<void> {
  const res = await sendMessage<boolean>({ type: 'CLEAR_DIAGNOSTICS' });
  if (!res.ok) {
    showToast('Could not clear diagnostics');
    return;
  }
  await loadDiagnostics();
  showToast('Diagnostics cleared');
}

/** Safe mode lives in chrome.storage.local ('safe_mode'); content scripts watch it. */
export async function initSafeMode(): Promise<void> {
  const checkbox = input('safe-mode');
  if (!checkbox) return;
  const { safe_mode } = (await chrome.storage.local.get(['safe_mode'])) as StoredExtensionData;
  checkbox.checked = Boolean(safe_mode);
  checkbox.addEventListener('change', () => {
    const value = checkbox.checked;
    void chrome.storage.local.set({ safe_mode: value } satisfies StoredExtensionData).then(
      () => showToast(value ? 'Safe mode on' : 'Safe mode off'),
      () => showToast('Could not save Safe mode')
    );
  });
}

let diagnosticsReloadTimer: number | null = null;

function initCompatibilityPanel(): void {
  document.getElementById('compat-copy')?.addEventListener('click', () => void copyDiagnosticsReport());
  document.getElementById('compat-download')?.addEventListener('click', () => void downloadDiagnosticsReport());
  document.getElementById('compat-clear')?.addEventListener('click', () => void clearDiagnostics());
  void initSafeMode().catch((err) => console.debug('[OctoDeck Options] Failed to read Safe mode:', err));
  void loadDiagnostics();

  // Live updates while the page is open (debounced: several tabs may report at once).
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if ((area === 'local' && changes.diag_records) || (area === 'session' && changes.diag_health)) {
      if (diagnosticsReloadTimer !== null) clearTimeout(diagnosticsReloadTimer);
      diagnosticsReloadTimer = window.setTimeout(() => {
        diagnosticsReloadTimer = null;
        void loadDiagnostics();
      }, 300);
    }
    if (area === 'local' && changes.safe_mode) {
      const checkbox = input('safe-mode');
      if (checkbox) checkbox.checked = Boolean(changes.safe_mode.newValue);
    }
  });
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

  initCompatibilityPanel();

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
