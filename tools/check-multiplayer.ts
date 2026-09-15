/**
 * Two browsers playing a full match through the relay.
 *
 * This is M31's acceptance criterion, run for real: two independent pages,
 * each with its own simulation, connected by the same relay code the Durable
 * Object runs. They must reach the same tick with the same state hash, and
 * neither may report a desync.
 *
 * Usage: pnpm check:multiplayer
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createRelay, hashString } from '../src/net/room.ts';
import type { Relay, RelaySocket } from '../src/net/room.ts';
import { decodeMessage } from '../src/net/protocol.ts';
import type { ClientMessage } from '../src/net/protocol.ts';

const RELAY_PORT = 8799;
const VITE_PORT = 5188;
const MATCH_TICKS = 400;

function findChromium(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const candidates: string[] = [];
  for (const dir of readdirSync(cache)) {
    candidates.push(
      join(cache, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      join(cache, dir, 'chrome-linux64', 'chrome'),
    );
  }
  return candidates.find((c) => existsSync(c));
}

function startRelay(): WebSocketServer {
  const rooms = new Map<string, Relay>();
  const server = new WebSocketServer({ port: RELAY_PORT });

  server.on('connection', (socket: WebSocket, request) => {
    const matchId =
      new URL(request.url ?? '/', 'http://localhost').searchParams.get('match') ?? 'default';
    let relay = rooms.get(matchId);
    if (!relay) {
      relay = createRelay({ matchId, seed: hashString(matchId) });
      rooms.set(matchId, relay);
    }

    const wrapped: RelaySocket = { send: (data) => socket.send(data), close: () => socket.close() };
    let playerId = -1;
    socket.on('message', (raw: unknown) => {
      const text = String(raw);
      if (playerId < 0) {
        const message = decodeMessage(text);
        if (message) playerId = (relay as Relay).join(wrapped, message as ClientMessage);
        return;
      }
      (relay as Relay).receive(playerId, text);
    });
    const drop = (): void => {
      if (playerId >= 0) (relay as Relay).leave(playerId);
      playerId = -1;
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  return server;
}

interface ClientState {
  tick: number;
  hash: number;
  halted: string | null;
  players: number[];
  playerId: number;
}

async function readState(page: Page): Promise<ClientState> {
  return page.evaluate(() => {
    const app = (
      window as unknown as {
        __app?: {
          driver: { tick(): number } | null;
          lockstep: { halted(): string | null; players(): readonly number[]; playerId: number } | null;
          stateHash(): number;
        };
      }
    ).__app;
    const driver = app?.driver;
    const lockstep = app?.lockstep;
    if (!app || !driver || !lockstep) {
      return { tick: -1, hash: 0, halted: 'not started', players: [], playerId: -1 };
    }
    return {
      tick: driver.tick(),
      hash: app.stateHash(),
      halted: lockstep.halted(),
      players: [...lockstep.players()],
      playerId: lockstep.playerId,
    };
  });
}

async function main(): Promise<void> {
  const relay = startRelay();
  const vite = await createServer({ server: { port: VITE_PORT, strictPort: true }, logLevel: 'warn' });
  await vite.listen();

  const executablePath = findChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  const failures: string[] = [];
  const url = `http://localhost:${VITE_PORT}/web_rts/?relay=${encodeURIComponent(
    `ws://localhost:${RELAY_PORT}/?match=check`,
  )}&match=check`;

  // Two independent browser contexts: separate pages, separate simulations.
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(`page ${i}: ${String(error)}`));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`page ${i} console: ${message.text()}`);
    });
    pages.push(page);
  }

  await Promise.all(pages.map((page) => page.goto(url, { waitUntil: 'domcontentloaded' })));
  // Both pages need to be present before the relay starts the match.
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // Each player issues orders as the match runs, so the command streams differ.
  for (let round = 0; round < 12; round++) {
    for (const [index, page] of pages.entries()) {
      await page.mouse.move(300 + index * 40, 250 + round * 6);
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  // Let them run on until both have passed the target tick.
  const deadline = Date.now() + 60_000;
  let states: ClientState[] = [];
  for (;;) {
    states = await Promise.all(pages.map(readState));
    if (states.every((state) => state.tick >= MATCH_TICKS)) break;
    if (states.some((state) => state.halted)) break;
    if (Date.now() > deadline) {
      failures.push(`timed out at ticks ${states.map((s) => s.tick).join(' and ')}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Bring both to exactly the same tick before comparing: they run
  // independently, so one is normally a tick or two ahead.
  const settle = Date.now() + 20_000;
  while (Date.now() < settle) {
    states = await Promise.all(pages.map(readState));
    if (states[0]?.tick === states[1]?.tick) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const [first, second] = states;
  if (!first || !second) failures.push('could not read both clients');
  else {
    if (first.playerId === second.playerId) failures.push('both clients got the same player id');
    if (first.halted) failures.push(`player ${first.playerId} halted: ${first.halted}`);
    if (second.halted) failures.push(`player ${second.playerId} halted: ${second.halted}`);
    if (first.tick < MATCH_TICKS || second.tick < MATCH_TICKS) {
      failures.push(`match did not reach ${MATCH_TICKS} ticks: ${first.tick} and ${second.tick}`);
    }
    if (first.tick === second.tick && first.hash !== second.hash) {
      failures.push(`desync at tick ${first.tick}: ${first.hash} vs ${second.hash}`);
    }
  }

  await browser.close();
  await vite.close();
  relay.close();

  for (const failure of failures) console.error(failure);
  if (failures.length > 0) {
    console.error('multiplayer check FAILED');
    process.exit(1);
  }
  console.log(
    `multiplayer check ok — two browsers reached tick ${first?.tick} with matching state ` +
      `(hash ${first?.hash}), no desync`,
  );
}

void main();
