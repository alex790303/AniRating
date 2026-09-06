// ═══════════════════════════════════════════════════════════
// 五個評分站的抓取模組。每個函式回傳「某一季」的作品陣列。
// ═══════════════════════════════════════════════════════════
import { DELAYS, FORMATS, MIN_POPULARITY } from "./config.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = "AniRating/1.0 (anime score aggregator; contact via GitHub)";

// 帶重試的 fetch：遇到 429（請求過快）會等待後重試
async function get(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 5000 * (i + 1);
        console.log(`   ⏸  被限流，等待 ${wait / 1000}s…`);
        await sleep(wait);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) { console.log(`   ⚠  放棄：${url} (${e.message})`); return null; }
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

// 標題正規化，用來做跨站比對
export const norm = s => (s || "")
  .toLowerCase()
  .replace(/[\u3000-\u303f\uff00-\uffef]/g, m => m)      // 保留日文標點供後續處理
  .replace(/season\s*\d+|第\s*\d+\s*期|\d+(st|nd|rd|th)\s*season/g, "")
  .replace(/[^\p{L}\p{N}]/gu, "")
  .trim();

// ── 1. AniList（主幹：ID、標題、封面、季度、狀態、期待度）────
const ANILIST_QUERY = `
query ($season: MediaSeason, $year: Int, $page: Int, $formats: [MediaFormat]) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(season: $season, seasonYear: $year, type: ANIME, format_in: $formats, sort: POPULARITY_DESC) {
      id idMal
      title { romaji english native }
      coverImage { extraLarge large color }
      bannerImage
      episodes duration status season seasonYear
      startDate { year month day }
      averageScore popularity favourites
      genres
      tags { name rank isGeneralSpoiler }
      studios(isMain: true) { nodes { name } }
      description(asHtml: false)
      siteUrl
      relations { edges { relationType node { id format season seasonYear } } }
      externalLinks { site url }
      nextAiringEpisode { episode airingAt }
    }
  }
}`;

export async function fetchAniList(year, season) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const json = await get("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { season, year, page, formats: FORMATS } }),
    });
    await sleep(DELAYS.anilist);
    const p = json?.data?.Page;
    if (!p) break;
    for (const m of p.media) {
      if ((m.popularity || 0) < MIN_POPULARITY) continue;
      out.push({
        anilistId: m.id,
        malId: m.idMal,
        title: { ja: m.title.native, en: m.title.english || m.title.romaji, romaji: m.title.romaji },
        cover: m.coverImage?.extraLarge || m.coverImage?.large,
        coverColor: m.coverImage?.color,
        banner: m.bannerImage,
        episodes: m.episodes,
        status: m.status,                     // FINISHED / RELEASING / NOT_YET_RELEASED
        season: m.season, seasonYear: m.seasonYear,
        startDate: m.startDate,
        genres: m.genres || [],
        aniTags: (m.tags || []).filter(t => !t.isGeneralSpoiler && t.rank >= 60).map(t => t.name),
        studio: m.studios?.nodes?.[0]?.name || null,
        synopsis: (m.description || "").replace(/<[^>]+>/g, "").slice(0, 400),
        popularity: m.popularity, favourites: m.favourites,
        airedEpisodes: m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null,
        nextAiringAt: m.nextAiringEpisode?.airingAt || null,
        relations: (m.relations?.edges || [])
          .filter(e => ["PREQUEL", "SEQUEL", "PARENT"].includes(e.relationType))
          .map(e => ({ type: e.relationType, id: e.node.id, season: e.node.season, year: e.node.seasonYear })),
        links: Object.fromEntries((m.externalLinks || []).map(l => [l.site, l.url])),
        scores: {
          AniList: m.averageScore != null ? m.averageScore / 10 : null,
        },
        votes: { AniList: m.popularity || 0 },
      });
    }
    if (!p.pageInfo.hasNextPage) break;
  }
  return out;
}

// ── 2. MyAnimeList（透過 Jikan）─────────────────────────────
export async function fetchMAL(year, season) {
  const s = season.toLowerCase() === "fall" ? "fall" : season.toLowerCase();
  const map = new Map();  // malId → { score, votes }
  for (let page = 1; page <= 12; page++) {
    const json = await get(`https://api.jikan.moe/v4/seasons/${year}/${s}?page=${page}&sfw=false`);
    await sleep(DELAYS.jikan);
    if (!json?.data?.length) break;
    for (const a of json.data) {
      if (a.score != null) map.set(a.mal_id, { score: a.score, votes: a.scored_by || 0 });
    }
    if (!json.pagination?.has_next_page) break;
  }
  return map;
}

// ── 3. Kitsu ───────────────────────────────────────────────
export async function fetchKitsu(year, season) {
  const rows = [];
  for (let off = 0; off < 400; off += 20) {
    const url = `https://kitsu.io/api/edge/anime?filter[seasonYear]=${year}&filter[season]=${season.toLowerCase()}`
      + `&page[limit]=20&page[offset]=${off}&fields[anime]=titles,canonicalTitle,averageRating,userCount,episodeCount`;
    const json = await get(url, { headers: { Accept: "application/vnd.api+json" } });
    await sleep(DELAYS.kitsu);
    if (!json?.data?.length) break;
    for (const a of json.data) {
      const at = a.attributes;
      if (at.averageRating == null) continue;
      rows.push({
        keys: [at.canonicalTitle, at.titles?.en, at.titles?.en_jp, at.titles?.ja_jp].filter(Boolean).map(norm),
        score: Number(at.averageRating) / 10,      // Kitsu 是 0–100
        votes: at.userCount || 0,
      });
    }
  }
  return rows;
}

// ── 4. Bangumi 番組計畫 ────────────────────────────────────
const MONTHS = { WINTER: [1, 4], SPRING: [4, 7], SUMMER: [7, 10], FALL: [10, 13] };
export async function fetchBangumi(year, season) {
  const [m0, m1] = MONTHS[season];
  const from = `${year}-${String(m0).padStart(2, "0")}-01`;
  const toY = m1 === 13 ? year + 1 : year;
  const toM = m1 === 13 ? 1 : m1;
  const to = `${toY}-${String(toM).padStart(2, "0")}-01`;
  const rows = [];
  for (let off = 0; off < 300; off += 50) {
    const json = await get(`https://api.bgm.tv/v0/search/subjects?limit=50&offset=${off}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        keyword: "", sort: "heat",
        filter: { type: [2], air_date: [`>=${from}`, `<${to}`], nsfw: false },
      }),
    });
    await sleep(DELAYS.bangumi);
    if (!json?.data?.length) break;
    for (const a of json.data) {
      if (!a.rating?.score) continue;
      rows.push({
        keys: [a.name, a.name_cn].filter(Boolean).map(norm),
        titleCn: a.name_cn || null,
        score: a.rating.score,          // 已是 0–10
        votes: a.rating.total || 0,
      });
    }
    if (json.data.length < 50) break;
  }
  return rows;
}

// ── 5. IMDb（透過 OMDb，需要免費金鑰）──────────────────────
export async function fetchIMDb(title, year, apiKey) {
  if (!apiKey || !title) return null;
  const url = `https://www.omdbapi.com/?apikey=${apiKey}&t=${encodeURIComponent(title)}&type=series&y=${year}`;
  const json = await get(url);
  await sleep(DELAYS.omdb);
  if (!json || json.Response === "False" || !json.imdbRating || json.imdbRating === "N/A") return null;
  return {
    score: Number(json.imdbRating),
    votes: Number(String(json.imdbVotes || "0").replace(/,/g, "")) || 0,
    imdbId: json.imdbID,
  };
}

export { sleep };
