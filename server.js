import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import express from "express";
import compression from "compression";
import morgan from "morgan";

const PKG_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version;
const HOSTNAME = hostname();

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

/**
 * Load all server modules through a unified loader.
 * In dev, the loader is Vite SSR; in prod, it's dynamic import from dist/.
 */
async function loadModules(load) {
  const storeModule = await load("session-store");
  const sessionStore = new storeModule.SessionStore();

  const ptyModule = await load("pty-manager");
  const ptyManager = new ptyModule.PtyManager(sessionStore);
  await ptyManager.discover();

  const authModule = await load("auth");
  app.use(authModule.authMiddleware);

  const apiModule = await load("api");
  app.use("/api", apiModule.createApiRouter(sessionStore, ptyManager, { appUrl: APP_URL }));

  const wsModule = await load("ws-handler");
  const wsHandler = new wsModule.WsHandler(sessionStore, ptyManager);

  const notifyModule = await load("notify");
  notifyModule.setupNotifications(ptyManager, sessionStore, {
    discordWebhook: DISCORD_WEBHOOK,
    appUrl: APP_URL,
  });

  // Auth routes — plain Express redirects, no SSR needed.
  // These are server-only cookie operations; using React Router SSR for them
  // causes "No result found for routeId" errors in production builds.
  app.get("/api/auth/callback", (req, res) => {
    const token = req.query.token;
    if (!token || !authModule.verifyAccessToken(String(token))) {
      res.status(401).send("Invalid or expired token");
      return;
    }
    const sessionToken = authModule.generateToken() || token;
    const isSecure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
    const securePart = isSecure ? " Secure;" : "";
    res.setHeader("Set-Cookie", `session=${sessionToken}; HttpOnly; SameSite=Lax;${securePart} Path=/; Max-Age=${30 * 24 * 60 * 60}`);
    res.redirect("/");
  });

  app.get("/api/auth/logout", (_req, res) => {
    res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/");
  });

  return { sessionStore, ptyManager, wsHandler, verifyWsAuth: authModule.verifyWsAuth, generateToken: authModule.generateToken, generateAccessToken: authModule.generateAccessToken, verifyAccessToken: authModule.verifyAccessToken };
}

async function start() {
  let modules;

  if (isDev) {
    const vite = await import("vite");
    const viteServer = await vite.createServer({
      server: { middlewareMode: true },
    });

    modules = await loadModules((name) => viteServer.ssrLoadModule(`./server/${name}.ts`));

    app.use(viteServer.middlewares);

    const { createRequestHandler } = await import("@react-router/express");
    app.use(
      createRequestHandler({
        build: () => viteServer.ssrLoadModule("virtual:react-router/server-build"),
        getLoadContext() {
          return { sessionStore: modules.sessionStore, version: PKG_VERSION, hostname: HOSTNAME };
        },
      })
    );
  } else {
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    modules = await loadModules((name) => import(`./dist/server/${name}.js`));

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
          return { sessionStore: modules.sessionStore, version: PKG_VERSION, hostname: HOSTNAME };
        },
      })
    );
  }

  const { wsHandler, verifyWsAuth, generateToken, generateAccessToken } = modules;

  const httpServer = createServer(app);

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

  httpServer.listen(PORT, HOST, async () => {
    writeServerInfo();
    const localUrl = `http://localhost:${PORT}`;

    // ANSI helpers (inline — server.js is plain JS, not TS)
    const esc = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
    const _bold = esc("1");
    const _cyan = esc("36");
    const _dim = esc("2");

    console.log(`${_bold("relay-tty")} listening on ${_cyan(localUrl)}`);
    if (APP_URL) {
      console.log(`Public URL: ${_cyan(APP_URL)}`);
    }
    const token = generateToken ? generateToken() : null;
    if (token) {
      const authBase = APP_URL || localUrl;
      console.log(_dim(`Auth: ${authBase}/api/auth/callback?token=${token}`));
    }

    // Print QR code when APP_URL is set so phones can scan to authenticate
    if (APP_URL && generateAccessToken) {
      const qrToken = generateAccessToken(86400); // 24h expiry
      if (qrToken) {
        const qrUrl = `${APP_URL}/api/auth/callback?token=${qrToken}`;
        try {
          const qrcode = await import("qrcode-terminal");
          console.log(_dim("\nScan to authenticate (24h):"));
          qrcode.default.generate(qrUrl, { small: true }, (qr) => {
            // Print to stderr (POSIX: status output to stderr)
            process.stderr.write(qr + "\n");
          });
        } catch {
          // qrcode-terminal not available, skip
        }
      }
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
