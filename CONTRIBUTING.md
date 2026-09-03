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
  - If `api/` changed: runs `api/verify.sh` (Protobuf linting and code generation check).
  - If `backend/` changed: runs `backend/verify.sh` (Go linting with `golangci-lint`, unit and integration tests).
  - If `frontend/` changed: runs `frontend/verify.sh` (TypeScript typecheck, ESLint, Vitest tests, and production builds).
- **Full Verification (`--force`):**
  ```bash
  ./verify.sh --force
  ```
  Runs all checks across the entire monorepo regardless of modified files. Used by release automation and CI gates.
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
| `feat` | A new user-facing feature or API capability | Features (`### Features`) |
| `fix` | A bug fix | Fixes (`### Fixes`) |
| `docs` | Documentation-only updates (README, docs, markdown files) | Other Changes (`### Other Changes`) |
| `style` | Code formatting or whitespace changes with no logic alterations | Other Changes (`### Other Changes`) |
| `refactor` | Code restructuring that neither fixes a bug nor adds a feature | Other Changes (`### Other Changes`) |
| `perf` | Changes that improve runtime performance | Other Changes (`### Other Changes`) |
| `test` | Adding missing tests or correcting existing tests | Other Changes (`### Other Changes`) |
| `build` | Changes to build tooling, dependencies, Vite, or LDFlags | Other Changes (`### Other Changes`) |
| `ci` | Changes to CI workflows, GitHub Actions, or automation scripts | Other Changes (`### Other Changes`) |
| `chore` | Routine repository maintenance, housekeeping, or cleanup | Other Changes (`### Other Changes`) |
| `revert` | Reverts a previous commit | Other Changes (`### Other Changes`) |

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
- Breaking changes indicate a major SemVer version increment.
- Describe the breaking change and migration requirements in the commit body, optionally with a `BREAKING CHANGE:` footer.

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
2. **Markdown Release Notes Corruption:** The automated release notes generator (`scripts/release-notes.sh`) formats commit subjects into Markdown bullet lists (`- <subject>`). Backticks in commit subjects frequently produce unclosed code spans, corrupt table layouts, and break rendering on GitHub Releases and web dashboard changelogs.
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

## 5. Automated Release Notes Generation

OctoDeck uses automated tooling (`scripts/release-notes.sh`) to generate release notes directly from Git commit history between tags (`git log $PREV_TAG..HEAD`).

### Categorization Pipeline
When a release is created, commits are automatically organized into sections:
- **`feat`** commits are grouped under **`### Features`**.
- **`fix`** commits are grouped under **`### Fixes`**.
- All other types (`docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`) are grouped under **`### Other Changes`**.

### Release Preview
The release automation script (`./release.sh`) displays the generated release notes in the terminal for preview before tagging and pushing a new release.

Because commit subjects are published directly in user-facing release notes, write clear, descriptive, professional descriptions that explain *what* changed from a user or consumer perspective.

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
   - Backend Go guidelines: `backend/GEMINI.md`
   - Frontend React & Extension guidelines: `frontend/GEMINI.md`
3. **Verify Git Hooks:** Confirm `git config core.hooksPath .githooks` has been configured.
4. **Implement Code & Tests:** Ensure all new code has unit/component tests.
5. **Run Verification:** Execute `./verify.sh` and ensure all checks pass with zero errors.
6. **Commit Changes:** Use Conventional Commits with zero backticks (`git commit -m "type(scope): description"`).
7. **Update Documentation:** If major architectural components or milestones were added, update `spec.md`.
