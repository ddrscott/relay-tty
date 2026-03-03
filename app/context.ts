import type { SessionStore } from "../server/session-store";

declare module "react-router" {
  interface AppLoadContext {
    sessionStore: SessionStore;
    version: string;
    hostname: string;
    /** Generate a long-lived auth token (no expiry). Used by auth callback to swap short-lived tokens. */
    generateToken: () => string | null;
  }
}
