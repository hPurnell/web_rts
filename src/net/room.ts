/**
 * The match relay, as a Cloudflare Durable Object.
 *
 * It is deliberately almost nothing: it assigns player ids, starts the match
 * when the room is full, and forwards every turn and hash to the other
 * clients. It never simulates anything and never inspects a command.
 *
 * That is the point of lockstep. The server cannot be authoritative about game
 * state because it does not have any, which means it cannot be a bottleneck,
 * cannot desync, and costs the same whether the players have ten units or a
 * thousand.
 */
import type { ClientMessage, ServerMessage } from './protocol.ts';
import { PROTOCOL_VERSION, decodeMessage, encodeMessage } from './protocol.ts';

export const DEFAULT_PLAYER_COUNT = 2;

/** The bits of a WebSocket this relay uses, so it can be driven from a test. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
}

interface Member {
  readonly socket: RelaySocket;
  readonly playerId: number;
  mapHash: number;
}

export interface Relay {
  /** Attach a socket. Returns the assigned player id, or -1 if the room is full. */
  join(socket: RelaySocket, message: ClientMessage): number;
  /** Handle a message from a member. */
  receive(playerId: number, raw: string): void;
  /** Detach a socket, telling everyone else. */
  leave(playerId: number): void;
  members(): number[];
  started(): boolean;
}

export interface RelayInit {
  readonly matchId: string;
  readonly playerCount?: number;
  /** Seed for the match. Chosen by the relay so every client agrees. */
  readonly seed: number;
}

export function createRelay(init: RelayInit): Relay {
  const playerCount = init.playerCount ?? DEFAULT_PLAYER_COUNT;
  const members = new Map<number, Member>();
  let nextPlayerId = 0;
  let started = false;

  const broadcast = (message: ServerMessage, except = -1): void => {
    const text = encodeMessage(message);
    for (const [id, member] of members) {
      if (id === except) continue;
      member.socket.send(text);
    }
  };

  return {
    members: () => [...members.keys()],
    started: () => started,

    join(socket, message) {
      if (message.type !== 'join') return -1;
      if (message.version !== PROTOCOL_VERSION) {
        socket.send(
          encodeMessage({
            type: 'halt',
            reason: `protocol version ${message.version} is not ${PROTOCOL_VERSION}`,
            tick: 0,
          }),
        );
        socket.close();
        return -1;
      }
      if (members.size >= playerCount || started) return -1;

      const playerId = nextPlayerId++;
      members.set(playerId, { socket, playerId, mapHash: message.mapHash });
      socket.send(encodeMessage({ type: 'welcome', playerId, matchId: init.matchId }));

      if (members.size < playerCount) return playerId;

      // Everyone is here. Refuse to start if they disagree about the map: the
      // match would desync on the first tick and look like a bug in the
      // simulation.
      const hashes = new Set([...members.values()].map((member) => member.mapHash));
      if (hashes.size > 1) {
        broadcast({ type: 'halt', reason: 'players are on different maps', tick: 0 });
        return playerId;
      }

      started = true;
      broadcast({
        type: 'start',
        seed: init.seed,
        playerCount,
        players: [...members.keys()].sort((a, b) => a - b),
      });
      return playerId;
    },

    receive(playerId, raw) {
      const message = decodeMessage(raw);
      if (!message) return;
      // Turns and hashes are relayed verbatim to everyone else. The relay
      // stamps the sender itself rather than trusting the field, so a client
      // cannot submit turns on someone else's behalf.
      if (message.type === 'turn') {
        broadcast({ ...message, playerId }, playerId);
        return;
      }
      if (message.type === 'hash') {
        broadcast({ ...message, playerId }, playerId);
      }
    },

    leave(playerId) {
      if (!members.delete(playerId)) return;
      broadcast({ type: 'leave', playerId });
    },
  };
}

/**
 * The Durable Object itself.
 *
 * Kept to the thinnest possible shell around `createRelay`, so the logic worth
 * testing runs anywhere and only the Cloudflare-specific plumbing lives here.
 */
export interface DurableObjectState {
  readonly id: { toString(): string };
}

interface WebSocketPairLike {
  0: RelaySocket & { accept?(): void };
  1: unknown;
}

declare const WebSocketPair: { new (): WebSocketPairLike };

export class MatchRoom {
  private readonly relay: Relay;

  constructor(state: DurableObjectState) {
    this.relay = createRelay({
      matchId: state.id.toString(),
      // Derived from the room id so every client in this room agrees, without
      // the relay needing to store anything.
      seed: hashString(state.id.toString()),
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const server = pair[0];
    server.accept?.();

    let playerId = -1;
    const socket = server as unknown as RelaySocket & {
      addEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
    };

    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (playerId < 0) {
        const message = decodeMessage(raw);
        if (message) playerId = this.relay.join(server, message as ClientMessage);
        return;
      }
      this.relay.receive(playerId, raw);
    });

    const drop = (): void => {
      if (playerId >= 0) this.relay.leave(playerId);
    };
    socket.addEventListener('close', drop);
    socket.addEventListener('error', drop);

    return new Response(null, { status: 101, webSocket: pair[1] } as ResponseInit);
  }
}

/** FNV-1a over a string, for deriving a match seed from a room id. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
