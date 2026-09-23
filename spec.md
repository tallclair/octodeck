# OctoDeck Specification

**Current Status:** Functional pre-alpha. Core Go daemon, local SQLite caching, embedded React Web App dashboard, Chrome Companion Extension, and release automation pipeline are operational.

---

## 1. High-Level Architecture

* **The Backend (Daemon):** A local Go server (`octodeck serve`) that handles business logic, GitHub API interactions, and local persistence. It listens on `127.0.0.1:38274` and embeds the React Web App UI static files directly via `//go:embed frontend_dist`. Its runtime version is dynamically extracted from git tags and injected at build time via `-ldflags` into `server.Version`, surfaced through the CLI (`octodeck --version`) and the HTTP `/api/v1/status` endpoint.
* **The Web App Dashboard:** Hosted exclusively by the Go backend daemon at `http://127.0.0.1:38274/`. Renders the maintainer triage interface using ConnectRPC over relative `/api/v1` routes with SameSite Anti-CSRF cookies (`octodeck_csrf`), surfacing the daemon runtime version in the settings modal.
* **The Companion Extension:** A lightweight Manifest V3 Chrome Extension. Manifest V3 metadata is injected at build time with numeric and descriptive SemVer versions. Handles browser-native capabilities (`github.com` view tracking, GitHub action tracking & auto-sync, configurable desktop notification filters, action toolbar launcher, GitHub right sidebar integration with Ack/Star/Notes controls, and grouped timeline noise collapsing). Displays daemon pairing, version status, and version mismatch warnings directly in its options page.
* **Release Automation & Quality Gates:** A repository-level release and verification pipeline that enforces Conventional Commits and backtick restrictions via Git hooks (`.githooks/`), generates categorized Markdown release notes from commit history (`scripts/release-notes.sh`), and manages strictly incremental SemVer releases (`release.sh`) protected by full verification preflights (`./verify.sh --force`).

---

## 2. Component Architecture

### 2.1 The Backend Daemon (`octodeck`)

- **API Gateway:** Serves ConnectRPC endpoints over HTTP/1.1 at `http://127.0.0.1:38274/api/v1`, wrapped with a global logging interceptor.
- **Static File Server:** Native embed (`//go:embed frontend_dist`) serving the compiled Web App UI (or fallback placeholder when uncompiled) at `/`.
- **Version Management & Health Endpoint:** Reads dynamic build-time git versions injected via `-ldflags` into `server.Version` (falling back to `"dev"`), exposed via the CLI root version flag (`octodeck --version`) and the `/api/v1/status` HTTP health endpoint alongside GitHub authentication status.
- **Data Store:** Local SQLite database (`~/.octodeck/octodeck.db`) using **Hybrid Storage** (Smart Index + Protobuf Blob).
- **Logging & Error Interception:** Structured JSON logging (`slog`) to Stdout. A ConnectRPC logging interceptor wraps unary and streaming handlers, automatically logging procedure errors via `slog.ErrorContext` with structured attributes (`procedure`, `code`, `error`, and HTTP `request_id`).
- **Auth Manager:** Uses `go-gh` for GitHub authentication and handles companion token authorization.
- **Status Calculator:** Computes item status on the fly on read in strict priority order (1. Never before seen: "New", 2. New non-noise comments or PR reviews: "New Activity", 3. New commits: "New Commit", 4. New noise comments: "Noise", 5. Idle: no display, plus "Acked") based on last_viewed_at, acked_at, user identity, and configured known bots.
- **Noise Filter:** Classifies comments on read into `CommentNoiseType` (bot authors, slash commands) without storing transient noise state in the database.
- **Auto-Ack Engine:** Automatically archives items where the last action was by the current user.
- **Sync Engine:** Orchestrates notification-first data synchronization. Uses GitHub REST notifications (`GET /notifications?all=true`) with `If-Modified-Since` headers for HTTP 304 fast-exit conditional caching. Performs repository exclusion filtering prior to hydration, resolves unknown items to GraphQL Node IDs using lightweight aliased queries (`ResolveNodeIDs`), hydrates items in uniform batches of up to 50 items (`FetchItems`), ingests timeline `ASSIGNED_EVENT` nodes mapped to `STATE_CHANGE_TYPE_ASSIGNED` to un-ack on assignment, tracks `SubscriptionState` (Subscribed/Unsubscribed/Ignored), backfills comment gaps when history is disconnected, and captures per-item `sync_error` in `ItemLocalState` without aborting sync. Cold start inventory sync seeds the working set by combining recent notifications with open authored/assigned search queries.
- **Trace Store & Observability:** Records structured sync traces (`sync_traces` table) capturing query parameters, duration, item counts, errors, HTTP status, reasons breakdown, and gzipped raw payloads (`sync_traces.raw_payload_compressed`) with automatic 24-hour retention pruning during garbage collection. Accessible via `octodeck debug traces`, `octodeck debug trace [id]`, and the Web App Debug Data Browser UI.
- **Discovery Engine & Auxiliary Search Queries:** Periodically discovers candidate items matching configured GitHub search queries (`tracked_queries`) without continuous polling overhead. Automatically injects an `updated:>` filter into searches referencing the last run timestamp minus a safety buffer (2 minutes) to account for GitHub indexing latency. Newly added queries are seeded with the query creation timestamp in SQLite metadata to avoid expensive historical backfills. Configuration validation rejects queries with explicit `updated` qualifiers and enforces at least one positive scope qualifier (`repo:owner/name`, `org:name`, or `user:name`). On save (`UpdateConfig`), newly added queries undergo a per-query 48-hour pre-flight check (`CountSearchIssues` with `created:>`) that returns warnings if a query exceeds an average of 50 newly created items per day unless confirmed (`force_save`). Executes lightweight, ID-only GraphQL search queries (`SearchCandidateIDs`) to find matching Issue and PullRequest node IDs. Discards previously known items via an in-memory $O(1)$ deduplication check against the SQLite item index (`GetAllItemIDs`) before issuing any hydration calls. Newly discovered candidate items are batch-hydrated (`FetchItemsByIDs`) with their full details and `viewerSubscription` state.
- **Untracked Item Lifecycle & GC Refresh:** Discovered unsubscribed items are persisted in SQLite with their initial snapshot state and remain dormant without continuous notification polling. Stale unsubscribed open items are refreshed after 30 days during existing garbage collection passes. The discovery engine is dynamically scheduled via a dedicated discovery ticker (`discovery_interval_min`, default 10 minutes) that resets upon configuration reloads.
- **Subscription Mutation API:** The `UpdateSubscription` ConnectRPC handler executes the GitHub GraphQL `updateSubscription` mutation to alter subscription state on GitHub (`SUBSCRIBED`, `UNSUBSCRIBED`, `IGNORED`) and updates the local SQLite item state, recalculating computed status and returning the updated item. It detects missing GitHub OAuth scopes (specifically the `notifications` scope) or organization SAML enforcement and maps them to an actionable `connect.CodePermissionDenied` error directing the user to run `gh auth refresh -s notifications`.
- **Config Manager:** Loads configuration from `~/.octodeck/config.json`. Single source of truth for known bots, repository/label filter patterns, tracked auxiliary search queries (`tracked_queries`), discovery interval (`discovery_interval_min`), sync intervals, and auto-ack preferences.

### 2.2 The Frontend (Web App & Companion Extension)

- **Web App Dashboard (`frontend/src/`)**: Full-screen maintainer triage dashboard (Inbox, Details, Settings). Uses relative `/api/v1` routes, URL search parameters for filter state synchronization, `localStorage` for UI layout preferences, and a React `ThemeProvider` supporting GitHub-inspired Light, Dark, and System appearance modes.
  - **Daemon Version Surfacing (`frontend/src/Settings.tsx`)**: Surfaces the backend daemon version (retrieved via `/api/v1/status` with build-time fallback) directly in the Settings modal footer.
  - **Settings Modal Controls (`frontend/src/Settings.tsx`)**: Provides configuration controls for multi-line `tracked_queries` (one GitHub search query per line) and `discovery_interval_min` (numeric input under Advanced settings, default 10 minutes, minimum 1 minute) with validation (enforcing `repo:`, `org:`, or `user:` scope qualifiers and rejecting manual `updated:` filters), a pre-flight confirmation prompt (`Save Anyway` / `Edit Query`) when a query exceeds 50 newly created items/day over 48h, dirty-checking, and discard confirmation.
  - **Keyboard Navigation & Action Shortcuts (`frontend/src/hooks/useKeyboardNavigation.ts`, `frontend/src/components/KeyboardShortcutsModal.tsx`)**: Single-key maintainer triage (`j`/`k` or arrows to move list focus, `Enter` to open Details Pane for focused item, `x`/`e` to Ack with smooth exit transition and auto-advance focus/details, `s` to Star/Unstar, `o` to Open on GitHub in new tab, `Esc` to close details/clear focus, and `?` to toggle keyboard shortcuts modal cheat sheet with sidebar shortcut trigger), guarded against active text inputs and modifier keys.
  - **Card Quick Actions & Smooth Transitions (`frontend/src/components/PullRequestCard.tsx`, `frontend/src/index.css`)**: Subtle hover-disclosed Check action button positioned outside the top-right of cards with fluid 280ms height collapse exit transitions upon dismissal.
  - **Floating Toast Notification System (`frontend/src/context/ToastContext.tsx`, `frontend/src/components/Toast.tsx`)**: Global toast notification system (`ToastProvider`, `useToast`) rendering floating alerts in the bottom-right viewport for user actions and failed mutations (subscribing, acking, starring, settings). Features manual dismiss controls, hover-pausing auto-dismiss timers (8000ms for errors, 5000ms for standard notices), accessible roles (`role="alert"` / `aria-live`), and interactive copyable remediation command buttons (e.g. for `gh auth refresh -s notifications`) with temporary copy confirmation.
  - **Untracked Indicators & One-Click Subscribe (`frontend/src/components/PullRequestCard.tsx`, `frontend/src/components/DetailsPane.tsx`)**: Displays interactive subscription indicators for items where `viewer_subscription` is `UNSUBSCRIBED`. On `PullRequestCard`, renders a compact `BellOff` icon button in the action row between the computed activity status indicator and the hover-disclosed Ack button (with the compact tooltip `"Untracked"`), transitioning to an inline spinning `RefreshCw` icon during in-flight subscription mutations. On `DetailsPane`, renders a full "Untracked" text badge with the explanatory tooltip `"Not subscribed on GitHub. Live updates won't be received automatically unless you subscribe or are mentioned."`. Both indicators trigger the `UpdateSubscription` mutation on click to subscribe the user on GitHub and locally promote the item, and automatically disable with an explanatory remediation tooltip (`gh auth refresh -s notifications`) when the GitHub `notifications` OAuth scope is missing (`has_notifications_scope: false`).
  - **Live Synchronization & Real-Time Updates (`frontend/src/components/Dashboard.tsx`, `frontend/src/components/SyncStatusDisplay.tsx`)**: Periodic polling of daemon sync progress (~2000ms `getSyncStatus`) and item mutations (~3000ms `getItems`), immediate refetch triggers on sync transition (`isSyncing: false`) or timestamp changes, and live navigation bar indicator & hovercard metrics reflecting background sync in real time.
  - **Viewport Scroll Anchoring & In-View Animations (`frontend/src/hooks/useScrollAnchoring.ts`)**: Layout-aware viewport anchoring preserving the exact visual scroll position without jumping when items insert above the current scroll offset, coupled with smooth CSS grid/transform entry animations for newly inserted in-view items.
  - **Theme System (`frontend/src/context/ThemeContext.tsx`)**: Theme context providing `'system' | 'light' | 'dark'` options, dynamic OS color scheme change listener (`prefers-color-scheme`), `.dark`/`.light` HTML class sync, and `octodeck_theme` local storage persistence.
  - **Generalized Filter Engine (`frontend/src/logic/filterEngine.ts`, `frontend/src/hooks/useDashboardFilters.ts`)**: Multidimensional filtering (Triage: Inbox/Activity/Acked/All, State: Open/Closed/All alongside Tracked/Untracked tracking filters, Type: All/PR/Issue, Org & Repo, Author, Milestone, Assigned: Me/All, Search Query, List Sorting: Latest Activity / Last Acked / Creation Date in Ascending or Descending order with Starred Items floating to top, and Details Pane Item selection) with bidirectional URL search parameter synchronization (`milestone`, `sort`, `order`, `item`, `tracking`), active filter chips with one-click removal, and sidebar shortcuts. The tracking filter evaluates item `viewer_subscription` state (`Tracked` matching items where `viewer_subscription !== UNSUBSCRIBED`, and `Untracked` matching `viewer_subscription === UNSUBSCRIBED`).
- **Companion Extension (`frontend/src/extension/`)**: Manifest V3 Chrome companion extension.
  - **Build-Time Version Injection (`frontend/vite.config.ts`, `frontend/src/extension/manifest.json`)**: Build tooling populates Manifest V3 with a strictly numeric `version` (e.g. `0.2.0`) and full descriptive `version_name` (e.g. `v0.2.0-2-g2c64b7a-dirty`), providing the `__APP_VERSION__` global definition across extension runtime code.
  - **`background.ts`**: Desktop alerts (`chrome.notifications`), periodic notification filter engine (`octodeck_poll_notifications`), action click launcher (focuses/opens dashboard tab), ConnectRPC message bridge for content scripts (`REFETCH_ITEM`/`SYNC_ITEM` RPC integration), daemon liveness checking, and known bots caching/synchronization (`chrome.storage.local`).
  - **`content.ts` & `content/`**: Performs direct GitHub view tracking on `github.com/*`, monitors user PR/issue actions (`actionTracker.ts`) for comments, PR reviews, merge, closing/reopening, and assignees/labels edits with a debounced ~1000ms background sync trigger and ~3500ms fallback reconciliation sync (including Web Component Shadow DOM (`ShadowRoot`) piercing across open/closed shadow roots via `composedPath()` and `getRootNode()`), injects a native OctoDeck section at the top of GitHub's right sidebar (`sidebarSection.ts`) for Ack/Star/Notes controls, renders dynamic timeline markers for Last Viewed and Acknowledged activity (`timelineMarkers.ts`), collapses noise comments into an extra-dense inline layout (`noiseCollapser.ts`), and auto-discovers unknown bots on GitHub pages.
  - **`options.html` & `options.ts`**: Options page for daemon connection status, pairing, notification filter configuration (Include/Exclude mode, repos/labels/authors wildcard patterns, assigned/authored toggles, bot ignore toggles), displaying extension version and daemon version side-by-side, and rendering an alert banner when versions mismatch.

### 2.3 Release Automation & Contribution Standards

- **Git Hooks (`.githooks/commit-msg`, `.githooks/pre-commit`)**: Version-controlled repository hooks configured via `git config core.hooksPath .githooks`. The `commit-msg` hook enforces Conventional Commits (`type(scope)!: description`) across allowed types (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`) and strictly prohibits backtick characters across all non-comment lines to prevent shell injection hazards and release notes Markdown formatting corruption. The `pre-commit` hook invokes `./verify.sh` on changed files prior to commit creation.
- **Contribution Standards (`CONTRIBUTING.md`)**: Comprehensive developer standards documenting development prerequisites, repository setup, git hook configuration, verification procedures, conventional commit formatting, backtick restrictions, release note categorization, and contribution workflow.
- **Automated Release Notes Generator (`scripts/release-notes.sh`)**: Analyzes git commit history between revisions (`git log $PREV_TAG..HEAD`), automatically categorizing commit subjects into Markdown sections: `### Features` for `feat`, `### Fixes` for `fix`, and `### Other Changes` for all other commit types.
- **Release Automation (`release.sh`)**: Orchestrates the release lifecycle with end-to-end preflights:
  - **SemVer Validation**: Validates target version format (`vX.Y.Z` or `X.Y.Z`, normalized to `vX.Y.Z`).
  - **Strict Incrementalism**: Enforces that target versions increment strictly by patch (`+1`), minor (`+1.0`), or major (`+1.0.0`) from the latest git tag, rejecting arbitrary jumps. In tagless repositories, initial releases are restricted to `v0.0.1`, `v0.1.0`, or `v1.0.0`.
  - **Git Preflights**: Enforces execution on branch `main` and verifies a clean working directory with zero uncommitted or untracked changes.
  - **Release Notes Preview**: Generates and displays release notes preview via `scripts/release-notes.sh`.
  - **Verification Gate**: Executes `./verify.sh --force`, aborting release creation if any test, linter, or build check fails.
  - **Tagging & Publishing**: Creates an annotated git tag (`git tag -a <version> -m "Release <version>"`) and pushes the tag to the remote origin repository.
- **GitHub Actions Release Pipeline (`.github/workflows/release.yml`)**: Automated CI/CD release workflow triggered by pushing a version tag (`v*`). Builds the Web App UI, compiles the Go backend binary (`dist/octodeck-<version>-linux-amd64`), packages the companion extension (`dist/octodeck-extension-<version>.zip`) and standalone web app assets (`dist/octodeck-webapp-<version>.zip`), generates commit-based release notes via `scripts/release-notes.sh`, and publishes an authenticated draft release with assets attached via the GitHub CLI.

---

## 3. Backend API Specification

The backend exposes a ConnectRPC API alongside HTTP REST endpoints. See `api/octodeck/v1/service.proto` for the full schema and contracts.

### 3.1 Services

* **OctoDeckService (ConnectRPC over HTTP/1.1 at `/api/v1`)**
  * `GetItems`: Main dashboard data with filtering.
  * `GetItem`: Single item retrieval by ID (`owner/repo#number`) with computed status and local metadata.
  * `Sync`: Streaming status updates.
  * `ViewItem`: Record item view timestamp and recalculate item status.
  * `AckItem`: Mutate acknowledged state.
  * `StarItem`: Mutate starred state.
  * `SetNotes`: Update maintainer private notes for an item.
  * `RefetchItem`: Force single item re-fetch.
  * `DeleteItem`: Remove item from local store.
  * `UpdateSubscription`: Update item subscription state on GitHub and in local storage with actionable OAuth scope error remediation.
  * `GetSyncStatus`: Retrieve synchronization status metrics (last successful sync, last update received, failure details, sync duration, 24h/7d/30d notification rates, and `has_notifications_scope` OAuth capability).
  * `GetDatabaseStats`: Retrieve database and storage metrics (total items, open/closed, PRs/issues, inbox/acked, repo count, trace count, database size on disk, and file path).
  * `GetConfig`: Retrieve current backend configuration, authenticated `current_user_login`, and per-query discovery statistics (`query_stats` with trailing 7-day and 30-day daily averages).
  * `UpdateConfig`: Update backend configuration, running 48-hour `created:>` pre-flight volume checks on newly added tracked queries unless `force_save` is set. Supports partial updates via `FieldMask`.

* **Configuration Model (`Config`)**
  * Configurable daemon settings managed via `GetConfig` and `UpdateConfig`, including repository filters (`watched_repos`, `pinned_repos`, `excluded_repos`), label filters (`included_labels`, `excluded_labels`), auxiliary search queries (`tracked_queries`), discovery check interval (`discovery_interval_min`, default 10 min), notification polling interval (`polling_interval_min`), bot account definitions (`known_bots`), auto-acknowledgement preferences (`auto_ack_own_activity`), server port, and database path.

### 3.2 HTTP REST & Utility Endpoints

* `GET /api/v1/status`: Returns daemon health, GitHub authentication state, `has_notifications_scope` OAuth status, and runtime `version` string.
* `POST /api/v1/auth/companion-token`: Authorizes and creates companion extension authentication tokens.
* `GET /auth/authorize`, `POST /auth/approve`, `POST /auth/token`: OAuth authorization flow endpoints for companion extension pairing.
* `GET /*`: Serves embedded static Web App assets (or fallback placeholder) with SPA routing fallback.

---

## 4. Code Layout

```
/
├── .github/                # GitHub Actions automated workflows
│   └── workflows/          # CI/CD workflow configurations (release.yml)
├── .githooks/              # Version-controlled Git hooks
│   ├── commit-msg          # Conventional Commits and backtick restriction validator
│   └── pre-commit          # Automated pre-commit verification runner
├── api/                    # Protocol Buffer Definitions (API Contract)
│   └── octodeck/v1/        # Proto service and resource schemas
├── backend/                # Go Daemon
│   ├── cmd/                # CLI Commands (`octodeck serve`, `debug`, `install`, `--version`)
│   ├── internal/           # Core packages (auth, config, database, github, logic, server)
│   │   ├── logic/
│   │   │   └── discovery.go # Auxiliary search query discovery engine and deduplication pipeline
│   │   └── server/
│   │       └── interceptor.go # ConnectRPC logging and error interceptor
│   ├── embed.go            # Web App static asset embed
│   └── main.go             # Backend daemon entrypoint
├── docs/                   # User guide, developer guides, and architecture specs
├── frontend/               # React Web App & Companion Extension Source
│   └── src/
│       ├── api/            # Generated TypeScript ConnectRPC Client
│       ├── components/     # React Dashboard UI Components
│       ├── context/        # React Context Providers (ToastContext, ThemeContext)
│       └── extension/      # Companion Chrome Extension Source
│           ├── background.ts  # Service worker, notification engine, message bridge
│           ├── options.html   # Dedicated extension settings page
│           ├── options.ts     # Options page controller
│           ├── content.ts     # Content script coordinator (GitHub tracker and widgets)
│           ├── content/       # Injected GitHub widgets (viewTracker, noiseCollapser, sidebarSection, styles)
│           └── manifest.json  # Manifest V3 configuration template
├── scripts/                # Repository operational and release scripts
│   ├── build-backend.sh    # Backend build script with version LDFlags and fallback placeholder
│   └── release-notes.sh    # Automated conventional commit release notes generator
├── CONTRIBUTING.md         # Contribution standards, commit conventions, and development workflows
├── GEMINI.md               # Project-wide developer guidelines and architectural instructions
├── release.sh              # SemVer release automation script with preflights and verification gate
├── spec.md                 # Living architecture specification
└── verify.sh               # Root verification runner for all monorepo subsystems
```
