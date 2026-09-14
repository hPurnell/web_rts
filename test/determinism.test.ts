import { describe, expect, it } from 'vitest';
import golden from './golden/sim.json' with { type: 'json' };
import {
  SCRIPT,
  SCRIPT_PLAYERS,
  SCRIPT_SEED,
  SCRIPT_TICKS,
  runScript,
  runScriptCheckpoints,
  runScriptHash,
} from './determinism.ts';
import { createMatch } from '../src/sim/match.ts';
import { diffComponents, hashComponents, hashMatch } from '../src/sim/statehash.ts';
import { CommandKind } from '../src/sim/commands.ts';
import { stepMatch } from '../src/sim/tick.ts';

describe('determinism harness', () => {
  it('the golden file describes the script that is actually committed', () => {
    // Guards against regenerating the hash while forgetting the script changed.
    expect(golden.seed).toBe(SCRIPT_SEED);
    expect(golden.players).toBe(SCRIPT_PLAYERS);
    expect(golden.ticks).toBe(SCRIPT_TICKS);
    expect(golden.commands).toBe(SCRIPT.length);
  });

  it('reaches the committed golden hash', () => {
    expect(runScriptHash()).toBe(golden.finalHash);
  });

  it('matches every committed checkpoint', () => {
    expect(runScriptCheckpoints(100)).toEqual(golden.checkpoints);
  });

  it('is reproducible run to run', () => {
    expect(runScriptHash()).toBe(runScriptHash());
  });

  it('is sensitive to the seed', () => {
    expect(runScriptHash({ seed: SCRIPT_SEED + 1 })).not.toBe(golden.finalHash);
  });

  it('is sensitive to when a command lands', () => {
    // Resource grants commute, so reordering two additions is genuinely a
    // no-op. What does not commute is the clamp at zero: moving the large
    // withdrawal before the deposit it would have consumed changes the result.
    const moved = SCRIPT.map((s) =>
      s.command.kind === CommandKind.GrantResources && s.command.minerals === -1000
        ? { ...s, tick: 30 }
        : s,
    );
    expect(runScriptHash({ script: moved })).not.toBe(golden.finalHash);
  });

  it('carries the unit store, with casualties', () => {
    const match = runScript();
    expect(match.units.count).toBeGreaterThan(0);
    // Since M24 the two armies meet and fight, so the survivors are fewer than
    // the units spawned. Slots are freed and reused, so count exceeds alive.
    expect(match.units.alive).toBeGreaterThan(0);
    expect(match.units.count).toBeGreaterThan(match.units.alive);
  });

  it('carries projectiles', () => {
    const names = runScript();
    expect(names.projectiles.count).toBeGreaterThanOrEqual(0);
    expect(hashComponents(names).has('shot.posX')).toBe(true);
  });

  it('notices a single unit position differing by one ULP', () => {
    const a = runScript();
    const b = runScript();
    expect(hashMatch(a)).toBe(hashMatch(b));
    b.units.posX[3] = (b.units.posX[3] as number) + 1;
    expect(hashMatch(b)).not.toBe(hashMatch(a));
    expect(diffComponents(a, b)).toEqual(['unit.posX']);
  });

  it('reports which component diverged', () => {
    const a = runScript();
    const b = runScript();
    expect(diffComponents(a, b)).toEqual([]);
    b.minerals[0] = (b.minerals[0] as number) + 1;
    expect(diffComponents(a, b)).toEqual(['minerals']);
    b.tick += 1;
    expect(diffComponents(a, b)).toEqual(['tick', 'minerals']);
  });
});

describe('float contamination is caught', () => {
  /**
   * Stands in for a sim function that someone wrote with floats: it produces a
   * value that is right to the eye and wrong in the bits. The harness must
   * notice.
   */
  function contaminatedGrant(amount: number): number {
    const scaled = amount * 1.0000001; // the kind of thing lint exists to stop
    return Math.round(scaled);
  }

  it('changes the hash when a sim value is computed with a float', () => {
    const clean = createMatch({ seed: SCRIPT_SEED, playerCount: SCRIPT_PLAYERS });
    const dirty = createMatch({ seed: SCRIPT_SEED, playerCount: SCRIPT_PLAYERS });
    for (let t = 0; t < 50; t++) {
      const amount = 10_000_000 + t;
      stepMatch(clean, [
        { kind: CommandKind.GrantResources, player: 0, minerals: amount, gas: 0 },
      ]);
      stepMatch(dirty, [
        {
          kind: CommandKind.GrantResources,
          player: 0,
          minerals: contaminatedGrant(amount),
          gas: 0,
        },
      ]);
    }
    expect(hashMatch(dirty)).not.toBe(hashMatch(clean));
    expect(diffComponents(clean, dirty)).toContain('minerals');
  });

  it('the lint rule would have rejected that function', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      'export const grant = (a: number): number => Math.round(a * 1.0000001);\n',
      { filePath: 'src/sim/__contaminated__.ts', warnIgnored: false },
    );
    const ids = (result?.messages ?? []).map((m) => m.ruleId);
    expect(ids).toContain('rts/no-nondeterminism');
  }, 30_000);
});
