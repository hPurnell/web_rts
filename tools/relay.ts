/**
 * A local match relay, for development and for testing multiplayer without
 * deploying anything.
 *
 * It runs exactly the same `createRelay` logic the Durable Object runs; only
 * the socket plumbing differs. Usage: `pnpm relay [port]`.
 */
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createRelay, hashString } from '../src/net/room.ts';
import type { Relay, RelaySocket } from '../src/net/room.ts';
import { decodeMessage } from '../src/net/protocol.ts';
import type { ClientMessage } from '../src/net/protocol.ts';

const port = Number(process.argv[2] ?? 8787);
const rooms = new Map<string, Relay>();

function roomFor(matchId: string): Relay {
  let relay = rooms.get(matchId);
  if (!relay) {
    relay = createRelay({ matchId, seed: hashString(matchId) });
    rooms.set(matchId, relay);
  }
  return relay;
}

const server = new WebSocketServer({ port });

server.on('connection', (socket: WebSocket, request) => {
  const matchId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('match') ?? 'default';
  const relay = roomFor(matchId);
  const wrapped: RelaySocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };

  let playerId = -1;
  socket.on('message', (raw: unknown) => {
    const text = String(raw);
    if (playerId < 0) {
      const message = decodeMessage(text);
      if (message) {
        playerId = relay.join(wrapped, message as ClientMessage);
        console.log(`[${matchId}] player ${playerId} joined (${relay.members().length} in room)`);
      }
      return;
    }
    relay.receive(playerId, text);
  });

  const drop = (): void => {
    if (playerId < 0) return;
    relay.leave(playerId);
    console.log(`[${matchId}] player ${playerId} left`);
    playerId = -1;
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

console.log(`relay listening on ws://localhost:${port}`);
