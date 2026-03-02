export interface Session {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  createdAt: number;
  lastActivity: number;
  status: "running" | "exited";
  exitCode?: number;
  exitedAt?: number;
  cols: number;
  rows: number;
  pid?: number;
  title?: string;
  /** ISO timestamp of session creation */
  startedAt?: string;
  /** Monotonic counter of all PTY output bytes */
  totalBytesWritten?: number;
  /** ISO timestamp of last PTY output */
  lastActiveAt?: string;
  /** Rolling average bytes/sec over last 30s window (legacy, prefer bps1) */
  bytesPerSecond?: number;
  /** 1-minute bytes/sec rolling average */
  bps1?: number;
  /** 5-minute bytes/sec rolling average */
  bps5?: number;
  /** 15-minute bytes/sec rolling average */
  bps15?: number;
}

export const WS_MSG = {
  DATA: 0x00,
  RESIZE: 0x01,
  EXIT: 0x02,
  BUFFER_REPLAY: 0x03,
  TITLE: 0x04,
  /** Server→client: OSC 9 notification text [UTF-8]. */
  NOTIFICATION: 0x05,
  /** Client→server: resume from byte offset [8B float64]. */
  RESUME: 0x10,
  /** Server→client: current total byte offset [8B float64]. */
  SYNC: 0x11,
  /** Server→client: session activity state [1B: 0x00=idle, 0x01=active]. */
  SESSION_STATE: 0x12,
  /** Server→client: gzip-compressed BUFFER_REPLAY [gzipped bytes]. */
  BUFFER_REPLAY_GZ: 0x13,
  /** Server→client: throughput metrics [bps1(f64) + bps5(f64) + bps15(f64) + totalBytes(f64)]. */
  SESSION_METRICS: 0x14,
} as const;

export interface CreateSessionRequest {
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface CreateSessionResponse {
  session: Session;
  url: string;
}

export interface SessionListResponse {
  sessions: Session[];
}
