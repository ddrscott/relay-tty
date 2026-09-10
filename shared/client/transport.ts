/**
 * A Transport moves whole frames (`[type byte][payload]`) between a client
 * and a pty-host, hiding whether the wire is a length-prefixed Unix socket
 * or raw WebSocket binary messages. SessionStream owns everything above
 * this line; transports own nothing but bytes and connection lifecycle.
 */
export interface Transport {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (info: { code?: number; reason?: string }) => void): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Creates a transport and starts connecting immediately. */
export type TransportFactory = () => Transport;
