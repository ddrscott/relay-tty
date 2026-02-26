import express from "express";
import compression from "compression";
import morgan from "morgan";
import { SessionStore } from "./session-store.js";

export const sessionStore = new SessionStore();

export function createApp() {
  const app = express();

  app.use(compression());
  app.use(morgan("short"));
  app.use(express.json());

  return app;
}
