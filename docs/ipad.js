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
    try {
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
