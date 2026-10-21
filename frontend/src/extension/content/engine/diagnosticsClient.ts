/**
 * Content-side half of the drift-reporting channel
 * (docs/internal/extension_dom_engine_design.md section 10.2).
 *
 * featureHost owns one client. Per page session it tells the client each gated feature's outcome
 * (setOutcome) and forwards every ctx.report() diagnostic (add). The client deduplicates, batches
 * and sends REPORT_DIAGNOSTIC messages to the background, which aggregates health and records
 * drift. The client never throws and sends nothing for a session that has ended.
 */
import type {
  Diagnostic,
  ExtensionMessage,
  ExtensionResponse,
  FeatureId,
  FeatureOutcome,
  FeatureReport,
  PageKind,
  ReportContext,
  VariantId,
} from '../../types';

/** Coalescing window between a feature's outcome and its first report. */
export const REPORT_BATCH_MS = 500;
/** Matches the background's per-report limit. */
export const MAX_DIAGNOSTICS_PER_REPORT = 10;
/** Exception text limit (the background enforces the same bound). */
export const MAX_MESSAGE_CHARS = 200;

export interface DiagnosticsSessionInfo {
  navId: string;
  pageKind: PageKind;
  /** owner/repo/(pull|issues)/N, or '' when the page isn't about an item. */
  path: string;
  ghRelease?: string;
}

export interface DiagnosticsClientDeps {
  send(msg: ExtensionMessage): Promise<ExtensionResponse>;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
  /** Clock for ReportContext.elapsedMs (default Date.now). */
  now?: () => number;
  /** Tab visibility and window focus (default: the current document). */
  pageState?: () => { visible: boolean; focused: boolean };
}

function documentPageState(): { visible: boolean; focused: boolean } {
  if (typeof document === 'undefined') return { visible: true, focused: true };
  return { visible: document.visibilityState === 'visible', focused: document.hasFocus() };
}

export interface DiagnosticsClient {
  /** Starts a page session; ends any previous one without sending its pending reports. */
  beginSession(info: DiagnosticsSessionInfo): void;
  /** Attaches a diagnostic to a feature's report (from ctx.report). Deduplicated per session. */
  add(feature: FeatureId, diagnostic: Diagnostic): void;
  /** Records the gate's decision (or a later change such as a breaker trip) for a feature. */
  setOutcome(feature: FeatureId, outcome: FeatureOutcome, variant: VariantId | 'unknown'): void;
  /** Ends the session; pending (unsent) reports are dropped. */
  endSession(): void;
}

/** Builds a page path for FeatureReport.path from an item reference. */
export function reportPath(item: { owner: string; repo: string; number: number } | null, kind: PageKind): string {
  if (!item) return '';
  const segment = kind === 'issue' ? 'issues' : 'pull';
  return `${item.owner}/${item.repo}/${segment}/${item.number}`;
}

/** Removes URLs and owner/repo-like tokens from exception text and bounds its length. */
export function scrubMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[\w.-]+\/[\w.-]+#\d+\b/g, '<item>')
    .slice(0, MAX_MESSAGE_CHARS);
}

interface FeatureState {
  outcome?: FeatureOutcome;
  variant: VariantId | 'unknown';
  /** Outcome included in the last report sent (undefined until the first send). */
  sentOutcome?: FeatureOutcome;
  /** Diagnostics not yet sent. */
  pending: Diagnostic[];
  /** Dedupe keys seen this session. */
  seen: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

function dedupeKey(d: Diagnostic): string {
  return `${d.code}|${d.scope ?? ''}|${d.anchor ?? ''}`;
}

export function createDiagnosticsClient(deps: DiagnosticsClientDeps): DiagnosticsClient {
  const now = deps.now ?? Date.now;
  const pageState = deps.pageState ?? documentPageState;
  let session: (DiagnosticsSessionInfo & { startedAt: number; visibleAtStart: boolean }) | null = null;
  let features = new Map<FeatureId, FeatureState>();

  const context = (): ReportContext | undefined => {
    if (!session) return undefined;
    try {
      const state = pageState();
      return {
        elapsedMs: Math.max(0, Math.round(now() - session.startedAt)),
        visibleAtStart: session.visibleAtStart,
        visible: state.visible,
        focused: state.focused,
      };
    } catch {
      return undefined;
    }
  };

  const stateFor = (feature: FeatureId): FeatureState => {
    let s = features.get(feature);
    if (!s) {
      s = { variant: 'unknown', pending: [], seen: new Set() };
      features.set(feature, s);
    }
    return s;
  };

  const cancelTimer = (s: FeatureState): void => {
    if (s.timer !== undefined) {
      deps.clearTimer(s.timer);
      s.timer = undefined;
    }
  };

  const flush = (feature: FeatureId): void => {
    const s = features.get(feature);
    if (!session || !s || s.outcome === undefined) return;
    cancelTimer(s);
    if (s.sentOutcome === s.outcome && s.pending.length === 0) return;
    const report: FeatureReport = {
      navId: session.navId,
      feature,
      outcome: s.outcome,
      pageKind: session.pageKind,
      variant: s.variant,
      path: session.path,
      ...(session.ghRelease ? { ghRelease: session.ghRelease } : {}),
      diagnostics: s.pending.splice(0, MAX_DIAGNOSTICS_PER_REPORT),
    };
    const ctx = context();
    if (ctx) report.context = ctx;
    s.sentOutcome = s.outcome;
    void deps.send({ type: 'REPORT_DIAGNOSTIC', report }).catch(() => {
      // Diagnostics are best effort; the messaging layer already handles orphaning.
    });
    // Anything beyond the per-report limit goes out in a follow-up.
    if (s.pending.length > 0) schedule(feature, 0);
  };

  const schedule = (feature: FeatureId, ms: number): void => {
    const s = stateFor(feature);
    if (s.timer !== undefined) {
      if (ms > 0) return; // already batching
      cancelTimer(s);
    }
    s.timer = deps.setTimer(() => {
      s.timer = undefined;
      flush(feature);
    }, ms);
  };

  const endSession = (): void => {
    for (const s of features.values()) cancelTimer(s);
    features = new Map();
    session = null;
  };

  return {
    endSession,

    beginSession(info) {
      endSession();
      let visibleAtStart = true;
      try {
        visibleAtStart = pageState().visible;
      } catch {
        // Keep the default.
      }
      session = { ...info, startedAt: now(), visibleAtStart };
    },

    add(feature, diagnostic) {
      if (!session) return;
      try {
        const s = stateFor(feature);
        const key = dedupeKey(diagnostic);
        if (s.seen.has(key)) return;
        s.seen.add(key);
        s.pending.push(
          diagnostic.message === undefined ? diagnostic : { ...diagnostic, message: scrubMessage(diagnostic.message) }
        );
        if (s.outcome === undefined) return; // sent with the outcome
        // Errors go out immediately; anything else waits for the batching window.
        schedule(feature, diagnostic.severity === 'error' || s.sentOutcome !== undefined ? 0 : REPORT_BATCH_MS);
      } catch {
        // Never let diagnostics break the engine.
      }
    },

    setOutcome(feature, outcome, variant) {
      if (!session) return;
      try {
        const s = stateFor(feature);
        const changed = s.outcome !== outcome;
        s.outcome = outcome;
        s.variant = variant;
        if (!changed && s.pending.length === 0) return;
        // First decision: coalesce with diagnostics that arrive during the settle window. Later
        // changes (e.g. a circuit-breaker trip) are sent right away.
        schedule(feature, s.sentOutcome === undefined ? REPORT_BATCH_MS : 0);
      } catch {
        // Never let diagnostics break the engine.
      }
    },
  };
}
