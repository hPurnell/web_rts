/**
 * The lockstep wire protocol.
 *
 * Only commands and hashes cross the wire — never state. That is what makes
 * the bandwidth independent of army size: a hundred units moving is one move
 * command, not a hundred position updates.
 */
import type { SimCommand } from '../sim/commands.ts';

export const PROTOCOL_VERSION = 1;

/**
 * Turns of input delay.
 *
 * A command issued on tick N executes on tick N + 2, which at 20Hz gives every
 * client 100ms to hear about it. Less and a player on a slow link stalls
 * everyone; more and the game feels sluggish to click.
 */
export const INPUT_DELAY_TURNS = 2;

/** Ticks between exchanged state hashes. */
export const HASH_INTERVAL = 100;

// --- client to server -------------------------------------------------------

export interface JoinMessage {
  readonly type: 'join';
  readonly version: number;
  readonly matchId: string;
  /** Map the client intends to play, so a mismatch is caught before starting. */
  readonly mapHash: number;
}

export interface TurnMessage {
  readonly type: 'turn';
  readonly tick: number;
  readonly playerId: number;
  readonly commands: readonly SimCommand[];
}

export interface HashMessage {
  readonly type: 'hash';
  readonly tick: number;
  readonly playerId: number;
  readonly hash: number;
}

export type ClientMessage = JoinMessage | TurnMessage | HashMessage;

// --- server to client -------------------------------------------------------

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly playerId: number;
  readonly matchId: string;
}

export interface StartMessage {
  readonly type: 'start';
  readonly seed: number;
  readonly playerCount: number;
  /** Player ids in the match, in a fixed order every client agrees on. */
  readonly players: readonly number[];
}

export interface LeaveMessage {
  readonly type: 'leave';
  readonly playerId: number;
}

export interface HaltMessage {
  readonly type: 'halt';
  readonly reason: string;
  readonly tick: number;
}

export type ServerMessage =
  | WelcomeMessage
  | StartMessage
  | TurnMessage
  | HashMessage
  | LeaveMessage
  | HaltMessage;

export type NetMessage = ClientMessage | ServerMessage;

export function encodeMessage(message: NetMessage): string {
  return JSON.stringify(message);
}

export function decodeMessage(text: string): NetMessage | null {
  try {
    const parsed = JSON.parse(text) as NetMessage;
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    // A peer that sends junk is ignored, not fatal: the match goes on.
    return null;
  }
}
