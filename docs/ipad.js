/*!
 * PvZ2 Gardendless – iPad support
 * - Re-fits the game on resize / rotation / Safari toolbar changes.
 * - "Rotate your iPad" overlay in portrait (touch devices only, CSS-driven).
 * - Blocks pinch / double-tap zoom.
 * - Unlocks Web Audio on the first touch (iOS blocks autoplay).
 *
 * LOAD ORDER: classic <script> in <head>, BEFORE any game script
 * (it must patch AudioContext before the engine creates one).
 */
(function () {
  'use strict';

  // ---------- Graphics quality (render resolution + antialias) ----------
  // Drawing at the iPad's full 2x resolution with antialiasing keeps the GPU at 100%, and the
  // iPad then heats up and throttles: smooth at first, laggier over time, worst on hordes.
  //   smooth   = 1x, no antialias      balanced = 1.5x, no antialias (default on touch screens)
  //   sharp    = native, antialias (original PC behaviour, default with mouse)
  var QUALITY = { smooth: { scale: 1, aa: false }, balanced: { scale: 1.5, aa: false }, sharp: { scale: 0, aa: true } };
  var isTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  var quality = null;
  try { quality = localStorage.getItem('__pvz_quality'); } catch (e) {}
  if (!QUALITY[quality]) quality = isTouch ? 'balanced' : 'sharp';
  var q = QUALITY[quality];
  window.__pvzQuality = quality;
  var realDpr = window.devicePixelRatio || 1;
  if (q.scale && realDpr > q.scale) {
    try {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: function () { return q.scale; } });
    } catch (e) {}
  }
  if (!q.aa && window.HTMLCanvasElement) {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (this.id === 'GameCanvas' && /webgl/i.test(String(type))) {
        var a = {};
        if (attrs) for (var k in attrs) a[k] = attrs[k];
        a.antialias = false;
        a.powerPreference = 'high-performance';
        return origGetContext.call(this, type, a);
      }
      return origGetContext.apply(this, arguments);
    };
  }

  // ---------- Error log (shown in the ⚙ panel; iPad has no easy console) ----------
  var errors = window.__pvzErrors = [];
  function logError(msg) {
    msg = String(msg || 'Unknown error').slice(0, 300);
    // Normal before the first tap: browsers block sound until the user interacts.
    if (/user didn't interact|NotAllowedError|not allowed by the user agent|play failed/i.test(msg)) return;
    if (errors.length >= 20 || errors.indexOf(msg) !== -1) return;
    errors.push(msg);
    try { window.dispatchEvent(new CustomEvent('pvz:error', { detail: msg })); } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) {
      logError('Failed to load ' + (e.target.src || e.target.href));
    } else {
      logError((e.message || 'Script error') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    logError('Unhandled: ' + (r && (r.stack || r.message) ? (r.message || r.stack) : r));
  });
  var origConsoleError = console.error;
  console.error = function () {
    if (errors.length < 20) try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && a.message ? a.message : typeof a === 'string' ? a : (function () { try { return JSON.stringify(a); } catch (x) { return String(a); } })());
      }
      logError(parts.join(' '));
    } catch (e) {}
    return origConsoleError.apply(console, arguments);
  };

  // ---------- Audio unlock ----------
  // Constructors are wrapped with plain factory functions (not `class extends`), because
  // Safari can refuse to subclass built-in media constructors. Any failure falls back to the
  // original constructor, so the game's audio can never be broken by this file.
  function wrapConstructor(name, onCreate) {
    var Orig = window[name];
    if (typeof Orig !== 'function') return;
    function Wrapped() {
      var obj;
      switch (arguments.length) {
        case 0: obj = new Orig(); break;
        case 1: obj = new Orig(arguments[0]); break;
        default: obj = new Orig(arguments[0], arguments[1]);
      }
      try { onCreate(obj); } catch (e) {}
      return obj;
    }
    try {
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig); // keep static members (e.g. AudioContext.prototype checks)
      window[name] = Wrapped;
    } catch (e) {
      window[name] = Orig;
    }
  }

  var audioContexts = [];
  wrapConstructor('AudioContext', function (ctx) { audioContexts.push(ctx); });
  wrapConstructor('webkitAudioContext', function (ctx) { audioContexts.push(ctx); });

  function unlockAudio() {
    audioContexts.forEach(function (ctx) {
      if (ctx.state === 'running' || ctx.state === 'closed') return;
      try {
        ctx.resume();
        var buf = ctx.createBuffer(1, 1, 22050);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch (e) {}
    });
  }
  // HTML <audio> elements (this game's audio engine pools 60 of them). iOS only lets an
  // element play from script after it has played once during a user gesture, so on the
  // first touch every idle, source-less element plays a silent clip muted, then resets.
  var SILENT_WAV = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA';
  var audioElements = [];
  wrapConstructor('Audio', function (el) { audioElements.push(el); });
  var elementsUnlocked = false;
  function unlockAudioElements() {
    if (elementsUnlocked) return;
    elementsUnlocked = true;
    audioElements.forEach(function (el) {
      var src = el.getAttribute('src');
      if (!el.paused || (src && src !== SILENT_WAV)) return; // never touch the game's sounds
      el.muted = true;
      el.src = SILENT_WAV;
      var p = el.play();
      var reset = function () {
        el.muted = false; // always restore, even if the game took the element over meanwhile
        if (el.getAttribute('src') !== SILENT_WAV) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
      };
      if (p && p.then) p.then(reset, reset);
      else reset();
    });
  }

  // Kept permanently: iOS suspends ("interrupted") audio after backgrounding.
  function onGesture() { unlockAudio(); unlockAudioElements(); }
  ['touchend', 'pointerup', 'mouseup', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, onGesture, { capture: true, passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') unlockAudio();
  });

  // ---------- Touch → mouse bridge ----------
  // The game was built for PC: seed packets, planting, sun, shovel etc. listen for MOUSE
  // events, which the engine never produces from finger touches. Here touches on the game
  // canvas are turned into the mouse events a PC would send, and the original touch events
  // are stopped so nothing is handled twice (the engine already turns mouse into touch for
  // its own buttons and scroll views).
  //   1 finger: left button (tap = click, drag = drag)
  //   2-finger tap: right button   ·   2-finger swipe / pinch: mouse wheel
  (function () {
    var PRESS_DELAY_MS = 60;   // a held finger presses after this (if no second finger joined)
    var TWO_FINGER_WINDOW_MS = 120; // a second finger within this = 2-finger gesture
    var RESTING_MS = 300;      // a finger held still this long yields to a new finger
    var MOVE_SLOP_PX = 6;      // moving further than this presses immediately
    var TAP_SLOP_PX = 15;      // 2-finger tap must move less than this
    var TAP_MAX_MS = 500;
    var WHEEL_PER_PX = 2;      // wheel delta per finger pixel
    var DROP_MIN_PX = 30;      // a drag this long while holding a seed/shovel drops it on release

    // Is the player holding something (seed, shovel, Plant Food, Zen Garden glove/cart)?
    // The PC game places items with a click; this lets a drag-and-release place them too.
    var holders = null, holdersScene = null;
    function holdingSomething() {
      var cc = window.cc;
      if (!cc || !cc.director || !cc.Component) return false;
      var scene = cc.director.getScene();
      if (!scene) return false;
      if (scene !== holdersScene || !holders || holders.some(function (c) { return !c.isValid; })) {
        holdersScene = scene;
        holders = scene.getComponentsInChildren(cc.Component).filter(function (c) {
          return c && (c.plantInHandLayer || c.gloveInHand || c.cartInHand);
        });
      }
      return holders.some(function (c) {
        var layer = c.plantInHandLayer;
        if (layer && layer.children && layer.children.some(function (n) { return n.active; })) return true;
        return !!((c.gloveInHand && c.gloveInHand.active) || (c.cartInHand && c.cartInHand.active));
      });
    }

    var canvas = null;
    var primary = null;        // the finger acting as the mouse
    var multi = null;          // 2-finger gesture { a, b (touch ids), start, moved, lastMid, lastDist, rx, ry }

    function isGameTarget(e) {
      if (!canvas || !canvas.isConnected) canvas = document.getElementById('GameCanvas');
      return !!canvas && e.target === canvas;
    }

    function mouse(type, x, y, button, buttons) {
      lastSent = { x: x, y: y };
      var ev = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, composed: true,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: button, buttons: buttons
      });
      canvas.dispatchEvent(ev);
    }

    function wheel(x, y, dx, dy) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0
      }));
    }

    // Touch screens report movement up to 120-240 times a second at uneven intervals. The game
    // (and its level-map momentum) expects one smooth cursor update per frame, so moves and
    // wheel steps are merged and sent once per animation frame.
    var pendingMove = null, pendingWheel = null, rafId = 0, lastSent = null;
    var STEP_PX = 40; // fill in long jumps so fast sweeps don't skip over sun
    function schedule() { if (!rafId) rafId = requestAnimationFrame(flushInput); }
    function flushInput() {
      rafId = 0;
      if (pendingMove) {
        var m = pendingMove; pendingMove = null;
        if (lastSent) {
          var dist = Math.hypot(m.x - lastSent.x, m.y - lastSent.y);
          var steps = Math.min(8, Math.floor(dist / STEP_PX));
          for (var i = 1; i <= steps; i++) {
            var f = i / (steps + 1);
            mouse('mousemove', lastSent.x + (m.x - lastSent.x) * f, lastSent.y + (m.y - lastSent.y) * f, 0, m.buttons);
          }
        }
        mouse('mousemove', m.x, m.y, 0, m.buttons);
      }
      if (pendingWheel) { var w = pendingWheel; pendingWheel = null; wheel(w.x, w.y, w.dx, w.dy); }
    }
    function flushNow() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } flushInput(); }
    function queueMove(x, y, buttons) { pendingMove = { x: x, y: y, buttons: buttons }; schedule(); }
    function queueWheel(x, y, dx, dy) {
      if (pendingWheel) { pendingWheel.x = x; pendingWheel.y = y; pendingWheel.dx += dx; pendingWheel.dy += dy; }
      else pendingWheel = { x: x, y: y, dx: dx, dy: dy };
      schedule();
    }

    function press() {
      if (!primary || primary.pressed) return;
      clearTimeout(primary.timer);
      primary.pressed = true;
      pendingMove = null;
      // Press where the finger first touched (like clicking where the cursor was), then
      // catch up to where it is now.
      mouse('mousemove', primary.sx, primary.sy, 0, 0);
      mouse('mousedown', primary.sx, primary.sy, 0, 1);
      if (primary.x !== primary.sx || primary.y !== primary.sy) queueMove(primary.x, primary.y, 1);
    }

    function find(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
      return null;
    }

    function pairState(a, b) {
      return {
        mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      };
    }

    // Work still owed to the game when a new touch begins (a very quick tap waiting for the
    // game to see the cursor, or a drag-and-drop click). It runs right away instead of being
    // dropped, so rapid taps never get lost.
    var owed = null;
    function settleOwed() { if (owed) { var f = owed; owed = null; f(); } }

    function releaseOffscreen() {
      // Let go far outside the game so nothing gets clicked by an interrupted touch.
      mouse('mousemove', -10000, -10000, 0, 1);
      mouse('mouseup', -10000, -10000, 0, 0);
    }

    function cancelPrimary() {
      if (!primary) return;
      clearTimeout(primary.timer);
      primary.onReady = null;
      pendingMove = null;
      if (primary.pressed) releaseOffscreen();
      primary = null;
    }

    // Recover from touches the system never finished (app switched, notification, system
    // swipe, rotation): anything we track that is no longer on the screen is released.
    function dropStale(e) {
      if (primary && !find(e.touches, primary.id)) cancelPrimary();
      if (multi && (!find(e.touches, multi.a) || !find(e.touches, multi.b))) multi = null;
    }
    function resetAll() {
      owed = null;
      cancelPrimary();
      multi = null;
      pendingWheel = null;
    }

    function startMulti(a, b, rx, ry) {
      var st = pairState(a, b);
      multi = { a: a.identifier, b: b.identifier, start: Date.now(), moved: 0,
                lastMid: st.mid, lastDist: st.dist, rx: rx, ry: ry };
    }

    function rightClick(x, y) {
      mouse('mousemove', x, y, 0, 0);
      mouse('mousedown', x, y, 2, 2);
      mouse('mouseup', x, y, 2, 0);
    }

    function onStart(e) {
      if (!isGameTarget(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      unlockAudio(); unlockAudioElements();
      dropStale(e);
      var now = Date.now();
      var ch = e.changedTouches;

      if (multi) return; // extra fingers during a 2-finger gesture are ignored

      if (primary && primary.pressed && now - primary.t0 > RESTING_MS &&
          Math.hypot(primary.x - primary.sx, primary.y - primary.sy) <= MOVE_SLOP_PX) {
        // The current finger has been sitting still (a thumb resting on the glass while
        // holding the iPad): let it go without clicking, and the new finger takes over.
        cancelPrimary();
      }

      if (primary) {
        // A second finger shortly after the first (before it pressed) = 2-finger gesture.
        // Other extra fingers while one is actively dragging are ignored.
        if (!primary.pressed && now - primary.t0 <= TWO_FINGER_WINDOW_MS) {
          var first = find(e.touches, primary.id);
          if (first && ch[0]) {
            var rx = primary.sx, ry = primary.sy;
            clearTimeout(primary.timer);
            primary.onReady = null;
            primary = null;
            pendingMove = null;
            startMulti(first, ch[0], rx, ry);
          }
        }
        return;
      }

      settleOwed();
      if (ch.length >= 2) { startMulti(ch[0], ch[1], ch[0].clientX, ch[0].clientY); return; }

      // New primary finger. Other fingers already resting on the screen don't matter.
      var t = ch[0];
      var p = primary = { id: t.identifier, t0: now, x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY,
                          pressed: false, ready: false, onReady: null, timer: 0 };
      mouse('mousemove', t.clientX, t.clientY, 0, 0); // hover first, like a real cursor
      // The game finds the lawn tile under the cursor once per frame: let two frames pass
      // after the hover before any click, or a quick tap can land before the game "sees" it.
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        p.ready = true;
        if (p.onReady) { var f = p.onReady; p.onReady = null; f(); }
      }); });
      p.timer = setTimeout(function () {
        if (primary !== p) return;
        if (p.ready) press(); else p.onReady = function () { if (primary === p) press(); };
      }, PRESS_DELAY_MS);
    }

    function onMove(e) {
      if (!isGameTarget(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      if (multi) {
        var a = find(e.touches, multi.a), b = find(e.touches, multi.b);
        if (!a || !b) return;
        var st = pairState(a, b);
        var dx = st.mid.x - multi.lastMid.x, dy = st.mid.y - multi.lastMid.y;
        var dd = st.dist - multi.lastDist;
        multi.moved += Math.abs(dx) + Math.abs(dy) + Math.abs(dd);
        if (multi.moved >= TAP_SLOP_PX) {
          if (Math.abs(dd) > Math.abs(dy) && Math.abs(dd) > Math.abs(dx)) {
            queueWheel(st.mid.x, st.mid.y, 0, -dd * WHEEL_PER_PX);                  // pinch out = zoom in
          } else if (dx || dy) {
            queueWheel(st.mid.x, st.mid.y, -dx * WHEEL_PER_PX, -dy * WHEEL_PER_PX); // natural scrolling
          }
        }
        multi.lastMid = st.mid; multi.lastDist = st.dist;
        return;
      }

      if (!primary) return;
      var t = find(e.changedTouches, primary.id);
      if (!t) return;
      primary.x = t.clientX; primary.y = t.clientY;
      if (!primary.pressed && Math.hypot(t.clientX - primary.sx, t.clientY - primary.sy) > MOVE_SLOP_PX) press();
      else queueMove(t.clientX, t.clientY, primary.pressed ? 1 : 0);
    }

    function onEnd(e) {
      var onGame = isGameTarget(e);
      if (!onGame && !primary && !multi) return;
      if (onGame) { e.preventDefault(); e.stopImmediatePropagation(); }

      if (multi) {
        // Finish as soon as either finger lifts, so a finger left on the glass can't freeze it.
        if (find(e.touches, multi.a) && find(e.touches, multi.b)) return;
        flushNow();
        var m = multi;
        multi = null;
        if (e.type === 'touchend' && Date.now() - m.start <= TAP_MAX_MS && m.moved < TAP_SLOP_PX) rightClick(m.rx, m.ry);
        return;
      }

      if (!primary) return;
      var t = find(e.changedTouches, primary.id);
      if (!t) return;
      if (e.type === 'touchcancel') { cancelPrimary(); return; }

      primary.x = t.clientX; primary.y = t.clientY;
      if (!primary.pressed && !primary.ready) {
        // Very quick tap: finish it once the game has seen the cursor arrive (or right away if
        // another touch starts first).
        var tp = primary;
        clearTimeout(tp.timer);
        primary = null;
        var finishTap = function () {
          if (owed !== finishTap) return;
          owed = null;
          primary = tp; press(); flushNow();
          mouse('mouseup', tp.x, tp.y, 0, 0);
          primary = null;
        };
        owed = finishTap;
        tp.onReady = finishTap;
        return;
      }

      var wasPressed = primary.pressed;
      press();
      if (wasPressed) queueMove(t.clientX, t.clientY, 1);
      flushNow();
      mouse('mouseup', t.clientX, t.clientY, 0, 0);
      var dragged = Math.hypot(t.clientX - primary.sx, t.clientY - primary.sy) > DROP_MIN_PX;
      primary = null;
      if (dragged) {
        // Drag-and-drop: if a seed/shovel/Plant Food is held, click where the finger lifted.
        // The game works out the tile under the cursor once per frame, so hover first and
        // click a couple of frames later, the way a real mouse click arrives.
        var x = t.clientX, y = t.clientY;
        mouse('mousemove', x, y, 0, 0);
        var drop = function () {
          if (owed !== drop) return;
          owed = null;
          var held = false;
          try { held = holdingSomething(); } catch (err) {}
          if (!held) return;
          mouse('mousemove', x, y, 0, 0);
          mouse('mousedown', x, y, 0, 1);
          mouse('mouseup', x, y, 0, 0);
        };
        owed = drop;
        setTimeout(drop, 50);
      }
    }

    // Start fresh whenever the game is interrupted mid-touch.
    window.addEventListener('blur', resetAll);
    window.addEventListener('pagehide', resetAll);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') resetAll(); });
    window.addEventListener('orientationchange', resetAll);

    var opts = { capture: true, passive: false };
    window.addEventListener('touchstart', onStart, opts);
    window.addEventListener('touchmove', onMove, opts);
    window.addEventListener('touchend', onEnd, opts);
    window.addEventListener('touchcancel', onEnd, opts);
  })();

  // ---------- Zoom / gesture blocking ----------
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });

  // ---------- Re-fit ----------
  var dispatching = false;

  function viewportSize() {
    var vv = window.visualViewport;
    return {
      w: Math.round(vv ? vv.width : window.innerWidth),
      h: Math.round(vv ? vv.height : window.innerHeight)
    };
  }

  function refit() {
    var s = viewportSize();
    var root = document.documentElement.style;
    root.setProperty('--pvz-vw', s.w + 'px');
    root.setProperty('--pvz-vh', s.h + 'px');

    // iOS can leave the page scrolled after rotation.
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);

    // Prefer the engine's own fit API when the global `cc` is exposed.
    var cc = window.cc;
    if (cc && cc.view) {
      try {
        if (typeof cc.view.resizeWithBrowserSize === 'function') cc.view.resizeWithBrowserSize(true);
      } catch (e) {}
    }

    // Let the engine (and anything else) re-read the new size.
    if (!dispatching) {
      dispatching = true;
      try { window.dispatchEvent(new Event('resize')); } finally { dispatching = false; }
    }
  }

  var timers = [];
  function scheduleRefit() {
    if (dispatching) return;
    timers.forEach(clearTimeout);
    // iOS reports final dimensions late after rotation / toolbar animation.
    timers = [0, 120, 350, 700].map(function (d) { return setTimeout(refit, d); });
  }

  window.addEventListener('resize', scheduleRefit);
  window.addEventListener('orientationchange', scheduleRefit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleRefit);
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', scheduleRefit);
  }
  window.addEventListener('pageshow', scheduleRefit);

  // ---------- Rotate overlay ----------
  function addOverlay() {
    if (document.getElementById('pvz-rotate')) return;
    var el = document.createElement('div');
    el.id = 'pvz-rotate';
    el.setAttribute('role', 'alert');
    el.innerHTML =
      '<div class="pvz-rotate-icon" aria-hidden="true"></div>' +
      '<p>Rotate your iPad to landscape to play</p>';
    document.body.appendChild(el);
    scheduleRefit();
  }
  if (document.body) addOverlay();
  else document.addEventListener('DOMContentLoaded', addOverlay);
})();
