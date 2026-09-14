/**
 * The pathfinding worker.
 *
 * Holds the current cost grid and solves flow fields on request. Keeping this
 * off the main thread is the whole point: a 256x256 field is single-digit
 * milliseconds, which is a visible hitch if it lands inside a frame.
 */
/// <reference lib="webworker" />
import { gridFromSnapshot } from './grid.ts';
import type { CostGrid } from './grid.ts';
import { computeFlowField } from './flowfield.ts';
import type { SolvedMessage, StaleMessage, WorkerRequest } from './protocol.ts';

let grid: CostGrid | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const message = event.data;

  if (message.type === 'grid') {
    grid = gridFromSnapshot(message.grid);
    return;
  }

  if (message.type === 'solve') {
    if (!grid || grid.version !== message.gridVersion) {
      // The caller is working from a grid we do not have. Say so rather than
      // answering with a field solved against stale terrain.
      const stale: StaleMessage = {
        type: 'stale',
        requestId: message.requestId,
        gridVersion: grid?.version ?? -1,
      };
      self.postMessage(stale);
      return;
    }

    const started = performance.now();
    const field = computeFlowField(grid, message.goalCell);
    const solved: SolvedMessage = {
      type: 'solved',
      requestId: message.requestId,
      goalCell: message.goalCell,
      gridVersion: field.gridVersion,
      width: field.width,
      height: field.height,
      flow: field.flow.buffer as ArrayBuffer,
      integration: field.integration.buffer as ArrayBuffer,
      solveMs: performance.now() - started,
    };
    // Transfer rather than copy: a 256x256 field is 192KB.
    self.postMessage(solved, [solved.flow, solved.integration]);
  }
};
