# Developing OctoDeck

This document covers setup, architecture, and development workflows for contributing to and hacking on OctoDeck.

## Project Structure

OctoDeck is organized as a Monorepo:

* `api/`: Protocol Buffer definitions (`octodeck/v1/service.proto`, `resources.proto`) and generation toolchain (`buf`).
* `backend/`: Local Go daemon (`octodeck`) handling GitHub API synchronization, local SQLite persistence, ConnectRPC service endpoints, and embedded static web assets (`backend/frontend_dist/`).
* `frontend/`: React/TypeScript codebase powering both the Web App dashboard and the Companion Chrome Extension.
* `backend/frontend_dist/`: Pre-compiled Web App static bundle embedded into the Go binary.
* `extension_dist/`: Pre-compiled Manifest V3 Chrome Companion Extension ready to load in Chrome.
* `docs/`: User guides, developer guides, and internal architecture design documents.

## Development Setup

### Prerequisites

* **Node.js & npm** (LTS recommended, v20+)
* **Go** (1.24+)
* **C compiler (`gcc` or `clang`)** (Required for CGO to compile `github.com/mattn/go-sqlite3`)
* **GitHub CLI (`gh`)** with active authentication:
  ```bash
  gh auth login -s read:org,notifications,repo
  ```

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd octodeck
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   *(Installs workspace runtime dependencies and local build tools—including `tsc`, `vite`, `eslint`, `vitest`, and `buf`—into `node_modules/.bin/`. Do not use `--omit=dev`, as `tsc` and `vite` are required to build.)*

3. **Configure Git Hooks:**
   ```bash
   git config core.hooksPath .githooks
   ```

4. **Generate API Code (when `.proto` schemas change):**
   ```bash
   npm run generate
   ```
   This invokes `buf` to generate Go Protobuf/ConnectRPC handlers in `backend/internal/api/` and TypeScript definitions/clients in `frontend/src/api/`.

## Running the Web App (Development Mode)

For fast UI development with Hot Module Replacement (HMR), run the Vite dev server paired with the Go backend in reverse-proxy mode (`--debug-server`):

1. **Start the Vite Dev Server:**
   ```bash
   npm run dev:webapp --workspace=frontend
   ```
   *(Runs on `http://127.0.0.1:5173`)*

2. **Start the Backend Daemon with Proxy Mode:**
   ```bash
   ./scripts/build-backend.sh
   ./octodeck serve --debug-server http://127.0.0.1:5173
   ```
   *(Running `./scripts/build-backend.sh` ensures the frontend fallback placeholder exists on fresh checkouts and injects git SemVer into `server.Version` via LDFlags)*

3. **Access the Web App:**
   Open `http://127.0.0.1:38274` in your browser. Requests for frontend assets are proxied directly to Vite, giving you instant HMR without rebuilding static bundles or restarting the Go daemon.

## Remote Development & SSH Port Forwarding

When developing on a remote workstation, cloud VM, or SSH host:

1. **Forward the daemon port to your local machine:**
   ```bash
   ssh -N -L 38274:localhost:38274 user@remote-host
   ```
   *(Or add `LocalForward 38274 127.0.0.1:38274` to your `~/.ssh/config`)*

2. **Access Dashboard & Extension Locally:**
   * **Web Dashboard:** Open `http://127.0.0.1:38274` in your local browser.
   * **Vite HMR Dev Mode:** The Go backend proxies dev requests to Vite on port 38274, so only port 38274 needs to be SSH-forwarded.
   * **Companion Chrome Extension:** The extension installed in your local browser communicates with `http://127.0.0.1:38274` across the SSH tunnel.

## Building Production Artifacts

To compile all monorepo components (Web App static bundle, Chrome Extension, and Go binary):

```bash
npm run build
```

This executes two build stages in sequence:

1. **Frontend (`npm run build:frontend`)**:
   * **Web App (`npm run build:webapp --workspace=frontend`)**: Runs TypeScript (`tsc -b`) and Vite (`BUILD_TARGET=webapp`) to output the static React Web App bundle into `backend/frontend_dist/`.
   * **Chrome Extension (`npm run build:extension --workspace=frontend`)**: Runs Vite in two passes (`BUILD_TARGET=extension` for background service worker, options page, and Manifest V3 version injection, followed by `BUILD_TARGET=extension-content` for content scripts) into `extension_dist/`.
2. **Backend (`npm run build:backend` / `./scripts/build-backend.sh`)**:
   * Ensures `backend/frontend_dist/index.html` exists (creating a minimal placeholder if the backend is built standalone before the frontend) so Go's `//go:embed frontend_dist` directive succeeds.
   * Derives the build version from `OCTODECK_VERSION` or `git describe --tags --match "v*" --always --dirty` (falling back to `"dev"`).
   * Compiles `./backend` via `go build` with `-ldflags` version injection into `server.Version`, producing the `./octodeck` binary in the project root.

## Loading the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle in the upper-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `extension_dist` directory in the repository root.

## Testing & Verification

Run the repository verification pipeline before submitting changes:

```bash
./verify.sh
```

This executes:
* Protobuf schema validation and linting (`api/verify.sh`)
* Go static analysis, linters, and unit/adversarial tests (`backend/verify.sh`)
* TypeScript type checking, ESLint, and Vitest test suites (`frontend/verify.sh`)
