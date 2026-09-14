/**
 * Headless smoke check for invariant 7: the built page loads in a real browser
 * with no console errors, and the in-page determinism self-check passes.
 *
 * Usage: pnpm check:browser  (builds first via the npm script)
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';

const BASE = '/web_rts/';

/**
 * Prefer an already-downloaded Chromium so this check works offline. Falls
 * back to Playwright's own bundled build (what CI uses after
 * `playwright install`).
 */
function findChromium(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const candidates: string[] = [];
  for (const dir of readdirSync(cache)) {
    candidates.push(
      join(cache, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      join(cache, dir, 'chrome-linux64', 'chrome'),
      join(cache, dir, 'chrome-linux', 'chrome'),
    );
  }
  return candidates.find((c) => existsSync(c));
}

async function main(): Promise<void> {
  const server = await preview({
    base: BASE,
    preview: { port: 4321, strictPort: true },
    logLevel: 'warn',
  });
  const url = `http://localhost:4321${BASE}`;

  const executablePath = findChromium();
  // Headless Chromium has no GPU: SwiftShader gives it a software WebGL
  // implementation, which is enough to prove the scene actually renders.
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  const record = (text: string): void => {
    errors.push(text);
    console.error(`console error: ${text}`);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') record(msg.text());
  });
  page.on('pageerror', (err) => record(String(err)));

  await page.goto(url, { waitUntil: 'networkidle' });
  const body = (await page.textContent('body')) ?? '';
  const selfCheckOk = body.includes('determinism self-check passed');

  // The canvas must actually be rendering: wait for the dev overlay's fps row
  // to report a real number, then drive the camera and check it moved.
  const failures: string[] = [];
  const readOverlay = async (key: string): Promise<string> =>
    (await page.textContent(`.dev-row:has(.dev-key:text-is("${key}")) .dev-value`)) ?? '';

  await page.waitForFunction(
    () => {
      const rows = Array.from(document.querySelectorAll('.dev-row'));
      const fps = rows.find((r) => r.firstElementChild?.textContent === 'fps');
      return Number(fps?.lastElementChild?.textContent ?? '0') > 0;
    },
    undefined,
    { timeout: 10_000 },
  );

  // Park the cursor in the middle of the canvas: a pointer sitting in the
  // corner is a legitimate edge-pan and would mask the keyboard test.
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width / 2, size.height / 2);
  await page.waitForTimeout(200);

  const before = await readOverlay('camera');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyD');
  const after = await readOverlay('camera');
  if (before === after) failures.push(`camera did not pan on KeyD (still ${after})`);

  const fps = Number(await readOverlay('fps'));
  if (!Number.isFinite(fps) || fps < 30) {
    // Headless software rendering is slower than a real GPU; 30 is a floor
    // that still catches a scene that is not rendering at all.
    failures.push(`fps too low in headless Chromium: ${fps}`);
  }

  await browser.close();
  await server.close();

  if (!selfCheckOk) console.error(`self-check text missing. Body was: ${body.trim()}`);
  for (const f of failures) console.error(f);

  if (errors.length > 0 || !selfCheckOk || failures.length > 0) {
    console.error('browser check FAILED');
    process.exit(1);
  }
  console.log(`browser check ok — ${url} rendered at ${fps} fps, camera responsive, self-check passed`);
}

void main();
