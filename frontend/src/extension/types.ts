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
  | { type: 'SYNC_ITEM'; itemId: string }
  | { type: 'GET_CONFIG' }
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
  | { type: 'REPORT_DIAGNOSTIC'; report: FeatureReport };

// ---------------------------------------------------------------------------
// GitHub DOM engine diagnostics (docs/internal/extension_dom_engine_design.md section 10)
// ---------------------------------------------------------------------------

export type { FeatureId, PageKind, ScopeId, VariantId, AnchorId } from './content/dom/types';

export type DiagnosticCode =
  | 'SCOPE_UNRECOGNIZED'
  | 'SCOPE_AMBIGUOUS'
  | 'DOM_ANCHOR_MISSING'
  | 'DOM_ANCHOR_AMBIGUOUS'
  | 'DOM_ANCHOR_FALLBACK'
  | 'DOM_IDENTITY_MISMATCH'
  | 'DOM_CLASSIFY_ANOMALY'
  | 'TIMELINE_UNKNOWN_KIND'
  | 'TIMELINE_HEURISTIC_USED'
  | 'LOADMORE_FAILED'
  | 'LOADMORE_NO_PROGRESS'
  | 'ANCHOR_NOT_FOUND'
  | 'FEATURE_EXCEPTION'
  | 'FEATURE_DISABLED';

export type Severity = 'info' | 'warn' | 'error';

/** Outcome of one gated feature on one page session. 'ok' reports clear degraded state. */
export type FeatureOutcome = 'ok' | 'drifted' | 'unrecognized' | 'disabled' | 'notApplicable';

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
 * click opens, and the freshest copy of the stream's resume cursor.
 */
export interface SessionExtensionData {
  notification_urls?: Record<string, string>;
  /** Resume cursor updated on every stream message (proto JSON Timestamp). */
  last_received_at?: string;
}