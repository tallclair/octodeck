# OctoDeck User Guide

A comprehensive guide to triaging GitHub notifications, managing workflows, and using the OctoDeck Companion Extension.

---

## 1. Core Mental Model & Triage Concepts

OctoDeck is built specifically for open-source maintainers handling high volumes of pull requests and issues. Unlike standard notification inboxes that treat notifications as simple read/unread alerts, OctoDeck operates on an **action-oriented maintainer state machine**.

### 1.1 The "Ack" (Acknowledge) Lifecycle

* **Inbox (Needs Your Attention):**
  Items in your inbox represent PRs or issues that require maintainer review, decision-making, or triage.

* **Ack (Waiting on Others):**
  When you review, comment, or determine no immediate action is needed from you, you **Ack** (acknowledge) the item. Acking archives the item from your Inbox into the **Acked** bucket.

* **Auto-Unack (New Activity Pops Back):**
  When another person comments, pushes a new commit, requests your re-review, or assigns you, OctoDeck automatically un-acknowledges the item, bringing it right back into your **Inbox** and **New Activity** views.

* **Auto-Ack on Your Own Activity:**
  When you leave a comment, submit a review, or close an item on GitHub, OctoDeck's companion extension or sync engine automatically acknowledges the item—because the ball is now in someone else's court.

* **100% Local & Private:**
  Your Ack state, star markers, and private maintainer notes live exclusively in your local SQLite database (`~/.octodeck/octodeck.db`). They are never pushed to GitHub or shared with others.

---

## 2. Dashboard Interface & Navigation

The OctoDeck dashboard (`http://127.0.0.1:38274/`) is designed for fast, high-volume triage.

### 2.1 Workflow Buckets (Sidebar)

* **Inbox:** All unacknowledged items requiring your review or attention.
* **New:** Items with unread human comments, reviews, or commits since you last viewed them.
* **Acked:** Items you have acknowledged and are waiting on contributors or CI.
* **All Items:** The complete catalog across all watched repositories.

*(Tip: Full keyboard navigation is supported throughout the app. Press `?` or click **Shortcuts** in the sidebar to open the cheat sheet.)*

### 2.2 Stars & Pinning Items

* **Pinning to the Top:** Starring an item (via the star icon or `s` shortcut) automatically floats and pins it to the top of your list, regardless of the active sort order or filter bucket.
* **Priority Tracking:** Use stars to flag critical PRs needing follow-up, high-priority releases, or issues you want to keep immediately visible during your triage session.
* **In-Situ Toggling:** You can star/unstar items from both the Web App and directly on `github.com` via the companion extension sidebar.

### 2.3 Private Maintainer Notes

* **Personal Context & Checklists:** Attach private, markdown-formatted notes to any pull request or issue (e.g., review checklists, edge-case reminders, debugging logs, or draft feedback).
* **In-Situ Access:** Notes are visible and editable both in the dashboard Details Pane and right inside GitHub via the companion extension's sidebar widget.
* **Strict Local Privacy:** Private notes are saved exclusively to your local machine (`~/.octodeck/octodeck.db`). They are never published, transmitted to GitHub, or visible to others.

---

## 3. Filtering & Search

OctoDeck pairs multidimensional filter menus with a highlighted query input in the list header. The query text (synchronized to the `?q=` URL parameter) and the toolbar controls stay in sync: picking options in a menu updates the corresponding clause of the query in place, and typing qualifiers in the query box updates the active state of the controls.

### 3.1 Toolbar & Filter Menus

* **Item State:** Quickly toggle between **All**, **Open**, or **Closed** items using the segmented switch on the left.
* **Item Type:** From the **Type** menu, filter by **Pull requests** or **Issues** (or click the active selection again to revert to All).
* **Activity & Subscriptions:** From the **Activity** menu, filter by **Subscribed** or **Unsubscribed** notifications, and one or more **New Activity** types (the **New Activity** header itself is equivalent to the **New** tab, or pick specific types: **New items**, **Mentions**, **Comments & reviews**, **New commits**, or **Noise (bots)**).
* **Author & Assigned:** Select one or more author logins (including `@your-login (you)` pinned at the top, which writes `author:@me`) or use the one-click **Assigned** toggle to add/remove `assignee:@me`.
* **Labels & Repository:** Filter by multiple GitHub labels (with live counts and label color swatches) or select one or more repositories (grouped by organization).
* **Activity & More Filters (`...`):** From the **Activity** menu, filter by **Subscribed** or **Unsubscribed** notifications and specific **New Activity** types. Opening the **`...` (More filters)** menu reveals multi-select **Assignee** and **Milestone** filters. When space is constrained, the toolbar collapses progressively from the right: **Activity** moves into the `...` menu first, followed by **Repository**.
* **Sorting:** Sort by **Latest Activity**, **Last Acked**, or **Creation Date** in ascending or descending order.

### 3.2 Query Input & Query Syntax

Press `/` anywhere outside a text input to focus the query bar. The query is plain text that you edit like any text field, and each clause is highlighted as a chip on the text itself: blue for filters, rose for excluded (`-`) filters, red with a wavy underline under the problem for errors, and dashed amber for unfinished clauses. Free-text search terms get a neutral chip. Long queries wrap onto more lines (up to four, then the box scrolls).

* **Autocomplete:** Typing a qualifier prefix (or pressing `ArrowDown` in an empty input) suggests qualifier keys and `is:` shorthands. After `:`, OctoDeck suggests closed-set values or live facet values (with match counts) for repositories, organizations, authors, assignees, milestones, and labels. Press `Tab` to accept a suggestion and keep editing the clause, or `Enter` to accept a value and move on to the next clause.
* **Editing:** Click anywhere in the query to place the caret, select text with the mouse or keyboard, and use the usual shortcuts: `Ctrl+A` / `Cmd+A` to select everything, copy/cut/paste (always as plain text; pasted line breaks become spaces), and `Ctrl+Z` / `Cmd+Z` to undo/redo. `Enter` never adds a line break; it moves the caret to the end of the query. `Esc` closes the suggestion list, and pressing it again leaves the query bar.
* **Removing clauses:** When the query bar is not focused, hover over a chip with the mouse to reveal a `×` on its right end; click it to remove that clause. The `×` button on the right of the query bar clears the whole query (including the **New**, **Acked** and **All** tab clauses) while keeping your current sort order.

#### Qualifiers

| Qualifier | Values | Description |
| :--- | :--- | :--- |
| `triage:<state>` | `inbox`, `acked`, `all` | Maintainer triage bucket (defaults to `triage:inbox` when omitted) |
| `state:<state>` | `open`, `closed`, `merged` | Item state |
| `type:<type>` | `pr`, `issue` | Item type (pull request or issue) |
| `draft:<bool>` | `true`, `false` | Pull request draft status |
| `tracking:<bool>` | `true`, `false` | GitHub notification subscription state (`true` for tracked, `false` for untracked) |
| `starred:<bool>` | `true`, `false` | Local maintainer star status |
| `new:<type>` | `item`, `mention`, `comment`, `code`, `noise`, `any` | Unviewed activity flags since last viewed or acknowledged |
| `repo:<owner/name>` | Open (facet-backed) | Repository `owner/name` (e.g. `repo:kubernetes/kubernetes`) |
| `org:<org>` | Open (facet-backed) | GitHub organization or user owner (e.g. `org:kubernetes`) |
| `author:<login>` | Open (`@me` or login) | Author login (`author:@me`, `author:octocat`, or `author:@octocat`) |
| `assignee:<login>` | Open (`@me` or login) | Assignee login (`assignee:@me`, `assignee:octocat`, or `assignee:@octocat`) |
| `milestone:<title>` | Open (facet-backed) | Milestone title (e.g. `milestone:v1.30`) |
| `label:<name>` | Open (facet-backed) | GitHub label name (`label:bug`, `label:"good first issue"`) |
| `no:<field>` | `assignee`, `label`, `milestone` | Items missing the specified metadata (`no:assignee`, `no:label`, `no:milestone`) |
| `in:<target>` | `title`, `body` | Restrict free-text search terms to title, body, or both (`in:title,body`; cannot be negated) |

Bare numbers or `#`-prefixed numbers such as `123` or `#123` match issue or pull request number `123` in addition to free-text search.

#### `is:` Shorthands

| Shorthand | Equivalent Clause |
| :--- | :--- |
| `is:open`, `is:closed`, `is:merged` | `state:open`, `state:closed`, `state:merged` |
| `is:pr`, `is:issue` | `type:pr`, `type:issue` |
| `is:draft`, `-is:draft` | `draft:true`, `-draft:true` |
| `is:tracked`, `is:untracked` | `tracking:true`, `tracking:false` |
| `is:starred`, `-is:starred` | `starred:true`, `-starred:true` |
| `is:new`, `-is:new` | `new:any`, `-new:any` |
| `is:inbox`, `is:acked` | `triage:inbox`, `triage:acked` |

#### Combining Clauses, Negation, and Quoting

* **AND (Spaces):** Separate clauses with spaces to require all of them: `is:pr is:open org:kubernetes`.
* **OR (Commas):** Separate values within a single qualifier using commas (no spaces) to match any of them: `label:kind/bug,kind/flake`, `state:closed,merged`, or same-field `is:` shorthands such as `is:open,merged`.
* **Negation (`-`):** Prefix any negatable qualifier or `is:` shorthand with `-` to exclude matches: `-label:lifecycle/rotten`, `-author:dependabot[bot]`, `-is:draft`, `-no:assignee`.
* **Quoting & Escapes:** Wrap values containing spaces or commas in double quotes: `label:"good first issue"`. Inside quotes, use `\"` for a literal quote and `\\` for a literal backslash. Wrap free-text phrases or URLs containing colons in quotes so they are searched as text rather than parsed as `key:value`: `"panic: nil pointer"` or `"https://example.com"`.

#### Examples

```text
is:pr is:open assignee:@me -is:draft
org:kubernetes label:kind/bug,kind/regression new:mention,comment
triage:all author:@me no:milestone "release notes" in:title #123
```

---

## 4. Companion Chrome Extension

The OctoDeck Companion Extension enhances your experience directly on `github.com`:

### 4.1 In-Situ GitHub Sidebar Section
On any GitHub Pull Request or Issue page, OctoDeck injects a widget at the top of the right sidebar:
* **Ack / Unack Button:** Change triage state without switching to the dashboard.
* **Star Toggle:** Bookmark critical issues.
* **Private Notes:** Add private markdown notes visible only to you.
* **Hide Events Toggle:** Instantly hide noise timeline events (e.g., label changes, reference spam).

### 4.2 Comment Box Integration
An **Ack** action button is injected directly into GitHub's comment and review submission forms so you can comment and acknowledge in a single click.

### 4.3 Bot Noise Collapsing
Known CI bots (e.g. `k8s-ci-robot`, `codecov`, `dependabot`) and slash commands (e.g. `/lgtm`, `/retest`, `/hold`) are grouped into clean, expandable summary bars so you can focus on real human conversations.

### 4.4 Timeline Markers
Dynamic timeline markers visually highlight the exact point in the discussion where you **last viewed** the item or **acknowledged** it, allowing you to instantly catch up on what's new.

### 4.5 Desktop Alerts & Icon Badge
* **Toolbar Icon Badge:** Shows your live unread or inbox count directly on the Chrome toolbar.
* **Desktop Notifications:** Receive native OS notifications with configurable filters (Include/Exclude modes, repository/label/author wildcards, ignore bot noise).

---

## 5. Configuration & Customization

Click **Settings** (or the gear icon in the sidebar) to configure:

* **Repository Filters:**
  Enter one pattern per line. Use `*` as a wildcard and prefix with `!` to exclude:
  ```text
  kubernetes/*
  !kubernetes/steering
  my-org/*
  ```
* **Label Filters:**
  Filter items by GitHub label patterns:
  ```text
  area/*
  !kind/flake
  ```
* **Known Bots:**
  Add bot usernames whose comments should be grouped and collapsed.
* **Polling Interval:**
  Background sync interval (default: 1 minute).
* **Appearance:**
  Choose between **System** (matches OS theme), **Light** (GitHub Light), or **Dark** (GitHub Dark).

---

## 6. Synchronization & Data Retention

OctoDeck runs a lightweight local SQLite database to give you instant local search and offline-friendly triage. To keep your database fast, lean, and consistent with GitHub, a background maintenance routine (Garbage Collection) runs automatically once every 24 hours:

### 6.1 Unsubscribed & Untracked Items (30-Day Stale Check)
* **Real-time Notifications vs. Untracked Items:** Items you are subscribed to receive immediate updates through GitHub notifications. Items you are not subscribed to (marked with an **Untracked** badge) do not emit notification events.
* **Automatic Refetch:** To prevent untracked open items from drifting out of date or staying open indefinitely, OctoDeck checks for any open items that have not been fetched in over **30 days** (`last_synced_at > 30 days`).
* **State Reconciliation:** Stale open items are automatically refetched from GitHub in the background to sync their latest status, comments, reviews, and state (e.g. updating them if they were closed or merged upstream).

### 6.2 Data Retention Policy (90-Day Pruning)
* **Closed & Merged Items:** Closed and merged PRs and issues are retained locally for **90 days** after their last activity to ensure search history and recent context remain available.
* **Automatic Pruning:** Items closed or merged longer than 90 days are cleaned up during daily garbage collection to keep database storage minimal.
* **Local Data Protection:** Any item containing maintainer stars or private notes is permanently protected and will not be deleted by garbage collection even if the item is deleted upstream on GitHub.

