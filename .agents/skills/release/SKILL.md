---
name: release
description: Cuts an OctoDeck release and writes its release notes. Use when asked to prepare or cut a release, or to write release notes.
---

# Release Workflow

A release is a commit on `main` that contains its own notes at `docs/releases/vX.Y.Z.md`, tagged `vX.Y.Z`. Pushing the tag runs `.github/workflows/release.yml`, which builds the assets and creates a **draft** GitHub release whose body is the notes file plus a generated assets footer. `release.sh` refuses to tag if the notes file is not committed at `HEAD`.

The maintainer owns two decisions, and this workflow stops for them:

- **Gate 1:** the version number and the notes. Do not commit the notes before the maintainer approves them.
- **Gate 2:** tagging and pushing. Do not push anything before the maintainer approves.

Publishing the draft release on GitHub is always left to the maintainer.

## 1. Gather Material

1. Confirm the tree is on `main`, clean, and up to date with `origin/main` (`git status`, `git fetch origin --tags`, `git status -sb`).
2. Run `./scripts/release-notes.sh` (defaults to the latest `v*` tag through `HEAD`). It prints:
   - A counts line.
   - `## Breaking Changes`, `## Major Features`, `## Other Enhancements`, `## Bug Fixes`: one entry per commit, oldest first. Each entry has a heading made from the scope and description, a `Commit: <hash> | Type: <type> | Scope: <scope>` line, and the full commit body.
   - `## Omitted`: subjects of everything else (other types, `Release-Note: none`, reverted commits), with the reason in parentheses where there is one.
3. Read the two most recent files in `docs/releases/` as the reference for format, tone, and area names. (`v0.1.0.md` is an initial release and lists everything under a single `## Features` section; later releases use the template below.)

## 2. Decide What Goes In

The script output is the starting list, not the final one. Use `git show <hash>` or `git log <range> -- <path>` whenever a commit body is too thin to explain the user impact.

- **Breaking changes must be breaking for users.** A change to an internal API between the daemon and the web app, which ship together in one binary, is not breaking for users. Mention it only if it creates something users must do (for example, the extension and daemon must be updated together), and then under Upgrading > Action Required.
- **Major Features become Highlights.** If another feature clearly deserves to be a highlight, or a marked one clearly does not, make the call and list it for the maintainer at Gate 1.
- **Merge follow-ups.** Several commits that build one feature become one entry. Fixes to a feature introduced in the same release are part of that feature, not Bug Fixes. Drop them.
- **Scan Omitted.** Promote anything users would notice (for example, a `perf` commit that makes sync noticeably faster, or a `build` commit that changes install requirements) and flag it at Gate 1.
- **Find required actions.** Look for config migrations, new OAuth scopes (`gh auth login` scopes), changed install steps, and companion extension changes. The extension is installed unpacked, so any release that changes it requires users to update and reload it.
- **Leave out** internal refactors, tests, tooling, and anything users cannot observe, even if it was a `feat` or `fix` commit (for example, a developer-only debug command).

## 3. Suggest a Version

The maintainer chooses the version. Suggest one using these rules:

- **Before 1.0 (current):** breaking changes are permitted. Suggest a minor bump (`v0.2.0` to `v0.3.0`) if the release has any feature or breaking change, and a patch bump (`v0.3.0` to `v0.3.1`) if it has only fixes.
- **From 1.0 on:** standard SemVer. Breaking changes require a major bump.

`release.sh` only accepts the next patch, minor, or major version after the latest tag.

## 4. Draft the Notes

Read [references/release-notes-guide.md](references/release-notes-guide.md) for the template, structure rules, and style rules, then write `docs/releases/vX.Y.Z.md` following it. **Do not commit it yet.** Then stop at **Gate 1** and present:

1. The suggested version and why.
2. The draft (or its path).
3. The judgment calls: entries promoted, demoted, merged, or dropped relative to the script output, and any breaking change you reclassified.

Revise until the maintainer approves.

## 5. Commit and Dry Run

After Gate 1 approval:

1. Commit only the notes file: `git commit -m "docs(release): add vX.Y.Z release notes" -- docs/releases/vX.Y.Z.md`. The commit-msg hook forbids backticks.
2. Run `./release.sh --dry-run -y vX.Y.Z`. It checks the branch, the tree, the version, and the notes file, prints the notes, and runs `./verify.sh --force`. Fix any failure before continuing. Never use `--skip-verify` unless the maintainer explicitly asks.

## 6. Tag and Push

Stop at **Gate 2**. Tell the maintainer the dry run passed and ask for approval to push `main` and the tag. After approval:

1. `git push origin main` (the tag should point at a commit that is on `origin/main`).
2. `./release.sh -y vX.Y.Z`. This runs verification again, creates the annotated tag, and pushes it.

## 7. Check the Draft Release

1. Watch the release workflow: `gh run list --workflow release.yml --limit 1`, then `gh run watch <run-id>`.
2. Confirm the draft: `gh release view vX.Y.Z --json isDraft,body,assets`. The body should be the notes file followed by the Release Assets footer, and three assets should be attached (Linux binary, extension zip, web app zip).
3. Give the maintainer the release URL (`https://github.com/tallclair/octodeck/releases/tag/vX.Y.Z`) and remind them that publishing the draft is their step.

If the workflow fails, report the failing step. Never delete or move a pushed tag without the maintainer's approval.
