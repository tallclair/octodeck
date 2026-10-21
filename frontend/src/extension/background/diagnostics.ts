/**
 * Background half of the drift-reporting channel (docs/internal/extension_diagnostics_design.md):
 * validates REPORT_DIAGNOSTIC payloads, keeps live feature health (chrome.storage.session) and
 * durable drift records (chrome.storage.local), and builds the options page's snapshot and exports.
 *
 * The service worker can be suspended at any time, so all state lives in storage. Every
 * read-modify-write goes through one serialized queue so concurrent reports from several tabs
 * can't lose updates.
 */
import {
  ANCHOR_IDS,
  DIAGNOSTIC_CODES,
  FEATURE_IDS,
  FEATURE_OUTCOMES,
  PAGE_KINDS,
  SCOPE_IDS,
  SEVERITIES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticsSnapshot,
  type DriftRecord,
  type DriftResolution,
  type FeatureHealthState,
  type FeatureId,
  type FeatureOutcome,
  type FeatureReport,
  type ReportContext,
  type SessionExtensionData,
  type StoredExtensionData,
} from '../types';

// ---------------------------------------------------------------------------
// Limits and tunables
// ---------------------------------------------------------------------------

/** A feature/variant is degraded after this many consecutive failures... */
export const DEGRADED_MIN_FAILURES = 3;
/** ...spread over at least this many distinct pages (so one odd or slow page can't trip it). */
export const DEGRADED_MIN_PAGES = 2;
/** Distinct failure paths remembered per streak. */
const MAX_FAILURE_PATHS = 5;

export const MAX_RECORDS = 100;
/** Fallback (info) records may use at most this many of MAX_RECORDS, so drift can't evict breakage. */
export const MAX_INFO_RECORDS = 40;
export const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SAMPLE_PATHS = 5;
/** Remembered navId|feature outcomes, for follow-up and resend dedupe. */
const MAX_SEEN = 200;

const MAX_DIAGNOSTICS = 10;
const MAX_FINGERPRINT_CHARS = 2048;
const MAX_MESSAGE_CHARS = 200;

const RECORDS_SCHEMA = 1;
const HEALTH_SCHEMA = 1;

/** User-facing feature names (badge tooltip, options page). */
export const FEATURE_LABELS: Record<FeatureId, string> = {
  viewTracker: 'View tracking',
  actionTracker: 'Action sync',
  sidebarWidget: 'Sidebar widget',
  ackButton: 'Ack button',
  noiseCollapser: 'Noise collapsing',
  timelineMarkers: 'Timeline markers',
  expandAll: 'Expand all',
  anchorNav: 'Linked comment navigation',
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VARIANT_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PATH_RE = /^[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+$/;
const RELEASE_RE = /^[0-9a-f]{7,40}$/;
const NAV_ID_RE = /^[\w-]{8,64}$/;
/** Must match the charset content/dom/fingerprint.ts emits. */
const FINGERPRINT_RE = /^[\w\-#.*[\]=?:> \n]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

function optionalNumber(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10_000 ? v : null;
}

function parseDiagnostic(raw: unknown): Diagnostic | null {
  if (!isObject(raw) || !oneOf(DIAGNOSTIC_CODES, raw.code) || !oneOf(SEVERITIES, raw.severity)) return null;
  const d: Diagnostic = { code: raw.code, severity: raw.severity };
  if (raw.scope !== undefined) {
    if (!oneOf(SCOPE_IDS, raw.scope)) return null;
    d.scope = raw.scope;
  }
  if (raw.anchor !== undefined) {
    if (!oneOf(ANCHOR_IDS, raw.anchor)) return null;
    d.anchor = raw.anchor;
  }
  const selectorIndex = optionalNumber(raw.selectorIndex);
  const count = optionalNumber(raw.count);
  if (selectorIndex === null || count === null) return null;
  if (selectorIndex !== undefined) d.selectorIndex = selectorIndex;
  if (count !== undefined) d.count = count;
  // An invalid fingerprint is dropped rather than rejecting the whole diagnostic.
  if (
    typeof raw.fingerprint === 'string' &&
    raw.fingerprint.length <= MAX_FINGERPRINT_CHARS &&
    FINGERPRINT_RE.test(raw.fingerprint)
  ) {
    d.fingerprint = raw.fingerprint;
  }
  if (typeof raw.message === 'string') d.message = raw.message.slice(0, MAX_MESSAGE_CHARS);
  return d;
}

/**
 * Validates a REPORT_DIAGNOSTIC payload from a GitHub tab. Returns null if anything structural is
 * wrong. The path must belong to the sending tab's URL; otherwise it is cleared (the tab may have
 * navigated since), not trusted.
 */
export function parseFeatureReport(raw: unknown, senderUrl: string | undefined): FeatureReport | null {
  if (!isObject(raw)) return null;
  const { navId, feature, outcome, pageKind, variant, path, ghRelease, diagnostics } = raw;
  if (typeof navId !== 'string' || !NAV_ID_RE.test(navId)) return null;
  if (!oneOf(FEATURE_IDS, feature) || !oneOf(FEATURE_OUTCOMES, outcome) || !oneOf(PAGE_KINDS, pageKind)) return null;
  if (typeof variant !== 'string' || (variant !== 'unknown' && !VARIANT_RE.test(variant))) return null;
  if (typeof path !== 'string' || (path !== '' && !PATH_RE.test(path))) return null;
  if (ghRelease !== undefined && (typeof ghRelease !== 'string' || !RELEASE_RE.test(ghRelease))) return null;
  if (!Array.isArray(diagnostics) || diagnostics.length > MAX_DIAGNOSTICS) return null;
  const parsed: Diagnostic[] = [];
  for (const d of diagnostics) {
    const p = parseDiagnostic(d);
    if (!p) return null;
    parsed.push(p);
  }

  let senderPath = '';
  try {
    senderPath = senderUrl ? new URL(senderUrl).pathname : '';
  } catch {
    senderPath = '';
  }
  // The tab's own item path, if it is on one (sub-routes such as /files are cut off).
  const senderItem = /^\/([\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+)(?:\/|$)/.exec(senderPath)?.[1] ?? '';

  const report: FeatureReport = {
    navId,
    feature,
    outcome,
    pageKind,
    variant,
    // The reported path wins: the tab may have navigated (or GitHub redirected /issues/N to
    // /pull/N) since the session started. The tab's path fills in when none was reported.
    path: path || senderItem,
    ...(ghRelease ? { ghRelease } : {}),
    diagnostics: parsed,
  };
  if (senderItem && path && senderItem !== path) report.senderPath = senderItem;
  const context = parseContext(raw.context);
  if (context) report.context = context;
  return report;
}

function parseContext(raw: unknown): ReportContext | undefined {
  if (!isObject(raw)) return undefined;
  const { elapsedMs, visibleAtStart, visible, focused } = raw;
  if (
    typeof elapsedMs !== 'number' ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    typeof visibleAtStart !== 'boolean' ||
    typeof visible !== 'boolean' ||
    typeof focused !== 'boolean'
  ) {
    return undefined;
  }
  return { elapsedMs: Math.round(Math.min(elapsedMs, 7 * 24 * 3600 * 1000)), visibleAtStart, visible, focused };
}

// ---------------------------------------------------------------------------
// Pure state transitions
// ---------------------------------------------------------------------------

const FAILURES: readonly FeatureOutcome[] = ['unrecognized', 'disabled'];
const RESETS: readonly FeatureOutcome[] = ['ok', 'drifted'];

export function healthKey(feature: FeatureId, variant: string): string {
  return `${feature}|${variant}`;
}

/**
 * Applies one outcome to a feature/variant's health. `previous` is the outcome already counted
 * for the same page session, so a follow-up (e.g. ok → disabled) changes the streak at most once
 * per session. Returns the new state (or the input when nothing changed).
 */
export function applyOutcome(
  current: FeatureHealthState | undefined,
  report: Pick<FeatureReport, 'feature' | 'variant' | 'outcome' | 'path' | 'diagnostics'>,
  previous: FeatureOutcome | undefined,
  now: number
): FeatureHealthState | undefined {
  const { outcome } = report;
  if (outcome === 'notApplicable') return current;
  const base: FeatureHealthState = current ?? {
    feature: report.feature,
    variant: report.variant,
    state: 'healthy',
    consecutiveFailures: 0,
    failurePaths: [],
    since: now,
  };

  if (RESETS.includes(outcome)) {
    // A session that already counted as a failure doesn't un-fail by itself; only a new one does.
    if (previous !== undefined && FAILURES.includes(previous)) return current;
    const next: FeatureHealthState = { ...base, consecutiveFailures: 0, failurePaths: [], lastOkAt: now };
    if (base.state === 'degraded') {
      next.state = 'healthy';
      next.since = now;
    }
    return next;
  }

  // A failure outcome. Count it once per session.
  if (previous !== undefined && FAILURES.includes(previous)) return current;
  const failurePaths =
    report.path && !base.failurePaths.includes(report.path)
      ? [...base.failurePaths, report.path].slice(-MAX_FAILURE_PATHS)
      : base.failurePaths;
  const next: FeatureHealthState = {
    ...base,
    consecutiveFailures: base.consecutiveFailures + 1,
    failurePaths,
    lastFailureAt: now,
    lastFailureCodes: [...new Set(report.diagnostics.map((d) => d.code))],
  };
  if (
    base.state === 'healthy' &&
    next.consecutiveFailures >= DEGRADED_MIN_FAILURES &&
    next.failurePaths.length >= DEGRADED_MIN_PAGES
  ) {
    next.state = 'degraded';
    next.since = now;
  }
  return next;
}

const RESOLUTION_BY_CODE: Record<DiagnosticCode, (d: Diagnostic) => DriftResolution> = {
  SCOPE_UNRECOGNIZED: () => 'missing',
  SCOPE_AMBIGUOUS: (d) => `ambiguous:${d.count ?? 0}`,
  DOM_ANCHOR_MISSING: () => 'missing',
  DOM_ANCHOR_AMBIGUOUS: (d) => `ambiguous:${d.count ?? 0}`,
  DOM_ANCHOR_FALLBACK: (d) => `fallback:${d.selectorIndex ?? 0}`,
  DOM_IDENTITY_MISMATCH: () => 'anomaly',
  DOM_CLASSIFY_ANOMALY: () => 'anomaly',
  TIMELINE_UNKNOWN_KIND: () => 'anomaly',
  TIMELINE_HEURISTIC_USED: () => 'anomaly',
  LOADMORE_FAILED: () => 'other',
  LOADMORE_NO_PROGRESS: () => 'other',
  ANCHOR_NOT_FOUND: () => 'missing',
  FEATURE_EXCEPTION: () => 'exception',
  FEATURE_DISABLED: () => 'disabled',
};

export function resolutionOf(d: Diagnostic): DriftResolution {
  return RESOLUTION_BY_CODE[d.code](d);
}

/** 64-bit FNV-1a, hex. Stable record keys without async crypto. */
export function stableHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Record key. Scoped diagnostics (scope/anchor problems from capabilities) are the same drift no
 * matter which feature tripped over them, so the feature is only part of the key for unscoped,
 * feature-level codes (exceptions, breaker trips).
 */
export function recordKey(report: FeatureReport, d: Diagnostic, extVersion: string): string {
  return stableHash(
    [
      d.code,
      d.scope ? '' : report.feature,
      d.scope ?? '',
      d.anchor ?? '',
      report.variant,
      report.pageKind,
      resolutionOf(d),
      d.fingerprint ?? '',
      d.message ?? '',
      extVersion,
    ].join('|')
  );
}

/**
 * Codes that describe the page's content rather than GitHub's markup (e.g. a linked comment that
 * no longer exists). They still reach health via the outcome, but aren't recorded as drift.
 */
const NON_DRIFT_CODES: ReadonlySet<DiagnosticCode> = new Set(['ANCHOR_NOT_FOUND']);

function addPaths(existing: readonly string[], report: FeatureReport): string[] {
  let paths = [...existing];
  for (const p of [report.path, report.senderPath]) {
    if (p && !paths.includes(p)) paths = [...paths, p];
  }
  return paths.slice(-MAX_SAMPLE_PATHS);
}

/** Upserts one record per drift diagnostic in the report. Returns a new array (newest last). */
export function upsertRecords(records: readonly DriftRecord[], report: FeatureReport, extVersion: string, now: number): DriftRecord[] {
  const byKey = new Map(records.map((r) => [r.key, r]));
  for (const d of report.diagnostics) {
    if (NON_DRIFT_CODES.has(d.code)) continue;
    const key = recordKey(report, d, extVersion);
    const existing = byKey.get(key);
    if (existing) {
      byKey.delete(key); // re-insert so the map stays ordered by lastSeen
      byKey.set(key, {
        ...existing,
        features: existing.features.includes(report.feature) ? existing.features : [...existing.features, report.feature],
        // Several features report the same page session; count sessions, not reports.
        count: existing.lastNavId === report.navId ? existing.count : existing.count + 1,
        lastNavId: report.navId,
        lastSeen: now,
        ghReleaseLast: report.ghRelease ?? existing.ghReleaseLast,
        samplePaths: addPaths(existing.samplePaths, report),
        ...(report.context ? { lastContext: report.context } : {}),
      });
      continue;
    }
    byKey.set(key, {
      key,
      code: d.code,
      severity: d.severity,
      feature: report.feature,
      features: [report.feature],
      ...(d.scope ? { scope: d.scope } : {}),
      ...(d.anchor ? { anchor: d.anchor } : {}),
      variant: report.variant,
      pageKind: report.pageKind,
      resolution: resolutionOf(d),
      ...(d.fingerprint ? { fingerprint: d.fingerprint } : {}),
      ...(d.message ? { message: d.message } : {}),
      extVersion,
      ...(report.ghRelease ? { ghReleaseFirst: report.ghRelease, ghReleaseLast: report.ghRelease } : {}),
      firstSeen: now,
      lastSeen: now,
      count: 1,
      lastNavId: report.navId,
      samplePaths: addPaths([], report),
      ...(report.context ? { lastContext: report.context } : {}),
    });
  }
  return [...byKey.values()];
}

/** Applies retention: TTL, the info sub-cap, then the overall cap (oldest lastSeen first). */
export function pruneRecords(records: readonly DriftRecord[], now: number): DriftRecord[] {
  const fresh = records.filter((r) => now - r.lastSeen <= RECORD_TTL_MS).sort((a, b) => a.lastSeen - b.lastSeen);
  const info = fresh.filter((r) => r.severity === 'info');
  const dropInfo = new Set(info.slice(0, Math.max(0, info.length - MAX_INFO_RECORDS)));
  const kept = fresh.filter((r) => !dropInfo.has(r));
  return kept.slice(Math.max(0, kept.length - MAX_RECORDS));
}

// ---------------------------------------------------------------------------
// Exports (options page "Copy report" / "Download JSON")
// ---------------------------------------------------------------------------

export interface ReportEnvironment {
  /** e.g. 'Chrome 131' */
  browser: string;
  generatedAt: number;
}

export interface DiagnosticsExport {
  schema: number;
  generatedAt: string;
  environment: { extensionVersion: string; browser: string; githubReleases: string[] };
  health: FeatureHealthState[];
  records: DriftRecord[];
}

function releasesOf(records: readonly DriftRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) {
    if (r.ghReleaseFirst) set.add(r.ghReleaseFirst);
    if (r.ghReleaseLast) set.add(r.ghReleaseLast);
  }
  return [...set];
}

/** JSON export. Includes sample page paths (user decision 10: reports always carry repo/URL). */
export function buildDiagnosticsExport(snapshot: DiagnosticsSnapshot, env: ReportEnvironment): DiagnosticsExport {
  return {
    schema: RECORDS_SCHEMA,
    generatedAt: new Date(env.generatedAt).toISOString(),
    environment: {
      extensionVersion: snapshot.extensionVersion,
      browser: env.browser,
      githubReleases: releasesOf(snapshot.records),
    },
    health: snapshot.health,
    records: snapshot.records,
  };
}

function iso(ms: number | undefined): string {
  return ms === undefined ? '' : new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** User-facing names of every feature a record was reported by. */
export function featureNames(r: Pick<DriftRecord, 'feature' | 'features'>): string {
  return (r.features?.length ? r.features : [r.feature]).map((f) => FEATURE_LABELS[f]).join(', ');
}

/** e.g. '8.2 s after navigation; tab visible and focused (hidden at start)'. */
export function describeContext(c: ReportContext): string {
  const tab = c.visible ? (c.focused ? 'tab visible and focused' : 'tab visible, window not focused') : 'tab hidden';
  return `${(c.elapsedMs / 1000).toFixed(1)} s after navigation; ${tab}${c.visibleAtStart ? '' : ' (hidden at start)'}`;
}

/** Escapes a table cell (pipes and newlines would break the Markdown table). */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Markdown report for pasting into a GitHub issue. Includes sample page links (decision 10). */
export function formatDiagnosticsMarkdown(snapshot: DiagnosticsSnapshot, env: ReportEnvironment): string {
  const lines: string[] = [];
  lines.push('### OctoDeck companion: GitHub compatibility report', '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Extension | ${cell(snapshot.extensionVersion)} |`);
  lines.push(`| Browser | ${cell(env.browser)} |`);
  lines.push(`| GitHub release(s) | ${releasesOf(snapshot.records).join(', ') || 'unknown'} |`);
  lines.push(`| Generated | ${iso(env.generatedAt)} |`, '');

  lines.push('#### Feature health', '');
  if (snapshot.health.length === 0) {
    lines.push('No reports yet.', '');
  } else {
    lines.push('| Feature | Variant | State | Failure streak | Last failure | Codes |', '|---|---|---|---|---|---|');
    for (const h of snapshot.health) {
      lines.push(
        `| ${FEATURE_LABELS[h.feature]} | ${cell(h.variant)} | ${h.state} | ${h.consecutiveFailures} | ${iso(h.lastFailureAt)} | ${(h.lastFailureCodes ?? []).join(', ')} |`
      );
    }
    lines.push('');
  }

  lines.push('#### Drift records', '');
  if (snapshot.records.length === 0) {
    lines.push('None.');
    return lines.join('\n');
  }
  lines.push('| Code | Feature | Scope / anchor | Variant | Page | Resolution | Count | First seen | Last seen |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of snapshot.records) {
    lines.push(
      `| ${r.code} | ${featureNames(r)} | ${[r.scope, r.anchor].filter(Boolean).join(' / ')} | ${cell(r.variant)} | ${r.pageKind} | ${r.resolution} | ${r.count} | ${iso(r.firstSeen)} | ${iso(r.lastSeen)} |`
    );
  }
  lines.push('');
  for (const r of snapshot.records) {
    if (!r.fingerprint && !r.message && r.samplePaths.length === 0 && !r.lastContext) continue;
    lines.push(`<details><summary>${r.code} ${[r.scope, r.anchor].filter(Boolean).join(' / ')} (${cell(r.variant)}, ${r.resolution})</summary>`, '');
    if (r.samplePaths.length > 0) {
      lines.push('Pages:', ...r.samplePaths.map((p) => `- https://github.com/${p}`), '');
    }
    if (r.message) lines.push(`Message: \`${r.message.replace(/`/g, "'")}\``, '');
    if (r.lastContext) lines.push(`Last seen: ${describeContext(r.lastContext)}`, '');
    if (r.fingerprint) lines.push('```', r.fingerprint, '```', '');
    lines.push('</details>', '');
  }
  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Storage-backed store
// ---------------------------------------------------------------------------

export interface DiagnosticsStorage {
  local: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
  session: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
}

export interface IngestResult {
  /** Labels of degraded features (any variant), sorted. */
  degraded: string[];
  /** Whether the degraded set changed. */
  degradedChanged: boolean;
}

export interface DiagnosticsStore {
  ingest(report: FeatureReport): Promise<IngestResult>;
  /** Degraded feature labels, for rendering the toolbar after a worker restart. */
  degradedLabels(): Promise<string[]>;
  snapshot(stream: DiagnosticsSnapshot['stream']): Promise<DiagnosticsSnapshot>;
  clear(): Promise<void>;
}

function degradedLabelsOf(health: Record<string, FeatureHealthState>): string[] {
  const labels = new Set<string>();
  for (const h of Object.values(health)) if (h.state === 'degraded') labels.add(FEATURE_LABELS[h.feature]);
  return [...labels].sort();
}

export function createDiagnosticsStore(
  storage: DiagnosticsStorage,
  extVersion: string,
  now: () => number = Date.now
): DiagnosticsStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const loadHealth = async (): Promise<Record<string, FeatureHealthState>> => {
    const { diag_health } = (await storage.session.get(['diag_health'])) as SessionExtensionData;
    return diag_health?.schema === HEALTH_SCHEMA ? diag_health.health : {};
  };

  const loadRecords = async (): Promise<DriftRecord[]> => {
    const { diag_records } = (await storage.local.get(['diag_records'])) as StoredExtensionData;
    if (diag_records?.schema !== RECORDS_SCHEMA) return [];
    // Records written before features[] existed list only their first feature.
    return diag_records.records.map((r) => (Array.isArray(r.features) ? r : { ...r, features: [r.feature] }));
  };

  return {
    ingest(report) {
      return serialized(async () => {
        const t = now();
        const [health, seenData] = await Promise.all([
          loadHealth(),
          storage.session.get(['diag_seen']) as Promise<SessionExtensionData>,
        ]);
        const seen = new Map(seenData.diag_seen ?? []);
        const seenKey = `${report.navId}|${report.feature}`;
        const previous = seen.get(seenKey);
        const before = degradedLabelsOf(health);

        const key = healthKey(report.feature, report.variant);
        const next = previous === report.outcome ? health[key] : applyOutcome(health[key], report, previous, t);
        if (next) health[key] = next;
        seen.delete(seenKey);
        seen.set(seenKey, report.outcome);
        const seenEntries = [...seen.entries()].slice(-MAX_SEEN);

        const writes: Promise<void>[] = [
          storage.session.set({
            diag_health: { schema: HEALTH_SCHEMA, health },
            diag_seen: seenEntries,
          } satisfies SessionExtensionData),
        ];
        if (report.diagnostics.length > 0) {
          const records = pruneRecords(upsertRecords(await loadRecords(), report, extVersion, t), t);
          writes.push(storage.local.set({ diag_records: { schema: RECORDS_SCHEMA, records } } satisfies StoredExtensionData));
        }
        await Promise.all(writes);

        const after = degradedLabelsOf(health);
        return { degraded: after, degradedChanged: after.join('\n') !== before.join('\n') };
      });
    },

    degradedLabels() {
      return serialized(async () => degradedLabelsOf(await loadHealth()));
    },

    snapshot(stream) {
      return serialized(async () => {
        const t = now();
        const [health, records] = await Promise.all([loadHealth(), loadRecords()]);
        return {
          extensionVersion: extVersion,
          stream,
          health: Object.values(health).sort((a, b) => a.feature.localeCompare(b.feature) || a.variant.localeCompare(b.variant)),
          records: pruneRecords(records, t).reverse(),
        };
      });
    },

    clear() {
      return serialized(async () => {
        await Promise.all([storage.local.remove('diag_records'), storage.session.remove(['diag_health', 'diag_seen'])]);
      });
    },
  };
}
