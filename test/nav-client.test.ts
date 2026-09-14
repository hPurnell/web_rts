import { describe, expect, it, vi } from 'vitest';
import { createNavClient } from '../src/nav/client.ts';
import type { NavTransport } from '../src/nav/client.ts';
import type { WorkerRequest, WorkerResponse } from '../src/nav/protocol.ts';
import { createCostGrid, gridFromSnapshot } from '../src/nav/grid.ts';
import { computeFlowField } from '../src/nav/flowfield.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import type { CostGrid } from '../src/nav/grid.ts';

/**
 * A transport that runs the real worker logic in-process, but only when told
 * to flush — so a test can hold several requests in flight at once and see
 * exactly how many reached the worker.
 */
function fakeTransport() {
  const sent: WorkerRequest[] = [];
  let handler: ((message: WorkerResponse) => void) | null = null;
  let grid: CostGrid | null = null;
  let solves = 0;

  const transport: NavTransport = {
    post: (message) => sent.push(message),
    onMessage: (h) => {
      handler = h;
    },
    terminate: () => {},
  };

  const flush = (): void => {
    const queue = sent.splice(0, sent.length);
    for (const message of queue) {
      if (message.type === 'grid') {
        grid = gridFromSnapshot(message.grid);
        continue;
      }
      if (!grid || grid.version !== message.gridVersion) {
        handler?.({ type: 'stale', requestId: message.requestId, gridVersion: grid?.version ?? -1 });
        continue;
      }
      solves++;
      const field = computeFlowField(grid, message.goalCell);
      handler?.({
        type: 'solved',
        requestId: message.requestId,
        goalCell: message.goalCell,
        gridVersion: field.gridVersion,
        width: field.width,
        height: field.height,
        flow: field.flow.buffer as ArrayBuffer,
        integration: field.integration.buffer as ArrayBuffer,
        solveMs: 3.5,
      });
    }
  };

  return {
    transport,
    flush,
    pendingMessages: () => sent.length,
    solveCount: () => solves,
  };
}

describe('nav client', () => {
  it('solves a goal and caches the result', async () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const fake = fakeTransport();
    const client = createNavClient(fake.transport);
    client.setGrid(grid);
    fake.flush();

    const promise = client.request(100);
    expect(client.pendingCount()).toBe(1);
    fake.flush();
    const field = await promise;

    expect(field).not.toBeNull();
    expect(field?.goalCell).toBe(100);
    expect(client.cacheSize()).toBe(1);
    expect(client.cached(100)).toBe(field);
    expect(client.lastSolveMs()).toBe(3.5);
  });

  it('coalesces concurrent requests for the same goal into one solve', async () => {
    // Ordering fifty units to one place must cost one field, not fifty.
    const grid = createCostGrid(createTestMap());
    const fake = fakeTransport();
    const client = createNavClient(fake.transport);
    client.setGrid(grid);
    fake.flush();

    const promises = Array.from({ length: 50 }, () => client.request(250));
    expect(client.pendingCount()).toBe(1);
    expect(fake.pendingMessages()).toBe(1);

    fake.flush();
    const fields = await Promise.all(promises);
    expect(fake.solveCount()).toBe(1);
    // And every caller got the same field object.
    for (const field of fields) expect(field).toBe(fields[0]);
  });

  it('does not coalesce different goals', async () => {
    const grid = createCostGrid(createTestMap());
    const fake = fakeTransport();
    const client = createNavClient(fake.transport);
    client.setGrid(grid);
    fake.flush();

    const promises = [client.request(100), client.request(200), client.request(300)];
    expect(client.pendingCount()).toBe(3);
    fake.flush();
    await Promise.all(promises);
    expect(fake.solveCount()).toBe(3);
  });

  it('answers a repeated goal from cache without touching the worker', async () => {
    const grid = createCostGrid(createTestMap());
    const fake = fakeTransport();
    const client = createNavClient(fake.transport);
    client.setGrid(grid);
    fake.flush();

    const first = await (async () => {
      const p = client.request(500);
      fake.flush();
      return p;
    })();
    const second = await client.request(500);

    expect(second).toBe(first);
    expect(fake.solveCount()).toBe(1);
    expect(fake.pendingMessages()).toBe(0);
  });

  it('evicts the least recently used field', async () => {
    const grid = createCostGrid(createTestMap());
    const fake = fakeTransport();
    const client = createNavClient(fake.transport, 3);
    client.setGrid(grid);
    fake.flush();

    const solve = async (goal: number) => {
      const p = client.request(goal);
      fake.flush();
      return p;
    };

    await solve(10);
    await solve(20);
    await solve(30);
    expect(client.cacheSize()).toBe(3);

    // Touching 10 makes 20 the oldest.
    await client.request(10);
    await solve(40);
    expect(client.cacheSize()).toBe(3);
    expect(client.cached(20)).toBeNull();
    expect(client.cached(10)).not.toBeNull();
    expect(client.cached(40)).not.toBeNull();
  });

  it('throws away the cache when the terrain changes', async () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const fake = fakeTransport();
    const client = createNavClient(fake.transport);
    client.setGrid(grid);
    fake.flush();

    const p = client.request(100);
    fake.flush();
    await p;
    expect(client.cacheSize()).toBe(1);

    // Every cached field was solved against terrain that no longer exists.
    grid.version++;
    client.setGrid(grid);
    expect(client.cacheSize()).toBe(0);
  });

  it('resolves null rather than hanging when the worker is behind', async () => {
    const grid = createCostGrid(createTestMap());
    const fake = fakeTransport();
    const client = createNavClient(fake.transport);
    client.setGrid(grid);
    fake.flush();

    // Bump the version without telling the worker.
    grid.version += 5;
    client.setGrid(grid);
    const stalePromise = client.request(100);
    // Drop the grid message so the worker stays on the old version.
    fake.flush();
    const field = await stalePromise;
    expect(field).not.toBeNull(); // the grid message was delivered first

    // Now genuinely desynchronise the client from the worker.
    const client2 = createNavClient(fake.transport);
    const orphan = client2.request(100);
    fake.flush();
    expect(await orphan).toBeNull();
  });

  it('resolves outstanding requests when disposed', async () => {
    const grid = createCostGrid(createTestMap());
    const fake = fakeTransport();
    const terminate = vi.fn();
    const client = createNavClient({ ...fake.transport, terminate });
    client.setGrid(grid);
    fake.flush();

    const promise = client.request(100);
    client.dispose();
    expect(await promise).toBeNull();
    expect(terminate).toHaveBeenCalled();
    expect(client.pendingCount()).toBe(0);
  });
});
