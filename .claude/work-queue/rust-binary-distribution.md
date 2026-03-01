# CI Cross-Compilation + Postinstall Binary Download for Rust pty-host

## Problem
The Rust pty-host binary only exists for the architecture of whoever runs `cargo build`. For `npx relay-tty` to work without a Rust toolchain, pre-built binaries must be available for all target platforms. This is a **gate on npm publishing**.

Without this, users without Rust get the Node.js fallback — which works, but defeats the purpose of the Rust rewrite (reliability, memory).

## Platform Matrix

| Target | OS | Arch | Notes |
|---|---|---|---|
| `aarch64-apple-darwin` | macOS | ARM64 | M1/M2/M3 Macs (primary dev target) |
| `x86_64-apple-darwin` | macOS | x86_64 | Intel Macs |
| `x86_64-unknown-linux-gnu` | Linux | x86_64 | Most servers, CI, WSL |
| `aarch64-unknown-linux-gnu` | Linux | ARM64 | AWS Graviton, Raspberry Pi |

Windows is out of scope (no `forkpty`).

## Implementation

### 1. GitHub Actions Workflow (`.github/workflows/rust-build.yml`)

Trigger: on git tag `v*` (release) or manual dispatch.

**Matrix strategy**:
- macOS ARM64: `runs-on: macos-14` (M1 runner), native build
- macOS x86_64: `runs-on: macos-13` (Intel runner), native build
- Linux x86_64: `runs-on: ubuntu-latest`, native build
- Linux ARM64: `runs-on: ubuntu-latest`, cross-compile with `cross` or `cargo-zigbuild`

**Steps per target**:
1. Checkout repo
2. Install Rust toolchain (via `dtolnay/rust-toolchain@stable`)
3. `cargo build --release --manifest-path crates/pty-host/Cargo.toml`
4. Strip binary (`strip` on macOS, `llvm-strip` or `aarch64-linux-gnu-strip` for cross)
5. Upload artifact: `relay-pty-host-{target}` (e.g. `relay-pty-host-aarch64-apple-darwin`)

**Release job** (after all builds):
1. Create GitHub release (or attach to existing)
2. Upload all four binaries as release assets

### 2. Postinstall Binary Download (`scripts/postinstall.js`)

Runs on `npm install` / `npx relay-tty`. Downloads the correct pre-built binary for the current platform.

```
detect platform: process.platform + process.arch
  → map to target triple (e.g. darwin + arm64 → aarch64-apple-darwin)
  → construct URL: https://github.com/<repo>/releases/download/v<version>/relay-pty-host-<target>
  → download to bin/relay-pty-host
  → chmod +x
```

**Edge cases**:
- Network failure: warn, fall back to Node pty-host (already handled by pty-manager)
- Unsupported platform: warn, fall back to Node
- CI environments: respect `--ignore-scripts` (npm) or `RELAY_SKIP_BINARY_DOWNLOAD=1` env var
- Version: read from `package.json` version field to construct the download URL

### 3. Package.json Changes

```json
{
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  }
}
```

The `bin/relay-pty-host` path is already in `.gitignore`. The postinstall script should be lightweight (no dependencies beyond Node builtins — use `https.get` or `fetch`).

### 4. Version Synchronization

The GitHub release tag must match `package.json` version. Options:
- **Simple**: Tag manually before `npm publish`, postinstall uses the tag
- **Automated**: CI creates the release + publishes to npm in one workflow

## Acceptance Criteria
- [ ] GitHub Actions workflow builds Rust binary for all 4 targets on tag push
- [ ] Binaries are attached to GitHub releases as downloadable assets
- [ ] `postinstall.js` detects platform and downloads correct binary to `bin/relay-pty-host`
- [ ] `npx relay-tty` works on a clean machine (no Rust) on macOS ARM64, macOS x86_64, Linux x86_64, Linux ARM64
- [ ] Graceful fallback: if download fails, Node pty-host is used (with a warning)
- [ ] `npm install --ignore-scripts` still works (Node fallback)
- [ ] Binary is stripped and < 1MB per platform
- [ ] CI also runs `cargo test` as part of the build (catch regressions before release)

## Relevant Files
- `.github/workflows/` — new workflow file
- `scripts/postinstall.js` — new, binary download script
- `package.json` — add postinstall script
- `crates/pty-host/Cargo.toml` — already exists
- `server/pty-manager.ts` — already checks `bin/relay-pty-host` first
- `cli/spawn.ts` — already checks `bin/relay-pty-host` first

## Constraints
- Postinstall script must use only Node builtins (no `node-fetch`, no `axios`)
- Must not slow down `npm install` significantly — download should be fast (binary is ~700KB)
- Must not break if GitHub is unreachable (graceful fallback)
- Linux cross-compilation for ARM64 needs `cross` or `cargo-zigbuild` (can't native-build on ubuntu-latest x86 runners)
