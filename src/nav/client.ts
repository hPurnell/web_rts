/**
 * Main-thread side of the pathfinder.
 *
 * Two things matter here beyond posting messages. Concurrent requests for the
 * same goal are coalesced, because ordering fifty units to one place must
 * produce one field and not fifty; and solved fields are cached by goal, since
 * an army given the same destination twice should not pay for it twice.
 *
 * The transport is injected so this can be exercised without a real Worker.
 */
import type { CostGrid } from './grid.ts';
import { snapshotCostGrid } from './grid.ts';
import type { FlowField } from './flowfield.ts';
import { NO_DIRECTION, UNREACHABLE } from './flowfield.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

/** Fields kept before the least recently used one is dropped. */
export const DEFAULT_CACHE_SIZE = 16;

export interface NavTransport {
  post(message: WorkerRequest, transfer?: Transferable[]): void;
  onMessage(handler: (message: WorkerResponse) => void): void;
  terminate(): void;
}

export interface NavClient {
  /** Send the current grid to the worker. Call after any terrain edit. */
  setGrid(grid: CostGrid): void;
  /**
   * Get the field for a goal. Resolves immediately from cache when possible,
   * and shares one in-flight request between callers asking for the same goal.
   */
  request(goalCell: number): Promise<FlowField | null>;
  /** The cached field for a goal, or null. Never blocks. */
  cached(goalCell: number): FlowField | null;
  pendingCount(): number;
  cacheSize(): number;
  /** Milliseconds the worker spent on the most recent solve. */
  lastSolveMs(): number;
  dispose(): void;
}

interface Pending {
  readonly goalCell: number;
  readonly promise: Promise<FlowField | null>;
  resolve(field: FlowField | null): void;
}

export function createNavClient(
  transport: NavTransport,
  cacheSize = DEFAULT_CACHE_SIZE,
): NavClient {
  let gridVersion = -1;
  let nextRequestId = 1;
  let lastSolveMs = 0;

  const pendingByRequest = new Map<number, Pending>();
  const pendingByGoal = new Map<number, Pending>();
  /** Insertion-ordered, so the first key is the least recently used. */
  const cache = new Map<number, FlowField>();

  transport.onMessage((message) => {
    const pending = pendingByRequest.get(message.requestId);
    if (!pending) return;
    pendingByRequest.delete(message.requestId);
    pendingByGoal.delete(pending.goalCell);

    if (message.type === 'stale') {
      // The worker is behind. Resolving null lets the caller retry next tick
      // rather than hang on a promise that will never settle.
      pending.resolve(null);
      return;
    }

    lastSolveMs = message.solveMs;
    const field: FlowField = {
      width: message.width,
      height: message.height,
      goalCell: message.goalCell,
      flow: new Int8Array(message.flow),
      integration: new Uint16Array(message.integration),
      gridVersion: message.gridVersion,
    };

    if (field.gridVersion === gridVersion) {
      cache.set(field.goalCell, field);
      while (cache.size > cacheSize) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    pending.resolve(field);
  });

  return {
    setGrid(grid) {
      gridVersion = grid.version;
      // Every cached field was solved against the old terrain.
      cache.clear();
      const snapshot = snapshotCostGrid(grid);
      transport.post({ type: 'grid', grid: snapshot }, [snapshot.cost, snapshot.links]);
    },

    request(goalCell) {
      const hit = cache.get(goalCell);
      if (hit) {
        // Refresh its position in the LRU order.
        cache.delete(goalCell);
        cache.set(goalCell, hit);
        return Promise.resolve(hit);
      }

      const inFlight = pendingByGoal.get(goalCell);
      if (inFlight) return inFlight.promise;

      const requestId = nextRequestId++;
      let resolve!: (field: FlowField | null) => void;
      const promise = new Promise<FlowField | null>((r) => {
        resolve = r;
      });
      const pending: Pending = { goalCell, promise, resolve };
      pendingByRequest.set(requestId, pending);
      pendingByGoal.set(goalCell, pending);

      transport.post({ type: 'solve', requestId, goalCell, gridVersion });
      return promise;
    },

    cached: (goalCell) => cache.get(goalCell) ?? null,
    pendingCount: () => pendingByRequest.size,
    cacheSize: () => cache.size,
    lastSolveMs: () => lastSolveMs,

    dispose() {
      for (const pending of pendingByRequest.values()) pending.resolve(null);
      pendingByRequest.clear();
      pendingByGoal.clear();
      cache.clear();
      transport.terminate();
    },
  };
}

/** Transport backed by a real Worker. */
export function createWorkerTransport(): NavTransport {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (handler) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => handler(event.data);
    },
    terminate: () => worker.terminate(),
  };
}

export { NO_DIRECTION, UNREACHABLE };
