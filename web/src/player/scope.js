// The level scope: a 7-second strip chart of loudness against the threshold. It is
// how you *see* why the player paused where it did — and the fastest way to pick a
// threshold, because you can watch the trace dip under the pink line between sentences.

const WINDOW_MS = 7000;
const DB_TOP = -10;
const DB_BOTTOM = -80;

export class Scope {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.history = [];
    this.dpr = 1;
    this.resize();
  }

  /** Must be called after the panel becomes visible: a display:none canvas measures 0. */
  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  push(t, db) {
    this.history.push({ t, db: Math.max(db, DB_BOTTOM - 5) });
  }

  #y(db, H) {
    const clamped = Math.max(DB_BOTTOM, Math.min(DB_TOP, db));
    return H - ((clamped - DB_BOTTOM) / (DB_TOP - DB_BOTTOM)) * H;
  }

  draw(now, curDb, { threshold, accent, thresholdColor, mono }) {
    const { ctx, canvas: c, dpr } = this;
    const W = c.width;
    const H = c.height;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    ctx.font = `${10 * dpr}px ${mono}`;
    ctx.textBaseline = "middle";
    for (let db = -20; db >= -70; db -= 10) {
      const y = this.#y(db, H);
      ctx.strokeStyle = "rgba(255,255,255,0.045)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillText("−" + Math.abs(db), 6 * dpr, y - 7 * dpr);
    }

    const tY = this.#y(threshold, H);
    ctx.fillStyle = withAlpha(accent, 0.05); // the "there is sound here" zone
    ctx.fillRect(0, 0, W, tY);
    ctx.strokeStyle = thresholdColor;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, tY);
    ctx.lineTo(W, tY);
    ctx.stroke();
    ctx.setLineDash([]);

    const t0 = now - WINDOW_MS;
    while (this.history.length && this.history[0].t < t0) this.history.shift();
    if (this.history.length < 2) return;

    const x = (t) => ((t - t0) / WINDOW_MS) * W;

    ctx.beginPath();
    ctx.moveTo(x(this.history[0].t), H);
    for (const p of this.history) ctx.lineTo(x(p.t), this.#y(p.db, H));
    ctx.lineTo(x(this.history[this.history.length - 1].t), H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, withAlpha(accent, 0.28));
    grad.addColorStop(1, withAlpha(accent, 0.02));
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const px = x(this.history[i].t);
      const py = this.#y(this.history[i].db, H);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.lineWidth = 1.8 * dpr;
    ctx.strokeStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8 * dpr;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x(this.history[this.history.length - 1].t), this.#y(curDb, H), 2.6 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function withAlpha(color, a) {
  const hex = String(color).trim().replace("#", "");
  if (!/^[0-9a-f]{3,8}$/i.test(hex)) return `rgba(54,226,160,${a})`;
  const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
