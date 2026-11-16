/* TRACKR panel: scroll through the selected clip, click a subject, track it in
 * both directions, and write Scale + Position keyframes so the zoomed frame follows it. */
(function () {
  'use strict';

  const cep = window.__adobe_cep__ || null;
  const nodeRequire = (window.cep_node && window.cep_node.require) || (typeof window.require === 'function' ? window.require : null);
  const $ = (id) => document.getElementById(id);
  const WORK_W = 480;   // tracking resolution (px wide)
  const CHUNK = 45;     // frames decoded at a time when tracking backwards

  const state = {
    clip: null,       // info from Premiere
    media: null,      // { w, h } display size of the source
    dur: 0,           // clip length in seconds
    tCur: 0,          // scrubber position, seconds from the clip's start
    frameT: 0,        // time of the frame currently shown
    tIn: 0, tOut: 0,  // zoom range
    target: null,     // { x, y, t } normalised position, and the time it was placed at
    frameImg: null,
    track: null,      // { f0, pts: [{ x, y, half, lost }] } normalised, one per frame from f0
    other: null,      // a different clip selected in the timeline (text or graphic to attach)
    busy: false,
    framing: 'keep', // 'keep' | 'centre' | 'custom'
    offset: { x: 0, y: 0 }, // custom framing: subject minus zoom-frame centre, normalised
  };

  /* ---------- small helpers ---------- */
  const fmt = (s) => {
    const m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fps = () => (state.clip ? state.clip.fps : 25);
  const frameOf = (t) => Math.round(t * fps());

  function status(msg, kind) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function progress(p) {
    $('progressBar').style.width = (p == null ? 0 : Math.round(p * 100)) + '%';
  }
  // which: the button doing the work ('track' | 'apply' | 'attach'), so its label shows progress.
  function setBusy(b, which) {
    state.busy = b;
    $('track').textContent = b && which === 'track' ? 'Tracking…' : 'Track';
    $('apply').textContent = b && which === 'apply' ? 'Applying…' : 'Apply';
    $('attach').textContent = b && which === 'attach' ? 'Attaching…' : 'Attach to subject';
    updateButtons();
  }
  function updateButtons() {
    const b = state.busy;
    $('track').disabled = b; $('reset').disabled = b; $('attach').disabled = b;
    $('apply').disabled = b || !state.track; // Apply needs a track first
  }

  /* The track is kept per clip (and across panel reloads) so text can be attached to it later. */
  const trackKey = (c) => 'trackr-' + c.nodeId;
  function saveTrack() {
    const c = state.clip;
    if (!c || !state.track) return;
    try {
      const r = (v) => Math.round(v * 1e5) / 1e5;
      localStorage.setItem(trackKey(c), JSON.stringify({
        inPoint: c.inPoint, outPoint: c.outPoint, path: c.path, f0: state.track.f0, target: state.target,
        pts: state.track.pts.map((p) => [r(p.x), r(p.y), r(p.half), p.lost ? 1 : 0]),
      }));
    } catch (e) { /* storage full or unavailable: the track still lives until the panel closes */ }
  }
  function loadTrack(c) {
    try {
      const d = JSON.parse(localStorage.getItem(trackKey(c)) || 'null');
      if (!d || d.path !== c.path || Math.abs(d.inPoint - c.inPoint) > 1e-3 || Math.abs(d.outPoint - c.outPoint) > 1e-3) return null;
      return { f0: d.f0, target: d.target || null, pts: d.pts.map((a) => ({ x: a[0], y: a[1], half: a[2], lost: !!a[3] })) };
    } catch (e) { return null; }
  }
  function dropTrack() {
    state.track = null;
    try { if (state.clip) localStorage.removeItem(trackKey(state.clip)); } catch (e) { /* ignore */ }
  }

  function setOther(o) {
    state.other = o;
    $('attachBox').hidden = !o;
    if (o) $('attachName').textContent = o.name;
    layout();
  }

  function host(fn, arg) {
    return new Promise((resolve, reject) => {
      if (!cep) return reject(new Error('Not running inside Premiere'));
      const call = 'TRACKR.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(String(arg))) + ')';
      cep.evalScript(call, (out) => {
        let r;
        try { r = JSON.parse(out); } catch (e) { return reject(new Error('Premiere said: ' + out)); }
        r.ok ? resolve(r) : reject(new Error(r.error));
      });
    });
  }

  // Folder this extension is installed in (works for Mac and Windows file URLs).
  function extDir() {
    const d = decodeURI(cep.getSystemPath('extension'));
    return d.replace(/^file:\/\/\/(?=[A-Za-z]:)/, '').replace(/^file:\/\//, '');
  }

  // ffmpeg: the copy shipped inside the extension first, then whatever is installed on the machine.
  const binCache = {};
  function findBin(name) {
    if (binCache[name]) return binCache[name];
    const fs = nodeRequire('fs'), path = nodeRequire('path'), os = nodeRequire('os');
    const win = os.platform() === 'win32', exe = win ? name + '.exe' : name;
    const bundled = path.join(extDir(), 'bin', os.platform() + '-' + os.arch(), exe);
    const sysPath = ((typeof process !== 'undefined' && process.env && process.env.PATH) || '').split(win ? ';' : ':');
    const dirs = win ? sysPath : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'].concat(sysPath);
    const all = [bundled].concat(dirs.filter(Boolean).map((d) => path.join(d, exe)));
    for (const p of all) {
      if (!fs.existsSync(p)) continue;
      if (p === bundled && !win) { try { fs.chmodSync(p, 0o755); } catch (e) { /* already executable */ } }
      return (binCache[name] = p);
    }
    throw new Error(win ? 'ffmpeg was not found. Reinstall TRACKR.' : 'ffmpeg was not found. Reinstall TRACKR, or run: brew install ffmpeg');
  }

  function run(bin, args, onData) {
    return new Promise((resolve, reject) => {
      const p = nodeRequire('child_process').spawn(bin, args, { windowsHide: true });
      const chunks = []; let err = '';
      p.stdout.on('data', (d) => (onData ? onData(d) : chunks.push(d)));
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || 'ffmpeg exited with ' + code));
        resolve(onData ? null : nodeRequire('buffer').Buffer.concat(chunks));
      });
    });
  }

  // Picture size as displayed (after rotation), read from ffmpeg's own description of the file.
  function parseProbe(text) {
    const line = text.split('\n').find((l) => /Stream #.*Video:/.test(l));
    const m = line && line.match(/,\s(\d{2,5})x(\d{2,5})[\s,\[]/);
    if (!m) throw new Error('No video stream in this clip.');
    const rot = text.match(/rotation of (-?\d+(?:\.\d+)?) degrees/) || text.match(/rotate\s*:\s*(-?\d+)/);
    const quarter = rot && Math.abs(Math.round(parseFloat(rot[1]) / 90)) % 2 === 1;
    return quarter ? { w: Number(m[2]), h: Number(m[1]) } : { w: Number(m[1]), h: Number(m[2]) };
  }

  function probe(file) {
    return new Promise((resolve, reject) => {
      // "ffmpeg -i file" prints the stream details and exits with an error because no output is given.
      const p = nodeRequire('child_process').spawn(findBin('ffmpeg'), ['-hide_banner', '-i', file], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.stdout.on('data', () => {});
      p.on('error', reject);
      p.on('close', () => { try { resolve(parseProbe(err)); } catch (e) { reject(e); } });
    });
  }

  /* ---------- layout: the preview always keeps the clip's own ratio ---------- */
  const viewer = $('viewer'), canvas = $('view'), ctx = canvas.getContext('2d');

  function layout() {
    const ratio = state.media ? state.media.w / state.media.h
      : state.frameImg ? state.frameImg.naturalWidth / state.frameImg.naturalHeight : 16 / 9;
    const main = $('main'), wide = window.innerWidth >= 600;
    const stageW = $('viewerWrap').clientWidth;
    let avail = main.clientHeight - $('clip').offsetHeight - $('scrubBox').offsetHeight - 20 - 12;
    if (!wide) avail -= $('controls').offsetHeight + 10;
    const maxH = Math.max(150, avail);
    const w = Math.max(60, Math.min(stageW, maxH * ratio));
    viewer.style.width = Math.round(w) + 'px';
    viewer.style.height = Math.round(w / ratio) + 'px';
    viewer.classList.toggle('narrow', w < 220);
    draw();
  }

  function drawBox(x, y, half, colour, dim) {
    const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
    const c = Math.min(half * 0.45, 9 * dpr);
    if (dim) {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(x - half, y - half, half * 2, half * 2); ctx.fill('evenodd');
    }
    ctx.strokeStyle = colour; ctx.lineWidth = 1.75 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
      const px = x + sx * half, py = y + sy * half;
      ctx.moveTo(px - sx * c, py); ctx.lineTo(px, py); ctx.lineTo(px, py - sy * c);
    });
    ctx.stroke();
    ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2); ctx.fill();
  }

  /* The zoom frame: the part of the video that fills the picture once zoomed in.
   * It is measured against the video itself, so 100% is always the full frame.
   * `sub` is the subject on the frame being shown (the target, or its tracked position). */
  function cropFor(sub) {
    if (!sub || !state.target) return null;
    const z = Number($('zoom').value) / 100, w = 1 / z, h = 1 / z;
    let off;
    if (state.framing === 'custom') off = state.offset;
    else if (state.framing === 'centre') off = { x: 0, y: 0 };
    else off = { x: (state.target.x - 0.5) / z, y: (state.target.y - 0.5) / z }; // subject keeps its place
    const cx = clamp(sub.x - off.x, w / 2, 1 - w / 2), cy = clamp(sub.y - off.y, h / 2, 1 - h / 2);
    return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, sub, z };
  }

  // Where the subject sits while zoomed in, in the clip's own pixels (the Transform effect works in that space).
  function holdPoint() {
    const k = cropFor(state.target);
    const m = state.media || { w: state.frameImg.naturalWidth, h: state.frameImg.naturalHeight };
    return [m.w * (0.5 + (state.target.x - k.cx) * k.z), m.h * (0.5 + (state.target.y - k.cy) * k.z)];
  }

  // Corners of the zoom frame, each with the direction it grows in.
  function corners(k) {
    return [
      { x: k.x, y: k.y, dx: -1, dy: -1 }, { x: k.x + k.w, y: k.y, dx: 1, dy: -1 },
      { x: k.x + k.w, y: k.y + k.h, dx: 1, dy: 1 }, { x: k.x, y: k.y + k.h, dx: -1, dy: 1 },
    ];
  }

  function subjectNow() {
    const f = frameOf(state.frameT), tr = state.track;
    const tp = tr && tr.pts[f - tr.f0];
    if (tp) return tp;
    return state.target && Math.abs(frameOf(state.target.t) - f) < 1 ? state.target : null;
  }

  // Rule-of-thirds guide inside the zoom frame (the final picture). Preview only; never rendered.
  function drawThirds(x, y, w, h, dpr) {
    const lines = [];
    [1, 2].forEach((i) => {
      lines.push([x + (w * i) / 3, y, x + (w * i) / 3, y + h]);
      lines.push([x, y + (h * i) / 3, x + w, y + (h * i) / 3]);
    });
    ctx.setLineDash([]);
    [['rgba(0,0,0,0.35)', 2.5 * dpr], ['rgba(255,255,255,0.55)', 1 * dpr]].forEach(([colour, width]) => {
      ctx.strokeStyle = colour; ctx.lineWidth = width;
      ctx.beginPath();
      lines.forEach(([x1, y1, x2, y2]) => { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); });
      ctx.stroke();
    });
    // The four power points, where the subject usually wants to sit.
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    [1, 2].forEach((i) => [1, 2].forEach((j) => {
      ctx.beginPath(); ctx.arc(x + (w * i) / 3, y + (h * j) / 3, 2 * dpr, 0, Math.PI * 2); ctx.fill();
    }));
  }

  function drawCrop(k) {
    const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
    const x = k.x * W, y = k.y * H, w = k.w * W, h = k.h * H;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(x, y, w, h); ctx.fill('evenodd');
    if ($('thirds').checked) drawThirds(x, y, w, h, dpr);
    ctx.setLineDash([]); ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    // Corner handles: drag one to resize the frame, which changes the zoom.
    const hs = 4 * dpr;
    corners(k).forEach((c) => {
      const px = clamp(c.x * W, hs + dpr, W - hs - dpr), py = clamp(c.y * H, hs + dpr, H - hs - dpr);
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.rect(px - hs, py - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke();
    });
  }

  function draw() {
    const box = viewer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.width * dpr)), H = Math.max(1, Math.round(box.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.clearRect(0, 0, W, H);
    if (state.frameImg) ctx.drawImage(state.frameImg, 0, 0, W, H);
    else { ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, W, H); }

    const sub = subjectNow();
    if (sub) {
      const k = cropFor(sub);
      if (k) drawCrop(k);
      const half = sub.half != null ? sub.half * W : (Number($('box').value) / 100) * W / 2;
      drawBox(sub.x * W, sub.y * H, half, sub.lost ? '#ff7b72' : '#5aa9ff', false);
    }
    $('hint').classList.toggle('hide', !!state.target || !state.frameImg);
    updateButtons();
    drawScrub();
  }

  function drawScrub() {
    const d = state.dur || 1, pc = (t) => clamp(t / d, 0, 1) * 100 + '%';
    $('head').style.left = pc(state.tCur);
    $('band').style.left = pc(state.tIn);
    $('band').style.width = clamp((state.tOut - state.tIn) / d, 0, 1) * 100 + '%';
    $('mark').style.display = state.target ? 'block' : 'none';
    if (state.target) $('mark').style.left = pc(state.target.t);
    $('timeNow').textContent = fmt(state.tCur);
    $('timeDur').textContent = '/ ' + fmt(state.dur);
    $('inOut').textContent = fmt(state.tIn);
    $('outOut').textContent = fmt(state.tOut);
  }

  function setFraming(mode) {
    state.framing = mode;
    [...$('framing').children].forEach((c) => {
      const on = c.dataset.v === mode;
      c.classList.toggle('on', on); c.setAttribute('aria-checked', on);
    });
  }

  function cornerAt(k, p, r) {
    if (!k) return null;
    return corners(k).find((c) => Math.hypot((c.x - p.x) * r.width, (c.y - p.y) * r.height) < 12) || null;
  }

  function setZoom(z) {
    const el = $('zoom');
    el.value = Math.round(clamp(z * 100, Number(el.min), Number(el.max)));
    el.dispatchEvent(new Event('input'));
  }

  // Click = place the subject. Drag inside the dotted frame = move it. Drag a corner = resize it (zoom).
  canvas.addEventListener('mousedown', (e) => {
    if (!state.frameImg || state.busy) return;
    const r = canvas.getBoundingClientRect();
    const at = (ev) => ({ x: clamp((ev.clientX - r.left) / r.width, 0, 1), y: clamp((ev.clientY - r.top) / r.height, 0, 1) });
    const p0 = at(e), k = cropFor(subjectNow());
    const corner = cornerAt(k, p0, r);
    const inCrop = k && p0.x >= k.x && p0.x <= k.x + k.w && p0.y >= k.y && p0.y <= k.y + k.h;
    let moved = false;
    const place = (p) => {
      state.target = { x: p.x, y: p.y, t: state.frameT };
      dropTrack();
    };
    const move = (ev) => {
      const p = at(ev);
      if (!moved && Math.hypot((p.x - p0.x) * r.width, (p.y - p0.y) * r.height) < 3) return;
      moved = true;
      if (corner) {
        // The opposite corner stays put; the frame keeps the video's shape.
        const fx = corner.x - corner.dx * k.w, fy = corner.y - corner.dy * k.h;
        const el = $('zoom'), minW = 100 / Number(el.max);
        const room = Math.min(corner.dx > 0 ? 1 - fx : fx, corner.dy > 0 ? 1 - fy : fy);
        const w = clamp(Math.max((p.x - fx) * corner.dx, (p.y - fy) * corner.dy), minW, Math.max(minW, Math.min(1, room)));
        state.offset = { x: k.sub.x - (fx + corner.dx * w / 2), y: k.sub.y - (fy + corner.dy * w / 2) };
        setFraming('custom');
        setZoom(1 / w);
      } else if (inCrop) {
        const cx = clamp(k.cx + p.x - p0.x, k.w / 2, 1 - k.w / 2), cy = clamp(k.cy + p.y - p0.y, k.h / 2, 1 - k.h / 2);
        state.offset = { x: k.sub.x - cx, y: k.sub.y - cy };
        setFraming('custom');
      } else place(p);
      draw();
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      if (!moved && !corner) { place(p0); draw(); }
      status('Drag the dotted frame to move it, or a corner to resize it');
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  canvas.addEventListener('mousemove', (e) => {
    if (e.buttons) return;
    const r = canvas.getBoundingClientRect(), k = cropFor(subjectNow());
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const c = cornerAt(k, p, r);
    canvas.style.cursor = c ? (c.dx * c.dy > 0 ? 'nwse-resize' : 'nesw-resize')
      : k && p.x >= k.x && p.x <= k.x + k.w && p.y >= k.y && p.y <= k.y + k.h ? 'move' : 'crosshair';
  });

  /* ---------- frames + scrubbing ---------- */
  function setFrame(src, t) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { state.frameImg = img; state.frameT = t; draw(); resolve(); };
      img.onerror = () => resolve();
      img.src = src;
    });
  }

  async function loadFrame(t) {
    const c = state.clip;
    if (!c) return;
    const jpg = await run(findBin('ffmpeg'), ['-v', 'error', '-ss', (c.inPoint + t).toFixed(4), '-i', c.path,
      '-frames:v', '1', '-vf', 'scale=w=640:h=640:force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
    await setFrame('data:image/jpeg;base64,' + jpg.toString('base64'), t);
  }

  // Latest request wins, so dragging the scrubber never queues up stale frames.
  let loading = false, wanted = null;
  async function showFrame(t) {
    wanted = t;
    if (loading || !cep) { if (!cep) { state.frameT = t; draw(); } return; }
    loading = true;
    while (wanted != null) {
      const tt = wanted; wanted = null;
      try { await loadFrame(tt); } catch (e) { status(e.message, 'error'); }
    }
    loading = false;
  }

  // The preview and Premiere's playhead stay on the same frame, in both directions.
  let lastLocalSeek = 0, sending = false, toSend = null;
  async function pushPlayhead(t) {
    toSend = t;
    if (sending || !cep || !state.clip) return;
    sending = true;
    while (toSend != null) {
      const tt = toSend; toSend = null;
      try { await host('setPlayhead', (state.clip.start + tt).toFixed(5)); } catch (e) { /* not fatal */ }
    }
    sending = false;
  }

  function seek(t, fromPremiere) {
    if (state.busy) return;
    const step = 1 / fps();
    const next = clamp(Math.round(t / step) * step, 0, Math.max(0, state.dur - step));
    if (fromPremiere && Math.abs(next - state.tCur) < step / 2) return;
    state.tCur = next;
    drawScrub();
    showFrame(state.tCur);
    if (!fromPremiere) { lastLocalSeek = Date.now(); pushPlayhead(state.tCur); }
  }

  let dragging = false, polling = false;
  async function pollPlayhead() {
    if (polling || state.busy || dragging || !cep || Date.now() - lastLocalSeek < 600) return;
    polling = true;
    try {
      const p = await host('playhead');
      const mine = state.clip && p.nodeId === state.clip.nodeId;
      if (p.nodeId && !mine) {
        if (state.clip && state.track) {
          // A track exists: stay on the tracked clip and offer to attach the newly selected one.
          if (!state.other || state.other.nodeId !== p.nodeId) setOther(await host('info'));
        } else if (p.nodeId !== state.skipId) {
          state.skipId = p.nodeId;
          await refreshClip(false);
        }
      } else if (mine && state.other) setOther(null);
      if (state.clip && Date.now() - lastLocalSeek >= 600 && !dragging) seek(p.t - state.clip.start, true);
    } catch (e) { /* no sequence or no selection: keep what is shown */ }
    polling = false;
  }

  const scrub = $('scrub');
  scrub.addEventListener('mousedown', (e) => {
    scrub.focus();
    const move = (ev) => {
      const r = scrub.getBoundingClientRect();
      seek(clamp((ev.clientX - r.left) / r.width, 0, 1) * state.dur);
    };
    dragging = true;
    move(e);
    const up = () => { dragging = false; lastLocalSeek = Date.now(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  scrub.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 10 : 1) / fps();
    if (e.key === 'ArrowLeft') { seek(state.tCur - step); e.preventDefault(); }
    if (e.key === 'ArrowRight') { seek(state.tCur + step); e.preventDefault(); }
  });
  viewer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    seek(state.tCur + (d / 40) / fps() * 2);
  }, { passive: false });

  /* ---------- clip ---------- */
  async function refreshClip(keep) {
    $('refresh').classList.remove('spin'); void $('refresh').offsetWidth; $('refresh').classList.add('spin');
    try {
      const c = await host('info');
      if (c.speed !== 1 || c.reversed) throw new Error('Clips with a speed change are not supported yet.');
      if (!c.path) throw new Error('This clip has no media file (nested sequence or graphic).');
      const same = state.clip && state.clip.nodeId === c.nodeId;
      state.clip = c;
      state.dur = c.outPoint - c.inPoint;
      if (!same || !keep) {
        state.media = await probe(c.path);
        const ph = c.playhead - c.start;
        state.tCur = ph > 0 && ph < state.dur ? ph : 0;
        state.tIn = 0; state.tOut = state.dur;
        state.track = loadTrack(c);
        // A restored track brings its subject point back with it.
        state.target = state.track ? (state.track.target || { x: state.track.pts[0].x, y: state.track.pts[0].y, t: state.track.f0 / c.fps }) : null;
        layout();
        await loadFrame(state.tCur);
      }
      setOther(null);
      $('clip').classList.add('live');
      $('clipName').textContent = c.name;
      $('clipMeta').textContent = fmt(state.dur) + ' · ' + state.media.w + '×' + state.media.h + ' · ' + (Math.round(c.fps * 100) / 100) + ' fps';
      layout();
      status(state.target ? 'Ready' : 'Scroll to a clear frame, then click the subject');
      return c;
    } catch (e) {
      state.clip = null;
      $('clip').classList.remove('live');
      $('clipName').textContent = 'No clip selected';
      $('clipMeta').textContent = 'Select a video clip in the timeline';
      status(e.message, 'error');
      throw e;
    }
  }

  function setRange(which) {
    if (state.busy) return;
    const min = 4 / fps();
    if (which === 'in') state.tIn = clamp(state.tCur, 0, state.tOut - min);
    else state.tOut = clamp(state.tCur + 1 / fps(), state.tIn + min, state.dur);
    dropTrack();
    draw();
  }

  /* ---------- tracking ---------- */
  // Decode `count` grayscale frames starting at clip frame `f0`; calls onFrame(Uint8Array, index).
  function decode(c, W, H, f0, count, onFrame) {
    const size = W * H, frame = new Uint8Array(size);
    let off = 0, n = 0;
    return run(findBin('ffmpeg'), ['-v', 'error', '-ss', (c.inPoint + f0 / c.fps).toFixed(4), '-i', c.path, '-an',
      '-vf', 'fps=' + c.fps + ',scale=' + W + ':' + H + ',format=gray', '-frames:v', String(count), '-f', 'rawvideo', '-'], (d) => {
      let p = 0;
      while (p < d.length) {
        const k = Math.min(size - off, d.length - p);
        frame.set(d.subarray(p, p + k), off); off += k; p += k;
        if (off === size) { off = 0; if (n < count) onFrame(frame, n++); }
      }
    });
  }

  async function trackRange(c, media) {
    const W = WORK_W, H = Math.round((WORK_W * media.h) / media.w / 2) * 2;
    const last = Math.max(1, frameOf(state.dur) - 1);
    const fR = clamp(frameOf(state.target.t), 0, last);
    const lo = Math.min(clamp(frameOf(state.tIn), 0, last), fR);
    const hi = Math.max(clamp(frameOf(state.tOut) - 1, 0, last), fR);
    const total = hi - lo + 1, half = ((Number($('box').value) / 100) * W) / 2;
    const out = new Array(total); let done = 0;
    const T = window.Trackr.Tracker;
    const put = (f, r) => {
      out[f - lo] = { x: r.x / W, y: r.y / H, half: r.half / W, lost: !!r.lost };
      if (++done % 6 === 0) { progress(done / total); status('Tracking ' + Math.round((done / total) * 100) + '%'); }
    };
    const init = (tr, frame) => tr.init(frame, state.target.x * W, state.target.y * H, half);

    // Forward from the frame the target was placed on.
    const fwd = new T(W, H), back = new T(W, H);
    await decode(c, W, H, fR, hi - fR + 1, (frame, i) => {
      if (i === 0) { put(fR, init(fwd, frame)); init(back, frame); }
      else put(fR + i, fwd.step(frame));
    });
    // Backward in chunks, since video only decodes forwards.
    for (let end = fR; end > lo;) {
      const start = Math.max(lo, end - CHUNK), n = end - start, size = W * H;
      const buf = new Uint8Array(n * size); let got = 0;
      await decode(c, W, H, start, n, (frame, i) => { buf.set(frame, i * size); got = i + 1; });
      for (let i = got - 1; i >= 0; i--) put(start + i, back.step(buf.subarray(i * size, (i + 1) * size)));
      end = start;
    }
    // Fill any frame ffmpeg did not return (end of file) with its neighbour.
    for (let i = 0; i < total; i++) if (!out[i]) out[i] = out[i - 1] || out.find(Boolean);
    if (!out[0]) throw new Error('Could not read frames from this clip.');
    return { f0: lo, pts: out };
  }

  /* Track: follow the subject through the range and keep the result. Nothing is written to the clip. */
  async function track() {
    if (state.busy) return false;
    if (!cep) return demoRun();
    if (state.other) { status('Select the video clip again to track it.', 'error'); return false; }
    setBusy(true, 'track'); progress(0);
    let ok = false;
    try {
      const c = await refreshClip(true);
      if (!state.target) throw new Error('Click the subject in the frame first.');
      const tr = await trackRange(c, state.media);
      state.track = tr; saveTrack(); draw();
      const pct = Math.round((tr.pts.filter((p) => p.lost).length / tr.pts.length) * 100);
      if (pct > 15) status('Tracked, but the subject was lost for ' + pct + '% of the range', 'error');
      else status('Tracked. Scroll the clip to check, then Apply', 'ok');
      ok = true;
    } catch (e) {
      status(e.message, 'error');
    } finally {
      setBusy(false); setTimeout(() => progress(null), 600);
    }
    return ok;
  }

  /* Apply: write the follow zoom from the existing track, using the current settings. */
  async function apply() {
    if (state.busy) return false;
    if (!cep) { status(state.track ? 'Applied (preview mode)' : 'Track the subject first.', state.track ? 'ok' : 'error'); return false; }
    if (state.other) { status('Select the tracked video clip to apply the zoom.', 'error'); return false; }
    setBusy(true, 'apply');
    let ok = false;
    try {
      const c = await refreshClip(true);
      const tr = state.track, media = state.media;
      if (!tr || !state.target) throw new Error('Track the subject first.');
      const last = Math.max(1, frameOf(state.dur) - 1);
      const fA = clamp(frameOf(state.tIn), 0, last), fB = clamp(frameOf(state.tOut) - 1, fA + 1, last);
      if (fA < tr.f0 || fB > tr.f0 + tr.pts.length - 1) throw new Error('The range is outside the track. Track again.');
      const pts = tr.pts.slice(fA - tr.f0, fB - tr.f0 + 1);
      const smooth = Number($('smooth').value) / 100;
      const keys = window.Trackr.solve(pts.map((p) => ({ x: p.x * media.w, y: p.y * media.h })), {
        // Solved in the clip's own pixel space: the Transform effect starts at centre, 100%.
        fps: c.fps, seqW: media.w, seqH: media.h, mediaW: media.w, mediaH: media.h,
        basePos: [0.5, 0.5], baseScale: 100, anchor: [0.5, 0.5],
        zoom: Number($('zoom').value) / 100, easeSec: Number($('ease').value),
        smoothSec: 0.03 + smooth * smooth * 0.9, hold: holdPoint(),
        zoomBack: $('back').checked, keyStep: Math.max(1, Math.round(c.fps / 12)),
      });
      status('Writing ' + keys.length + ' keyframes…');
      // With no ease, the zoom cuts in and out: a resting key one frame before the range keeps
      // the frames before In unzoomed, and (with "Zoom back out") one frame after Out cuts back.
      if (!(Number($('ease').value) > 0)) {
        const rest = { x: 0.5, y: 0.5, s: 100 };
        if (fA > 0) keys.unshift(Object.assign({ f: -1 }, rest));
        if ($('back').checked && fB < last) keys.push(Object.assign({ f: fB - fA + 1 }, rest));
      }
      const rows = keys.map((k) => [(c.inPoint + (fA + k.f) / c.fps).toFixed(5), k.x.toFixed(6), k.y.toFixed(6), k.s.toFixed(3)].join(','));
      await host('apply', c.nodeId + '|' + rows.join(';'));
      status('Applied. To make text follow, select the text clip', 'ok');
      ok = true;
    } catch (e) {
      status(e.message, 'error');
    } finally {
      setBusy(false);
    }
    return ok;
  }

  // Both steps in one go (kept for scripting and tests).
  async function trackAndApply() {
    return (await track()) && apply();
  }

  /* Path for an attached clip. follow (0..1) smooths the movement; easeSec blends the clip
   * from resting into following at the start, and back to resting at the end. */
  function attachPath(sx, sy, f, follow, easeSec) {
    const n = sx.length, g = window.Trackr.gaussianSmooth, sig = follow * follow * 0.9 * f;
    let easeF = Math.round(easeSec * f);
    if (easeF * 2 > n - 1) easeF = Math.floor((n - 1) / 2);
    const e = window.Trackr.easeInOut, w = new Array(n);
    for (let i = 0; i < n; i++) w[i] = easeF < 1 ? 1 : Math.min(e(i / easeF), e((n - 1 - i) / easeF));
    return { X: g(sx, sig), Y: g(sy, sig), w };
  }

  /* Make the selected text or graphic clip follow the tracked subject, keeping the
   * offset it has from the subject at the playhead. */
  async function attach() {
    if (state.busy || !cep) return;
    try {
      const src = state.clip, tr = state.track, m = state.media;
      if (!src || !tr) throw new Error('Track a subject first.');
      const o = await host('info');
      if (o.nodeId === src.nodeId) throw new Error('Select the text or graphic clip to attach.');
      setBusy(true, 'attach');
      const f = src.fps;
      const fa = Math.max(tr.f0, Math.ceil((o.start - src.start) * f - 1e-6));
      const fb = Math.min(tr.f0 + tr.pts.length - 1, Math.floor((o.end - src.start) * f + 1e-6) - 1);
      const n = fb - fa + 1;
      if (n < 2) throw new Error('That clip does not overlap the tracked part of the video.');
      // Where the video's own Transform effect (the follow zoom) puts the picture on each frame.
      const smp = await host('sample', [src.nodeId, (src.inPoint + fa / f).toFixed(5), (1 / f).toFixed(7), n].join('|'));
      const s0 = src.scale / 100, sx = [], sy = [];
      for (let i = 0; i < n; i++) {
        const p = tr.pts[fa + i - tr.f0];
        const z = smp.has ? smp.s[i] / 100 : 1, px = smp.has ? smp.x[i] : 0.5, py = smp.has ? smp.y[i] : 0.5;
        const mx = (px + (p.x - 0.5) * z) * m.w, my = (py + (p.y - 0.5) * z) * m.h;
        sx.push(src.pos[0] * src.seqW + (mx - src.anchor[0] * m.w) * s0);
        sy.push(src.pos[1] * src.seqH + (my - src.anchor[1] * m.h) * s0);
      }
      // Follow and Ease come from the sliders. At 0 the text locks to the raw track, one keyframe per frame.
      const k = attachPath(sx, sy, f, Number($('smooth').value) / 100, Number($('ease').value));
      const X = k.X, Y = k.Y, rows = [];
      const ref = clamp(frameOf(o.playhead - src.start), fa, fb) - fa;
      for (let i = 0; i < n; i++) {
        const t = o.inPoint + (src.start + (fa + i) / f - o.start);
        rows.push([t.toFixed(5), (0.5 + k.w[i] * (X[i] - X[ref]) / src.seqW).toFixed(6), (0.5 + k.w[i] * (Y[i] - Y[ref]) / src.seqH).toFixed(6), '100'].join(','));
      }
      status('Writing ' + rows.length + ' keyframes…');
      await host('apply', o.nodeId + '|' + rows.join(';'));
      status('Attached ' + o.name + ' to the subject', 'ok');
    } catch (e) {
      status(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (state.busy || !cep) return;
    try {
      const c = await host('info');
      await host('reset', c.nodeId);
      draw(); // the track itself stays, so text can still be attached to it
      status('Clip restored', 'ok');
    } catch (e) { status(e.message, 'error'); }
  }

  /* ---------- controls ---------- */
  const labels = {
    zoom: (v) => v + '%',
    box: (v) => v + '%',
    smooth: (v) => (v < 20 ? 'Tight' : v < 60 ? 'Smooth' : 'Loose'),
    ease: (v) => Number(v).toFixed(1) + ' s',
  };
  Object.keys(labels).forEach((id) => {
    const el = $(id), out = $(id + 'Out');
    const sync = () => {
      el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
      out.textContent = labels[id](el.value);
      if (id === 'box') { dropTrack(); draw(); }
      if (id === 'zoom') draw();
    };
    el.addEventListener('input', sync); sync();
  });
  $('framing').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setFraming(b.dataset.v);
    draw();
  });
  try { const saved = localStorage.getItem('fz.thirds'); if (saved != null) $('thirds').checked = saved === '1'; } catch (e) { /* default on */ }
  $('thirds').addEventListener('change', () => {
    try { localStorage.setItem('fz.thirds', $('thirds').checked ? '1' : '0'); } catch (e) { /* ignore */ }
    draw();
  });
  $('refresh').addEventListener('click', () => { if (!state.busy) refreshClip(false).catch(() => {}); });
  $('setIn').addEventListener('click', () => setRange('in'));
  $('setOut').addEventListener('click', () => setRange('out'));
  $('track').addEventListener('click', track);
  $('apply').addEventListener('click', apply);
  $('reset').addEventListener('click', reset);
  $('attach').addEventListener('click', attach);

  if (window.ResizeObserver) new ResizeObserver(layout).observe(document.body);
  window.addEventListener('resize', layout);

  /* ---------- host theme ---------- */
  function applyTheme() {
    try {
      const c = JSON.parse(cep.getHostEnvironment()).appSkinInfo.panelBackgroundColor.color;
      const rgb = [c.red, c.green, c.blue].map(Math.round);
      if (rgb[0] + rgb[1] + rgb[2] < 3 * 110) document.documentElement.style.setProperty('--bg', 'rgb(' + rgb.join(',') + ')');
    } catch (e) { /* keep defaults */ }
  }

  /* ---------- browser preview (outside Premiere) ---------- */
  function demoRun() {
    if (!state.target) return status('Click the subject in the frame first.', 'error');
    setBusy(true, 'track');
    let p = 0;
    const t = setInterval(() => {
      p += 0.04; progress(Math.min(1, p)); status('Tracking ' + Math.round(Math.min(1, p) * 100) + '%');
      if (p >= 1) {
        clearInterval(t);
        state.track = { f0: 0, pts: Array.from({ length: 160 }, () => ({ x: state.target.x, y: state.target.y, half: 0.07 })) };
        setBusy(false); draw(); status('Tracked. Scroll the clip to check, then Apply', 'ok'); setTimeout(() => progress(null), 600);
      }
    }, 40);
  }

  async function start() {
    if (cep) {
      applyTheme();
      layout();
      try {
        await new Promise((r) => cep.evalScript('$.evalFile(' + JSON.stringify(extDir().replace(/\\/g, '/') + '/host/index.jsx') + ')', r));
      } catch (e) { /* the manifest already loaded it */ }
      await refreshClip(false).catch(() => {});
      setInterval(pollPlayhead, 250);
    } else {
      const q = new URLSearchParams(location.search);
      state.dur = 6.4; state.tOut = 6.4; state.tIn = 0.8; state.tCur = 2.2;
      $('clip').classList.add('live');
      $('clipName').textContent = 'A001_talking-head.mp4';
      $('clipMeta').textContent = '0:06.40 · 1920×1080 · 25 fps';
      if (q.get('portrait')) { state.media = { w: 1080, h: 1920 }; $('clipMeta').textContent = '0:06.40 · 1080×1920 · 25 fps'; }
      await setFrame('demo.jpg', 2.2);
      state.target = { x: 0.5, y: 0.36, t: 2.2 };
      status('Preview mode: open this panel in Premiere to use it');
      layout();
    }
  }
  window.FZPanel = { state, parseProbe, probe, findBin, attach, attachPath, setOther, cropFor, holdPoint, setFraming, refreshClip, track, apply, trackAndApply, trackRange, reset, host, layout, seek, draw };
  start();
})();
