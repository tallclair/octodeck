# Gemini Agent Instructions: OctoDeck Frontend

The `frontend/` directory holds the code for **OctoDeck**'s React Web App dashboard and companion Chrome Extension.

## Coding Standards & Style

### General Principles

* **TypeScript:** Use strict TypeScript for all logic. Define interfaces for all GitHub API responses and internal state objects.
* **Idiomatic:** Always use idiomatic TypeScript, and apply best practices.
* **Functional:** Prefer functional programming patterns. Use pure functions for the "Core Logic" engine (State/Noise detection).
* **Async/Await:** Use `async/await` over raw Promises. Handle errors explicitly in `try/catch` blocks.
* **Comments:** Add comments explaining anything that isn't obvious from the code.
* **Security:** Always prioritize security best practices.
* **No One-Off Hacks or Magic Tokens:** Never hardcode opaque IDs, mystery hashes, base64 strings, or temporary workarounds tailored to a single item. DOM parsing and timeline detection must rely on standard semantic selectors, classes, links, and official attribute patterns.

### Chrome Extension Specifics (Manifest V3)

* **Service Workers:** Remember `background.ts` is ephemeral. Do not rely on global variables for state; use `chrome.storage.local`.

### Frontend (React + Tailwind)

* **Components:** Functional components with Hooks.
* **Styling:** Use Tailwind CSS v4 utility classes. Avoid custom CSS files unless absolutely necessary for animations.
* **Icons:** Use `lucide-react`.
* **Types:** Centralize shared interfaces (GitHub responses, Storage schema) in `frontend/src/types/index.ts`. Avoid duplicating type definitions across files.

## Testing Strategy (Non-Negotiable)

* **Test-Driven Logic:** Write unit tests *before* or *alongside* implementation.
* **Tooling:** Use `Vitest`. The project is already configured with `jsdom` and a setup file at `frontend/src/test/setup.ts`.
* **Mocking:** Use `vi.stubGlobal('fetch', mock)` for mocking network requests to avoid TypeScript conflicts with the global scope.
* **Rule:** **Always run tests after changing anything.** Do not mark a task as complete until tests pass. Always run tests in non-interactive mode.
* **Scope:**
  * **Unit Tests:** Required for `NoiseFilter`, `StatusCalculator`, `UrlParser`, and `GitHubClient`.
  * **Component Tests:** Snapshot tests for complex UI cards.
  * **Manual Verification:** explicitly state the manual verification steps you performed (e.g., "Loaded extension in Chrome, clicked button X").

## Dependency Management

* **Philosophy:** Keep dependencies lightweight. Only take dependencies on well-known and officially supported packages.
* **Criteria:**
  * Use official libraries for accessing APIs when they exist
  * Avoid libraries maintained by a single independent individual
* **Management:** Use `npm` inside the `frontend/` directory (or `--workspace=frontend` from monorepo root). Lock versions in `package-lock.json`.
