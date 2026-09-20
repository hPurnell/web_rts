/**
 * Resolving a map's scenery names to the models that draw them.
 *
 * The rules here were all derived from the shipped art rather than from
 * documentation, so they are worth pinning: each case below is a name a real
 * map places and the model the archives really hold for it. The `exists` stub
 * stands in for the archive index, listing the models the real one has for
 * these families and nothing else — which is the whole point of the design,
 * since a candidate that is not a real model has to fall through.
 */
import { describe, expect, it } from 'vitest';
import { resolveModel } from '../generals/tools/objectini.ts';

/** The models the real archives hold for the families exercised here. */
const MODELS = new Set(
  [
    // Pine ships four snow variants and eight green ones.
    'ptpine01', 'ptpine01_s', 'ptpine02', 'ptpine02_s', 'ptpine03', 'ptpine03_s',
    'ptpine03_s2', 'ptpine04', 'ptpine04_s', 'ptpine04_s2', 'ptxpine05',
    // Doubled letters squeezed out.
    'ptdogwod07', 'ptdogwod08', 'ptxwilow02',
    // Truncated to four letters, and short names not truncated at all.
    'ptxbamb01', 'ptxfir06', 'ptoak01',
    'ptxbirch03', 'ptpalm02', 'ptspruce01', 'ptspruce01_s',
    // A building, which resolves through the INI instead.
    'cbtgasstn',
  ].map((name) => `${name}.w3d`),
);

const exists = (file: string): boolean => MODELS.has(file.toLowerCase());
const ini = new Map([['stangasstation', 'CBTGasStn']]);
const resolve = (name: string): string | null => resolveModel(name, ini, exists);

describe('resolving scenery to models', () => {
  it('prefers what the INI says', () => {
    expect(resolve('StanGasStation')).toBe('CBTGasStn');
  });

  it('falls back to the naming convention for trees, which the INI omits', () => {
    // No `Object TreePine` block exists anywhere in the game's data.
    expect(resolve('TreePine')).toBe('ptpine01');
    expect(resolve('TreePine2')).toBe('ptpine02');
    expect(resolve('TreeBirch03')).toBe('ptxbirch03');
  });

  it('squeezes the doubled letters the art drops', () => {
    expect(resolve('TreeDogwood7')).toBe('ptdogwod07');
    expect(resolve('TreeWillow02')).toBe('ptxwilow02');
  });

  it('truncates long family names but never short ones', () => {
    expect(resolve('TreeBamboo01Snow')).toBe('ptxbamb01');
    // `Fir` and `Oak` are three letters. A truncation floor that cut below the
    // name itself lost these entirely, which is how the bound got its guard.
    expect(resolve('TreeFir06Snow')).toBe('ptxfir06');
    expect(resolve('TreeOak01Snow')).toBe('ptoak01');
  });

  it('reads the seasonal qualifier on either side of the number', () => {
    expect(resolve('TreePineSnow')).toBe('ptpine01_s');
    expect(resolve('TreePine3snow')).toBe('ptpine03_s');
    expect(resolve('TreePine4snow2')).toBe('ptpine04_s2');
  });

  it('keeps the season when the exact variant is missing', () => {
    // The art ships four snow pines and a winter map places eight kinds. The
    // nearest snow pine beats the exact green one.
    expect(resolve('TreePine5snow2')).toBe('ptpine01_s');
    expect(resolve('TreeSpruce04Snow')).toBe('ptspruce01_s');
  });

  it('ignores the height qualifier, which has no model of its own', () => {
    expect(resolve('TreePalm2short')).toBe('ptpalm02');
  });

  it('gives up rather than substituting something unrelated', () => {
    expect(resolve('TreeMangrove3')).toBeNull();
    expect(resolve('BrickWall04')).toBeNull();
  });
});
