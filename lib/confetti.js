/**
 * Win confetti: two bursts fired in from just off the left and right edges,
 * aimed at the game board, drawn on a single <canvas>.
 *
 * Kept cheap for phones: one canvas, a particle count scaled to the viewport,
 * device pixel ratio capped at 2, plain fillRect per piece, and the canvas and
 * animation loop are torn down as soon as the last piece falls off screen.
 * The canvas is a manual popover so it sits in the top layer above the
 * result <dialog>; without popover support it falls back to a fixed overlay.
 * Skipped entirely when the player prefers reduced motion.
 */

const COLORS = ["#e53935", "#fdd835", "#43a047", "#1e88e5", "#ffffff", "#ff8f00", "#8e24aa"];
const MAX_DURATION_MS = 6000;
const FADE_MS = 700;

let active = null;

/** @param {Element} [target] What to aim at (the card area); defaults to the viewport. */
export function launchConfetti(target) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (active) active.stop();
  active = createBurst(target);
}

function createBurst(target) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    pointerEvents: "none",
    zIndex: "2147483647",
    overflow: "hidden",
    maxWidth: "none",
    maxHeight: "none",
  });

  const canPopover = typeof canvas.showPopover === "function";
  if (canPopover) canvas.popover = "manual";
  document.body.append(canvas);
  if (canPopover) {
    try {
      canvas.showPopover();
    } catch {
      // Falls back to the fixed overlay.
    }
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return { stop() {} };
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  // Physics in px/s, tuned to the viewport so phones and desktops look the same.
  const gravity = height * 0.9;
  const particles = spawn(width, height, gravity, aimRect(target, width, height));

  let rafId = 0;
  let last = performance.now();
  const start = last;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", resize);
    canvas.remove();
    if (active?.stop === stop) active = null;
  };

  const frame = (now) => {
    // Clamp dt so a backgrounded tab doesn't teleport pieces on return.
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    const elapsed = now - start;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const remaining = MAX_DURATION_MS - elapsed;
    ctx.globalAlpha = remaining < FADE_MS ? Math.max(remaining / FADE_MS, 0) : 1;

    let alive = 0;
    for (const p of particles) {
      if (p.delay > 0) {
        p.delay -= dt;
        alive++;
        continue;
      }
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag + gravity * dt;
      p.x += (p.vx + Math.sin(p.wobble) * p.sway) * dt;
      p.y += p.vy * dt;
      p.wobble += p.wobbleSpeed * dt;
      p.rotation += p.spin * dt;
      p.flip += p.flipSpeed * dt;

      if (p.y > height + 20) continue;
      alive++;

      // Scale one axis by cos(flip) for a cheap 3D tumble.
      const cos = Math.cos(p.rotation);
      const sin = Math.sin(p.rotation);
      const sy = Math.cos(p.flip);
      ctx.setTransform(
        cos * dpr,
        sin * dpr,
        -sin * sy * dpr,
        cos * sy * dpr,
        p.x * dpr,
        p.y * dpr,
      );
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }

    if (alive === 0 || elapsed >= MAX_DURATION_MS) {
      stop();
      return;
    }
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  return { stop };
}

function aimRect(target, width, height) {
  const rect = target?.getBoundingClientRect?.();
  // Clip to the visible viewport; fall back to the middle of the screen.
  if (rect && rect.width > 0 && rect.height > 0) {
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, width);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, height);
    if (right > left && bottom > top) return { left, top, width: right - left, height: bottom - top };
  }
  return { left: width * 0.2, top: height * 0.2, width: width * 0.6, height: height * 0.6 };
}

function spawn(width, height, gravity, aim) {
  const count = Math.round(Math.min(Math.max((width * height) / 9000, 90), 180));
  const particles = [];
  const size = Math.min(Math.max(Math.min(width, height) / 70, 6), 11);
  const offscreen = Math.max(40, width * 0.06);
  const aimX = aim.left + aim.width / 2;
  const aimY = aim.top + aim.height / 2;

  for (let i = 0; i < count; i++) {
    const fromLeft = i % 2 === 0;
    const drag = 0.9 + Math.random() * 0.6;
    // Launch from just past the side edge, a bit below the middle of the screen.
    const x0 = fromLeft ? -offscreen : width + offscreen;
    const y0 = height * (0.58 + Math.random() * 0.14);
    // Each piece aims at a random spot on the board, clustered toward its center.
    const tx = aimX + (Math.random() + Math.random() - 1) * aim.width * 0.45;
    const ty = aimY + (Math.random() + Math.random() - 1) * aim.height * 0.45;
    // Solve the launch velocity that, under drag and gravity, reaches (tx, ty) after flight time t.
    const t = 0.65 + Math.random() * 0.35;
    const reach = (1 - Math.exp(-drag * t)) / drag;
    const vx = (tx - x0) / reach;
    const vy = (ty - y0 - (gravity * t) / drag) / reach + gravity / drag;
    particles.push({
      x: x0,
      y: y0,
      vx,
      vy,
      delay: Math.random() * 0.25 + (i < count / 2 ? 0 : 0.35),
      drag,
      w: size * (0.8 + Math.random() * 0.5),
      h: size * (0.4 + Math.random() * 0.3),
      color: COLORS[(Math.random() * COLORS.length) | 0],
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 10,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 8,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 2 + Math.random() * 4,
      sway: 20 + Math.random() * 40,
    });
  }
  return particles;
}
