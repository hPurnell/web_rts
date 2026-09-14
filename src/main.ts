import './ui/style.css';
import { runSelfChecks } from './dev/selfcheck.ts';
import { startApp } from './app.ts';

const checks = runSelfChecks();
for (const c of checks) {
  const line = `[selfcheck] ${c.name}: ${c.ok ? 'ok' : 'FAILED'} - ${c.detail}`;
  if (c.ok) console.info(line);
  else console.error(line);
}
const failed = checks.filter((c) => !c.ok);

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const overlay = document.getElementById('overlay');
if (!canvas || !overlay) throw new Error('missing #viewport or #overlay in the page');

const status = document.createElement('div');
status.className = 'status-line';
status.textContent =
  failed.length === 0
    ? `determinism self-check passed (${checks.length} checks)`
    : `determinism self-check FAILED: ${failed.map((c) => c.name).join(', ')}`;
status.style.color = failed.length === 0 ? '#6ee7a8' : '#ff7a7a';
overlay.appendChild(status);

startApp(canvas, overlay);
