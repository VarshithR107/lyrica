// ═══════════════════════════════════════════════════════════════════
// Lyrica local server
//   - serves the static SPA (index.html + js/css)
//   - proxies YouTube searches:  /api/yt-search?q=<query>
//
// Why the proxy: the browser can't talk to youtube.com/results directly
// (no CORS). Node has no CORS rules, so we fetch server-side and just
// return the first videoId from the resulting page.
// ═══════════════════════════════════════════════════════════════════

const http = require("node:http");
const fs   = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// In-process cache so a song clicked twice doesn't re-scrape.
const idCache = new Map();

// ─── Lyrics (LRCLIB) ───────────────────────────────────────────────
// Proxied server-side so the browser never has to reach lrclib.net
// directly (dodges ad-blockers, flaky networks, and per-tab rate limits),
// and so we can send a proper User-Agent + cache and retry intelligently.
const lyricsCache = new Map();
const LRCLIB_UA = "Lyrica/1.0 (local music player; https://lrclib.net)";

async function lrclib(pathAndQuery) {
  // One retry: LRCLIB occasionally rate-limits (429) or times out under bursts,
  // and a transient miss shouldn't read as "this song has no lyrics".
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://lrclib.net/api/${pathAndQuery}`, {
        headers: { "User-Agent": LRCLIB_UA, "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return null;        // genuine "not found" — don't retry
      if (!res.ok) { if (attempt === 0) { await new Promise(r => setTimeout(r, 400)); continue; } return null; }
      return await res.json();
    } catch {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 400)); continue; }
      return null;
    }
  }
  return null;
}

// ─── Musixmatch (fallback source) ──────────────────────────────────
// Uses the public desktop-app token. It's best-effort: the token is rate
// limited, so when it 401s we just skip and fall back. Because Musixmatch
// is only queried for songs LRCLIB misses — and every result is cached
// permanently — coverage keeps climbing over time without hammering it.
const MXM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) musixmatch-desktop",
  "Cookie": "x-mxm-token-guid=00000000-0000-0000-0000-000000000000",
};
let mxmToken = null;
let mxmTokenAt = 0;
let mxmBlockedUntil = 0;   // when throttled (401), skip MXM entirely until this time

async function getMxmToken() {
  if (mxmToken && Date.now() - mxmTokenAt < 9 * 60 * 1000) return mxmToken;
  try {
    const r = await fetch(
      "https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0&format=json",
      { headers: MXM_HEADERS, signal: AbortSignal.timeout(4000) }
    );
    const d = await r.json();
    const t = d?.message?.body?.user_token;
    if (t && t.length > 20 && d?.message?.header?.status_code === 200) {
      mxmToken = t; mxmTokenAt = Date.now();
      return t;
    }
  } catch { /* network/timeout */ }
  mxmToken = null;
  mxmBlockedUntil = Date.now() + 10 * 60 * 1000;   // back off for 10 min
  return null;
}

// Strip Musixmatch's "not for commercial use" disclaimer from plain lyrics.
function stripMxmDisclaimer(s) {
  return String(s || "")
    .split("\n")
    .filter(l => !/not for commercial use|^\s*\(\d{6,}\)\s*$|^\*{3,}/i.test(l))
    .join("\n")
    .trim();
}

async function musixmatch(track, artist) {
  if (Date.now() < mxmBlockedUntil) return { synced: null, plain: null };   // backing off
  const tok = await getMxmToken();
  if (!tok) return { synced: null, plain: null };
  try {
    const u = `https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?format=json&namespace=lyrics_richsynched&subtitle_format=lrc&app_id=web-desktop-app-v1.0&usertoken=${tok}&q_track=${encodeURIComponent(track)}&q_artist=${encodeURIComponent(artist)}`;
    const d = await (await fetch(u, { headers: MXM_HEADERS, signal: AbortSignal.timeout(5000) })).json();
    if (d?.message?.header?.status_code === 401) {
      mxmToken = null; mxmBlockedUntil = Date.now() + 10 * 60 * 1000;
      return { synced: null, plain: null };
    }
    const m = d?.message?.body?.macro_calls || {};
    const synced = m["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body || "";
    const plain = stripMxmDisclaimer(m["track.lyrics.get"]?.message?.body?.lyrics?.lyrics_body || "");
    return {
      synced: synced.length > 5 ? synced : null,
      plain: plain.length > 5 ? plain : null,
    };
  } catch {
    return { synced: null, plain: null };
  }
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")        // drop "(From "RRR")", "(Telugu)" …
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip the noise iTunes adds to titles so LRCLIB's search can match:
// "(From "RRR")", "(feat. X)", "(Telugu)", "(Remastered 2009)", "(Mixed)", etc.
function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[\(\[][^\)\]]*\b(from|feat|ft|remaster|remix|version|live|edit|mono|stereo|deluxe|bonus|telugu|tamil|hindi|kannada|malayalam|punjabi|original|soundtrack|ost|reprise|mixed|mix|extended|radio|club|instrumental|acoustic|cover|sped\s*up|slowed|lo-?fi)\b[^\)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(single|ep|from\s+.*|.*version|.*remaster.*)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Title with ALL bracketed bits removed — a last-ditch broad query.
function bareTitle(t) {
  return String(t || "").replace(/[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\s+/g, " ").trim();
}

function hasLyrics(d) { return !!(d && (d.syncedLyrics || d.plainLyrics)); }

// Score a search result against what we asked for, so we never return a
// totally unrelated song's lyrics. Returns the best result, or null if
// nothing clears the confidence bar.
function pickBest(results, want) {
  const nt = norm(want.title);
  const ntTokens = nt.split(" ").filter(Boolean);
  let best = null, bestScore = -1;
  for (const r of results) {
    if (!hasLyrics(r)) continue;
    const n = norm(r.trackName);
    let score = 0;
    if (r.syncedLyrics) score += 50;                 // strongly prefer timed lyrics
    if (n === nt) score += 45;
    else if (n.includes(nt) || nt.includes(n)) score += 30;
    else {
      const tn = n.split(" ");
      const overlap = ntTokens.filter(x => tn.includes(x)).length;
      score += Math.round((overlap / Math.max(1, ntTokens.length)) * 25);
    }
    if (want.duration && r.duration) {
      const diff = Math.abs(r.duration - want.duration);
      if (diff <= 3) score += 15;
      else if (diff <= 10) score += 7;
      else if (diff > 35) score -= 12;               // likely a different cut/song
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 30 ? best : null;              // require a real title match
}

const clip = (d) => ({ syncedLyrics: d.syncedLyrics || null, plainLyrics: d.plainLyrics || null });

async function lrclibLookup({ artist, track, album, duration }) {
  const E = encodeURIComponent;
  const want = { title: track, duration };
  const clean = cleanTitle(track);
  const bare = bareTitle(track);

  // 1) The two exact "get" calls in parallel — fastest, most accurate.
  const [exact, nodur] = await Promise.all([
    duration
      ? lrclib(`get?artist_name=${E(artist)}&track_name=${E(track)}&album_name=${E(album)}&duration=${duration}`)
      : Promise.resolve(null),
    lrclib(`get?artist_name=${E(artist)}&track_name=${E(track)}`),
  ]);
  if (hasLyrics(exact)) return clip(exact);
  if (hasLyrics(nodur)) return clip(nodur);

  // 2) Free-text searches — ALL fired in parallel (title-first; regional
  //    artist strings are messy). Score the combined candidate pool.
  const queries = [...new Set([clean, bare, track, `${bare} ${artist}`].map(s => s.trim()).filter(Boolean))];
  const arrays = await Promise.all(queries.map(q => lrclib(`search?q=${E(q)}`)));
  const seen = new Set();
  const pool = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      const id = r.id ?? `${r.trackName}|${r.artistName}`;
      if (!seen.has(id)) { seen.add(id); pool.push(r); }
    }
  }
  const best = pickBest(pool, want);
  if (best) return clip(best);

  return { syncedLyrics: null, plainLyrics: null };
}

// Waterfall: LRCLIB first (fast, unlimited, synced), then Musixmatch for
// whatever LRCLIB can't cover. Everything is cached permanently in-process.
async function getLyrics({ artist, track, album, duration }) {
  const key = `${artist}|${track}|${album}|${duration}`;
  if (lyricsCache.has(key)) return lyricsCache.get(key);

  let synced = null, plain = null, source = null;

  const lr = await lrclibLookup({ artist, track, album, duration });
  if (lr.syncedLyrics) { synced = lr.syncedLyrics; source = "LRCLIB"; }
  if (lr.plainLyrics) plain = lr.plainLyrics;

  // No synced timing from LRCLIB → try Musixmatch (best-effort).
  if (!synced && artist) {
    const mx = await musixmatch(track, artist);
    if (mx.synced) { synced = mx.synced; source = "Musixmatch"; }
    if (!plain && mx.plain) { plain = mx.plain; if (!source) source = "Musixmatch"; }
  }

  const out = {
    syncedLyrics: synced,
    plainLyrics: plain,
    source: synced ? source : (plain ? (source || "Lyrics") : null),
    synced: !!synced,
  };
  // Only cache HITS. Caching a miss would poison the track forever after any
  // transient rate-limit/timeout — the bug that made lyrics "disappear".
  if (synced || plain) lyricsCache.set(key, out);
  return out;
}

// "M:SS" or "H:MM:SS" → seconds.
function parseLenText(s) {
  const parts = String(s).split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Parse the top search results into rich candidates. We split on each
// videoId and read that renderer's own title / channel / length, so we can
// rank by how well a video will line up with synced lyrics.
function parseYtCandidates(html, max = 12) {
  const out = [];
  const seen = new Set();
  const parts = html.split('"videoId":"');
  for (let i = 1; i < parts.length && out.length < max; i++) {
    const id = parts[i].slice(0, 11);
    if (!/^[\w-]{11}$/.test(id) || seen.has(id)) continue;
    const chunk = parts[i].slice(0, 3000);   // this renderer's window
    // The only "M:SS"/"H:MM:SS" simpleText in a renderer is its length.
    const lenM = chunk.match(/"simpleText":"(\d{1,2}:\d{2}(?::\d{2})?)"/);
    if (!lenM) continue;                       // no duration → playlist/short/channel, skip
    const titleM = chunk.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    const ownerM = chunk.match(/"(?:ownerText|longBylineText)":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    seen.add(id);
    out.push({
      id,
      dur: parseLenText(lenM[1]),
      title: (titleM?.[1] || "").toLowerCase(),
      owner: (ownerM?.[1] || "").toLowerCase(),
    });
  }
  return out;
}

// Score a candidate for lyric-sync suitability. The winners are the auto-
// generated "<Artist> - Topic" Art Tracks: they're the exact streaming master
// LRCLIB times against, so they start at the song's start (no music-video
// intro) and line up cleanly. Then we weigh duration closeness and prefer
// plain audio over videos, heavily penalising non-matching versions.
function scoreCandidate(c, wantDur) {
  let s = 0;
  if (wantDur) s += Math.max(0, 60 - Math.abs(c.dur - wantDur) * 4);
  else s += 30;
  if (/-\s*topic$/.test(c.owner)) s += 55;                          // Art Track master = ideal
  if (/\b(audio|visualizer|visualiser|lyrics?)\b/.test(c.title)) s += 16;
  if (/official\s+audio/.test(c.title)) s += 8;
  if (/\b(official\s+(music\s+)?video|m\/?v)\b/.test(c.title)) s -= 10;   // videos often have intros
  if (/\b(live|remix|cover|sped\s*up|slowed|reverb|karaoke|instrumental|acoustic|8d|nightcore|mashup|concert|performance|reaction|tutorial)\b/.test(c.title)) s -= 70;
  return s;
}

// Rank candidates best-first and return their ids. Returning a LIST (not just
// the winner) lets the client fall back to the next upload if the top one
// can't be embedded/played, instead of skipping the whole song.
function rankVideos(cands, wantDur) {
  return cands
    .map(c => ({ c, s: scoreCandidate(c, wantDur) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.c.id);
}

async function ytSearch(query, wantDur = 0) {
  const cacheKey = `${query}|${wantDur || 0}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);

  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+000",  // skip EU consent gate
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`youtube ${res.status}`);
  const html = await res.text();

  // Rank parsed candidates (Topic/audio + matching length). If parsing finds
  // nothing, fall back to the raw videoId order from the page.
  let ids = rankVideos(parseYtCandidates(html), wantDur);
  if (!ids.length) {
    ids = [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map(m => m[1]))];
  }
  ids = ids.slice(0, 6);
  idCache.set(cacheKey, ids);
  return ids;
}

// ─── Transliteration (Google Input Tools) ─────────────────────────
// Phonetic transliteration of Latin text INTO a target script — the engine
// behind "sound translation": the original lyrics keep their sound but get
// written in the user's chosen script (e.g. English → Devanagari/Telugu/…).
// Input Tools is a typing backend, so we transliterate word-by-word and cache
// every word permanently (lyrics repeat a lot → coverage climbs, calls drop).
const translitCache = new Map();
const ITOOLS_LANGS = new Set([
  "as","bn","gu","hi","kn","ml","mr","ne","or","pa","sa","si","ta","te",  // Indic
  "be","bg","ru","sr","uk",                                                // Cyrillic
  "ar","fa","ur",                                                          // Perso-Arabic
  "am","el","he","ja","th","ti","zh",                                      // other scripts
]);

async function mapLimitSrv(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}

async function inputToolsWord(word, lang) {
  const key = `${lang}|${word}`;
  if (translitCache.has(key)) return translitCache.get(key);
  let out = word;
  try {
    const url = `https://inputtools.google.com/request?itc=${encodeURIComponent(lang)}-t-i0-und` +
                `&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8&text=${encodeURIComponent(word)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    // Shape: ["SUCCESS",[["<input>",["<cand1>",...],[],{}]]]
    if (Array.isArray(d) && d[0] === "SUCCESS") {
      const cand = d[1]?.[0]?.[1]?.[0];
      if (cand) out = cand;
    }
  } catch { /* keep the Latin word on any failure */ }
  translitCache.set(key, out);
  return out;
}

// Transliterate whole lines: gather the unique Latin words across the song,
// transliterate each once, then rebuild every line preserving spacing/punctuation.
async function transliterateLines(lines, lang) {
  if (!ITOOLS_LANGS.has(lang)) return lines.slice();
  const wordRe = /[A-Za-z][A-Za-z'’]*/g;
  const uniq = new Set();
  for (const ln of lines) {
    const m = String(ln || "").match(wordRe);
    if (m) for (const w of m) uniq.add(w.toLowerCase());
  }
  const words = [...uniq];
  const map = new Map();
  await mapLimitSrv(words, 6, async (w) => { map.set(w, await inputToolsWord(w, lang)); });
  return lines.map(ln => String(ln || "").replace(wordRe, (w) => map.get(w.toLowerCase()) || w));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      // Aggressive: prevents the browser from ever serving a stale build.
      "cache-control": "no-store, must-revalidate",
      "pragma": "no-cache",
      "expires": "0",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    // Malformed request target (e.g. "//") — don't let it crash the server.
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return;
  }

  // ── API: YouTube search ────────────────────────────────────────
  if (u.pathname === "/api/yt-search") {
    const q = (u.searchParams.get("q") || "").trim();
    const dur = Number(u.searchParams.get("dur") || 0);
    if (!q) return sendJson(res, 400, { error: "missing q" });
    try {
      const ids = await ytSearch(q, dur);
      if (!ids.length) return sendJson(res, 200, { videoId: null, candidates: [], reason: "no-results" });
      return sendJson(res, 200, { videoId: ids[0], candidates: ids });
    } catch (e) {
      return sendJson(res, 502, { error: e.message || "search-failed" });
    }
  }

  // ── API: Lyrics (LRCLIB proxy) ─────────────────────────────────
  if (u.pathname === "/api/lyrics") {
    const artist = (u.searchParams.get("artist") || "").trim();
    const track = (u.searchParams.get("track") || "").trim();
    const album = (u.searchParams.get("album") || "").trim();
    const duration = Number(u.searchParams.get("duration") || 0);
    if (!artist || !track) return sendJson(res, 400, { error: "missing artist/track" });
    try {
      return sendJson(res, 200, await getLyrics({ artist, track, album, duration }));
    } catch (e) {
      return sendJson(res, 502, { error: e.message || "lyrics-failed" });
    }
  }

  // ── API: Transliteration (Latin → target script) ──────────────
  if (u.pathname === "/api/translit") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
    const body = await readJsonBody(req);
    const lines = Array.isArray(body?.lines) ? body.lines : null;
    const lang = String(body?.lang || "").trim();
    if (!lines || !lang) return sendJson(res, 400, { error: "missing lines/lang" });
    try {
      return sendJson(res, 200, { lines: await transliterateLines(lines, lang) });
    } catch {
      return sendJson(res, 200, { lines });   // graceful: echo input on failure
    }
  }

  // ── Static files ──────────────────────────────────────────────
  let rel = u.pathname === "/" ? "/index.html" : u.pathname;
  // sanitise — never serve outside project root
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  sendFile(res, full);
});

server.listen(PORT, () => {
  console.log(`Lyrica  →  http://localhost:${PORT}/`);
});
