import { createContext, type RouterContext } from "react-router";
import type { SessionStore } from "../server/session-store";
import type { DesktopDisplay } from "../server/desktop";

/** Server-side values that server.js hands to every loader through `getLoadContext`. */
export interface AppContext {
  sessionStore: SessionStore;
  version: string;
  hostname: string;
  readCustomCommands?: () => string[];
  /** Cached probe of the loopback VNC port (macOS Screen Sharing). */
  desktopAvailable?: () => Promise<boolean>;
  /** Physical displays of the host in framebuffer coordinates, for the desktop picker. */
  desktopDisplays?: () => Promise<DesktopDisplay[]>;
}

// React Router 8 looks context values up by the identity of this key object.
// server.js is plain JS that runs outside the Vite bundle, so it cannot import
// this module and share its instance. Both sides therefore fetch the key from
// the global symbol registry under the same name (see appContextKey in server.js).
const registryKey = Symbol.for("relay-tty.appContext");
const registry = globalThis as { [registryKey]?: RouterContext<AppContext> };

export const appContext: RouterContext<AppContext> =
  (registry[registryKey] ??= createContext<AppContext>());
