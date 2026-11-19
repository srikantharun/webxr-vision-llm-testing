/**
 * Minimal DOM score HUD for desktop / emulator play.
 *
 * This is a flat 2D overlay — great for playing in the browser emulator on a
 * Mac. In an immersive headset session you wouldn't see DOM, but it is
 * harmless there. (A spatial UIKit panel would be the in-VR equivalent.)
 */
let el: HTMLDivElement | null = null;

export function initHud(): void {
  if (el) return;
  el = document.createElement('div');
  el.id = 'score-hud';
  el.style.cssText = [
    'position:fixed',
    'top:16px',
    'left:16px',
    'z-index:10000',
    'font:600 20px system-ui,-apple-system,sans-serif',
    'color:#fff',
    'background:rgba(10,12,20,0.6)',
    'padding:10px 16px',
    'border-radius:12px',
    'backdrop-filter:blur(6px)',
    'pointer-events:none',
    'user-select:none',
  ].join(';');
  document.body.appendChild(el);
  render(0);
}

export function setScore(n: number): void {
  render(n);
  document.title = `Score ${n} · Meta VR mini-game`;
}

function render(n: number): void {
  if (el) {
    el.textContent = `🎯 Score: ${n}   —   click / trigger the glowing shapes!`;
  }
}
