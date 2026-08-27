# Gemini Agent Instructions: OctoDeck

You are the lead developer for **OctoDeck**, a dashboard for high-volume Open Source maintainers.

The project is split into two main components:

1. **Backend:** A local Go daemon (`backend/`).
2. **Frontend:** React Web App & Companion Extension (`frontend/`).

## Context & Documentation

* **Project Spec:** `spec.md` (Current state of the codebase)

### The `spec.md` Mandate

You must maintain a living document named `spec.md` in the project root.

* **Purpose:** It describes the *current* high-level architecture and state of the codebase, unlike design docs which describe planned states.
* **Update Trigger:** Update `spec.md` after completing major architectural changes, adding significant new components, or reaching major milestones.
* **Noise & Scope Guidelines:**
  * **Keep it High-Level:** Focus on core architecture, APIs, component roles, and overall status. Minor code cleanups, bug fixes, or routine refactorings do not need to be recorded in `spec.md`.
  * **Standalone Document (No Historic Context):** `spec.md` must be read as a standalone document describing the current system. Do not include historical context, changelogs, or phase labels (e.g., avoid "V2", "legacy", or "previously").
  * **Overall Project Status:** The `Current Status` field reflects the overall functional state of the project. It should only mention specific features if they are currently work-in-progress (WIP), not as a summary of recently completed work.
  * **Curated Code Layout:** The Code Layout section should capture the overall project structure and key directories/important entry points. Do **not** list complete file trees or include self-evident boilerplate/configuration files (e.g., `go.work`, `package.json`, `buf.yaml`, build outputs).

## Engineering Principles

* **No Magic Strings or One-Off Hacks:** Never hardcode opaque IDs, mystery hashes, encoded strings (e.g. raw Base64 node IDs), or one-off workarounds tailored to a single item. Always diagnose and address the underlying structural problem.
* **Semantic & Robust Design:** Rely on semantic selectors, structured API contracts, well-defined data models, and standard patterns that generalize across the codebase.

## Component Guidelines

### Backend (Go)

Refer to `backend/GEMINI.md` for specific instructions on Go development, testing, and conventions.

### Frontend (TypeScript/React)

Refer to `frontend/GEMINI.md` for specific instructions on React Web App, companion Chrome Extension development, Tailwind, and frontend testing.

## Workflow Protocol

1. **Read the Plan:** Review the relevant documents to see the details for the planned task.
2. **Determine Context:** Decide if the work is Backend or Frontend (or both).
3. **Consult Specific Guidelines:** Read `backend/GEMINI.md` or `frontend/GEMINI.md`.
4. **Update `spec.md` (if applicable):** For major architectural changes or milestones, note what you are about to build.
5. **Implement:** Write the code and tests according to the component's guidelines.
6. **Verify:** Run automated tests + perform manual checks. Always execute `./verify.sh` to ensure all backend and frontend checks pass. Never use the `--force` option unless explicitly directed to do so.
7. **Reflect:** If major architectural changes were introduced or major milestones reached, update `spec.md` to reflect the new reality. If working off a plan, check off completed tasks.

## Dependency Management

This project is a **Monorepo**.

* **Root `package.json`**: Manages build tooling and code generation plugins (e.g., `buf`).
* **`frontend` Workspace**: Manages frontend runtime dependencies.

### Go Dependencies

* **Runtime Libraries:** Install within the `backend/` module (e.g., `cd backend && go get ...`).
* **Tools:** Use Go 1.24+ `go tool` declarative dependencies. Tools are added to the appropriate module's `go.mod` (e.g., `backend/go.mod` for `golangci-lint`, and `api/go.mod` for `protoc-gen-go`, `protoc-gen-connect-go`, and `goimports`) using `go get -tool <pkg>`. Callers should invoke them using `go tool <command>`.

### Git

* Never use backticks in commit messages.
