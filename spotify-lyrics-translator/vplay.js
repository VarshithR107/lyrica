// ═══════════════════════════════════════════════════════════════════
// Virtual player — a silent stand-in clock for when a track's YouTube
// video can't be played (removed, embed-disabled, or no match found).
//
// It mirrors the control surface of youtube.js (play/pause/seek/time/state)
// but produces no audio: it just advances a timeline against the song's
// known duration so the synced lyrics still scroll through on the now-
// playing template instead of the track being skipped.
// ═══════════════════════════════════════════════════════════════════

// Same numeric values as youtube.js STATE so the shared app handlers
// (which compare against yt.STATE.*) work regardless of the source.
export const STATE = {
  UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5,
};

let dur = 0;        // total seconds
let cur = 0;        // current position (seconds)
let playing = false;
let last = 0;       // performance.now() at the previous tick
let timer = null;

const listeners = { time: [], state: [] };

function emit(name, ...args) {
  for (const fn of listeners[name] || []) {
    try { fn(...args); } catch (e) { console.warn("vplay listener error:", e); }
  }
}

export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
}

function tick() {
  if (!playing) return;
  const now = performance.now();
  cur += (now - last) / 1000;
  last = now;
  if (dur > 0 && cur >= dur) {
    cur = dur;
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
    emit("time", cur, dur);
    emit("state", STATE.ENDED);
    return;
  }
  emit("time", cur, dur);
}

// Cue a new track of the given length (seconds). Does not auto-start.
export function load(durationSec) {
  dur = Math.max(0, Number(durationSec) || 0);
  cur = 0;
}

export function play() {
  if (dur > 0 && cur >= dur) cur = 0;   // replay from the top after ENDED
  if (!playing) {
    playing = true;
    last = performance.now();
    if (!timer) timer = setInterval(tick, 200);
  }
  emit("state", STATE.PLAYING);
}

export function pause() {
  if (!playing) return;
  playing = false;
  if (timer) { clearInterval(timer); timer = null; }
  emit("state", STATE.PAUSED);
}

export function stop() {
  playing = false;
  if (timer) { clearInterval(timer); timer = null; }
  cur = 0;
}

export function seekTo(sec) {
  const max = dur > 0 ? dur : Number(sec) || 0;
  cur = Math.max(0, Math.min(max, Number(sec) || 0));
  last = performance.now();
  emit("time", cur, dur);
}

export function getCurrentTime() { return cur; }
export function getDuration() { return dur; }
export function isPaused() { return !playing; }
export function isReady() { return true; }

// No audio to control — kept for interface parity with youtube.js so the
// playback router can call these uniformly.
export function setVolume() {}
export function mute() {}
export function unMute() {}
