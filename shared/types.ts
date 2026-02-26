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
}

export const WS_MSG = {
  DATA: 0x00,
  RESIZE: 0x01,
  EXIT: 0x02,
  BUFFER_REPLAY: 0x03,
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
