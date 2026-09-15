/**
 * The Cloudflare Worker entry point.
 *
 * Routes every connection for a match id to the one Durable Object that owns
 * that room. There is no matchmaking beyond "the id in the URL is the room",
 * which is enough to send someone a link and play them; a lobby that lists
 * open games would be a second Durable Object and is not built yet.
 */
import { MatchRoom } from './room.ts';

export { MatchRoom };

interface DurableObjectNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };
}

export interface Env {
  readonly MATCH_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const matchId = url.searchParams.get('match') ?? 'default';
    // One object per match id, so two clients using the same link land in the
    // same room wherever in the world they connect from.
    const room = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(matchId));
    return room.fetch(request);
  },
};
