/**
 * Unit type definitions, loaded from data rather than hard-coded.
 *
 * Every field in units.json is an integer in a named unit (milli-cells,
 * ticks), so loading is integer arithmetic: parsing "2.8" would put a float
 * into the simulation through the back door (invariant 2).
 *
 * Distances become Q16.16 cells; speeds become Q16.16 cells *per tick*, since
 * the simulation's only clock is the tick counter.
 */
import type { Fixed } from './fixed.ts';
import { fromRatio } from './fixed.ts';
import { TICKS_PER_SECOND } from './ticks.ts';
import rawTable from './data/units.json' with { type: 'json' };

const MILLI = 1000;

export interface UnitType {
  readonly id: string;
  readonly name: string;
  readonly typeId: number;
  readonly maxHp: number;
  /** Cells per tick. */
  readonly speed: Fixed;
  readonly sightRadius: Fixed;
  readonly attackRange: Fixed;
  readonly damage: number;
  /** Ticks between attacks. */
  readonly cooldown: number;
  /** Collision radius in cells. */
  readonly radius: Fixed;
  readonly buildTicks: number;
  readonly mineralCost: number;
  readonly gasCost: number;
  /** True when the weapon rotates independently of the hull. */
  readonly hasTurret: boolean;
  /** True for buildings: they do not move, and players remember seeing them. */
  readonly isStructure: boolean;
  /** Cells per tick for this weapon's shot; zero means hitscan. */
  readonly projectileSpeed: Fixed;
  /** True when this type can attack at all. */
  readonly canAttack: boolean;
}

interface RawUnitType {
  id: string;
  name: string;
  hp: number;
  speedMilliCellsPerSecond: number;
  sightRadiusMilliCells: number;
  attackRangeMilliCells: number;
  damage: number;
  cooldownTicks: number;
  radiusMilliCells: number;
  buildTicks: number;
  mineralCost: number;
  gasCost: number;
  hasTurret: boolean;
  isStructure: boolean;
  projectileSpeedMilliCellsPerSecond: number;
}

function build(raw: RawUnitType, typeId: number): UnitType {
  return {
    id: raw.id,
    name: raw.name,
    typeId,
    maxHp: raw.hp | 0,
    // milli-cells per second -> cells per tick, in one exact division.
    speed: fromRatio(raw.speedMilliCellsPerSecond, MILLI * TICKS_PER_SECOND),
    sightRadius: fromRatio(raw.sightRadiusMilliCells, MILLI),
    attackRange: fromRatio(raw.attackRangeMilliCells, MILLI),
    damage: raw.damage | 0,
    cooldown: raw.cooldownTicks | 0,
    radius: fromRatio(raw.radiusMilliCells, MILLI),
    buildTicks: raw.buildTicks | 0,
    mineralCost: raw.mineralCost | 0,
    gasCost: raw.gasCost | 0,
    hasTurret: raw.hasTurret === true,
    isStructure: raw.isStructure === true,
    projectileSpeed: fromRatio(raw.projectileSpeedMilliCellsPerSecond, MILLI * TICKS_PER_SECOND),
    canAttack: (raw.damage | 0) > 0 && (raw.attackRangeMilliCells | 0) > 0,
  };
}

/** Type ids are array indices, and the order in units.json is part of the
 * determinism contract: reordering the file changes every replay. */
export const UNIT_TYPES: readonly UnitType[] = (rawTable.types as RawUnitType[]).map(build);

const BY_ID = new Map(UNIT_TYPES.map((type) => [type.id, type]));

export function unitTypeById(id: string): UnitType {
  const type = BY_ID.get(id);
  if (!type) throw new Error(`unknown unit type "${id}"`);
  return type;
}

export function unitType(typeId: number): UnitType {
  const type = UNIT_TYPES[typeId];
  if (!type) throw new Error(`unknown unit type id ${typeId}`);
  return type;
}

export const UNIT_TYPE_COUNT = UNIT_TYPES.length;
