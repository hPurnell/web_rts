/**
 * WebSocket transport for the lockstep client.
 *
 * Plain `postMessage`-style framing over a socket: one JSON message per frame.
 * No SharedArrayBuffer and no binary framing, because neither buys anything
 * here — a turn is a handful of small objects and the whole point of lockstep
 * is that the traffic does not grow with the size of the game.
 */
import type { LockstepTransport } from './lockstep.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';
import { PROTOCOL_VERSION, decodeMessage, encodeMessage } from './protocol.ts';

export interface ConnectOptions {
  readonly url: string;
  readonly matchId: string;
  readonly mapHash: number;
  onOpen?(): void;
  onClose?(reason: string): void;
}

export interface Connection extends LockstepTransport {
  /** Resolves with the assigned player id once the relay welcomes us. */
  readonly welcome: Promise<{ playerId: number }>;
  /** Resolves when the relay says the match is starting. */
  readonly start: Promise<{ seed: number; playerCount: number; players: number[] }>;
  readonly connected: () => boolean;
}

export function connect(options: ConnectOptions): Connection {
  const socket = new WebSocket(options.url);
  const handlers: ((message: ServerMessage) => void)[] = [];
  const queued: ClientMessage[] = [];
  let open = false;

  let resolveWelcome!: (value: { playerId: number }) => void;
  const welcome = new Promise<{ playerId: number }>((resolve) => {
    resolveWelcome = resolve;
  });
  let resolveStart!: (value: { seed: number; playerCount: number; players: number[] }) => void;
  const start = new Promise<{ seed: number; playerCount: number; players: number[] }>((resolve) => {
    resolveStart = resolve;
  });

  socket.addEventListener('open', () => {
    open = true;
    socket.send(
      encodeMessage({
        type: 'join',
        version: PROTOCOL_VERSION,
        matchId: options.matchId,
        mapHash: options.mapHash,
      }),
    );
    // Anything issued before the socket opened goes out now, in order.
    for (const message of queued.splice(0, queued.length)) {
      socket.send(encodeMessage(message));
    }
    options.onOpen?.();
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    const message = decodeMessage(typeof event.data === 'string' ? event.data : '');
    if (!message) return;
    if (message.type === 'welcome') resolveWelcome({ playerId: message.playerId });
    if (message.type === 'start') {
      resolveStart({
        seed: message.seed,
        playerCount: message.playerCount,
        players: [...message.players],
      });
    }
    for (const handler of handlers) handler(message as ServerMessage);
  });

  socket.addEventListener('close', () => {
    open = false;
    options.onClose?.('connection closed');
  });
  socket.addEventListener('error', () => {
    options.onClose?.('connection error');
  });

  return {
    welcome,
    start,
    connected: () => open,
    send(message) {
      if (!open) {
        queued.push(message);
        return;
      }
      socket.send(encodeMessage(message));
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      handlers.length = 0;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}
