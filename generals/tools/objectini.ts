/**
 * Which model does an object use?
 *
 * A map places objects by name — `TreePine`, `TreeDogwood7` — and the name is
 * not the model. The mapping lives in the `Object` blocks under `Data/INI`,
 * where a `W3DModelDraw` module's `DefaultConditionState` names the W3D file.
 *
 * Two wrinkles make this more than a regex over one file:
 *
 * - The definitions are spread across two hundred-odd INI files, so every one
 *   is scanned rather than guessing which holds what.
 * - The key is `Model` for most things but `ModelName` for trees, which use a
 *   `W3DTreeDraw` module of their own. Matching only `Model` resolves the
 *   scenery and none of the forest.
 * - `ChildObject <name> <parent>` inherits, and a great many of the tree
 *   variants a map actually places are children that override nothing but
 *   their model — or not even that, in which case the parent's model is the
 *   answer.
 */
import { indexArchives, readIndexed } from './big.ts';
import type { AssetIndex } from './big.ts';

export interface ObjectModels {
  /** Object name, lower-cased, to the W3D file it draws. */
  readonly models: ReadonlyMap<string, string>;
}

/** `Object Foo` or `ChildObject Foo Bar`, to the end of the block. */
const OBJECT_BLOCK = /^(Object|ChildObject)\s+(\w+)(?:\s+(\w+))?\s*$/gim;

/**
 * The model a block draws.
 *
 * `Model = NONE` is a real answer meaning "draws nothing", and is skipped so a
 * child can inherit something that does.
 */
function modelIn(block: string): string | null {
  for (const match of block.matchAll(/^\s*Model(?:Name)?\s*=\s*([\w.]+)/gim)) {
    const name = match[1] as string;
    if (name.toUpperCase() !== 'NONE') return name;
  }
  return null;
}

export function readObjectModels(index: AssetIndex): ObjectModels {
  const direct = new Map<string, string>();
  const parents = new Map<string, string>();

  for (const entry of index.entries.values()) {
    if (!entry.key.startsWith('data/ini/') || !entry.key.endsWith('.ini')) continue;

    let text: string;
    try {
      text = readIndexed(index, entry.key).toString('latin1');
    } catch {
      continue;
    }
    if (!text.includes('Object')) continue;

    // Split on the block headers, keeping each header with its body.
    const headers = [...text.matchAll(OBJECT_BLOCK)];
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i] as RegExpMatchArray;
      const start = (header.index ?? 0) + header[0].length;
      const end = headers[i + 1]?.index ?? text.length;
      const name = (header[2] as string).toLowerCase();
      const parent = header[3]?.toLowerCase();

      const model = modelIn(text.slice(start, end));
      if (model) direct.set(name, model);
      else if (parent) parents.set(name, parent);
    }
  }

  // Resolve inheritance, with a depth cap so a cycle in the data cannot hang.
  const models = new Map(direct);
  for (const [name, parent] of parents) {
    let walk: string | undefined = parent;
    for (let depth = 0; depth < 8 && walk; depth++) {
      const found = direct.get(walk);
      if (found) {
        models.set(name, found);
        break;
      }
      walk = parents.get(walk);
    }
  }

  return { models };
}

/** Convenience for tools that have an install but no index yet. */
export function readObjectModelsFrom(archives: readonly string[]): ObjectModels {
  return readObjectModels(indexArchives(archives));
}

/**
 * The model an object draws, falling back to the art's naming convention.
 *
 * Most scenery resolves through the INI. The trees mostly do not: a map places
 * `TreePine` and `TreeDogwood7`, and no `Object` block of either name exists —
 * they are drawn straight from models called `PTPine01` and `PTDogwod07`.
 *
 * So candidates are generated from the name's shape and each is tested against
 * the archives, which makes the guessing self-correcting: a candidate that is
 * not really a model simply does not match, and the object is skipped rather
 * than pointed at the wrong art.
 */
export function resolveModel(
  name: string,
  models: ReadonlyMap<string, string>,
  exists: (file: string) => boolean,
): string | null {
  const fromIni = models.get(name.toLowerCase());
  if (fromIni && exists(`${fromIni}.w3d`)) return fromIni;

  // The qualifier sits on either side of the number — `TreePineSnow`,
  // `TreePine3snow` and `TreePine5snow2` are all in the shipped maps — so both
  // positions are matched, along with the trailing variant digit.
  const tree = /^Tree([A-Za-z]+?)(snow|short)?(\d*)(snow|short)?(\d*)$/i.exec(name);
  if (!tree) return fromIni ?? null;

  const family = (tree[1] as string).toLowerCase();
  const snow = /snow/i.test(`${tree[2] ?? ''}${tree[4] ?? ''}`);
  const variant = tree[5] ?? '';
  const digits = tree[3] ?? '';
  const number = digits.length > 0 ? Number(digits) : 1;

  // The art abbreviates a family name to fit a fixed-width naming scheme and
  // the map does not. Two ways, both in the data: doubled letters are squeezed
  // out (`Dogwood` is modelled as `Dogwod`, `Willow` as `Wilow`) and long
  // names are truncated (`Bamboo` to `Bamb`). Some families also take an `x`
  // prefix. Every abbreviation down to four letters is offered, longest first
  // and never shorter than the name itself, and the archive decides which is
  // real. Dropping that floor below the full stem loses the short families:
  // `Fir` and `Oak` are three letters and are not abbreviated at all.
  const squeezed = family.replace(/(.)\1/g, '$1');
  const bodies: string[] = [];
  for (const stem of [family, squeezed]) {
    for (let length = stem.length; length >= Math.min(4, stem.length); length--) {
      bodies.push(stem.slice(0, length), `x${stem.slice(0, length)}`);
    }
  }

  // Ordered by how wrong the substitution is. Season first: a winter map
  // places eight variants of snow-laden pine and the art ships four, so the
  // nearest snow pine is a far better answer than the exact green one. Within
  // a season the exact variant wins, then the first of the family.
  const suffixes = snow ? [`_s${variant}`, '_s', ''] : ['', '_s'];
  const numbers = [String(number).padStart(2, '0'), String(number), '01', '1', ''];

  const candidates: string[] = [];
  for (const suffix of suffixes) {
    for (const digit of numbers) {
      for (const body of new Set(bodies)) candidates.push(`pt${body}${digit}${suffix}`);
    }
  }

  for (const candidate of candidates) {
    if (exists(`${candidate}.w3d`)) return candidate;
  }
  return fromIni ?? null;
}
