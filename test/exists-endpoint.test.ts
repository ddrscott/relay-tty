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

// A real temp cwd with a known file + subdir, used as the "session cwd".
let cwd: string;
let server: Server;
let baseUrl: string;

interface ExistsResult {
  path: string;
  exists: boolean;
  isFile: boolean;
}

async function postExists(
  sessionId: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/exists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

before(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-exists-"));
  fs.writeFileSync(path.join(cwd, "package.json"), "{}");
  fs.mkdirSync(path.join(cwd, "subdir"));

  // Minimal SessionStore: only .get is used by the exists route.
  const sessionStore = {
    get(id: string) {
      return id === "sess1" ? ({ id, cwd } as any) : undefined;
    },
  } as unknown as SessionStore;
  const ptyManager = {} as unknown as PtyManager;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(sessionStore, ptyManager));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("POST /api/sessions/:id/exists", () => {
  it("reports a real relative file as existing", async () => {
    const { status, json } = await postExists("sess1", { paths: ["package.json"] });
    assert.equal(status, 200);
    const r = json.results as ExistsResult[];
    assert.deepEqual(r[0], { path: "package.json", exists: true, isFile: true });
  });

  it("reports a missing file as not existing (no 404 for the batch)", async () => {
    const { status, json } = await postExists("sess1", { paths: ["Node.js", "nope.md"] });
    assert.equal(status, 200);
    const r = json.results as ExistsResult[];
    assert.equal(r.find((x) => x.path === "Node.js")!.exists, false);
    assert.equal(r.find((x) => x.path === "nope.md")!.exists, false);
  });

  it("reports a directory as existing but not a file", async () => {
    const { json } = await postExists("sess1", { paths: ["subdir"] });
    const r = json.results as ExistsResult[];
    assert.deepEqual(r[0], { path: "subdir", exists: true, isFile: false });
  });

  it("denies path traversal outside the session cwd", async () => {
    const { json } = await postExists("sess1", {
      paths: ["../../../../../../etc/passwd"],
    });
    const r = json.results as ExistsResult[];
    assert.equal(r[0].exists, false);
  });

  it("resolves an absolute path (leading slash) to the real file", async () => {
    const abs = path.join(cwd, "package.json");
    const { json } = await postExists("sess1", { paths: [abs] });
    const r = json.results as ExistsResult[];
    assert.equal(r[0].exists, true);
    assert.equal(r[0].isFile, true);
  });

  it("404s for an unknown session", async () => {
    const { status } = await postExists("does-not-exist", { paths: ["package.json"] });
    assert.equal(status, 404);
  });

  it("400s when paths is not an array", async () => {
    const { status } = await postExists("sess1", { paths: "package.json" });
    assert.equal(status, 400);
  });
});
