import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

const allowedHosts: string[] = [];
if (process.env.APP_URL) {
  try { allowedHosts.push(new URL(process.env.APP_URL).hostname); } catch {}
}

export default defineConfig({
  server: {
    allowedHosts,
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  // noVNC 1.7 uses top-level await, which needs an es2022 target. Every
  // browser relay-tty targets (Safari 15+, Chrome 89+) supports it.
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
