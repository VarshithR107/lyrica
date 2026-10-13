// ═══════════════════════════════════════════════════════════════════
// iTunes Search API — free, no auth, CORS-enabled
// Docs: https://performance-partners.apple.com/search-api
// Returns 30-second preview URLs. Catalog ~= every commercial song.
// ═══════════════════════════════════════════════════════════════════

const BASE = "https://itunes.apple.com";

// Normalize an iTunes search result into our internal track shape.
function normalize(r) {
  // iTunes' artwork URLs end in /100x100bb.jpg — swap for higher resolution.
  const cover = (r.artworkUrl100 || r.artworkUrl60 || "").replace(/\/\d+x\d+bb\./, "/512x512bb.");
  return {
    id: String(r.trackId || r.collectionId || r.artistId),
    name: r.trackName || r.collectionName || r.artistName || "",
    artists: [{ name: r.artistName || "" }],
    album: { name: r.collectionName || "", images: [{ url: cover }] },
    duration_ms: r.trackTimeMillis || 30000,
    preview_url: r.previewUrl || null,
    genre: r.primaryGenreName || "",
  };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) return null;
  return res.json();
}

// ─── Search ──────────────────────────────────────────────────────
export async function searchTracks(query, limit = 30) {
  if (!query) return [];
  const data = await get(`/search?term=${encodeURIComponent(query)}&entity=song&limit=${limit}`);
  return (data?.results || []).map(normalize);
}

export async function searchAlbums(query, limit = 12) {
  const data = await get(`/search?term=${encodeURIComponent(query)}&entity=album&limit=${limit}`);
  return (data?.results || []).map(normalize);
}

export async function searchArtists(query, limit = 6) {
  const data = await get(`/search?term=${encodeURIComponent(query)}&entity=musicArtist&limit=${limit}`);
  return data?.results || [];
}

// ─── Smart search ────────────────────────────────────────────────
// Spotify-style: query songs + artists in parallel, then rank by how
// well each result matches the query so the obvious song floats to the
// top even with sloppy/partial input ("blndng lghts", "weeknd blinding").
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")        // drop "(feat. …)", "[remix]"
    .replace(/[^a-z0-9\s]/g, " ")            // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// ── Information-retrieval primitives (typo-tolerant fuzzy matching) ──
// Levenshtein edit distance — the basis for "did you mean" typo handling.
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}
// Normalised edit similarity (1 = identical, 0 = totally different).
function editSim(a, b) {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}
// Dice coefficient over character bigrams — robust phrase similarity that
// tolerates dropped letters ("blndng lghts" ≈ "blinding lights").
function bigrams(s) {
  const g = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    g.set(bg, (g.get(bg) || 0) + 1);
  }
  return g;
}
function diceCoeff(a, b) {
  a = a.replace(/\s/g, ""); b = b.replace(/\s/g, "");
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, sizeA = 0, sizeB = 0;
  for (const v of A.values()) sizeA += v;
  for (const [k, v] of B) { sizeB += v; if (A.has(k)) inter += Math.min(v, A.get(k)); }
  return (2 * inter) / (sizeA + sizeB);
}
// Each query token matched to its best field token (handles word-level typos).
function fuzzyTokenCoverage(qTokens, fieldTokens) {
  if (!qTokens.length || !fieldTokens.length) return 0;
  let total = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const ft of fieldTokens) {
      if (ft === qt) { best = 1; break; }
      if (ft.includes(qt) || qt.includes(ft)) { best = Math.max(best, 0.85); continue; }
      best = Math.max(best, editSim(qt, ft));
    }
    total += best;
  }
  return total / qTokens.length;
}

// Composite relevance: exact/prefix/substring signals (precision) blended
// with fuzzy similarity (recall/typo-tolerance), title weighted over artist.
function relevance(track, q) {
  const name = norm(track.name);
  const artist = norm(track.artists.map(a => a.name).join(" "));
  const ql = norm(q);
  const qTokens = ql.split(" ").filter(Boolean);
  const fieldTokens = `${name} ${artist}`.split(" ").filter(Boolean);
  let s = 0;

  // Precision signals — exact/prefix/substring.
  if (name === ql) s += 140;
  else if (name.startsWith(ql)) s += 85;
  else if (name.includes(ql)) s += 50;

  if (artist === ql) s += 95;
  else if (artist.startsWith(ql)) s += 45;
  else if (artist.includes(ql)) s += 25;

  if (`${artist} ${name}`.includes(ql) || `${name} ${artist}`.includes(ql)) s += 25;

  // Fuzzy recall signals — survive typos / dropped letters.
  s += Math.round(diceCoeff(ql, name) * 60);
  s += Math.round(diceCoeff(ql, artist) * 25);
  s += Math.round(editSim(ql, name) * 25);
  s += Math.round(fuzzyTokenCoverage(qTokens, fieldTokens) * 55);

  return s;
}

// Personalization boost: nudge results toward artists/genres the listener
// already likes or plays, so search reflects *their* taste, not just the
// global popularity prior. Kept small so it re-ranks ties without ever
// overriding a clearly-better textual match.
function personalBoost(track, favArtists, favGenres) {
  let b = 0;
  const a = norm(track.artists?.[0]?.name);
  if (a && favArtists.has(a)) b += 24;
  const g = String(track.genre || "").toLowerCase().trim();
  if (g && favGenres.has(g)) b += 10;
  return b;
}

// Returns { topResult, tracks, artist } — topResult is the single best
// match (an artist if the query is clearly an artist name, else a song).
// `opts.favoriteArtists` / `opts.favoriteGenres` (arrays of raw names) let the
// caller personalize ranking toward the listener's taste.
export async function smartSearch(query, limit = 40, opts = {}) {
  if (!query) return { topResult: null, tracks: [], artist: null };

  const favArtists = new Set((opts.favoriteArtists || []).map(norm).filter(Boolean));
  const favGenres = new Set(
    (opts.favoriteGenres || []).map(g => String(g || "").toLowerCase().trim()).filter(Boolean)
  );

  const ql = norm(query);
  const [songs, artists] = await Promise.all([
    searchTracks(query, limit),
    searchArtists(query, 3),
  ]);

  // ── Query expansion (spell-correct then re-retrieve) ──────────────
  // iTunes' own recall is weak on typos, so it may only surface obscure
  // covers for "blndng lghts". We detect that the query was likely
  // misspelled (the best candidate's title differs from what was typed but
  // is fuzzily close), then re-search with that corrected title to pull the
  // canonical/popular version + its siblings, and merge both result sets.
  // The second search is well-ordered by iTunes, giving us a popularity prior.
  let expanded = [];
  let expandedRank = new Map();   // track-id → its position in the corrected search
  const bestFuzzy = [...songs].sort((a, b) => relevance(b, query) - relevance(a, query))[0];
  if (bestFuzzy) {
    const canon = norm(bestFuzzy.name);
    const looksMisspelled = canon && canon !== ql && !canon.includes(ql) && diceCoeff(ql, canon) > 0.4;
    if (looksMisspelled) {
      try {
        expanded = await searchTracks(bestFuzzy.name, 25);
        expanded.forEach((t, i) => expandedRank.set(t.id, i));
      } catch { /* ignore */ }
    }
  }

  const pool = expanded.concat(songs);

  // Rank against the ORIGINAL query (so artist tokens like "…ed sheeran" still
  // matter); within ties, prefer the corrected search's order — a popularity
  // proxy that lets the original beat look-alike covers.
  const ranked = pool
    .map((t, i) => {
      const popRank = expandedRank.has(t.id) ? expandedRank.get(t.id) : 100 + i;
      const s = relevance(t, query) - popRank * 0.4 + personalBoost(t, favArtists, favGenres);
      return { t, s };
    })
    .sort((a, b) => b.s - a.s);

  // Dedupe by title+artist (iTunes returns the same song on many albums).
  const seen = new Set();
  const tracks = [];
  for (const { t } of ranked) {
    const key = `${norm(t.name)}|${norm(t.artists[0]?.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(t);
  }

  // Is the query primarily an artist name? Decide between an artist and a
  // song for the top result the way Spotify does:
  //   • The leading "The" shouldn't break a match ("weeknd" → The Weeknd).
  //   • An artist only wins if they're well-represented in the results
  //     (a popularity proxy), so an obscure band coincidentally named
  //     "Blinding Lights" never outranks the famous song.
  const stripThe = (s) => norm(s).replace(/^the /, "");
  const sameArtist = (a, b) => {
    const na = stripThe(a), nb = stripThe(b);
    return na && nb && (na === nb || na.includes(nb) || nb.includes(na));
  };

  const topArtist = artists[0];
  const artistName = norm(topArtist?.artistName);
  // Treat as an artist query only when the typed text is essentially the
  // artist's exact name AND that artist dominates the results (owns several
  // tracks — a popularity proxy). This keeps "taylor swift"/"weeknd" as artist
  // results while a namesake one-off song or a misspelling stays a song.
  const exactArtist = stripThe(artistName) !== "" && stripThe(artistName) === ql.replace(/^the /, "");
  const ownedTracks = topArtist
    ? tracks.filter(t => sameArtist(t.artists[0]?.name, topArtist.artistName))
    : [];

  const artistIsTop = topArtist && exactArtist && ownedTracks.length >= 3;

  let topResult = null;
  if (artistIsTop) {
    topResult = {
      type: "artist",
      id: String(topArtist.artistId),
      name: topArtist.artistName,
      genre: topArtist.primaryGenreName || "Artist",
      image: ownedTracks[0]?.album.images[0]?.url || tracks[0]?.album.images[0]?.url || "",
    };
  } else if (tracks.length) {
    topResult = { type: "track", track: tracks[0] };
  }

  return { topResult, tracks, artist: artistIsTop ? topArtist : null };
}

// ─── Album / Artist details ──────────────────────────────────────
export async function getAlbumTracks(collectionId, limit = 50) {
  const data = await get(`/lookup?id=${collectionId}&entity=song&limit=${limit}`);
  // First result is the album itself; rest are tracks.
  return (data?.results || []).slice(1).map(normalize);
}

export async function getArtistTopTracks(artistId, limit = 20) {
  const data = await get(`/lookup?id=${artistId}&entity=song&limit=${limit}`);
  return (data?.results || []).slice(1).map(normalize);
}

// ─── "Charts" — Apple's RSS endpoint became CORS-restricted, so we
//    use /search with broad popular terms as a stand-in for trending.
const CHART_CACHE = new Map();

export async function topSongs(country = "us", limit = 25, term = "top hits") {
  const key = `songs:${country}:${limit}:${term}`;
  if (CHART_CACHE.has(key)) return CHART_CACHE.get(key);
  const data = await get(`/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}&country=${country}`);
  const tracks = (data?.results || []).map(normalize);
  CHART_CACHE.set(key, tracks);
  return tracks;
}

export async function topAlbums(country = "us", limit = 12, term = "new albums") {
  const key = `albums:${country}:${limit}:${term}`;
  if (CHART_CACHE.has(key)) return CHART_CACHE.get(key);
  const data = await get(`/search?term=${encodeURIComponent(term)}&entity=album&limit=${limit}&country=${country}`);
  const albums = (data?.results || []).map(a => ({
    id: String(a.collectionId),
    name: a.collectionName,
    artists: [{ name: a.artistName }],
    album: { name: a.collectionName, images: [{ url: (a.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, "/512x512bb.") }] },
  }));
  CHART_CACHE.set(key, albums);
  return albums;
}

// ─── Genre search (no real genre endpoint — use search by genre name) ──
export async function tracksByGenre(genreName, limit = 24) {
  return searchTracks(genreName, limit);
}
