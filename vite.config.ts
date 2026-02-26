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
  ssr: {
    external: ["node-pty"],
  },
});
