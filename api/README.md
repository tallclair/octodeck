# OctoDeck API

This directory contains the Protocol Buffer definitions for the OctoDeck project. It uses [Buf](https://buf.build/) to manage schema linting and code generation for both the Go backend and the TypeScript frontend.

## Directory Layout

- `octodeck/v1/`: Contains the versioned Proto definitions.
  - `resources.proto`: Common data models (Issues, PRs, etc.).
  - `service.proto`: The RPC service definition (Connect protocol).
- `buf.yaml`: The Buf module configuration.
- `buf.gen.yaml`: The generation configuration, defining where generated code is placed.
- `package.json`: Manages the Buf toolchain and generation scripts.

## Tooling & Conventions

### Generation

Code generation is triggered from this directory. It generates Go code into `../backend/internal/api` and TypeScript code into `../frontend/src/api`.

To generate code:
```bash
npm run generate
```

This runs `buf generate` followed by `goimports` to clean up the backend generation.

### Linting

We adhere to the `STANDARD` Buf linting rules. To check for linting errors:
```bash
npm run lint
```

### Conventions

- **Versioning:** All breaking changes should result in a new versioned directory (e.g., `v2/`).
- **Style:** Follow the [Google Protocol Buffers Style Guide](https://developers.google.com/protocol-buffers/docs/style).
- **Go Package:** The Go package prefix is managed via `buf.gen.yaml` to match the internal backend structure.
