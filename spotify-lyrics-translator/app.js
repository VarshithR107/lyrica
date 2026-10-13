// ═══════════════════════════════════════════════════════════════════
// LYRICA — iTunes Search for metadata + YouTube IFrame for full-song
// playback + LRCLIB for synced lyrics + Google MT for translation/romanization.
// ═══════════════════════════════════════════════════════════════════

import * as itunes from "./itunes.js";
import * as yt from "./youtube.js";
import * as vplay from "./vplay.js";
import { fetchLyrics, prefetchLyrics } from "./lyrics.js";
import { translateText, soundTranslate } from "./translate.js";
import { LANGUAGES, GENRES, MUSIC_LANGS } from "./songs.js";

// Per-track lyric sync offset (seconds). Persisted across sessions.
let offsetStore = {};
try { offsetStore = JSON.parse(localStorage.getItem("lyrica_offsets_v1") || "{}"); } catch {}

// ─── State ───────────────────────────────────────────────────────
const state = {
  view: "home",
  viewHistory: [],
  queue: [],
  currentIndex: -1,
  paused: true,
  shuffle: false,
  repeat: 0,
  volume: 0.8,
  muted: false,
  liked: new Map(JSON.parse(localStorage.getItem("lyrica_liked_v2") || "[]")),
  playlists: loadPlaylists(),       // [{ id, name, tracks: [...] }]
  recent: loadRecent(),             // recently-played tracks, newest first
  currentPlaylistId: null,          // playlist currently open in the playlist view
  lyrics: null,
  lyricsSynced: true,     // false when only plain (untimed) lyrics are available
  lyricsSource: null,     // "LRCLIB" | "Musixmatch" | …
  activeLyricIdx: -1,
  translationCache: {},   // key `${trackId}_${lang}` → translated lines[]
  romanCache: {},         // key `${trackId}_${lang}` → romanized lines[]
  lang: "none",
  dualLang: true,
  translitMode: "translate",
  draggingProgress: false,
  lyricOffset: 0,   // seconds: user fine-tune correction added to song time
  duration: 0,     // current track duration (from YT, in seconds)
  currentTime: 0,  // current playback time (from YT, in seconds)
  virtual: false,  // true when this track's video can't play and we're running
                   // the silent lyrics-only clock instead of YouTube
  shuffleOrder: null,  // smart-shuffled play order (array of queue indices)
  shufflePos: 0,       // our position within shuffleOrder
  searches: loadSearches(),   // recent search terms, newest first
  karaoke: false,      // karaoke (sing-along scoring) mode on/off
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ─── Playback router ─────────────────────────────────────────────
// Every playback control goes through `pb`, which delegates to whichever
// player is currently driving the track: YouTube normally, or the virtual
// (lyrics-only) clock when the video is unavailable. Volume/mute are applied
// to BOTH so the setting stays consistent across a mid-song switch.
function activePlayer() { return state.virtual ? vplay : yt; }
const pb = {
  play:           () => activePlayer().play(),
  pause:          () => activePlayer().pause(),
  seekTo:         (s) => activePlayer().seekTo(s),
  getCurrentTime: () => activePlayer().getCurrentTime(),
  getDuration:    () => activePlayer().getDuration(),
  isPaused:       () => activePlayer().isPaused(),
  setVolume:      (v) => { yt.setVolume(v); vplay.setVolume(v); },
  mute:           () => { yt.mute(); vplay.mute(); },
  unMute:         () => { yt.unMute(); vplay.unMute(); },
};

// ─── Boot ────────────────────────────────────────────────────────
async function boot() {
  applySettings();
  buildLanguageSelector();
  applyContentDefaults();
  buildVisualizerBars();
  bindEvents();
  initVoice();
  initKaraoke();
  initProfileMenu();
  initSettings();
  initMediaSession();
  greet();
  updateSidebarCount();
  renderSidebarPlaylists();
  await renderHome();
  await initYouTube();
  setVolume(state.volume);
}

async function initYouTube() {
  yt.on("ready", () => {
    if (!state.virtual) $("#npArtContainer")?.classList.add("has-player");
  });
  // Both players report through the same handlers; we ignore whichever one
  // isn't currently driving the track (the dead YT iframe keeps emitting
  // time(0,0) even after we've switched to the virtual clock).
  yt.on("time", (cur, dur) => onPlayerTime("yt", cur, dur));
  yt.on("state", (s) => onPlayerState("yt", s));
  yt.on("error", onPlayerError);
  vplay.on("time", (cur, dur) => onPlayerTime("vplay", cur, dur));
  vplay.on("state", (s) => onPlayerState("vplay", s));
  await yt.init("ytPlayer");
}

function isActiveSource(src) {
  return state.virtual ? src === "vplay" : src === "yt";
}

function onPlayerTime(src, cur, dur) {
  if (!isActiveSource(src)) return;
  if (state.draggingProgress) {
    state.currentTime = cur;
    state.duration = dur;
    syncLyrics();
    return;
  }
  state.currentTime = cur;
  state.duration = dur;
  if (dur > 0) {
    const p = (cur / dur) * 100;
    $("#progressFill").style.width = `${p}%`;
    $("#progressThumb").style.left = `${p}%`;
  }
  $("#timeCurrent").textContent = fmt(cur);
  $("#timeTotal").textContent = fmt(dur);
  maybeSyncHint(dur);
  syncLyrics();
}

function onPlayerState(src, s) {
  if (!isActiveSource(src)) return;
  if (s === yt.STATE.PLAYING) { state.paused = false; updatePlayButton(); }
  else if (s === yt.STATE.PAUSED) { state.paused = true; updatePlayButton(); }
  else if (s === yt.STATE.ENDED) {
    if (sleepAtEndOfTrack) {
      sleepAtEndOfTrack = false;
      updateSleepUI();
      state.paused = true; updatePlayButton();
      toast("Sleep timer — playback stopped 😴");
      return;
    }
    if (state.repeat === 2) { pb.seekTo(0); pb.play(); }
    else if (state.repeat === 1 || hasMoreToPlay()) nextTrack();
    else if (settings.autoplay) autoplayMore();
    else { state.paused = true; updatePlayButton(); }
  }
}

function onPlayerError(code) {
  console.warn("YouTube error:", code);
  // The player script itself couldn't load — almost always an ad blocker /
  // privacy extension / network blocking youtube.com. Tell the user clearly
  // instead of failing silently, and don't skip tracks (every one would fail).
  if (code === "yt-blocked") {
    const ph = $("#npArtPlaceholder");
    if (ph) ph.innerHTML = '<span style="padding:0 18px;text-align:center;line-height:1.55">⚠️ The YouTube player is blocked.<br>Turn off your ad blocker / shields for this site (allow <b>youtube.com</b> &amp; <b>googlevideo.com</b>), then reload. Or open the app in a normal (non-blocked) window.</span>';
    $("#npArtContainer")?.classList.remove("has-player");
    toast("YouTube player blocked — disable your ad blocker for this site, then reload", 7000);
    return;
  }
  // A single track's video can't play (removed / embed-disabled / no match).
  // Don't skip it — fall back to a silent lyrics-only playback so the synced
  // lyrics still scroll through the song on its now-playing template.
  enterVirtualMode(code === "no-results");
}

// ─── Lyrics-only (virtual) playback ──────────────────────────────
// Keep the current track on screen and run a silent clock against its known
// duration so synced lyrics still play through, instead of skipping.
function enterVirtualMode(noMatch) {
  const t = current();
  if (!t) return;
  state.virtual = true;
  try { yt.stop(); } catch {}

  // Duration: the track's real length is best; else the last lyric timestamp;
  // else a 3-minute default so the template still has a sensible timeline.
  let dur = Math.round((t.duration_ms || 0) / 1000);
  if (!dur && Array.isArray(state.lyrics) && state.lyrics.length) {
    dur = Math.ceil(state.lyrics[state.lyrics.length - 1][0]) + 5;
  }
  if (!dur) dur = 180;

  showVirtualArt(t);
  vplay.load(dur);
  vplay.setVolume(state.muted ? 0 : state.volume);
  vplay.play();
  state.duration = dur;
  $("#timeTotal").textContent = fmt(dur);
  toast(noMatch ? "No video found — playing lyrics view" : "Video unavailable — playing lyrics view", 3500);
}

function exitVirtualMode() {
  if (!state.virtual) return;
  state.virtual = false;
  try { vplay.stop(); } catch {}
  const ph = $("#npArtPlaceholder");
  if (ph) ph.innerHTML = "<span>Loading player…</span>";
  if (yt.isReady()) $("#npArtContainer")?.classList.add("has-player");
}

// Show the album art (with a small label) in place of the dead video frame.
function showVirtualArt(t) {
  const cover = t.album?.images?.[0]?.url || "";
  const ph = $("#npArtPlaceholder");
  if (ph) {
    ph.innerHTML =
      (cover ? `<img class="np-art-fallback" src="${cover}" alt="">` : "") +
      `<span class="np-art-tag">♪ Lyrics view · video unavailable</span>`;
  }
  $("#npArtContainer")?.classList.remove("has-player");   // reveal the placeholder over the iframe
}

function greet() {
  const hr = new Date().getHours();
  $("#pageTitle").textContent = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
}

// ─── Home ────────────────────────────────────────────────────────
async function renderHome() {
  renderRecent();
  const qp = $("#quickPicks");
  const grid = $("#featuredGrid");
  qp.innerHTML = skeletonCards(8, "qp-card");
  grid.innerHTML = skeletonCards(10, "song-card");

  const codes = musicLangCodes();
  const mls = musicLangs();
  const [songLists, albumLists] = await Promise.all([
    Promise.all(mls.map(ml => itunes.topSongs(ml.country, 25, ml.term))),
    Promise.all(mls.map(ml => itunes.topAlbums(ml.country, 12, ml.albumTerm))),
  ]);
  // Blend the per-language charts round-robin so every chosen language is
  // represented near the top, deduping any track that appears in more than one.
  const top = blendLists(songLists, 25);
  const releases = blendLists(albumLists, 12);

  // Reflect the chosen music language(s) in the Featured heading.
  const ft = $("#featuredTitle");
  if (ft) {
    if (codes.length === 1) ft.textContent = codes[0] === "en" ? "Featured For You" : `Popular in ${mls[0].name}`;
    else ft.textContent = `Popular in ${joinNames(mls.map(m => m.name))}`;
  }

  // Quick picks: top 8 songs
  qp.innerHTML = "";
  top.slice(0, 8).forEach(t => {
    const c = document.createElement("div");
    c.className = "qp-card";
    c.innerHTML = `
      <img src="${t.album.images[0]?.url || ''}" alt="" loading="lazy">
      <span class="qp-card-title">${escapeHtml(t.name)}</span>
      <button class="qp-play"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21"/></svg></button>`;
    c.addEventListener("click", () => playFromList(top, top.indexOf(t)));
    qp.appendChild(c);
  });

  // Featured: rest of top songs as cards
  grid.innerHTML = "";
  top.slice(0, 18).forEach((t, i) => grid.appendChild(trackCard(t, top, i)));

  // Albums row
  const albumsRow = $("#albumsGrid");
  if (albumsRow) {
    albumsRow.innerHTML = "";
    releases.forEach(a => albumsRow.appendChild(albumCard(a)));
  }

  // Genres
  const gg = $("#genreGrid");
  gg.innerHTML = "";
  GENRES.forEach(g => {
    const c = document.createElement("div");
    c.className = "genre-card";
    c.style.background = `linear-gradient(135deg, ${g.color}, ${g.color}88)`;
    c.innerHTML = `<span class="genre-icon">${g.icon}</span>${g.name}`;
    c.addEventListener("click", () => {
      navigate("search");
      $("#globalSearch").value = g.name;
      runSmartSearch(g.name);
    });
    gg.appendChild(c);
  });
}

function skeletonCards(n, cls) {
  return Array.from({ length: n }, () => `<div class="${cls} skeleton"></div>`).join("");
}

// Round-robin merge of several ranked lists into one, deduped by id and capped.
function blendLists(lists, cap) {
  const out = [], seen = new Set();
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < max && out.length < cap; i++) {
    for (const l of lists) {
      const t = l[i];
      if (t?.id && !seen.has(t.id)) { seen.add(t.id); out.push(t); if (out.length >= cap) break; }
    }
  }
  return out;
}
// "Hindi", "Hindi & Telugu", "Hindi, Telugu & English"
function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  return names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
}

// ─── Cards ───────────────────────────────────────────────────────
function trackCard(t, list, idx) {
  const card = document.createElement("div");
  card.className = "song-card";
  const liked = state.liked.has(t.id);
  card.innerHTML = `
    <div class="sc-art-wrap">
      <img class="sc-art" src="${t.album.images[0]?.url || ''}" alt="" loading="lazy">
      <button class="sc-menu-btn" title="Add to playlist">
        <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </button>
      <button class="sc-play-btn"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21"/></svg></button>
    </div>
    <div class="sc-title">${escapeHtml(t.name)}</div>
    <div class="sc-bottom">
      <span class="sc-artist">${escapeHtml(t.artists.map(a => a.name).join(", "))}</span>
      <button class="heart-btn ${liked ? 'liked' : ''}" data-id="${t.id}">
        <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
    </div>`;
  card.addEventListener("click", (e) => {
    if (e.target.closest(".heart-btn") || e.target.closest(".sc-menu-btn")) return;
    playFromList(list, idx);
  });
  card.querySelector(".heart-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLike(t);
  });
  card.querySelector(".sc-menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openCtxMenu(t, e.currentTarget);
  });
  return card;
}

function albumCard(a) {
  const card = document.createElement("div");
  card.className = "song-card";
  card.innerHTML = `
    <div class="sc-art-wrap">
      <img class="sc-art" src="${a.album.images[0]?.url || ''}" alt="" loading="lazy">
      <button class="sc-play-btn"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21"/></svg></button>
    </div>
    <div class="sc-title">${escapeHtml(a.name)}</div>
    <div class="sc-bottom"><span class="sc-artist">${escapeHtml(a.artists.map(x => x.name).join(", "))}</span></div>`;
  card.addEventListener("click", async () => {
    const tracks = await itunes.getAlbumTracks(a.id);
    if (tracks.length) playFromList(tracks, 0);
  });
  return card;
}

// ─── Search ──────────────────────────────────────────────────────
let searchTimer = null;
let searchSeq = 0;   // guards against out-of-order async responses
function bindSearchInput() {
  $("#globalSearch").addEventListener("input", () => {
    const q = $("#globalSearch").value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      hideSearchResults();
      $("#searchEmpty").style.display = "flex";
      renderRecentSearches();
      return;
    }
    searchTimer = setTimeout(() => runSmartSearch(q), 280);
  });
}

// ── Recent searches (persisted) ──────────────────────────────────
const SEARCH_KEY = "lyrica_searches_v1";
const SEARCH_MAX = 8;
function loadSearches() {
  try { return JSON.parse(localStorage.getItem(SEARCH_KEY) || "[]"); }
  catch { return []; }
}
function recordSearch(q) {
  q = q.trim();
  if (!q) return;
  const lc = q.toLowerCase();
  state.searches = state.searches.filter(s => s.toLowerCase() !== lc);
  state.searches.unshift(q);
  if (state.searches.length > SEARCH_MAX) state.searches.length = SEARCH_MAX;
  try { localStorage.setItem(SEARCH_KEY, JSON.stringify(state.searches)); } catch {}
}
function clearSearches() {
  state.searches = [];
  try { localStorage.removeItem(SEARCH_KEY); } catch {}
  renderRecentSearches();
}
function renderRecentSearches() {
  const box = $("#recentSearches");
  if (!box) return;
  if (!state.searches.length) { box.style.display = "none"; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div class="rs-head"><span>Recent searches</span><button class="rs-clear" id="rsClear">Clear</button></div>
    <div class="rs-chips"></div>`;
  const chips = box.querySelector(".rs-chips");
  state.searches.forEach(q => {
    const chip = document.createElement("button");
    chip.className = "rs-chip";
    chip.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>${escapeHtml(q)}`;
    chip.addEventListener("click", () => {
      const gs = $("#globalSearch");
      gs.value = q;
      runSmartSearch(q);
    });
    chips.appendChild(chip);
  });
  box.querySelector("#rsClear").addEventListener("click", clearSearches);
}

// Bias search ranking toward artists/genres the listener already likes or plays.
function searchTaste() {
  const artists = new Set(), genres = new Set();
  const add = (t) => {
    const a = t?.artists?.[0]?.name;
    if (a) artists.add(a);
    if (t?.genre) genres.add(t.genre);
  };
  state.liked.forEach(add);
  state.recent.forEach(add);
  return { favoriteArtists: [...artists], favoriteGenres: [...genres] };
}

function hideSearchResults() {
  $("#searchSmart").style.display = "none";
  $("#searchResults").style.display = "none";
  $("#searchMoreTitle").style.display = "none";
}

// Instant matches from the listener's OWN library (liked + recently played +
// playlists) — these surface ahead of catalog results, so searching feels
// immediate and personal (Spotify shows your own stuff first too).
function searchLibrary(q) {
  const ql = q.toLowerCase().trim();
  if (!ql) return [];
  const qt = ql.split(/\s+/).filter(Boolean);
  const seen = new Set();
  const pool = [];
  const add = (t) => { if (t?.id && !seen.has(t.id)) { seen.add(t.id); pool.push(t); } };
  state.liked.forEach(add);
  state.recent.forEach(add);
  for (const pl of state.playlists) (pl.tracks || []).forEach(add);

  const score = (t) => {
    const name = (t.name || "").toLowerCase();
    const artist = (t.artists?.[0]?.name || "").toLowerCase();
    let s = 0;
    if (name === ql) s += 100;
    else if (name.startsWith(ql)) s += 60;
    else if (name.includes(ql)) s += 35;
    if (artist === ql) s += 50; else if (artist.includes(ql)) s += 22;
    const ft = `${name} ${artist}`.split(/\s+/);
    s += qt.filter(x => ft.some(f => f.includes(x))).length * 9;
    return s;
  };
  return pool.map(t => ({ t, s: score(t) }))
    .filter(x => x.s >= 25)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(x => x.t);
}

// Smart search: a Spotify-style "Top result" + ranked Songs list, with the
// long tail rendered as a card grid below.
async function runSmartSearch(q) {
  const seq = ++searchSeq;
  let { topResult, tracks } = await itunes.smartSearch(q, 40, searchTaste());
  if (seq !== searchSeq) return;   // a newer keystroke already fired

  recordSearch(q);
  $("#searchEmpty").style.display = "none";

  // Fold in matches from the user's own library, deduped and placed first.
  const lib = searchLibrary(q);
  if (lib.length) {
    const libIds = new Set(lib.map(t => t.id));
    tracks = [...lib, ...tracks.filter(t => !libIds.has(t.id))];
    // A spot-on library hit becomes the Top result.
    if ((lib[0].name || "").toLowerCase() === q.toLowerCase().trim()) {
      topResult = { type: "track", track: lib[0] };
    }
  }

  if (tracks.length === 0) {
    hideSearchResults();
    $("#searchResults").style.display = "grid";
    $("#searchResults").innerHTML =
      '<p style="color:var(--text-3);grid-column:1/-1;text-align:center;padding:40px;">No results.</p>';
    return;
  }

  renderTopResult(topResult, tracks);
  renderSongList(tracks.slice(0, 6));
  $("#searchSmart").style.display = "grid";

  // Long tail as cards.
  const more = tracks.slice(6);
  const grid = $("#searchResults");
  if (more.length) {
    $("#searchMoreTitle").style.display = "block";
    grid.style.display = "grid";
    grid.innerHTML = "";
    more.forEach((t, i) => grid.appendChild(trackCard(t, tracks, i + 6)));
  } else {
    $("#searchMoreTitle").style.display = "none";
    grid.style.display = "none";
  }

  prefetchLyrics(tracks.slice(0, 10));
}

function renderTopResult(topResult, tracks) {
  const card = $("#topResultCard");
  if (!topResult) { card.innerHTML = ""; return; }

  if (topResult.type === "artist") {
    // Build a "play this artist" queue from their tracks in the results.
    const artistTracks = tracks.filter(
      t => t.artists[0]?.name?.toLowerCase() === topResult.name.toLowerCase()
    );
    const queue = artistTracks.length ? artistTracks : tracks;
    card.innerHTML = `
      <img class="tr-art round" src="${topResult.image || tracks[0]?.album.images[0]?.url || ''}" alt="">
      <div class="tr-name">${escapeHtml(topResult.name)}</div>
      <div class="tr-meta"><span class="tr-type-pill">Artist</span><span class="tr-sub">${escapeHtml(topResult.genre)}</span></div>
      <button class="tr-play"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21"/></svg></button>`;
    card.onclick = () => playFromList(queue, 0);
  } else {
    const t = topResult.track;
    card.innerHTML = `
      <img class="tr-art" src="${t.album.images[0]?.url || ''}" alt="">
      <div class="tr-name">${escapeHtml(t.name)}</div>
      <div class="tr-meta"><span class="tr-type-pill">Song</span><span class="tr-sub">${escapeHtml(t.artists.map(a => a.name).join(", "))}</span></div>
      <button class="tr-play"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21"/></svg></button>`;
    card.onclick = () => playFromList(tracks, tracks.indexOf(t));
  }
}

function renderSongList(tracks) {
  const el = $("#songList");
  el.innerHTML = "";
  tracks.forEach((t, i) => el.appendChild(songRow(t, tracks, i)));
}

// ─── Library (localStorage) ──────────────────────────────────────
function renderLibrary() {
  const grid = $("#libraryGrid");
  const empty = $("#libraryEmpty");
  const tracks = [...state.liked.values()];
  if (tracks.length === 0) {
    grid.style.display = "none";
    empty.style.display = "flex";
    return;
  }
  grid.style.display = "grid";
  empty.style.display = "none";
  grid.innerHTML = "";
  tracks.forEach((t, i) => grid.appendChild(trackCard(t, tracks, i)));
}

// ─── Queue view ──────────────────────────────────────────────────
function renderQueue() {
  const container = $("#queueList");
  container.innerHTML = "";
  if (state.queue.length === 0) {
    container.innerHTML = '<div style="color:var(--text-3);padding:20px;">Queue is empty. Play something first.</div>';
    return;
  }
  state.queue.forEach((t, idx) => {
    const item = document.createElement("div");
    item.className = `queue-item ${idx === state.currentIndex ? 'active-queue' : ''}`;
    item.innerHTML = `
      <span class="qi-num">${idx === state.currentIndex ? '▶' : idx + 1}</span>
      <img class="qi-art" src="${t.album.images[0]?.url || ''}" loading="lazy">
      <div class="qi-meta">
        <div class="qi-title">${escapeHtml(t.name)}</div>
        <div class="qi-artist">${escapeHtml(t.artists.map(a => a.name).join(", "))}</div>
      </div>
      <button class="qi-remove" title="Remove from queue">
        <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
      </button>`;
    item.querySelector(".qi-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(idx);
    });
    item.addEventListener("click", () => playFromList(state.queue, idx));
    container.appendChild(item);
  });
}

// ─── Recently played (localStorage) ──────────────────────────────
const RECENT_KEY = "lyrica_recent_v1";
const RECENT_MAX = 16;

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch { return []; }
}
function saveRecent() {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent)); } catch {}
}
// Record a play: move the track to the front, dedup by id, cap the list.
function pushRecent(track) {
  if (!track?.id) return;
  state.recent = state.recent.filter(t => t.id !== track.id);
  state.recent.unshift(track);
  if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
  saveRecent();
  if (state.view === "home") renderRecent();
}
function clearRecent() {
  state.recent = [];
  saveRecent();
  renderRecent();
  toast("Recently played cleared");
}
function renderRecent() {
  const section = $("#recentSection");
  const grid = $("#recentGrid");
  if (!section || !grid) return;
  if (state.recent.length === 0) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  grid.innerHTML = "";
  state.recent.forEach((t, i) => grid.appendChild(trackCard(t, state.recent, i)));
}

// ─── Playback ────────────────────────────────────────────────────
function playFromList(list, idx) {
  state.queue = list.slice();
  state.currentIndex = idx;
  navigate("nowplaying");
  loadTrack(true);
}

function current() { return state.queue[state.currentIndex] || null; }

// One-time nudge per track: if the matched video's length still differs a lot
// from the studio track, synced lyrics may drift — point the user at the offset.
let syncHintTrackId = null;
function maybeSyncHint(ytDur) {
  const t = current();
  if (!t || !ytDur || ytDur < 1 || syncHintTrackId === t.id) return;
  syncHintTrackId = t.id;
  if (!state.lyricsSynced) return;
  const want = Math.round((t.duration_ms || 0) / 1000);
  if (want && Math.abs(ytDur - want) > 12) {
    toast("Heads up: this video's length differs from the track — if lyrics drift, use ⋯ → Sync offset");
  }
}

// Append a track to the end of the play queue. If nothing is playing yet,
// just start it. Returns a short status for toasts/voice feedback.
function addToQueue(track) {
  if (!track) return "No song to add";
  if (state.currentIndex < 0 || state.queue.length === 0) {
    playFromList([track], 0);
    return `Playing “${track.name}”`;
  }
  state.queue.push(track);
  if (state.view === "queue") renderQueue();
  return `Added “${track.name}” to queue`;
}

// Insert a track right after the current one so it plays next.
function playNext(track) {
  if (!track) return "No song to add";
  if (state.currentIndex < 0 || state.queue.length === 0) {
    playFromList([track], 0);
    return `Playing “${track.name}”`;
  }
  state.queue.splice(state.currentIndex + 1, 0, track);
  if (state.view === "queue") renderQueue();
  return `“${track.name}” will play next`;
}

// Remove a track from the queue by its position, keeping currentIndex valid.
function removeFromQueue(idx) {
  if (idx < 0 || idx >= state.queue.length) return;
  if (idx === state.currentIndex) { toast("Can't remove the song that's playing"); return; }
  state.queue.splice(idx, 1);
  if (idx < state.currentIndex) state.currentIndex--;
  renderQueue();
}

// Pre-warm the LRCLIB cache for the neighbouring tracks so that hitting
// next/prev shows lyrics instantly instead of waiting on a fresh fetch.
function prefetchAdjacentLyrics() {
  const q = state.queue;
  if (q.length < 2) return;
  const next = q[(state.currentIndex + 1) % q.length];
  const prev = q[(state.currentIndex - 1 + q.length) % q.length];
  prefetchLyrics([next, prev].filter(Boolean));
}

function loadTrack(autoplay) {
  const t = current();
  if (!t) return;

  exitVirtualMode();   // leaving any lyrics-only fallback from the previous track

  const cover = t.album.images[0]?.url || "";
  const title = t.name;
  const artist = t.artists.map(a => a.name).join(", ");

  $("#pbArt").src = cover;
  $("#pbTitle").textContent = title;
  $("#pbArtist").textContent = artist;
  $("#npTitle").textContent = title;
  $("#npArtist").textContent = artist;

  // The mini player-bar panel stays hidden until the first track loads.
  $("#pbLeft").classList.remove("is-empty");
  pushRecent(t);
  updateMediaSession();

  $("#progressFill").style.width = "0%";
  $("#progressThumb").style.left = "0%";
  $("#timeCurrent").textContent = "0:00";
  $("#timeTotal").textContent = "0:00";
  state.currentTime = 0;
  state.duration = 0;

  updateLikeButtons();
  renderQueue();
  loadLyricsForCurrent();
  prefetchAdjacentLyrics();   // warm next/prev so switching tracks is instant

  if (autoplay) {
    if (!yt.isReady()) {
      // Player still booting — retry once it's up.
      yt.on("ready", () => playOnYouTube(t));
    } else {
      playOnYouTube(t);
    }
  }
}

function playOnYouTube(t) {
  const artist = t.artists.map(a => a.name).join(" ");
  // "official audio" biases YouTube toward studio uploads over live/remix versions,
  // so the LRCLIB lyrics line up better.
  const q = `${t.name} ${artist} official audio`;
  // Pass the studio track length so the server picks the upload whose duration
  // matches — that's what makes the synced lyric timestamps line up.
  const dur = Math.round((t.duration_ms || 0) / 1000);
  yt.searchAndPlay(q, dur);
}

function togglePlay() {
  if (state.queue.length === 0) return;
  // Robustness: if YouTube is ready but nothing actually loaded (autoplay was
  // blocked, or a load got missed), the Play click (a user gesture) should KICK
  // OFF the current track rather than no-op.
  if (!state.virtual && yt.isReady() && current() && yt.getDuration() === 0) {
    playOnYouTube(current());
    return;
  }
  if (pb.isPaused()) pb.play(); else pb.pause();
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  $("#btnShuffle").classList.toggle("active", state.shuffle);
  if (state.shuffle) {
    buildShuffleOrder(state.currentIndex);   // arm a fresh smart order from here
    toast("Smart shuffle on");
  } else {
    state.shuffleOrder = null;
    toast("Shuffle off");
  }
}

function nextTrack() {
  if (state.queue.length === 0) return;
  if (state.shuffle) advanceShuffle(+1);
  else state.currentIndex = (state.currentIndex + 1) % state.queue.length;
  loadTrack(true);
}

function prevTrack() {
  if (state.queue.length === 0) return;
  if (pb.getCurrentTime() > 3) { pb.seekTo(0); return; }
  if (state.shuffle) advanceShuffle(-1);
  else state.currentIndex = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
  loadTrack(true);
}

// ─── Smart shuffle (Spotify-style) ───────────────────────────────
// True randomness *clumps* — you get three songs by one artist in a row and it
// feels broken. Spotify solves this with an even-distribution shuffle (Poláček):
// group tracks by artist, then lay each group out at evenly-spaced positions
// across the queue with a random offset + jitter, so same-artist (and, as a
// tiebreak, same-genre) songs are spread APART. On top of that we personalize —
// liked songs drift a little earlier, just-played songs a little later — and we
// always cover the whole queue before anything repeats.
const artistKey = (t) => (t?.artists?.[0]?.name || "").toLowerCase().trim();
const genreKey  = (t) => (t?.genre || "").toLowerCase().trim();

function fisherYates(arr) {
  for (let k = arr.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [arr[k], arr[j]] = [arr[j], arr[k]];
  }
  return arr;
}

// Lay one group of indices (already order-randomized) onto evenly-spaced
// positions in [0,1) with a random start offset and per-item jitter.
function spreadGroup(items, place, posOf) {
  const m = items.length;
  const spacing = 1 / m;
  const offset = Math.random() * spacing;
  items.forEach((idx, k) => {
    let pos = offset + k * spacing + (Math.random() - 0.5) * spacing * 0.5;
    pos += posOf(state.queue[idx]);
    place.push({ i: idx, pos });
  });
}

function buildShuffleOrder(startIndex) {
  const n = state.queue.length;
  if (n === 0) { state.shuffleOrder = []; state.shufflePos = 0; return; }
  const start = (startIndex >= 0 && startIndex < n) ? startIndex : Math.floor(Math.random() * n);

  // Group the rest (the current track plays first) by artist; group same-genre
  // tracks of unknown/one-off artists too so genres also don't bunch up.
  const recentIds = new Set(state.recent.slice(0, 12).map(t => t.id));
  const posOf = (t) => {
    let d = 0;
    if (state.liked.has(t?.id)) d -= 0.06 * Math.random();   // favourites a touch earlier
    if (recentIds.has(t?.id))   d += 0.10 * Math.random();   // just-played a touch later
    return d;
  };

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    if (i === start) continue;
    const t = state.queue[i];
    const key = artistKey(t) || (genreKey(t) ? `genre:${genreKey(t)}` : `solo:${i}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }

  const placed = [];
  for (const items of groups.values()) spreadGroup(fisherYates(items), placed, posOf);
  placed.sort((a, b) => a.pos - b.pos);

  state.shuffleOrder = [start, ...placed.map(p => p.i)];
  state.shufflePos = 0;
}

// Rebuild the order if it's missing, stale (queue changed), or no longer lined
// up with the track we're actually on (e.g. the user picked a song directly).
function ensureShuffleOrder() {
  const o = state.shuffleOrder;
  if (o && o.length === state.queue.length && o[state.shufflePos] === state.currentIndex) return;
  buildShuffleOrder(state.currentIndex);
}

// Is there another track to play after the current one (without repeat-all)?
// Shuffle-aware: under shuffle we check our position in the shuffled order,
// not the raw queue index.
function hasMoreToPlay() {
  if (state.shuffle) {
    ensureShuffleOrder();
    return state.shufflePos < state.shuffleOrder.length - 1;
  }
  return state.currentIndex < state.queue.length - 1;
}

function advanceShuffle(dir) {
  if (state.queue.length === 0) return;
  ensureShuffleOrder();
  let pos = state.shufflePos + dir;
  if (pos >= state.shuffleOrder.length) {   // finished a full pass — reshuffle
    buildShuffleOrder(-1);
    pos = 0;
  } else if (pos < 0) {
    pos = 0;
  }
  state.shufflePos = pos;
  state.currentIndex = state.shuffleOrder[pos];
}

// ─── Autoplay ────────────────────────────────────────────────────
// When the queue runs out (and Autoplay is on), keep the music going: pull
// tracks related to the last song — same artist first, then same genre — that
// aren't already queued, append them, and play on.
async function autoplayMore() {
  const t = current();
  if (!t) { state.paused = true; updatePlayButton(); return; }
  try {
    const have = new Set(state.queue.map(x => x.id));
    const fresh = (arr) => arr.filter(x => x?.id && !have.has(x.id));

    const seed = t.artists?.[0]?.name || t.name;
    let pool = fresh(await itunes.searchTracks(seed, 25));
    if (pool.length < 3 && t.genre) pool = pool.concat(fresh(await itunes.tracksByGenre(t.genre, 25)));
    if (!pool.length) { state.paused = true; updatePlayButton(); return; }

    const startLen = state.queue.length;
    state.queue.push(...pool.slice(0, 10));
    state.currentIndex = startLen;            // first newly-added track
    if (state.shuffle) buildShuffleOrder(state.currentIndex);
    renderQueue();
    toast("Autoplay · added similar songs");
    loadTrack(true);
  } catch {
    state.paused = true; updatePlayButton();
  }
}

function updatePlayButton() {
  const icon = $("#playIcon");
  if (!state.paused) {
    icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    startVisualizer();
  } else {
    icon.innerHTML = '<polygon points="5 3 19 12 5 21"/>';
    stopVisualizer();
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = state.paused ? "paused" : "playing";
  }
}

// ─── Media Session (OS media keys, lock-screen art & controls) ───
function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => pb.play());
  ms.setActionHandler("pause", () => pb.pause());
  ms.setActionHandler("previoustrack", () => prevTrack());
  ms.setActionHandler("nexttrack", () => nextTrack());
  try {
    ms.setActionHandler("seekto", (d) => { if (d.seekTime != null) pb.seekTo(d.seekTime); });
    ms.setActionHandler("seekforward", () => pb.seekTo(pb.getCurrentTime() + 10));
    ms.setActionHandler("seekbackward", () => pb.seekTo(Math.max(0, pb.getCurrentTime() - 10)));
  } catch { /* some browsers lack these actions */ }
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  const t = current();
  if (!t) return;
  const art = t.album.images[0]?.url;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.name,
    artist: t.artists.map(a => a.name).join(", "),
    album: t.album?.name || "Lyrica",
    artwork: art ? [
      { src: art, sizes: "300x300", type: "image/jpeg" },
      { src: art, sizes: "512x512", type: "image/jpeg" },
    ] : [],
  });
}

// ─── Volume ──────────────────────────────────────────────────────
function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  pb.setVolume(state.muted ? 0 : state.volume);
  $("#volumeFill").style.width = `${(state.muted ? 0 : state.volume) * 100}%`;
  updateVolIcon();
}
function toggleMute() {
  state.muted = !state.muted;
  if (state.muted) pb.mute(); else { pb.unMute(); pb.setVolume(state.volume); }
  $("#volumeFill").style.width = `${(state.muted ? 0 : state.volume) * 100}%`;
  updateVolIcon();
}
function updateVolIcon() {
  const v = state.muted ? 0 : state.volume;
  const icon = $("#volIcon");
  if (v === 0) icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
  else if (v < 0.5) icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M15.54 8.46a5 5 0 010 7.07"/>';
  else icon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>';
}

// ─── Likes ───────────────────────────────────────────────────────
function toggleLike(track) {
  const id = track.id;
  if (state.liked.has(id)) {
    state.liked.delete(id);
    toast("Removed from Liked Songs");
  } else {
    state.liked.set(id, track);
    toast("Added to Liked Songs ♥");
  }
  localStorage.setItem("lyrica_liked_v2", JSON.stringify([...state.liked]));
  updateSidebarCount();
  updateLikeButtons();
  $$(`[data-id="${id}"]`).forEach(b => b.classList.toggle("liked", state.liked.has(id)));
  if (state.view === "library") renderLibrary();
}

function updateLikeButtons() {
  const id = current()?.id;
  if (!id) return;
  const liked = state.liked.has(id);
  $("#pbLikeBtn").classList.toggle("liked", liked);
  $("#npLikeBtn").classList.toggle("liked", liked);
}

function updateSidebarCount() {
  $("#sidebarLikedCount").textContent = state.liked.size;
  const pm = $("#pmLikedCount");
  if (pm) pm.textContent = state.liked.size;
}

// ─── Playlists ───────────────────────────────────────────────────
const PLAYLIST_KEY = "lyrica_playlists_v1";

function loadPlaylists() {
  try { return JSON.parse(localStorage.getItem(PLAYLIST_KEY) || "[]"); }
  catch { return []; }
}
function savePlaylists() {
  try { localStorage.setItem(PLAYLIST_KEY, JSON.stringify(state.playlists)); } catch {}
}
function genId() {
  // Time + randomness is plenty for a localStorage-only id.
  return "pl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function findPlaylist(id) {
  return state.playlists.find(p => p.id === id) || null;
}

// Create a playlist; if `seedTrack` is given, drops it in immediately.
function createPlaylist(name, seedTrack = null) {
  const pl = { id: genId(), name: name.trim() || "My Playlist", tracks: [] };
  if (seedTrack) pl.tracks.push(seedTrack);
  state.playlists.unshift(pl);
  savePlaylists();
  renderSidebarPlaylists();
  return pl;
}

function deletePlaylist(id) {
  state.playlists = state.playlists.filter(p => p.id !== id);
  savePlaylists();
  renderSidebarPlaylists();
  if (state.currentPlaylistId === id) {
    state.currentPlaylistId = null;
    navigate("home");
  }
}

function renamePlaylist(id, name) {
  const pl = findPlaylist(id);
  if (!pl) return;
  pl.name = name.trim() || pl.name;
  savePlaylists();
  renderSidebarPlaylists();
  if (state.currentPlaylistId === id) renderPlaylistView(id);
}

// Add (or, if already present, do nothing) a track to a playlist.
function addToPlaylist(playlistId, track) {
  const pl = findPlaylist(playlistId);
  if (!pl) return;
  if (pl.tracks.some(t => t.id === track.id)) {
    toast(`Already in "${pl.name}"`);
    return;
  }
  pl.tracks.push(track);
  savePlaylists();
  toast(`Added to "${pl.name}" ✓`);
  if (state.currentPlaylistId === playlistId) renderPlaylistView(playlistId);
}

function removeFromPlaylist(playlistId, trackId) {
  const pl = findPlaylist(playlistId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter(t => t.id !== trackId);
  savePlaylists();
  if (state.currentPlaylistId === playlistId) renderPlaylistView(playlistId);
}

function renderSidebarPlaylists() {
  const wrap = $("#sidebarPlaylists");
  // Keep the two fixed items (Liked Songs, Play Queue); replace the rest.
  wrap.querySelectorAll(".pl-user").forEach(n => n.remove());
  state.playlists.forEach(pl => {
    const btn = document.createElement("button");
    btn.className = "sidebar-playlist-item pl-user";
    if (pl.id === state.currentPlaylistId && state.view === "playlist") btn.classList.add("active-pl");
    btn.innerHTML = `<span class="pl-icon">🎵</span> ${escapeHtml(pl.name)} <span class="liked-count">${pl.tracks.length}</span>`;
    btn.addEventListener("click", () => openPlaylist(pl.id));
    wrap.appendChild(btn);
  });
}

function openPlaylist(id) {
  state.currentPlaylistId = id;
  navigate("playlist");
}

function renderPlaylistView(id) {
  const pl = findPlaylist(id);
  if (!pl) { navigate("home"); return; }

  $("#playlistName").textContent = pl.name;
  $("#playlistSub").textContent =
    pl.tracks.length === 0 ? "No songs yet" : `${pl.tracks.length} song${pl.tracks.length === 1 ? "" : "s"}`;

  // Cover: use the first track's art if available, else a gradient tile.
  const cover = $("#playlistCover");
  const art = pl.tracks[0]?.album.images[0]?.url;
  if (art) {
    cover.style.backgroundImage = `url('${art}')`;
    cover.textContent = "";
  } else {
    cover.style.backgroundImage = "";
    cover.textContent = "🎵";
  }

  const empty = $("#playlistEmpty");
  const listEl = $("#playlistTracks");
  $("#playlistPlayBtn").style.display = pl.tracks.length ? "flex" : "none";

  if (pl.tracks.length === 0) {
    empty.style.display = "flex";
    listEl.innerHTML = "";
    return;
  }
  empty.style.display = "none";
  listEl.innerHTML = "";
  pl.tracks.forEach((t, i) => {
    listEl.appendChild(songRow(t, pl.tracks, i, { index: i + 1, playlistId: id }));
  });
}

// ─── Add-to-playlist context menu ────────────────────────────────
let ctxTrack = null;           // track the menu is acting on
let pendingSeedTrack = null;   // track to seed into a brand-new playlist

function openCtxMenu(track, anchorEl) {
  ctxTrack = track;
  const menu = $("#ctxMenu");
  const list = $("#ctxList");
  list.innerHTML = "";

  if (state.playlists.length === 0) {
    list.innerHTML = '<div class="ctx-empty">No playlists yet — create one below.</div>';
  } else {
    state.playlists.forEach(pl => {
      const has = pl.tracks.some(t => t.id === track.id);
      const item = document.createElement("button");
      item.className = "ctx-item";
      item.innerHTML = `<span class="pl-icon">🎵</span><span>${escapeHtml(pl.name)}</span>${has ? '<span class="ctx-check">✓</span>' : ""}`;
      item.addEventListener("click", () => {
        addToPlaylist(pl.id, track);
        closeCtxMenu();
      });
      list.appendChild(item);
    });
  }

  // Position near the anchor, clamped to the viewport.
  menu.classList.add("open");
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth || 240;
  const mh = menu.offsetHeight || 200;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function closeCtxMenu() {
  $("#ctxMenu").classList.remove("open");
  ctxTrack = null;
}

// ─── Modal (create / rename) ─────────────────────────────────────
let modalMode = "create";      // "create" | "rename"
let modalPlaylistId = null;

function openModal(mode, { playlistId = null, seedTrack = null, value = "" } = {}) {
  modalMode = mode;
  modalPlaylistId = playlistId;
  pendingSeedTrack = seedTrack;
  $("#modalTitle").textContent = mode === "rename" ? "Rename playlist" : "Create playlist";
  $("#modalSave").textContent = mode === "rename" ? "Save" : "Create";
  const input = $("#modalInput");
  input.value = value;
  $("#modalOverlay").classList.add("open");
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeModal() {
  $("#modalOverlay").classList.remove("open");
  pendingSeedTrack = null;
  modalPlaylistId = null;
}

function commitModal() {
  const name = $("#modalInput").value.trim();
  if (!name) { toast("Enter a name"); return; }
  if (modalMode === "rename" && modalPlaylistId) {
    renamePlaylist(modalPlaylistId, name);
  } else {
    const pl = createPlaylist(name, pendingSeedTrack);
    toast(pendingSeedTrack ? `Created "${pl.name}" with 1 song` : `Created "${pl.name}"`);
  }
  closeModal();
}

// ─── Song row (used by smart search + playlist view) ─────────────
function songRow(t, list, idx, { index = idx + 1, playlistId = null } = {}) {
  const row = document.createElement("div");
  row.className = "song-row";
  if (current()?.id === t.id) row.classList.add("active-row");
  const liked = state.liked.has(t.id);
  row.innerHTML = `
    <span class="sr-index">
      <span class="sr-num">${index}</span>
      <span class="sr-play"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21"/></svg></span>
    </span>
    <img class="sr-art" src="${t.album.images[0]?.url || ''}" alt="" loading="lazy">
    <div class="sr-meta">
      <div class="sr-title">${escapeHtml(t.name)}</div>
      <div class="sr-artist">${escapeHtml(t.artists.map(a => a.name).join(", "))}</div>
    </div>
    <div class="sr-actions">
      <button class="sr-like ${liked ? 'liked' : ''}" title="Like">
        <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
      <button class="sr-menu" title="More">
        <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </button>
    </div>`;

  row.addEventListener("click", () => playFromList(list, idx));
  row.querySelector(".sr-like").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLike(t);
    row.querySelector(".sr-like").classList.toggle("liked", state.liked.has(t.id));
  });
  row.querySelector(".sr-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    // In a playlist, the menu offers removal too — but keep it simple:
    // open the add-to-playlist menu; right-click style removal lives on the playlist.
    openCtxMenu(t, e.currentTarget);
  });

  // In the playlist view, give the row a quick "remove from this playlist".
  if (playlistId) {
    row.querySelector(".sr-menu").title = "Remove / add to playlist";
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      removeFromPlaylist(playlistId, t.id);
      toast("Removed from playlist");
    });
  }
  return row;
}

// ─── Navigation ──────────────────────────────────────────────────
function navigate(view) {
  if (state.view !== view) state.viewHistory.push(state.view);
  state.view = view;
  document.body.classList.remove("nav-open");   // dismiss the mobile drawer on navigation
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#view-${view}`)?.classList.add("active");
  $$(".nav-btn").forEach(b => b.classList.remove("active"));
  $(`.nav-btn[data-view="${view}"]`)?.classList.add("active");

  const gs = $("#globalSearch");
  const pt = $("#pageTitle");
  if (view === "search") { gs.style.display = "block"; pt.style.display = "none"; gs.focus(); if (!gs.value.trim()) renderRecentSearches(); }
  else { gs.style.display = "none"; pt.style.display = "block"; }

  const titles = { home: "", search: "", library: "Your Library", queue: "Play Queue", nowplaying: "Now Playing", playlist: "" };
  if (view === "home") greet();
  else pt.textContent = titles[view] || "";

  if (view === "home") renderRecent();
  if (view === "library") renderLibrary();
  if (view === "queue") renderQueue();
  if (view === "playlist" && state.currentPlaylistId) renderPlaylistView(state.currentPlaylistId);

  renderSidebarPlaylists();   // refresh the active-playlist highlight
  $("#historyBack").disabled = state.viewHistory.length === 0;
}

function goBack() {
  const prev = state.viewHistory.pop();
  if (prev) navigate(prev);
}

// ─── Lyrics ──────────────────────────────────────────────────────
async function loadLyricsForCurrent(force = false) {
  state.activeLyricIdx = -1;
  state.lyrics = null;
  state.lyricsSynced = true;
  state.lyricsSource = null;
  state.translationCache = {};
  state.romanCache = {};
  const t = current();
  if (!t) return;

  // User-adjustable fine-tune offset (most tracks need 0; LRCLIB timestamps
  // reference the full song, which is exactly what YouTube plays).
  state.lyricOffset = offsetStore[t.id] != null ? offsetStore[t.id] : 0;
  updateOffsetLabel();

  $("#lyricsInner").innerHTML = `
    <div class="lyrics-loading">
      <div class="lyrics-spinner"></div>
      <span>Loading lyrics…</span>
    </div>`;

  const result = await fetchLyrics(t, force);
  if (current()?.id !== t.id) return;   // user skipped while we were fetching
  if (!result || !result.lines || result.lines.length === 0) {
    state.lyricsSource = null;
    $("#lyricsInner").innerHTML = `
      <div class="lyrics-empty">
        <div class="le-icon">🎤</div>
        <div class="le-title">No lyrics found</div>
        <div class="le-sub">We couldn't find lyrics for this track anywhere. The studio version usually matches best.</div>
        <button class="le-retry" id="lyricsRetry">Try again</button>
      </div>`;
    $("#lyricsRetry")?.addEventListener("click", () => loadLyricsForCurrent(true));
    return;
  }
  state.lyrics = result.lines;
  state.lyricsSynced = result.synced !== false;
  state.lyricsSource = result.source || null;

  // Karaoke follows the song: re-point the recogniser at this track's language
  // and reset the per-line matcher + score for a fresh sing-along.
  if (state.karaoke) {
    if (state.lyricsSynced && karaokeRecognition) {
      karaokeRecognition.lang = karaokeLang();
      karaokeSession.correct = 0; karaokeSession.total = 0;
      kResultsLen = 0; kResultBase = 0;
      updateKaraokeHud(null);
    } else {
      // New track has no synced timing — karaoke can't score it; drop out.
      setKaraoke(false);
      toast("Karaoke off — this track has no time-synced lyrics.");
    }
  }

  updateTranslatorInfo();   // refresh the detected-language banner for this song
  translateAndRender();     // renders original, translation, or romanized original
}

function saveOffset() {
  const t = current();
  if (!t) return;
  offsetStore[t.id] = state.lyricOffset;
  try { localStorage.setItem("lyrica_offsets_v1", JSON.stringify(offsetStore)); } catch {}
}

// "+0.4s" / "−0.2s" — used in both the menu label and the live-nudge toast.
function offsetText() {
  const off = (state.lyricOffset == null || isNaN(state.lyricOffset)) ? 0 : state.lyricOffset;
  return off >= 0 ? `+${off.toFixed(1)}s` : `${off.toFixed(1)}s`;
}

function updateOffsetLabel() {
  const val = $("#offsetVal");
  const off = (state.lyricOffset == null || isNaN(state.lyricOffset)) ? 0 : state.lyricOffset;
  if (val) val.textContent = offsetText();
  // Keep the slider thumb in step with button/keyboard adjustments.
  const slider = $("#offsetSlider");
  if (slider && Number(slider.value) !== off) slider.value = String(off);
}

// Set the offset to an absolute value (slider) — clamp to the slider's range.
function setOffset(value) {
  let v = Number(value);
  if (isNaN(v)) v = 0;
  v = Math.max(-10, Math.min(10, Math.round(v * 10) / 10));
  state.lyricOffset = v;
  saveOffset();
  updateOffsetLabel();
  syncLyrics(true);
}

function adjustOffset(deltaOrReset) {
  if (deltaOrReset === "reset") {
    const t = current();
    if (t) delete offsetStore[t.id];
    state.lyricOffset = 0;
    try { localStorage.setItem("lyrica_offsets_v1", JSON.stringify(offsetStore)); } catch {}
    updateOffsetLabel();
    syncLyrics(true);
    return;
  }
  // Round to 0.1 to avoid float drift accumulating across many small nudges.
  state.lyricOffset = Math.round(((state.lyricOffset || 0) + deltaOrReset) * 10) / 10;
  saveOffset();
  updateOffsetLabel();
  syncLyrics(true);
}

// data = { text: translatedLines[]|null, roman: romanizedLines[]|null }
function renderLyrics(data = null) {
  if (!state.lyrics) return;
  const inner = $("#lyricsInner");
  inner.innerHTML = "";
  inner.classList.toggle("unsynced", !state.lyricsSynced);
  const mode = state.translitMode;     // translate | transliterate ("Sounds") | both
  const lang = state.lang;
  const text = data?.text || null;
  const roman = data?.roman || null;
  const isParen = (s) => /^\(.*\)$/.test(s);   // "(Instrumental)" — never translate

  state.lyrics.forEach(([time, original], idx) => {
    const div = document.createElement("div");
    div.className = "lyric-line";
    div.dataset.time = time;
    div.dataset.idx = idx;

    const tline = (text && text[idx] != null) ? text[idx] : original;   // translation
    const rline = (roman && roman[idx] != null) ? roman[idx] : "";       // romanization

    // Primary (large) line.
    const primary = document.createElement("span");
    primary.className = "lyric-main";   // target for the karaoke fill highlighter
    if (state.karaoke && !isParen(original)) {
      // Karaoke: the original is what you sing, so it's always the highlighted
      // line — split into per-word spans the recognizer can score individually.
      renderKaraokeWords(primary, original);
    } else if (lang === "none") {
      // No translation target. With Sounds, show the romanized reading as the
      // main line (or keep the original on top and put it beneath, in dual mode).
      primary.textContent = (!isParen(original) && rline && !state.dualLang) ? rline : original;
    } else if (state.dualLang) {
      primary.textContent = original;                       // original on top
    } else if (mode === "transliterate") {
      primary.textContent = isParen(original) ? original : (rline || tline);
    } else {
      primary.textContent = isParen(original) ? original : tline;   // translate / both
    }
    div.appendChild(primary);

    // Secondary line(s).
    if (!isParen(original)) {
      const subs = [];
      if (lang === "none") {
        if (rline && state.dualLang) subs.push(["lyric-translit", rline]);   // sounds under original
      } else if (state.dualLang) {
        if (mode === "translate" || mode === "both") subs.push(["lyric-trans", tline]);
        if (mode === "transliterate" || mode === "both") subs.push(["lyric-translit", rline]);
      } else if (mode === "both") {
        subs.push(["lyric-translit", rline]);   // translation is primary, sounds beneath
      }
      for (const [cls, val] of subs) {
        if (!val) continue;
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = val;
        div.appendChild(s);
      }
    }

    // Click-to-seek only makes sense for time-synced lyrics.
    if (state.lyricsSynced) {
      div.addEventListener("click", () => {
        const seekTo = time - (state.lyricOffset || 0);
        pb.seekTo(Math.max(0, seekTo));
        if (pb.isPaused()) pb.play();
      });
    }
    inner.appendChild(div);
  });
  state.activeLyricIdx = -1;
}

function syncLyrics(force = false) {
  if (!state.lyrics || !state.lyricsSynced) return;
  // YouTube plays the full song, so currentTime maps directly to lyric
  // timestamps. The user-tunable offset is just a small +/- correction.
  const offset = state.lyricOffset || 0;
  const t = state.currentTime + offset;
  let idx = -1;
  for (let i = 0; i < state.lyrics.length; i++) {
    if (t >= state.lyrics[i][0]) idx = i;
    else break;
  }
  const lines = $("#lyricsInner").querySelectorAll(".lyric-line");

  // On line change: move the highlight, fade sung lines, recentre the scroll.
  if (force || idx !== state.activeLyricIdx) {
    // Karaoke: grade the line we're leaving before we move on.
    if (state.karaoke && state.activeLyricIdx !== idx) karaokeLineChange(lines, idx);
    state.activeLyricIdx = idx;
    lines.forEach((l, i) => {
      l.classList.toggle("active", i === idx);
      l.classList.toggle("sung", i < idx);
      if (i !== idx) l.querySelector(".lyric-main")?.style.removeProperty("--fill");
    });
    const a = lines[idx];
    if (a) {
      const scroll = $("#lyricsScroll");
      scroll.scrollTo({ top: a.offsetTop - scroll.clientHeight / 2 + a.clientHeight / 2, behavior: "smooth" });
    }
  }

  // Every tick: advance the karaoke fill across the active line, based on how
  // far we are between its timestamp and the next line's.
  if (idx >= 0 && lines[idx]) {
    const start = state.lyrics[idx][0];
    const end = (idx + 1 < state.lyrics.length) ? state.lyrics[idx + 1][0] : start + 4;
    const frac = end > start ? Math.max(0, Math.min(1, (t - start) / (end - start))) : 1;
    lines[idx].querySelector(".lyric-main")?.style.setProperty("--fill", `${(frac * 100).toFixed(1)}%`);
  }
}

// ═══ Karaoke — sing-along pronunciation scoring ═══════════════════
// Listens to the mic with a dedicated continuous SpeechRecognition (separate
// from the one-shot voice-command recogniser), and grades each word of the
// active lyric line: words you sing correctly light up green; words you skip or
// get wrong flash red when the line ends. A small HUD tracks the running score.

let karaokeRecognition = null;
let karaokeSupported = false;
let karaokePausedForVoice = false;   // true while a voice command borrows the mic
const karaokeSession = { correct: 0, total: 0 };

// Per-line matching state (the line currently being scored).
let kResultsLen = 0;     // size of the recogniser's cumulative results array
let kResultBase = 0;     // where (in that array) the CURRENT line's speech starts

// Lyric-script language name (from detectOriginalLang) → speech-recognition BCP-47.
const SR_LANG = {
  Telugu: "te-IN", Hindi: "hi-IN", Tamil: "ta-IN", Kannada: "kn-IN",
  Malayalam: "ml-IN", Punjabi: "pa-IN", Bengali: "bn-IN", Gujarati: "gu-IN",
  Arabic: "ar-SA", Korean: "ko-KR", Russian: "ru-RU", Greek: "el-GR",
  Hebrew: "he-IL", Chinese: "zh-CN", Japanese: "ja-JP",
};

// Pick the recognition locale for the current song; default to English.
function karaokeLang() {
  const name = state.lyrics ? detectOriginalLang(state.lyrics.map(l => l[1])) : null;
  return (name && SR_LANG[name]) || "en-US";
}

// Normalise a word for comparison: lowercase, strip accents + punctuation,
// keep only letters/digits (mirrors translate.js's toReadableLatin approach).
function normalizeWord(w) {
  return String(w || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")        // combining accent marks
    .replace(/[^\p{L}\p{N}]/gu, "");        // anything that isn't a letter/number
}

function tokenize(text) {
  return String(text || "").split(/\s+/).map(normalizeWord).filter(Boolean);
}

// Classic Levenshtein edit distance (small strings — plenty fast).
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Two words "match" if they're equal, or close enough that the difference is
// almost certainly mis-hearing (tolerance scales with word length).
function wordsMatch(heard, expected) {
  if (!heard || !expected) return false;
  if (heard === expected) return true;
  if (expected.length < 4) return false;             // short words: exact only
  return levenshtein(heard, expected) <= Math.ceil(expected.length / 4);
}

// Render text as individual karaoke word tokens (used by renderLyrics).
function renderKaraokeWords(container, text) {
  container.innerHTML = "";
  const words = String(text || "").split(/(\s+)/);   // keep the whitespace chunks
  words.forEach(chunk => {
    if (/^\s+$/.test(chunk) || chunk === "") { container.appendChild(document.createTextNode(chunk)); return; }
    const norm = normalizeWord(chunk);
    if (!norm) { container.appendChild(document.createTextNode(chunk)); return; }
    const span = document.createElement("span");
    span.className = "kw";
    span.dataset.w = norm;
    span.textContent = chunk;
    container.appendChild(span);
  });
}

// Greedily align the words heard so far against the active line's expected
// words, marking each matched span green. Skip-tolerant: a heard word can
// satisfy the next expected word OR the one after (handles a dropped word).
function applyKaraokeMatch(lineEl, heardWords) {
  const spans = [...lineEl.querySelectorAll(".kw")];
  if (!spans.length) return;
  let p = 0;
  for (const h of heardWords) {
    if (p >= spans.length) break;
    if (wordsMatch(h, spans[p].dataset.w)) {
      spans[p].classList.add("kw-correct"); p++;
    } else if (p + 1 < spans.length && wordsMatch(h, spans[p + 1].dataset.w)) {
      spans[p + 1].classList.add("kw-correct"); p += 2;
    }
  }
  updateKaraokeHud(lineEl);
}

// Live HUD: how much of the CURRENT line is right so far + session accuracy.
function updateKaraokeHud(lineEl) {
  const line = $("#khLine");
  const score = $("#khScore");
  if (lineEl && line) {
    const spans = [...lineEl.querySelectorAll(".kw")];
    const got = spans.filter(s => s.classList.contains("kw-correct")).length;
    line.textContent = spans.length ? `${got}/${spans.length} words` : "Sing along…";
  }
  if (score) {
    const pct = karaokeSession.total ? Math.round((karaokeSession.correct / karaokeSession.total) * 100) : 100;
    score.textContent = `${pct}%`;
    score.classList.toggle("good", pct >= 80);
    score.classList.toggle("bad", karaokeSession.total > 0 && pct < 50);
  }
}

// Called from syncLyrics when the active line changes: grade the line we're
// leaving (un-matched words → missed/red, fold into the session), then arm the
// matcher for the new line.
function karaokeLineChange(lines, newIdx) {
  const prev = lines[state.activeLyricIdx];
  if (prev) {
    const spans = [...prev.querySelectorAll(".kw")];
    spans.forEach(s => { if (!s.classList.contains("kw-correct")) s.classList.add("kw-missed"); });
    karaokeSession.correct += spans.filter(s => s.classList.contains("kw-correct")).length;
    karaokeSession.total += spans.length;
  }
  // New line starts fresh; only speech from here on counts toward it.
  kResultBase = kResultsLen;
  updateKaraokeHud(lines[newIdx]);
}

function initKaraoke() {
  const btn = $("#karaokeBtn");
  if (!btn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.classList.add("unsupported");
    btn.addEventListener("click", () => toast("Karaoke needs Chrome or Edge (and a microphone)."));
    return;
  }
  karaokeSupported = true;

  karaokeRecognition = new SR();
  karaokeRecognition.continuous = true;       // keep listening across the whole song
  karaokeRecognition.interimResults = true;   // score words as they're sung, not after
  karaokeRecognition.maxAlternatives = 1;

  karaokeRecognition.addEventListener("result", (e) => {
    kResultsLen = e.results.length;
    if (!state.karaoke || state.activeLyricIdx < 0) return;
    const lineEl = $("#lyricsInner").querySelectorAll(".lyric-line")[state.activeLyricIdx];
    if (!lineEl) return;
    // Only consider speech since the current line began.
    const heard = [];
    for (let i = Math.min(kResultBase, e.results.length); i < e.results.length; i++) {
      heard.push(...tokenize(e.results[i][0].transcript));
    }
    applyKaraokeMatch(lineEl, heard);
  });

  // Continuous recognition still stops on long silence / network hiccups —
  // restart it so karaoke keeps listening for the whole song.
  karaokeRecognition.addEventListener("end", () => {
    if (state.karaoke && !karaokePausedForVoice) {
      try { karaokeRecognition.start(); } catch {}
    }
  });

  karaokeRecognition.addEventListener("error", (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return;   // benign — end handler restarts
    const msg =
      (e.error === "not-allowed" || e.error === "service-not-allowed")
        ? "Mic blocked — click the lock icon in the address bar, allow Microphone, then retry"
      : e.error === "audio-capture" ? "No microphone detected"
      : e.error === "network"       ? "Karaoke needs internet for speech recognition"
      :                               `Karaoke error: ${e.error}`;
    toast(msg, 5000);
    if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
      setKaraoke(false);
    }
  });

  btn.addEventListener("click", () => setKaraoke(!state.karaoke));
}

function setKaraoke(on) {
  if (on === state.karaoke) return;
  if (on) {
    if (!karaokeSupported) { toast("Karaoke needs Chrome or Edge (and a microphone)."); return; }
    if (!state.lyrics || !state.lyricsSynced) {
      toast("Karaoke needs time-synced lyrics — try another track.");
      return;
    }
    state.karaoke = true;
    karaokeSession.correct = 0; karaokeSession.total = 0;
    kResultsLen = 0; kResultBase = 0;
    karaokeRecognition.lang = karaokeLang();
    $("#karaokeBtn").classList.add("active");
    $("#karaokeHud").classList.add("show");
    document.body.classList.add("karaoke-on");
    updateKaraokeHud(null);
    translateAndRender();                 // re-render so the original shows as word spans
    try { karaokeRecognition.start(); }
    catch { setTimeout(() => { try { karaokeRecognition.start(); } catch {} }, 300); }
    toast(`Karaoke on 🎤 — sing along! (mic language: ${karaokeRecognition.lang})`, 3500);
  } else {
    state.karaoke = false;
    karaokePausedForVoice = false;
    $("#karaokeBtn").classList.remove("active");
    $("#karaokeHud").classList.remove("show");
    document.body.classList.remove("karaoke-on");
    try { karaokeRecognition.stop(); } catch {}
    translateAndRender();                 // re-render to drop word spans
  }
}

// Voice commands and karaoke can't share the mic — pause karaoke while a voice
// command is captured, then resume it.
function pauseKaraokeForVoice() {
  if (!state.karaoke) return false;
  karaokePausedForVoice = true;
  try { karaokeRecognition.stop(); } catch {}
  return true;
}
function resumeKaraokeAfterVoice() {
  if (!state.karaoke || !karaokePausedForVoice) return;
  karaokePausedForVoice = false;
  setTimeout(() => { try { karaokeRecognition.start(); } catch {} }, 350);
}

// ─── Translation + romanization ──────────────────────────────────
// Translations are fetched once per (track, language) and cached; the
// romanization ("Sounds") is fetched lazily only when that mode needs it.
async function translateAndRender() {
  if (!state.lyrics) return;
  const lang = state.lang;
  const mode = state.translitMode;
  // "Original" selected. With Sounds/Both there's still something to do —
  // romanize the original into readable English letters (no translation target
  // needed). With Meaning there's nothing to translate, so show it as-is.
  if (lang === "none") {
    if (mode === "transliterate" || mode === "both") renderRomanizedOriginal();
    else renderLyrics();
    return;
  }

  const t = current();
  const key = `${t?.id}_${lang}`;
  const needRoman = (mode === "transliterate" || mode === "both");

  // Fast path — already cached.
  if (state.translationCache[key] && (!needRoman || state.romanCache[key])) {
    renderLyrics({ text: state.translationCache[key], roman: state.romanCache[key] || null });
    return;
  }

  $("#lyricsInner").innerHTML = `
    <div class="lyrics-loading">
      <div class="lyrics-spinner"></div>
      <span>Translating to ${LANGUAGES[lang] || lang}…</span>
    </div>`;

  const sources = state.lyrics.map(([, txt]) => txt);
  const stale = () => current()?.id !== t?.id || state.lang !== lang;
  const keepParens = (arr) => arr.map((v, i) => /^\(.*\)$/.test(sources[i]) ? sources[i] : v);

  try {
    let text = state.translationCache[key];
    if (!text) {
      text = keepParens(await translateText(sources, lang));
      if (stale()) return;
      state.translationCache[key] = text;
    }

    let roman = state.romanCache[key] || null;
    if (needRoman && !roman) {
      // "Sounds": transliterate the ORIGINAL lyrics into the chosen script so
      // they read in the target language but still sound like the original.
      roman = keepParens(await soundTranslate(sources, lang));
      if (stale()) return;
      state.romanCache[key] = roman;
    }

    renderLyrics({ text, roman });
    toast(`Translated to ${LANGUAGES[lang] || lang}`);
  } catch (e) {
    console.error(e);
    renderLyrics();
    toast("Translation failed — showing original");
  }
}

// Reflect the active language on the fancy Translate button.
function updateTranslateLabel() {
  const btn = $("#translateBtn");
  const lbl = $("#translateLabel");
  if (!btn || !lbl) return;
  if (state.lang === "none") {
    lbl.textContent = "Translate";
    btn.classList.remove("active");
  } else {
    lbl.textContent = (LANGUAGES[state.lang] || state.lang).replace(/\s*\(.*\)/, "");
    btn.classList.add("active");
  }
  refreshFavLangsUI();
  updateTranslatorInfo();
}

// Detect the script of the current lyrics → a friendly language name, so the
// menu can tell the listener what they're translating FROM. Returns null for
// Latin-script lyrics (we can't reliably name those, and they're usually English).
function detectOriginalLang(lines) {
  const text = lines.join(" ");
  const ranges = [
    [/[ఀ-౿]/, "Telugu"],   [/[ऀ-ॿ]/, "Hindi"],
    [/[஀-௿]/, "Tamil"],    [/[ಀ-೿]/, "Kannada"],
    [/[ഀ-ൿ]/, "Malayalam"],[/[਀-੿]/, "Punjabi"],
    [/[ঀ-৿]/, "Bengali"],  [/[઀-૿]/, "Gujarati"],
    [/[؀-ۿ]/, "Arabic"],   [/[가-힯]/, "Korean"],
    [/[Ѐ-ӿ]/, "Russian"],  [/[Ͱ-Ͽ]/, "Greek"],
    [/[֐-׿]/, "Hebrew"],   [/[一-鿿]/, "Chinese"],
  ];
  let best = null, bestCount = 0;
  for (const [re, name] of ranges) {
    const c = (text.match(new RegExp(re.source, "g")) || []).length;
    if (c > bestCount) { bestCount = c; best = name; }
  }
  if (/[぀-ヿ]/.test(text)) return "Japanese";   // kana ⇒ definitely Japanese
  return bestCount >= 2 ? best : null;
}

// Languages whose alphabet IS the Latin alphabet — Sounds stays in plain letters
// for these; for any other target the sound is written in that language's script.
const LATIN_LANGS = new Set(["en", "es", "fr", "de", "it", "pt", "nl", "sv", "pl", "cs", "ro", "tr", "id", "ms", "vi"]);

// One-line, plain-English explanation of what the current Language + mode show.
function modeHintText() {
  const { lang, translitMode: mode } = state;
  if (lang === "none") {
    return mode === "translate"
      ? "Pick a language above to see the meaning."
      : "The original lyrics in simple English letters.";
  }
  const name = (LANGUAGES[lang] || lang).replace(/\s*\(.*\)/, "");
  const latin = LATIN_LANGS.has(lang);
  if (mode === "translate") return `The meaning, in ${name}.`;
  if (mode === "transliterate") {
    return latin
      ? "How it's pronounced, in simple English letters."
      : `How it's pronounced, written in ${name} — same sound.`;
  }
  return latin
    ? `The meaning in ${name}, plus how it's pronounced.`
    : `The meaning in ${name}, plus the same sound written in ${name}.`;
}

// Refresh the detected-language banner + the mode explanation in the menu.
function updateTranslatorInfo() {
  const det = $("#lmDetected");
  if (det) {
    const name = state.lyrics ? detectOriginalLang(state.lyrics.map(l => l[1])) : null;
    if (name) { det.style.display = "flex"; det.innerHTML = `Original language: <b>${name}</b>`; }
    else det.style.display = "none";
  }
  const hint = $("#lmModeHint");
  if (hint) hint.textContent = modeHintText();
}

// "Sounds" with no translation target: romanize the ORIGINAL lyrics into plain
// English letters and render them. Cached per track so re-toggling is instant.
async function renderRomanizedOriginal() {
  const t = current();
  if (!t) return;
  const key = `${t.id}_roman_orig`;
  if (state.romanCache[key]) { renderLyrics({ roman: state.romanCache[key] }); return; }

  $("#lyricsInner").innerHTML = `
    <div class="lyrics-loading">
      <div class="lyrics-spinner"></div>
      <span>Reading the sounds…</span>
    </div>`;

  const sources = state.lyrics.map(([, txt]) => txt);
  const keepParens = (arr) => arr.map((v, i) => /^\(.*\)$/.test(sources[i]) ? sources[i] : v);
  try {
    const roman = keepParens(await soundTranslate(sources, "none"));
    if (current()?.id !== t.id || state.lang !== "none") return;   // user moved on
    state.romanCache[key] = roman;
    renderLyrics({ roman });
  } catch {
    renderLyrics();
  }
}

function buildLanguageSelector() {
  const sel = $("#langSelect");
  sel.innerHTML = "";
  for (const [code, name] of Object.entries(LANGUAGES)) {
    const o = document.createElement("option");
    o.value = code; o.textContent = name;
    sel.appendChild(o);
  }
  const c = document.createElement("option");
  c.value = "custom"; c.textContent = "✍️ Custom language...";
  sel.appendChild(c);

  // Mirror the language list into the Settings "default language" picker.
  const dsel = $("#setDefaultLang");
  if (dsel) {
    dsel.innerHTML = "";
    for (const [code, name] of Object.entries(LANGUAGES)) {
      const o = document.createElement("option");
      o.value = code; o.textContent = name;
      dsel.appendChild(o);
    }
    dsel.value = settings.defaultLang || "none";
  }

  // Settings "music languages" multi-select chips (Home-feed catalogs).
  renderSongLangChips();
}

// Render the Home-feed music-language toggle chips, reflecting the saved set.
function renderSongLangChips() {
  const box = $("#setSongLangChips");
  if (!box) return;
  const sel = new Set(musicLangCodes());
  box.innerHTML = "";
  for (const [code, cfg] of Object.entries(MUSIC_LANGS)) {
    const b = document.createElement("button");
    b.className = "lang-chip" + (sel.has(code) ? " on" : "");
    b.dataset.code = code;
    b.textContent = cfg.name;
    box.appendChild(b);
  }
}

// Short, compact name for a translation language (native script, no parens).
function shortLangName(code) {
  if (code === "none") return "Original";
  return (LANGUAGES[code] || code).replace(/\s*\(.*\)/, "");
}

// Render the Now-Playing "quick languages" chips + the save-star state.
function refreshFavLangsUI() {
  const box = $("#langFavChips");
  if (box) {
    const favs = settings.favLangs || [];
    box.innerHTML = "";
    box.style.display = favs.length ? "flex" : "none";
    for (const code of favs) {
      const chip = document.createElement("button");
      chip.className = "lm-fav-chip" + (code === state.lang ? " on" : "");
      chip.dataset.code = code;
      chip.textContent = shortLangName(code);
      box.appendChild(chip);
    }
  }
  const star = $("#langFavToggle");
  if (star) star.classList.toggle("on", (settings.favLangs || []).includes(state.lang));
}

// Apply the persisted lyrics/translation defaults to live state + the
// Now-Playing controls, so a returning listener picks up where they left off.
function applyContentDefaults() {
  state.translitMode = settings.transMode || "translate";
  $$(".lm-mode-btn").forEach(x => x.classList.toggle("active", x.dataset.mode === state.translitMode));
  state.dualLang = settings.dualLang !== false;
  const dl = $("#dualLangBtn"); if (dl) dl.checked = state.dualLang;
  state.lang = settings.defaultLang || "none";
  const sel = $("#langSelect"); if (sel) sel.value = state.lang;
  updateTranslateLabel();
}

// ─── Visualizer ──────────────────────────────────────────────────
function buildVisualizerBars() {
  const v = $("#visualizer");
  v.innerHTML = "";
  for (let i = 0; i < 14; i++) {
    const b = document.createElement("div");
    b.className = "vis-bar";
    v.appendChild(b);
  }
}
let visId = null;
function startVisualizer() {
  if (visId) return;
  const bars = $("#visualizer").querySelectorAll(".vis-bar");
  (function draw() {
    visId = requestAnimationFrame(draw);
    bars.forEach(b => { b.style.height = `${4 + Math.random() * 30}px`; });
  })();
}
function stopVisualizer() {
  if (visId) { cancelAnimationFrame(visId); visId = null; }
  $("#visualizer").querySelectorAll(".vis-bar").forEach(b => b.style.height = "4px");
}

// ─── Voice assistant (Web Speech API) ────────────────────────────
// A hands-free controller: a mic button (or the "V" key) starts speech
// recognition, the transcript is parsed for a command, and the matching
// existing action runs. No external service — uses the browser's built-in
// SpeechRecognition (Chrome/Edge).
let recognition = null;
let voiceActive = false;
let voiceLangMap = null;

// Build a spoken-name → ISO-code map for "translate to <language>".
function buildVoiceLangMap() {
  const map = {};
  for (const [code, name] of Object.entries(LANGUAGES)) {
    if (code === "none") continue;
    const clean = name.replace(/\s*\(.*\)/, "").trim().toLowerCase();
    if (clean) map[clean] = code;
  }
  // Common names + aliases the recognizer is likely to return.
  Object.assign(map, {
    spanish:"es", french:"fr", german:"de", italian:"it", portuguese:"pt",
    japanese:"ja", korean:"ko", chinese:"zh", mandarin:"zh", russian:"ru",
    arabic:"ar", hindi:"hi", telugu:"te", tamil:"ta", kannada:"kn",
    bengali:"bn", marathi:"mr", gujarati:"gu", punjabi:"pa", urdu:"ur",
    turkish:"tr", polish:"pl", dutch:"nl", swedish:"sv", thai:"th",
    vietnamese:"vi", indonesian:"id", greek:"el", czech:"cs", hebrew:"he",
    malay:"ms", romanian:"ro", persian:"fa", farsi:"fa", ukrainian:"uk",
  });
  return map;
}

// Switch translation language from a voice command, keeping the dropdown in sync.
function applyLanguage(code, label) {
  state.lang = code;
  const sel = $("#langSelect");
  if (sel) {
    if (code !== "none" && ![...sel.options].some(o => o.value === code)) {
      const opt = document.createElement("option");
      opt.value = code; opt.textContent = label || code;
      sel.insertBefore(opt, sel.lastElementChild);
    }
    sel.value = code;
  }
  updateTranslateLabel();
  translateAndRender();
}

async function voicePlay(query) {
  toast(`Searching “${query}”…`);
  try {
    const { tracks } = await itunes.smartSearch(query, 10);
    if (tracks.length) { playFromList(tracks, 0); toast(`Playing “${tracks[0].name}”`); }
    else toast(`No match for “${query}”`);
  } catch { toast("Search failed"); }
}

// Normalize a spoken phrase: strip wake words, politeness and lead-ins so the
// intent patterns below see the bare command ("hey lyrica, could you please
// play despacito" → "play despacito").
function normalizeVoice(raw) {
  let t = (raw || "").toLowerCase().trim();
  t = t.replace(/[.,!?;]+/g, " ");
  t = t.replace(/^(hey|ok|okay|hi|hello|yo)\s+(lyrica|lyrics?|assistant|google)\b/g, " ");
  t = t.replace(/\b(lyrica|assistant)\b/g, " ");
  // Drop leading politeness / lead-ins.
  t = t.replace(/^\s*(please|can you|could you|would you|will you|can we|let'?s|lets|i want to|i wanna|i would like to|i'd like to|i need you to|go ahead and|just|now|hey)\s+/g, " ");
  // Drop trailing politeness.
  t = t.replace(/\b(please|for me|right now|thanks|thank you)\b/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

// Map a recognised phrase to an action; returns a short confirmation (or null
// if nothing matched, so the caller can try another recognition hypothesis).
function handleVoiceCommand(raw) {
  const text = normalizeVoice(raw);
  if (!text) return null;
  voiceLangMap = voiceLangMap || buildVoiceLangMap();
  let m;

  // ── Translation ───────────────────────────────────────────────
  m = text.match(/(?:translate|translation|convert|change|lyrics?)\b.*?\b(?:in ?to|into|to|in)\s+([a-z ]+)/);
  if (m) {
    const name = m[1].trim().replace(/\b(language|please|for me)\b/g, "").trim();
    const code = voiceLangMap[name];
    if (code) { applyLanguage(code, name); return `Translating to ${name}`; }
    return `I don't know the language "${name}"`;
  }
  if (/\b(stop translating|turn off translation|show original|no translation|original lyrics|back to english)\b/.test(text)) {
    applyLanguage("none"); return "Showing original lyrics";
  }

  // ── Queue (before bare "play"/"next"/"queue") ─────────────────
  if (/\b(play|queue)( this| it| that)? next\b/.test(text) || /\bplay next\b/.test(text)) {
    const t = current();
    return t ? playNext(t) : "Nothing is playing";
  }
  if (/\b(add|put)\b.*\bqueue\b|\bqueue (this|it|that|the song|this song|up)\b|\badd to queue\b/.test(text)) {
    const t = current();
    return t ? addToQueue(t) : "Nothing is playing";
  }

  // ── Play / search a song ──────────────────────────────────────
  // "play / put on / start / turn on / listen to / play some <song>"
  m = text.match(/^(?:play|put on|start playing|start|turn on|listen to|play some|play me|i want to listen to|i wanna hear|play the song)\s+(.+)/);
  if (m) {
    let q = m[1].replace(/\b(song|track|please|on (spotify|youtube))\b/g, "")
                .replace(/\s+/g, " ").trim();
    if (q && !/^(it|this|that|music|something|a song)$/.test(q)) {
      voicePlay(q);
      return `Searching for ${q}`;
    }
    pb.play(); return "Playing";
  }

  // ── Transport ─────────────────────────────────────────────────
  if (/\b(pause|hold on|wait|stop( playing| the music| the song)?|shut up)\b/.test(text) && !/\bdon'?t\b/.test(text)) {
    if (!pb.isPaused()) pb.pause(); return "Paused";
  }
  if (/\b(resume|unpause|continue|keep playing|play it|play again|carry on|go on)\b/.test(text) || text === "play") {
    pb.play(); return "Playing";
  }
  if (/\b(next|skip|forward|fast ?forward|next (one|song|track)|change (the )?song)\b/.test(text)) {
    nextTrack(); return "Playing the next track";
  }
  if (/\b(previous|prev|go back|last (one|song|track)|rewind|back a song|play the last)\b/.test(text)) {
    prevTrack(); return "Going back a track";
  }
  if (/\b(restart|start over|from the beginning|replay this)\b/.test(text)) {
    pb.seekTo(0); pb.play(); return "Starting over";
  }

  // ── Likes ─────────────────────────────────────────────────────
  if (/\b(unlike|dislike|remove (this |it |from )*(likes?|liked|favou?rites?))\b/.test(text)) {
    const t = current();
    if (t && state.liked.has(t.id)) { toggleLike(t); return "Removed from your liked songs"; }
    return "It's not in your liked songs";
  }
  if (/\b(like|love|favou?rite|add (this|it) to (likes|liked|favou?rites)|heart this)\b/.test(text)) {
    const t = current();
    if (!t) return "Nothing is playing";
    if (!state.liked.has(t.id)) { toggleLike(t); return "Added to your liked songs"; }
    return "It's already liked";
  }

  // ── Volume ────────────────────────────────────────────────────
  if (/\bunmute\b/.test(text)) { if (state.muted) toggleMute(); return "Unmuted"; }
  if (/\b(mute|silence)\b/.test(text)) { if (!state.muted) toggleMute(); return "Muted"; }
  if (/\b(max|full|maximum|hundred percent)\b.*\bvolume\b|\bvolume\b.*\b(max|full|maximum|all the way)\b|\bblast it\b/.test(text)) { setVolume(1); return "Volume maxed"; }
  m = text.match(/volume (?:to |at )?(\d{1,3})/);
  if (m) { const v = Math.min(100, +m[1]); setVolume(v / 100); return `Volume ${v} percent`; }
  if (/\b(volume up|louder|turn it up|crank it|raise the volume|increase volume|pump it up)\b/.test(text)) { setVolume(state.volume + 0.15); return "Turning it up"; }
  if (/\b(volume down|quieter|turn it down|lower the volume|decrease volume|softer)\b/.test(text)) { setVolume(state.volume - 0.15); return "Turning it down"; }

  // ── Shuffle / repeat ──────────────────────────────────────────
  if (/\b(smart )?mix( my likes| my liked)?\b/.test(text) && !/\bmix it up\b/.test(text)) { startSmartMix(); return "Starting your Smart Mix"; }
  if (/\bshuffle\b|\brandom\b|\bmix it up\b/.test(text)) { toggleShuffle(); return state.shuffle ? "Smart shuffle on" : "Shuffle off"; }
  if (/\brepeat\b|\bloop\b/.test(text)) { $("#btnRepeat").click(); return ["Repeat off", "Repeating all", "Repeating this song"][state.repeat]; }

  // ── Sleep timer ───────────────────────────────────────────────
  m = text.match(/\b(?:sleep timer|sleep|stop playing).*?(\d{1,3})\s*(?:min|minute)/);
  if (m) { setSleepTimer(String(Math.min(180, +m[1]))); return `Sleep timer set for ${m[1]} minutes`; }
  if (/\bsleep timer\b.*\b(off|cancel|stop)\b|\bcancel (the )?(sleep )?timer\b/.test(text)) { setSleepTimer("off"); return "Sleep timer off"; }

  // ── What's playing? ───────────────────────────────────────────
  if (/\b(what('?s| is) (this|playing|the song)|name of (this|the) song|what song)\b/.test(text)) {
    const t = current();
    return t ? `This is ${t.name} by ${t.artists.map(a => a.name).join(", ")}` : "Nothing is playing right now";
  }

  // ── Navigation ────────────────────────────────────────────────
  m = text.match(/^(?:search|find|look for|look up)\s+(?:for\s+)?(.+)/);
  if (m) { const q = m[1].trim(); navigate("search"); $("#globalSearch").value = q; runSmartSearch(q); return `Searching for ${q}`; }
  if (/\b(recently played|recent|history)\b/.test(text)) { navigate("home"); return "Here's what you played recently"; }
  if (/\b(show |open )?lyrics\b|\bnow playing\b/.test(text)) { navigate("nowplaying"); return "Now playing"; }
  if (/\b(library|liked songs|my songs|favou?rites)\b/.test(text)) { navigate("library"); return "Opening your library"; }
  if (/\b(open |show )?queue\b|\bup next\b/.test(text)) { navigate("queue"); return "Here's the queue"; }
  if (/\b(go )?home\b|\bmain page\b/.test(text)) { navigate("home"); return "Home"; }

  // ── Fullscreen / copy ─────────────────────────────────────────
  if (/\bfull ?screen\b/.test(text)) { toggleLyricsFullscreen(); return "Fullscreen lyrics"; }

  return null;   // unrecognised — caller may try another hypothesis
}

function setVoiceUI({ status, heard, active } = {}) {
  if (status != null) $("#voiceStatus").textContent = status;
  if (heard != null) $("#voiceHeard").textContent = heard ? `“${heard}”` : "";
  if (active != null) $("#voicePanel").classList.toggle("active", active);
}

// Speak a confirmation aloud (Google-Assistant style), briefly ducking the
// music so the reply is audible. Controlled by the "Spoken replies" setting.
let voiceDuckRestore = null;
function spokenize(s) {
  return String(s || "").replace(/[“”"♥✓•·…]/g, "").replace(/\s+/g, " ").trim();
}
function speak(text) {
  if (!settings.voiceFeedback) return;
  if (!("speechSynthesis" in window) || !text) return;
  const clean = spokenize(text);
  if (!clean) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "en-US"; u.rate = 1.05; u.pitch = 1; u.volume = 1;
    // Duck the music while the assistant talks, then restore.
    if (!state.muted && voiceDuckRestore == null && !pb.isPaused()) {
      voiceDuckRestore = state.volume;
      pb.setVolume(Math.max(0.12, state.volume * 0.25));
    }
    const restore = () => {
      if (voiceDuckRestore != null) { pb.setVolume(state.muted ? 0 : voiceDuckRestore); voiceDuckRestore = null; }
    };
    u.onend = restore; u.onerror = restore;
    speechSynthesis.speak(u);
    // Safety: restore even if onend never fires.
    setTimeout(restore, 4000);
  } catch { /* TTS unavailable */ }
}

// Phrases that turn the assistant off (rather than controlling playback).
const VOICE_OFF_RE = /\b(stop listening|stop the assistant|that'?s all|never ?mind|dismiss|go to sleep|goodbye|bye)\b/;

function initVoice() {
  const fab = $("#voiceFab");
  const panel = $("#voicePanel");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SR) {
    fab.classList.add("unsupported");
    fab.addEventListener("click", () =>
      toast("Voice control needs Chrome or Edge (and a microphone)."));
    return;
  }

  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  // One command per tap. continuous:false lets the browser detect end-of-speech
  // itself and fire a final result — no restart/idle juggling, far more reliable.
  recognition.continuous = false;
  // Ask for several hypotheses: if the top guess is misheard, a lower-ranked
  // alternative often matches a real command — big accuracy win.
  recognition.maxAlternatives = 5;

  let gotFinal = false;
  let closeTimer = null;

  function closeSoon() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!voiceActive) panel.classList.remove("open"); }, 2800);
  }

  recognition.addEventListener("result", (e) => {
    let interim = "";
    let alts = null;
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        alts = [];
        for (let k = 0; k < r.length; k++) {
          const tx = r[k].transcript.trim();
          if (tx) alts.push(tx);
        }
      } else {
        interim += r[0].transcript;
      }
    }
    if (interim) setVoiceUI({ status: "Listening…", heard: interim });
    if (!alts || !alts.length) return;

    gotFinal = true;

    // "Stop listening" on any hypothesis.
    if (alts.some(a => VOICE_OFF_RE.test(a.toLowerCase()))) {
      setVoiceUI({ heard: alts[0], status: "Okay 👋" }); speak("Okay");
      return;
    }

    // Try each hypothesis (best-ranked first); use the first that maps to a
    // command, so a misheard top guess doesn't sink a valid command.
    let chosen = alts[0], reply = null;
    for (const alt of alts) {
      const r = handleVoiceCommand(alt);
      if (r) { chosen = alt; reply = r; break; }
    }

    setVoiceUI({ heard: chosen });
    if (reply) { setVoiceUI({ status: "✓ " + reply }); toast(`🎙 ${reply}`); speak(reply); }
    else {
      setVoiceUI({ status: `Sorry, I didn't get that — try again` });
      speak("Sorry, I didn't get that");
    }
  });

  recognition.addEventListener("end", () => {
    voiceActive = false;
    fab.classList.remove("listening");
    setVoiceUI({ active: false });
    if (!gotFinal) setVoiceUI({ status: "Didn't hear anything — tap and speak" });
    closeSoon();
    resumeKaraokeAfterVoice();   // hand the mic back to karaoke if it was running
  });

  recognition.addEventListener("error", (e) => {
    voiceActive = false;
    fab.classList.remove("listening");
    if (e.error === "aborted") return;     // we stopped it ourselves
    const msg =
      (e.error === "not-allowed" || e.error === "service-not-allowed")
        ? "Mic blocked — click the lock icon in the address bar, allow Microphone, then retry"
      : e.error === "no-speech"     ? "Didn't catch that — tap and speak"
      : e.error === "audio-capture" ? "No microphone detected"
      : e.error === "network"       ? "Voice needs internet — check your connection"
      :                               `Voice error: ${e.error}`;
    setVoiceUI({ active: false, status: msg });
    closeSoon();
  });

  function startVoice() {
    if (voiceActive) { try { recognition.stop(); } catch {} return; }   // tap again = stop
    pauseKaraokeForVoice();   // only one mic consumer at a time
    gotFinal = false;
    voiceActive = true;
    clearTimeout(closeTimer);
    fab.classList.add("listening");
    panel.classList.add("open");
    setVoiceUI({ status: "Listening… speak now", heard: "", active: true });
    try {
      recognition.start();
    } catch {
      // start() throws if a previous session is still closing — retry once.
      setTimeout(() => { try { recognition.start(); } catch {} }, 300);
    }
  }

  fab.addEventListener("click", startVoice);

  // "V" anywhere outside a text field starts listening.
  document.addEventListener("keydown", (e) => {
    if (e.code === "KeyV" && !["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) {
      e.preventDefault();
      startVoice();
    }
  });
}

// ─── Settings ────────────────────────────────────────────────────
// Persisted appearance/behaviour prefs. Applied to <html>/<body> so all the
// themeable CSS (accent presets, lyric size, visualizer) updates instantly.
const SETTINGS_KEY = "lyrica_settings_v1";
const DEFAULT_SETTINGS = {
  theme: "aurora", lyricSize: "m", visualizer: true, reduceMotion: false, voiceFeedback: true,
  defaultLang: "none", transMode: "translate", dualLang: true, autoplay: false,
  songLangs: ["en"],   // Home-feed music languages (popular songs from each are blended)
  favLangs: [],        // saved quick-access translation languages (Now-Playing chips)
};

// Which regional catalogs the Home feed should blend.
function musicLangCodes() {
  return (settings.songLangs && settings.songLangs.length) ? settings.songLangs : ["en"];
}
function musicLangs() {
  return musicLangCodes().map(c => MUSIC_LANGS[c] || MUSIC_LANGS.en);
}
const LYRIC_SIZES = { s: "16px", m: "19px", l: "23px" };

let settings = loadSettings();
function loadSettings() {
  let s;
  try { s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { s = { ...DEFAULT_SETTINGS }; }
  // Migrate the old single `songLang` to the `songLangs` list; ensure arrays exist.
  if (!Array.isArray(s.songLangs)) s.songLangs = s.songLang ? [s.songLang] : ["en"];
  if (!s.songLangs.length) s.songLangs = ["en"];
  if (!Array.isArray(s.favLangs)) s.favLangs = [];
  delete s.songLang;
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
function applySettings() {
  document.documentElement.setAttribute("data-theme", settings.theme);
  document.documentElement.style.setProperty("--lyric-size", LYRIC_SIZES[settings.lyricSize] || LYRIC_SIZES.m);
  document.body.classList.toggle("no-visualizer", !settings.visualizer);
  document.body.classList.toggle("reduce-motion", !!settings.reduceMotion);
}

function syncSettingsUI() {
  $$("#themeSwatches .swatch").forEach(s => s.classList.toggle("on", s.dataset.theme === settings.theme));
  $$("#lyricSizeSeg button").forEach(b => b.classList.toggle("on", b.dataset.size === settings.lyricSize));
  $("#setVisualizer").checked = settings.visualizer;
  $("#setReduceMotion").checked = settings.reduceMotion;
  const vf = $("#setVoiceFeedback");
  if (vf) vf.checked = settings.voiceFeedback;
  renderSongLangChips();
  const dlang = $("#setDefaultLang"); if (dlang) dlang.value = settings.defaultLang || "none";
  $$("#setTransModeSeg button").forEach(b => b.classList.toggle("on", b.dataset.mode === (settings.transMode || "translate")));
  const sdl = $("#setDualLang"); if (sdl) sdl.checked = settings.dualLang !== false;
  const sap = $("#setAutoplay"); if (sap) sap.checked = !!settings.autoplay;
}

function openSettings() { syncSettingsUI(); $("#settingsOverlay").classList.add("open"); }
function closeSettings() { $("#settingsOverlay").classList.remove("open"); }

function initSettings() {
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsOverlay").addEventListener("click", (e) => {
    if (e.target === $("#settingsOverlay")) closeSettings();
  });

  // Listening-stats overlay shares the same close affordances.
  $("#statsClose").addEventListener("click", closeStats);
  $("#statsOverlay").addEventListener("click", (e) => {
    if (e.target === $("#statsOverlay")) closeStats();
  });

  // Edit-profile overlay.
  $("#profileEditClose")?.addEventListener("click", closeProfileEdit);
  $("#peCancel")?.addEventListener("click", closeProfileEdit);
  $("#peSave")?.addEventListener("click", commitProfileEdit);
  $("#profileEditOverlay")?.addEventListener("click", (e) => {
    if (e.target === $("#profileEditOverlay")) closeProfileEdit();
  });
  $("#peAvatar")?.addEventListener("input", (e) => {
    $("#peAvatarPreview").src = e.target.value.trim() || DEFAULT_PROFILE.avatar;
  });
  $("#peName")?.addEventListener("keydown", (e) => { if (e.key === "Enter") commitProfileEdit(); });

  $$("#themeSwatches .swatch").forEach(s => s.addEventListener("click", () => {
    settings.theme = s.dataset.theme; saveSettings(); applySettings(); syncSettingsUI();
  }));
  $$("#lyricSizeSeg button").forEach(b => b.addEventListener("click", () => {
    settings.lyricSize = b.dataset.size; saveSettings(); applySettings(); syncSettingsUI();
  }));
  $("#setVisualizer").addEventListener("change", (e) => {
    settings.visualizer = e.target.checked; saveSettings(); applySettings();
  });
  $("#setReduceMotion").addEventListener("change", (e) => {
    settings.reduceMotion = e.target.checked; saveSettings(); applySettings();
  });
  $("#setVoiceFeedback")?.addEventListener("change", (e) => {
    settings.voiceFeedback = e.target.checked; saveSettings();
    if (e.target.checked) speak("Voice replies on");
  });

  // Music languages — multi-select chips; the Home feed blends all chosen ones.
  $("#setSongLangChips")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".lang-chip");
    if (!chip) return;
    const code = chip.dataset.code;
    const sel = new Set(musicLangCodes());
    if (sel.has(code)) {
      if (sel.size === 1) { toast("Keep at least one music language"); return; }
      sel.delete(code);
    } else {
      sel.add(code);
    }
    settings.songLangs = [...sel];
    saveSettings();
    renderSongLangChips();
    if (state.view === "home") renderHome();
  });

  // Default lyrics language — applies live and keeps the Now-Playing picker in sync.
  $("#setDefaultLang")?.addEventListener("change", (e) => {
    settings.defaultLang = e.target.value; saveSettings();
    applyLanguage(settings.defaultLang);
  });

  // Default translation view (Translate / Sounds / Both).
  $$("#setTransModeSeg button").forEach(b => b.addEventListener("click", () => {
    settings.transMode = b.dataset.mode; saveSettings();
    state.translitMode = b.dataset.mode;
    $$("#setTransModeSeg button").forEach(x => x.classList.toggle("on", x === b));
    $$(".lm-mode-btn").forEach(x => x.classList.toggle("active", x.dataset.mode === b.dataset.mode));
    updateTranslateLabel();
    translateAndRender();   // handles "Original" (incl. Sounds) internally
  }));

  // Show original + translation (dual language).
  $("#setDualLang")?.addEventListener("change", (e) => {
    settings.dualLang = e.target.checked; saveSettings();
    state.dualLang = e.target.checked;
    const dl = $("#dualLangBtn"); if (dl) dl.checked = e.target.checked;
    translateAndRender();   // handles "Original" (incl. Sounds) internally
  });

  // Autoplay similar songs when the queue ends.
  $("#setAutoplay")?.addEventListener("change", (e) => {
    settings.autoplay = e.target.checked; saveSettings();
  });

  // Restore from backup (merge a previously exported JSON file).
  $("#setImportBtn")?.addEventListener("click", () => $("#setImportFile").click());
  $("#setImportFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importBackup(file);
    e.target.value = "";   // allow re-importing the same file later
  });

  $("#clearDataBtn").addEventListener("click", () => {
    if (!confirm("Clear all liked songs, playlists, and recently played? This can't be undone.")) return;
    state.liked.clear();
    state.playlists = [];
    state.recent = [];
    try {
      localStorage.removeItem("lyrica_liked_v2");
      localStorage.removeItem(PLAYLIST_KEY);
      localStorage.removeItem(RECENT_KEY);
    } catch {}
    updateSidebarCount();
    renderSidebarPlaylists();
    renderRecent();
    if (state.view === "library") renderLibrary();
    if (state.view === "playlist") navigate("home");
    toast("All your data was cleared");
    closeSettings();
  });

  // Escape closes settings.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSettings(); closeStats(); closeProfileEdit(); }
  });
}

// ─── Lyrics tools (copy / export / fullscreen) ───────────────────
function copyLyrics() {
  if (!state.lyrics?.length) { toast("No lyrics to copy"); return; }
  const t = current();
  const header = t ? `${t.name} — ${t.artists.map(a => a.name).join(", ")}\n\n` : "";
  const body = state.lyrics.map(([, l]) => l).join("\n");
  const write = navigator.clipboard?.writeText?.(header + body);
  if (write) write.then(() => toast("Lyrics copied ✓"), () => toast("Couldn't copy lyrics"));
  else toast("Clipboard unavailable");
}

function lrcStamp(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = (sec % 60);
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function downloadLrc() {
  if (!state.lyrics?.length) { toast("No lyrics to export"); return; }
  const t = current();
  const out = [];
  if (t) {
    out.push(`[ti:${t.name}]`);
    out.push(`[ar:${t.artists.map(a => a.name).join(", ")}]`);
    if (t.album?.name) out.push(`[al:${t.album.name}]`);
    out.push("[by:Lyrica]");
  }
  for (const [time, text] of state.lyrics) {
    out.push(state.lyricsSynced ? `[${lrcStamp(time)}]${text}` : text);
  }
  const blob = new Blob([out.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safe = (t ? `${t.artists[0]?.name || ""} - ${t.name}` : "lyrics")
    .replace(/[\\/:*?"<>|]/g, "_").trim();
  const a = document.createElement("a");
  a.href = url; a.download = `${safe || "lyrics"}.lrc`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Downloaded .lrc ✓");
}

function toggleLyricsFullscreen() {
  const el = $(".np-right");
  if (!el) return;
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  if (state.view !== "nowplaying") navigate("nowplaying");
  const req = el.requestFullscreen?.bind(el) || el.webkitRequestFullscreen?.bind(el);
  if (req) Promise.resolve(req()).catch(() => toast("Fullscreen unavailable"));
  else toast("Fullscreen unavailable");
}

function handleLyricsTool(tool) {
  if (tool === "copy") copyLyrics();
  else if (tool === "lrc") downloadLrc();
  else if (tool === "fullscreen") toggleLyricsFullscreen();
}

// ─── Sleep timer ─────────────────────────────────────────────────
// Transient (resets on reload). "endoftrack" lets the current song finish.
let sleepTimerId = null;
let sleepAtEndOfTrack = false;
let sleepDeadline = 0;

function clearSleep() {
  if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
  sleepAtEndOfTrack = false;
  sleepDeadline = 0;
  sleepActiveMins = 0;
}

function setSleepTimer(value) {
  clearSleep();
  if (value === "off") { updateSleepUI(); toast("Sleep timer off"); return; }
  if (value === "endoftrack") { sleepAtEndOfTrack = true; updateSleepUI(); toast("Will stop at end of track 😴"); return; }
  const mins = parseInt(value, 10);
  if (!mins) { updateSleepUI(); return; }
  sleepActiveMins = mins;
  sleepDeadline = Date.now() + mins * 60000;
  sleepTimerId = setTimeout(() => {
    sleepTimerId = null; sleepDeadline = 0;
    pb.pause();
    updateSleepUI();
    toast("Sleep timer — paused playback 😴");
  }, mins * 60000);
  updateSleepUI();
  toast(`Sleep timer set for ${mins} min`);
}

// Reflect the active timer on the player-bar moon button + popover options.
function updateSleepUI() {
  const btn = $("#btnSleep");
  if (btn) btn.classList.toggle("active", !!sleepTimerId || sleepAtEndOfTrack);
  const cur = sleepAtEndOfTrack ? "endoftrack" : (sleepTimerId ? String(sleepActiveMins) : "off");
  $$("#sleepMenu .sleep-opt").forEach(b => b.classList.toggle("on", b.dataset.sleep === cur));
}
let sleepActiveMins = 0;

// ─── Profile menu (top-right) ────────────────────────────────────
// ─── User profile (editable) ─────────────────────────────────────
const PROFILE_KEY = "lyrica_profile_v1";
const DEFAULT_PROFILE = {
  name: "Srinivas R.",
  email: "srinivas@lyrica.app",
  avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=160&q=80&auto=format&fit=crop",
};
let profile = loadProfile();
function loadProfile() {
  try { return { ...DEFAULT_PROFILE, ...JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") }; }
  catch { return { ...DEFAULT_PROFILE }; }
}
function saveProfile() { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {} }

// Reflect the profile everywhere it shows (header pill + dropdown).
function applyProfile() {
  const name = profile.name || "You";
  const av = profile.avatar || DEFAULT_PROFILE.avatar;
  const set = (sel, prop, val) => { const el = $(sel); if (el) el[prop] = val; };
  set("#userName", "textContent", name);
  set("#pmName", "textContent", name);
  set("#pmEmail", "textContent", profile.email || "");
  set("#headerAvatar", "src", av);
  set("#pmAvatar", "src", av);
}

function openProfileEdit() {
  $("#peName").value = profile.name || "";
  $("#peEmail").value = profile.email || "";
  $("#peAvatar").value = profile.avatar || "";
  $("#peAvatarPreview").src = profile.avatar || DEFAULT_PROFILE.avatar;
  $("#profileEditOverlay").classList.add("open");
  setTimeout(() => $("#peName").focus(), 50);
}
function closeProfileEdit() { $("#profileEditOverlay").classList.remove("open"); }
function commitProfileEdit() {
  const name = $("#peName").value.trim();
  if (!name) { toast("Enter a display name"); return; }
  profile = {
    name,
    email: $("#peEmail").value.trim(),
    avatar: $("#peAvatar").value.trim() || DEFAULT_PROFILE.avatar,
  };
  saveProfile();
  applyProfile();
  closeProfileEdit();
  toast("Profile updated ✓");
}

function initProfileMenu() {
  const btn = $("#profileBtn");
  const menu = $("#profileMenu");
  if (!btn || !menu) return;

  applyProfile();

  const setOpen = (open) => {
    menu.classList.toggle("open", open);
    btn.classList.toggle("open", open);
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });

  menu.querySelectorAll(".pm-item").forEach(item => {
    item.addEventListener("click", () => {
      setOpen(false);
      handleProfileAction(item.dataset.pm);
    });
  });
}

function handleProfileAction(action) {
  switch (action) {
    case "library":  navigate("library"); break;
    case "recent":   navigate("home"); break;
    case "queue":    navigate("queue"); break;
    case "create":   openModal("create"); break;
    case "editprofile": openProfileEdit(); break;
    case "smartmix": startSmartMix(); break;
    case "stats":    openStats(); break;
    case "sleep":    $("#btnSleep").click(); break;
    case "settings": openSettings(); break;
    case "voice":    $("#voiceFab").click(); break;
    case "export":   exportBackup(); break;
    case "about":    toast("Lyrica · music with live-translated lyrics ✨"); break;
  }
}

// ─── Smart Mix ───────────────────────────────────────────────────
// One tap: build a queue from the listener's liked songs (falling back to
// recently played), turn on smart shuffle, and start playing.
function startSmartMix() {
  const pool = state.liked.size ? [...state.liked.values()] : state.recent.slice();
  if (!pool.length) { toast("Like a few songs first to build a Smart Mix"); return; }
  state.queue = pool.slice();
  state.shuffle = true;
  $("#btnShuffle").classList.add("active");
  buildShuffleOrder(Math.floor(Math.random() * pool.length));
  state.currentIndex = state.shuffleOrder[0];
  navigate("nowplaying");
  loadTrack(true);
  toast(`Smart Mix · ${pool.length} song${pool.length === 1 ? "" : "s"} 🎲`);
}

// ─── Listening stats ─────────────────────────────────────────────
function openStats() { renderStats(); $("#statsOverlay").classList.add("open"); }
function closeStats() { $("#statsOverlay").classList.remove("open"); }

function renderStats() {
  const body = $("#statsBody");
  if (!body) return;

  const liked = [...state.liked.values()];
  const pool = liked.concat(state.recent);

  // Top artists / genres tallied across liked + recently played.
  const tally = (keyFn) => {
    const m = new Map();
    for (const t of pool) {
      const k = keyFn(t);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  };
  const topArtists = tally(t => t?.artists?.[0]?.name);
  const topGenres = tally(t => t?.genre);

  const stat = (num, label) => `<div class="stat-card"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
  const list = (title, rows) => {
    if (!rows.length) return `<div class="stat-list"><div class="stat-list-title">${title}</div><div class="stat-empty">Nothing yet — play some music.</div></div>`;
    const items = rows.map(([name, n], i) =>
      `<div class="stat-row"><span class="stat-rank">${i + 1}</span><span class="stat-row-name">${escapeHtml(name)}</span><span class="stat-row-count">${n} song${n === 1 ? "" : "s"}</span></div>`
    ).join("");
    return `<div class="stat-list"><div class="stat-list-title">${title}</div>${items}</div>`;
  };

  body.innerHTML = `
    <div class="stat-grid">
      ${stat(state.liked.size, "Liked songs")}
      ${stat(state.playlists.length, "Playlists")}
      ${stat(state.recent.length, "Recently played")}
      ${stat(topArtists.length, "Artists explored")}
    </div>
    ${list("Top artists", topArtists)}
    ${list("Top genres", topGenres)}`;
}

// ─── Export backup ───────────────────────────────────────────────
// Download the listener's library (liked songs, playlists, recents) as a
// JSON file so it survives a cleared browser / moves to another device.
function exportBackup() {
  const data = {
    app: "Lyrica",
    version: 1,
    exportedAt: new Date().toISOString(),
    liked: [...state.liked.values()],
    playlists: state.playlists,
    recent: state.recent,
    searches: state.searches,
  };
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `lyrica-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${state.liked.size} liked · ${state.playlists.length} playlists`);
  } catch {
    toast("Couldn't export backup");
  }
}

// Merge a previously-exported backup into the current library (never destructive:
// only adds liked songs / playlists / history that aren't already present).
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { toast("That file isn't valid JSON"); return; }
    if (!data || (data.app && data.app !== "Lyrica")) { toast("That's not a Lyrica backup"); return; }

    let addedLikes = 0, addedPlaylists = 0;

    if (Array.isArray(data.liked)) {
      for (const t of data.liked) if (t?.id && !state.liked.has(t.id)) { state.liked.set(t.id, t); addedLikes++; }
      localStorage.setItem("lyrica_liked_v2", JSON.stringify([...state.liked]));
    }
    if (Array.isArray(data.playlists)) {
      const ids = new Set(state.playlists.map(p => p.id));
      for (const p of data.playlists) if (p?.id && !ids.has(p.id)) { state.playlists.push(p); ids.add(p.id); addedPlaylists++; }
      savePlaylists();
    }
    if (Array.isArray(data.recent)) {
      const have = new Set(state.recent.map(t => t.id));
      for (const t of data.recent) if (t?.id && !have.has(t.id)) { state.recent.push(t); have.add(t.id); }
      if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
      saveRecent();
    }
    if (Array.isArray(data.searches)) {
      for (const s of data.searches) {
        const lc = String(s).toLowerCase();
        if (!state.searches.some(x => x.toLowerCase() === lc)) state.searches.push(String(s));
      }
      state.searches = state.searches.slice(0, SEARCH_MAX);
      try { localStorage.setItem(SEARCH_KEY, JSON.stringify(state.searches)); } catch {}
    }

    updateSidebarCount();
    renderSidebarPlaylists();
    renderRecent();
    if (state.view === "library") renderLibrary();
    toast(`Restored ${addedLikes} liked · ${addedPlaylists} playlists`);
  };
  reader.onerror = () => toast("Couldn't read that file");
  reader.readAsText(file);
}

// ─── Toast ───────────────────────────────────────────────────────
let toastTimer;
function toast(msg, ms = 2800) {
  $("#toastMsg").textContent = msg;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), ms);
}

// ─── Helpers ─────────────────────────────────────────────────────
function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function pctFromEvent(e, el) {
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

// ─── Events ──────────────────────────────────────────────────────
function bindEvents() {
  // Mobile nav drawer: hamburger opens it, scrim taps close it. (navigate()
  // closes it too, so picking any destination dismisses the drawer.)
  $("#navToggle")?.addEventListener("click", () => document.body.classList.toggle("nav-open"));
  $("#navScrim")?.addEventListener("click", () => document.body.classList.remove("nav-open"));

  $$(".nav-btn").forEach(b => b.addEventListener("click", () => navigate(b.dataset.view)));
  $$(".sidebar-playlist-item").forEach(b => {
    b.addEventListener("click", () => {
      const a = b.dataset.action;
      if (a === "liked") navigate("library");
      if (a === "queue") navigate("queue");
    });
  });
  $("#historyBack").addEventListener("click", goBack);
  $("#npBackBtn").addEventListener("click", goBack);
  $("#pbLeft").addEventListener("click", () => navigate("nowplaying"));

  $("#btnPlay").addEventListener("click", togglePlay);
  $("#btnNext").addEventListener("click", nextTrack);
  $("#btnPrev").addEventListener("click", prevTrack);
  $("#btnShuffle").addEventListener("click", toggleShuffle);
  $("#btnRepeat").addEventListener("click", () => {
    state.repeat = (state.repeat + 1) % 3;
    $("#btnRepeat").classList.toggle("active", state.repeat > 0);
    toast(["Repeat off", "Repeat all", "Repeat one"][state.repeat]);
  });
  $("#btnVolume").addEventListener("click", toggleMute);
  $("#btnLyrics").addEventListener("click", () => navigate("nowplaying"));

  $("#pbLikeBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (current()) toggleLike(current());
  });
  $("#npLikeBtn").addEventListener("click", () => {
    if (current()) toggleLike(current());
  });
  // Add the currently-open song to a playlist, right from Now Playing.
  $("#npAddBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (current()) openCtxMenu(current(), e.currentTarget);
    else toast("Play a song first");
  });
  $("#recentClearBtn").addEventListener("click", clearRecent);

  // Progress drag
  const pt = $("#progressTrack");
  pt.addEventListener("mousedown", (e) => {
    state.draggingProgress = true;
    const p = pctFromEvent(e, pt);
    if (state.duration) pb.seekTo(p * state.duration);
  });
  document.addEventListener("mousemove", (e) => {
    if (!state.draggingProgress || !state.duration) return;
    const p = pctFromEvent(e, pt);
    pb.seekTo(p * state.duration);
    $("#progressFill").style.width = `${p * 100}%`;
    $("#progressThumb").style.left = `${p * 100}%`;
  });
  document.addEventListener("mouseup", () => { state.draggingProgress = false; });

  // Volume drag
  let dv = false;
  const vt = $("#volumeTrack");
  vt.addEventListener("mousedown", (e) => { dv = true; setVolume(pctFromEvent(e, vt)); });
  document.addEventListener("mousemove", (e) => { if (dv) setVolume(pctFromEvent(e, vt)); });
  document.addEventListener("mouseup", () => { dv = false; });

  // Mode group (translate dropdown)
  $$(".lm-mode-btn").forEach(b => b.addEventListener("click", () => {
    $$(".lm-mode-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    state.translitMode = b.dataset.mode;
    updateTranslateLabel();
    translateAndRender();   // handles "Original" (incl. Sounds) internally
  }));

  // Language selector (translate dropdown)
  $("#langSelect").addEventListener("change", () => {
    const v = $("#langSelect").value;
    if (v === "custom") {
      const c = prompt("Enter language (e.g., Italian, Tamil):");
      if (c?.trim()) {
        const codeMap = { italian:"it", korean:"ko", tamil:"ta", bengali:"bn", turkish:"tr", polish:"pl", dutch:"nl", swedish:"sv", thai:"th", vietnamese:"vi", indonesian:"id", greek:"el", czech:"cs", hebrew:"he", malay:"ms", romanian:"ro", kannada:"kn", marathi:"mr", gujarati:"gu", punjabi:"pa", urdu:"ur", persian:"fa", ukrainian:"uk" };
        const code = codeMap[c.toLowerCase()] || c.substring(0, 2).toLowerCase();
        const opt = document.createElement("option");
        opt.value = code; opt.textContent = `${c} (${code})`;
        $("#langSelect").insertBefore(opt, $("#langSelect").lastElementChild);
        $("#langSelect").value = code;
        state.lang = code;
        updateTranslateLabel();
        translateAndRender();
      } else $("#langSelect").value = state.lang;
    } else {
      state.lang = v;
      updateTranslateLabel();
      translateAndRender();
    }
  });

  // Dual-language checkbox (translate dropdown)
  $("#dualLangBtn").addEventListener("change", () => {
    state.dualLang = $("#dualLangBtn").checked;
    translateAndRender();   // handles "Original" (incl. Sounds) internally
  });

  // Save / unsave the current language to the quick-access list.
  $("#langFavToggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const code = state.lang;
    const favs = settings.favLangs || (settings.favLangs = []);
    const i = favs.indexOf(code);
    if (i >= 0) { favs.splice(i, 1); toast(`Removed ${shortLangName(code)} from quick languages`); }
    else { favs.push(code); toast(`Saved ${shortLangName(code)} to quick languages`); }
    saveSettings();
    refreshFavLangsUI();
  });

  // One-tap switch to a saved quick language.
  $("#langFavChips")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".lm-fav-chip");
    if (!chip) return;
    e.stopPropagation();
    applyLanguage(chip.dataset.code);
  });

  // Two dropdowns: fancy Translate button + 3-dots (sync offset) menu.
  const tMenu = $("#translateMenu");
  const oMenu = $("#lyricsMenu");
  $("#translateBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    oMenu.classList.remove("open");
    tMenu.classList.toggle("open");
  });
  $("#lyricsMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    tMenu.classList.remove("open");
    oMenu.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!tMenu.contains(e.target) && !e.target.closest("#translateBtn")) tMenu.classList.remove("open");
    if (!oMenu.contains(e.target) && !e.target.closest("#lyricsMenuBtn")) oMenu.classList.remove("open");
  });

  // Sync offset buttons (now inside the 3-dots menu)
  $$(".lm-offset-step").forEach(b => b.addEventListener("click", () => {
    adjustOffset(parseFloat(b.dataset.step));
  }));
  $$(".lm-offset-reset").forEach(b => b.addEventListener("click", () => adjustOffset("reset")));
  // Draggable offset slider — absolute value, live as you drag.
  $("#offsetSlider")?.addEventListener("input", (e) => setOffset(e.target.value));

  // Lyrics tools: copy / download .lrc / fullscreen
  $$(".lm-tool").forEach(b => b.addEventListener("click", () => {
    handleLyricsTool(b.dataset.tool);
    oMenu.classList.remove("open");
  }));

  // Sleep timer popover
  const sleepMenu = $("#sleepMenu");
  $("#btnSleep").addEventListener("click", (e) => {
    e.stopPropagation();
    sleepMenu.classList.toggle("open");
  });
  $$("#sleepMenu .sleep-opt").forEach(b => b.addEventListener("click", () => {
    setSleepTimer(b.dataset.sleep);
    sleepMenu.classList.remove("open");
  }));
  document.addEventListener("click", (e) => {
    if (!sleepMenu.contains(e.target) && !e.target.closest("#btnSleep")) sleepMenu.classList.remove("open");
  });

  $("#fidelityBadge").addEventListener("click", () => {
    const b = $("#fidelityBadge");
    const hi = b.textContent.includes("Lossless");
    b.textContent = hi ? "Preview" : "Preview · Lossless";
    toast(hi ? "Standard" : "Preview-only audio");
  });

  bindSearchInput();

  // ── Playlists: create / context menu / modal ──────────────────
  $("#sidebarCreateBtn").addEventListener("click", () => openModal("create"));

  $("#ctxNewPlaylist").addEventListener("click", () => {
    const seed = ctxTrack;
    closeCtxMenu();
    openModal("create", { seedTrack: seed });
  });

  $("#ctxAddQueue").addEventListener("click", () => {
    const t = ctxTrack;
    closeCtxMenu();
    if (t) toast(addToQueue(t));
  });
  $("#ctxPlayNext").addEventListener("click", () => {
    const t = ctxTrack;
    closeCtxMenu();
    if (t) toast(playNext(t));
  });

  // Close the context menu on any outside click or scroll.
  document.addEventListener("click", (e) => {
    const menu = $("#ctxMenu");
    if (menu.classList.contains("open") &&
        !menu.contains(e.target) &&
        !e.target.closest(".sc-menu-btn") &&
        !e.target.closest(".sr-menu")) {
      closeCtxMenu();
    }
  });
  $("#contentScroll").addEventListener("scroll", closeCtxMenu, true);

  // Modal
  $("#modalSave").addEventListener("click", commitModal);
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modalOverlay").addEventListener("click", (e) => {
    if (e.target === $("#modalOverlay")) closeModal();
  });
  $("#modalInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitModal();
    if (e.key === "Escape") closeModal();
  });

  // Playlist view actions
  $("#playlistPlayBtn").addEventListener("click", () => {
    const pl = findPlaylist(state.currentPlaylistId);
    if (pl?.tracks.length) playFromList(pl.tracks, 0);
  });
  $("#playlistRenameBtn").addEventListener("click", () => {
    const pl = findPlaylist(state.currentPlaylistId);
    if (pl) openModal("rename", { playlistId: pl.id, value: pl.name });
  });
  $("#playlistDeleteBtn").addEventListener("click", () => {
    const pl = findPlaylist(state.currentPlaylistId);
    if (pl && confirm(`Delete playlist "${pl.name}"? This can't be undone.`)) {
      deletePlaylist(pl.id);
      toast("Playlist deleted");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    switch (e.code) {
      case "Space": e.preventDefault(); togglePlay(); break;
      case "ArrowRight": if (state.duration) pb.seekTo(Math.min(state.duration, pb.getCurrentTime() + 5)); break;
      case "ArrowLeft":  pb.seekTo(Math.max(0, pb.getCurrentTime() - 5)); break;
      case "ArrowUp":    e.preventDefault(); setVolume(state.volume + 0.05); break;
      case "ArrowDown":  e.preventDefault(); setVolume(state.volume - 0.05); break;
      case "KeyN": nextTrack(); break;
      case "KeyP": prevTrack(); break;
      case "KeyM": toggleMute(); break;
      case "KeyL": if (current()) toggleLike(current()); break;
      // Live lyric-sync nudge: "[" pulls lyrics earlier, "]" pushes them later.
      case "BracketLeft":  if (state.lyrics) { adjustOffset(-0.2); toast(`Lyric sync ${offsetText()}`, 1200); } break;
      case "BracketRight": if (state.lyrics) { adjustOffset(0.2);  toast(`Lyric sync ${offsetText()}`, 1200); } break;
    }
  });
}

window.addEventListener("DOMContentLoaded", boot);
