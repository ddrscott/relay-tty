import type { SessionStore } from "../server/session-store";

declare module "react-router" {
  interface AppLoadContext {
    sessionStore: SessionStore;
    version: string;
  }
}
