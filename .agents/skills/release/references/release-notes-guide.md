# Release Notes Guide

How to write `docs/releases/vX.Y.Z.md`. Follow it exactly so that notes are consistent in format and tone from release to release. The two most recent files in `docs/releases/` show it applied.

## Template

Use these sections in this order, and leave out any section that would be empty.

```markdown
# OctoDeck vX.Y.Z — <Short Theme>

<Summary: 1 to 2 sentences on what this release is about.>

## Upgrading

### Action Required

1. <Imperative step users must take when upgrading.>

### Breaking Changes

* **<Short name>:** <What changed; who is affected; whether it is migrated automatically; how to recover or downgrade, if relevant.>

## Highlights

### <Feature Name>

<2 to 3 sentences: what users can now do, why it matters, how to start.>

## Enhancements

### <Area>

* **<Short name>:** <What users can now do.>

## Bug Fixes

### <Area>

* **<Short name>:** <The corrected behavior.>
```

## Structure Rules

- **Title theme:** two to five words naming the release's main story (for example, "Saved Searches and Query Language"). If the release is mostly fixes, use something like "Sync Reliability Fixes".
- **Upgrading** comes first: it is what someone must read before upgrading. Omit it when both subsections are empty.
  - **Action Required:** numbered, imperative steps.
  - **Breaking Changes:** everything that now behaves incompatibly, including changes that are migrated automatically and need no action. A breaking change that needs action appears in both: the step under Action Required, the explanation here.
- **Highlights:** at most four. Each gets an `###` heading and a short paragraph, not bullets.
- **Areas** group Enhancements and Bug Fixes by what users see. Pick them per release (for example: Dashboard, Saved Searches, Companion Extension, Notifications, Daemon & Sync, Settings & Discovery). Reuse area names from earlier releases when they fit. Order areas by how much they changed. If a section has fewer than four bullets, skip the area subheadings and use a flat list.
- **No Release Assets section** and no install links. The release workflow appends those.
- **No commit hashes, PR links, or contributor credits.** Traceability lives in git.

## Style Rules

- **Tone:** concise and professional.
- **Audience:** a maintainer who uses OctoDeck daily but has never seen the code.
- **Bullets** open with a bold short name and a colon, followed by a brief phrase or sentence. Full sentences are not required; cut filler words. For example: "**Saved searches:** pin any query to the sidebar, with live match and unread counts."
- **Tense and voice:** present tense, active voice, focused on what users can now do. Avoid "we" and "you" unless a phrase reads awkwardly without them.
- **Bug fixes** state the corrected behavior, not the bug or its cause: "**Bot detection:** collapsed comment boxes no longer flagged as bots", not "Fixed a bug where the bot detector misclassified the comment box".
- **Names users see only:** UI labels, CLI commands, config files, and settings. No package, function, RPC, proto, or file names unless users interact with them. Write UI labels as they appear in the app.
- **Code formatting** for commands, file paths, URLs, query syntax, and keyboard keys (for example `octodeck install`, `~/.octodeck/config.json`, `is:open`, `j`/`k`).
- **No emoji**, no exclamation marks, no marketing superlatives ("blazing fast", "powerful", "seamless").
- **Consistent terms:** use the terms the app and the User Guide (`docs/user_guide.md`) use (Ack, Inbox, New Activity, saved search, discovery query, companion extension, daemon).
