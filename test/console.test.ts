import { describe, expect, it, vi } from 'vitest';
import {
  HISTORY_LIMIT,
  SCROLLBACK_LIMIT,
  createConsole,
  splitStatements,
  tokenize,
} from '../src/ui/console.ts';
import type { GameConsole } from '../src/ui/console.ts';
import type { SimCommand } from '../src/sim/commands.ts';

/** A console plus a record of everything it queued at the simulation. */
function setup(): { console: GameConsole; queued: SimCommand[] } {
  const queued: SimCommand[] = [];
  const console = createConsole({ queue: (command) => queued.push(command) });
  return { console, queued };
}

/** The text of every line, so assertions read as what the user would see. */
function output(console: GameConsole): string {
  return console.lines.map((l) => l.text).join('\n');
}

describe('tokenizing', () => {
  it('splits on whitespace and keeps quoted runs together', () => {
    expect(tokenize('bind F4 "spawn raider 2"')).toEqual(['bind', 'F4', 'spawn raider 2']);
    expect(tokenize('  give   500   100 ')).toEqual(['give', '500', '100']);
    expect(tokenize('')).toEqual([]);
  });

  it('keeps an empty quoted string as an argument', () => {
    // `alias foo ""` has to be distinguishable from `alias foo`, or there is
    // no way to clear an alias by assigning nothing to it.
    expect(tokenize('alias foo ""')).toEqual(['alias', 'foo', '']);
  });

  it('splits statements on semicolons, but not inside quotes', () => {
    expect(splitStatements('give 100; spawn soldier')).toEqual(['give 100', 'spawn soldier']);
    expect(splitStatements('bind F4 "stop; give 100"')).toEqual(['bind F4 "stop; give 100"']);
    expect(splitStatements('  ;  ; ')).toEqual([]);
  });
});

describe('cvars', () => {
  it('reads a value back when given no argument', () => {
    const { console } = setup();
    console.cvar({ name: 'cl_test', help: 'A test cvar.', value: 3 });
    console.execute('cl_test');
    expect(output(console)).toContain('cl_test = 3');
  });

  it('coerces to the type the default implies', () => {
    const { console } = setup();
    console.cvar({ name: 'a_number', help: '', value: 1 });
    console.cvar({ name: 'a_bool', help: '', value: false });
    console.cvar({ name: 'a_string', help: '', value: 'off' });

    console.execute('a_number 4.5');
    console.execute('a_bool on');
    console.execute('a_string  hello');

    expect(console.number('a_number')).toBe(4.5);
    expect(console.bool('a_bool')).toBe(true);
    expect(console.string('a_string')).toBe('hello');
  });

  it('clamps a number to its range rather than refusing it', () => {
    const { console } = setup();
    console.cvar({ name: 'cam_test', help: '', value: 1, min: 0.5, max: 2 });
    console.execute('cam_test 99');
    expect(console.number('cam_test')).toBe(2);
    console.execute('cam_test -99');
    expect(console.number('cam_test')).toBe(0.5);
  });

  it('refuses a value of the wrong type instead of storing NaN', () => {
    const { console } = setup();
    console.cvar({ name: 'cl_num', help: '', value: 1 });
    console.execute('cl_num banana');
    expect(console.number('cl_num')).toBe(1);
    expect(output(console)).toContain('expects a number');
  });

  it('calls onChange only when the value actually moves', () => {
    const { console } = setup();
    const onChange = vi.fn();
    console.cvar({ name: 'cl_watch', help: '', value: false, onChange });

    console.execute('cl_watch 1');
    console.execute('cl_watch 1');
    expect(onChange).toHaveBeenCalledTimes(1);
    console.execute('cl_watch 0');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('refuses to write a read-only cvar', () => {
    const { console } = setup();
    console.cvar({ name: 'cl_ro', help: '', value: 'fixed', readonly: true });
    console.execute('cl_ro other');
    expect(console.string('cl_ro')).toBe('fixed');
    expect(output(console)).toContain('read-only');
  });

  it('toggles and resets', () => {
    const { console } = setup();
    console.cvar({ name: 'cl_flag', help: '', value: false });
    console.execute('toggle cl_flag');
    expect(console.bool('cl_flag')).toBe(true);
    console.execute('reset cl_flag');
    expect(console.bool('cl_flag')).toBe(false);
  });

  it('cycles a cvar through given values', () => {
    const { console } = setup();
    console.cvar({ name: 'r_layer', help: '', value: 'off' });
    console.execute('toggle r_layer off slope walkable');
    expect(console.string('r_layer')).toBe('slope');
    console.execute('toggle r_layer off slope walkable');
    expect(console.string('r_layer')).toBe('walkable');
    console.execute('toggle r_layer off slope walkable');
    expect(console.string('r_layer')).toBe('off');
  });
});

describe('cheat gating', () => {
  it('refuses a cheat command until sv_cheats is on', () => {
    const { console, queued } = setup();
    console.register({
      name: 'give_test',
      help: '',
      cheat: true,
      run: ({ console: c }) => c.queue({ kind: 0 } as SimCommand),
    });

    console.execute('give_test');
    expect(queued).toHaveLength(0);
    expect(output(console)).toContain('sv_cheats 1');

    console.execute('sv_cheats 1');
    console.execute('give_test');
    expect(queued).toHaveLength(1);
  });

  it('refuses a cheat cvar the same way', () => {
    const { console } = setup();
    console.cvar({ name: 'r_seeall', help: '', value: false, cheat: true });
    console.execute('r_seeall 1');
    expect(console.bool('r_seeall')).toBe(false);

    console.execute('sv_cheats 1');
    console.execute('r_seeall 1');
    expect(console.bool('r_seeall')).toBe(true);
  });

  it('locks cheats off, and turns them off if they were already on', () => {
    // The networked case. A client that had cheats on before connecting must
    // not keep them: it would issue commands the other client never agreed to,
    // which is a desync rather than an unfairness.
    const { console, queued } = setup();
    console.register({
      name: 'cheat_test',
      help: '',
      cheat: true,
      run: ({ console: c }) => c.queue({ kind: 0 } as SimCommand),
    });

    console.execute('sv_cheats 1');
    expect(console.cheatsAllowed()).toBe(true);

    console.setCheatsLocked(true);
    expect(console.cheatsAllowed()).toBe(false);
    expect(console.bool('sv_cheats')).toBe(false);

    console.execute('sv_cheats 1');
    console.execute('cheat_test');
    expect(queued).toHaveLength(0);
    expect(output(console)).toContain('locked off in a networked match');

    console.setCheatsLocked(false);
    console.execute('sv_cheats 1');
    console.execute('cheat_test');
    expect(queued).toHaveLength(1);
  });
});

describe('commands', () => {
  it('reports an unknown command rather than failing silently', () => {
    const { console } = setup();
    console.execute('nonsense');
    expect(output(console)).toContain('unknown command: nonsense');
  });

  it('turns a thrown error into a console line', () => {
    const { console } = setup();
    console.register({
      name: 'boom',
      help: '',
      run: () => {
        throw new Error('it broke');
      },
    });
    console.execute('boom');
    expect(output(console)).toContain('boom: it broke');
    // And the console is still usable afterwards.
    console.execute('echo alive');
    expect(output(console)).toContain('alive');
  });

  it('runs several statements from one line', () => {
    const { console } = setup();
    console.execute('echo one; echo two');
    expect(output(console)).toContain('one');
    expect(output(console)).toContain('two');
  });

  it('gives a command its arguments and its raw tail', () => {
    const { console } = setup();
    let seen: { args: readonly string[]; rest: string } | null = null;
    console.register({
      name: 'capture',
      help: '',
      run: ({ args, rest }) => {
        seen = { args: [...args], rest };
      },
    });
    console.execute('capture F4 "spawn raider 2"');
    expect(seen).toEqual({ args: ['F4', 'spawn raider 2'], rest: 'F4 "spawn raider 2"' });
  });
});

describe('binds and aliases', () => {
  it('runs a bound command on a key press, without echoing the command', () => {
    const { console } = setup();
    console.execute('bind KeyG "echo pressed"');
    console.clear();

    expect(console.pressKey('KeyG')).toBe(true);
    expect(output(console)).toContain('pressed');
    // Pressing a key shows what the command said, not the command.
    expect(output(console)).not.toContain('] echo pressed');
  });

  it('reports an unbound key rather than claiming it', () => {
    const { console } = setup();
    expect(console.pressKey('KeyQ')).toBe(false);
  });

  it('binds a multi-statement command', () => {
    const { console } = setup();
    console.execute('bind F4 "echo a; echo b"');
    console.clear();
    console.pressKey('F4');
    expect(output(console)).toContain('a');
    expect(output(console)).toContain('b');
  });

  it('expands an alias', () => {
    const { console } = setup();
    console.execute('alias hello "echo world"');
    console.clear();
    console.execute('hello');
    expect(output(console)).toContain('world');
  });

  it('survives an alias defined in terms of itself', () => {
    // `alias a "a"` is an easy thing to type and must not take the tab down.
    const { console } = setup();
    console.execute('alias loop "loop"');
    console.execute('loop');
    expect(output(console)).toContain('expanded too deeply');
  });

  it('refuses to shadow a real command with an alias', () => {
    const { console } = setup();
    console.execute('alias echo "echo no"');
    expect(output(console)).toContain('already a command');
    expect(console.aliases.has('echo')).toBe(false);
  });
});

describe('history and completion', () => {
  it('walks submitted lines with recall', () => {
    const { console } = setup();
    console.execute('echo one');
    console.execute('echo two');

    expect(console.recall(-1)).toBe('echo two');
    expect(console.recall(-1)).toBe('echo one');
    expect(console.recall(1)).toBe('echo two');
  });

  it('does not record the same line twice in a row', () => {
    const { console } = setup();
    console.execute('echo same');
    console.execute('echo same');
    expect(console.history.filter((l) => l === 'echo same')).toHaveLength(1);
  });

  it('does not record commands run from a bind or a config', () => {
    const { console } = setup();
    console.execute('echo typed');
    console.execute('echo silent', { silent: true });
    expect(console.history).toEqual(['echo typed']);
  });

  it('bounds history', () => {
    const { console } = setup();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) console.execute(`echo ${i}`);
    expect(console.history).toHaveLength(HISTORY_LIMIT);
    expect(console.history.at(-1)).toBe(`echo ${HISTORY_LIMIT + 19}`);
  });

  it('bounds scrollback', () => {
    const { console } = setup();
    for (let i = 0; i < SCROLLBACK_LIMIT * 2; i++) console.print(`line ${i}`);
    expect(console.lines).toHaveLength(SCROLLBACK_LIMIT);
    expect(console.lines.at(-1)?.text).toBe(`line ${SCROLLBACK_LIMIT * 2 - 1}`);
  });

  it('completes to the longest shared prefix', () => {
    const { console } = setup();
    console.cvar({ name: 'r_fog', help: '', value: true });
    console.cvar({ name: 'r_fogcolor', help: '', value: 'grey' });
    console.cvar({ name: 'cl_other', help: '', value: 1 });

    const result = console.complete('r_');
    expect(result.matches).toEqual(['r_fog', 'r_fogcolor']);
    expect(result.common).toBe('r_fog');

    expect(console.complete('zzz').matches).toEqual([]);
  });

  it('completes commands, cvars and aliases alike', () => {
    const { console } = setup();
    console.execute('alias clearall "clear"');
    expect(console.complete('clear').matches).toEqual(['clear', 'clearall']);
  });
});

describe('config persistence', () => {
  it('saves archived cvars and binds, and nothing else', () => {
    const { console } = setup();
    console.cvar({ name: 'cl_kept', help: '', value: 1, archive: true });
    console.cvar({ name: 'cl_dropped', help: '', value: 1 });
    console.execute('cl_kept 5');
    console.execute('cl_dropped 5');
    console.execute('bind KeyG "echo hi"');

    const config = console.saveConfig();
    expect(config).toContain('cl_kept 5');
    expect(config).not.toContain('cl_dropped');
    expect(config).toContain('bind KeyG "echo hi"');
  });

  it('leaves out an archived cvar still at its default', () => {
    const { console } = setup();
    console.cvar({ name: 'cl_default', help: '', value: 2, archive: true });
    expect(console.saveConfig()).not.toContain('cl_default');
  });

  it('round-trips through load', () => {
    const first = createConsole();
    first.cvar({ name: 'cl_kept', help: '', value: 1, archive: true });
    first.execute('cl_kept 7');
    first.execute('bind F4 "echo restored"');

    const second = createConsole();
    second.cvar({ name: 'cl_kept', help: '', value: 1, archive: true });
    second.loadConfig(first.saveConfig());

    expect(second.number('cl_kept')).toBe(7);
    expect(second.binds.get('F4')).toBe('echo restored');
    // Loading a config does not fill the history with the config.
    expect(second.history).toEqual([]);
  });

  it('writes through to storage when a setting changes', () => {
    const written: string[] = [];
    const console = createConsole({
      storage: { read: () => null, write: (text) => written.push(text) },
    });
    console.cvar({ name: 'cl_kept', help: '', value: 1, archive: true });
    console.execute('cl_kept 3');
    expect(written.at(-1)).toContain('cl_kept 3');
  });

  it('ignores blank lines and comments in a config', () => {
    const console = createConsole();
    console.cvar({ name: 'cl_kept', help: '', value: 1, archive: true });
    console.loadConfig('// a comment\n\n   \ncl_kept 9\n');
    expect(console.number('cl_kept')).toBe(9);
  });
});

describe('queueing simulation commands', () => {
  it('says so rather than throwing when there is nowhere to queue', () => {
    const console = createConsole();
    console.execute('sv_cheats 1');
    console.register({
      name: 'q',
      help: '',
      cheat: true,
      run: ({ console: c }) => c.queue({ kind: 0 } as SimCommand),
    });
    console.execute('q');
    expect(output(console)).toContain('no match is running');
  });
});
