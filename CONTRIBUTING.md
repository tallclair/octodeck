# Contributing to OctoDeck

Thank you for contributing to OctoDeck! OctoDeck is a dashboard for high-volume open source maintainers.

The repository is organized as a monorepo:
- **Backend:** A local Go daemon (`backend/`) handling GitHub synchronization, SQLite persistence, and ConnectRPC services.
- **Frontend:** A React Web App dashboard (`frontend/src/`) and Chrome Companion Extension (`frontend/src/extension/`).
- **API:** Protocol Buffer definitions (`api/`) compiled with `buf`.

To ensure reliability, reproducible releases, and high code quality, all contributions must follow the guidelines outlined below.

---

## 1. Development Setup & Git Hooks

### Prerequisites
- **Go:** 1.24+
- **Node.js:** LTS (v20+)
- **GitHub CLI (`gh`):** Authenticated with `gh auth login -s read:org,notifications,repo`

### Initial Repository Setup
1. Clone the repository and install root dependencies:
   ```bash
   git clone <repository-url>
   cd octodeck
   npm install
   ```

2. **Configure Git Hooks (Mandatory):**
   ```bash
   git config core.hooksPath .githooks
   ```
   OctoDeck maintains version-controlled Git hooks in the `.githooks/` directory:
   - **`pre-commit`:** Automatically runs `./verify.sh` on changed files to ensure tests and linters pass before committing.
   - **`commit-msg`:** Validates that commit messages follow the Conventional Commits standard and enforces the strict prohibition on backticks.

---

## 2. Developer Verification (`./verify.sh`)

Before creating a commit or submitting a pull request, run the repository verification runner:

```bash
./verify.sh
```

### Verification Behavior
- **Selective Verification:** By default, `./verify.sh` detects changed files using `git status --porcelain` and executes only the affected subsystem suites:
  - If `api/` changed: runs `api/verify.sh` (Protobuf linting, plus a check that the committed generated code matches a fresh `npm run generate`).
  - If `backend/` changed: runs `backend/verify.sh` (Go linting with `golangci-lint`, unit and integration tests).
  - If `frontend/` changed: runs `frontend/verify.sh` (TypeScript typecheck, ESLint, Vitest tests, and production builds).
  - If `scripts/`, `.githooks/`, or `release.sh` changed: runs `scripts/verify.sh` (the `scripts/test-*.sh` suites).
  - Root dependency files map to the components they affect: `go.work`/`go.work.sum` run API and backend checks; `package.json`/`package-lock.json`/`.npmrc` run API and frontend checks; changes to `verify.sh` itself run everything.
  - API changes do not trigger backend or frontend checks on their own. Any API change that affects them must change the committed generated code under `backend/` or `frontend/`, and the generated code check enforces that.
- **Parallel Execution:** Selected components run in parallel, and within the backend (build, lint, tests) and frontend (typecheck, lint, tests, webapp and extension bundles) the individual steps run in parallel too, via the shared `scripts/lib/parallel.sh` helper. Output is captured per step: a `PASS`/`FAIL` line with the elapsed time is printed as each finishes, and the full output of anything that failed is printed at the end. Interrupting (Ctrl-C) stops everything. Frontend linting uses an ESLint cache in `frontend/node_modules/.cache/eslint/`.
- **Full Verification (`--force`):**
  ```bash
  ./verify.sh --force
  ```
  Runs all checks across the entire monorepo regardless of modified files, using full (not incremental) backend linting. Used by release automation.
- **Continuous Integration:** `.github/workflows/ci.yml` runs the full suite on every pull request and push to `main`, with one parallel job per component. The aggregate `CI passed` check is the one to require in branch protection.
- **Verification Rule:** Never attempt to bypass verification failures. All tests, linters, and typechecks must pass cleanly with zero errors.

---

## 3. Commit Message Standards

OctoDeck strictly enforces the **Conventional Commits 1.0.0** specification.

### Commit Format
```
<type>(<scope>)!: <description>

[optional body]

[optional footer(s)]
```

### Allowed Commit Types
The commit type must be strictly lowercase and must be one of the following:

| Type | Purpose | Release Notes Category |
|---|---|---|
| `feat` | A new user-facing feature or API capability | Other Enhancements, or Major Features with `Release-Note: major` |
| `fix` | A bug fix | Bug Fixes |
| `docs` | Documentation-only updates (README, docs, markdown files) | Omitted |
| `style` | Code formatting or whitespace changes with no logic alterations | Omitted |
| `refactor` | Code restructuring that neither fixes a bug nor adds a feature | Omitted |
| `perf` | Changes that improve runtime performance | Omitted |
| `test` | Adding missing tests or correcting existing tests | Omitted |
| `build` | Changes to build tooling, dependencies, Vite, or LDFlags | Omitted |
| `ci` | Changes to CI workflows, GitHub Actions, or automation scripts | Omitted |
| `chore` | Routine repository maintenance, housekeeping, or cleanup | Omitted |
| `revert` | Reverts a previous commit | Omitted (and so is the reverted commit) |

A commit of any type marked as breaking (see below) is listed under Breaking Changes. Because performance improvements are omitted, use `feat` or `fix` for a perf change that users would notice and care about.

### Scopes (Optional)
Scopes provide context on which component was modified and are enclosed in parentheses immediately after the type.
- Allowed characters in scope: alphanumeric characters, underscores, hyphens, periods, and forward slashes (`[-a-zA-Z0-9_./]`).
- Spaces are not permitted inside the scope parentheses.
- Common scopes across OctoDeck:
  - `backend`: Go daemon, server, or logic packages
  - `frontend`: React Web App dashboard
  - `extension`: Chrome Companion Extension
  - `api`: Protobuf schemas and ConnectRPC definitions
  - `dashboard`: UI components and triage views
  - `server`: HTTP and ConnectRPC server routing
  - `github`: GitHub REST and GraphQL client
  - `storage`: SQLite database and persistence layer
  - `hooks`: Git hook automation
  - `scripts`: Build and release tooling

### Breaking Changes (`!:`)
Breaking changes represent backwards-incompatible API or behavioral changes.
- Indicated by placing an exclamation point `!` immediately before the colon:
  - With scope: `feat(api)!: modify StatusResponse JSON schema`
  - Without scope: `feat!: change default daemon port to 38275`
- Breaking changes are permitted before 1.0 and require a major version bump from 1.0 on (see [Versioning](#versioning)).
- Alternatively, add a `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer to the commit body. Either form lists the commit under Breaking Changes in the release notes.
- Describe the breaking change and migration requirements in the commit body, optionally with a `BREAKING CHANGE:` footer.

### Release-Note Footer
An optional `Release-Note:` footer controls how a commit appears in the release notes. The `commit-msg` hook accepts only these values:

| Footer | Effect |
|---|---|
| `Release-Note: major` | Lists a `feat` commit under Major Features instead of Other Enhancements. Use it for headline features worth calling out at the top of the release. |
| `Release-Note: none` | Omits a `feat` or `fix` commit from the release notes, such as a fix for a bug that was introduced and fixed within the same release. |

Example:
```
feat(dashboard): add saved searches

Saved searches allow arbitrary queries to be pinned to the sidebar.

Release-Note: major
```

### Description Formatting Rules
- Must include a colon followed by exactly one space (`: `).
- Written in the imperative mood ("add feature", not "added feature" or "adds feature").
- Do not end the subject line with a period.

---

## 4. Strict Prohibition on Backticks

**RULE: Never use backticks (\`) in commit messages.**

Commit messages must never contain backtick characters anywhere in the subject line or body. This is strictly enforced by the `.githooks/commit-msg` hook.

### Why Backticks Are Prohibited
1. **Shell Script Execution Hazards:** In Bourne/Bash shells, backticks are command substitution operators. Because commit subjects are passed into shell variables by release automation scripts (such as `git tag -a <version> -m "$SUBJECT"` or CI pipelines), unescaped backticks trigger unexpected shell command execution or syntax crashes.
2. **Markdown Release Notes Corruption:** The automated release notes generator (`scripts/release-notes.sh`) formats commit subjects into Markdown headings. Backticks in commit subjects frequently produce unclosed code spans, corrupt table layouts, and break rendering on GitHub Releases and web dashboard changelogs.
3. **Cross-Platform Portability:** Avoids quoting and escaping bugs across different operating systems and developer shells (Linux, macOS, Windows Git Bash).

### Acceptable Alternatives to Backticks
When referencing code identifiers, filenames, function names, or CLI flags in commit messages, use single quotes, double quotes, or plain text:

| Forbidden (Uses Backticks) | Allowed (Single/Double Quotes or Plain Text) |
|---|---|
| ``feat: update `server.Version` constant`` | `feat: update 'server.Version' constant` |
| ``fix: handle `304 Not Modified` response`` | `fix: handle "304 Not Modified" response` |
| ``refactor: clean up `StatusResponse` proto`` | `refactor: clean up StatusResponse proto` |
| ``fix(cli): fix `--version` flag output`` | `fix(cli): fix '--version' flag output` |

---

## 5. Releases & Release Notes

### Versioning
OctoDeck follows SemVer, with the usual pre-1.0 relaxation:
- **Before 1.0 (alpha, current):** breaking changes are permitted in any release. Releases with new features or breaking changes typically bump the minor version (`v0.1.0` to `v0.2.0`), and releases with only fixes bump the patch version (`v0.2.0` to `v0.2.1`).
- **From 1.0 on:** breaking changes require a major version bump.

The maintainer cutting the release chooses the version. `release.sh` only enforces that it is the next patch, minor, or major version.

### Release Notes
Release notes are written for each release and committed as `docs/releases/vX.Y.Z.md`, named after the release tag, before tagging. `release.sh` refuses to tag without that file at `HEAD`, and the release workflow publishes it (followed by a generated list of release assets) as the body of the draft GitHub release. The earlier files in `docs/releases/` are the reference for format and tone.

Agents writing release notes follow the release skill (`.agents/skills/release/SKILL.md`), which documents the full release workflow, the notes template, and the style rules.

### Release Notes Input (`scripts/release-notes.sh`)
The notes are drafted from `scripts/release-notes.sh [FROM_REF] [TO_REF]` (defaulting to the latest tag through `HEAD`), which groups the commits in the range by user impact. Every included entry carries the full commit body along with the commit hash, type, and scope. Each included commit is listed in exactly one section, in this order:
1. **`## Breaking Changes`:** commits of any type with `!` before the colon or a `BREAKING CHANGE:` footer.
2. **`## Major Features`:** `feat` commits with a `Release-Note: major` footer.
3. **`## Other Enhancements`:** all other `feat` commits.
4. **`## Bug Fixes`:** `fix` commits.
5. **`## Omitted`:** everything else, by subject only: the other commit types, commits with a `Release-Note: none` footer, and commits that were reverted within the range. Merge commits are skipped entirely.

Within each section, entries are listed oldest first.

Because commit subjects and bodies are the source material for user-facing release notes, write clear, descriptive, professional descriptions that explain *what* changed from a user or consumer perspective, and use the body to explain the user impact of `feat` and `fix` commits and the migration steps for breaking changes.

---

## 6. Commit Message Examples

### Valid Commit Messages (Allowed)
- `feat(backend): add git-derived version injection via ldflags`
- `feat(extension): inject version into dashboard DOM`
- `fix(dashboard): display mismatch banner when versions differ`
- `fix: resolve comment gap backfill in sync engine`
- `docs: create CONTRIBUTING.md detailing commit standards`
- `style(frontend): format card header with tailwind utility classes`
- `refactor(server): decouple status handler from root command`
- `perf(sync): optimize GraphQL batch hydration query`
- `test(backend): add unit test for root command version flag`
- `build(deps): update connectrpc to v1.18.0`
- `ci: configure automated verification workflow`
- `chore(hooks): add commit-msg hook for conventional commits`
- `feat(api)!: restructure 'StatusResponse' protobuf definition`
- `feat(dashboard): add saved searches` with a `Release-Note: major` footer
- `revert: revert commit 'feat(ui): experimental card animation'`

### Invalid Commit Messages (Rejected by Hook)
- ``fix: update `server.Version` constant``
  *(Rejected: contains backticks. Use single quotes 'server.Version' instead.)*
- `Fixed status calculation bug`
  *(Rejected: missing Conventional Commits type prefix.)*
- `Feat: add extension options page`
  *(Rejected: type must be lowercase 'feat', not 'Feat'.)*
- `feature: add support for org webhooks`
  *(Rejected: 'feature' is not an allowed type; use 'feat'.)*
- `bugfix: handle nil pointer in client`
  *(Rejected: 'bugfix' is not an allowed type; use 'fix'.)*
- `feat:`
  *(Rejected: empty description.)*
- `feat:no space after colon`
  *(Rejected: missing space after colon.)*
- `feat(frontend ui): add buttons`
  *(Rejected: spaces are not allowed inside scope parentheses.)*
- `WIP`
  *(Rejected: not a valid Conventional Commit.)*

---

## 7. Contribution Workflow Summary

1. **Check Requirements:** Verify that your planned changes align with `spec.md`.
2. **Review Component Guidelines:**
   - Backend Go guidelines: `backend/AGENTS.md`
   - Frontend React & Extension guidelines: `frontend/AGENTS.md`
3. **Verify Git Hooks:** Confirm `git config core.hooksPath .githooks` has been configured.
4. **Implement Code & Tests:** Ensure all new code has unit/component tests.
5. **Run Verification:** Execute `./verify.sh` and ensure all checks pass with zero errors.
6. **Commit Changes:** Use Conventional Commits with zero backticks (`git commit -m "type(scope): description"`).
7. **Update Documentation:** If major architectural components or milestones were added, update `spec.md`.
