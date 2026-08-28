# OctoDeck Feature Requests

This document tracks proposed and planned feature requests for OctoDeck.

## Planned

### Usability tweaks

- Rename "New" to "New Activity"
- Add an option to ignore code pushes
- Add help text to the settings (question mark in a circle next to field label that gives explanation in a hover card)
- Visually make "New" a sub-item of Inbox
- Add other quick-selection sub-items to the inbox for authored by me and starred.

### Auxiliary Queries & Subscription Status (Initial Triage Tool)

Auxiliary queries allow maintainers to monitor queues (e.g. `repo:kubernetes/kubernetes is:open label:sig/node`) for **initial triage** of new items.

#### Operating Principles for Auxiliary Queries

1. **Discovery Only (Not Updates):** Auxiliary queries are **not** an update polling mechanism. They purely detect *new candidate items* matching the query.
2. **Ultra-Lightweight ID-Only Search:**
   ```graphql
   query SearchCandidateIDs($query: String!) {
     search(query: $query, type: ISSUE_ADVANCED, first: 100) {
       nodes {
         ... on Issue { id }
         ... on PullRequest { id }
       }
     }
   }
   ```
   Because this query fetches only IDs without deep joins, it executes in $<50$ms and never times out.
3. **Database Deduplication:** IDs already present in SQLite are discarded immediately in memory with zero API overhead.
4. **Hydrate New Items with `viewerSubscription`:** Only genuinely new items are hydrated with full details plus `viewerSubscription` (`SUBSCRIBED`, `UNSUBSCRIBED`, `IGNORED`).
5. **Lifecycle of Discovered Untracked Items:**
   * An unsubscribed item discovered via auxiliary search has its initial snapshot recorded in SQLite.
   * Future auxiliary runs will filter it out (ID already in DB).
   * It will remain in its initial state without live updates unless the maintainer subscribes, is assigned, or `@mentioned`.
   * Stale unsubscribed open items are refreshed after 30 days by the existing GC stale-item check.
6. **Dashboard Subscription Indicator:**
   * Items with `viewer_subscription = UNSUBSCRIBED` display an **"Untracked"** badge on the dashboard item card with a tooltip: *"Not subscribed on GitHub. Live updates won't be received automatically unless you subscribe or are mentioned."*
   * Maintainers can click the badge to subscribe on GitHub with one click via the `UpdateSubscription` ConnectRPC mutation.

#### Implementation Plan

- [ ] **Config Extension:** Add `tracked_queries: []string` to `config.yaml` (e.g. `repo:k8s/k8s is:open label:sig/node`).
- [ ] **ID-Only Discovery Query:** Implement `SearchCandidateIDs(ctx, query)` in `backend/internal/github/client.go` to return only item IDs.
- [ ] **Discovery Engine Loop:** Implement periodic (15-30m) discovery check in `SyncEngine` that filters out existing DB IDs and hydrates only genuinely new items.
- [ ] **Subscription API Mutation:** Implement `UpdateSubscription` ConnectRPC method to allow one-click subscribing directly from the dashboard UI.
- [ ] **Verification:** Test discovery of new issues/PRs, deduplication against SQLite, and subscription state toggling.


### Tags

Tags are like private labels. The user defines them, and can add them to any items. They're visible from the dashboard, details pane, and directly on github (via extension). There is a filter selector for tags.

#### Tag rules? (TBD)

Automatic tagging. Still under consideration.

### Saved Searches / bookmarked filters

Save filter criteria / dashboard views, they show up in the left nave for quick selection. This could replace pinned repos.

### Multi-select filters

The following should be multi-selectable (union of selected items):

- Author
- Repository
- Label

## Backlog

### AI Reviews

See [autoreview_design.md](autoreview_design.md)

### Generalized noise filtering

Add a configuration field that holds a list of regexes that are applied to comments to tag them as noise. Make the slash command filtering just the default for the generalized noise filter.

### Filter Out Slash Commands and Boilerplate from Descriptions
- **Status:** Proposed
- **Description:** Automatically filter out bot slash commands, command instructions (e.g., `/hold`, `/lgtm`, `/assign`, `/kind bug`, `/retest`), empty release-notes codeblocks, and orphaned section headers from issue and PR opening descriptions, with a UI toggle to show the full original text.
- **Rationale:** PR templates and issue descriptions (especially in large projects like Kubernetes) frequently include boilerplate slash commands, release note placeholders, and instruction headers that clutter the maintainer's reading experience. Filtering them out by default keeps descriptions focused on the actual changes while preserving the ability to inspect the raw template.
- **Key Requirements:**
  - **Slash Command Stripping:** Remove lines consisting of bot slash commands (such as `/kind bug`, `/priority important-soon`, `/assign @user`, `/lgtm`).
  - **Empty / NONE Release Notes Filter:** Hide ```` ```release-notes ```` code blocks when the only content inside is `"NONE"` (or empty/whitespace).
  - **Orphaned Header Cleanup:** If removing slash commands or boilerplate leaves a markdown header section with no remaining content (e.g., `# What type of PR is this?` followed only by `/kind bug`), strip the header as well.
    - *Example Transformation:*
      ```markdown
      # What type of PR is this?
      /kind bug

      # What this PR does / why we need it:
      Fixes a regression in the scheduler.
      ```
      becomes:
      ```markdown
      # What this PR does / why we need it:
      Fixes a regression in the scheduler.
      ```
  - **Raw View Toggle:** Provide a UI toggle (such as "Show full description" / "Hide boilerplate") in `DetailsPane` whenever content has been filtered.
- **Implementation Outline:**
  - [ ] **Sanitization Logic (`markdownFilter.ts` / `noiseFilter.ts`):**
    - Strip slash command lines.
    - Parse/strip ```` ```release-notes\nNONE\n``` ```` blocks.
    - Post-process markdown AST or lines to remove markdown header lines that have no succeeding content before the next header or end of text.
  - [ ] **UI Toggle Component:** In `DetailsPane.tsx` (or `Markdown.tsx`), render a toggle button to switch between filtered and raw description text.
  - [ ] **Unit Tests:** Add test cases covering Kubernetes PR templates, release-notes blocks with `NONE` vs actual notes, nested markdown headers, code blocks with slash comments (which should NOT be stripped), and toggle interaction.
