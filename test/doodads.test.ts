/**
 * Moving scenery: flags that wave and lights that blink.
 *
 * The animation is baked to a matrix per frame by the pipeline, so what is
 * left to test here is playback — which frame a moment lands on, that each
 * copy runs at its own point in the loop, and that a hidden frame draws
 * nothing rather than something.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { createDoodads } from '../src/render/doodads.ts';
import type { AnimatedAsset } from '../src/render/doodads.ts';
import type { LoadedModel, LoadedPart } from '../src/render/models.ts';

function part(scene: Scene): LoadedPart {
  const vertexData = new VertexData();
  vertexData.positions = [0, 0, 0, 1, 0, 0, 0, 0, 1];
  vertexData.indices = [0, 1, 2];
  vertexData.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0];
  return { vertexData, material: new StandardMaterial('m', scene) };
}

/** An identity matrix translated by `y`, in thin-instance layout. */
function lifted(y: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1];
}

function setup(visible?: number[], placements = 1) {
  const scene = new Scene(new NullEngine());
  const model: LoadedModel = { hull: part(scene), turretOffsetY: 0, rotors: [] };
  // Four frames at one frame a second, the part rising a unit a frame.
  const asset: AnimatedAsset = {
    frames: 4,
    frameRate: 1,
    parts: [
      {
        part: part(scene),
        matrices: new Float32Array([...lifted(0), ...lifted(1), ...lifted(2), ...lifted(3)]),
        ...(visible ? { visible: new Uint8Array(visible) } : {}),
      },
    ],
  };
  const renderer = createDoodads(
    scene,
    new Map([['Flag', model]]),
    Array.from({ length: placements }, (_, i) => ({ type: 'Flag', x: i * 10, z: 0, angle: 0 })),
    () => 0,
    new Map([['Flag', [asset]]]),
  );
  const moving = scene.meshes.find((mesh) => mesh.name.includes('moving'));
  if (!moving) throw new Error('no moving part');
  const buffer = (): Float32Array =>
    (moving as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
  return { renderer, buffer };
}

describe('moving scenery', () => {
  it('steps through the baked frames rather than blending them', () => {
    const { renderer, buffer } = setup();
    renderer.update(0);
    expect(buffer()[13]).toBe(0);
    // Part-way through frame 1 is still frame 1: the source plays raw
    // animations without interpolating between frames.
    renderer.update(1.6);
    expect(buffer()[13]).toBe(1);
    renderer.update(3.2);
    expect(buffer()[13]).toBe(3);
  });

  it('loops', () => {
    const { renderer, buffer } = setup();
    renderer.update(4.1);
    expect(buffer()[13]).toBe(0);
  });

  it('rides on the placement', () => {
    const { renderer, buffer } = setup(undefined, 2);
    renderer.update(0);
    // The second copy stands ten along x, whatever frame it is on.
    expect(buffer()[16 + 12]).toBe(10);
  });

  it('starts each copy at its own point in the loop', () => {
    const { renderer, buffer } = setup(undefined, 2);
    renderer.update(0);
    // Two flags on one frame at the same moment would wave in step.
    expect(buffer()[13]).not.toBe(buffer()[16 + 13]);
  });

  it('draws nothing on a hidden frame', () => {
    const { renderer, buffer } = setup([1, 0, 1, 0]);
    renderer.update(1.5);
    expect([...buffer().slice(0, 16)].every((v) => v === 0)).toBe(true);
    renderer.update(2.5);
    expect(buffer()[15]).toBe(1);
  });
});
