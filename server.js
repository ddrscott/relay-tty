import { createServer } from "node:http";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import express from "express";
import compression from "compression";
import morgan from "morgan";

const PORT = parseInt(process.env.PORT || "7680", 10);
const HOST = "0.0.0.0";
const isDev = process.env.NODE_ENV !== "production";
const APP_URL = process.env.APP_URL;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const CONFIG_DIR = join(homedir(), ".config", "relay-tty");
const SERVER_FILE = join(CONFIG_DIR, "server.json");

const app = express();
app.use(compression());
app.use(morgan("short"));
app.use(express.json());

// Session store is created here so both API routes and React Router loaders can access it
let sessionStore;
let ptyManager;
let wsHandler;
let verifyWsAuth;
let generateToken;

function writeServerInfo() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SERVER_FILE, JSON.stringify({
    url: `http://localhost:${PORT}`,
    pid: process.pid,
    startedAt: Date.now(),
  }, null, 2) + "\n");
}

function clearServerInfo() {
  try { unlinkSync(SERVER_FILE); } catch {}
}

async function start() {
  if (isDev) {
    // In dev, Vite handles TS compilation for us
    const vite = await import("vite");
    const viteServer = await vite.createServer({
      server: { middlewareMode: true },
    });

    // Load server modules through Vite SSR pipeline (handles .ts)
    const storeModule = await viteServer.ssrLoadModule("./server/session-store.ts");
    sessionStore = new storeModule.SessionStore();

    const ptyModule = await viteServer.ssrLoadModule("./server/pty-manager.ts");
    ptyManager = new ptyModule.PtyManager(sessionStore);
    await ptyManager.discover();

    // Auth middleware (before API routes)
    const authModule = await viteServer.ssrLoadModule("./server/auth.ts");
    app.use(authModule.authMiddleware);
    verifyWsAuth = authModule.verifyWsAuth;
    generateToken = authModule.generateToken;

    const apiModule = await viteServer.ssrLoadModule("./server/api.ts");
    app.use("/api", apiModule.createApiRouter(sessionStore, ptyManager));

    const wsModule = await viteServer.ssrLoadModule("./server/ws-handler.ts");
    wsHandler = new wsModule.WsHandler(sessionStore, ptyManager);

    const notifyModule = await viteServer.ssrLoadModule("./server/notify.ts");
    notifyModule.setupNotifications(ptyManager, sessionStore, {
      discordWebhook: DISCORD_WEBHOOK,
      appUrl: APP_URL,
    });

    app.use(viteServer.middlewares);

    const { createRequestHandler } = await import("@react-router/express");
    app.use(
      createRequestHandler({
        build: () => viteServer.ssrLoadModule("virtual:react-router/server-build"),
        getLoadContext() {
          return { sessionStore };
        },
      })
    );
  } else {
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // In production, load compiled JS
    const { SessionStore } = await import("./dist/server/session-store.js");
    sessionStore = new SessionStore();

    const { PtyManager } = await import("./dist/server/pty-manager.js");
    ptyManager = new PtyManager(sessionStore);
    await ptyManager.discover();

    // Auth middleware
    const { authMiddleware, verifyWsAuth: vwa, generateToken: gt } = await import("./dist/server/auth.js");
    app.use(authMiddleware);
    verifyWsAuth = vwa;
    generateToken = gt;

    const { createApiRouter } = await import("./dist/server/api.js");
    app.use("/api", createApiRouter(sessionStore, ptyManager));

    const { WsHandler } = await import("./dist/server/ws-handler.js");
    wsHandler = new WsHandler(sessionStore, ptyManager);

    const { setupNotifications } = await import("./dist/server/notify.js");
    setupNotifications(ptyManager, sessionStore, {
      discordWebhook: DISCORD_WEBHOOK,
      appUrl: APP_URL,
    });

    app.use("/assets", express.static(
      path.join(__dirname, "build/client/assets"),
      { immutable: true, maxAge: "1y" }
    ));
    app.use(express.static(
      path.join(__dirname, "build/client"),
      { maxAge: "1h" }
    ));

    const { createRequestHandler } = await import("@react-router/express");
    const build = await import("./build/server/index.js");
    app.use(
      createRequestHandler({
        build,
        getLoadContext() {
          return { sessionStore };
        },
      })
    );
  }

  const httpServer = createServer(app);

  // WS upgrade routing with auth check
  if (wsHandler) {
    httpServer.on("upgrade", (req, socket, head) => {
      // Share WS connections validate their own token inside handleUpgrade
      const isShareWs = req.url?.startsWith("/ws/share");
      if (!isShareWs && verifyWsAuth && !verifyWsAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wsHandler.handleUpgrade(req, socket, head);
    });
  }

  httpServer.listen(PORT, HOST, async () => {
    writeServerInfo();
    const localUrl = `http://localhost:${PORT}`;
    console.log(`relay-tty listening on ${localUrl}`);
    if (APP_URL) {
      console.log(`Public URL: ${APP_URL}`);
    }
    const token = generateToken ? generateToken() : null;
    if (token) {
      const authBase = APP_URL || localUrl;
      console.log(`Auth: ${authBase}/api/auth/callback?token=${token}`);
    }
    if (DISCORD_WEBHOOK && APP_URL) {
      const authUrl = token
        ? `${APP_URL}/api/auth/callback?token=${token}`
        : APP_URL;
      try {
        await fetch(DISCORD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: authUrl }),
        });
      } catch (err) {
        console.error("Discord webhook failed:", err.message);
      }
    }
  });

  // Clean up server info on shutdown
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      clearServerInfo();
      process.exit(0);
    });
  }
}

start().catch((err) => {
  console.error("Failed to start:", err);
  clearServerInfo();
  process.exit(1);
});
