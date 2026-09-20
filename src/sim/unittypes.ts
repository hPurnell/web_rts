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
  /** Side of the square of cells a structure occupies; 0 for mobile units. */
  readonly footprint: number;
  /** Type ids this structure can produce. */
  readonly produces: readonly number[];

  /**
   * True for types that fly. An aircraft ignores the flow field, the
   * navigation grid and other units, carries an altitude, and has to take off
   * before it can go anywhere.
   */
  readonly isAircraft: boolean;
  /** Height it holds while airborne, in cells above the ground below it. */
  readonly cruiseAltitude: Fixed;
  /** Cells per tick it climbs and descends. */
  readonly climbRate: Fixed;
  /** Cells per tick per tick its speed may change by. */
  readonly acceleration: Fixed;
  /** Radians per tick it may turn by. */
  readonly turnRate: Fixed;
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
  footprintCells: number;
  produces: string[];
  isAircraft?: boolean;
  cruiseAltitudeMilliCells?: number;
  climbRateMilliCellsPerSecond?: number;
  accelerationMilliCellsPerSecondSq?: number;
  turnRateMilliRadiansPerSecond?: number;
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
    footprint: raw.footprintCells | 0,
    // Resolved by index rather than by name once the table is built, so the
    // simulation never carries strings across a tick.
    produces: (raw.produces ?? []).map((id) =>
      RAW_TYPES.findIndex((candidate) => candidate.id === id),
    ).filter((index) => index >= 0),

    isAircraft: raw.isAircraft === true,
    cruiseAltitude: fromRatio(raw.cruiseAltitudeMilliCells ?? 0, MILLI),
    climbRate: fromRatio(raw.climbRateMilliCellsPerSecond ?? 0, MILLI * TICKS_PER_SECOND),
    // Per tick per tick, so the rate divides by the tick rate twice.
    acceleration: fromRatio(
      raw.accelerationMilliCellsPerSecondSq ?? 0,
      MILLI * TICKS_PER_SECOND * TICKS_PER_SECOND,
    ),
    turnRate: fromRatio(raw.turnRateMilliRadiansPerSecond ?? 0, MILLI * TICKS_PER_SECOND),
  };
}

/** Type ids are array indices, and the order in units.json is part of the
 * determinism contract: reordering the file changes every replay. */
const RAW_TYPES = rawTable.types as RawUnitType[];

export const UNIT_TYPES: readonly UnitType[] = RAW_TYPES.map(build);

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
