/**
 * The message protocol between the main thread and the pathfinding worker.
 *
 * Everything crossing the boundary is either a plain number or a transferable
 * ArrayBuffer — no SharedArrayBuffer anywhere (invariant 6), because GitHub
 * Pages cannot send the headers that would make one work.
 */
import type { CostGridSnapshot } from './grid.ts';

export interface SetGridMessage {
  readonly type: 'grid';
  readonly grid: CostGridSnapshot;
}

export interface SolveMessage {
  readonly type: 'solve';
  readonly requestId: number;
  readonly goalCell: number;
  /** The grid version the caller believes the worker holds. */
  readonly gridVersion: number;
}

export type WorkerRequest = SetGridMessage | SolveMessage;

export interface SolvedMessage {
  readonly type: 'solved';
  readonly requestId: number;
  readonly goalCell: number;
  readonly gridVersion: number;
  readonly width: number;
  readonly height: number;
  /** Int8Array of direction indices. */
  readonly flow: ArrayBuffer;
  /** Uint16Array of accumulated costs. */
  readonly integration: ArrayBuffer;
  /** Milliseconds spent solving, for the dev overlay. */
  readonly solveMs: number;
}

export interface StaleMessage {
  readonly type: 'stale';
  readonly requestId: number;
  /** The version the worker actually holds. */
  readonly gridVersion: number;
}

export type WorkerResponse = SolvedMessage | StaleMessage;
