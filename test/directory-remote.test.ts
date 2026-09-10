import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { WS_MSG } from "../shared/types.js";
import { remoteDirectory, wsUrl } from "../shared/client/directory-remote.js";
import type { WebSocketCtor } from "../shared/client/transport-ws.js";

describe("remoteDirectory", () => {
  it("builds ws urls from http hosts", () => {
    assert.equal(wsUrl("http://x:1/", "/ws/events"), "ws://x:1/ws/events");
    assert.equal(wsUrl("https://x", "/ws/sessions/a"), "wss://x/ws/sessions/a");
  });

  it("lists over HTTP and streams events over /ws/events", async () => {
    const sessions: Record<string, unknown>[] = [{ id: "r1", status: "running", createdAt: 1 }];
    const http = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/sessions/r1") { res.end(JSON.stringify(sessions[0])); return; }
      res.end(JSON.stringify({ sessions }));
    });
    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, s, h) =>
      wss.handleUpgrade(req, s, h, (ws) => {
        const upd = Buffer.concat([
          Buffer.from([WS_MSG.SESSION_UPDATE]),
          Buffer.from(JSON.stringify({ id: "r1", status: "running", createdAt: 1, title: "new" })),
        ]);
        setTimeout(() => {
          ws.send(upd);
          sessions[0] = { id: "r1", status: "running", createdAt: 1, title: "new" };
          sessions.push({ id: "r2", status: "running", createdAt: 2 });
          ws.send("sessions-changed");
        }, 50);
      })
    );
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as AddressInfo).port;
    const d = remoteDirectory({ host: `http://127.0.0.1:${port}`, WS: WebSocket as unknown as WebSocketCtor });
    assert.deepEqual((await d.list()).map((s) => s.id), ["r1"]);
    assert.equal((await d.get("r1"))?.id, "r1");
    const events: string[] = [];
    const done = new Promise<void>((r) =>
      d.subscribe((e) => {
        events.push(e.type);
        if (events.length === 3) r();
      })
    );
    await done;
    // initial relist creates r1, then SESSION_UPDATE updates it, then r2 is created
    assert.deepEqual(events, ["created", "updated", "created"]);
    d.close();
    wss.close();
    http.close();
  });
});
