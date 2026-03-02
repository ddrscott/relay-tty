#!/usr/bin/env node

/**
 * postinstall.js — Download pre-built Rust pty-host binary for the current platform.
 *
 * Uses only Node builtins (no external dependencies). Falls back gracefully
 * if the download fails — the Node.js pty-host will be used instead.
 *
 * Set RELAY_SKIP_BINARY_DOWNLOAD=1 to skip (useful in CI with --ignore-scripts).
 */

import { createWriteStream, mkdirSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpsGet } from "node:https";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, "bin");
const BIN_PATH = join(BIN_DIR, "relay-pty-host");
const REPO = "ddrscott/relay-tty";

// Platform → Rust target triple
const PLATFORM_MAP = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

async function main() {
  // Skip if explicitly disabled
  if (process.env.RELAY_SKIP_BINARY_DOWNLOAD === "1") {
    console.log("relay-tty: Skipping binary download (RELAY_SKIP_BINARY_DOWNLOAD=1)");
    return;
  }

  // Skip if binary already exists (e.g. local cargo build)
  if (existsSync(BIN_PATH)) {
    console.log("relay-tty: Binary already exists at bin/relay-pty-host, skipping download");
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const target = PLATFORM_MAP[key];

  if (!target) {
    console.log(`relay-tty: No pre-built binary for ${key}, using Node.js fallback`);
    return;
  }

  // Read version from package.json
  let version;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    version = pkg.version;
  } catch (err) {
    console.log("relay-tty: Could not read package.json version, skipping binary download");
    return;
  }

  const assetName = `relay-pty-host-${target}`;
  const url = `https://github.com/${REPO}/releases/download/v${version}/${assetName}`;

  console.log(`relay-tty: Downloading ${assetName} (v${version})...`);

  mkdirSync(BIN_DIR, { recursive: true });

  await download(url, BIN_PATH);
  chmodSync(BIN_PATH, 0o755);
  console.log("relay-tty: Binary installed to bin/relay-pty-host");
}

/**
 * Download a URL to a file path, following up to 5 redirects.
 * Uses only Node builtin https module.
 */
function download(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) {
      return reject(new Error("Too many redirects"));
    }

    httpsGet(url, { headers: { "User-Agent": "relay-tty-postinstall" } }, (res) => {
      // Follow redirects (GitHub releases redirect to S3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain the response
        return download(res.headers.location, destPath, redirects - 1).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const file = createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
      file.on("error", (err) => {
        try { unlinkSync(destPath); } catch {}
        reject(err);
      });
    }).on("error", reject);
  });
}

main().catch((err) => {
  // Clean up partial download
  try { unlinkSync(BIN_PATH); } catch {}
  console.log(`relay-tty: Binary download failed (${err.message}), using Node.js fallback`);
});
