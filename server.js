import { createServer } from "node:http";
import express from "express";
import compression from "compression";
import morgan from "morgan";

const PORT = parseInt(process.env.PORT || "7680", 10);
const HOST = "0.0.0.0";
const isDev = process.env.NODE_ENV !== "production";

const app = express();
app.use(compression());
app.use(morgan("short"));
app.use(express.json());

// Session store is created here so both API routes and React Router loaders can access it
let sessionStore;
let ptyManager;
let wsHandler;
let verifyWsAuth;

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

    // Auth middleware (before API routes)
    const authModule = await viteServer.ssrLoadModule("./server/auth.ts");
    app.use(authModule.authMiddleware);
    verifyWsAuth = authModule.verifyWsAuth;

    const apiModule = await viteServer.ssrLoadModule("./server/api.ts");
    app.use("/api", apiModule.createApiRouter(sessionStore, ptyManager));

    const wsModule = await viteServer.ssrLoadModule("./server/ws-handler.ts");
    wsHandler = new wsModule.WsHandler(sessionStore, ptyManager);

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

    // Auth middleware
    const { authMiddleware, verifyWsAuth: vwa } = await import("./dist/server/auth.js");
    app.use(authMiddleware);
    verifyWsAuth = vwa;

    const { createApiRouter } = await import("./dist/server/api.js");
    app.use("/api", createApiRouter(sessionStore, ptyManager));

    const { WsHandler } = await import("./dist/server/ws-handler.js");
    wsHandler = new WsHandler(sessionStore, ptyManager);

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
      if (verifyWsAuth && !verifyWsAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wsHandler.handleUpgrade(req, socket, head);
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`relay-tty listening on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
