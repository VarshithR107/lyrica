// ═══════════════════════════════════════════════════════════════════
// LYRICS — fetched via the local proxy (LRCLIB → Musixmatch waterfall).
// Returns { lines, synced, source }. Persisted to localStorage so repeat
// plays are instant.
// ═══════════════════════════════════════════════════════════════════

const SEARCH = "https://lrclib.net/api/search";
const LS_KEY = "lyrica_lyrics_cache_v2";   // v2: stores {lines, synced, source}

// ─── Persistent cache ────────────────────────────────────────────
let diskCache;
try { diskCache = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { diskCache = {}; }
const memCache = new Map();

function saveDisk() {
  // Cap to last 200 entries to avoid bloating localStorage
  const keys = Object.keys(diskCache);
  if (keys.length > 200) {
    const trim = keys.slice(0, keys.length - 200);
    trim.forEach(k => delete diskCache[k]);
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(diskCache)); } catch {}
}

// ─── LRC parser ──────────────────────────────────────────────────
function parseLRC(text) {
  const out = [];
  const lineRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/;
  for (const raw of text.split("\n")) {
    const m = raw.match(lineRe);
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const ms = Number((m[3] || "0").padEnd(3, "0"));
    const t = min * 60 + sec + ms / 1000;
    const txt = (m[4] || "").trim();
    if (txt) out.push([t, txt]);
  }
  return out;
}

// Returns { lines: [[time,text]...], synced: bool, source: string } | null.
// For unsynced (plain) lyrics, timestamps are placeholders and the UI shows
// the words without time-highlighting.
function parseData(data) {
  if (!data) return null;
  if (data.syncedLyrics) {
    const lines = parseLRC(data.syncedLyrics);
    if (lines.length) return { lines, synced: true, source: data.source || "LRCLIB" };
  }
  if (data.plainLyrics) {
    const lines = data.plainLyrics.split("\n").filter(l => l.trim()).map((t, i) => [i * 3, t.trim()]);
    if (lines.length) return { lines, synced: false, source: data.source || "Lyrics" };
  }
  return null;
}

function trackFields(track) {
  return {
    artist: track.artists?.[0]?.name || "",
    title: track.name || "",
    album: track.album?.name || "",
    dur: Math.round((track.duration_ms || 0) / 1000),
  };
}

// Primary path: the local server proxies LRCLIB (handles matching, retries,
// caching, and a proper User-Agent). This is far more reliable than hitting
// lrclib.net from the browser, which can be blocked by ad-blockers/networks.
async function fromProxy(track) {
  const { artist, title, album, dur } = trackFields(track);
  const qs = `artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&album=${encodeURIComponent(album)}&duration=${dur}`;
  const r = await fetch(`/api/lyrics?${qs}`);
  if (!r.ok) throw new Error(`proxy ${r.status}`);
  return parseData(await r.json());
}

// Fallback: talk to LRCLIB directly (used only if the proxy is unreachable).
async function fromLrclibDirect(track) {
  const { artist, title } = trackFields(track);
  const r = await fetch(`${SEARCH}?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`);
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return parseData(arr.find(x => x.syncedLyrics) || arr[0]);
}

// ─── Public API ──────────────────────────────────────────────────
// Returns { lines, synced, source } or null.
export async function fetchLyrics(track, force = false) {
  if (!track) return null;
  const key = track.id;

  if (!force) {
    if (memCache.has(key)) return memCache.get(key);
    if (diskCache[key]) {
      memCache.set(key, diskCache[key]);
      return diskCache[key];
    }
  } else {
    // Retry: drop any cached miss so we actually hit the network again.
    memCache.delete(key);
  }

  let result = null;
  try {
    result = await fromProxy(track);
  } catch {
    // Proxy unreachable (e.g. opened as a bare file) — try LRCLIB directly.
    try { result = await fromLrclibDirect(track); } catch {}
  }

  memCache.set(key, result);
  if (result && result.lines && result.lines.length) {
    diskCache[key] = result;
    saveDisk();
  }
  return result;
}

// Pre-warm cache for a list of tracks (e.g., visible search results)
export function prefetchLyrics(tracks) {
  tracks.slice(0, 10).forEach(t => {
    if (!memCache.has(t.id) && !diskCache[t.id]) {
      fetchLyrics(t).catch(() => {});
    }
  });
}
