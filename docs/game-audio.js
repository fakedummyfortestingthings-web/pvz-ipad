// Game audio engine (same API as the 0.16.0 Electron renderer pool the game calls through
// window.audioEngine), tuned for iPad Safari:
//
// - Sound effects (audio/Sounds/...) play through Web Audio: each clip is fetched and decoded
//   once, kept in a memory-capped cache, and replayed with an AudioBufferSourceNode. The old
//   way re-loaded a media file into an <audio> element for every pea, chomp and groan, which
//   on iPad Safari is slow, stalls frames and gets worse the busier a level is.
// - Music (audio/Music/...) keeps using <audio> elements: one long track at a time, and
//   decoding whole songs into memory would use far too much RAM.
// - If Web Audio is unavailable, everything falls back to <audio> elements.

const DEFAULT_VOLUME = 0.9;
const MUSIC_POOL_SIZE = 8;          // <audio> elements for music (and fallback)
const FALLBACK_POOL_SIZE = 60;      // original pool size when Web Audio is unavailable
const MAX_SFX_VOICES = 48;          // concurrent sound effects
const SFX_CACHE_BYTES = 24 * 1048576; // decoded PCM kept in memory (least recently used evicted)
const LONG_CLIP_BYTES = 350 * 1024; // longer clips (ambience loops) stream via <audio> instead

function clamp01(v) { return Math.min(1, Math.max(0, Number(v) || 0)); }

// ---------------------------------------------------------------- <audio> element pool
class ElementPool {
    constructor(size) {
        this.pool = [];
        for (let i = 0; i < size; i++) {
            const el = new Audio();
            el.preload = 'auto';
            el.preservesPitch = false;
            this.pool.push({
                kind: 'el', el, id: null, playing: false, fading: false, speed: 1, volume: DEFAULT_VOLUME,
                restartBeforeEnd: null, restartTimer: null, fadeTimer: null,
            });
        }
    }

    play(engine, src, speed, volume, forcedId) {
        const slot = this.pool.find(s => !s.playing);
        if (!slot) return null;
        const el = slot.el;
        if (slot.restartTimer) { clearTimeout(slot.restartTimer); slot.restartTimer = null; }
        if (slot.fadeTimer) { clearInterval(slot.fadeTimer); slot.fadeTimer = null; }
        el.pause();
        el.src = src;
        el.playbackRate = speed;
        el.preservesPitch = false;
        el.volume = clamp01(volume);
        slot.id = forcedId || engine.nextId++;
        slot.playing = true;
        slot.fading = false;
        slot.speed = speed;
        slot.volume = volume;
        slot.restartBeforeEnd = null;
        engine.byId.set(slot.id, slot);
        el.onended = () => this.release(engine, slot);
        el.onerror = () => { console.warn('[audio] load error:', src); this.release(engine, slot); };
        el.play().catch(() => this.release(engine, slot));
        return slot.id;
    }

    release(engine, slot) {
        if (!slot.playing) return;
        slot.playing = false;
        slot.fading = false;
        slot.restartBeforeEnd = null;
        if (slot.restartTimer) { clearTimeout(slot.restartTimer); slot.restartTimer = null; }
        if (slot.fadeTimer) { clearInterval(slot.fadeTimer); slot.fadeTimer = null; }
        const el = slot.el;
        el.onended = null;
        el.onerror = null;
        el.pause();
        el.removeAttribute('src');
        el.load();
        if (slot.id !== null) engine.byId.delete(slot.id);
        slot.id = null;
    }

    setVolume(slot, volume) { slot.volume = clamp01(volume); slot.el.volume = slot.volume; }

    setPlaying(slot, playing) { if (playing) slot.el.play().catch(() => { }); else slot.el.pause(); }

    seek(slot, seconds) {
        const el = slot.el;
        const target = Math.max(0, seconds);
        const apply = () => { if (el.seekable.length > 0) el.currentTime = Math.min(target, el.duration || target); };
        if (el.readyState >= 1 && el.seekable.length > 0) apply();
        else el.addEventListener('loadedmetadata', apply, { once: true });
    }

    getPosition(slot) {
        const el = slot.el;
        return [el.currentTime, isFinite(el.duration) ? el.duration : null];
    }

    getDuration(slot) { return isFinite(slot.el.duration) ? slot.el.duration : null; }

    fadeOut(engine, slot, durationMs) {
        if (slot.fading) return;
        slot.fading = true;
        const startVol = slot.el.volume;
        const steps = 30;
        let i = 0;
        slot.fadeTimer = setInterval(() => {
            i++;
            slot.el.volume = Math.max(0, startVol * (1 - i / steps));
            if (i >= steps) {
                clearInterval(slot.fadeTimer);
                slot.fadeTimer = null;
                this.release(engine, slot);
            }
        }, durationMs / steps);
    }

    setRestartBeforeEnd(slot, beforeMs) {
        slot.restartBeforeEnd = beforeMs / 1000;
        const schedule = () => {
            if (!slot.playing || slot.restartBeforeEnd === null) return;
            const el = slot.el;
            if (!isFinite(el.duration)) { slot.restartTimer = setTimeout(schedule, 100); return; }
            const target = el.duration - slot.restartBeforeEnd / slot.speed;
            const remaining = (target - el.currentTime) * 1000 / slot.speed;
            if (remaining <= 0) {
                el.currentTime = 0;
                schedule();
            } else {
                slot.restartTimer = setTimeout(() => {
                    if (!slot.playing) return;
                    el.currentTime = 0;
                    schedule();
                }, remaining);
            }
        };
        schedule();
    }

    cleanupFinished(engine) {
        let count = 0;
        for (const slot of this.pool) {
            if (!slot.playing && slot.el.src) {
                slot.el.removeAttribute('src');
                slot.el.load();
                if (slot.id !== null) engine.byId.delete(slot.id);
                slot.id = null;
                count++;
            }
        }
        return count;
    }
}

// ---------------------------------------------------------------- Web Audio sound effects
class SfxEngine {
    constructor() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.cache = new Map();   // url -> { buffer, bytes, used }
        this.longClips = new Set(); // clips too long to decode into memory: played via <audio>
        this.loading = new Map(); // url -> Promise<AudioBuffer>
        this.bytes = 0;
        this.voices = new Set();
        this.clock = 0;

        // Play through the silent switch like <audio> did (Safari 17+), and stop the audio
        // clock while the game is in the background.
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.ctx.suspend().catch(() => { });
            else this.ctx.resume().catch(() => { });
        });
    }

    decode(data) {
        return new Promise((resolve, reject) => {
            const p = this.ctx.decodeAudioData(data, resolve, reject);
            if (p && typeof p.then === 'function') p.then(resolve, reject);
        });
    }

    load(url) {
        const hit = this.cache.get(url);
        if (hit) { hit.used = ++this.clock; return Promise.resolve(hit.buffer); }
        let p = this.loading.get(url);
        if (p) return p;
        p = fetch(url)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then(data => {
                if (data.byteLength > LONG_CLIP_BYTES) {
                    this.longClips.add(url);
                    const err = new Error('long clip');
                    err.longClip = true;
                    throw err;
                }
                return this.decode(data);
            })
            .then(buffer => {
                const bytes = buffer.length * buffer.numberOfChannels * 4;
                this.cache.set(url, { buffer, bytes, used: ++this.clock });
                this.bytes += bytes;
                this.evict();
                return buffer;
            })
            .finally(() => this.loading.delete(url));
        this.loading.set(url, p);
        return p;
    }

    cached(url) {
        const hit = this.cache.get(url);
        if (!hit) return null;
        hit.used = ++this.clock;
        return hit.buffer;
    }

    evict() {
        if (this.bytes <= SFX_CACHE_BYTES) return;
        const inUse = new Set();
        for (const v of this.voices) if (v.url) inUse.add(v.url);
        const entries = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
        for (const [url, entry] of entries) {
            if (this.bytes <= SFX_CACHE_BYTES * 0.8) break;
            if (inUse.has(url)) continue;
            this.cache.delete(url);
            this.bytes -= entry.bytes;
        }
    }

    play(engine, url, speed, volume) {
        if (this.voices.size >= MAX_SFX_VOICES) return null;
        if (this.ctx.state === 'suspended' && document.visibilityState === 'visible') this.ctx.resume().catch(() => { });
        const gain = this.ctx.createGain();
        gain.gain.value = clamp01(volume);
        gain.connect(this.master);
        const v = {
            kind: 'sfx', id: engine.nextId++, url, gain, speed: speed || 1, volume,
            buffer: null, src: null, startedAt: 0, offset: 0, paused: false, dead: false,
            loopEnd: null, restartBefore: null, fadeTimer: null,
        };
        this.voices.add(v);
        engine.byId.set(v.id, v);
        const buffer = this.cached(url);
        if (buffer) {
            v.buffer = buffer;
            this.start(engine, v, 0);
        } else {
            this.load(url).then(b => {
                if (v.dead) return;
                v.buffer = b;
                this.applyLoop(v);
                if (!v.paused) this.start(engine, v, v.offset);
            }).catch((err) => {
                const wasDead = v.dead;
                const id = v.id, loopBefore = v.restartBefore;
                this.release(engine, v);
                if (wasDead || !err || !err.longClip) return;
                // Too long to keep decoded: hand the same id over to an <audio> element.
                const got = engine.elements.play(engine, url, v.speed, v.volume, id);
                if (got != null && loopBefore != null) {
                    const slot = engine.getSlot(id);
                    if (slot) engine.elements.setRestartBeforeEnd(slot, loopBefore * 1000);
                }
            });
        }
        return v.id;
    }

    start(engine, v, offset) {
        const dur = v.buffer.duration;
        if (!(dur > 0)) { this.release(engine, v); return; }
        const src = this.ctx.createBufferSource();
        src.buffer = v.buffer;
        src.playbackRate.value = v.speed;
        if (v.loopEnd !== null) { src.loop = true; src.loopStart = 0; src.loopEnd = v.loopEnd; }
        src.connect(v.gain);
        src.onended = () => { if (v.src === src) this.release(engine, v); };
        const at = Math.max(0, Math.min(offset, dur - 0.001));
        src.start(0, at);
        v.src = src;
        v.offset = at;
        v.startedAt = this.ctx.currentTime;
    }

    stopSource(v) {
        const src = v.src;
        v.src = null;
        if (!src) return;
        src.onended = null;
        try { src.stop(); } catch (e) { }
        try { src.disconnect(); } catch (e) { }
    }

    position(v) {
        if (!v.buffer) return v.offset;
        let pos = v.offset;
        if (v.src) pos += (this.ctx.currentTime - v.startedAt) * v.speed;
        if (v.loopEnd !== null && pos > v.loopEnd) pos = pos % v.loopEnd;
        return Math.min(pos, v.buffer.duration);
    }

    release(engine, v) {
        if (v.dead) return;
        v.dead = true;
        if (v.fadeTimer) { clearTimeout(v.fadeTimer); v.fadeTimer = null; }
        this.stopSource(v);
        try { v.gain.disconnect(); } catch (e) { }
        this.voices.delete(v);
        engine.byId.delete(v.id);
    }

    setVolume(v, volume) {
        v.volume = clamp01(volume);
        const g = v.gain.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        g.value = v.volume;
    }

    setPlaying(engine, v, playing) {
        if (playing) {
            if (!v.paused) return;
            v.paused = false;
            if (v.buffer) this.start(engine, v, v.offset);
        } else {
            if (v.paused) return;
            v.offset = this.position(v);
            v.paused = true;
            this.stopSource(v);
        }
    }

    seek(engine, v, seconds) {
        v.offset = Math.max(0, seconds);
        if (v.buffer && !v.paused) { this.stopSource(v); this.start(engine, v, v.offset); }
    }

    fadeOut(engine, v, durationMs) {
        if (v.fadeTimer) return;
        const g = v.gain.gain;
        const now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + Math.max(0.01, durationMs / 1000));
        v.fadeTimer = setTimeout(() => { v.fadeTimer = null; this.release(engine, v); }, durationMs);
    }

    applyLoop(v) {
        if (v.restartBefore === null || !v.buffer) return;
        const end = v.buffer.duration - v.restartBefore / v.speed;
        v.loopEnd = end > 0.01 ? end : v.buffer.duration;
        if (v.src) { v.src.loop = true; v.src.loopStart = 0; v.src.loopEnd = v.loopEnd; }
    }

    setRestartBeforeEnd(v, beforeMs) {
        v.restartBefore = beforeMs / 1000;
        this.applyLoop(v);
    }
}

// ---------------------------------------------------------------- public engine
export class AudioEngine {
    constructor(manifest, audioRoot) {
        this.audioRoot = audioRoot;
        this.manifest = manifest;
        this.nextId = 1;
        this.byId = new Map();
        this.sfx = null;
        this.elements = null;
    }

    async init() {
        try {
            if (window.AudioContext || window.webkitAudioContext) this.sfx = new SfxEngine();
        } catch (e) {
            console.warn('[audio] Web Audio unavailable, using <audio> elements:', e);
            this.sfx = null;
        }
        this.elements = new ElementPool(this.sfx ? MUSIC_POOL_SIZE : FALLBACK_POOL_SIZE);
    }

    nameToPath(name) {
        return this.manifest[name] ?? null;
    }

    play(name, speed = 1, volume = DEFAULT_VOLUME) {
        const relPath = this.nameToPath(name);
        if (!relPath) {
            console.warn('[audio] unknown clip:', name);
            return null;
        }
        const src = new URL(relPath.split('/').map(encodeURIComponent).join('/'), this.audioRoot).href;
        if (this.sfx && !relPath.startsWith('Music/') && !this.sfx.longClips.has(src)) return this.sfx.play(this, src, speed, volume);
        return this.elements.play(this, src, speed, volume);
    }

    getSlot(id) {
        return this.byId.get(id) || null;
    }

    setVolume(id, volume) {
        const s = this.getSlot(id);
        if (!s) return;
        if (s.kind === 'sfx') this.sfx.setVolume(s, volume); else this.elements.setVolume(s, volume);
    }

    setPlaying(id, playing) {
        const s = this.getSlot(id);
        if (!s) return;
        if (s.kind === 'sfx') this.sfx.setPlaying(this, s, playing); else this.elements.setPlaying(s, playing);
    }

    seek(id, seconds) {
        const s = this.getSlot(id);
        if (!s) return;
        if (s.kind === 'sfx') this.sfx.seek(this, s, seconds); else this.elements.seek(s, seconds);
    }

    getPosition(id) {
        const s = this.getSlot(id);
        if (!s) return [0, null];
        if (s.kind === 'sfx') return [this.sfx.position(s), s.buffer ? s.buffer.duration : null];
        return this.elements.getPosition(s);
    }

    getDuration(id) {
        const s = this.getSlot(id);
        if (!s) return null;
        if (s.kind === 'sfx') return s.buffer ? s.buffer.duration : null;
        return this.elements.getDuration(s);
    }

    fadeOut(id, durationMs) {
        const s = this.getSlot(id);
        if (!s) return;
        if (s.kind === 'sfx') this.sfx.fadeOut(this, s, durationMs); else this.elements.fadeOut(this, s, durationMs);
    }

    setRestartBeforeEnd(id, beforeMs) {
        const s = this.getSlot(id);
        if (!s) return;
        if (s.kind === 'sfx') this.sfx.setRestartBeforeEnd(s, beforeMs); else this.elements.setRestartBeforeEnd(s, beforeMs);
    }

    destroy(id) {
        const s = this.getSlot(id);
        if (!s) return;
        if (s.kind === 'sfx') this.sfx.release(this, s); else this.elements.release(this, s);
    }

    cleanupFinished() {
        return this.elements ? this.elements.cleanupFinished(this) : 0;
    }

    listClips() {
        return Object.keys(this.manifest);
    }
}

export async function initializeGameAudio() {
    const audioRoot = new URL('audio/', document.baseURI);
    const response = await fetch(new URL('manifest.json', audioRoot));
    if (!response.ok) throw new Error(`Audio manifest HTTP ${response.status}`);
    const engine = new AudioEngine(await response.json(), audioRoot);
    await engine.init();
    window.audioEngine = engine;
}
