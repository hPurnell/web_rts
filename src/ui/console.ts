/**
 * A Quake-style console: commands, cvars, binds and aliases.
 *
 * This module is deliberately free of the DOM. It owns parsing, the registry,
 * history and completion; `consoleview.ts` draws it. That split is what lets
 * the interesting half — quoting, cheat gating, completion, bind recursion —
 * be tested without a browser, and it keeps the rule that nothing here reaches
 * into the renderer.
 *
 * It also never mutates the simulation. Commands that change match state hand
 * a `SimCommand` to `queue()`, which puts it through the same tick-boundary
 * path as a mouse click (invariant 4). A console that wrote straight into the
 * unit store would desync every other client in the match on the first `give`.
 */
import type { SimCommand } from '../sim/commands.ts';

/** How many lines of scrollback to keep. Older lines are dropped. */
export const SCROLLBACK_LIMIT = 512;
/** How many submitted lines the up-arrow can walk back through. */
export const HISTORY_LIMIT = 64;
/** How deep a bind or alias may expand before it is treated as a loop. */
const MAX_EXPANSION_DEPTH = 8;

export type LineLevel = 'echo' | 'info' | 'warn' | 'error';

export interface ConsoleLine {
  readonly text: string;
  readonly level: LineLevel;
}

export type CvarValue = string | number | boolean;

export interface CvarDef {
  readonly name: string;
  readonly help: string;
  readonly value: CvarValue;
  /** Requires `sv_cheats 1`. Refused rather than silently ignored. */
  readonly cheat?: boolean;
  /** Persisted to localStorage and restored next session. */
  readonly archive?: boolean;
  /** Reported by `cvarlist` but cannot be set from the console. */
  readonly readonly?: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Called after a successful set, with the parsed value. */
  onChange?(value: CvarValue): void;
}

export interface Cvar extends CvarDef {
  value: CvarValue;
  readonly defaultValue: CvarValue;
  readonly type: 'string' | 'number' | 'boolean';
}

/** What a command handler is given. */
export interface CommandContext {
  readonly args: readonly string[];
  /** The raw text after the command name, unsplit. For `echo` and `bind`. */
  readonly rest: string;
  readonly console: GameConsole;
  print(text: string, level?: LineLevel): void;
}

export interface ConsoleCommandDef {
  readonly name: string;
  readonly help: string;
  /** Shown by `help <name>`, e.g. "give <minerals> [gas]". */
  readonly usage?: string;
  readonly cheat?: boolean;
  /**
   * Completions for the command's first argument. Without one, Tab after a
   * command name does nothing, which is the right default: most arguments
   * here are numbers or free text.
   */
  complete?(prefix: string): readonly string[];
  run(context: CommandContext): void;
}

export interface ConsoleHost {
  /** Puts a simulation command on the queue for the next tick boundary. */
  queue?(command: SimCommand): void;
  /** Reads and writes persisted settings. Omitted in tests. */
  storage?: {
    read(): string | null;
    write(text: string): void;
  };
}

export interface CompletionResult {
  /** Every name that starts with the prefix, sorted. */
  readonly matches: readonly string[];
  /** The longest prefix they all share, which is what Tab inserts. */
  readonly common: string;
}

export interface GameConsole {
  readonly lines: readonly ConsoleLine[];
  /**
   * How many lines have ever been printed, including ones since trimmed.
   *
   * The view renders incrementally, and `lines.length` cannot tell it what is
   * new: once the scrollback is full, every print trims one line and appends
   * one, so the length never changes while the contents change completely.
   */
  readonly totalPrinted: number;
  readonly commands: ReadonlyMap<string, ConsoleCommandDef>;
  readonly cvars: ReadonlyMap<string, Cvar>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly binds: ReadonlyMap<string, string>;

  register(command: ConsoleCommandDef): void;
  cvar(def: CvarDef): Cvar;
  lookup(name: string): Cvar | undefined;

  /** Current value, typed. Throws if the cvar does not exist. */
  number(name: string): number;
  bool(name: string): boolean;
  string(name: string): string;
  /** Set from code rather than from the console: skips the cheat check. */
  set(name: string, value: CvarValue): void;

  /** Run a line. May hold several commands separated by `;`. */
  execute(line: string, options?: { silent?: boolean }): void;
  print(text: string, level?: LineLevel): void;
  clear(): void;

  /** Run whatever is bound to a key code. Returns true if something ran. */
  pressKey(code: string): boolean;
  bind(code: string, command: string): void;
  unbind(code: string): void;

  complete(prefix: string): CompletionResult;
  /** Walk history. `delta` is -1 for older, +1 for newer. */
  recall(delta: number): string;
  resetRecall(): void;
  readonly history: readonly string[];

  /**
   * Locks `sv_cheats` off. A networked match calls this: one client turning on
   * cheats would issue commands the others never agreed to.
   */
  setCheatsLocked(locked: boolean): void;
  cheatsAllowed(): boolean;

  queue(command: SimCommand): void;
  /** Serialise archived cvars and binds, in `exec`-able form. */
  saveConfig(): string;
  loadConfig(text: string): void;
  onChange(listener: () => void): () => void;
}

/**
 * Split a line into tokens, respecting double quotes.
 *
 * `bind F4 "spawn raider 2"` has to survive as three tokens or binds can never
 * carry arguments, which is most of what makes them worth having.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Split a line on `;`, ignoring separators inside quotes.
 *
 * Needed for binds that do two things: `bind F4 "stop; give 100"`.
 */
export function splitStatements(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The longest prefix shared by every string given. */
function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] as string;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** Parse a cvar value into the type its default implies. */
function coerce(cvar: Cvar, raw: string): CvarValue | null {
  if (cvar.type === 'string') return raw;
  if (cvar.type === 'boolean') {
    if (raw === '1' || raw === 'true' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (cvar.min !== undefined && value < cvar.min) return cvar.min;
  if (cvar.max !== undefined && value > cvar.max) return cvar.max;
  return value;
}

/** How a cvar's value is written back out, for `cvarlist` and the config. */
export function formatValue(value: CvarValue): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

export function createConsole(host: ConsoleHost = {}): GameConsole {
  const lines: ConsoleLine[] = [];
  const commands = new Map<string, ConsoleCommandDef>();
  const cvars = new Map<string, Cvar>();
  const aliases = new Map<string, string>();
  const binds = new Map<string, string>();
  const history: string[] = [];
  const listeners = new Set<() => void>();

  let totalPrinted = 0;
  let recallIndex = -1;
  let cheatsLocked = false;
  /** Guards against `alias a "a"` taking the tab out with it. */
  let depth = 0;

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const print = (text: string, level: LineLevel = 'info'): void => {
    // A multi-line string becomes multiple entries, so the view never has to
    // think about wrapping something that already contains newlines.
    for (const part of text.split('\n')) {
      lines.push({ text: part, level });
      totalPrinted++;
    }
    if (lines.length > SCROLLBACK_LIMIT) lines.splice(0, lines.length - SCROLLBACK_LIMIT);
    changed();
  };

  const self: GameConsole = {
    get lines() {
      return lines;
    },
    get totalPrinted() {
      return totalPrinted;
    },
    commands,
    cvars,
    aliases,
    binds,
    get history() {
      return history;
    },

    register(command) {
      commands.set(command.name.toLowerCase(), command);
    },

    cvar(def) {
      const existing = cvars.get(def.name.toLowerCase());
      if (existing) return existing;
      const type =
        typeof def.value === 'boolean'
          ? 'boolean'
          : typeof def.value === 'number'
            ? 'number'
            : 'string';
      const cvar: Cvar = { ...def, defaultValue: def.value, type, value: def.value };
      cvars.set(def.name.toLowerCase(), cvar);
      return cvar;
    },

    lookup(name) {
      return cvars.get(name.toLowerCase());
    },

    number(name) {
      return Number(required(name).value);
    },
    bool(name) {
      const value = required(name).value;
      return typeof value === 'boolean' ? value : Number(value) !== 0;
    },
    string(name) {
      return String(required(name).value);
    },

    set(name, value) {
      const cvar = required(name);
      if (cvar.value === value) return;
      cvar.value = value;
      cvar.onChange?.(value);
      changed();
    },

    execute(line, options) {
      for (const statement of splitStatements(line)) runStatement(statement, options?.silent === true);
    },

    print,

    clear() {
      lines.length = 0;
      changed();
    },

    pressKey(code) {
      const bound = binds.get(code);
      if (bound === undefined) return false;
      self.execute(bound, { silent: true });
      return true;
    },

    bind(code, command) {
      binds.set(code, command);
      changed();
    },

    unbind(code) {
      binds.delete(code);
      changed();
    },

    complete(prefix) {
      // Past the first word, the command being typed decides. `map <Tab>`
      // should offer maps, not every command in the registry.
      const separator = prefix.search(/\s/);
      if (separator >= 0) {
        const command = commands.get(prefix.slice(0, separator).toLowerCase());
        const argument = prefix.slice(separator + 1);
        // Only the first argument, and only while it is still the last word:
        // completing into the middle of a line would overwrite what follows.
        if (!command?.complete || /\s/.test(argument)) {
          return { matches: [], common: prefix };
        }
        const matches = [...command.complete(argument)].sort();
        const head = prefix.slice(0, separator + 1);
        return {
          matches,
          common: matches.length > 0 ? head + commonPrefix(matches) : prefix,
        };
      }

      const lower = prefix.toLowerCase();
      const names = [
        ...commands.keys(),
        ...cvars.keys(),
        ...aliases.keys(),
      ].filter((name) => name.startsWith(lower));
      const matches = [...new Set(names)].sort();
      return { matches, common: commonPrefix(matches) };
    },

    recall(delta) {
      if (history.length === 0) return '';
      if (recallIndex === -1) recallIndex = history.length;
      recallIndex = Math.max(0, Math.min(history.length, recallIndex + delta));
      return history[recallIndex] ?? '';
    },

    resetRecall() {
      recallIndex = -1;
    },

    setCheatsLocked(locked) {
      cheatsLocked = locked;
      if (locked) {
        const cheats = cvars.get('sv_cheats');
        if (cheats && cheats.value !== false) {
          cheats.value = false;
          cheats.onChange?.(false);
        }
      }
      changed();
    },

    cheatsAllowed() {
      if (cheatsLocked) return false;
      const cheats = cvars.get('sv_cheats');
      return cheats ? cheats.value === true : false;
    },

    queue(command) {
      if (!host.queue) {
        print('nothing to queue commands to: no match is running', 'error');
        return;
      }
      host.queue(command);
    },

    saveConfig() {
      const out: string[] = [];
      for (const cvar of [...cvars.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        if (!cvar.archive || cvar.value === cvar.defaultValue) continue;
        out.push(`${cvar.name} ${quoteIfNeeded(formatValue(cvar.value))}`);
      }
      for (const [code, command] of [...binds.entries()].sort()) {
        out.push(`bind ${code} ${quoteIfNeeded(command)}`);
      }
      return out.join('\n');
    },

    loadConfig(text) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('//')) continue;
        self.execute(trimmed, { silent: true });
      }
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function required(name: string): Cvar {
    const cvar = cvars.get(name.toLowerCase());
    if (!cvar) throw new Error(`unknown cvar: ${name}`);
    return cvar;
  }

  function quoteIfNeeded(text: string): string {
    return /[\s;"]/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
  }

  /**
   * Run one statement: a command, a cvar read or write, or an alias.
   *
   * `silent` suppresses the echo of the line itself, which is what a bind or a
   * config file wants — pressing a bound key should show the command's output,
   * not the command.
   */
  function runStatement(statement: string, silent: boolean): void {
    const tokens = tokenize(statement);
    const name = tokens[0]?.toLowerCase();
    if (name === undefined) return;

    if (!silent) {
      print(`] ${statement}`, 'echo');
      if (history[history.length - 1] !== statement) history.push(statement);
      if (history.length > HISTORY_LIMIT) history.shift();
      recallIndex = -1;
    }

    if (depth >= MAX_EXPANSION_DEPTH) {
      print(`'${name}' expanded too deeply — is it defined in terms of itself?`, 'error');
      return;
    }

    const args = tokens.slice(1);
    // Everything after the command name, with its original spacing and quotes
    // intact. `bind` and `alias` need it; `echo` reads better with it.
    const rest = statement.trim().slice(tokens[0]?.length ?? 0).trim();

    const alias = aliases.get(name);
    if (alias !== undefined) {
      depth++;
      try {
        self.execute(alias, { silent: true });
      } finally {
        depth--;
      }
      return;
    }

    const command = commands.get(name);
    if (command) {
      if (command.cheat && !self.cheatsAllowed()) {
        print(refusal(name), 'error');
        return;
      }
      depth++;
      try {
        command.run({ args, rest, console: self, print });
      } catch (error) {
        print(`${name}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        depth--;
      }
      return;
    }

    const cvar = cvars.get(name);
    if (cvar) {
      if (args.length === 0) {
        print(
          `${cvar.name} = ${formatValue(cvar.value)}  (default ${formatValue(cvar.defaultValue)})\n  ${cvar.help}`,
        );
        return;
      }
      if (cvar.readonly) {
        print(`${cvar.name} is read-only`, 'error');
        return;
      }
      if (cvar.cheat && !self.cheatsAllowed()) {
        print(refusal(cvar.name), 'error');
        return;
      }
      const value = coerce(cvar, args[0] as string);
      if (value === null) {
        print(`${cvar.name} expects a ${cvar.type}`, 'error');
        return;
      }
      if (cvar.value !== value) {
        cvar.value = value;
        cvar.onChange?.(value);
        persist();
        changed();
      }
      return;
    }

    print(`unknown command: ${name}`, 'error');
  }

  function refusal(name: string): string {
    return cheatsLocked
      ? `${name} is a cheat, and cheats are locked off in a networked match`
      : `${name} is a cheat — set sv_cheats 1 first`;
  }

  function persist(): void {
    host.storage?.write(self.saveConfig());
  }

  // ---------------------------------------------------------------------
  // The commands every console has, independent of this game.
  // ---------------------------------------------------------------------

  self.cvar({
    name: 'sv_cheats',
    help: 'Allow commands that change match state from the console.',
    value: false,
  });

  self.register({
    name: 'help',
    help: 'Describe a command or cvar, or list everything.',
    usage: 'help [name]',
    run({ args, print: out }) {
      const name = args[0]?.toLowerCase();
      if (name === undefined) {
        out('Type a command name for help on it. `cmdlist` and `cvarlist` list everything.');
        out('Tab completes. Up and down walk history. ` or Escape closes the console.');
        return;
      }
      const command = commands.get(name);
      if (command) {
        out(`${command.usage ?? command.name}${command.cheat ? '  [cheat]' : ''}`);
        out(`  ${command.help}`);
        return;
      }
      const cvar = cvars.get(name);
      if (cvar) {
        out(`${cvar.name} = ${formatValue(cvar.value)}  (default ${formatValue(cvar.defaultValue)})`);
        out(`  ${cvar.help}`);
        return;
      }
      out(`nothing called ${name}`, 'error');
    },
  });

  self.register({
    name: 'cmdlist',
    help: 'List commands, optionally filtered by a substring.',
    usage: 'cmdlist [substring]',
    run({ args, print: out }) {
      const filter = args[0]?.toLowerCase() ?? '';
      const names = [...commands.values()]
        .filter((c) => c.name.includes(filter))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const command of names) {
        out(`${command.name.padEnd(18)} ${command.help}`);
      }
      out(`${names.length} commands`);
    },
  });

  self.register({
    name: 'cvarlist',
    help: 'List cvars and their values, optionally filtered by a substring.',
    usage: 'cvarlist [substring]',
    run({ args, print: out }) {
      const filter = args[0]?.toLowerCase() ?? '';
      const matching = [...cvars.values()]
        .filter((c) => c.name.includes(filter))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const cvar of matching) {
        const marks = `${cvar.cheat ? 'C' : ' '}${cvar.archive ? 'A' : ' '}${cvar.readonly ? 'R' : ' '}`;
        out(`${marks} ${cvar.name.padEnd(20)} ${formatValue(cvar.value).padEnd(10)} ${cvar.help}`);
      }
      out(`${matching.length} cvars   (C cheat, A archived, R read-only)`);
    },
  });

  self.register({
    name: 'find',
    help: 'Search commands and cvars by substring.',
    usage: 'find <substring>',
    run({ args, console: c }) {
      const needle = args[0];
      if (needle === undefined) throw new Error('usage: find <substring>');
      c.execute(`cmdlist ${needle}`, { silent: true });
      c.execute(`cvarlist ${needle}`, { silent: true });
    },
  });

  self.register({
    name: 'echo',
    help: 'Print its arguments.',
    usage: 'echo <text>',
    run({ rest, print: out }) {
      out(rest.replace(/"/g, ''));
    },
  });

  self.register({
    name: 'clear',
    help: 'Empty the console scrollback.',
    run({ console: c }) {
      c.clear();
    },
  });

  self.register({
    name: 'toggle',
    help: 'Flip a boolean cvar, or step a number between given values.',
    usage: 'toggle <cvar> [values...]',
    run({ args, console: c, print: out }) {
      const name = args[0];
      if (name === undefined) throw new Error('usage: toggle <cvar> [values...]');
      const cvar = c.lookup(name);
      if (!cvar) {
        out(`unknown cvar: ${name}`, 'error');
        return;
      }
      if (args.length > 1) {
        const values = args.slice(1);
        const current = formatValue(cvar.value);
        const index = values.indexOf(current);
        const next = values[(index + 1) % values.length] as string;
        c.execute(`${cvar.name} ${next}`, { silent: true });
        return;
      }
      c.execute(`${cvar.name} ${cvar.value === true || Number(cvar.value) !== 0 ? 0 : 1}`, {
        silent: true,
      });
    },
  });

  self.register({
    name: 'reset',
    help: 'Put a cvar back to its default.',
    usage: 'reset <cvar>',
    run({ args, console: c, print: out }) {
      const name = args[0];
      if (name === undefined) throw new Error('usage: reset <cvar>');
      const cvar = c.lookup(name);
      if (!cvar) {
        out(`unknown cvar: ${name}`, 'error');
        return;
      }
      c.execute(`${cvar.name} ${formatValue(cvar.defaultValue)}`, { silent: true });
    },
  });

  self.register({
    name: 'bind',
    help: 'Bind a key to a command, or show what a key is bound to.',
    usage: 'bind <KeyCode> "<command>"',
    run({ args, rest, console: c, print: out }) {
      const code = args[0];
      if (code === undefined) {
        c.execute('bindlist', { silent: true });
        return;
      }
      if (args.length === 1) {
        const bound = binds.get(code);
        out(bound === undefined ? `${code} is not bound` : `${code} = "${bound}"`);
        return;
      }
      // Everything after the key code, so quotes inside the command survive.
      const command = rest.slice(code.length).trim().replace(/^"|"$/g, '');
      c.bind(code, command);
      persist();
      out(`bound ${code} to "${command}"`);
    },
  });

  self.register({
    name: 'unbind',
    help: 'Remove a key binding.',
    usage: 'unbind <KeyCode>',
    run({ args, console: c, print: out }) {
      const code = args[0];
      if (code === undefined) throw new Error('usage: unbind <KeyCode>');
      c.unbind(code);
      persist();
      out(`unbound ${code}`);
    },
  });

  self.register({
    name: 'bindlist',
    help: 'List every key binding.',
    run({ print: out }) {
      const entries = [...binds.entries()].sort();
      for (const [code, command] of entries) out(`${code.padEnd(14)} "${command}"`);
      out(`${entries.length} binds`);
    },
  });

  self.register({
    name: 'alias',
    help: 'Name a command line, or list aliases.',
    usage: 'alias <name> "<command>"',
    run({ args, rest, print: out }) {
      const name = args[0]?.toLowerCase();
      if (name === undefined) {
        for (const [key, value] of [...aliases.entries()].sort()) out(`${key.padEnd(14)} "${value}"`);
        out(`${aliases.size} aliases`);
        return;
      }
      if (args.length === 1) {
        aliases.delete(name);
        out(`removed alias ${name}`);
        changed();
        return;
      }
      if (commands.has(name) || cvars.has(name)) {
        out(`${name} is already a command or cvar`, 'error');
        return;
      }
      const body = rest.slice(args[0]?.length ?? 0).trim().replace(/^"|"$/g, '');
      aliases.set(name, body);
      changed();
      out(`alias ${name} = "${body}"`);
    },
  });

  return self;
}
