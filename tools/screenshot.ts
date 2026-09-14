/**
 * Capture a screenshot of the running game, for checking that a change looks
 * right rather than only that it typechecks.
 *
 * Usage: pnpm shot [out.png] [--wait ms] [--keys KeyD,KeyW] [--wheel N]
 *
 * Runs against the dev server, so it does not pay for a production build.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

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

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const out = process.argv[2]?.startsWith('--') ? 'shot.png' : (process.argv[2] ?? 'shot.png');
  const waitMs = Number(arg('wait', '1500'));
  const keys = arg('keys', '').split(',').filter(Boolean);
  const wheel = Number(arg('wheel', '0'));

  const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'warn' });
  await server.listen();

  const executablePath = findChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('pageerror:', String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('console error:', m.text());
  });

  await page.goto('http://localhost:5199/web_rts/', { waitUntil: 'networkidle' });
  await page.mouse.move(640, 360);
  await page.waitForTimeout(waitMs);

  if (wheel !== 0) {
    await page.mouse.wheel(0, wheel);
    await page.waitForTimeout(600);
  }
  for (const key of keys) {
    await page.keyboard.down(key);
  }
  if (keys.length > 0) {
    await page.waitForTimeout(Number(arg('hold', '600')));
    for (const key of keys) await page.keyboard.up(key);
    await page.waitForTimeout(200);
  }

  await page.screenshot({ path: out });
  const overlay = await page.textContent('.dev-overlay');
  console.log(`wrote ${out}`);
  console.log(`overlay: ${overlay?.replace(/\s+/g, ' ').trim()}`);

  await browser.close();
  await server.close();
}

void main();
