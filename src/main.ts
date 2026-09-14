import './ui/style.css';
import { runSelfChecks } from './dev/selfcheck.ts';

const checks = runSelfChecks();
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  const line = `[selfcheck] ${c.name}: ${c.ok ? 'ok' : 'FAILED'} — ${c.detail}`;
  if (c.ok) console.info(line);
  else console.error(line);
}

const overlay = document.getElementById('overlay');
if (overlay) {
  const boot = document.createElement('div');
  boot.className = 'boot';
  const status = failed.length === 0
    ? `determinism self-check passed (${checks.length} checks)`
    : `determinism self-check FAILED: ${failed.map((c) => c.name).join(', ')}`;
  boot.innerHTML = '<h1>web_rts</h1><p>Browser RTS &mdash; foundation build</p>';
  const p = document.createElement('p');
  p.textContent = status;
  p.style.color = failed.length === 0 ? '#6ee7a8' : '#ff7a7a';
  boot.appendChild(p);
  overlay.appendChild(boot);
}
