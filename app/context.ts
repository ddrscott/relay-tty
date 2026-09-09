import type { SessionStore } from "../server/session-store";
import type { DesktopDisplay } from "../server/desktop";

declare module "react-router" {
  interface AppLoadContext {
    sessionStore: SessionStore;
    version: string;
    hostname: string;
    readCustomCommands?: () => string[];
    /** Cached probe of the loopback VNC port (macOS Screen Sharing). */
    desktopAvailable?: () => Promise<boolean>;
    /** Physical displays of the host in framebuffer coordinates, for the desktop picker. */
    desktopDisplays?: () => Promise<DesktopDisplay[]>;
  }
}
