/*
 * TRACKR tracker and camera solver. No dependencies, so it runs in the
 * panel and can be unit-tested in plain Node.
 *
 * Tracker: follows a square patch through 8-bit grayscale frames with
 * zero-mean normalised cross-correlation (coarse search, then a fine pass),
 * and slowly adapts the template so gradual changes in the subject are kept.
 */
(function (root) {
  'use strict';

  const G = 12;            // template is (2G+1) x (2G+1) samples, whatever the box size
  const N = 2 * G + 1;
  const SCALES = [0.96, 1, 1.04];

  function Tracker(width, height) {
    this.w = width;
    this.h = height;
  }

  // Sample the N x N grid centred on (cx, cy); `half` is the box half-size in pixels.
  Tracker.prototype._sample = function (frame, cx, cy, half, out) {
    const w = this.w, h = this.h, sp = half / G;
    let k = 0;
    for (let j = -G; j <= G; j++) {
      let y = Math.round(cy + j * sp); if (y < 0) y = 0; else if (y >= h) y = h - 1;
      const row = y * w;
      for (let i = -G; i <= G; i++) {
        let x = Math.round(cx + i * sp); if (x < 0) x = 0; else if (x >= w) x = w - 1;
        out[k++] = frame[row + x];
      }
    }
  };

  Tracker.prototype.init = function (frame, cx, cy, half) {
    this.half = Math.max(4, half);
    this.x = cx; this.y = cy;
    this.vx = 0; this.vy = 0;
    this.lostCount = 0;
    this.tpl = new Float32Array(N * N);
    this.buf = new Float32Array(N * N);
    this._sample(frame, cx, cy, this.half, this.tpl);
    return { x: cx, y: cy, half: this.half, score: 1 };
  };

  // ZNCC between the template and the box at (cx, cy, half), using every `skip`-th sample.
  Tracker.prototype._score = function (frame, cx, cy, half, skip) {
    const w = this.w, h = this.h, sp = half / G, tpl = this.tpl;
    let sI = 0, sT = 0, sII = 0, sTT = 0, sIT = 0, c = 0;
    for (let j = -G; j <= G; j += skip) {
      let y = Math.round(cy + j * sp); if (y < 0) y = 0; else if (y >= h) y = h - 1;
      const row = y * w, trow = (j + G) * N + G;
      for (let i = -G; i <= G; i += skip) {
        let x = Math.round(cx + i * sp); if (x < 0) x = 0; else if (x >= w) x = w - 1;
        const a = frame[row + x], t = tpl[trow + i];
        sI += a; sT += t; sII += a * a; sTT += t * t; sIT += a * t; c++;
      }
    }
    const num = sIT - (sI * sT) / c;
    const den = Math.sqrt((sII - (sI * sI) / c) * (sTT - (sT * sT) / c));
    return den > 1e-6 ? num / den : 0;
  };

  Tracker.prototype.step = function (frame) {
    const px = this.x + this.vx, py = this.y + this.vy, half = this.half;
    // Search further when the subject was lost on the previous frames.
    const s = Math.round(Math.max(10, half * 1.1) * (1 + Math.min(this.lostCount, 3) * 0.6));
    const stride = s > 40 ? 3 : 2;
    let best = -2, bx = px, by = py;
    for (let dy = -s; dy <= s; dy += stride) {
      for (let dx = -s; dx <= s; dx += stride) {
        const sc = this._score(frame, px + dx, py + dy, half, 2);
        if (sc > best) { best = sc; bx = px + dx; by = py + dy; }
      }
    }
    // Fine pass: position to the pixel, and three box sizes so a subject that
    // walks towards or away from the camera stays matched.
    let fine = -2, fx = bx, fy = by, fh = half;
    for (let k = 0; k < SCALES.length; k++) {
      const hk = half * SCALES[k];
      const bias = SCALES[k] === 1 ? 0.004 : 0; // prefer no size change on a near-tie
      for (let dy = -stride; dy <= stride; dy++) {
        for (let dx = -stride; dx <= stride; dx++) {
          const sc = this._score(frame, bx + dx, by + dy, hk, 1) + bias;
          if (sc > fine) { fine = sc; fx = bx + dx; fy = by + dy; fh = hk; }
        }
      }
    }
    if (fine < 0.45) {
      // Lost: hold the last known position instead of jumping to noise.
      this.lostCount++;
      this.vx *= 0.5; this.vy *= 0.5;
      return { x: this.x, y: this.y, half: this.half, score: fine, lost: true };
    }
    this.lostCount = 0;
    const nx = Math.max(0, Math.min(this.w - 1, fx));
    const ny = Math.max(0, Math.min(this.h - 1, fy));
    this.vx = 0.6 * (nx - this.x); this.vy = 0.6 * (ny - this.y);
    this.x = nx; this.y = ny;
    this.half = Math.max(4, Math.min(this.w, 0.6 * this.half + 0.4 * fh));
    if (fine > 0.7) {
      this._sample(frame, nx, ny, this.half, this.buf);
      const t = this.tpl, b = this.buf;
      for (let i = 0; i < t.length; i++) t[i] = 0.93 * t[i] + 0.07 * b[i];
    }
    return { x: nx, y: ny, half: this.half, score: fine };
  };

  /* ---------- camera solve ---------- */

  function gaussianSmooth(values, sigma) {
    if (sigma < 0.3) return values.slice();
    const r = Math.ceil(sigma * 3), n = values.length, out = new Array(n);
    const k = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
    for (let i = 0; i < n; i++) {
      let acc = 0, wsum = 0;
      for (let j = -r; j <= r; j++) {
        const idx = Math.max(0, Math.min(n - 1, i + j));
        acc += values[idx] * k[j + r]; wsum += k[j + r];
      }
      out[i] = acc / wsum;
    }
    return out;
  }

  const easeInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /*
   * points: tracked subject per frame, in media pixels.
   * o: { fps, seqW, seqH, mediaW, mediaH, basePos:[nx,ny], baseScale, anchor:[nx,ny],
   *      zoom (multiplier), easeSec, smoothSec, framing:'keep'|'centre', zoomBack, keyStep }
   * Returns keyframes [{ f, x, y, s }] with x/y normalised to the sequence frame and s in percent.
   */
  function solve(points, o) {
    const n = points.length;
    const ax = o.anchor[0] * o.mediaW, ay = o.anchor[1] * o.mediaH;
    const sigma = o.smoothSec * o.fps;
    const dx = gaussianSmooth(points.map((p) => p.x - ax), sigma);
    const dy = gaussianSmooth(points.map((p) => p.y - ay), sigma);

    // Ease 0 means no ramp: fully zoomed from the first frame of the range to the last.
    // (The caller adds cut keys just outside the range so the zoom starts and ends on a cut.)
    const ramp = o.easeSec > 0;
    let easeF = Math.max(1, Math.round(o.easeSec * o.fps));
    const ramps = o.zoomBack ? 2 : 1;
    if (easeF * ramps > n - 1) easeF = Math.max(1, Math.floor((n - 1) / ramps));

    const p0x = o.basePos[0] * o.seqW, p0y = o.basePos[1] * o.seqH, s0 = o.baseScale;
    // Where the subject should sit on screen while zoomed in.
    // o.hold is an explicit point in sequence pixels (set by dragging the zoom frame).
    const cx = o.hold ? o.hold[0] : o.framing === 'centre' ? o.seqW / 2 : p0x + dx[0] * s0 / 100;
    const cy = o.hold ? o.hold[1] : o.framing === 'centre' ? o.seqH / 2 : p0y + dy[0] * s0 / 100;

    const frames = [];
    for (let i = 0; i < n; i++) {
      let z = ramp ? easeInOut(i / easeF) : 1;
      if (ramp && o.zoomBack) z = Math.min(z, easeInOut((n - 1 - i) / easeF));
      const s = s0 * (1 + (o.zoom - 1) * z);
      let x = p0x + (cx - dx[i] * s / 100 - p0x) * z;
      let y = p0y + (cy - dy[i] * s / 100 - p0y) * z;
      // Keep the footage covering the frame so no black edge shows.
      const maxX = ax * s / 100, minX = o.seqW - (o.mediaW - ax) * s / 100;
      const maxY = ay * s / 100, minY = o.seqH - (o.mediaH - ay) * s / 100;
      if (minX <= maxX) x = Math.max(minX, Math.min(maxX, x));
      if (minY <= maxY) y = Math.max(minY, Math.min(maxY, y));
      frames.push({ f: i, x: x / o.seqW, y: y / o.seqH, s,
        minX: minX / o.seqW, maxX: maxX / o.seqW, minY: minY / o.seqH, maxY: maxY / o.seqH });
    }
    const clamp = (v, lo, hi) => (lo <= hi ? Math.max(lo, Math.min(hi, v)) : v);
    // Clamping can leave small corners in the path; a light pass rounds them off.
    const sx = gaussianSmooth(frames.map((k) => k.x), Math.min(sigma, 2));
    const sy = gaussianSmooth(frames.map((k) => k.y), Math.min(sigma, 2));
    const step = Math.max(1, o.keyStep || 1), keys = [];
    for (let i = 0; i < n; i++) {
      if (i % step === 0 || i === n - 1) {
        const pin = ramp && (i === 0 || (o.zoomBack && i === n - 1));
        const k = frames[i];
        keys.push({
          f: i, s: k.s,
          x: pin ? k.x : clamp(sx[i], k.minX, k.maxX),
          y: pin ? k.y : clamp(sy[i], k.minY, k.maxY),
        });
      }
    }
    return keys;
  }

  /* ---------- attach: make another layer follow the subject ---------- */

  // Premiere reports Position/Anchor either normalised (0-1) or in pixels depending on version.
  const isNorm = (v) => Math.abs(v[0]) <= 4 && Math.abs(v[1]) <= 4;

  // Transform-effect keys (from solve) at clip frame f, linearly interpolated like Premiere does.
  function transformAt(tk, f) {
    if (!tk || !tk.keys.length) return { x: 0.5, y: 0.5, s: 100 };
    const ks = tk.keys, rel = f - tk.fA;
    if (rel <= ks[0].f) return ks[0];
    const last = ks[ks.length - 1];
    if (rel >= last.f) return last;
    let i = 1; while (ks[i].f < rel) i++;
    const a = ks[i - 1], b = ks[i], u = (rel - a.f) / (b.f - a.f);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, s: a.s + (b.s - a.s) * u };
  }

  /*
   * Where the tracked subject appears in the sequence, in sequence pixels, for clip frame f.
   * p: subject normalised to the source frame. tk: zoom keys written to the clip's Transform
   * effect ({ fA, keys }) or null. motion: the clip's Motion { pos, scale, anchor } (static).
   */
  function subjectOnScreen(p, f, o) {
    const mw = o.media.w, mh = o.media.h, t = transformAt(o.transformKeys, f);
    // Transform effect: works in the clip's own pixels, anchor at the centre.
    const tx = t.x * mw + (p.x - 0.5) * mw * t.s / 100;
    const ty = t.y * mh + (p.y - 0.5) * mh * t.s / 100;
    // Motion: places the clip in the sequence.
    const m = o.motion, pn = isNorm(m.pos), an = isNorm(m.anchor);
    const px = pn ? m.pos[0] * o.seq.w : m.pos[0], py = pn ? m.pos[1] * o.seq.h : m.pos[1];
    const ax = an ? m.anchor[0] * mw : m.anchor[0], ay = an ? m.anchor[1] * mh : m.anchor[1];
    return { x: px + (tx - ax) * m.scale / 100, y: py + (ty - ay) * m.scale / 100 };
  }

  /*
   * Position keys for a layer that should follow the subject, keeping the offset it has at frame `ref`.
   * o: { pts, f0 (clip frame of pts[0]), from, to (clip frames, inclusive), ref, base ([x,y] the layer's
   *      Position at ref, in its own units), fps, smoothSec, keyStep, media, seq, motion, transformKeys }
   * Returns [{ f, x, y }] with f in clip frames and x/y in the layer's own Position units.
   */
  function followPath(o) {
    // Hold the last good position through frames where the tracker lost the subject.
    const pts = [];
    let good = o.pts.find((p) => p && !p.lost) || o.pts.find(Boolean);
    for (const p of o.pts) { if (p && !p.lost) good = p; pts.push(good); }
    const sigma = (o.smoothSec || 0) * o.fps;
    const xs = gaussianSmooth(pts.map((p) => p.x), sigma), ys = gaussianSmooth(pts.map((p) => p.y), sigma);
    const at = (f) => {
      const i = Math.max(0, Math.min(pts.length - 1, f - o.f0));
      return subjectOnScreen({ x: xs[i], y: ys[i] }, f, o);
    };
    const r = at(o.ref), norm = isNorm(o.base), step = Math.max(1, o.keyStep || 1), keys = [];
    for (let f = o.from; f <= o.to; f++) {
      if ((f - o.from) % step !== 0 && f !== o.to) continue;
      const s = at(f), dx = s.x - r.x, dy = s.y - r.y;
      keys.push({ f, x: o.base[0] + (norm ? dx / o.seq.w : dx), y: o.base[1] + (norm ? dy / o.seq.h : dy) });
    }
    return keys;
  }

  const api = { Tracker, solve, gaussianSmooth, easeInOut, transformAt, subjectOnScreen, followPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Trackr = api;
})(typeof window !== 'undefined' ? window : globalThis);
