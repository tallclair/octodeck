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

* **Node.js** (LTS recommended, v20+)
* **Go** (1.24+)
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

3. **Enable Git Pre-Commit Hook (Optional):**
   ```bash
   ln -s ../../.githooks/pre-commit .git/hooks/pre-commit
   ```

4. **Generate API Code:**
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
   cd backend
   go run . serve --debug-server http://127.0.0.1:5173
   ```

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

* The Web App static bundle is built to `backend/frontend_dist/` and embedded directly into the Go binary via `//go:embed`.
* The Chrome Extension is built to `extension_dist/`.
* The `octodeck` binary is compiled to the project root.

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
