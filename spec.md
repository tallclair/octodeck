# OctoDeck Specification

**Current Status:** Functional pre-alpha. Core Go daemon, local SQLite caching, embedded React Web App dashboard, and Chrome Companion Extension are operational with in-repo pre-built distributions for zero-NPM Go developer workflows.

---

## 1. High-Level Architecture

* **The Backend (Daemon):** A local Go server (`octodeck serve`) that handles business logic, GitHub API interactions, and local persistence. It listens on `127.0.0.1:38274` and embeds the production React Web App UI static files directly via `//go:embed frontend_dist`.
* **The Web App Dashboard:** Hosted exclusively by the Go backend daemon at `http://127.0.0.1:38274/`. Renders the maintainer triage interface using ConnectRPC over relative `/api/v1` routes with SameSite Anti-CSRF cookies (`octodeck_csrf`).
* **The Companion Extension:** A lightweight Manifest V3 Chrome Extension (`extension_dist/`). Handles browser-native capabilities (`github.com` view tracking, GitHub action tracking & auto-sync, configurable desktop notification filters, action toolbar launcher, GitHub right sidebar integration with Ack/Star/Notes controls, and grouped timeline noise collapsing).

---

## 2. Component Architecture

### 2.1 The Backend Daemon (`octodeck`)

- **API Gateway:** Serves ConnectRPC endpoints over HTTP/1.1 at `http://127.0.0.1:38274/api/v1`.
- **Static File Server:** Native embed (`//go:embed frontend_dist`) serving the Web App UI at `/`.
- **Data Store:** Local SQLite database (`~/.octodeck/octodeck.db`) using **Hybrid Storage** (Smart Index + Protobuf Blob).
- **Logging:** Structured JSON logging (`slog`) to Stdout.
- **Auth Manager:** Uses `go-gh` for GitHub authentication and handles companion token authorization.
- **Status Calculator:** Computes item status on the fly on read in strict priority order (1. Never before seen: "New", 2. New non-noise comments or PR reviews: "New Activity", 3. New commits: "New Commit", 4. New noise comments: "Noise", 5. Idle: no display, plus "Acked") based on last_viewed_at, acked_at, user identity, and configured known bots.
- **Noise Filter:** Classifies comments on read into `CommentNoiseType` (bot authors, slash commands) without storing transient noise state in the database.
- **Auto-Ack Engine:** Automatically archives items where the last action was by the current user.
- **Sync Engine:** Orchestrates notification-first data synchronization. Uses GitHub REST notifications (`GET /notifications?all=true`) with `If-Modified-Since` headers for HTTP 304 fast-exit conditional caching. Performs repository exclusion filtering prior to hydration, resolves unknown items to GraphQL Node IDs using lightweight aliased queries (`ResolveNodeIDs`), hydrates items in uniform batches of up to 50 items (`FetchItems`), ingests timeline `ASSIGNED_EVENT` nodes mapped to `STATE_CHANGE_TYPE_ASSIGNED` to un-ack on assignment, tracks `SubscriptionState` (Subscribed/Unsubscribed/Ignored), backfills comment gaps when history is disconnected, and captures per-item `sync_error` in `ItemLocalState` without aborting sync. Cold start inventory sync seeds the working set by combining recent notifications with open authored/assigned search queries.
- **Trace Store & Observability:** Records structured sync traces (`sync_traces` table) capturing query parameters, duration, item counts, errors, HTTP status, reasons breakdown, and gzipped raw payloads (`sync_traces.raw_payload_compressed`) with automatic 24-hour retention pruning during garbage collection. Accessible via `octodeck debug traces`, `octodeck debug trace [id]`, and the Web App Debug Data Browser UI.
- **Config Manager:** Loads configuration from `~/.octodeck/config.json`. Single source of truth for known bots, repository/label filter patterns, sync intervals, and auto-ack preferences.

### 2.2 The Frontend (Web App & Companion Extension)

- **Web App Dashboard (`frontend/src/`)**: Full-screen maintainer triage dashboard (Inbox, Details, Settings) compiled directly to `backend/frontend_dist/`. Uses relative `/api/v1` routes, URL search parameters for filter state synchronization, `localStorage` for UI layout preferences, and a React `ThemeProvider` supporting GitHub-inspired Light, Dark, and System appearance modes.
  - **Keyboard Navigation & Action Shortcuts (`frontend/src/hooks/useKeyboardNavigation.ts`, `frontend/src/components/KeyboardShortcutsModal.tsx`)**: Single-key maintainer triage (`j`/`k` or arrows to move list focus, `Enter` to open Details Pane for focused item, `x`/`e` to Ack with smooth exit transition and auto-advance focus/details, `s` to Star/Unstar, `o` to Open on GitHub in new tab, `Esc` to close details/clear focus, and `?` to toggle keyboard shortcuts modal cheat sheet with sidebar shortcut trigger), guarded against active text inputs and modifier keys.
  - **Card Quick Actions & Smooth Transitions (`frontend/src/components/PullRequestCard.tsx`, `frontend/src/index.css`)**: Subtle hover-disclosed Check action button positioned outside the top-right of cards with fluid 280ms height collapse exit transitions upon dismissal.
  - **Live Synchronization & Real-Time Updates (`frontend/src/components/Dashboard.tsx`, `frontend/src/components/SyncStatusDisplay.tsx`)**: Periodic polling of daemon sync progress (~2000ms `getSyncStatus`) and item mutations (~3000ms `getItems`), immediate refetch triggers on sync transition (`isSyncing: false`) or timestamp changes, and live navigation bar indicator & hovercard metrics reflecting background sync in real time.
  - **Viewport Scroll Anchoring & In-View Animations (`frontend/src/hooks/useScrollAnchoring.ts`)**: Layout-aware viewport anchoring preserving the exact visual scroll position without jumping when items insert above the current scroll offset, coupled with smooth CSS grid/transform entry animations for newly inserted in-view items.
  - **Theme System (`frontend/src/context/ThemeContext.tsx`)**: Theme context providing `'system' | 'light' | 'dark'` options, dynamic OS color scheme change listener (`prefers-color-scheme`), `.dark`/`.light` HTML class sync, and `octodeck_theme` local storage persistence.
  - **Generalized Filter Engine (`frontend/src/logic/filterEngine.ts`, `frontend/src/hooks/useDashboardFilters.ts`)**: Multidimensional filtering (Triage: Inbox/Activity/Acked/All, State: Open/Closed/All, Type: All/PR/Issue, Org & Repo, Author, Milestone, Assigned: Me/All, Search Query, List Sorting: Latest Activity / Last Acked / Creation Date in Ascending or Descending order with Starred Items floating to top, and Details Pane Item selection) with bidirectional URL query parameter synchronization (`milestone`, `sort`, `order`, `item`) and sidebar shortcuts.
- **Companion Extension (`frontend/src/extension/`, compiled to `extension_dist/`)**: Manifest V3 Chrome companion extension.
  - **`background.ts`**: Desktop alerts (`chrome.notifications`), periodic notification filter engine (`octodeck_poll_notifications`), action click launcher (focuses/opens dashboard tab), ConnectRPC message bridge for content scripts (`REFETCH_ITEM`/`SYNC_ITEM` RPC integration), daemon liveness checking, and known bots caching/synchronization (`chrome.storage.local`).
  - **`content.ts` & `content/`**: Performs direct GitHub view tracking on `github.com/*`, monitors user PR/issue actions (`actionTracker.ts`) for comments, PR reviews, merge, closing/reopening, and assignees/labels edits with a debounced ~1000ms background sync trigger and ~3500ms fallback reconciliation sync (including Web Component Shadow DOM (`ShadowRoot`) piercing across open/closed shadow roots via `composedPath()` and `getRootNode()`), injects a native OctoDeck section at the top of GitHub's right sidebar (`sidebarSection.ts`) for Ack/Star/Notes controls, renders dynamic timeline markers for Last Viewed and Acknowledged activity (`timelineMarkers.ts`), collapses noise comments into an extra-dense inline layout (`noiseCollapser.ts`), and auto-discovers unknown bots on GitHub pages.
  - **`options.html` & `options.ts`**: Options page for daemon connection status, pairing, and notification filter configuration (Include/Exclude mode, repos/labels/authors wildcard patterns, assigned/authored toggles, bot ignore toggles).

---

## 3. Backend API Specification

The backend exposes a ConnectRPC API. See `api/octodeck/v1/service.proto` for the full schema and contracts.

### 3.1 Services

* **OctoDeckService**
  * `GetItems`: Main dashboard data with filtering.
  * `GetItem`: Single item retrieval by ID (`owner/repo#number`) with computed status and local metadata.
  * `Sync`: Streaming status updates.
  * `ViewItem`: Record item view timestamp and recalculate item status.
  * `AckItem`: Mutate acknowledged state.
  * `StarItem`: Mutate starred state.
  * `SetNotes`: Update maintainer private notes for an item.
  * `RefetchItem`: Force single item re-fetch.
  * `DeleteItem`: Remove item from local store.
  * `GetSyncStatus`: Retrieve synchronization status metrics (last successful sync, last update received, failure details, sync duration, and 24h/7d/30d notification rates).
  * `GetDatabaseStats`: Retrieve database and storage metrics (total items, open/closed, PRs/issues, inbox/acked, repo count, trace count, database size on disk, and file path).
  * `GetConfig`: Retrieve current backend configuration and authenticated `current_user_login`.
  * `UpdateConfig`: Update backend configuration. Supports partial updates via `FieldMask`.

---

## 4. Code Layout

```
/
├── api/                    # Protocol Buffer Definitions (API Contract)
│   └── octodeck/v1/        # Proto service and resource schemas
├── backend/                # Go Daemon
│   ├── cmd/                # CLI Commands (`octodeck serve`, `debug`, `install`)
│   ├── frontend_dist/      # Pre-built Web App static bundle embedded into binary
│   ├── internal/           # Core packages (auth, config, database, github, logic, server)
│   ├── embed.go            # Web App static asset embed (`frontend_dist`)
│   └── main.go             # Backend daemon entrypoint
├── extension_dist/         # Pre-built Chrome Companion Extension
├── docs/                   # User guide, developer guides, and architecture specs
└── frontend/               # React Web App & Companion Extension Source
    └── src/
        ├── api/            # Generated TypeScript ConnectRPC Client
        ├── components/     # React Dashboard UI Components
        └── extension/      # Companion Chrome Extension Source
            ├── background.ts  # Service worker, notification engine, message bridge
            ├── options.html   # Dedicated extension settings page
            ├── options.ts     # Options page controller
            ├── content.ts     # Content script coordinator
            ├── content/       # Injected GitHub widgets (viewTracker, noiseCollapser, sidebarSection, styles)
            └── manifest.json  # Manifest V3 configuration
```
