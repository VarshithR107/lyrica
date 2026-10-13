// ═══════════════════════════════════════════════════════════════════
// YouTube IFrame Player wrapper — plays full songs by search query.
// Replaces the 30-second iTunes preview so LRCLIB lyric timestamps
// (which reference the full song) line up with real playback time.
// ═══════════════════════════════════════════════════════════════════

export const STATE = {
  UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5,
};

let player = null;
let ready = false;
let timeTimer = null;
const listeners = { ready: [], state: [], time: [], error: [] };

function emit(name, ...args) {
  for (const fn of listeners[name] || []) {
    try { fn(...args); } catch (e) { console.warn("yt listener error:", e); }
  }
}

export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
}

// Load the IFrame API exactly once. Resolves true when ready, or false if the
// script is blocked (ad blocker / privacy extension / network) or never loads.
let apiPromise = null;
function loadApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(true);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      finish(true);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => finish(false);          // blocked outright
    document.head.appendChild(tag);
    // If neither onerror nor ready fires, it's almost certainly being blocked.
    setTimeout(() => finish(false), 9000);
  });
  return apiPromise;
}

export async function init(elementId) {
  const ok = await loadApi();
  if (!ok || !(window.YT && window.YT.Player)) {
    emit("error", "yt-blocked");
    return null;
  }
  return new Promise((resolve) => {
    player = new YT.Player(elementId, {
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 1,
        controls: 0,        // we render our own controls
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1,
        fs: 0,
      },
      events: {
        onReady: () => {
          ready = true;
          startTimeTimer();
          emit("ready");
          resolve(player);
        },
        onStateChange: (e) => emit("state", e.data),
        onError: (e) => {
          // A video that won't embed/play (101/150), was removed (100), or is
          // invalid (2/5) shouldn't kill the song — try the next candidate for
          // the same track first. Only when all are exhausted do we report up.
          if (candidateIds.length && candPos < candidateIds.length - 1) {
            candPos++;
            try { player.loadVideoById(candidateIds[candPos]); } catch {}
            return;
          }
          emit("error", e.data);
        },
      },
    });
  });
}

function startTimeTimer() {
  if (timeTimer) return;
  timeTimer = setInterval(() => {
    if (!ready || !player || !player.getCurrentTime) return;
    try {
      const cur = player.getCurrentTime() || 0;
      const dur = player.getDuration() || 0;
      emit("time", cur, dur);
    } catch {}
  }, 100);   // 100ms → tighter lyric highlight + smoother karaoke fill
}

// ─── Search → videoId via local Node proxy ───────────────────────
// The browser can't talk to youtube.com/results (no CORS) and public
// Piped/Invidious mirrors are mostly dead. server.js (same origin)
// fetches the YouTube search page server-side and returns a videoId.
const idCache = new Map();

// Candidate uploads for the song currently being loaded, best-first. If one
// errors, onError walks to the next before giving up on the track.
let candidateIds = [];
let candPos = 0;

async function resolveCandidates(query, dur = 0) {
  const cacheKey = `${query}|${dur || 0}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  const durParam = dur ? `&dur=${Math.round(dur)}` : "";
  const r = await fetch(`/api/yt-search?q=${encodeURIComponent(query)}${durParam}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `http-${r.status}`);
  }
  const data = await r.json();
  const ids = Array.isArray(data?.candidates) && data.candidates.length
    ? data.candidates
    : (data?.videoId ? [data.videoId] : []);
  if (ids.length) idCache.set(cacheKey, ids);
  return ids;
}

// Load by free-text query: resolve ranked candidates, play the first, and let
// onError fall through to the rest. `dur` (seconds) biases selection toward the
// matching-length upload so synced lyrics line up with playback.
export async function searchAndPlay(query, dur = 0) {
  if (!ready || !player) return;
  try {
    const ids = await resolveCandidates(query, dur);
    if (!ids.length) { emit("error", "no-results"); return; }
    candidateIds = ids;
    candPos = 0;
    player.loadVideoById(ids[0]);
  } catch (e) {
    emit("error", e?.message || "search-failed");
  }
}

export function loadById(videoId) {
  if (!ready || !player || !videoId) return;
  player.loadVideoById(videoId);
}

export function play() { if (ready) player.playVideo(); }
export function pause() { if (ready) player.pauseVideo(); }
export function stop() { if (ready) player.stopVideo(); }
export function seekTo(sec) { if (ready) player.seekTo(Math.max(0, sec), true); }
export function getCurrentTime() { return ready ? (player.getCurrentTime() || 0) : 0; }
export function getDuration() { return ready ? (player.getDuration() || 0) : 0; }
export function getState() { return ready ? player.getPlayerState() : STATE.UNSTARTED; }
export function isPaused() {
  if (!ready) return true;
  const s = player.getPlayerState();
  return s !== STATE.PLAYING && s !== STATE.BUFFERING;
}

// Volume 0..1
export function setVolume(v01) {
  if (!ready) return;
  player.setVolume(Math.round(Math.max(0, Math.min(1, v01)) * 100));
}
export function mute() { if (ready) player.mute(); }
export function unMute() { if (ready) player.unMute(); }
export function isReady() { return ready; }
