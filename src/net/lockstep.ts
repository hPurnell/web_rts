/**
 * The lockstep turn scheduler.
 *
 * The rule is simple and absolute: a tick may not run until every player's
 * commands for that tick have arrived. That is what keeps simulations
 * identical — not trust, not reconciliation, just refusing to guess.
 *
 * Everything here is transport-agnostic so it can be driven at full speed in a
 * test, with latency and disconnections simulated exactly.
 */
import type { SimCommand } from '../sim/commands.ts';
import type { Match } from '../sim/match.ts';
import { hashMatch } from '../sim/statehash.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';
import { HASH_INTERVAL, INPUT_DELAY_TURNS } from './protocol.ts';

export interface LockstepTransport {
  send(message: ClientMessage): void;
  onMessage(handler: (message: ServerMessage) => void): void;
  close(): void;
}

export interface DesyncReport {
  readonly tick: number;
  readonly localHash: number;
  readonly remoteHash: number;
  readonly playerId: number;
}

export interface Lockstep {
  readonly playerId: number;
  /** Players whose commands are still required each turn. */
  players(): readonly number[];
  /** Queue a command to run after the input delay. */
  issue(command: SimCommand): void;
  /**
   * Step as far as the arrived commands allow, up to `maxTicks`.
   * Returns how many ticks ran.
   */
  step(match: Match, maxTicks: number, run: (commands: readonly SimCommand[]) => void): number;
  /** True when the next tick is waiting on somebody. */
  stalled(): boolean;
  /** Players whose commands the next tick is still missing. */
  waitingFor(): readonly number[];
  /** The desync that halted the match, or null. */
  desync(): DesyncReport | null;
  /** Why the match halted, or null. */
  halted(): string | null;
  dispose(): void;
}

export interface LockstepInit {
  readonly transport: LockstepTransport;
  readonly playerId: number;
  readonly players: readonly number[];
  /** Ticks of input delay. Exposed for tests. */
  readonly inputDelay?: number;
}

export function createLockstep(init: LockstepInit): Lockstep {
  const { transport, playerId } = init;
  const inputDelay = init.inputDelay ?? INPUT_DELAY_TURNS;

  let players = [...init.players];
  /** tick -> playerId -> commands. */
  const arrived = new Map<number, Map<number, SimCommand[]>>();
  /** Hashes peers reported, by tick and player. */
  const peerHashes = new Map<number, Map<number, number>>();
  const localHashes = new Map<number, number>();

  let pending: SimCommand[] = [];
  /** The next tick this client has already submitted for. */
  let submittedThrough = -1;
  let desyncReport: DesyncReport | null = null;
  let haltReason: string | null = null;
  /** The tick step() last refused to run, or null when it is keeping up. */
  let waitingOnTick: number | null = null;

  const bucket = (tick: number): Map<number, SimCommand[]> => {
    let byPlayer = arrived.get(tick);
    if (!byPlayer) {
      byPlayer = new Map();
      arrived.set(tick, byPlayer);
    }
    return byPlayer;
  };

  transport.onMessage((message) => {
    switch (message.type) {
      case 'turn':
        bucket(message.tick).set(message.playerId, [...message.commands]);
        return;
      case 'hash': {
        let byPlayer = peerHashes.get(message.tick);
        if (!byPlayer) {
          byPlayer = new Map();
          peerHashes.set(message.tick, byPlayer);
        }
        byPlayer.set(message.playerId, message.hash);
        compareHashes(message.tick);
        return;
      }
      case 'leave':
        // A player who has gone can never send another turn, so waiting for
        // them would hang everyone else forever. Drop them and carry on; the
        // tick we were stalled on may now be runnable.
        players = players.filter((id) => id !== message.playerId);
        if (waitingOnTick !== null && ready(waitingOnTick)) waitingOnTick = null;
        return;
      case 'halt':
        haltReason = message.reason;
        return;
      default:
        return;
    }
  });

  function compareHashes(tick: number): void {
    const mine = localHashes.get(tick);
    const theirs = peerHashes.get(tick);
    if (mine === undefined || !theirs) return;
    for (const [peer, hash] of theirs) {
      if (hash === mine) continue;
      if (desyncReport) return;
      // Halting is the right response: past this point the two games have
      // diverged, and continuing produces two different matches that both
      // look fine locally.
      desyncReport = { tick, localHash: mine, remoteHash: hash, playerId: peer };
      haltReason = `desync at tick ${tick} against player ${peer}`;
      return;
    }
  }

  /** Submit this client's commands for every tick up to `throughTick`. */
  function submit(throughTick: number): void {
    while (submittedThrough < throughTick) {
      submittedThrough++;
      const commands = submittedThrough === throughTick ? pending : [];
      if (submittedThrough === throughTick) pending = [];
      transport.send({
        type: 'turn',
        tick: submittedThrough,
        playerId,
        commands,
      });
      // A client also needs its own commands: the server relays to others.
      bucket(submittedThrough).set(playerId, [...commands]);
    }
  }

  // The first few ticks have no input behind them, so they are submitted up
  // front — otherwise every client waits for commands nobody could have sent.
  submit(inputDelay - 1);

  const ready = (tick: number): boolean => {
    const byPlayer = arrived.get(tick);
    if (!byPlayer) return false;
    return players.every((id) => byPlayer.has(id));
  };

  const lockstep: Lockstep = {
    playerId,
    players: () => players,

    issue(command) {
      pending.push(command);
    },

    step(match, maxTicks, run) {
      if (haltReason) return 0;
      let stepped = 0;

      while (stepped < maxTicks) {
        const tick = match.tick;
        // Always keep the pipeline `inputDelay` turns ahead of the simulation.
        submit(tick + inputDelay);
        if (!ready(tick)) {
          waitingOnTick = tick;
          break;
        }
        waitingOnTick = null;

        const byPlayer = arrived.get(tick);
        // Ordered by player id, not by arrival: two clients must apply the
        // same commands in the same order or they diverge immediately.
        const commands: SimCommand[] = [];
        for (const id of [...players].sort((a, b) => a - b)) {
          for (const command of byPlayer?.get(id) ?? []) commands.push(command);
        }

        run(commands);
        arrived.delete(tick);
        stepped++;

        if (match.tick % HASH_INTERVAL === 0) {
          const hash = hashMatch(match);
          localHashes.set(match.tick, hash);
          transport.send({ type: 'hash', tick: match.tick, playerId, hash });
          compareHashes(match.tick);
          if (haltReason) break;
        }
      }
      return stepped;
    },

    stalled: () => haltReason === null && waitingOnTick !== null,

    waitingFor() {
      if (waitingOnTick === null) return [];
      const byPlayer = arrived.get(waitingOnTick);
      return players.filter((id) => !byPlayer?.has(id));
    },

    desync: () => desyncReport,
    halted: () => haltReason,

    dispose() {
      arrived.clear();
      peerHashes.clear();
      localHashes.clear();
      transport.close();
    },
  };

  return lockstep;
}
