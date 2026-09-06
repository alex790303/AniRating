// ═══════════════════════════════════════════════════════════
// AniRating 主程式
//   node scripts/build.mjs            → 抓全部年份
//   node scripts/build.mjs --recent   → 只更新最近 3 季（每日排程用）
// 輸出：data/seasons/2026-summer.json 等 + data/index.json
// ═══════════════════════════════════════════════════════════
import fs from "node:fs/promises";
import path from "node:path";
import {
  START_YEAR, FUTURE_SEASONS, SEASONS, SEASON_KEY,
  SITE_WEIGHTS, SITE_CONFIDENCE, SCALE_CENTER, SCALE_SPREAD,
  TAG_MAP, MOOD_MAP,
} from "./config.mjs";
import { fetchAniList, fetchMAL, fetchKitsu, fetchBangumi, fetchIMDb, norm } from "./sources.mjs";

const OUT = "data";
const OMDB_KEY = process.env.OMDB_API_KEY || "";
const RECENT_ONLY = process.argv.includes("--recent");

// ── 目前是哪一季 ───────────────────────────────────────────
function currentSeason(d = new Date()) {
  const m = d.getUTCMonth();                       // 0-11
  const s = m < 3 ? "WINTER" : m < 6 ? "SPRING" : m < 9 ? "SUMMER" : "FALL";
  return { year: d.getUTCFullYear(), season: s };
}
function seasonOffset({ year, season }, delta) {
  let i = SEASONS.indexOf(season) + delta, y = year;
  while (i < 0) { i += 4; y--; }
  while (i > 3) { i -= 4; y++; }
  return { year: y, season: SEASONS[i] };
}
function targetSeasons() {
  const now = currentSeason();
  if (RECENT_ONLY) return [-1, 0, 1].map(d => seasonOffset(now, d));
  const list = [];
  for (let y = START_YEAR; y <= now.year + 1; y++)
    for (const s of SEASONS) {
      const idx = y * 4 + SEASONS.indexOf(s);
      const max = now.year * 4 + SEASONS.indexOf(now.season) + FUTURE_SEASONS;
      if (idx <= max) list.push({ year: y, season: s });
    }
  return list;
}

// ── 跨站比對：用正規化標題找出對應作品 ─────────────────────
function matchByTitle(item, rows) {
  const keys = [item.title.ja, item.title.en, item.title.romaji].filter(Boolean).map(norm);
  for (const r of rows) if (r.keys.some(k => k && keys.includes(k))) return r;
  // 退一步：允許前綴相符（處理「第二期」等後綴差異）
  for (const r of rows)
    for (const k of r.keys)
      if (k && k.length > 6 && keys.some(q => q.startsWith(k) || k.startsWith(q))) return r;
  return null;
}

// ── 標籤收斂 ───────────────────────────────────────────────
const mapTags = (genres, aniTags) => {
  const pool = [...(genres || []), ...(aniTags || [])];
  const hit = k => TAG_MAP[k].some(g => pool.includes(g));
  return Object.keys(TAG_MAP).filter(hit).slice(0, 4);
};
const mapMoods = (genres, aniTags) => {
  const pool = [...(genres || []), ...(aniTags || [])];
  return Object.keys(MOOD_MAP).filter(k => MOOD_MAP[k].some(g => pool.includes(g))).slice(0, 3);
};

// ── 評分聚合 ───────────────────────────────────────────────
// 步驟：1) 各站算出全體平均與標準差 2) 每部作品轉成 z 分數
//       3) 依評分人數做貝氏收縮 4) 依權重加權平均 5) 換回 10 分制
export function aggregate(items) {
  const sites = Object.keys(SITE_WEIGHTS);

  // 1) 各站分布
  const stats = {};
  for (const s of sites) {
    const xs = items.map(i => i.scores[s]).filter(v => v != null && v > 0);
    if (xs.length < 8) { stats[s] = null; continue; }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
    stats[s] = { mean, sd, n: xs.length };
  }

  for (const it of items) {
    let wsum = 0, zsum = 0, votesTotal = 0;
    const detail = {};
    for (const s of sites) {
      const raw = it.scores[s], v = it.votes[s] || 0;
      if (raw == null || !stats[s]) { detail[s] = null; continue; }
      // 2) z 分數
      const z = (raw - stats[s].mean) / stats[s].sd;
      // 3) 貝氏收縮：人數越少越往該站平均靠
      const C = SITE_CONFIDENCE[s];
      const shrink = v / (v + C);
      const zAdj = z * shrink;
      // 4) 權重＝基礎權重 × 樣本信心
      const w = SITE_WEIGHTS[s] * Math.min(1, Math.log1p(v) / Math.log1p(C));
      wsum += w; zsum += zAdj * w; votesTotal += v;
      detail[s] = { raw: Number(raw.toFixed(2)), votes: v, weight: Number(w.toFixed(3)) };
    }
    if (wsum === 0) { it.combined = null; it.confidence = 0; it.sources = detail; continue; }
    // 正規化權重供前端顯示
    for (const s of sites) if (detail[s]) detail[s].weight = Number((detail[s].weight / wsum).toFixed(3));
    // 5) 換回 10 分制
    const score = SCALE_CENTER + (zsum / wsum) * SCALE_SPREAD;
    it.combined = Number(Math.max(1, Math.min(10, score)).toFixed(2));
    it.confidence = votesTotal;
    it.sources = detail;
  }
  return items;
}

// ── 抓一季 ─────────────────────────────────────────────────
async function buildSeason(year, season) {
  const key = `${year}-${SEASON_KEY[season]}`;
  process.stdout.write(`\n▶ ${key}\n`);

  const items = await fetchAniList(year, season);
  console.log(`   AniList  ${items.length} 部`);
  if (!items.length) return null;

  const mal = await fetchMAL(year, season);
  console.log(`   MAL      ${mal.size} 部有評分`);
  const kitsu = await fetchKitsu(year, season);
  console.log(`   Kitsu    ${kitsu.length} 部有評分`);
  const bgm = await fetchBangumi(year, season);
  console.log(`   Bangumi  ${bgm.length} 部有評分`);

  let imdbHit = 0;
  for (const it of items) {
    // MAL：用 AniList 提供的 idMal 精準對應
    const m = it.malId ? mal.get(it.malId) : null;
    if (m) { it.scores.MyAnimeList = m.score; it.votes.MyAnimeList = m.votes; }

    // Kitsu / Bangumi：標題比對
    const k = matchByTitle(it, kitsu);
    if (k) { it.scores.Kitsu = k.score; it.votes.Kitsu = k.votes; }
    const b = matchByTitle(it, bgm);
    if (b) {
      it.scores.Bangumi = b.score; it.votes.Bangumi = b.votes;
      if (b.titleCn) it.title.zh = b.titleCn;      // 順便取得中文譯名
    }
  }

  // IMDb：只查已完結／播出中的作品（未播出沒有評分），且逐一查詢較慢
  if (OMDB_KEY) {
    for (const it of items) {
      if (it.status === "NOT_YET_RELEASED") continue;
      const r = await fetchIMDb(it.title.en || it.title.romaji, year, OMDB_KEY);
      if (r) { it.scores.IMDb = r.score; it.votes.IMDb = r.votes; it.imdbId = r.imdbId; imdbHit++; }
    }
    console.log(`   IMDb     ${imdbHit} 部比對成功 / ${items.length}`);
  } else {
    console.log("   IMDb     略過（未設定 OMDB_API_KEY）");
  }

  aggregate(items);

  // 整理成前端要的乾淨格式
  const clean = items.map(it => ({
    id: it.anilistId,
    title: { zh: it.title.zh || it.title.en || it.title.romaji, en: it.title.en || it.title.romaji, ja: it.title.ja },
    cover: it.cover, coverColor: it.coverColor,
    year, season: SEASON_KEY[season],
    status: it.status === "FINISHED" ? "finished"
      : it.status === "RELEASING" ? "airing" : "upcoming",
    episodes: it.episodes,
    airedEpisodes: it.airedEpisodes,
    nextAiringAt: it.nextAiringAt,
    startDate: it.startDate,
    studio: it.studio,
    synopsis: it.synopsis,
    tags: mapTags(it.genres, it.aniTags),
    moods: mapMoods(it.genres, it.aniTags),
    split: it.relations.some(r => r.type === "SEQUEL" || r.type === "PREQUEL"),
    score: it.combined,
    votes: it.confidence,
    heat: it.status === "NOT_YET_RELEASED"
      ? Math.min(100, Math.round(Math.log1p(it.popularity) / Math.log1p(120000) * 100)) : null,
    sources: it.sources,
    links: { anilist: `https://anilist.co/anime/${it.anilistId}`, ...it.links },
  })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.heat ?? 0) - (a.heat ?? 0));

  await fs.mkdir(path.join(OUT, "seasons"), { recursive: true });
  await fs.writeFile(path.join(OUT, "seasons", `${key}.json`),
    JSON.stringify({ key, year, season: SEASON_KEY[season], updated: new Date().toISOString(), items: clean }));
  console.log(`   ✔ 已寫入 data/seasons/${key}.json（${clean.length} 部）`);
  return { key, year, season: SEASON_KEY[season], count: clean.length };
}

// ── 主流程 ─────────────────────────────────────────────────
const t0 = Date.now();
const list = targetSeasons();
console.log(`AniRating 資料更新：共 ${list.length} 季${RECENT_ONLY ? "（僅最近）" : ""}`);

const done = [];
for (const { year, season } of list) {
  try {
    const r = await buildSeason(year, season);
    if (r) done.push(r);
  } catch (e) {
    console.log(`   ✖ ${year} ${season} 失敗：${e.message}`);
  }
}

// 合併既有索引（--recent 模式不能覆蓋掉舊季）
let prev = [];
try { prev = JSON.parse(await fs.readFile(path.join(OUT, "index.json"), "utf8")).seasons || []; } catch {}
const merged = [...prev.filter(p => !done.some(d => d.key === p.key)), ...done]
  .sort((a, b) => a.key.localeCompare(b.key));

await fs.writeFile(path.join(OUT, "index.json"), JSON.stringify({
  updated: new Date().toISOString(),
  current: (({ year, season }) => `${year}-${SEASON_KEY[season]}`)(currentSeason()),
  seasons: merged,
}, null, 2));

console.log(`\n完成：${done.length} 季，耗時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
