# OctoDeck Companion: Diagnostics, Drift Recording and Background Router

This document details §10 of [extension_dom_engine_design.md](extension_dom_engine_design.md). It covers how the content-script DOM engine reports GitHub markup drift, how the background service worker validates, aggregates and records it, how drift shows up to the user, and how messages from content scripts and extension pages are routed and access-checked.

User decisions referenced below are numbered as in §14 of the engine design.

## Goals

1. One channel (`REPORT_DIAGNOSTIC`) carries per-page-session feature outcomes, including **ok**, plus discrete events such as exceptions and circuit-breaker trips.
2. **Live health** answers "is GitHub integration degraded right now?" without flapping on slow or unusual pages.
3. **Durable drift records** carry enough detail for a developer to update the DOM contract without reproducing the problem: which anchor, which variant, which fallback, the sanitized structure around the miss, and the GitHub release.
4. A report the user can export and share.
5. A router that validates every message and enforces which context may send what.

**Non-goals:** remote telemetry; automatic selector repair; sending page text anywhere.

## Components

| File | Role |
|---|---|
| `content/engine/diagnosticsClient.ts` | Content side. featureHost calls it. Deduplicates, batches and sends reports. |
| `content/dom/fingerprint.ts` | Sanitized structural fingerprint of a DOM subtree. |
| `background/router.ts` | Table-driven `onMessage` router: sender classification, per-type contexts, payload parsers, rate limit. |
| `background/diagnostics.ts` | Report validation, live health, drift records, retention, snapshot and exports. |
| `background/action.ts` | Single toolbar renderer over persisted state (daemon stream status, daemon badge, degraded features, per-tab detail). |
| `options.ts` / `options.html` | The "GitHub Compatibility" panel. |
| `types.ts` | Message unions and diagnostics types. Re-exports the shared vocabulary from `content/dom/types.ts`. |

## Wire format

```ts
type FeatureOutcome = 'ok' | 'drifted' | 'unrecognized' | 'disabled' | 'notApplicable';

interface Diagnostic {
  code: DiagnosticCode;          // closed list in types.ts (DIAGNOSTIC_CODES)
  severity: 'info' | 'warn' | 'error';
  scope?: ScopeId; anchor?: AnchorId;
  selectorIndex?: number;        // fallback / ambiguous
  count?: number;                // ambiguous match count
  fingerprint?: string;          // <= 2 KB, see Fingerprint
  message?: string;              // scrubbed exception text, <= 200 chars
}

interface FeatureReport {
  navId: string;                 // per page session; follow-ups reuse it
  feature: FeatureId;
  outcome: FeatureOutcome;
  pageKind: PageKind;
  variant: VariantId | 'unknown';
  path: string;                  // owner/repo/(pull|issues)/N, or ''
  ghRelease?: string;            // <meta name="release"> (GitHub deploy SHA)
  diagnostics: Diagnostic[];     // <= 10
}
```

The message is `{ type: 'REPORT_DIAGNOSTIC', report }`. The background adds its own extension version (`version_name`), so content code can neither forget nor spoof it.

### Content-side client

The engine calls `createDiagnosticsClient({send, setTimer, clearTimer})`. That returns `{beginSession, add, setOutcome, endSession}`.

- **featureHost** calls `setOutcome` once the recognition gate decides. The first report for a feature waits a 500 ms coalescing window, so diagnostics from the settle period ride along.
- **Follow-ups go out immediately**, using the same `navId`. That covers an outcome change (e.g. `ok` → `disabled` after a breaker trip) and any diagnostic added after the first report.
- **Deduplication:** diagnostics are deduplicated per session by `code|scope|anchor`.
- **Message scrubbing:** exception messages have URLs and `owner/repo#N` tokens replaced.
- **Lifecycle:** nothing is sent after `endSession`, and the client never throws.

## Fingerprint

`fingerprint(root, {depth = 3, maxNodes = 40, knownIds})` returns at most 2 KB, one element per line, indented by depth:

```
div[data-testid=issue-viewer-metadata-pane].prc-PageLayout-Pane-*
  div[data-testid=sidebar-assignees-section][role=region][aria-label?]
```

**Where to fingerprint:**
- missing anchor: the nearest resolved ancestor (the `within` anchor, else the scope root)
- ambiguous anchor: the first two matches (`fingerprintAll`)
- fallback: the matched element's parent

**Sanitization:**
- **Never text.**
- `.markdown-body`, `[data-testid="markdown-body"]` and `.comment-body` subtrees are marked `[content]` and not descended into.
- Attribute values are kept only for `data-testid`, `role` and `type`. Others (`aria-label`, `href`, `data-gid`, ...) appear by name only.
- **ids are shown only if the contract references them.** That means `knownIds`, typically `idsFromSelectors()` over the active variant's locators, or a numbered id whose prefix is listed (e.g. `issuecomment-` → `issuecomment-#`). The fixtures showed why this restriction is needed: GitHub ids embed user data (`awaiting-review-<login>`, `user-content-<heading>`).
- Digit runs become `#`. GraphQL ids keep only their typename prefix (`timeline-row-border-IC_*`). Generated CSS-module suffixes collapse to `*` (`prc-Button-ButtonBase-*`, `PageHeader_Title__*`).
- OctoDeck-owned subtrees are skipped.
- **Background check:** the background re-validates the charset and length. If the check fails, it drops the fingerprint, not the report.

A test runs the fingerprint over every element of both captured fixtures. It asserts there are no repo names, no viewer login and no numbers in ids or attribute values.

## Router

Senders are classified as follows:
- `extensionPage`: the URL starts with the extension origin. The options page opens in a tab, so `sender.tab` is not used for this.
- `githubContent`: `sender.id` is this extension, the frame URL origin is `https://github.com`, and there's a tab.
- Anything else is rejected.

| Message | GitHub content | Extension page |
|---|---|---|
| GET_ITEM, VIEW_ITEM, ACK_ITEM, STAR_ITEM, SET_NOTES, REFETCH_ITEM | ✅ | ✅ |
| GET_KNOWN_BOTS, GET_HIDE_EVENTS, SET_HIDE_EVENTS, OPEN_DASHBOARD | ✅ | ✅ |
| REPORT_DIAGNOSTIC | ✅ | ❌ |
| GET/SAVE_NOTIFICATION_SETTINGS, GET_DAEMON_STATUS, GET/CLEAR_DIAGNOSTICS | ❌ | ✅ |

- **Removed types:** `GET_CONFIG` had no senders and exposed the whole daemon config (db path, watched repos) to GitHub pages. `SYNC_ITEM` was an unused alias.
- **Parsers:** each type has a hand-written parser that bounds and type-checks every field. Handlers receive only parsed fields.
- **`REPORT_DIAGNOSTIC` validation:**
  - enum membership for feature, outcome, page kind, scope, anchor, code and severity
  - regexes for `variant`, `path`, `ghRelease` and `navId`
  - `path` must belong to the sending tab's URL; otherwise it's cleared
  - rate limit of 30 reports per minute per tab (an in-memory token bucket)
- **Responses:** every message gets exactly one response. Rejected or malformed messages get `{ok:false, error:'Message rejected'}`. Handler errors become `{ok:false, error}`.
- **Daemon calls:** all daemon fetches (`callDaemonRpc`, `checkDaemonStatus`, pairing) time out after 10 s. A hung daemon then surfaces as "OctoDeck daemon is not responding" instead of leaving callers waiting forever.

## Live health (`chrome.storage.session`)

- **Keying:** health is kept per `feature|variant`, so one arm of a GitHub A/B test can degrade on its own.
- **Concurrency:** all read-modify-write happens on one serialized queue in the worker.
- **Outcome rules:**

| Outcome | Effect |
|---|---|
| `ok`, `drifted` | Resets the failure streak. A degraded entry recovers. |
| `unrecognized`, `disabled` | Increments the streak and adds the page path (up to 5 distinct). |
| `notApplicable` | Ignored. |

- **Degraded rule:** at least **3 consecutive failures across at least 2 distinct pages** (decision 5). `DEGRADED_MIN_FAILURES` and `DEGRADED_MIN_PAGES` are exported constants.
- **Session dedupe:** a bounded `navId|feature → outcome` map makes each page session count at most once toward the streak. Resends and follow-ups (e.g. `ok` → `disabled`) can't double count.
- **Restart behavior:** session storage resets with the browser, so a stale amber badge never outlives a GitHub fix by more than one browser session.

## Drift records (`chrome.storage.local`)

- **One record per distinct drift**, keyed by a 64-bit FNV-1a hash of `code|feature|scope|anchor|variant|pageKind|resolution|fingerprint|message|extVersion`.
- **Fields:**
  - `resolution`: `fallback:i` / `missing` / `ambiguous:n` / `exception` / `disabled` / `anomaly` / `other`
  - `fingerprint`, `message`
  - `ghReleaseFirst`/`ghReleaseLast`
  - `firstSeen`/`lastSeen`, `count`
  - up to 5 `samplePaths`
- **Paths:** records keep sample page paths, and exports include them (decision 10), because the repo/URL is what makes a report reproducible. Page text is never recorded.
- **Retention:** 100 records and 30 days (§14.1). Fallback (`info`) records are capped at 40, so drift noise can't evict breakage.
- **Schema versioning:** the stored object carries `schema: 1`. Data from another schema is ignored.

## Toolbar (`background/action.ts`)

A single `ActionState` in session storage feeds one renderer: `{stream, badge, degraded, tabs}`.

| Priority | Condition | Text | Color | Tooltip |
|---|---|---|---|---|
| 1 | daemon stream offline / setup / version mismatch | `!` / `SETUP` / `UPD` | red / orange | as before |
| 2 | any feature degraded (decision 5) | daemon count (kept) | amber | daemon tooltip + "GitHub integration limited: …" |
| 3 | otherwise | daemon count | blue | daemon tooltip |

**Per-tab detail:**
- A tab whose current page session has `unrecognized` or `disabled` features gets a tab-specific tooltip: the global tooltip plus "On this page: … paused."
- The detail resets when that tab reports a new `navId`, when it starts loading (`tabs.onUpdated` status `loading`), and when it closes.
- None of this needs the `tabs` permission.

There are no desktop notifications for drift (decision 8).

## Options page: GitHub Compatibility panel (decision 7)

- **Status badge:** "OK", "Limited" or "No data yet".
- **Health table:** one row per feature × page layout (variant).
- **Drift records:** expandable entries with pages, message and fingerprint. Everything is rendered via `textContent`.
- **Copy report:** Markdown with an environment table (extension version, browser, GitHub releases), health, records, page links and fingerprints, ready to paste into an issue.
- **Download JSON:** `octodeck-diagnostics-YYYYMMDD.json`, made via `Blob` (no `downloads` permission).
- **Clear:** clears records, health and the amber state.
- **Safe mode switch:** stored as `chrome.storage.local.safe_mode`. The engine's prefs source watches it, turns all mutators off and sets `html[data-octodeck-safe]`.
- **Live updates:** the panel refreshes when records or health change.

## Daemon log (deferred, decision 9)

Not built in this phase. The string-typed vocabulary and the transition-oriented health state keep it open. A later `ReportClientDiagnostics` RPC would forward only healthy↔degraded transitions (queued in session storage and flushed when the notification stream connects). The daemon would log them through `slog` and keep an in-memory status for a dashboard banner.

## Testing

| Test file | Covers |
|---|---|
| `diagnosticsClient.test.ts` | batching, dedupe, follow-ups, overflow splitting, session end, scrubbing |
| `fingerprint.test.ts` | sanitization rules, limits, and a privacy sweep over both fixtures |
| `router.test.ts` | sender classification, context matrix, malformed payloads, rate limit, error handling |
| `diagnostics.test.ts` | validation, the degraded rule, per-variant independence, session dedupe, serialized concurrency, records, retention, exports |
| `action.test.ts` | precedence, amber keeps the count, per-tab titles, serialized updates |
| `optionsDiagnostics.test.ts` | panel rendering (including markup-injection safety), copy, download, clear, Safe mode |
| `background.test.ts` | end-to-end: reports from three tabs turn the badge amber, and clearing resets it |
