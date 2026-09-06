// ═══════════════════════════════════════════════════════════════════
// AniRating 資料抓取與評分聚合（單檔版）
//   node build.mjs            → 抓全部年份（第一次用，很久）
//   node build.mjs --recent   → 只更新最近 3 季（每日排程用）
// 輸出：data/seasons/*.json、data/index.json
// ═══════════════════════════════════════════════════════════════════
import fs from "node:fs/promises";
import path from "node:path";

// ╔═══ 設定區：只有這一段你可能會想改 ═══════════════════════════════╗
const START_YEAR = 2021;          // 抓幾年起。想補全歷史就改小
const FUTURE_SEASONS = 1;         // 往未來抓幾季
const FORMATS = ["TV", "TV_SHORT"];   // 加 "MOVIE" 可收錄劇場版
const MIN_POPULARITY = 150;       // 低於此人氣不收錄。0 = 全收

const SITE_WEIGHTS = {            // 基礎權重（會再依實際票數縮放）
  MyAnimeList: 0.30, AniList: 0.24, Bangumi: 0.22, Kitsu: 0.12, IMDb: 0.12,
};
const SITE_CONFIDENCE = {         // 票數要到多少，該站分數才算完全可信
  MyAnimeList: 3000, AniList: 2000, Bangumi: 300, Kitsu: 400, IMDb: 800,
};
const SCALE_CENTER = 7.0, SCALE_SPREAD = 1.05;   // 綜合分的中心與展幅

const DELAYS = { anilist: 800, jikan: 1400, kitsu: 400, bangumi: 600, omdb: 250 };
// ╚═════════════════════════════════════════════════════════════════╝

const TAG_MAP = {
  action: ["Action", "Martial Arts", "Super Power", "Military"],
  isekai: ["Isekai", "Reincarnation"],
  romance: ["Romance", "Shoujo", "Josei", "Harem"],
  slice: ["Slice of Life", "Iyashikei", "CGDCT"],
  mystery: ["Mystery", "Thriller", "Suspense", "Detective"],
  fantasy: ["Fantasy", "Adventure", "Magic"],
  scifi: ["Sci-Fi", "Mecha", "Space", "Cyberpunk"],
  sports: ["Sports", "Team Sports", "Racing"],
  comedy: ["Comedy", "Parody", "Gag Humor"],
  music: ["Music", "Idol", "Band"],
  drama: ["Drama", "Psychological", "Historical"],
  horror: ["Horror", "Gore", "Survival"],
  school: ["School", "Coming of Age"],
  food: ["Food", "Gourmet", "Cooking"],
};
const MOOD_MAP = {
  rush: ["Shounen", "Super Power", "Male Protagonist"],
  tear: ["Tragedy", "Emotional", "Bittersweet"],
  brain: ["Psychological", "Philosophy", "Politics", "Time Manipulation"],
  heal: ["Iyashikei", "Heartwarming", "Slice of Life"],
  dark: ["Tragedy", "Gore", "Dystopian", "Nihilism"],
  tense: ["Survival", "Suspense", "Battle Royale"],
  art: ["Cinematic", "Stylized"],
  chill: ["Episodic", "Comedy", "Short Episodes"],
};
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const SEASON_KEY = { WINTER: "winter", SPRING: "spring", SUMMER: "summer", FALL: "autumn" };
const OUT = "data";
const OMDB_KEY = process.env.OMDB_API_KEY || "";
const RECENT_ONLY = process.argv.includes("--recent");
const UA = "AniRating/1.0 (anime score aggregator)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 帶重試的請求 ──────────────────────────────────────────────────
async function get(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 5000 * (i + 1);
        console.log(`   ⏸ 被限流，等 ${wait / 1000}s`); await sleep(wait); continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) { console.log(`   ⚠ 放棄 ${url} (${e.message})`); return null; }
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}
const norm = s => (s || "").toLowerCase()
  .replace(/season\s*\d+|第\s*\d+\s*期|\d+(st|nd|rd|th)\s*season/g, "")
  .replace(/[^\p{L}\p{N}]/gu, "").trim();

// ── 1. AniList：主幹資料 ─────────────────────────────────────────
const Q = `query($season:MediaSeason,$year:Int,$page:Int,$formats:[MediaFormat]){
 Page(page:$page,perPage:50){ pageInfo{hasNextPage}
  media(season:$season,seasonYear:$year,type:ANIME,format_in:$formats,sort:POPULARITY_DESC){
   id idMal title{romaji english native} coverImage{extraLarge large color} bannerImage
   episodes status season seasonYear startDate{year month day}
   averageScore popularity favourites genres tags{name rank isGeneralSpoiler}
   studios(isMain:true){nodes{name}} description(asHtml:false) siteUrl
   relations{edges{relationType node{id}}} externalLinks{site url}
   nextAiringEpisode{episode airingAt} }}}`;

async function fetchAniList(year, season) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: Q, variables: { season, year, page, formats: FORMATS } }),
    });
    await sleep(DELAYS.anilist);
    const p = j?.data?.Page; if (!p) break;
    for (const m of p.media) {
      if ((m.popularity || 0) < MIN_POPULARITY) continue;
      out.push({
        anilistId: m.id, malId: m.idMal,
        title: { ja: m.title.native, en: m.title.english || m.title.romaji, romaji: m.title.romaji },
        cover: m.coverImage?.extraLarge || m.coverImage?.large, coverColor: m.coverImage?.color,
        banner: m.bannerImage, episodes: m.episodes, status: m.status,
        startDate: m.startDate, genres: m.genres || [],
        aniTags: (m.tags || []).filter(t => !t.isGeneralSpoiler && t.rank >= 60).map(t => t.name),
        studio: m.studios?.nodes?.[0]?.name || null,
        synopsis: (m.description || "").replace(/<[^>]+>/g, "").slice(0, 400),
        popularity: m.popularity, favourites: m.favourites,
        airedEpisodes: m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null,
        nextAiringAt: m.nextAiringEpisode?.airingAt || null,
        hasRelations: (m.relations?.edges || []).some(e => ["SEQUEL", "PREQUEL"].includes(e.relationType)),
        links: Object.fromEntries((m.externalLinks || []).map(l => [l.site, l.url])),
        scores: { AniList: m.averageScore != null ? m.averageScore / 10 : null },
        votes: { AniList: m.popularity || 0 },
      });
    }
    if (!p.pageInfo.hasNextPage) break;
  }
  return out;
}

// ── 2. MyAnimeList（Jikan）───────────────────────────────────────
async function fetchMAL(year, season) {
  const map = new Map();
  for (let page = 1; page <= 12; page++) {
    const j = await get(`https://api.jikan.moe/v4/seasons/${year}/${season.toLowerCase()}?page=${page}`);
    await sleep(DELAYS.jikan);
    if (!j?.data?.length) break;
    for (const a of j.data) if (a.score != null) map.set(a.mal_id, { score: a.score, votes: a.scored_by || 0 });
    if (!j.pagination?.has_next_page) break;
  }
  return map;
}

// ── 3. Kitsu ────────────────────────────────────────────────────
async function fetchKitsu(year, season) {
  const rows = [];
  for (let off = 0; off < 400; off += 20) {
    const j = await get(`https://kitsu.io/api/edge/anime?filter[seasonYear]=${year}`
      + `&filter[season]=${season.toLowerCase()}&page[limit]=20&page[offset]=${off}`,
      { headers: { Accept: "application/vnd.api+json" } });
    await sleep(DELAYS.kitsu);
    if (!j?.data?.length) break;
    for (const a of j.data) {
      const t = a.attributes;
      if (t.averageRating == null) continue;
      rows.push({
        keys: [t.canonicalTitle, t.titles?.en, t.titles?.en_jp, t.titles?.ja_jp].filter(Boolean).map(norm),
        score: Number(t.averageRating) / 10, votes: t.userCount || 0,
      });
    }
  }
  return rows;
}

// ── 4. Bangumi 番組計畫 ──────────────────────────────────────────
const MONTHS = { WINTER: [1, 4], SPRING: [4, 7], SUMMER: [7, 10], FALL: [10, 13] };
async function fetchBangumi(year, season) {
  const [m0, m1] = MONTHS[season];
  const from = `${year}-${String(m0).padStart(2, "0")}-01`;
  const toY = m1 === 13 ? year + 1 : year, toM = m1 === 13 ? 1 : m1;
  const to = `${toY}-${String(toM).padStart(2, "0")}-01`;
  const rows = [];
  for (let off = 0; off < 300; off += 50) {
    const j = await get(`https://api.bgm.tv/v0/search/subjects?limit=50&offset=${off}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ keyword: "", sort: "heat", filter: { type: [2], air_date: [`>=${from}`, `<${to}`], nsfw: false } }),
    });
    await sleep(DELAYS.bangumi);
    if (!j?.data?.length) break;
    for (const a of j.data) {
      if (!a.rating?.score) continue;
      rows.push({
        keys: [a.name, a.name_cn].filter(Boolean).map(norm), titleCn: a.name_cn || null,
        score: a.rating.score, votes: a.rating.total || 0,
      });
    }
    if (j.data.length < 50) break;
  }
  return rows;
}

// ── 5. IMDb（OMDb）──────────────────────────────────────────────
async function fetchIMDb(title, year) {
  if (!OMDB_KEY || !title) return null;
  const j = await get(`https://www.omdbapi.com/?apikey=${OMDB_KEY}&t=${encodeURIComponent(title)}&type=series&y=${year}`);
  await sleep(DELAYS.omdb);
  if (!j || j.Response === "False" || !j.imdbRating || j.imdbRating === "N/A") return null;
  return { score: Number(j.imdbRating), votes: Number(String(j.imdbVotes || "0").replace(/,/g, "")) || 0, imdbId: j.imdbID };
}

// ── 跨站比對與標籤 ──────────────────────────────────────────────
function matchByTitle(item, rows) {
  const keys = [item.title.ja, item.title.en, item.title.romaji].filter(Boolean).map(norm);
  for (const r of rows) if (r.keys.some(k => k && keys.includes(k))) return r;
  for (const r of rows) for (const k of r.keys)
    if (k && k.length > 6 && keys.some(q => q.startsWith(k) || k.startsWith(q))) return r;
  return null;
}
const mapBy = (M, genres, aniTags, n) => {
  const pool = [...(genres || []), ...(aniTags || [])];
  return Object.keys(M).filter(k => M[k].some(g => pool.includes(g))).slice(0, n);
};

// ── 評分聚合 ────────────────────────────────────────────────────
function aggregate(items) {
  const sites = Object.keys(SITE_WEIGHTS), stats = {};
  for (const s of sites) {
    const xs = items.map(i => i.scores[s]).filter(v => v != null && v > 0);
    if (xs.length < 8) { stats[s] = null; continue; }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
    stats[s] = { mean, sd };
  }
  for (const it of items) {
    let wsum = 0, zsum = 0, vt = 0; const d = {};
    for (const s of sites) {
      const raw = it.scores[s], v = it.votes[s] || 0;
      if (raw == null || !stats[s]) { d[s] = null; continue; }
      const z = (raw - stats[s].mean) / stats[s].sd, C = SITE_CONFIDENCE[s];
      const w = SITE_WEIGHTS[s] * Math.min(1, Math.log1p(v) / Math.log1p(C));
      wsum += w; zsum += z * (v / (v + C)) * w; vt += v;
      d[s] = { raw: Number(raw.toFixed(2)), votes: v, weight: w };
    }
    if (!wsum) { it.combined = null; it.confidence = 0; it.sources = d; continue; }
    for (const s of sites) if (d[s]) d[s].weight = Number((d[s].weight / wsum).toFixed(3));
    it.combined = Number(Math.max(1, Math.min(10, SCALE_CENTER + (zsum / wsum) * SCALE_SPREAD)).toFixed(2));
    it.confidence = vt; it.sources = d;
  }
  return items;
}

// ── 季度工具 ────────────────────────────────────────────────────
function currentSeason(d = new Date()) {
  const m = d.getUTCMonth();
  return { year: d.getUTCFullYear(), season: m < 3 ? "WINTER" : m < 6 ? "SPRING" : m < 9 ? "SUMMER" : "FALL" };
}
function seasonOffset({ year, season }, delta) {
  let i = SEASONS.indexOf(season) + delta, y = year;
  while (i < 0) { i += 4; y--; } while (i > 3) { i -= 4; y++; }
  return { year: y, season: SEASONS[i] };
}
function targetSeasons() {
  const now = currentSeason();
  if (RECENT_ONLY) return [-1, 0, 1].map(d => seasonOffset(now, d));
  const max = now.year * 4 + SEASONS.indexOf(now.season) + FUTURE_SEASONS, list = [];
  for (let y = START_YEAR; y <= now.year + 1; y++) for (const s of SEASONS)
    if (y * 4 + SEASONS.indexOf(s) <= max) list.push({ year: y, season: s });
  return list;
}

// ── 抓一季 ──────────────────────────────────────────────────────
async function buildSeason(year, season) {
  const key = `${year}-${SEASON_KEY[season]}`;
  console.log(`\n▶ ${key}`);
  const items = await fetchAniList(year, season);
  console.log(`   AniList ${items.length} 部`);
  if (!items.length) return null;

  const mal = await fetchMAL(year, season);   console.log(`   MAL     ${mal.size} 部有評分`);
  const kitsu = await fetchKitsu(year, season); console.log(`   Kitsu   ${kitsu.length} 部有評分`);
  const bgm = await fetchBangumi(year, season); console.log(`   Bangumi ${bgm.length} 部有評分`);

  for (const it of items) {
    const m = it.malId ? mal.get(it.malId) : null;
    if (m) { it.scores.MyAnimeList = m.score; it.votes.MyAnimeList = m.votes; }
    const k = matchByTitle(it, kitsu);
    if (k) { it.scores.Kitsu = k.score; it.votes.Kitsu = k.votes; }
    const b = matchByTitle(it, bgm);
    if (b) { it.scores.Bangumi = b.score; it.votes.Bangumi = b.votes; if (b.titleCn) it.title.zh = b.titleCn; }
  }
  if (OMDB_KEY) {
    let hit = 0;
    for (const it of items) {
      if (it.status === "NOT_YET_RELEASED") continue;
      const r = await fetchIMDb(it.title.en || it.title.romaji, year);
      if (r) { it.scores.IMDb = r.score; it.votes.IMDb = r.votes; it.imdbId = r.imdbId; hit++; }
    }
    console.log(`   IMDb    ${hit} / ${items.length} 比對成功`);
  } else console.log("   IMDb    略過（未設定 OMDB_API_KEY）");

  aggregate(items);

  const clean = items.map(it => ({
    id: it.anilistId,
    title: { zh: it.title.zh || it.title.en || it.title.romaji, en: it.title.en || it.title.romaji, ja: it.title.ja },
    cover: it.cover, coverColor: it.coverColor, banner: it.banner,
    year, season: SEASON_KEY[season],
    status: it.status === "FINISHED" ? "finished" : it.status === "RELEASING" ? "airing" : "upcoming",
    episodes: it.episodes, airedEpisodes: it.airedEpisodes, nextAiringAt: it.nextAiringAt,
    startDate: it.startDate, studio: it.studio, synopsis: it.synopsis,
    tags: mapBy(TAG_MAP, it.genres, it.aniTags, 4),
    moods: mapBy(MOOD_MAP, it.genres, it.aniTags, 3),
    split: it.hasRelations,
    score: it.combined, votes: it.confidence,
    heat: it.status === "NOT_YET_RELEASED"
      ? Math.min(100, Math.round(Math.log1p(it.popularity) / Math.log1p(120000) * 100)) : null,
    sources: it.sources,
    links: { anilist: `https://anilist.co/anime/${it.anilistId}`, ...it.links },
  })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.heat ?? 0) - (a.heat ?? 0));

  await fs.mkdir(path.join(OUT, "seasons"), { recursive: true });
  await fs.writeFile(path.join(OUT, "seasons", key + ".json"),
    JSON.stringify({ key, year, season: SEASON_KEY[season], updated: new Date().toISOString(), items: clean }));
  console.log(`   ✔ data/seasons/${key}.json（${clean.length} 部）`);
  return { key, year, season: SEASON_KEY[season], count: clean.length };
}

// ── 主流程 ──────────────────────────────────────────────────────
const t0 = Date.now(), list = targetSeasons();
console.log(`AniRating 更新：${list.length} 季${RECENT_ONLY ? "（僅最近）" : ""}`);
const done = [];
for (const { year, season } of list) {
  try { const r = await buildSeason(year, season); if (r) done.push(r); }
  catch (e) { console.log(`   ✖ ${year} ${season} 失敗：${e.message}`); }
}
let prev = [];
try { prev = JSON.parse(await fs.readFile(path.join(OUT, "index.json"), "utf8")).seasons || []; } catch {}
const merged = [...prev.filter(p => !done.some(d => d.key === p.key)), ...done].sort((a, b) => a.key.localeCompare(b.key));
await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify({
  updated: new Date().toISOString(),
  current: (({ year, season }) => `${year}-${SEASON_KEY[season]}`)(currentSeason()),
  seasons: merged,
}, null, 2));
console.log(`\n完成：${done.length} 季，耗時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
