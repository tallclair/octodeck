import type { JsonObject } from '@bufbuild/protobuf';
import { ItemStatus } from '../api/octodeck/v1/resources_pb';
import type { AnchorId, FeatureId, PageKind, ScopeId, VariantId } from './content/dom/types';

/** octodeck.v1.NotificationSettings in its proto JSON form. */
export type NotificationSettingsJson = JsonObject;

export { ItemStatus };
export type ItemStatusType = ItemStatus;

export type ExtensionMessage =
  | { type: 'GET_ITEM'; itemId: string }
  | { type: 'VIEW_ITEM'; itemId: string }
  | { type: 'ACK_ITEM'; itemId: string; acked?: boolean }
  | { type: 'STAR_ITEM'; itemId: string; starred: boolean }
  | { type: 'SET_NOTES'; itemId: string; notes: string }
  | { type: 'REFETCH_ITEM'; itemId: string }
  | { type: 'GET_KNOWN_BOTS' }
  | { type: 'GET_DAEMON_STATUS' }
  | { type: 'OPEN_DASHBOARD'; itemId?: string }
  // Notification settings live in the daemon config; they cross the message channel in their
  // proto JSON form.
  | { type: 'GET_NOTIFICATION_SETTINGS' }
  | { type: 'SAVE_NOTIFICATION_SETTINGS'; settings: NotificationSettingsJson }
  | { type: 'GET_HIDE_EVENTS' }
  | { type: 'SET_HIDE_EVENTS'; hideEvents: boolean }
  // Per page session and gated feature outcome from the content-script DOM engine.
  | { type: 'REPORT_DIAGNOSTIC'; report: FeatureReport }
  // Extension pages only: the GitHub compatibility panel on the options page.
  | { type: 'GET_DIAGNOSTICS' }
  | { type: 'CLEAR_DIAGNOSTICS' };

export type ExtensionMessageType = ExtensionMessage['type'];

// ---------------------------------------------------------------------------
// GitHub DOM engine diagnostics (docs/internal/extension_dom_engine_design.md section 10)
// ---------------------------------------------------------------------------

export type { FeatureId, PageKind, ScopeId, VariantId, AnchorId } from './content/dom/types';
export { FEATURE_IDS, PAGE_KINDS, SCOPE_IDS, ANCHOR_IDS } from './content/dom/types';

export const DIAGNOSTIC_CODES = [
  'SCOPE_UNRECOGNIZED',
  'SCOPE_AMBIGUOUS',
  'DOM_ANCHOR_MISSING',
  'DOM_ANCHOR_AMBIGUOUS',
  'DOM_ANCHOR_FALLBACK',
  'DOM_IDENTITY_MISMATCH',
  'DOM_CLASSIFY_ANOMALY',
  'TIMELINE_UNKNOWN_KIND',
  'TIMELINE_HEURISTIC_USED',
  'LOADMORE_FAILED',
  'LOADMORE_NO_PROGRESS',
  'ANCHOR_NOT_FOUND',
  'FEATURE_EXCEPTION',
  'FEATURE_DISABLED',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export const SEVERITIES = ['info', 'warn', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Outcome of one gated feature on one page session. 'ok' reports clear degraded state. */
export const FEATURE_OUTCOMES = ['ok', 'drifted', 'unrecognized', 'disabled', 'notApplicable'] as const;
export type FeatureOutcome = (typeof FEATURE_OUTCOMES)[number];

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  scope?: ScopeId;
  anchor?: AnchorId;
  /** Selector index that matched (FALLBACK / AMBIGUOUS). */
  selectorIndex?: number;
  /** Match count (AMBIGUOUS). */
  count?: number;
  /** Sanitized structural fingerprint (design section 10.3), at most 2 KB. */
  fingerprint?: string;
  /** Scrubbed exception text, at most 200 characters. */
  message?: string;
}

export interface FeatureReport {
  /** Random per page session; lets the background dedupe resends. */
  navId: string;
  feature: FeatureId;
  outcome: FeatureOutcome;
  pageKind: PageKind;
  /** Variant of the feature's primary required scope. */
  variant: VariantId | 'unknown';
  /** owner/repo/(pull|issues)/N */
  path: string;
  /** GitHub deploy SHA from meta[name=release]. */
  ghRelease?: string;
  /** At most 10. */
  diagnostics: Diagnostic[];
  /** Page state when the report was sent, to tell lazy rendering apart from drift. */
  context?: ReportContext;
  /**
   * Set by the background only (never taken from content): the sending tab's item path when it
   * differs from `path`, e.g. after GitHub redirected /issues/N to /pull/N.
   */
  senderPath?: string;
}

export interface ReportContext {
  /** Milliseconds since the page session started. */
  elapsedMs: number;
  /** Whether the tab was visible when the session started. */
  visibleAtStart: boolean;
  /** Whether the tab was visible / the window focused when the report was sent. */
  visible: boolean;
  focused: boolean;
}

/**
 * Live health of one feature in one markup variant (chrome.storage.session). Keyed per variant so
 * one arm of a GitHub A/B test can degrade on its own.
 */
export interface FeatureHealthState {
  feature: FeatureId;
  variant: VariantId | 'unknown';
  state: 'healthy' | 'degraded';
  /** 'unrecognized' / 'disabled' outcomes since the last 'ok' / 'drifted'. */
  consecutiveFailures: number;
  /** Distinct page paths in the current failure streak (capped). */
  failurePaths: string[];
  lastOkAt?: number;
  lastFailureAt?: number;
  lastFailureCodes?: DiagnosticCode[];
  /** When state last changed. */
  since: number;
}

/** How a drift record's anchor or feature failed. */
export type DriftResolution =
  | `fallback:${number}`
  | 'missing'
  | `ambiguous:${number}`
  | 'exception'
  | 'disabled'
  | 'anomaly'
  | 'other';

/**
 * Durable, deduplicated record of one kind of drift (chrome.storage.local), detailed enough for a
 * developer to update the DOM contract.
 */
export interface DriftRecord {
  /**
   * Hash of code|scope|anchor|variant|pageKind|resolution|fingerprint|message|extVersion, plus the
   * feature for unscoped (feature-level) diagnostics. Scoped diagnostics are shared by every
   * feature that uses the scope, so they produce one record listing all of them.
   */
  key: string;
  code: DiagnosticCode;
  severity: Severity;
  /** First feature that reported it. */
  feature: FeatureId;
  /** Every feature that reported it. */
  features: FeatureId[];
  scope?: ScopeId;
  anchor?: AnchorId;
  variant: VariantId | 'unknown';
  pageKind: PageKind;
  resolution: DriftResolution;
  fingerprint?: string;
  message?: string;
  extVersion: string;
  ghReleaseFirst?: string;
  ghReleaseLast?: string;
  firstSeen: number;
  lastSeen: number;
  /** Number of page sessions it was seen in. */
  count: number;
  /** Page session that last counted (several features report the same session). */
  lastNavId?: string;
  /** Distinct sample page paths (owner/repo/kind/N), newest last, capped. */
  samplePaths: string[];
  /** Page state of the most recent occurrence. */
  lastContext?: ReportContext;
}

/** Extension-side connection state of the daemon notification stream. */
export type DaemonStreamStatus = 'connected' | 'offline' | 'setup' | 'version-mismatch';

/** Everything the options page's GitHub compatibility panel shows. */
export interface DiagnosticsSnapshot {
  extensionVersion: string;
  stream: { status: DaemonStreamStatus; since: number } | null;
  health: FeatureHealthState[];
  records: DriftRecord[];
}

export type ExtensionResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface DaemonStatus {
  online: boolean;
  version?: string;
  ghAuthenticated?: boolean;
  error?: string;
}

export interface StoredExtensionData {
  bearer_token?: string;
  hide_events?: boolean;
  known_bots?: string[];
  /** Resume cursor of the notification stream (proto JSON Timestamp). */
  last_received_at?: string;
  /** Global Safe mode switch (options page): content mutators off, OctoDeck UI hidden on GitHub. */
  safe_mode?: boolean;
  /** Drift records, newest last (background/diagnostics.ts). */
  diag_records?: { schema: number; records: DriftRecord[] };
}

/** Keys written by earlier extension versions that are removed on install/update. */
export const OBSOLETE_STORAGE_KEYS = [
  'notification_filters',
  'last_notified_timestamps',
  'last_known_user_login',
  'badge_count_mode',
] as const;

/**
 * Session storage (cleared when the browser exits): shown notification IDs mapped to the URL a
 * click opens, the freshest copy of the stream's resume cursor, live diagnostics health and the
 * toolbar action state.
 */
export interface SessionExtensionData {
  notification_urls?: Record<string, string>;
  /** Resume cursor updated on every stream message (proto JSON Timestamp). */
  last_received_at?: string;
  /** Live feature health, keyed 'feature|variant' (background/diagnostics.ts). */
  diag_health?: { schema: number; health: Record<string, FeatureHealthState> };
  /** Last outcome per 'navId|feature', so resent or follow-up reports count once (bounded). */
  diag_seen?: [string, FeatureOutcome][];
  /** Toolbar action inputs (background/action.ts). */
  action_state?: ActionState;
}

/** Inputs to the single toolbar renderer (background/action.ts). */
export interface ActionState {
  stream: { status: DaemonStreamStatus; since: number } | null;
  /** Last badge pushed by the daemon. */
  badge: { text: string; tooltip: string } | null;
  /** Human-readable names of degraded features (global). */
  degraded: string[];
  /** Per tab: the latest session's limited features on that tab. */
  tabs: Record<string, { navId: string; limited: string[] }>;
}