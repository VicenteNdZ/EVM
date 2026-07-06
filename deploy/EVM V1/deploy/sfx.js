(function () {
  if (window.__sfxInstalled) return;
  window.__sfxInstalled = true;

  var ac = null;
  function ctx() {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    return ac;
  }
  function muted() { try { return localStorage.getItem('agd_muted') === '1'; } catch (e) { return false; } }

  function tone(opts) {
    var a = ctx(); if (!a) return;
    var t0 = a.currentTime + (opts.when || 0);
    var o = a.createOscillator(), g = a.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.f, t0);
    if (opts.f2 != null) { try { o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f2), t0 + opts.dur); } catch (e) {} }
    var peak = opts.gain == null ? 0.18 : opts.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    o.connect(g); g.connect(a.destination);
    o.start(t0); o.stop(t0 + opts.dur + 0.02);
  }
  function noise(dur, gain, hp) {
    var a = ctx(); if (!a) return;
    var n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    var src = a.createBufferSource(); src.buffer = buf;
    var g = a.createGain(); g.gain.value = gain == null ? 0.12 : gain;
    var node = src;
    if (hp) { var f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; src.connect(f); node = f; }
    node.connect(g); g.connect(a.destination); src.start(a.currentTime);
  }

  var S = {
    click: function () { tone({ f: 1050, dur: 0.06, type: 'sine', gain: 0.13, attack: 0.004 }); tone({ f: 1570, dur: 0.05, when: 0.012, type: 'sine', gain: 0.06 }); },
    soft:  function () { tone({ f: 420, f2: 880, dur: 0.07, type: 'sine', gain: 0.16 }); },
    tick:  function () { tone({ f: 2100, dur: 0.025, type: 'square', gain: 0.1 }); },
    toggle:function () { tone({ f: 700, f2: 1100, dur: 0.05, type: 'triangle', gain: 0.14 }); },
    success: function () { [{ f: 660, t: 0 }, { f: 880, t: 0.09 }, { f: 1320, t: 0.18 }].forEach(function (s) { tone({ f: s.f, dur: 0.22, when: s.t, type: 'sine', gain: 0.16 }); }); },
    error: function () { tone({ f: 392, dur: 0.2, type: 'square', gain: 0.16 }); tone({ f: 300, dur: 0.28, when: 0.14, type: 'square', gain: 0.16 }); },
    key: function () { noise(0.03, 0.12, 1500); tone({ f: 320, dur: 0.04, type: 'square', gain: 0.08 }); }
  };

  function play(name) { if (muted()) return; var f = S[name] || S.click; try { f(); } catch (e) {} }
  window.SFX = { play: play, tone: tone, noise: noise };

  // choose a sound based on what was clicked
  function pick(el) {
    var t = (el.getAttribute && (el.getAttribute('data-sfx'))) || '';
    if (t && S[t]) return t;
    var title = ((el.getAttribute && el.getAttribute('title')) || '').toLowerCase();
    var txt = (el.textContent || '').trim().toLowerCase();
    if (/elimin|borrar|error|cerrar sesión/.test(title + ' ' + txt)) return 'error';
    if (/guardar|crear|confirm|aceptar|añadir|agregar/.test(title + ' ' + txt)) return 'success';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return 'tick';
    var role = (el.getAttribute && el.getAttribute('role')) || '';
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button') return 'click';
    return null;
  }

  document.addEventListener('pointerdown', function (e) {
    if (muted()) return;
    if (e.button != null && e.button !== 0) return;
    var el = e.target;
    // ignore the canvas / drawing surface so measuring isn't noisy
    if (el && (el.tagName === 'CANVAS')) return;
    var hit = el && el.closest ? el.closest('button, a, [role="button"], input, textarea, select, [data-sfx]') : null;
    if (!hit) return;
    if (hit.tagName === 'CANVAS') return;
    var name = pick(hit);
    if (name) play(name);
  }, true);
})();
