/* TRACKR host script (ExtendScript, runs inside Premiere Pro).
 * Every function returns a JSON string: {"ok":true,...} or {"ok":false,"error":"..."}. */
var TRACKR = (function () {
  var TICKS_PER_SECOND = 254016000000;

  function q(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
  }
  function fail(msg) { return '{"ok":false,"error":' + q(msg) + '}'; }

  function findClip() {
    if (!app.project) return { error: 'Open a project first.' };
    var seq = app.project.activeSequence;
    if (!seq) return { error: 'Open a sequence first.' };
    var sel = seq.getSelection();
    var clip = null, i;
    for (i = 0; sel && i < sel.length; i++) {
      if (sel[i].mediaType === 'Video') { clip = sel[i]; break; }
    }
    if (!clip) return { error: 'Select a video clip in the timeline.' };
    var motion = null;
    for (i = 0; i < clip.components.numItems; i++) {
      if (clip.components[i].matchName === 'AE.ADBE Motion') { motion = clip.components[i]; break; }
    }
    if (!motion) return { error: 'This clip has no Motion effect.' };
    return { seq: seq, clip: clip, pos: motion.properties[0], scale: motion.properties[1], anchor: motion.properties[5] };
  }

  var TRANSFORM = 'AE.ADBE Geometry';

  function findTransform(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
      if (clip.components[i].matchName === TRANSFORM) return clip.components[i];
    }
    return null;
  }

  /* Adding an effect is only possible through the QE DOM, which addresses clips by track and start time. */
  function addTransform(f) {
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var seq = f.seq, track = -1, i, j;
    for (i = 0; i < seq.videoTracks.numTracks && track < 0; i++) {
      var clips = seq.videoTracks[i].clips;
      for (j = 0; j < clips.numItems; j++) {
        if (clips[j].nodeId === f.clip.nodeId) { track = i; break; }
      }
    }
    if (track < 0) return null;
    var qt = qseq.getVideoTrackAt(track);
    for (i = 0; i < qt.numItems; i++) {
      var it = qt.getItemAt(i);
      if (it && it.type === 'Clip' && Math.abs(it.start.secs - f.clip.start.seconds) < 0.002) {
        it.addVideoEffect(qe.project.getVideoEffectByName('Transform'));
        break;
      }
    }
    return findTransform(f.clip);
  }

  function transformParams(fx) {
    var out = { pos: null, scale: null, width: null, uniform: null, anchor: null };
    for (var i = 0; i < fx.properties.numItems; i++) {
      var n = fx.properties[i].displayName;
      if (n === 'Position') out.pos = fx.properties[i];
      else if (n === 'Anchor Point') out.anchor = fx.properties[i];
      else if ((n === 'Scale' || n === 'Scale Height') && !out.scale) out.scale = fx.properties[i];
      else if (n === 'Scale Width') out.width = fx.properties[i];
      else if (n === 'Uniform Scale') out.uniform = fx.properties[i];
    }
    return out;
  }

  function valueOf(param, time) {
    return param.isTimeVarying() ? param.getValueAtTime(time) : param.getValue();
  }

  function clearKeys(param) {
    if (!param.isTimeVarying()) return;
    var keys = param.getKeys();
    if (!keys) return;
    for (var i = keys.length - 1; i >= 0; i--) param.removeKey(keys[i], false);
  }

  function seconds(t) {
    var time = new Time();
    time.seconds = t;
    return time;
  }

  function info() {
    try {
      var f = findClip();
      if (f.error) return fail(f.error);
      var c = f.clip, s = f.seq;
      var pos = valueOf(f.pos, c.inPoint), scl = valueOf(f.scale, c.inPoint), anc = valueOf(f.anchor, c.inPoint);
      var speed = 1, reversed = false;
      try { speed = c.getSpeed(); reversed = !!c.isSpeedReversed(); } catch (e1) {}
      var path = '';
      try { if (c.projectItem) path = c.projectItem.getMediaPath() || ''; } catch (e2) {}
      return '{"ok":true' +
        ',"name":' + q(c.name) +
        ',"path":' + q(path) +
        ',"nodeId":' + q(c.nodeId) +
        ',"start":' + c.start.seconds +
        ',"end":' + c.end.seconds +
        ',"inPoint":' + c.inPoint.seconds +
        ',"outPoint":' + c.outPoint.seconds +
        ',"speed":' + speed +
        ',"reversed":' + (reversed ? 'true' : 'false') +
        ',"seqW":' + s.frameSizeHorizontal +
        ',"seqH":' + s.frameSizeVertical +
        ',"fps":' + (TICKS_PER_SECOND / Number(s.timebase)) +
        ',"playhead":' + s.getPlayerPosition().seconds +
        ',"pos":[' + pos[0] + ',' + pos[1] + ']' +
        ',"scale":' + scl +
        ',"anchor":[' + anc[0] + ',' + anc[1] + ']' +
        ',"animated":' + ((f.pos.isTimeVarying() || f.scale.isTimeVarying()) ? 'true' : 'false') +
        '}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  /* data: "<nodeId>|t,x,y,s;t,x,y,s;..."  (t = source seconds, x/y normalised, s = percent) */
  function apply(data) {
    try {
      var bar = data.indexOf('|');
      var nodeId = data.substring(0, bar), rows = data.substring(bar + 1).split(';');
      var f = findClip();
      if (f.error) return fail(f.error);
      if (String(f.clip.nodeId) !== nodeId) return fail('The selection changed. Select the clip again.');
      var fx = findTransform(f.clip), added = false;
      if (!fx) { fx = addTransform(f); added = true; }
      if (!fx) return fail('Could not add the Transform effect to this clip.');
      var p = transformParams(fx);
      if (!p.pos || !p.scale) return fail('The Transform effect has no Position or Scale to animate.');
      // Scale both axes: width is keyed too, in case Uniform Scale cannot be switched on.
      try { if (p.uniform) p.uniform.setValue(true, true); } catch (eU) {}
      clearKeys(p.pos); clearKeys(p.scale);
      p.pos.setTimeVarying(true);
      p.scale.setTimeVarying(true);
      if (p.width) { clearKeys(p.width); p.width.setTimeVarying(true); }
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i].split(',');
        var t = seconds(parseFloat(r[0]));
        var last = i === rows.length - 1;
        p.pos.addKey(t);
        p.pos.setValueAtKey(t, [parseFloat(r[1]), parseFloat(r[2])], last);
        p.scale.addKey(t);
        p.scale.setValueAtKey(t, parseFloat(r[3]), last);
        if (p.width) { p.width.addKey(t); p.width.setValueAtKey(t, parseFloat(r[3]), last); }
      }
      return '{"ok":true,"keys":' + rows.length + ',"added":' + (added ? 'true' : 'false') + '}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  /* data: "<nodeId>". Clears the follow zoom from the clip's Transform effect. */
  function reset(data) {
    try {
      var f = findClip();
      if (f.error) return fail(f.error);
      if (String(f.clip.nodeId) !== String(data)) return fail('Select the clip you want to reset.');
      var fx = findTransform(f.clip);
      if (!fx) return fail('Nothing to reset on this clip.');
      var p = transformParams(fx);
      clearKeys(p.pos); clearKeys(p.scale);
      p.pos.setTimeVarying(false);
      p.scale.setTimeVarying(false);
      p.pos.setValue([0.5, 0.5], true);
      p.scale.setValue(100, true);
      if (p.width) { clearKeys(p.width); p.width.setTimeVarying(false); p.width.setValue(100, true); }
      return '{"ok":true}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  /* Clears Position/Scale keyframes from Motion (written by early versions of this panel). data: "<nodeId>|x,y,s" */
  function resetMotion(data) {
    try {
      var bar = data.indexOf('|');
      var nodeId = data.substring(0, bar), v = data.substring(bar + 1).split(',');
      var f = findClip();
      if (f.error) return fail(f.error);
      if (String(f.clip.nodeId) !== nodeId) return fail('Select the clip you want to reset.');
      clearKeys(f.pos); clearKeys(f.scale);
      f.pos.setTimeVarying(false);
      f.scale.setTimeVarying(false);
      f.pos.setValue([parseFloat(v[0]), parseFloat(v[1])], true);
      f.scale.setValue(parseFloat(v[2]), true);
      return '{"ok":true}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  /* Debug: read back the Transform keys on the selected clip, and list its effects. */
  function dump() {
    try {
      var f = findClip();
      if (f.error) return fail(f.error);
      var comps = [], i, j;
      for (i = 0; i < f.clip.components.numItems; i++) {
        var c = f.clip.components[i], names = [];
        for (j = 0; j < c.properties.numItems; j++) names.push(q(c.properties[j].displayName));
        comps.push('{"name":' + q(c.displayName) + ',"match":' + q(c.matchName) + ',"props":[' + names.join(',') + ']}');
      }
      var out = [], fx = findTransform(f.clip);
      if (fx) {
        var p = transformParams(fx), keys = p.pos.isTimeVarying() ? p.pos.getKeys() : null;
        for (i = 0; keys && i < keys.length; i++) {
          var v = p.pos.getValueAtKey(keys[i]), sc = p.scale.getValueAtTime(keys[i]);
          out.push('[' + keys[i].seconds + ',' + v[0] + ',' + v[1] + ',' + sc + ']');
        }
        try { out.push('["uniform",' + q(String(p.uniform ? p.uniform.getValue() : 'none')) + ',"widthAnimated",' + (p.width && p.width.isTimeVarying() ? 'true' : 'false') + ']'); } catch (eD) {}
        if (!keys) { var pv = p.pos.getValue(); out.push('["static",' + pv[0] + ',' + pv[1] + ',' + p.scale.getValue() + ']'); }
      }
      return '{"ok":true,"motionAnimated":' + ((f.pos.isTimeVarying() || f.scale.isTimeVarying()) ? 'true' : 'false') +
        ',"components":[' + comps.join(',') + '],"keys":[' + out.join(',') + ']}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  function clipById(seq, id) {
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var clips = seq.videoTracks[i].clips;
      for (var j = 0; j < clips.numItems; j++) {
        if (String(clips[j].nodeId) === id) return clips[j];
      }
    }
    return null;
  }

  /* Reads a clip's Transform effect over time, so the panel knows where the picture really is.
   * data: "<nodeId>|<first source time>|<step>|<count>" */
  function sample(data) {
    try {
      var a = data.split('|'), t0 = parseFloat(a[1]), dt = parseFloat(a[2]), n = parseInt(a[3], 10);
      var seq = app.project ? app.project.activeSequence : null;
      if (!seq) return fail('Open a sequence first.');
      var clip = clipById(seq, a[0]);
      if (!clip) return fail('The tracked clip is no longer in this sequence.');
      var fx = findTransform(clip);
      if (!fx) return '{"ok":true,"has":false}';
      var p = transformParams(fx), xs = [], ys = [], ss = [];
      for (var i = 0; i < n; i++) {
        var t = seconds(t0 + i * dt);
        var v = valueOf(p.pos, t);
        xs.push(v[0]); ys.push(v[1]); ss.push(valueOf(p.scale, t));
      }
      return '{"ok":true,"has":true,"x":[' + xs.join(',') + '],"y":[' + ys.join(',') + '],"s":[' + ss.join(',') + ']}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  /* Light call for the panel's playhead sync: playhead time and the selected video clip. */
  function playhead() {
    try {
      var seq = app.project ? app.project.activeSequence : null;
      if (!seq) return fail('Open a sequence first.');
      var sel = seq.getSelection(), id = '';
      for (var i = 0; sel && i < sel.length; i++) {
        if (sel[i].mediaType === 'Video') { id = String(sel[i].nodeId); break; }
      }
      return '{"ok":true,"t":' + seq.getPlayerPosition().seconds + ',"nodeId":' + q(id) + '}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  /* Move Premiere's playhead to a sequence time in seconds. */
  function setPlayhead(sec) {
    try {
      var seq = app.project ? app.project.activeSequence : null;
      if (!seq) return fail('Open a sequence first.');
      seq.setPlayerPosition(String(Math.round(parseFloat(sec) * TICKS_PER_SECOND)));
      return '{"ok":true}';
    } catch (e) {
      return fail(e.toString());
    }
  }

  return { info: info, apply: apply, reset: reset, resetMotion: resetMotion, dump: dump, sample: sample, playhead: playhead, setPlayhead: setPlayhead };
})();
