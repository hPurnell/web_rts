/**
 * Unit rendering.
 *
 * One thin-instance buffer per unit type per part, so 2,000 units cost a
 * handful of draw calls rather than 2,000. Hull and turret are separate
 * buffers because the turret tracks its target independently of where the hull
 * is pointing — that is also why there is no skinning anywhere: every unit is
 * rigid parts, which M28 formalises as the asset convention.
 *
 * Positions are interpolated between the last two simulation ticks. At 20Hz a
 * unit moves a visible distance per tick, so without interpolation movement
 * reads as stepping rather than walking.
 */
// Side-effect import: Babylon's tree-shaken build only installs the
// thinInstance* methods on Mesh when this module is pulled in. Without it the
// meshes render nothing and say nothing about why.
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { buildPartMesh } from './models.ts';
import type { LoadedModel } from './models.ts';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import type { Match } from '../sim/match.ts';
import type { World } from '../sim/world.ts';
import { cellFromWorld } from '../sim/world.ts';
import { isVisible } from '../sim/fog.ts';
import { UNIT_TYPES } from '../sim/unittypes.ts';
import { AirState, UnitState } from '../sim/units.ts';
import { toFloat } from '../sim/fixed.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { cellCornerY } from './terrain.ts';

/** Player colours, indexed by owner id. */
/**
 * How far a unit's footing moves toward the ground beneath it each frame.
 *
 * Low enough that cresting a ridge is a lean rather than a flick, high enough
 * that a unit does not visibly lag the ground it is standing on.
 */
const NORMAL_BLEND = 0.18;

export const PLAYER_COLORS: readonly Color3[] = [
  new Color3(0.29, 0.56, 0.93),
  new Color3(0.91, 0.35, 0.31),
  new Color3(0.35, 0.78, 0.45),
  new Color3(0.85, 0.66, 0.24),
  new Color3(0.66, 0.42, 0.86),
  new Color3(0.31, 0.76, 0.8),
  new Color3(0.93, 0.53, 0.27),
  new Color3(0.8, 0.8, 0.85),
];

/** Placeholder proportions, replaced wholesale in M29. */
interface PartShape {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly lift: number;
}

function hullShape(radius: number, footprint = 0): PartShape {
  if (footprint > 0) {
    // A structure fills its footprint and stands tall enough to read as a
    // building rather than a very large tank.
    const side = footprint * 0.85;
    const height = footprint * 0.8;
    return { width: side, height, depth: side, lift: height / 2 };
  }
  const size = radius * 2;
  return { width: size, height: size * 0.7, depth: size * 1.25, lift: size * 0.35 };
}

function turretShape(radius: number): PartShape {
  const size = radius * 1.1;
  return { width: size, height: size * 0.55, depth: size * 1.15, lift: radius * 1.05 };
}

/** A rotor's mesh and the buffer its instances are written into. */
interface RotorGroup {
  readonly mesh: Mesh;
  readonly offset: { x: number; y: number; z: number };
  data: Float32Array;
}

interface InstanceGroup {
  readonly hull: Mesh;
  /** Null for types whose weapon does not rotate, such as workers. */
  readonly turret: Mesh | null;
  /** How far above the ground each part's origin sits, in world units. */
  readonly hullLift: number;
  readonly turretLift: number;
  /** How strongly the player colour tints this group, 0 none to 1 fully. */
  readonly tintStrength: number;
  /** Spinning parts. Empty for everything that does not fly. */
  readonly rotors: RotorGroup[];
  /** True for types that fly: they bank instead of leaning on the ground. */
  readonly isAircraft: boolean;
  /** Scratch buffers, grown on demand and reused between frames. */
  hullData: Float32Array;
  turretData: Float32Array;
  /** Per-instance RGBA, so one mesh serves every player. */
  colorData: Float32Array;
  count: number;
}

export interface UnitRenderer {
  /**
   * Write instance matrices for the current frame.
   * `alpha` is the driver's interpolation factor, 0..1.
   * `localPlayer` decides what fog hides; pass -1 to see everything.
   */
  update(
    match: Match,
    world: World,
    overrides: HeightOverrides | null,
    alpha: number,
    localPlayer?: number,
  ): void;
  /** Remember this tick's positions as the basis for interpolation. */
  captureTick(match: Match): void;
  /** Live instances written by the last update, for the dev overlay. */
  instanceCount(): number;
  /** Hide everything, e.g. when a match ends. */
  clear(): void;
  dispose(): void;
}

const FLOATS_PER_MATRIX = 16;

/**
 * How much of the player colour a textured model takes.
 *
 * Enough to tell two armies apart at a glance, little enough that the art still
 * looks like the vehicle it is. Placeholder boxes keep the full colour, because
 * a box has nothing else to look at.
 */
const MODEL_TINT = 0.3;

// --- flight attitude -------------------------------------------------------
// Gains chosen by eye against the source game rather than derived: a Comanche
// accelerating hard should read as clearly nose-down without looking like it
// is diving, and a hard turn should roll it well over but not knife-edge.
/** Radians of roll per world-unit-per-tick of lateral acceleration. */
const BANK_PER_ACCEL = 260;
/** Radians of nose-down pitch per unit of along-track acceleration. */
const PITCH_PER_ACCEL = 150;
const MAX_BANK = 0.55;
const MAX_PITCH = 0.32;
/** How fast the attitude eases toward the wanted one, per frame. */
const ATTITUDE_BLEND = 0.12;

/** Rotor revolutions per second while flying. */
const ROTOR_SPEED = 5.5;
/** How fast the rotor spools up and down, as a fraction per second. */
const ROTOR_SPOOL = 1.6;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function makePart(
  scene: Scene,
  name: string,
  shape: PartShape,
  material: StandardMaterial,
): Mesh {
  const mesh = CreateBox(
    name,
    { width: shape.width, height: shape.height, depth: shape.depth },
    scene,
  );
  mesh.material = material;
  mesh.isPickable = false;
  mesh.thinInstanceEnablePicking = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.setEnabled(false);
  return mesh;
}

export function createUnitRenderer(scene: Scene, models?: ReadonlyMap<string, LoadedModel>): UnitRenderer {
  // One material for every unit. Player colour rides on a per-instance colour
  // buffer instead of a material per player, so the draw-call count depends on
  // how many unit *types* are on screen and not on how many players are in the
  // match — six types across eight players is eight draws, not forty-eight.
  const material = new StandardMaterial('unit', scene);
  material.diffuseColor = new Color3(1, 1, 1);
  material.emissiveColor = new Color3(0.22, 0.22, 0.22);
  material.specularColor = new Color3(0.15, 0.15, 0.16);

  /**
   * One group per unit type; owner is a per-instance colour.
   *
   * A registered model replaces the placeholder box for that type and brings
   * its own material. The draw-call count does not move: it was one per type
   * per part before and it is one per type per part now, because a model still
   * draws as a single thin-instanced mesh.
   */
  const groups: InstanceGroup[] = UNIT_TYPES.map((type, typeId) => {
    const radius = toFloat(type.radius);
    const model = models?.get(type.id);
    return {
      hull: model
        ? buildPartMesh(scene, `hull_t${typeId}`, model.hull)
        : makePart(scene, `hull_t${typeId}`, hullShape(radius, type.footprint), material),
      turret: model?.turret
        ? buildPartMesh(scene, `turret_t${typeId}`, model.turret)
        : type.hasTurret && !model
          ? makePart(scene, `turret_t${typeId}`, turretShape(radius), material)
          : null,
      // A model's parts are already positioned relative to the ground and to
      // the turret pivot by the pipeline, so they need no extra lift.
      hullLift: model ? 0 : hullShape(radius, type.footprint).lift,
      turretLift: model ? model.turretOffsetY : turretShape(radius).lift,
      tintStrength: model ? MODEL_TINT : 1,
      rotors: (model?.rotors ?? []).map((rotor, r) => ({
        mesh: buildPartMesh(scene, `rotor${r}_t${typeId}`, rotor.part),
        offset: rotor.offset,
        data: new Float32Array(0),
      })),
      isAircraft: type.isAircraft,
      hullData: new Float32Array(0),
      turretData: new Float32Array(0),
      colorData: new Float32Array(0),
      count: 0,
    };
  });

  // Previous-tick positions, so a frame can interpolate rather than snap.
  let prevX = new Int32Array(0);
  let prevZ = new Int32Array(0);
  let prevFacing = new Int32Array(0);
  let prevAltitude = new Int32Array(0);
  // Previous-tick velocity, which is where a helicopter's attitude comes from:
  // the change between two ticks is its acceleration, and banking and pitching
  // are that acceleration made visible.
  let prevVelX = new Int32Array(0);
  let prevVelZ = new Int32Array(0);
  let prevTick = -1;
  let written = 0;

  // Smoothed flight attitude, one per unit slot, and the rotor's phase.
  // Render-only, like the terrain normals below: none of it is simulation
  // state, and putting it there would mean hashing two arrays for a look.
  let bank = new Float32Array(0);
  let pitch = new Float32Array(0);
  let rotorPhase = new Float32Array(0);
  let spool = new Float32Array(0);
  let lastFrame = 0;

  // Smoothed terrain normals, one per unit slot. Render-only state, so plain
  // floats: nothing here reaches the simulation or the state hash.
  let normalX = new Float32Array(0);
  let normalY = new Float32Array(0);
  let normalZ = new Float32Array(0);

  /** Grow the normal arrays, starting new slots upright rather than at zero. */
  const growNormals = (count: number): void => {
    const size = Math.max(16, count * 2);
    const nx = new Float32Array(size);
    const ny = new Float32Array(size).fill(1);
    const nz = new Float32Array(size);
    nx.set(normalX);
    ny.set(normalY.subarray(0, Math.min(normalY.length, size)));
    nz.set(normalZ);
    // A slot that has never been written must start upright, not flat-zero,
    // or a newly spawned unit's first frame has no basis at all.
    for (let i = normalY.length; i < size; i++) ny[i] = 1;
    normalX = nx;
    normalY = ny;
    normalZ = nz;
  };

  /**
   * Grow the per-unit attitude arrays.
   *
   * `attitude` is only a length marker for the three that travel together;
   * they are separate arrays for the same reason the normals are.
   */
  let attitude = new Float32Array(0);
  const growAttitude = (count: number): void => {
    const size = Math.max(16, count * 2);
    const next = new Float32Array(size);
    const nextBank = new Float32Array(size);
    const nextPitch = new Float32Array(size);
    const nextPhase = new Float32Array(size);
    const nextSpool = new Float32Array(size);
    nextBank.set(bank);
    nextPitch.set(pitch);
    nextPhase.set(rotorPhase);
    nextSpool.set(spool);
    // Start each rotor at its own angle, so a flight of helicopters does not
    // beat in unison like one machine.
    for (let i = rotorPhase.length; i < size; i++) nextPhase[i] = (i * 2.399963) % (Math.PI * 2);
    attitude = next;
    bank = nextBank;
    pitch = nextPitch;
    rotorPhase = nextPhase;
    spool = nextSpool;
    if (normalX.length < size) growNormals(size);
  };

  const ensure = (group: InstanceGroup, needed: number): void => {
    const floats = needed * FLOATS_PER_MATRIX;
    if (group.hullData.length >= floats) return;
    // Grow in powers of two so a steadily rising army does not reallocate
    // every single frame.
    let size = Math.max(16, group.hullData.length / FLOATS_PER_MATRIX || 16);
    while (size < needed) size *= 2;
    group.hullData = new Float32Array(size * FLOATS_PER_MATRIX);
    group.turretData = new Float32Array(size * FLOATS_PER_MATRIX);
    for (const rotor of group.rotors) rotor.data = new Float32Array(size * FLOATS_PER_MATRIX);
    group.colorData = new Float32Array(size * 4);
  };

  /**
   * Write a translation-plus-Y-rotation matrix directly.
   *
   * Composing a Matrix per unit per frame allocates and costs more than the
   * arithmetic does; a unit only ever yaws, so eight of the sixteen entries
   * are constant.
   */
  /**
   * One instance matrix: a yaw about the terrain normal rather than about Y.
   *
   * On flat ground `up` is (0,1,0) and this reduces exactly to the yaw-only
   * matrix it replaces. On a hillside the unit leans into the slope, which is
   * the single largest visual difference continuous terrain makes: a box
   * standing bolt upright on a 30-degree hill is immediately wrong in a way
   * that nothing else about the terrain is.
   */
  const writeMatrix = (
    out: Float32Array,
    offset: number,
    x: number,
    y: number,
    z: number,
    sin: number,
    cos: number,
    upX: number,
    upY: number,
    upZ: number,
  ): void => {
    // Forward is the heading with the component along `up` removed, so the
    // unit still faces where it is going after being tilted.
    const dot = sin * upX + cos * upZ;
    let fx = sin - upX * dot;
    let fy = -upY * dot;
    let fz = cos - upZ * dot;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen;
    fy /= flen;
    fz /= flen;

    // Right = up x forward, which on flat ground gives (cos, 0, -sin) — the
    // first row of the matrix this replaced.
    const rx = upY * fz - upZ * fy;
    const ry = upZ * fx - upX * fz;
    const rz = upX * fy - upY * fx;

    out[offset] = rx;
    out[offset + 1] = ry;
    out[offset + 2] = rz;
    out[offset + 3] = 0;
    out[offset + 4] = upX;
    out[offset + 5] = upY;
    out[offset + 6] = upZ;
    out[offset + 7] = 0;
    out[offset + 8] = fx;
    out[offset + 9] = fy;
    out[offset + 10] = fz;
    out[offset + 11] = 0;
    out[offset + 12] = x;
    out[offset + 13] = y;
    out[offset + 14] = z;
    out[offset + 15] = 1;
  };

  /**
   * One rotor instance: the hull's frame, then a hub offset and a spin.
   *
   * The offset is rotated by the hull's own basis rather than added in world
   * axes. A helicopter banked thirty degrees still carries its mast
   * perpendicular to its deck, and adding the offset in world Y would leave
   * the disc hanging in the air beside the aircraft.
   */
  const writeRotor = (
    out: Float32Array,
    offset: number,
    x: number,
    y: number,
    z: number,
    sin: number,
    cos: number,
    upX: number,
    upY: number,
    upZ: number,
    hub: { x: number; y: number; z: number },
    phase: number,
  ): void => {
    // The same basis `writeMatrix` builds, so the two parts agree exactly.
    const dot = sin * upX + cos * upZ;
    let fx = sin - upX * dot;
    let fy = -upY * dot;
    let fz = cos - upZ * dot;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen;
    fy /= flen;
    fz /= flen;
    const rx = upY * fz - upZ * fy;
    const ry = upZ * fx - upX * fz;
    const rz = upX * fy - upY * fx;

    // Spin about the mast, which is the hull's up axis.
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    // Rotor basis = hull basis pre-rotated about up by the phase.
    const arx = rx * c + fx * s;
    const ary = ry * c + fy * s;
    const arz = rz * c + fz * s;
    const afx = fx * c - rx * s;
    const afy = fy * c - ry * s;
    const afz = fz * c - rz * s;

    out[offset] = arx;
    out[offset + 1] = ary;
    out[offset + 2] = arz;
    out[offset + 3] = 0;
    out[offset + 4] = upX;
    out[offset + 5] = upY;
    out[offset + 6] = upZ;
    out[offset + 7] = 0;
    out[offset + 8] = afx;
    out[offset + 9] = afy;
    out[offset + 10] = afz;
    out[offset + 11] = 0;
    out[offset + 12] = x + rx * hub.x + upX * hub.y + fx * hub.z;
    out[offset + 13] = y + ry * hub.x + upY * hub.y + fy * hub.z;
    out[offset + 14] = z + rz * hub.x + upZ * hub.y + fz * hub.z;
    out[offset + 15] = 1;
  };

  return {
    captureTick(match) {
      const units = match.units;
      if (prevX.length < units.count) {
        prevX = new Int32Array(units.posX.length);
        prevZ = new Int32Array(units.posZ.length);
        prevFacing = new Int32Array(units.facing.length);
        prevAltitude = new Int32Array(units.altitude.length);
        prevVelX = new Int32Array(units.velX.length);
        prevVelZ = new Int32Array(units.velZ.length);
      }
      prevX.set(units.posX);
      prevZ.set(units.posZ);
      prevFacing.set(units.facing);
      prevAltitude.set(units.altitude);
      prevVelX.set(units.velX);
      prevVelZ.set(units.velZ);
      prevTick = match.tick;
    },

    instanceCount: () => written,

    update(match, world, overrides, alpha, localPlayer = -1) {
      const units = match.units;
      // Before the first captured tick there is nothing to interpolate from.
      const blend = prevTick >= 0 ? Math.max(0, Math.min(1, alpha)) : 1;

      // Seconds since the last frame, for the one thing here that runs on
      // wall-clock time rather than on ticks: the rotor. It has to look right
      // at any frame rate and it feeds nothing back into the simulation, so a
      // real clock is the honest source. Clamped so a stalled tab does not
      // spin the blades through a thousand revolutions on the next frame.
      const now = performance.now();
      const dt = lastFrame === 0 ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;

      for (const group of groups) group.count = 0;

      const hidden = (index: number): boolean => {
        if (localPlayer < 0) return false;
        if (units.ownerId[index] === localPlayer) return false;
        const cell = cellFromWorld(
          world,
          units.posX[index] as number,
          units.posZ[index] as number,
        );
        // An enemy unit exists only where you can currently see it. Explored
        // ground is not enough: that is what makes scouting matter.
        return !isVisible(match.fog, localPlayer, cell);
      };

      for (let i = 0; i < units.count; i++) {
        if (units.isAlive[i] !== 1) continue;
        if (hidden(i)) continue;
        const group = groups[units.typeId[i] as number];
        if (!group) continue;
        group.count++;
      }

      for (const group of groups) {
        if (group.count > 0) ensure(group, group.count);
        group.count = 0;
      }

      written = 0;
      for (let i = 0; i < units.count; i++) {
        if (units.isAlive[i] !== 1) continue;
        if (hidden(i)) continue;
        const group = groups[units.typeId[i] as number];
        if (!group) continue;

        const nowX = toFloat(units.posX[i] as number);
        const nowZ = toFloat(units.posZ[i] as number);
        const fromX = prevTick >= 0 ? toFloat(prevX[i] as number) : nowX;
        const fromZ = prevTick >= 0 ? toFloat(prevZ[i] as number) : nowZ;
        const x = fromX + (nowX - fromX) * blend;
        const z = fromZ + (nowZ - fromZ) * blend;

        const nowFacing = toFloat(units.facing[i] as number);
        const fromFacing = prevTick >= 0 ? toFloat(prevFacing[i] as number) : nowFacing;
        // Interpolate the short way round, or a unit crossing the wrap point
        // spins the long way once per lap.
        let delta = nowFacing - fromFacing;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const facing = fromFacing + delta * blend;

        // The simulation's heading is `atan2(vz, vx)`: a unit travels along
        // (cos, sin). Every model points its nose along its own +X — the
        // Abrams's barrel runs to +1.36 there and -0.42 behind — and
        // `writeMatrix` sends model +X to (cos a, -sin a) for the angle a it
        // is given. So it is given the heading negated. Passing the heading
        // straight through mirrored every vehicle across its direction of
        // travel, which on anything not driving along the x axis reads as
        // skating sideways.
        const noseX = Math.cos(facing);
        const noseZ = Math.sin(facing);
        const sin = -noseZ;
        const cos = noseX;

        let y = groundHeightAt(world, overrides, x, z);

        if (attitude.length <= i) growAttitude(units.count);
        let upX: number;
        let upY: number;
        let upZ: number;

        if (group.isAircraft) {
          // An aircraft flies at an altitude the simulation owns, interpolated
          // like its position so a climb is smooth between ticks.
          const fromAltitude = toFloat(prevAltitude[i] as number);
          y += fromAltitude + (toFloat(units.altitude[i] as number) - fromAltitude) * blend;

          // Attitude comes from acceleration, not from an animation. The
          // change in velocity over the last tick, split into the component
          // along the heading and the one across it, is exactly what a
          // helicopter leans against: it noses down to accelerate and rolls
          // into a turn. Because the simulation rate-limits both, this is a
          // real quantity rather than a guess.
          const ax = toFloat((units.velX[i] as number) - (prevVelX[i] as number));
          const az = toFloat((units.velZ[i] as number) - (prevVelZ[i] as number));
          // Along the nose, and across it toward the left: in this left-handed
          // world, facing +x with y up, +z is on your left.
          const along = ax * noseX + az * noseZ;
          const across = -ax * noseZ + az * noseX;

          const wantBank = clamp(across * BANK_PER_ACCEL, -MAX_BANK, MAX_BANK);
          const wantPitch = clamp(along * PITCH_PER_ACCEL, -MAX_PITCH, MAX_PITCH);
          bank[i] = (bank[i] as number) + (wantBank - (bank[i] as number)) * ATTITUDE_BLEND;
          pitch[i] = (pitch[i] as number) + (wantPitch - (pitch[i] as number)) * ATTITUDE_BLEND;

          // Tip the up vector. Accelerating forward puts the nose down, which
          // leans the rotor disc — and so the up vector — toward the nose;
          // accelerating to the left rolls it that way, leaning up toward the
          // left. `writeMatrix` re-orthogonalises the heading against it, so
          // this is enough to describe the whole attitude.
          const sinBank = Math.sin(bank[i] as number);
          const sinPitch = Math.sin(pitch[i] as number);
          upX = noseX * sinPitch - noseZ * sinBank;
          upY = Math.cos(bank[i] as number) * Math.cos(pitch[i] as number);
          upZ = noseZ * sinPitch + noseX * sinBank;
          const len = Math.hypot(upX, upY, upZ) || 1;
          upX /= len;
          upY /= len;
          upZ /= len;
          normalX[i] = upX;
          normalY[i] = upY;
          normalZ[i] = upZ;
        } else {
          // Blend the normal toward the ground rather than snapping to it. A
          // unit crossing a ridge changes its footing over one frame, and
          // without this the model visibly flicks over as it crests.
          const sampled = terrainNormalAt(world, overrides, x, z);
          upX = (normalX[i] as number) + (sampled.x - (normalX[i] as number)) * NORMAL_BLEND;
          upY = (normalY[i] as number) + (sampled.y - (normalY[i] as number)) * NORMAL_BLEND;
          upZ = (normalZ[i] as number) + (sampled.z - (normalZ[i] as number)) * NORMAL_BLEND;
          const upLen = Math.hypot(upX, upY, upZ) || 1;
          upX /= upLen;
          upY /= upLen;
          upZ /= upLen;
          normalX[i] = upX;
          normalY[i] = upY;
          normalZ[i] = upZ;
        }

        const offset = group.count * FLOATS_PER_MATRIX;
        writeMatrix(group.hullData, offset, x, y + group.hullLift, z, sin, cos, upX, upY, upZ);
        if (group.turret) {
          // The turret shares the hull's footing, so it leans with it.
          writeMatrix(
            group.turretData,
            offset,
            x,
            y + group.turretLift,
            z,
            sin,
            cos,
            upX,
            upY,
            upZ,
          );
        }

        for (const rotor of group.rotors) {
          // Spin rate follows the flight state rather than being constant: a
          // parked helicopter's rotor is stopped, and it spools up before it
          // lifts rather than the instant it is told to.
          const wanted =
            (units.airState[i] as number) === AirState.Grounded &&
            (units.state[i] as number) === UnitState.Idle
              ? 0
              : 1;
          const current = spool[i] as number;
          spool[i] = current + clamp(wanted - current, -ROTOR_SPOOL * dt, ROTOR_SPOOL * dt);
          rotorPhase[i] =
            ((rotorPhase[i] as number) + (spool[i] as number) * ROTOR_SPEED * Math.PI * 2 * dt) %
            (Math.PI * 2);

          // The disc rides on the hull, so it is placed by the hull's own
          // frame: the offset is rotated by the attitude rather than added in
          // world axes, or the rotor slides off the mast whenever it banks.
          writeRotor(rotor.data, offset, x, y, z, sin, cos, upX, upY, upZ, rotor.offset, rotorPhase[i] as number);
        }

        // The instance colour multiplies the material, which is how one mesh
        // serves every player. A placeholder box wants the player colour at
        // full strength; a textured model does not — multiplying desert tan by
        // saturated blue gives a near-black vehicle, which is exactly what it
        // looked like. Models get the colour pulled most of the way to white,
        // so the art reads and the team is still legible.
        const color = PLAYER_COLORS[units.ownerId[i] as number] ?? PLAYER_COLORS[0];
        const tint = group.tintStrength;
        const colorOffset = group.count * 4;
        group.colorData[colorOffset] = 1 - tint * (1 - (color?.r ?? 1));
        group.colorData[colorOffset + 1] = 1 - tint * (1 - (color?.g ?? 1));
        group.colorData[colorOffset + 2] = 1 - tint * (1 - (color?.b ?? 1));
        group.colorData[colorOffset + 3] = 1;

        group.count++;
        written++;
      }

      for (const group of groups) {
        if (group.count === 0) {
          group.hull.setEnabled(false);
          group.turret?.setEnabled(false);
          for (const rotor of group.rotors) rotor.mesh.setEnabled(false);
          continue;
        }
        group.hull.thinInstanceSetBuffer('matrix', group.hullData, FLOATS_PER_MATRIX, false);
        group.hull.thinInstanceSetBuffer('color', group.colorData, 4, false);
        group.hull.thinInstanceCount = group.count;
        group.hull.setEnabled(true);
        if (group.turret) {
          group.turret.thinInstanceSetBuffer('matrix', group.turretData, FLOATS_PER_MATRIX, false);
          group.turret.thinInstanceSetBuffer('color', group.colorData, 4, false);
          group.turret.thinInstanceCount = group.count;
          group.turret.setEnabled(true);
        }
        for (const rotor of group.rotors) {
          rotor.mesh.thinInstanceSetBuffer('matrix', rotor.data, FLOATS_PER_MATRIX, false);
          rotor.mesh.thinInstanceSetBuffer('color', group.colorData, 4, false);
          rotor.mesh.thinInstanceCount = group.count;
          rotor.mesh.setEnabled(true);
        }
      }
    },

    clear() {
      written = 0;
      prevTick = -1;
      for (const group of groups) {
        group.count = 0;
        group.hull.setEnabled(false);
        group.turret?.setEnabled(false);
        for (const rotor of group.rotors) rotor.mesh.setEnabled(false);
      }
    },

    dispose() {
      for (const group of groups) {
        group.hull.dispose();
        group.turret?.dispose();
        for (const rotor of group.rotors) rotor.mesh.dispose();
      }
      material.dispose();
    },
  };
}

/**
 * Terrain normal under a world-space point.
 *
 * Central differences over the rendered surface rather than the per-corner
 * normal table, because a unit stands between corners and sampling the table
 * would step at each cell boundary. Half a cell either side is wide enough to
 * ignore the triangle split and narrow enough to follow a hillside.
 */
export function terrainNormalAt(
  world: World,
  overrides: HeightOverrides | null,
  x: number,
  z: number,
): { x: number; y: number; z: number } {
  const e = toFloat(world.cellSize) / 2;
  const dx = groundHeightAt(world, overrides, x + e, z) - groundHeightAt(world, overrides, x - e, z);
  const dz = groundHeightAt(world, overrides, x, z + e) - groundHeightAt(world, overrides, x, z - e);
  const nx = -dx;
  const ny = 2 * e;
  const nz = -dz;
  const length = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / length, y: ny / length, z: nz / length };
}

/** Terrain height under a world-space point, following ramp slopes. */
export function groundHeightAt(world: World, overrides: HeightOverrides | null, x: number, z: number): number {
  const cellSize = toFloat(world.cellSize);
  const cell = cellFromWorld(world, Math.round(x * 65536), Math.round(z * 65536));
  if (cell < 0) return 0;
  const h = cellCornerY(world, cell, overrides);
  // Bilinear across the cell, so a unit walking a ramp rises smoothly rather
  // than stepping at each cell boundary.
  const fx = x / cellSize - Math.floor(x / cellSize);
  const fz = z / cellSize - Math.floor(z / cellSize);
  const north = (h[0] as number) + ((h[1] as number) - (h[0] as number)) * fx;
  const south = (h[3] as number) + ((h[2] as number) - (h[3] as number)) * fx;
  return north + (south - north) * fz;
}
