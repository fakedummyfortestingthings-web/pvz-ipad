/*!
 * PvZ2 Gardendless – offline + save UI
 * - Registers the service worker.
 * - Online/offline indicator + settings pill (export/import, sync now, download for offline).
 * - Toasts (used by cloud-sync.js via window.PVZUI.toast).
 *
 * LOAD ORDER: <script src="pvz-ui.js" defer> at the end of <body>, after save-store.js.
 */
(function () {
  'use strict';

  var swVersion = null;

  // ---------- Service worker ----------
  var swSupported = 'serviceWorker' in navigator && (location.protocol === 'https:' ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  function askVersion(target) {
    if (target) target.postMessage({ type: 'GET_VERSION' });
  }

  if (swSupported) {
    // The worker lives next to the page itself (not under <base href>), so it controls the whole game.
    var swUrl = new URL('sw.js', location.href).href;
    navigator.serviceWorker.register(swUrl).then(function (reg) {
      askVersion(navigator.serviceWorker.controller || reg.active);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'activated' && navigator.serviceWorker.controller) {
            toast('Game updated.', 'Reload', function () { location.reload(); });
          }
        });
      });
    }).catch(function (e) {
      console.warn('[PVZ] Service worker registration failed:', e);
    });
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'VERSION') { swVersion = e.data.version; render(); warmCache(); }
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      askVersion(navigator.serviceWorker.controller);
    });
  } else {
    console.warn('[PVZ] Service worker not available (needs HTTPS or localhost). Offline play disabled.');
  }

  // ---------- Warm cache ----------
  // On the very first visit the worker starts controlling the page only after the game has
  // loaded, so those files never passed through it. Cache everything this page already
  // loaded, so the next launch works offline even without "Download all".
  // Later visits are already cached as files load, so skip the extra work (it caused hitches).
  var firstVisit = swSupported && !navigator.serviceWorker.controller;
  var warming = false;
  function warmCache() {
    if (!firstVisit || warming || !swVersion || !navigator.serviceWorker.controller || !window.caches) return;
    warming = true;
    var origin = location.origin;
    var seen = {};
    var urls = [location.href.split('#')[0]];
    (performance.getEntriesByType ? performance.getEntriesByType('resource') : []).forEach(function (e) {
      if (e.name.indexOf(origin + '/') !== 0) return;
      if (/\/__\/|asset-list\.json|sw\.js(\?|$)/.test(e.name)) return;
      urls.push(e.name);
    });
    urls = urls.filter(function (u) { if (seen[u]) return false; seen[u] = true; return true; });
    caches.open('pvz-assets-' + swVersion).then(function (cache) {
      var i = 0;
      function next() {
        if (i >= urls.length) return Promise.resolve();
        var url = urls[i++];
        return caches.match(url).then(function (hit) {
          if (hit) return;
          return fetch(url).then(function (res) {
            if (res.ok && res.status === 200) return cache.put(url, res);
          });
        }).catch(function () {}).then(next);
      }
      var lanes = [];
      for (var w = 0; w < 4; w++) lanes.push(next());
      return Promise.all(lanes);
    }).catch(function () {}).then(function () { warming = false; });
  }
  // Re-run a few times: the game keeps loading files after the page's load event.
  window.addEventListener('load', function () {
    [60000, 180000].forEach(function (d) { setTimeout(warmCache, d); });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') warmCache();
  });

  // ---------- DOM ----------
  var hud, label, backdrop, fileInput, progress, toastEl;
  var cloud = window.__pvzCloud || { state: 'starting', detail: '' };

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  function build() {
    hud = el('div', { id: 'pvz-hud' },
      '<button type="button" class="pvz-hud-btn" data-h="fs" aria-label="Full screen">⛶</button>' +
      '<button type="button" class="pvz-hud-btn" data-h="menu" aria-label="Save, offline and graphics settings">' +
        '<span class="pvz-dot"></span><span class="pvz-hud-label"></span><span class="pvz-gear">⚙</span></button>');
    label = hud.querySelector('.pvz-hud-label');
    hud.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-h]');
      if (!b) return;
      if (b.getAttribute('data-h') === 'fs') toggleFullscreen(); else openPanel();
    });
    if (!fsSupported()) hud.querySelector('[data-h="fs"]').style.display = 'none';

    backdrop = el('div', { id: 'pvz-panel-backdrop' },
      '<div id="pvz-panel" role="dialog" aria-modal="true" aria-labelledby="pvz-panel-title">' +
        '<h2 id="pvz-panel-title">Settings</h2>' +
        '<div class="pvz-row"><span>Network</span><span data-f="net"></span></div>' +
        '<div class="pvz-row"><span>Last local save</span><span data-f="local"></span></div>' +
        '<div class="pvz-row"><span>Cloud</span><span data-f="cloud"></span></div>' +
        '<div class="pvz-row"><span>Offline pack</span><span data-f="pack"></span></div>' +
        '<div class="pvz-quality"><span>Graphics</span><div class="pvz-seg">' +
          '<button type="button" data-q="smooth">Smoothest</button>' +
          '<button type="button" data-q="balanced">Balanced</button>' +
          '<button type="button" data-q="sharp">Sharpest</button>' +
        '</div></div>' +
        '<div class="pvz-actions">' +
          '<button type="button" data-a="export">Export save</button>' +
          '<button type="button" data-a="import">Import save</button>' +
          '<button type="button" data-a="sync">Sync now</button>' +
          '<button type="button" data-a="offline">Download all for offline</button>' +
          '<button type="button" class="wide ghost" data-a="repair">Repair (clear offline copy, keeps saves)</button>' +
          '<button type="button" class="wide ghost" data-a="close">Close</button>' +
        '</div>' +
        '<div id="pvz-diag"><h3>Device</h3><pre data-f="device"></pre><h3>Problems</h3><pre data-f="errors"></pre></div>' +
        '<div id="pvz-progress"><div class="bar"><div class="fill"></div></div><div class="text"></div></div>' +
      '</div>');
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closePanel();
      var qb = e.target.closest && e.target.closest('[data-q]');
      if (qb) {
        var nq = qb.getAttribute('data-q');
        if (nq === window.__pvzQuality) return;
        try { localStorage.setItem('__pvz_quality', nq); } catch (err) {}
        if (window.PVZSave) window.PVZSave.flush();
        location.reload();
        return;
      }
      var a = e.target.closest && e.target.closest('[data-a]');
      if (!a) return;
      var act = a.getAttribute('data-a');
      if (act === 'close') closePanel();
      if (act === 'export' && window.PVZSave) window.PVZSave.exportFile();
      if (act === 'import') fileInput.click();
      if (act === 'sync') {
        if (window.PVZCloud) window.PVZCloud.syncNow('manual');
        else toast('Cloud sync is not configured.');
      }
      if (act === 'offline') downloadAll(a);
      if (act === 'repair') repair();
    });
    progress = backdrop.querySelector('#pvz-progress');

    fileInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: '' });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f || !window.PVZSave) return;
      if (!confirm('Replace your current progress with this save file?')) return;
      window.PVZSave.importFile(f).catch(function (e) { toast('Import failed: ' + e.message); });
    });

    toastEl = el('div', { id: 'pvz-toast', role: 'status' });
    probeStartupFiles();

    document.body.appendChild(hud);
    if (isTouchUI()) setTimeout(offerFullscreen, 1500);
    document.body.appendChild(backdrop);
    document.body.appendChild(fileInput);
    document.body.appendChild(toastEl);
    render();
  }

  // ---------- Full screen ----------
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsSupported() {
    var d = document.documentElement;
    return !isStandalone() && !!(d.requestFullscreen || d.webkitRequestFullscreen) &&
      (document.fullscreenEnabled !== false || document.webkitFullscreenEnabled);
  }
  function isStandalone() { return !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }
  function toggleFullscreen() {
    try {
      if (fsElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        var d = document.documentElement;
        var r = (d.requestFullscreen || d.webkitRequestFullscreen).call(d);
        if (r && r.catch) r.catch(function () { toast('Full screen isn\'t available here. Use Share → Add to Home Screen instead.'); });
      }
    } catch (e) {
      toast('Full screen isn\'t available here. Use Share → Add to Home Screen instead.');
    }
  }
  function offerFullscreen() {
    if (!fsSupported() || fsElement()) return;
    try { if (sessionStorage.getItem('__pvz_fs_offered')) return; sessionStorage.setItem('__pvz_fs_offered', '1'); } catch (e) {}
    toast('Play in full screen?', 'Full screen', toggleFullscreen);
  }

  function openPanel() { render(); backdrop.classList.add('open'); }
  function closePanel() { backdrop.classList.remove('open'); }

  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    var today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                 : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  var CLOUD_TEXT = {
    starting: 'Starting…', disabled: 'Not configured', offline: 'Waiting for connection',
    syncing: 'Syncing…', synced: 'Up to date', pending: 'Changes not uploaded yet', error: 'Error'
  };

  function packKey() { return '__pvz_pack_' + (swVersion || '?'); }

  function render() {
    if (!hud) return;
    var online = navigator.onLine;
    hud.classList.toggle('offline', !online);
    label.textContent = online ? '' : 'Offline';

    var f = function (name) { return backdrop.querySelector('[data-f="' + name + '"]'); };
    f('net').textContent = online ? 'Online' : 'Offline';
    var meta = window.PVZSave ? window.PVZSave.getMeta() : null;
    f('local').textContent = meta ? fmtTime(meta.updatedAt) : '—';
    var c = CLOUD_TEXT[cloud.state] || cloud.state;
    if (cloud.state === 'synced' && meta && meta.lastSyncedAt) c += ' · ' + fmtTime(meta.lastSyncedAt);
    if (cloud.state === 'error' && cloud.detail) c += ': ' + cloud.detail;
    f('cloud').textContent = c;
    var qs = backdrop.querySelectorAll('[data-q]');
    for (var qi = 0; qi < qs.length; qi++) qs[qi].classList.toggle('on', qs[qi].getAttribute('data-q') === window.__pvzQuality);
    f('device').textContent = deviceInfo();
    var errs = window.__pvzErrors || [];
    f('errors').textContent = errs.length ? errs.join('\n\n') : 'None';
    hud.classList.toggle('has-errors', errs.length > 0);
    var packDone = false;
    try { packDone = localStorage.getItem(packKey()) === '1'; } catch (e) {}
    f('pack').textContent = !swSupported ? 'Needs HTTPS' : packDone ? 'Downloaded' : 'Partial (as you play)';
  }

  // ---------- Diagnostics ----------
  var avifOk = null;
  (function () {
    var img = new Image();
    img.onload = function () { avifOk = img.width > 0; render(); };
    img.onerror = function () { avifOk = false; render(); };
    img.src = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';
  })();
  function isTouchUI() { return (navigator.maxTouchPoints || 0) > 0; }
  function deviceInfo() {
    var started = !!(window.cc && window.cc.director && window.cc.director.getScene && window.cc.director.getScene());
    return [
      navigator.userAgent,
      'Screen ' + screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x',
      'AVIF images: ' + (avifOk === null ? 'checking…' : avifOk ? 'supported' : 'NOT supported (needs iPadOS 16+)'),
      'Service worker: ' + (!swSupported ? 'unavailable' : navigator.serviceWorker.controller ? 'active ' + (swVersion || '') : 'not yet active'),
      'Graphics: ' + (window.__pvzQuality || '?') + ' · canvas ' + (function () { var c = document.getElementById('GameCanvas'); return c ? c.width + '×' + c.height : '?'; })(),
      'Home Screen app: ' + (navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'),
      'Game engine started: ' + (started ? 'yes' : 'no')
    ].join('\n');
  }
  function repair() {
    if (!confirm('Clear the offline copy and reload? Your saves are kept.')) return;
    var jobs = [];
    if (window.caches) jobs.push(caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k.indexOf('pvz-') === 0; }).map(function (k) { return caches.delete(k); }));
    }));
    if (swSupported) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
      return Promise.all(rs.map(function (r) { return r.unregister(); }));
    }));
    try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('__pvz_pack_') === 0) localStorage.removeItem(k); }); } catch (e) {}
    Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }
  // When a startup file fails to load, check each one and report its HTTP status.
  var IMPORT_FAIL = /module script failed|dynamically imported module|loading dynamically imported/i;
  var probed = false;
  function probeStartupFiles() {
    if (probed) return;
    var errs = window.__pvzErrors || [];
    if (!errs.some(function (e) { return IMPORT_FAIL.test(e); })) return;
    probed = true;
    var push = function (m) { errs.push(m); render(); };
    push('Base URL: ' + document.baseURI);
    ['game-audio.js', 'resource-codec-avif-support.js', 'index.js', 'src/system.bundle.js', 'src/import-map.json', 'audio/manifest.json']
      .forEach(function (f) {
        var u = new URL(f, document.baseURI).href;
        fetch(u, { cache: 'no-store' })
          .then(function (r) { push(f + ': HTTP ' + r.status + ' ' + (r.headers.get('content-type') || '')); })
          .catch(function (e) { push(f + ': ' + e.message); });
      });
  }
  window.addEventListener('pvz:error', function () { render(); probeStartupFiles(); });

  // ---------- Download all for offline ----------
  var downloading = false;
  function downloadAll(btn) {
    if (downloading) return;
    if (!swSupported) { toast('Offline mode needs the site served over HTTPS.'); return; }
    if (!navigator.onLine) { toast('Connect to the internet to download the offline pack.'); return; }
    if (!navigator.serviceWorker.controller || !swVersion) {
      toast('Reload the page once, then try again.', 'Reload', function () { location.reload(); });
      return;
    }
    downloading = true;
    btn.disabled = true;
    var fill = progress.querySelector('.fill');
    var text = progress.querySelector('.text');
    progress.classList.add('show');
    text.textContent = 'Reading file list…';

    fetch('asset-list.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('asset-list.json not found (run gen-asset-list.js)');
      return r.json();
    }).then(function (list) {
      var files = Array.isArray(list) ? list : list.files;
      var total = files.length, done = 0, failed = 0, i = 0;
      var cacheName = 'pvz-assets-' + swVersion;
      return caches.open(cacheName).then(function (cache) {
        function update() {
          fill.style.width = (total ? (done / total) * 100 : 100).toFixed(1) + '%';
          text.textContent = done + ' / ' + total + ' files' + (failed ? ' · ' + failed + ' failed' : '');
        }
        function worker() {
          if (i >= total) return Promise.resolve();
          var url = new URL(files[i++], document.baseURI).href;
          return caches.match(url).then(function (hit) {
            if (hit) return;
            return fetch(url, { cache: 'no-cache' }).then(function (res) {
              if (!res.ok) throw new Error(res.status);
              return cache.put(url, res);
            });
          }).catch(function (e) {
            failed++;
            if (e && e.name === 'QuotaExceededError') throw e;
          }).then(function () { done++; update(); return worker(); });
        }
        update();
        var workers = [];
        for (var w = 0; w < 6; w++) workers.push(worker());
        return Promise.all(workers).then(function () {
          if (!failed) {
            try { localStorage.setItem(packKey(), '1'); } catch (e) {}
            text.textContent = 'Done – the game now works fully offline.';
          } else {
            text.textContent = failed + ' file(s) failed. Tap again to retry the missing ones.';
          }
        });
      });
    }).catch(function (e) {
      text.textContent = (e && e.name === 'QuotaExceededError')
        ? 'Not enough storage on this device. Add the game to your Home Screen and try again.'
        : 'Download failed: ' + (e && e.message ? e.message : e);
    }).then(function () {
      downloading = false;
      btn.disabled = false;
      render();
    });
  }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg, actionLabel, action, opts) {
    if (!toastEl) { console.info('[PVZ]', msg); return; }
    opts = opts || {};
    toastEl.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = msg;
    toastEl.appendChild(span);
    if (actionLabel) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', function () { hideToast(); action && action(); });
      toastEl.appendChild(b);
    }
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'close';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '✕';
    x.addEventListener('click', hideToast);
    toastEl.appendChild(x);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(hideToast, actionLabel ? 12000 : 5000);
  }
  function hideToast() { if (toastEl) toastEl.classList.remove('show'); }

  window.PVZUI = { toast: toast, hideToast: hideToast, render: render };

  // ---------- Events ----------
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  window.addEventListener('pvz:localsave', function () { if (backdrop && backdrop.classList.contains('open')) render(); });
  window.addEventListener('pvz:cloudstatus', function (e) { cloud = e.detail; render(); });

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
