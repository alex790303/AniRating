// ═══════════════════════════════════════════════════════════
// AniRating 設定檔
// 這是唯一你可能會想手動修改的檔案。改完存檔即可，其他不用動。
// ═══════════════════════════════════════════════════════════

// 要抓幾年的資料。先做近 5 年，之後想補全歷史就把 START_YEAR 改小。
export const START_YEAR = 2021;

// 抓到未來幾季（AniList 通常只有下一季的資料，設 1 就夠）
export const FUTURE_SEASONS = 1;

// 只收錄電視動畫（含短篇）。想加劇場版就把 "MOVIE" 加進來。
export const FORMATS = ["TV", "TV_SHORT"];

// 太冷門的作品不收（AniList 的 popularity 值，約等於清單收錄人數）
// 設 0 = 全收。設 200 可濾掉大量沒人看的作品，讓網站清爽。
export const MIN_POPULARITY = 150;

// ── 各評分站的基礎權重 ────────────────────────────────────
// 權重會再依「該站實際有多少人評分」動態縮放，這裡只是天花板。
// 總和不必等於 1，程式會自動正規化。
export const SITE_WEIGHTS = {
  MyAnimeList: 0.30,   // 樣本數最大
  AniList:     0.24,   // 資料最完整
  Bangumi:     0.22,   // 中文圈視角
  Kitsu:       0.12,
  IMDb:        0.12,   // 比對率約七成，比不到就自動不計
};

// ── 貝氏收縮常數 C ────────────────────────────────────────
// 意思是「評分人數要到多少，這站的分數才算完全可信」。
// 人數遠低於 C 的作品，分數會被拉回該站的平均值。
export const SITE_CONFIDENCE = {
  MyAnimeList: 3000,
  AniList:     2000,
  Bangumi:     300,
  Kitsu:       400,
  IMDb:        800,
};

// ── 綜合分的呈現尺度 ──────────────────────────────────────
export const SCALE_CENTER = 7.0;   // 正規化後的中心分
export const SCALE_SPREAD = 1.05;  // 每 1 個標準差 = 幾分

// ── 標籤對照：把各站的原始 genre 收斂成 14 個大類 ───────────
export const TAG_MAP = {
  action:  ["Action", "Martial Arts", "Super Power", "Military"],
  isekai:  ["Isekai", "Reincarnation"],
  romance: ["Romance", "Shoujo", "Josei", "Harem"],
  slice:   ["Slice of Life", "Iyashikei", "CGDCT"],
  mystery: ["Mystery", "Thriller", "Suspense", "Detective"],
  fantasy: ["Fantasy", "Adventure", "Magic"],
  scifi:   ["Sci-Fi", "Mecha", "Space", "Cyberpunk"],
  sports:  ["Sports", "Team Sports", "Racing"],
  comedy:  ["Comedy", "Parody", "Gag Humor"],
  music:   ["Music", "Idol", "Band"],
  drama:   ["Drama", "Psychological", "Historical"],
  horror:  ["Horror", "Gore", "Survival"],
  school:  ["School", "Coming of Age"],
  food:    ["Food", "Gourmet", "Cooking"],
};

// ── 氛圍標籤：由 AniList 的社群 tag 推導 ────────────────────
export const MOOD_MAP = {
  rush:  ["Shounen", "Male Protagonist", "Super Power"],
  tear:  ["Tragedy", "Emotional", "Bittersweet"],
  brain: ["Psychological", "Philosophy", "Politics", "Time Manipulation"],
  heal:  ["Iyashikei", "Heartwarming", "Slice of Life"],
  dark:  ["Tragedy", "Gore", "Dystopian", "Nihilism"],
  tense: ["Survival", "Suspense", "Battle Royale"],
  art:   ["Achromatic", "Achronological Order"], // 佔位，實際由作畫評價推導
  chill: ["Episodic", "Comedy", "Short Episodes"],
};

// ── 網路禮儀：各站的請求間隔（毫秒）─────────────────────────
// 調太快會被封 IP。這些值是各站官方或社群公認的安全值。
export const DELAYS = {
  anilist: 800,    // 官方限制 90 次/分
  jikan:   1400,   // 官方限制 3 次/秒、60 次/分
  kitsu:   400,
  bangumi: 600,
  omdb:    250,    // 免費金鑰每日 1000 次
};

export const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const SEASON_KEY = { WINTER: "winter", SPRING: "spring", SUMMER: "summer", FALL: "autumn" };
