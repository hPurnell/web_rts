import './ui/style.css';

const overlay = document.getElementById('overlay');
if (overlay) {
  const boot = document.createElement('div');
  boot.className = 'boot';
  boot.innerHTML = '<h1>web_rts</h1><p>Browser RTS &mdash; foundation build</p>';
  overlay.appendChild(boot);
}
