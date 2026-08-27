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

OctoDeck offers multidimensional filtering and real-time search:

* **PRs vs Issues:** Quickly toggle between Pull Requests only, Issues only, or All.
* **State:** Filter by Open, Closed, or All.
* **Repository & Organization:** Filter by org (e.g. `kubernetes`) or specific repo (`kubernetes/kubernetes`).
* **Author:** Filter by author login or select `@me` (items you created).
* **Assigned to Me:** One-click toggle to view only items assigned to your GitHub username.
* **Milestone & Labels:** Filter by GitHub milestones and label taxonomies.
* **Sorting:** Sort by **Latest Activity**, **Last Acked**, or **Creation Date** in ascending or descending order.

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

