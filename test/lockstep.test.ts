import { describe, expect, it, vi } from 'vitest';
import { createLockstep } from '../src/net/lockstep.ts';
import type { LockstepTransport } from '../src/net/lockstep.ts';
import { createRelay } from '../src/net/room.ts';
import type { RelaySocket } from '../src/net/room.ts';
import {
  HASH_INTERVAL,
  INPUT_DELAY_TURNS,
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
} from '../src/net/protocol.ts';
import type { ClientMessage, ServerMessage } from '../src/net/protocol.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { CommandKind } from '../src/sim/commands.ts';
import type { SimCommand } from '../src/sim/commands.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';

/**
 * Two clients wired to a real relay, with a controllable delivery queue.
 *
 * Messages sit in the queue until `flush` is called, so a test can hold a
 * client's turn back and watch the other refuse to run ahead of it.
 */
function network(playerCount = 2) {
  const world = createTestMap();
  const relay = createRelay({ matchId: 'test', seed: 0xabcdef, playerCount });
  const queue: (() => void)[] = [];
  const clients: {
    playerId: number;
    transport: LockstepTransport;
    handlers: ((message: ServerMessage) => void)[];
  }[] = [];

  const connect = (): (typeof clients)[number] => {
    const handlers: ((message: ServerMessage) => void)[] = [];
    const client = { playerId: -1, transport: null as unknown as LockstepTransport, handlers };

    const socket: RelaySocket = {
      send: (data) => {
        const message = decodeMessage(data) as ServerMessage | null;
        if (!message) return;
        queue.push(() => {
          for (const handler of handlers) handler(message);
        });
      },
      close: () => {},
    };

    client.transport = {
      send: (message: ClientMessage) => {
        queue.push(() => relay.receive(client.playerId, encodeMessage(message)));
      },
      onMessage: (handler) => handlers.push(handler),
      close: () => {},
    };

    handlers.push((message) => {
      if (message.type === 'welcome') client.playerId = message.playerId;
    });
    client.playerId = relay.join(socket, {
      type: 'join',
      version: PROTOCOL_VERSION,
      matchId: 'test',
      mapHash: w.hashWorld(world),
    });
    clients.push(client);
    return client;
  };

  const flush = (): void => {
    // Drain repeatedly: delivering a message can enqueue replies.
    for (let guard = 0; guard < 10_000 && queue.length > 0; guard++) {
      (queue.shift() as () => void)();
    }
  };

  return { world, relay, clients, connect, flush, pending: () => queue.length };
}

function makeMatch(world: w.World, seed: number) {
  return createMatchFromWorld({
    world,
    seed,
    playerCount: 2,
    startingWorkers: 2,
    costGrid: createCostGrid(world),
  });
}

describe('the relay', () => {
  it('assigns player ids and starts when the room is full', () => {
    const net = network();
    const a = net.connect();
    expect(a.playerId).toBe(0);
    expect(net.relay.started()).toBe(false);

    const b = net.connect();
    expect(b.playerId).toBe(1);
    expect(net.relay.started()).toBe(true);
  });

  it('turns away extra players', () => {
    const net = network();
    net.connect();
    net.connect();
    expect(net.connect().playerId).toBe(-1);
  });

  it('refuses a protocol version it does not speak', () => {
    const relay = createRelay({ matchId: 'x', seed: 1 });
    const sent: string[] = [];
    const socket: RelaySocket = { send: (data) => sent.push(data), close: () => {} };
    const id = relay.join(socket, {
      type: 'join',
      version: PROTOCOL_VERSION + 5,
      matchId: 'x',
      mapHash: 0,
    });
    expect(id).toBe(-1);
    expect(sent.join()).toContain('protocol version');
  });

  it('refuses to start players who are on different maps', () => {
    // Starting them would desync on the first tick and look like a simulation
    // bug rather than a lobby mistake.
    const relay = createRelay({ matchId: 'x', seed: 1 });
    const messages: string[] = [];
    const socket = (): RelaySocket => ({ send: (data) => messages.push(data), close: () => {} });
    relay.join(socket(), { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 1 });
    relay.join(socket(), { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 2 });
    expect(relay.started()).toBe(false);
    expect(messages.join()).toContain('different maps');
  });

  it('stamps the sender rather than trusting the message', () => {
    // Otherwise a client could submit turns on someone else's behalf.
    const relay = createRelay({ matchId: 'x', seed: 1 });
    const seen: string[] = [];
    relay.join({ send: () => {}, close: () => {} }, { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 0 });
    relay.join({ send: (d) => seen.push(d), close: () => {} }, { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 0 });

    relay.receive(0, encodeMessage({ type: 'turn', tick: 5, playerId: 99, commands: [] }));
    const relayed = seen.map((d) => decodeMessage(d)).find((m) => m?.type === 'turn');
    expect(relayed && 'playerId' in relayed && relayed.playerId).toBe(0);
  });

  it('tells everyone when a player leaves', () => {
    const relay = createRelay({ matchId: 'x', seed: 1 });
    const seen: string[] = [];
    relay.join({ send: () => {}, close: () => {} }, { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 0 });
    relay.join({ send: (d) => seen.push(d), close: () => {} }, { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 0 });
    relay.leave(0);
    expect(seen.map((d) => decodeMessage(d)).some((m) => m?.type === 'leave')).toBe(true);
    expect(relay.members()).toEqual([1]);
  });
});

describe('lockstep turn scheduling', () => {
  function pair() {
    const net = network();
    const a = net.connect();
    const b = net.connect();
    net.flush();

    const worlds = [net.world, net.world];
    const matches = [makeMatch(worlds[0]!, 0xabcdef), makeMatch(worlds[1]!, 0xabcdef)];
    const steps = [
      createLockstep({ transport: a.transport, playerId: 0, players: [0, 1] }),
      createLockstep({ transport: b.transport, playerId: 1, players: [0, 1] }),
    ];
    net.flush();

    const advance = (maxTicks: number): void => {
      for (let i = 0; i < maxTicks; i++) {
        for (const [index, lockstep] of steps.entries()) {
          lockstep.step(matches[index]!, 1, (commands) =>
            stepMatch(matches[index]!, commands, { world: worlds[index]! }),
          );
        }
        net.flush();
      }
    };

    return { net, steps, matches, worlds, advance };
  }

  it('keeps two clients bit-identical through a match', () => {
    const { steps, matches, advance } = pair();

    // Both players issue commands as they go.
    for (let round = 0; round < 40; round++) {
      steps[0]?.issue({ kind: CommandKind.GrantResources, player: 0, minerals: round, gas: 0 });
      if (round % 3 === 0) {
        steps[1]?.issue({ kind: CommandKind.GrantResources, player: 1, minerals: 5, gas: 1 });
      }
      advance(10);
    }

    expect(matches[0]?.tick).toBe(matches[1]?.tick);
    expect(matches[0]!.tick).toBeGreaterThan(300);
    expect(hashMatch(matches[0]!)).toBe(hashMatch(matches[1]!));
    expect(steps[0]?.halted()).toBeNull();
    expect(steps[1]?.halted()).toBeNull();
  });

  it('applies commands in player order, not arrival order', () => {
    // Two clients whose messages arrive in different orders must still apply
    // the same commands in the same sequence.
    const { steps, matches, advance } = pair();
    steps[1]?.issue({ kind: CommandKind.GrantResources, player: 1, minerals: 100, gas: 0 });
    steps[0]?.issue({ kind: CommandKind.GrantResources, player: 0, minerals: 100, gas: 0 });
    advance(20);
    expect(hashMatch(matches[0]!)).toBe(hashMatch(matches[1]!));
  });

  it('refuses to run ahead of a player whose turn has not arrived', () => {
    const net = network();
    const a = net.connect();
    const b = net.connect();
    net.flush();

    const match = makeMatch(net.world, 0xabcdef);
    const lockstep = createLockstep({ transport: a.transport, playerId: 0, players: [0, 1] });
    net.flush();

    // Player 1 never sends anything: player 0 runs the pre-filled delay ticks
    // and then stops dead rather than guessing.
    const ran = lockstep.step(match, 100, (commands) =>
      stepMatch(match, commands, { world: net.world }),
    );
    expect(ran).toBeLessThanOrEqual(INPUT_DELAY_TURNS);
    expect(lockstep.stalled()).toBe(true);
    expect(lockstep.waitingFor()).toEqual([1]);
    void b;
  });

  it('carries on when a player drops, instead of hanging', () => {
    const net = network();
    const a = net.connect();
    net.connect();
    net.flush();

    const match = makeMatch(net.world, 0xabcdef);
    const lockstep = createLockstep({ transport: a.transport, playerId: 0, players: [0, 1] });
    net.flush();
    lockstep.step(match, 100, (commands) => stepMatch(match, commands, { world: net.world }));
    expect(lockstep.stalled()).toBe(true);

    net.relay.leave(1);
    net.flush();

    expect(lockstep.stalled()).toBe(false);
    expect(lockstep.players()).toEqual([0]);
    const ran = lockstep.step(match, 50, (commands) =>
      stepMatch(match, commands, { world: net.world }),
    );
    expect(ran).toBe(50);
    expect(lockstep.halted()).toBeNull();
  });
});

describe('desync detection', () => {
  it('catches a client whose simulation diverged, and halts', () => {
    const net = network();
    const a = net.connect();
    const b = net.connect();
    net.flush();

    const worlds = [net.world, net.world];
    const matches = [makeMatch(worlds[0]!, 0xabcdef), makeMatch(worlds[1]!, 0xabcdef)];
    const steps = [
      createLockstep({ transport: a.transport, playerId: 0, players: [0, 1] }),
      createLockstep({ transport: b.transport, playerId: 1, players: [0, 1] }),
    ];
    net.flush();

    const advance = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        for (const [index, lockstep] of steps.entries()) {
          lockstep.step(matches[index]!, 1, (commands) =>
            stepMatch(matches[index]!, commands, { world: worlds[index]! }),
          );
        }
        net.flush();
      }
    };

    // Stand in for a float creeping into a simulation path on one client only:
    // one unit's position differs by a single ULP.
    advance(20);
    matches[1]!.minerals[0] = (matches[1]!.minerals[0] as number) + 1;

    advance(HASH_INTERVAL + 20);

    const desync = steps[0]?.desync() ?? steps[1]?.desync();
    expect(desync).not.toBeNull();
    expect(desync?.tick).toBe(HASH_INTERVAL);
    expect(desync?.localHash).not.toBe(desync?.remoteHash);
    // And the match stops rather than continuing as two different games.
    expect(steps[0]?.halted() ?? steps[1]?.halted()).toMatch(/desync at tick 100/);
  });

  it('exchanges hashes on the interval and agrees when nothing is wrong', () => {
    const net = network();
    const a = net.connect();
    const b = net.connect();
    net.flush();

    const matches = [makeMatch(net.world, 0xabcdef), makeMatch(net.world, 0xabcdef)];
    const steps = [
      createLockstep({ transport: a.transport, playerId: 0, players: [0, 1] }),
      createLockstep({ transport: b.transport, playerId: 1, players: [0, 1] }),
    ];
    net.flush();

    for (let i = 0; i < HASH_INTERVAL * 2 + 10; i++) {
      for (const [index, lockstep] of steps.entries()) {
        lockstep.step(matches[index]!, 1, (commands) =>
          stepMatch(matches[index]!, commands, { world: net.world }),
        );
      }
      net.flush();
    }

    expect(matches[0]?.tick).toBeGreaterThan(HASH_INTERVAL * 2);
    expect(steps[0]?.desync()).toBeNull();
    expect(steps[1]?.desync()).toBeNull();
  });
});

describe('the wire format', () => {
  it('round-trips messages and ignores junk', () => {
    const message: SimCommand = { kind: CommandKind.GrantResources, player: 0, minerals: 5, gas: 1 };
    const encoded = encodeMessage({ type: 'turn', tick: 7, playerId: 1, commands: [message] });
    const decoded = decodeMessage(encoded);
    expect(decoded?.type).toBe('turn');
    expect(decodeMessage('}{')).toBeNull();
    expect(decodeMessage('12')).toBeNull();
  });

  it('closes over a dropped socket without throwing', () => {
    const relay = createRelay({ matchId: 'x', seed: 1 });
    const close = vi.fn();
    relay.join({ send: () => {}, close }, { type: 'join', version: PROTOCOL_VERSION, matchId: 'x', mapHash: 0 });
    expect(() => relay.leave(0)).not.toThrow();
    expect(() => relay.leave(0)).not.toThrow(); // twice is fine
  });
});

describe('the M31 acceptance criteria, stated directly', () => {
  /** Two clients on one relay, driven tick by tick. */
  function duel() {
    const net = network();
    const a = net.connect();
    const b = net.connect();
    net.flush();

    const worlds = [net.world, net.world];
    const matches = [makeMatch(worlds[0]!, 0xabcdef), makeMatch(worlds[1]!, 0xabcdef)];
    const steps = [
      createLockstep({ transport: a.transport, playerId: 0, players: [0, 1] }),
      createLockstep({ transport: b.transport, playerId: 1, players: [0, 1] }),
    ];
    net.flush();

    const advance = (ticks: number, corrupt?: (tick: number) => void): void => {
      for (let i = 0; i < ticks; i++) {
        for (const [index, lockstep] of steps.entries()) {
          lockstep.step(matches[index]!, 1, (commands) => {
            stepMatch(matches[index]!, commands, { world: worlds[index]! });
            if (index === 1) corrupt?.(matches[1]!.tick);
          });
        }
        net.flush();
      }
    };

    return { net, steps, matches, advance };
  }

  it('a float in a simulation path is caught by hash comparison', () => {
    // The real failure mode: one client computes a position with a float and
    // lands a fraction of a unit away. Nothing looks wrong locally; the hash
    // is the only thing that notices.
    const { steps, matches, advance } = duel();
    let drifted = false;
    advance(HASH_INTERVAL + 40, (tick) => {
      if (tick !== 37 || drifted) return;
      const before = matches[1]!.units.posX[0] as number;
      // A factor small enough to be invisible on screen -- a hundred-thousandth
      // of a cell -- but large enough to actually move the fixed-point value.
      // A gentler factor rounds back to the same integer, and the test would
      // then be asserting that nothing was caught.
      const after = Math.round(before * 1.00001);
      expect(after, 'the drift must actually change the value').not.toBe(before);
      matches[1]!.units.posX[0] = after;
      drifted = true;
    });
    expect(drifted).toBe(true);

    const desync = steps[0]?.desync() ?? steps[1]?.desync();
    expect(desync, 'the drift should have been caught').not.toBeNull();
    expect(desync?.tick).toBe(HASH_INTERVAL);
    expect(steps[0]?.halted() ?? steps[1]?.halted()).toMatch(/desync/);
  });

  it('a dropped connection does not hang the other client', () => {
    const { net, steps, matches, advance } = duel();
    advance(30);
    expect(matches[0]!.tick).toBeGreaterThan(20);

    // Player 1 vanishes mid-match.
    net.relay.leave(1);
    net.flush();

    const before = matches[0]!.tick;
    for (let i = 0; i < 60; i++) {
      steps[0]?.step(matches[0]!, 1, (commands) =>
        stepMatch(matches[0]!, commands, { world: net.world }),
      );
      net.flush();
    }
    expect(matches[0]!.tick).toBe(before + 60);
    expect(steps[0]?.stalled()).toBe(false);
    expect(steps[0]?.halted()).toBeNull();
  });

  it('plays a match to completion with both sides issuing orders', () => {
    const { steps, matches, advance } = duel();
    for (let round = 0; round < 30; round++) {
      steps[round % 2]?.issue({
        kind: CommandKind.GrantResources,
        player: round % 2,
        minerals: round,
        gas: round % 3,
      });
      advance(20);
    }
    expect(matches[0]!.tick).toBe(matches[1]!.tick);
    expect(matches[0]!.tick).toBeGreaterThan(500);
    expect(hashMatch(matches[0]!)).toBe(hashMatch(matches[1]!));
    expect(steps[0]?.desync()).toBeNull();
  });
});
