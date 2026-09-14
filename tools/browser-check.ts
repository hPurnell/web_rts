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
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(url, { waitUntil: 'networkidle' });
  const body = (await page.textContent('body')) ?? '';

  await browser.close();
  await server.close();

  const selfCheckOk = body.includes('determinism self-check passed');
  for (const e of errors) console.error(`console error: ${e}`);
  if (!selfCheckOk) console.error(`self-check text missing. Body was: ${body.trim()}`);

  if (errors.length > 0 || !selfCheckOk) {
    console.error('browser check FAILED');
    process.exit(1);
  }
  console.log(`browser check ok — ${url} loaded clean, self-check passed`);
}

void main();
