import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createApiRouter } from "../server/api.js";
import type { SessionStore } from "../server/session-store.js";
import type { PtyManager } from "../server/pty-manager.js";

let targetDir: string;
let server: Server;
let baseUrl: string;

async function postUpload(
  filename: string,
  body: string,
  uploadDir?: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "X-Filename": filename };
  if (uploadDir !== undefined) headers["X-Upload-Dir"] = uploadDir;
  const res = await fetch(`${baseUrl}/api/upload`, { method: "POST", headers, body });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

before(async () => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-upload-"));

  const sessionStore = {} as unknown as SessionStore;
  const ptyManager = {} as unknown as PtyManager;

  const app = express();
  app.use("/api", createApiRouter(sessionStore, ptyManager));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(() => {
  server?.close();
  fs.rmSync(targetDir, { recursive: true, force: true });
});

describe("POST /api/upload with X-Upload-Dir", () => {
  it("writes the file into the requested directory", async () => {
    const { status, json } = await postUpload(
      "hello.txt",
      "hello world",
      encodeURIComponent(targetDir),
    );
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.path, path.join(targetDir, "hello.txt"));
    assert.equal(fs.readFileSync(json.path, "utf-8"), "hello world");
  });

  it("dedupes filenames in the target directory", async () => {
    const first = await postUpload("dup.txt", "one", encodeURIComponent(targetDir));
    const second = await postUpload("dup.txt", "two", encodeURIComponent(targetDir));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(second.json.path, first.json.path);
    assert.equal(path.dirname(second.json.path), targetDir);
    assert.equal(fs.readFileSync(first.json.path, "utf-8"), "one");
    assert.equal(fs.readFileSync(second.json.path, "utf-8"), "two");
  });

  it("expands a leading ~ to the home directory", async () => {
    // Point at an existing dir under $HOME via ~ to avoid creating junk:
    // use the target dir only if it's under home, otherwise skip expansion
    // specifics and just assert the endpoint accepts ~ and returns a path
    // inside the home directory.
    const { status, json } = await postUpload(
      "tilde.txt",
      "tilde",
      encodeURIComponent("~/.relay-tty/uploads-test-tmp"),
    );
    assert.equal(status, 200);
    assert.ok(json.path.startsWith(os.homedir()));
    fs.rmSync(path.join(os.homedir(), ".relay-tty/uploads-test-tmp"), { recursive: true, force: true });
  });

  it("rejects a relative X-Upload-Dir", async () => {
    const { status, json } = await postUpload(
      "rel.txt",
      "nope",
      encodeURIComponent("relative/dir"),
    );
    assert.equal(status, 400);
    assert.match(json.error, /absolute/);
  });

  it("rejects malformed URI encoding", async () => {
    const { status } = await postUpload("bad.txt", "nope", "%E0%A4%A");
    assert.equal(status, 400);
  });

  it("still uses the configured upload dir when header is absent", async () => {
    const { status, json } = await postUpload("plain.txt", "default dir");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    // Clean up the file written to the real configured upload dir
    fs.rmSync(json.path, { force: true });
  });
});
