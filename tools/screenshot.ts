/**
 * Capture a screenshot of the running game, for checking that a change looks
 * right rather than only that it typechecks.
 *
 * Usage: pnpm shot [out.png] [--wait ms] [--keys KeyD,KeyW] [--wheel N]
 *                   [--path "?mode=editor"]
 *
 * `--path` is appended to the page URL. Mostly it is worth it for
 * `?mode=editor`, which is the only way to look at terrain with no fog of war
 * over it — in game mode everything outside a unit's sight is black, which
 * hides exactly the thing you are usually trying to see.
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
  /**
   * --keys takes phases: "F2:200,KeyA+KeyS:1500" presses F2 for 200ms, then
   * holds A and S together for 1500ms. Camera panning is time-based, so a tap
   * moves nothing.
   */
  const keyPhases = arg('keys', '')
    .split(',')
    .filter(Boolean)
    .map((phase) => {
      const [combo, ms] = phase.split(':');
      return { keys: (combo ?? '').split('+').filter(Boolean), ms: Number(ms ?? arg('hold', '600')) };
    });
  const wheel = Number(arg('wheel', '0'));
  const [mouseX, mouseY] = arg('mouse', '640,360').split(',').map(Number) as [number, number];
  /** --drag "x1,y1 x2,y2 ..." presses the left button and paints along a path. */
  const drag = arg('drag', '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p.split(',').map(Number) as [number, number]);

  const pageErrors: string[] = [];
  const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'warn' });
  await server.listen();

  const executablePath = findChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const record = (text: string): void => {
    pageErrors.push(text);
    console.error(`page error: ${text}`);
  };
  page.on('pageerror', (e) => record(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') record(m.text());
  });

  await page.goto(`http://localhost:5199/web_rts/${arg('path', '')}`, { waitUntil: 'networkidle' });
  await page.mouse.move(mouseX, mouseY);
  await page.waitForTimeout(waitMs);

  if (wheel !== 0) {
    await page.mouse.wheel(0, wheel);
    await page.waitForTimeout(600);
  }
  for (const phase of keyPhases) {
    for (const key of phase.keys) await page.keyboard.down(key);
    await page.waitForTimeout(phase.ms);
    for (const key of phase.keys) await page.keyboard.up(key);
    await page.waitForTimeout(150);
  }

  if (drag.length > 0) {
    const [first, ...rest] = drag;
    await page.mouse.move(first![0], first![1]);
    await page.mouse.down();
    for (const [x, y] of rest) {
      await page.mouse.move(x, y, { steps: 8 });
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  /** --rightclick "x,y" issues an order to the current selection. */
  const rightClicks = arg('rightclick', '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p.split(',').map(Number) as [number, number]);
  for (const [x, y] of rightClicks) {
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(Number(arg('settle', '1500')));
  }

  /** --press "Control+z,Control+z" sends chord presses after everything else. */
  for (const chord of arg('press', '').split(',').filter(Boolean)) {
    await page.keyboard.press(chord);
    await page.waitForTimeout(250);
  }

  /** --after <ms> waits before capturing, e.g. to let a match play out. */
  await page.waitForTimeout(Number(arg('after', '0')));

  // A second move right before capture: some headless setups deliver the very
  // first pointer event before the page's listeners are attached.
  await page.mouse.move(mouseX - 1, mouseY - 1);
  await page.mouse.move(mouseX, mouseY);
  await page.waitForTimeout(150);

  await page.screenshot({ path: out });
  const overlay = await page.textContent('.dev-overlay');
  console.log(`wrote ${out}`);
  console.log(`overlay: ${overlay?.replace(/\s+/g, ' ').trim()}`);

  await browser.close();
  await server.close();

  // A screenshot of a broken page still looks like a screenshot, so say so
  // loudly and fail rather than letting a silent exception pass for success.
  if (pageErrors.length > 0) {
    console.error(`FAILED: ${pageErrors.length} page error(s) while capturing`);
    process.exit(1);
  }
}

void main();
