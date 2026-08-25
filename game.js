// ═══════════════════════════════════════════════════════════
// 🏰 DD Tower Defense - 可愛塔防遊戲
// 馬卡龍風格 × 固定路徑塔防 × Canvas 渲染
// ═══════════════════════════════════════════════════════════

// ─── 0. 全域行動端偵錯日誌系統 ─────────────────
function dbgLog(msg) {
  console.log('[GameLog]', msg);
  const logBox = document.getElementById('debug-log');
  if (logBox) {
    const line = document.createElement('div');
    line.style.borderBottom = '1px dashed #222';
    line.style.padding = '2px 0';
    line.textContent = `[${new Date().toTimeString().split(' ')[0]}] ${msg}`;
    logBox.appendChild(line);
    // children[0] 是固定的標題列，只裁掉超過 50 條的日誌本體
    while (logBox.children.length > 51) {
      logBox.removeChild(logBox.children[1]);
    }
    logBox.scrollTop = logBox.scrollHeight;
  }
}

window.addEventListener('error', (e) => {
  dbgLog(`❌ JS Error: ${e.message} (${e.filename}:${e.lineno})`);
});

window.addEventListener('unhandledrejection', (e) => {
  dbgLog(`❌ Promise Error: ${e.reason}`);
});

// 驗證用共用密鑰，必須跟 devserver.py 啟動時印出來的 token 一致
// （devserver.py 第一次執行會自動產生並存進 .debug_token，之後重跑沿用同一把）
const DEBUG_TOKEN = '1a1e476d6158794f';

// 把 console.log/warn/error 同步轉發到電腦（需搭配 devserver.py 執行）
// 沒有跑 devserver 時 fetch 會失敗，靜默忽略，不影響遊戲本身
(function setupRemoteLog() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  function forward(level, args) {
    const msg = args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); }
      catch (e) { return String(a); }
    }).join(' ');
    fetch('/__log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Token': DEBUG_TOKEN },
      body: JSON.stringify({ level, msg })
    }).catch(() => {});
  }
  ['log', 'warn', 'error'].forEach(level => {
    console[level] = function (...args) {
      orig[level].apply(console, args);
      forward(level, args);
    };
  });
})();

// 截圖上傳到電腦（配合 debug 面板的 📷 按鈕）
function dbgUploadScreenshot() {
  const canvas = document.getElementById('game-canvas');
  if (!canvas) return;
  canvas.toBlob(blob => {
    if (!blob) return;
    fetch('/__upload', { method: 'POST', headers: { 'X-Debug-Token': DEBUG_TOKEN }, body: blob })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        dbgLog('📷 截圖已上傳');
      })
      .catch(() => dbgLog('📷 截圖上傳失敗（devserver 未啟動或 token 不符？）'));
  }, 'image/png');
}

dbgLog('Script loading...');

// ─── 1. 遊戲設定 (總規格 6×8，外圍一圈行徑，中央 4×6 建造) ───────────
const CONFIG = {
  VERSION: 'v1.3.1-dev',
  COLS: 6,
  ROWS: 8,
  CELL_SIZE: 80, // 超大好按格子 (480x640 完美填滿手機螢幕)
  STARTING_GOLD: 200,
  STARTING_LIVES: 20,
  SELL_RATIO: 0.7,
  MAX_LEVEL: 3,
  TOTAL_WAVES: 15,
  LS_KEY: 'dd_tower_defense_best',
};

const CANVAS_W = CONFIG.COLS * CONFIG.CELL_SIZE; // 480
const CANVAS_H = CONFIG.ROWS * CONFIG.CELL_SIZE; // 640

// ─── 2. 多地圖配置數據 (純 6×8 規格，中央 4×6 建造) ──────────
const MAP_CONFIGS = {
  outer_ring: {
    id: 'outer_ring',
    name: '經典外廊 (4×6 建造)',
    desc: '左上 [0,0] 出發繞最外圍一圈至右上 [5,0]，中央 4×6 蓋塔',
    pathType: 'outer',
    cols: 6,
    rows: 8,
    waypoints: [
      [0, 0],
      [0, 7],
      [5, 7],
      [5, 0],
    ],
  },
  serpentine: {
    id: 'serpentine',
    name: '花園小徑 (蛇形路線)',
    desc: '經典蜿蜒路線，適合均衡佈局',
    pathType: 'snake',
    cols: 6,
    rows: 8,
    waypoints: [
      [0, 0],
      [0, 2],
      [5, 2],
      [5, 5],
      [0, 5],
      [0, 7],
      [5, 7],
    ],
  },
  ring: {
    id: 'ring',
    name: '競技之環 (螺旋路線)',
    desc: '外圍環繞一圈，中央為建造平台',
    pathType: 'spiral',
    cols: 6,
    rows: 8,
    waypoints: [
      [0, 0],
      [0, 7],
      [5, 7],
      [5, 2],
      [1, 2],
    ],
  },
};

let CURRENT_MAP_ID = 'outer_ring';
let PATH_WAYPOINTS = MAP_CONFIGS[CURRENT_MAP_ID].waypoints;

// ─── 3. 防禦塔數據 (Group 1: 5 大自然花靈與植物魔法流派) ──────────────────────────
const TOWER_DATA = {
  petal: {
    name: '粉櫻花靈之箭',
    cost: 100,
    range: 120,
    damage: 16,
    fireRate: 1.1,
    projectileSpeed: 320,
    projectileColor: '#ff80ab',
    description: '旋轉五瓣粉櫻 · 翡翠光箭速射',
    color: '#ff80ab',
    levels: [
      { damage: 16, range: 120, fireRate: 1.1 },
      { damage: 26, range: 135, fireRate: 1.3, upgradeCost: 80 },
      { damage: 42, range: 150, fireRate: 1.5, upgradeCost: 160 },
    ],
  },
  sunflower: {
    name: '暖陽向日葵金壇',
    cost: 75,
    range: 0,
    damage: 0,
    fireRate: 0,
    goldPerSecond: 8,
    description: '金黃花瓣 · 定時產出陽光金幣',
    color: '#ffb300',
    levels: [
      { goldPerSecond: 8 },
      { goldPerSecond: 18, upgradeCost: 75 },
      { goldPerSecond: 32, upgradeCost: 150 },
    ],
  },
  lavender: {
    name: '月影薰衣草法杖',
    cost: 220,
    range: 135,
    damage: 28,
    fireRate: 1.0,
    chainCount: 3,
    chainRange: 90,
    projectileSpeed: 420,
    projectileColor: '#ea80fc',
    description: '幽紫薰衣草 · 月光電弧彈射',
    color: '#ab47bc',
    levels: [
      { damage: 28, range: 135, fireRate: 1.0, chainCount: 3 },
      { damage: 45, range: 150, fireRate: 1.2, chainCount: 4, upgradeCost: 160 },
      { damage: 70, range: 165, fireRate: 1.4, chainCount: 5, upgradeCost: 320 },
    ],
  },
  mushroom: {
    name: '魔幻蘑菇孢子壇',
    cost: 180,
    range: 125,
    damage: 15,
    fireRate: 0.9,
    poisonDps: 18,
    poisonDuration: 4.0,
    projectileSpeed: 250,
    projectileColor: '#69f0ae',
    description: '紫斑毒蕈 · 綠霧孢子持續腐蝕',
    color: '#4caf50',
    levels: [
      { damage: 15, range: 125, fireRate: 0.9, poisonDps: 18, poisonDuration: 4.0 },
      { damage: 25, range: 140, fireRate: 1.1, poisonDps: 30, poisonDuration: 5.0, upgradeCost: 140 },
      { damage: 38, range: 155, fireRate: 1.3, poisonDps: 48, poisonDuration: 6.0, upgradeCost: 280 },
    ],
  },
  treant: {
    name: '古木荊棘牢籠',
    cost: 260,
    range: 110,
    damage: 35,
    fireRate: 0.8,
    slowFactor: 0.35,
    slowDuration: 2.5,
    splashRadius: 50,
    projectileSpeed: 260,
    projectileColor: '#795548',
    description: '蒼勁藤木 · 尖刺定身與範圍震裂',
    color: '#795548',
    levels: [
      { damage: 35, range: 110, fireRate: 0.8, slowFactor: 0.35, slowDuration: 2.5, splashRadius: 50 },
      { damage: 55, range: 125, fireRate: 1.0, slowFactor: 0.3, slowDuration: 3.0, splashRadius: 60, upgradeCost: 180 },
      { damage: 85, range: 140, fireRate: 1.2, slowFactor: 0.2, slowDuration: 3.5, splashRadius: 75, upgradeCost: 350 },
    ],
  },
  cannon: {
    name: '熔岩熾火巨砲',
    cost: 300,
    range: 150,
    damage: 60,
    fireRate: 0.6,
    splashRadius: 70,
    projectileSpeed: 300,
    projectileColor: '#ff3d00',
    description: '熾熱熔岩 · 遠程劇烈重砲轟炸',
    color: '#ff3d00',
    levels: [
      { damage: 60, range: 150, fireRate: 0.6, splashRadius: 70 },
      { damage: 95, range: 170, fireRate: 0.75, splashRadius: 85, upgradeCost: 220 },
      { damage: 150, range: 190, fireRate: 0.9, splashRadius: 105, upgradeCost: 400 },
    ],
  },
  ice_crystal: {
    name: '極光霜藍冰晶',
    cost: 150,
    range: 130,
    damage: 12,
    fireRate: 1.2,
    slowFactor: 0.5,
    slowDuration: 3.0,
    piercing: 3,
    projectileSpeed: 380,
    projectileColor: '#40c4ff',
    description: '極地冰晶 · 霜雪穿透與集體凍結',
    color: '#00b0ff',
    levels: [
      { damage: 12, range: 130, fireRate: 1.2, slowFactor: 0.5, slowDuration: 3.0, piercing: 3 },
      { damage: 22, range: 145, fireRate: 1.4, slowFactor: 0.4, slowDuration: 3.5, piercing: 4, upgradeCost: 120 },
      { damage: 38, range: 160, fireRate: 1.7, slowFactor: 0.3, slowDuration: 4.0, piercing: 6, upgradeCost: 240 },
    ],
  },
  laser: {
    name: '星核日光雷射塔',
    cost: 350,
    range: 160,
    damage: 40,
    fireRate: 1.6,
    piercing: 2,
    projectileSpeed: 600,
    projectileColor: '#ffd700',
    description: '高能光核 · 極速穿透高頻雷射',
    color: '#ffc107',
    levels: [
      { damage: 40, range: 160, fireRate: 1.6, piercing: 2 },
      { damage: 65, range: 175, fireRate: 1.9, piercing: 3, upgradeCost: 250 },
      { damage: 105, range: 195, fireRate: 2.2, piercing: 4, upgradeCost: 450 },
    ],
  },
};

// ─── 4. 敵人數據 ─────────────────────────────
const ENEMY_DATA = {
  caterpillar: { name: '毛毛蟲', emoji: '🐛', hp: 60, speed: 50, reward: 10, damage: 1 },
  bee: { name: '蜜蜂', emoji: '🐝', hp: 40, speed: 90, reward: 12, damage: 1, canEnrage: true },
  snail: { name: '蝸牛', emoji: '🐌', hp: 190, speed: 28, reward: 25, damage: 2 },
  beetle: { name: '鐵甲甲蟲', emoji: '🪲', hp: 320, speed: 38, reward: 35, damage: 2, armor: 0.25 },
  butterfly: { name: '蝴蝶', emoji: '🦋', hp: 95, speed: 65, reward: 18, damage: 1, canEnrage: true },
  dragon: { name: '小龍', emoji: '🐉', hp: 550, speed: 32, reward: 100, damage: 5, isBoss: true },
};

// ─── 5. 各關卡波次數據 (每關 15 波，難度各自獨立設計) ─────────────────────
// 第一關：沿用原本已調校過的新手曲線，原封不動
const WAVE_DATA_L1 = [
  { enemies: [{ type: 'caterpillar', count: 5, interval: 1.5 }], bonus: 50 },
  { enemies: [{ type: 'caterpillar', count: 8, interval: 1.2 }], bonus: 60 },
  { enemies: [{ type: 'caterpillar', count: 5, interval: 1.0 }, { type: 'bee', count: 3, interval: 0.8 }], bonus: 80 },
  { enemies: [{ type: 'bee', count: 10, interval: 0.7 }], bonus: 90 },
  { enemies: [{ type: 'caterpillar', count: 6, interval: 0.8 }, { type: 'snail', count: 2, interval: 2.5 }], bonus: 120 },
  { enemies: [{ type: 'bee', count: 8, interval: 0.5 }, { type: 'beetle', count: 2, interval: 2.0 }], bonus: 130 },
  { enemies: [{ type: 'butterfly', count: 6, interval: 0.8 }, { type: 'bee', count: 5, interval: 0.6 }], bonus: 150 },
  { enemies: [{ type: 'snail', count: 4, interval: 1.8 }, { type: 'beetle', count: 3, interval: 1.5 }], bonus: 170 },
  { enemies: [{ type: 'bee', count: 15, interval: 0.35 }, { type: 'butterfly', count: 6, interval: 0.5 }], bonus: 180 },
  { enemies: [{ type: 'dragon', count: 1, interval: 3 }, { type: 'beetle', count: 3, interval: 1.2 }, { type: 'caterpillar', count: 8, interval: 0.6 }], bonus: 250 },
  { enemies: [{ type: 'butterfly', count: 12, interval: 0.4 }, { type: 'beetle', count: 5, interval: 1.0 }], bonus: 220 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.25 }, { type: 'butterfly', count: 8, interval: 0.4 }], bonus: 240 },
  { enemies: [{ type: 'snail', count: 8, interval: 0.8 }, { type: 'dragon', count: 1, interval: 4 }], bonus: 280 },
  { enemies: [{ type: 'beetle', count: 8, interval: 0.6 }, { type: 'butterfly', count: 12, interval: 0.3 }, { type: 'snail', count: 6, interval: 0.6 }], bonus: 320 },
  { enemies: [{ type: 'dragon', count: 3, interval: 4 }, { type: 'beetle', count: 6, interval: 0.8 }, { type: 'butterfly', count: 10, interval: 0.3 }, { type: 'bee', count: 15, interval: 0.15 }], bonus: 500 },
];

// 第二關：中階怪提前出場、間隔壓縮、龍波次變多（共 4 波含龍，總龍數 8 隻）
const WAVE_DATA_L2 = [
  { enemies: [{ type: 'caterpillar', count: 8, interval: 1.2 }], bonus: 60 },
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.9 }, { type: 'bee', count: 4, interval: 0.7 }], bonus: 70 },
  { enemies: [{ type: 'bee', count: 10, interval: 0.55 }, { type: 'snail', count: 3, interval: 2.0 }], bonus: 100 },
  { enemies: [{ type: 'bee', count: 12, interval: 0.45 }, { type: 'beetle', count: 3, interval: 1.6 }], bonus: 120 },
  { enemies: [{ type: 'caterpillar', count: 6, interval: 0.6 }, { type: 'snail', count: 4, interval: 1.6 }, { type: 'beetle', count: 3, interval: 1.4 }], bonus: 150 },
  { enemies: [{ type: 'bee', count: 12, interval: 0.4 }, { type: 'beetle', count: 5, interval: 1.2 }], bonus: 170 },
  { enemies: [{ type: 'butterfly', count: 8, interval: 0.5 }, { type: 'bee', count: 10, interval: 0.4 }], bonus: 190 },
  { enemies: [{ type: 'snail', count: 6, interval: 1.3 }, { type: 'beetle', count: 6, interval: 1.0 }, { type: 'dragon', count: 1, interval: 3 }], bonus: 260 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.25 }, { type: 'butterfly', count: 10, interval: 0.35 }], bonus: 230 },
  { enemies: [{ type: 'dragon', count: 1, interval: 3 }, { type: 'beetle', count: 6, interval: 0.9 }, { type: 'caterpillar', count: 10, interval: 0.45 }], bonus: 320 },
  { enemies: [{ type: 'butterfly', count: 16, interval: 0.28 }, { type: 'beetle', count: 8, interval: 0.7 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 26, interval: 0.18 }, { type: 'butterfly', count: 12, interval: 0.28 }], bonus: 300 },
  { enemies: [{ type: 'snail', count: 10, interval: 0.6 }, { type: 'dragon', count: 2, interval: 3.2 }], bonus: 380 },
  { enemies: [{ type: 'beetle', count: 10, interval: 0.5 }, { type: 'butterfly', count: 16, interval: 0.25 }, { type: 'snail', count: 8, interval: 0.5 }], bonus: 420 },
  { enemies: [{ type: 'dragon', count: 4, interval: 3.5 }, { type: 'beetle', count: 8, interval: 0.6 }, { type: 'butterfly', count: 14, interval: 0.22 }, { type: 'bee', count: 20, interval: 0.12 }], bonus: 600 },
];

// 第三關：從第 1 波就混編各種怪，龍最早第 7 波出現（共 4 波含龍，總龍數 11 隻）
const WAVE_DATA_L3 = [
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.9 }, { type: 'bee', count: 3, interval: 1.0 }], bonus: 70 },
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.7 }, { type: 'bee', count: 6, interval: 0.6 }, { type: 'snail', count: 2, interval: 2.0 }], bonus: 90 },
  { enemies: [{ type: 'bee', count: 12, interval: 0.45 }, { type: 'snail', count: 4, interval: 1.6 }, { type: 'beetle', count: 2, interval: 1.6 }], bonus: 130 },
  { enemies: [{ type: 'bee', count: 14, interval: 0.35 }, { type: 'beetle', count: 4, interval: 1.3 }, { type: 'butterfly', count: 4, interval: 0.8 }], bonus: 150 },
  { enemies: [{ type: 'caterpillar', count: 8, interval: 0.5 }, { type: 'snail', count: 5, interval: 1.4 }, { type: 'beetle', count: 4, interval: 1.1 }], bonus: 190 },
  { enemies: [{ type: 'bee', count: 16, interval: 0.3 }, { type: 'beetle', count: 6, interval: 1.0 }, { type: 'butterfly', count: 6, interval: 0.6 }], bonus: 210 },
  { enemies: [{ type: 'butterfly', count: 10, interval: 0.4 }, { type: 'bee', count: 14, interval: 0.32 }, { type: 'dragon', count: 1, interval: 3 }], bonus: 300 },
  { enemies: [{ type: 'snail', count: 8, interval: 1.1 }, { type: 'beetle', count: 8, interval: 0.8 }, { type: 'bee', count: 10, interval: 0.35 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 24, interval: 0.2 }, { type: 'butterfly', count: 14, interval: 0.28 }, { type: 'beetle', count: 4, interval: 0.9 }], bonus: 320 },
  { enemies: [{ type: 'dragon', count: 2, interval: 2.8 }, { type: 'beetle', count: 8, interval: 0.7 }, { type: 'caterpillar', count: 12, interval: 0.35 }], bonus: 420 },
  { enemies: [{ type: 'butterfly', count: 20, interval: 0.22 }, { type: 'beetle', count: 10, interval: 0.6 }, { type: 'snail', count: 6, interval: 0.9 }], bonus: 380 },
  { enemies: [{ type: 'bee', count: 30, interval: 0.15 }, { type: 'butterfly', count: 16, interval: 0.22 }, { type: 'beetle', count: 6, interval: 0.6 }], bonus: 420 },
  { enemies: [{ type: 'snail', count: 12, interval: 0.5 }, { type: 'dragon', count: 3, interval: 2.8 }, { type: 'beetle', count: 8, interval: 0.5 }], bonus: 500 },
  { enemies: [{ type: 'beetle', count: 14, interval: 0.4 }, { type: 'butterfly', count: 20, interval: 0.2 }, { type: 'snail', count: 10, interval: 0.42 }, { type: 'bee', count: 16, interval: 0.15 }], bonus: 560 },
  { enemies: [{ type: 'dragon', count: 5, interval: 3.0 }, { type: 'beetle', count: 12, interval: 0.45 }, { type: 'butterfly', count: 20, interval: 0.18 }, { type: 'bee', count: 26, interval: 0.1 }], bonus: 800 },
];

// ─── 5.1 關卡定義：地圖 + 專屬波次，取代原本的自由選地圖 ─────
// hpMultiplier：難度成長改成「換關卡」才提高血量，同一關卡內每一波不再額外疊加
const LEVEL_DATA = [
  { id: 'level_1', name: '第一關・晨光花園', mapId: 'outer_ring', waves: WAVE_DATA_L1, hpMultiplier: 1.0 },
  { id: 'level_2', name: '第二關・迷霧小徑', mapId: 'serpentine', waves: WAVE_DATA_L2, hpMultiplier: 1.3 },
  { id: 'level_3', name: '第三關・競技之環', mapId: 'ring', waves: WAVE_DATA_L3, hpMultiplier: 1.6 },
];
let CURRENT_LEVEL_INDEX = 0;

// ─── 5.2 關卡進度存檔 (解鎖狀態 + 星等，只增不減) ─────
const LEVEL_PROGRESS_KEY = 'dd_td_level_progress_v1';
let _levelProgressMemoryFallback = null; // 無痕模式/配額滿時的記憶體備援

function defaultLevelProgress() {
  const levels = {};
  LEVEL_DATA.forEach((lvl, idx) => {
    levels[lvl.id] = { stars: 0, unlocked: idx === 0 };
  });
  return { version: 1, levels };
}

function loadLevelProgress() {
  try {
    const raw = localStorage.getItem(LEVEL_PROGRESS_KEY);
    if (!raw) return _levelProgressMemoryFallback || defaultLevelProgress();
    const data = JSON.parse(raw);
    if (!data || !data.levels) return defaultLevelProgress();
    // 確保新增的關卡在舊存檔上也有預設值
    LEVEL_DATA.forEach((lvl, idx) => {
      if (!data.levels[lvl.id]) data.levels[lvl.id] = { stars: 0, unlocked: idx === 0 };
    });
    return data;
  } catch (e) {
    return _levelProgressMemoryFallback || defaultLevelProgress();
  }
}

function saveLevelProgress(data) {
  _levelProgressMemoryFallback = data;
  try {
    localStorage.setItem(LEVEL_PROGRESS_KEY, JSON.stringify(data));
  } catch (e) {
    dbgLog('⚠️ 關卡進度存檔失敗（可能為無痕模式或配額已滿），本次僅暫存於記憶體');
  }
}

// 記錄一次關卡結果：星等只增不減，通關（stars>=1）解鎖下一關。
// 每次「首度達成」某星等門檻會發放一次寶箱水晶獎勵（重玩補到已經拿過的星數不會重複給）。
function recordLevelResult(levelIndex, stars) {
  const level = LEVEL_DATA[levelIndex];
  if (!level) return { crystalsEarned: 0 };
  const progress = loadLevelProgress();
  const entry = progress.levels[level.id] || { stars: 0, unlocked: levelIndex === 0 };
  const previousStars = entry.stars;
  const newStars = Math.max(previousStars, stars);

  let crystalsEarned = 0;
  for (let tier = previousStars + 1; tier <= newStars; tier++) {
    crystalsEarned += CHEST_REWARDS[tier - 1] || 0;
  }

  entry.stars = newStars;
  if (stars >= 1) {
    entry.unlocked = true;
    const nextLevel = LEVEL_DATA[levelIndex + 1];
    if (nextLevel) {
      progress.levels[nextLevel.id] = progress.levels[nextLevel.id] || { stars: 0, unlocked: false };
      progress.levels[nextLevel.id].unlocked = true;
    }
  }
  progress.levels[level.id] = entry;
  saveLevelProgress(progress);

  if (crystalsEarned > 0) addCrystals(crystalsEarned);
  return { entry, crystalsEarned };
}

// 測試用：直接把關卡進度設成「通關到第 clearedThroughIndex 關、拿 starsOnLast 星」
// clearedThroughIndex 傳 -1 代表重置成「尚未通關任何關卡」
function debugApplyLevelProgress(clearedThroughIndex, starsOnLast) {
  const levels = {};
  LEVEL_DATA.forEach((lvl, idx) => {
    if (clearedThroughIndex < 0) {
      levels[lvl.id] = { stars: 0, unlocked: idx === 0 };
    } else if (idx < clearedThroughIndex) {
      levels[lvl.id] = { stars: 3, unlocked: true };
    } else if (idx === clearedThroughIndex) {
      levels[lvl.id] = { stars: starsOnLast, unlocked: true };
    } else if (idx === clearedThroughIndex + 1) {
      levels[lvl.id] = { stars: 0, unlocked: true };
    } else {
      levels[lvl.id] = { stars: 0, unlocked: false };
    }
  });
  saveLevelProgress({ version: 1, levels });
  CURRENT_LEVEL_INDEX = Math.max(0, clearedThroughIndex);
  if (window.gameInstance && window.gameInstance.renderLevelCarousel) {
    window.gameInstance.renderLevelCarousel();
  }
  dbgLog(`🧪 測試進度已套用：clearedThroughIndex=${clearedThroughIndex}, starsOnLast=${starsOnLast}`);
}
window.dbgApplyLevelProgress = debugApplyLevelProgress;

// ─── 5.3 商店：永久貨幣、塔與技能解鎖 ─────────────────
// 一開始就能用的塔（不用商店解鎖）；其餘的塔與 2 個主動技能都要用「魔法水晶」在商店解鎖
const FREE_STARTER_TOWERS = ['petal'];

const SHOP_ITEMS = {
  towers: {
    sunflower: { cost: 30 },
    ice_crystal: { cost: 40 },
    mushroom: { cost: 45 },
    lavender: { cost: 55 },
    treant: { cost: 65 },
    cannon: { cost: 75 },
    laser: { cost: 90 },
  },
  skills: {
    meteor: { cost: 50, name: '流星轟炸', desc: '對指定範圍造成大量爆炸傷害，冷卻 30 秒' },
    freeze: { cost: 50, name: '絕對零度', desc: '全場敵人短暫凍結減速，冷卻 45 秒' },
  },
};

// 方案一：魔導卡牌矩陣元數據 (包含圖示、定位標籤、機制解說與三圍數值)
const SHOP_METADATA = {
  petal: {
    kind: 'tower',
    icon: 'assets/towers/tower_petal.svg',
    badges: [{ text: '🎯 基礎速射', type: 'pierce' }, { text: '🏹 單體點殺', type: 'pierce' }],
    desc: '翡翠光箭高速射擊，適合前中期平穩過渡與快速擊落飛行蜜蜂。',
    stats: { dmg: '16', range: '120', rate: '1.1/s' },
  },
  sunflower: {
    kind: 'tower',
    icon: 'assets/towers/tower_sunflower.svg',
    badges: [{ text: '💰 產金 +8/s', type: 'econ' }, { text: '📈 經濟核心', type: 'econ' }],
    desc: '不進行攻擊，每秒定時產出 +8 陽光金幣，升級大幅增加金幣產能，越早蓋越賺。',
    stats: { dmg: '0', range: '-', rate: '產金 +8/s' },
  },
  ice_crystal: {
    kind: 'tower',
    icon: 'assets/towers/tower_ice_crystal.svg',
    badges: [{ text: '🧊 霜凍減速 50%', type: 'slow' }, { text: '✨ 貫穿 3 體', type: 'pierce' }],
    desc: '發射極寒冰晶貫穿前排 3 隻敵人，命中附加 50% 緩速持續 3 秒，聚怪控場核心。',
    stats: { dmg: '12', range: '130', rate: '1.2/s' },
  },
  mushroom: {
    kind: 'tower',
    icon: 'assets/towers/tower_mushroom.svg',
    badges: [{ text: '🧪 劇毒腐蝕', type: 'poison' }, { text: '🛡️ 無視護甲', type: 'poison' }],
    desc: '噴灑劇毒綠霧孢子，每秒造成 18 點無視防禦的真實毒傷持續 4 秒，重裝鐵甲剋星。',
    stats: { dmg: '15', range: '125', rate: '0.9/s' },
  },
  lavender: {
    kind: 'tower',
    icon: 'assets/towers/tower_lavender.svg',
    badges: [{ text: '⚡ 電弧連鎖 3 體', type: 'chain' }, { text: '🌊 群怪剋星', type: 'chain' }],
    desc: '釋放月光電弧在多個目標間彈射跳躍，清繳密集蟲群與蝙蝠蜂潮極度高效。',
    stats: { dmg: '28', range: '135', rate: '1.0/s' },
  },
  treant: {
    kind: 'tower',
    icon: 'assets/towers/tower_treant.svg',
    badges: [{ text: '⛓️ 劇烈緩速 65%', type: 'slow' }, { text: '💥 範圍重壓', type: 'aoe' }],
    desc: '重砸蒼勁藤木，對範圍內敵人造成 65% 強力緩速與定身，並引發地面物理震裂。',
    stats: { dmg: '35', range: '110', rate: '0.8/s' },
  },
  cannon: {
    kind: 'tower',
    icon: 'assets/towers/tower_cannon.svg',
    badges: [{ text: '💥 70px 範圍轟炸', type: 'aoe' }, { text: '🔥 毀滅高傷', type: 'aoe' }],
    desc: '拋射高溫熔岩砲彈，落地引發大範圍劇烈爆炸，擁有全遊戲最高單發物理面傷。',
    stats: { dmg: '60', range: '150', rate: '0.6/s' },
  },
  laser: {
    kind: 'tower',
    icon: 'assets/towers/tower_laser.svg',
    badges: [{ text: '⚡ 極速高頻', type: 'pierce' }, { text: '📏 直線貫穿', type: 'pierce' }],
    desc: '超高頻率 (1.6/s) 聚能光束，射線貫穿直線上所有敵人，放置於長走廊傷害最大化。',
    stats: { dmg: '40', range: '160', rate: '1.6/s' },
  },
  meteor: {
    kind: 'skill',
    icon: 'assets/skills/skill_meteor.svg',
    badges: [{ text: '🌋 全圖自選轟炸', type: 'skill' }, { text: '⏱️ 冷卻 30s', type: 'skill' }],
    desc: '召喚天外熾熱流星群，對指定圓形區域造成毀滅性 350 點範圍爆炸傷害。',
    stats: { dmg: '350', range: '全圖選點', rate: 'CD 30s' },
  },
  freeze: {
    kind: 'skill',
    icon: 'assets/skills/skill_freeze.svg',
    badges: [{ text: '🧊 全場定身凍結', type: 'skill' }, { text: '⏱️ 冷卻 45s', type: 'skill' }],
    desc: '降下極地暴風雪，強制全場所有移動中的敵人減速 80% 並冰凍定身 3.5 秒。',
    stats: { dmg: '50', range: '全場敵人', rate: 'CD 45s' },
  }
};

function getShopBadgeClass(type) {
  switch (type) {
    case 'slow': return 'badge-slow';
    case 'poison': return 'badge-poison';
    case 'chain': return 'badge-chain';
    case 'aoe': return 'badge-aoe';
    case 'pierce': return 'badge-pierce';
    case 'econ': return 'badge-econ';
    case 'skill': return 'badge-skill';
    default: return 'badge-pierce';
  }
}

// 通關關卡「首度達成」1★/2★/3★ 各發放一次的水晶獎勵（寶箱）
const CHEST_REWARDS = [10, 20, 40];

const CRYSTALS_KEY = 'dd_td_crystals_v1';
let _crystalsMemoryFallback = null;

function loadCrystals() {
  try {
    const raw = localStorage.getItem(CRYSTALS_KEY);
    if (raw === null) return _crystalsMemoryFallback ?? 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return _crystalsMemoryFallback ?? 0;
  }
}

function saveCrystals(n) {
  _crystalsMemoryFallback = n;
  try {
    localStorage.setItem(CRYSTALS_KEY, String(n));
  } catch (e) {
    dbgLog('⚠️ 水晶存檔失敗（可能為無痕模式或配額已滿），本次僅暫存於記憶體');
  }
}

function addCrystals(n) {
  const total = loadCrystals() + n;
  saveCrystals(total);
  return total;
}

const UNLOCKS_KEY = 'dd_td_unlocks_v1';
let _unlocksMemoryFallback = null;

function defaultUnlocks() {
  return { towers: [...FREE_STARTER_TOWERS], skills: [] };
}

function loadUnlocks() {
  try {
    const raw = localStorage.getItem(UNLOCKS_KEY);
    if (!raw) return _unlocksMemoryFallback || defaultUnlocks();
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.towers) || !Array.isArray(data.skills)) return defaultUnlocks();
    return data;
  } catch (e) {
    return _unlocksMemoryFallback || defaultUnlocks();
  }
}

function saveUnlocks(data) {
  _unlocksMemoryFallback = data;
  try {
    localStorage.setItem(UNLOCKS_KEY, JSON.stringify(data));
  } catch (e) {
    dbgLog('⚠️ 解鎖狀態存檔失敗（可能為無痕模式或配額已滿），本次僅暫存於記憶體');
  }
}

function isTowerUnlocked(typeKey) {
  if (FREE_STARTER_TOWERS.includes(typeKey)) return true;
  return loadUnlocks().towers.includes(typeKey);
}

function isSkillUnlocked(skillKey) {
  return loadUnlocks().skills.includes(skillKey);
}

// 用水晶購買永久解鎖一座塔；回傳 { ok, reason? }
function purchaseTower(typeKey) {
  const item = SHOP_ITEMS.towers[typeKey];
  if (!item) return { ok: false, reason: 'not-found' };
  if (isTowerUnlocked(typeKey)) return { ok: false, reason: 'already-unlocked' };
  const balance = loadCrystals();
  if (balance < item.cost) return { ok: false, reason: 'insufficient' };
  saveCrystals(balance - item.cost);
  const unlocks = loadUnlocks();
  unlocks.towers.push(typeKey);
  saveUnlocks(unlocks);
  return { ok: true };
}

// 用水晶購買永久解鎖一個主動技能；回傳 { ok, reason? }
function purchaseSkill(skillKey) {
  const item = SHOP_ITEMS.skills[skillKey];
  if (!item) return { ok: false, reason: 'not-found' };
  if (isSkillUnlocked(skillKey)) return { ok: false, reason: 'already-unlocked' };
  const balance = loadCrystals();
  if (balance < item.cost) return { ok: false, reason: 'insufficient' };
  saveCrystals(balance - item.cost);
  const unlocks = loadUnlocks();
  unlocks.skills.push(skillKey);
  saveUnlocks(unlocks);
  return { ok: true };
}

// ─── 5.5 Canvas 手繪角色系統 ─────────────────
const Sprites = {
  // 通用立體水汪汪萌系臉蛋
  drawFace: function(ctx, eyeOffsetY = -2) {
    ctx.save();
    // 腮紅
    ctx.fillStyle = 'rgba(255, 105, 180, 0.45)';
    ctx.beginPath(); ctx.ellipse(-7, eyeOffsetY + 5, 3.5, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(7, eyeOffsetY + 5, 3.5, 2, 0, 0, Math.PI * 2); ctx.fill();

    // 黑色大眼珠
    ctx.fillStyle = '#1a1a24';
    ctx.beginPath(); ctx.arc(-5, eyeOffsetY, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(5, eyeOffsetY, 2.5, 0, Math.PI * 2); ctx.fill();

    // 晶亮高光小白點
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-5.8, eyeOffsetY - 0.8, 1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(4.2, eyeOffsetY - 0.8, 1, 0, Math.PI * 2); ctx.fill();

    // 可愛微笑嘴巴
    ctx.strokeStyle = '#4a2810';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, eyeOffsetY + 3, 2, 0.2, Math.PI - 0.2, false); ctx.stroke();
    ctx.restore();
  },

  // 1. 粉櫻花靈之箭 (Sakura Archer - 1號設計：白石蓮花座 + 翡翠藤蔓 + 五瓣粉櫻 + 懸浮翡翠光箭)
  drawTower_petal: function(ctx, time) {
    ctx.save();
    const pulse = 1 + Math.sin(time * 3.5) * 0.03;
    ctx.scale(pulse, pulse);

    // 1. 白石金紋蓮花底座
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffa726';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(-16, 8, 32, 8, 3);
    ctx.fill();
    ctx.stroke();

    // 2. 翡翠生命藤蔓主幹
    ctx.fillStyle = '#66bb6a';
    ctx.fillRect(-3.5, -4, 7, 14);

    // 3. 旋轉五瓣粉櫻花冠
    ctx.save();
    ctx.translate(0, -10);
    ctx.rotate(time * 0.35);
    for (let i = 0; i < 5; i++) {
      ctx.rotate((Math.PI * 2) / 5);
      // 粉櫻漸層花瓣
      const grad = ctx.createLinearGradient(0, -14, 0, 0);
      grad.addColorStop(0, '#ff4081');
      grad.addColorStop(0.6, '#ff80ab');
      grad.addColorStop(1, '#ffcdd2');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, -9, 5.5, 9, 0, 0, Math.PI * 2);
      ctx.fill();

      // 花瓣白色高光中脈
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(0, -3);
      ctx.stroke();
    }
    ctx.restore();

    // 4. 黃金核心花蕊
    const coreGrad = ctx.createRadialGradient(-2, -12, 1, 0, -10, 8);
    coreGrad.addColorStop(0, '#fff9c4');
    coreGrad.addColorStop(0.6, '#ffd54f');
    coreGrad.addColorStop(1, '#ffb300');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, -10, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffa000';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 5. 頂端懸浮翡翠光之箭矢 (隨時間上下呼吸浮動)
    const arrowBob = Math.sin(time * 6) * 2;
    ctx.shadowColor = '#00e676';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#00e676';
    ctx.beginPath();
    ctx.moveTo(0, -28 + arrowBob);
    ctx.lineTo(4, -20 + arrowBob);
    ctx.lineTo(-4, -20 + arrowBob);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  },

  // 2. 暖陽向日葵金壇 (Golden Sunflower - 2號設計)
  drawTower_sunflower: function(ctx, time) {
    ctx.save();
    const sway = Math.sin(time * 2.5) * 0.06;
    ctx.rotate(sway);

    // 花盆底座
    ctx.fillStyle = '#fff8e1'; ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-14, 18); ctx.lineTo(14, 18); ctx.lineTo(10, 6); ctx.lineTo(-10, 6); ctx.closePath(); ctx.fill(); ctx.stroke();

    // 向日葵金瓣
    ctx.save();
    ctx.translate(0, -6);
    ctx.rotate(time * 0.15);
    ctx.fillStyle = '#ffca28';
    for (let i = 0; i < 8; i++) {
      ctx.rotate((Math.PI * 2) / 8);
      ctx.beginPath(); ctx.ellipse(0, -11, 4.5, 7, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 焦糖花盤
    ctx.fillStyle = '#6d4c41'; ctx.beginPath(); ctx.arc(0, -6, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 1.2; ctx.stroke();

    // 頂端懸浮金幣
    const coinBob = Math.sin(time * 5) * 1.5;
    ctx.fillStyle = '#ffd54f'; ctx.strokeStyle = '#ff8f00'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(0, -24 + coinBob, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    ctx.restore();
  },

  // 3. 月影薰衣草法杖 (Lavender Arcane - 3號設計)
  drawTower_lavender: function(ctx, time) {
    ctx.save();
    const sway = Math.sin(time * 3) * 0.05;
    ctx.rotate(sway);

    // 圓盤底座
    ctx.fillStyle = '#ede7f6'; ctx.strokeStyle = '#b39ddb'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, 14, 16, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // 木質法杖主幹
    ctx.fillStyle = '#8d6e63'; ctx.fillRect(-2.5, -12, 5, 24);

    // 薰衣草水晶花苞
    const lavs = [
      { x: 0, y: -22, r: 6.5, c: '#ab47bc' },
      { x: -6, y: -15, r: 5.5, c: '#7e57c2' },
      { x: 6, y: -15, r: 5.5, c: '#ba68c8' }
    ];
    for (const l of lavs) {
      ctx.fillStyle = l.c; ctx.beginPath(); ctx.arc(l.x, l.y, l.r, 0, Math.PI * 2); ctx.fill();
    }

    // 月光守護電弧環
    ctx.strokeStyle = '#ea80fc'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, -18, 14, Math.PI * 0.7, Math.PI * 2.3); ctx.stroke();

    ctx.restore();
  },

  // 4. 魔幻蘑菇孢子壇 (Spore Shroom - 4號設計)
  drawTower_mushroom: function(ctx, time) {
    ctx.save();
    const squish = 1 + Math.sin(time * 3) * 0.04;
    ctx.scale(squish, 2 - squish);

    // 古木樹樁座
    ctx.fillStyle = '#6d4c41'; ctx.beginPath(); ctx.roundRect(-15, 3, 30, 14, 4); ctx.fill();

    // 主菌傘 (紫斑毒蕈)
    ctx.fillStyle = '#f5f5f5'; ctx.fillRect(-5, -6, 10, 10);
    ctx.fillStyle = '#ab47bc'; ctx.beginPath(); ctx.arc(0, -8, 15, Math.PI, 0); ctx.fill();
    // 蘑菇白斑
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-6, -13, 2.5, 0, Math.PI * 2); ctx.arc(6, -13, 2.5, 0, Math.PI * 2); ctx.arc(0, -18, 3, 0, Math.PI * 2); ctx.fill();

    // 旁生小青蕈
    ctx.fillStyle = '#4caf50'; ctx.beginPath(); ctx.arc(11, 2, 6.5, Math.PI, 0); ctx.fill();

    // 綠色劇毒螢光微粒 (呼吸光暈)
    const glowAlpha = 0.5 + Math.sin(time * 6) * 0.4;
    ctx.fillStyle = `rgba(105, 240, 174, ${glowAlpha})`;
    ctx.beginPath(); ctx.arc(-2, -26, 2, 0, Math.PI * 2); ctx.arc(4, -23, 1.8, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  },

  // 5. 古木荊棘牢籠 (Thorn Treant - 5號設計)
  drawTower_treant: function(ctx, time) {
    ctx.save();
    const pulse = 1 + Math.sin(time * 2) * 0.03;
    ctx.scale(pulse, pulse);

    // 大地泥座
    ctx.fillStyle = '#795548'; ctx.beginPath(); ctx.ellipse(0, 15, 18, 6, 0, 0, Math.PI * 2); ctx.fill();

    // 扭曲蒼勁樹幹
    ctx.fillStyle = '#4e342e';
    ctx.beginPath();
    ctx.moveTo(-7, 15); ctx.quadraticCurveTo(7, 0, -5, -20);
    ctx.lineTo(5, -20); ctx.quadraticCurveTo(-5, 0, 7, 15);
    ctx.closePath(); ctx.fill();

    // 荊棘利刺
    ctx.fillStyle = '#2e7d32';
    const thorns = [[-8, 3], [8, -3], [-6, -12], [6, -15]];
    for (const p of thorns) {
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] * 1.5, p[1] - 3); ctx.lineTo(p[0], p[1] - 5); ctx.closePath(); ctx.fill();
    }

    // 核心綠晶光芒
    ctx.fillStyle = '#66bb6a'; ctx.beginPath(); ctx.arc(0, -6, 3.5, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  },

  // 6. 熔岩熾火巨砲 (Volcanic Cannon)
  drawTower_cannon: function(ctx, time) {
    ctx.save();
    // 鋼鐵重砲基座
    ctx.fillStyle = '#37474f'; ctx.beginPath(); ctx.ellipse(0, 14, 19, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#455a64'; ctx.fillRect(-12, 0, 24, 14);
    // 巨型砲管
    ctx.fillStyle = '#263238'; ctx.fillRect(-8, -18, 16, 20);
    ctx.fillStyle = '#ff3d00'; ctx.fillRect(-9, -22, 18, 5); // 砲口赤紅熱浪
    // 熾熱熔岩核心脈動
    const glow = 0.5 + Math.sin(time * 8) * 0.5;
    ctx.fillStyle = `rgba(255, 112, 67, ${glow})`;
    ctx.beginPath(); ctx.arc(0, -2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },

  // 7. 極光霜藍冰晶 (Aurora Ice Crystal)
  drawTower_ice_crystal: function(ctx, time) {
    ctx.save();
    const floatY = Math.sin(time * 3) * 3;
    ctx.translate(0, floatY);
    // 霜雪寒冰底陣
    ctx.fillStyle = 'rgba(64, 196, 255, 0.2)'; ctx.beginPath(); ctx.ellipse(0, 16 - floatY, 18, 6, 0, 0, Math.PI * 2); ctx.fill();
    // 多稜晶石主體
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(12, -4); ctx.lineTo(0, 10); ctx.lineTo(-12, -4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e0f7fa';
    ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(6, -4); ctx.lineTo(0, 10); ctx.closePath(); ctx.fill();
    // 冰晶星芒
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -28); ctx.lineTo(0, 14); ctx.moveTo(-16, -7); ctx.lineTo(16, -7); ctx.stroke();
    ctx.restore();
  },

  // 8. 星核日光雷射塔 (Solar Core Laser)
  drawTower_laser: function(ctx, time) {
    ctx.save();
    const rot = time * 2;
    // 科技金屬底座
    ctx.fillStyle = '#212121'; ctx.beginPath(); ctx.ellipse(0, 14, 20, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#424242'; ctx.beginPath(); ctx.arc(0, 6, 14, Math.PI, 0); ctx.fill();
    // 懸浮黃金日光光環
    ctx.save();
    ctx.translate(0, -10);
    ctx.rotate(rot);
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // 核心日光聚能球
    ctx.fillStyle = '#fff176'; ctx.beginPath(); ctx.arc(0, -10, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-2, -12, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },

  // ─── 怪物立體繪製 (Q 版輕量幾何 Sprite) ──────────────────────────

  // 小皇冠輔助
  drawMiniCrown: function(ctx, ox, oy) {
    ctx.save();
    ctx.fillStyle = '#ffd600';
    ctx.strokeStyle = '#e65100';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(ox - 6, oy + 3); ctx.lineTo(ox - 6, oy - 3);
    ctx.lineTo(ox - 3, oy);     ctx.lineTo(ox, oy - 4);
    ctx.lineTo(ox + 3, oy);     ctx.lineTo(ox + 6, oy - 3);
    ctx.lineTo(ox + 6, oy + 3); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ff1744';
    ctx.beginPath(); ctx.arc(ox, oy - 4, 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },

  // 1. 毛毛蟲
  drawEnemy_caterpillar: function(ctx, time, isBoss) {
    ctx.save();
    const w1 = Math.sin(time * 8) * 1.5;
    const w2 = Math.sin(time * 8 - 1) * 1.5;
    const w3 = Math.sin(time * 8 - 2) * 1.5;

    if (isBoss) {
      const seg = (cx, cy, r) => {
        const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
        g.addColorStop(0, '#fffde7'); g.addColorStop(0.5, '#ffd600'); g.addColorStop(1, '#e65100');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1; ctx.stroke();
      };
      seg(9 + w3, 0, 5); seg(1 + w2, w2 * 0.4, 6.5); seg(-8 + w1, 0, 8);
      this.drawMiniCrown(ctx, -8 + w1, -12);
      ctx.save(); ctx.translate(-8 + w1, 0); this.drawFace(ctx, 0); ctx.restore();
    } else {
      const seg = (cx, cy, r, c1, c2) => {
        const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
        g.addColorStop(0, c1); g.addColorStop(1, c2);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#2e7d32'; ctx.lineWidth = 0.8; ctx.stroke();
      };
      seg(7 + w3, 0, 4, '#e8f5e9', '#66bb6a');
      seg(1 + w2, w2 * 0.4, 5.5, '#e8f5e9', '#4caf50');
      seg(-7 + w1, 0, 7, '#e8f5e9', '#388e3c');

      ctx.strokeStyle = '#2e7d32'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-8 + w1, -5); ctx.lineTo(-11 + w1, -10);
      ctx.moveTo(-5 + w1, -5); ctx.lineTo(-2 + w1, -10); ctx.stroke();
      ctx.fillStyle = '#ff4081';
      ctx.beginPath(); ctx.arc(-11 + w1, -10, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-2 + w1, -10, 1.5, 0, Math.PI * 2); ctx.fill();

      ctx.save(); ctx.translate(-7 + w1, 0); this.drawFace(ctx, 0); ctx.restore();
    }
    ctx.restore();
  },

  // 2. 蜜蜂 (圓滾萌蜂 / 黃金蜂王)
  drawEnemy_bee: function(ctx, time, isBoss) {
    ctx.save();
    const bob = Math.sin(time * 6) * 2;
    const flap = Math.sin(time * 30) * 0.4;
    ctx.translate(0, bob);

    if (isBoss) {
      ctx.save();
      ctx.translate(5, -9);
      ctx.rotate(flap);
      ctx.fillStyle = 'rgba(255, 249, 196, 0.9)'; ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(5, -5, 6, 9, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-2, 0, 4.5, 7, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.rotate(-0.1);
      const bg = ctx.createRadialGradient(-3, -3, 2, 0, 0, 15);
      bg.addColorStop(0, '#fffde7'); bg.addColorStop(0.4, '#ffee58'); bg.addColorStop(1, '#e65100');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(0, 0, 14, 12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, 14, 12, 0, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(80, 30, 0, 0.75)';
      ctx.fillRect(0, -13, 5, 26); ctx.fillRect(9, -13, 6, 26);
      ctx.restore();

      ctx.strokeStyle = '#b23c00'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(0, 0, 14, 12, -0.1, 0, Math.PI * 2); ctx.stroke();

      ctx.fillStyle = '#ffd600';
      ctx.beginPath(); ctx.moveTo(13, 1); ctx.lineTo(18, 2); ctx.lineTo(13, 4); ctx.fill();
      this.drawMiniCrown(ctx, -4, -13);

      ctx.fillStyle = 'rgba(255, 64, 129, 0.75)';
      ctx.beginPath(); ctx.ellipse(-9, 2, 2.5, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7f0000';
      ctx.beginPath(); ctx.arc(-7, -1, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-2, 0, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-7.5, -1.6, 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-2.5, -0.6, 0.7, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.save();
      ctx.translate(4, -8);
      ctx.rotate(flap);
      ctx.fillStyle = 'rgba(179, 229, 252, 0.85)'; ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(4, -4, 5, 8, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-2, 0, 4, 6, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.rotate(-0.1);
      const bg = ctx.createRadialGradient(-3, -3, 2, 0, 0, 14);
      bg.addColorStop(0, '#fff9c4'); bg.addColorStop(0.4, '#ffeb3b'); bg.addColorStop(1, '#f57f17');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 11, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 11, 0, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#3e2723';
      ctx.fillRect(0, -12, 4.5, 24); ctx.fillRect(8, -12, 5, 24);
      ctx.restore();

      ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 11, -0.1, 0, Math.PI * 2); ctx.stroke();

      ctx.fillStyle = '#3e2723';
      ctx.beginPath(); ctx.moveTo(12, 1); ctx.lineTo(16, 2); ctx.lineTo(12, 4); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-4, 11, 1.5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(3, 11, 1.5, 2.2, 0, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-6, -9); ctx.quadraticCurveTo(-9, -15, -7, -17); ctx.stroke();
      ctx.beginPath(); ctx.arc(-7, -17, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.quadraticCurveTo(0, -16, 3, -18); ctx.stroke();
      ctx.beginPath(); ctx.arc(3, -18, 1.5, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = 'rgba(255, 107, 129, 0.75)';
      ctx.beginPath(); ctx.ellipse(-9, 2, 2.5, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-1, 3, 2.5, 2, 0, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#2d2013';
      ctx.beginPath(); ctx.arc(-7, -1, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-2, 0, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-7.5, -1.6, 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-2.5, -0.6, 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },

  // 3. 蝸牛 (焦糖旋殼 / 黃金蝸牛王)
  drawEnemy_snail: function(ctx, time, isBoss) {
    ctx.save();
    const sq = Math.sin(time * 4) * 0.6;

    if (isBoss) {
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath(); ctx.ellipse(-2 + sq, 4, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1; ctx.stroke();

      const shG = ctx.createRadialGradient(2, -2, 1, 3, 0, 9);
      shG.addColorStop(0, '#fffde7'); shG.addColorStop(0.5, '#ffd600'); shG.addColorStop(1, '#e65100');
      ctx.fillStyle = shG;
      ctx.beginPath(); ctx.arc(3, -2, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.2; ctx.stroke();

      this.drawMiniCrown(ctx, 3, -14);

      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-8 + sq, 3); ctx.lineTo(-12 + sq, -3);
      ctx.moveTo(-4 + sq, 3); ctx.lineTo(-7 + sq, -5); ctx.stroke();
      ctx.fillStyle = '#ffd600';
      ctx.beginPath(); ctx.arc(-12 + sq, -3, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-7 + sq, -5, 1.8, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#a5d6a7';
      ctx.beginPath(); ctx.ellipse(-2 + sq, 4, 10, 3.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#388e3c'; ctx.lineWidth = 0.8; ctx.stroke();

      const shG = ctx.createRadialGradient(2, -2, 1, 3, 0, 8);
      shG.addColorStop(0, '#ffe082'); shG.addColorStop(0.5, '#ffb300'); shG.addColorStop(1, '#e65100');
      ctx.fillStyle = shG;
      ctx.beginPath(); ctx.arc(2, -1, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#bf360c'; ctx.lineWidth = 1; ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(2, -1, 4, 0.2, Math.PI * 1.5); ctx.stroke();

      ctx.strokeStyle = '#388e3c'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-7 + sq, 3); ctx.lineTo(-10 + sq, -2);
      ctx.moveTo(-4 + sq, 3); ctx.lineTo(-6 + sq, -4); ctx.stroke();
      ctx.fillStyle = '#1b5e20';
      ctx.beginPath(); ctx.arc(-10 + sq, -2, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-6 + sq, -4, 1.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },

  // 4. 蝴蝶 (紫粉彩蝶 / 黃金蝶王)
  drawEnemy_butterfly: function(ctx, time, isBoss) {
    ctx.save();
    if (isBoss) {
      const flap = Math.sin(time * 10);
      const scaleX = 0.45 + Math.abs(flap) * 0.55;
      ctx.save(); ctx.scale(scaleX, 1);
      const drawWing = (dir) => {
        const wg = ctx.createRadialGradient(dir * 7, -3, 1, dir * 7, 0, 11);
        wg.addColorStop(0, '#fffde7'); wg.addColorStop(0.5, '#ffee58'); wg.addColorStop(1, '#e65100');
        ctx.fillStyle = wg;
        ctx.beginPath(); ctx.ellipse(dir * 8, -3, 8, 10, dir * Math.PI / 8, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e65100'; ctx.lineWidth = 0.9; ctx.stroke();
      };
      drawWing(-1); drawWing(1); ctx.restore();

      ctx.fillStyle = '#e65100';
      ctx.beginPath(); ctx.ellipse(0, 0, 3, 8, 0, 0, Math.PI * 2); ctx.fill();
      this.drawMiniCrown(ctx, 0, -12);
      this.drawFace(ctx, -1);
    } else {
      const flap = Math.sin(time * 12);
      const scaleX = 0.5 + Math.abs(flap) * 0.5;
      ctx.save(); ctx.scale(scaleX, 1);
      const drawWing = (dir) => {
        const wg = ctx.createRadialGradient(dir * 6, -3, 1, dir * 6, 0, 10);
        wg.addColorStop(0, '#f8bbd0'); wg.addColorStop(0.5, '#b388ff'); wg.addColorStop(1, '#80d8ff');
        ctx.fillStyle = wg;
        ctx.beginPath(); ctx.ellipse(dir * 7, -3, 7, 9, dir * Math.PI / 8, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#7c4dff'; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(dir * 7, -4, 1.8, 0, Math.PI * 2); ctx.fill();
      };
      drawWing(-1); drawWing(1); ctx.restore();

      ctx.fillStyle = '#c51162';
      ctx.beginPath(); ctx.ellipse(0, 0, 2.5, 7, 0, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = '#4a148c'; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(-1, -6); ctx.quadraticCurveTo(-4, -11, -6, -9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(1, -6); ctx.quadraticCurveTo(4, -11, 6, -9); ctx.stroke();

      this.drawFace(ctx, -1);
    }
    ctx.restore();
  },

  // 5. 幼龍 (青碧生肖幼龍 / 黃金真龍王 - 生肖圖重繪)
  drawEnemy_dragon: function(ctx, time, isBoss) {
    ctx.save();
    const bob = Math.sin(time * 4) * 1.5;
    const whiskerWave = Math.sin(time * 6) * 2;
    const tailWave = Math.sin(time * 5) * 1.5;
    ctx.translate(0, bob);

    if (isBoss) {
      // 尾巴
      ctx.save();
      ctx.translate(9, 6);
      ctx.rotate(tailWave * 0.1);
      ctx.strokeStyle = '#ffd600'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(9, 4, 9, -7); ctx.stroke();
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#ff6f00';
      ctx.beginPath(); ctx.moveTo(9, -7); ctx.quadraticCurveTo(14, -11, 9, -15); ctx.quadraticCurveTo(6, -11, 9, -7); ctx.closePath(); ctx.fill();
      ctx.restore();

      // 金身
      const bg = ctx.createRadialGradient(-2, 6, 1, 0, 8, 10);
      bg.addColorStop(0, '#fffde7'); bg.addColorStop(0.5, '#ffd600'); bg.addColorStop(1, '#e65100');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(0, 8, 10, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.2; ctx.stroke();

      ctx.fillStyle = '#fffde7';
      ctx.beginPath(); ctx.ellipse(0, 8.5, 6.5, 6.5, 0, 0, Math.PI * 2); ctx.fill();

      // 耳與角
      ctx.fillStyle = '#ffd600'; ctx.strokeStyle = '#e65100'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.ellipse(-12, -3, 3.5, 2, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(12, -3, 3.5, 2, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      ctx.fillStyle = '#ff5722'; ctx.strokeStyle = '#b71c1c'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-7, -9); ctx.quadraticCurveTo(-12, -16, -9, -18); ctx.quadraticCurveTo(-6, -14, -5, -9); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(7, -9); ctx.quadraticCurveTo(12, -16, 9, -18); ctx.quadraticCurveTo(6, -14, 5, -9); ctx.closePath(); ctx.fill(); ctx.stroke();

      this.drawMiniCrown(ctx, 0, -17);

      // 金龍頭
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(0, -3, 12, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.2; ctx.stroke();

      ctx.fillStyle = '#fffde7';
      ctx.beginPath(); ctx.ellipse(0, -0.5, 10, 6.5, 0, 0, Math.PI); ctx.fill();

      // 龍鬚
      ctx.strokeStyle = '#ffd600'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-8, 0); ctx.quadraticCurveTo(-15, 2 + whiskerWave, -18, 9 + whiskerWave); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.quadraticCurveTo(15, 2 - whiskerWave, 18, 9 - whiskerWave); ctx.stroke();

      // 腮紅 & 琉璃赤瞳
      ctx.fillStyle = 'rgba(255, 64, 129, 0.75)';
      ctx.beginPath(); ctx.ellipse(-7, 0, 2.2, 1.2, -0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(7, 0, 2.2, 1.2, 0.2, 0, Math.PI * 2); ctx.fill();

      const drawKingDragonEye = (ex, ey, flip) => {
        ctx.fillStyle = '#b71c1c';
        ctx.beginPath(); ctx.ellipse(ex, ey, 2.4, 3.2, flip ? 0.15 : -0.15, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(ex - 0.6, ey - 1, 1, 0, Math.PI * 2); ctx.fill();
      };
      drawKingDragonEye(-6, -4, false);
      drawKingDragonEye(6, -4, true);

      ctx.fillStyle = '#bf360c';
      ctx.beginPath(); ctx.arc(-1.5, 0, 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(1.5, 0, 0.6, 0, Math.PI * 2); ctx.fill();
    } else {
      // 尾巴 + 黃毛
      ctx.save();
      ctx.translate(8, 6);
      ctx.rotate(tailWave * 0.1);
      ctx.strokeStyle = '#5dbbb0'; ctx.lineWidth = 4.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(8, 4, 8, -6); ctx.stroke();
      ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#fff59d'; ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(8, -6); ctx.quadraticCurveTo(12, -10, 8, -13); ctx.quadraticCurveTo(5, -10, 8, -6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();

      // 青碧身
      ctx.fillStyle = '#5dbbb0';
      ctx.beginPath(); ctx.ellipse(0, 8, 9, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 1; ctx.stroke();

      ctx.fillStyle = '#cbf3ed';
      ctx.beginPath(); ctx.ellipse(0, 8.5, 6, 6, 0, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-3, 6); ctx.lineTo(-3, 9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(3, 6); ctx.lineTo(3, 9); ctx.stroke();

      // 耳與角
      ctx.fillStyle = '#5dbbb0'; ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.ellipse(-11, -3, 3.5, 2, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(11, -3, 3.5, 2, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffcdd2';
      ctx.beginPath(); ctx.ellipse(-11, -3, 2, 1, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(11, -3, 2, 1, 0.3, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#ffab91'; ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-7, -9); ctx.quadraticCurveTo(-11, -15, -8, -17); ctx.quadraticCurveTo(-6, -14, -5, -9); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(7, -9); ctx.quadraticCurveTo(11, -15, 8, -17); ctx.quadraticCurveTo(6, -14, 5, -9); ctx.closePath(); ctx.fill(); ctx.stroke();

      ctx.fillStyle = '#fff59d'; ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-2, -10); ctx.lineTo(0, -15); ctx.lineTo(2, -10); ctx.closePath(); ctx.fill(); ctx.stroke();

      // 青碧頭
      ctx.fillStyle = '#5dbbb0';
      ctx.beginPath(); ctx.ellipse(0, -3, 11, 9.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#2b6e66'; ctx.lineWidth = 1; ctx.stroke();

      ctx.fillStyle = '#cbf3ed';
      ctx.beginPath(); ctx.ellipse(0, -0.5, 9.5, 6, 0, 0, Math.PI); ctx.fill();

      // 龍鬚
      ctx.strokeStyle = '#fff176'; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-7, 0); ctx.quadraticCurveTo(-14, 2 + whiskerWave, -16, 8 + whiskerWave); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(7, 0); ctx.quadraticCurveTo(14, 2 - whiskerWave, 16, 8 - whiskerWave); ctx.stroke();

      ctx.fillStyle = 'rgba(255, 107, 129, 0.7)';
      ctx.beginPath(); ctx.ellipse(-7, 0, 2.2, 1.2, -0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(7, 0, 2.2, 1.2, 0.2, 0, Math.PI * 2); ctx.fill();

      const drawChibiEye = (ex, ey, flip) => {
        ctx.fillStyle = '#3e2723';
        ctx.beginPath(); ctx.ellipse(ex, ey, 2.2, 3, flip ? 0.15 : -0.15, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(ex - 0.6, ey - 1, 0.9, 0, Math.PI * 2); ctx.fill();
      };
      drawChibiEye(-5.5, -4, false);
      drawChibiEye(5.5, -4, true);

      ctx.fillStyle = '#3e7a72';
      ctx.beginPath(); ctx.arc(-1.5, 0, 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(1.5, 0, 0.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },

  // 6. 鐵甲甲蟲 (黑曜石甲蟲 / 黃金甲蟲王)
  drawEnemy_beetle: function(ctx, time, isBoss) {
    ctx.save();
    if (isBoss) {
      const bob = Math.sin(time * 5) * 1.2; ctx.translate(0, bob);
      ctx.strokeStyle = '#f9a825'; ctx.lineWidth = 2;
      for (let s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.moveTo(s * 6, -4); ctx.lineTo(s * 10, -7);
        ctx.moveTo(s * 6, 0);  ctx.lineTo(s * 11, 0);
        ctx.moveTo(s * 6, 4);  ctx.lineTo(s * 10, 7);
        ctx.stroke();
      }
      const shG = ctx.createRadialGradient(-2, -2, 1, 0, 0, 10);
      shG.addColorStop(0, '#fffde7'); shG.addColorStop(0.5, '#ffd600'); shG.addColorStop(1, '#e65100');
      ctx.fillStyle = shG; ctx.beginPath(); ctx.ellipse(0, 1, 8.5, 9.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.2; ctx.stroke();

      ctx.fillStyle = '#ffd600';
      ctx.beginPath();
      ctx.moveTo(-2, -8); ctx.lineTo(-5, -15); ctx.lineTo(-1, -12);
      ctx.lineTo(0, -16); ctx.lineTo(1, -12); ctx.lineTo(5, -15); ctx.lineTo(2, -8);
      ctx.closePath(); ctx.fill();

      this.drawMiniCrown(ctx, 0, -18);

      ctx.fillStyle = '#ffd600';
      ctx.beginPath(); ctx.arc(-3, -5, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -5, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath(); ctx.arc(-3, -5, 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -5, 0.7, 0, Math.PI * 2); ctx.fill();
    } else {
      const bob = Math.sin(time * 6) * 1; ctx.translate(0, bob);
      ctx.strokeStyle = '#37474f'; ctx.lineWidth = 1.5;
      for (let s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.moveTo(s * 5, -4); ctx.lineTo(s * 9, -7);
        ctx.moveTo(s * 5, 0);  ctx.lineTo(s * 10, 0);
        ctx.moveTo(s * 5, 4);  ctx.lineTo(s * 9, 7);
        ctx.stroke();
      }
      const shG = ctx.createRadialGradient(-2, -2, 1, 0, 0, 9);
      shG.addColorStop(0, '#78909c'); shG.addColorStop(1, '#263238');
      ctx.fillStyle = shG; ctx.beginPath(); ctx.ellipse(0, 1, 7.5, 8.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#90a4ae'; ctx.lineWidth = 1; ctx.stroke();

      ctx.fillStyle = '#ffb300';
      ctx.beginPath();
      ctx.moveTo(-2, -7); ctx.lineTo(-4, -13); ctx.lineTo(-1, -11);
      ctx.lineTo(0, -14); ctx.lineTo(1, -11); ctx.lineTo(4, -13); ctx.lineTo(2, -7);
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = '#ff1744';
      ctx.beginPath(); ctx.arc(-2.5, -5, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(2.5, -5, 1.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
};

// ─── 6. 工具函數 ─────────────────────────────
function dist(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gridToPixel(col, row) {
  return {
    x: col * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2,
    y: row * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2,
  };
}

function pixelToGrid(px, py) {
  return {
    col: Math.floor(px / CONFIG.CELL_SIZE),
    row: Math.floor(py / CONFIG.CELL_SIZE),
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ─── 7. 音效系統 ─────────────────────────────
class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      this.enabled = false;
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  play(type) {
    if (!this.enabled || !this.ctx) return;
    this.resume();
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);

      switch (type) {
        case 'place':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(523, t);
          osc.frequency.setValueAtTime(659, t + 0.05);
          gain.gain.setValueAtTime(0.08, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
          osc.start(t);
          osc.stop(t + 0.15);
          break;
        case 'shoot':
          osc.type = 'square';
          osc.frequency.setValueAtTime(880, t);
          osc.frequency.exponentialRampToValueAtTime(440, t + 0.04);
          gain.gain.setValueAtTime(0.03, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
          osc.start(t);
          osc.stop(t + 0.05);
          break;
        case 'hit':
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(300, t);
          osc.frequency.exponentialRampToValueAtTime(100, t + 0.08);
          gain.gain.setValueAtTime(0.06, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
          osc.start(t);
          osc.stop(t + 0.1);
          break;
        case 'kill':
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(784, t);
          osc.frequency.setValueAtTime(1047, t + 0.06);
          gain.gain.setValueAtTime(0.08, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          osc.start(t);
          osc.stop(t + 0.2);
          break;
        case 'wave':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, t);
          osc.frequency.setValueAtTime(554, t + 0.1);
          osc.frequency.setValueAtTime(659, t + 0.2);
          gain.gain.setValueAtTime(0.1, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
          osc.start(t);
          osc.stop(t + 0.4);
          break;
        case 'gameover':
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(440, t);
          osc.frequency.exponentialRampToValueAtTime(110, t + 0.5);
          gain.gain.setValueAtTime(0.08, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
          osc.start(t);
          osc.stop(t + 0.6);
          break;
        case 'victory':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(523, t);
          osc.frequency.setValueAtTime(659, t + 0.15);
          osc.frequency.setValueAtTime(784, t + 0.3);
          osc.frequency.setValueAtTime(1047, t + 0.45);
          gain.gain.setValueAtTime(0.1, t);
          gain.gain.setValueAtTime(0.1, t + 0.3);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
          osc.start(t);
          osc.stop(t + 0.7);
          break;
        case 'gold':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1200, t);
          osc.frequency.setValueAtTime(1600, t + 0.04);
          gain.gain.setValueAtTime(0.04, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
          osc.start(t);
          osc.stop(t + 0.08);
          break;
        case 'upgrade':
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, t);
          osc.frequency.setValueAtTime(660, t + 0.08);
          osc.frequency.setValueAtTime(880, t + 0.16);
          gain.gain.setValueAtTime(0.08, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
          osc.start(t);
          osc.stop(t + 0.3);
          break;
        case 'sell':
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(600, t);
          osc.frequency.exponentialRampToValueAtTime(300, t + 0.12);
          gain.gain.setValueAtTime(0.06, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
          osc.start(t);
          osc.stop(t + 0.15);
          break;
        case 'error':
          osc.type = 'square';
          osc.frequency.setValueAtTime(200, t);
          osc.frequency.setValueAtTime(150, t + 0.1);
          gain.gain.setValueAtTime(0.06, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          osc.start(t);
          osc.stop(t + 0.2);
          break;
      }
    } catch (e) {
      // Ignore audio errors
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }
}

// ─── 8. 地圖系統 ─────────────────────────────
class GameMap {
  constructor(mapId = CURRENT_MAP_ID) {
    this.mapId = mapId;
    this.config = MAP_CONFIGS[mapId] || MAP_CONFIGS['serpentine'];
    this.grid = [];
    this.pathCells = new Set();
    this.pathPixels = [];
    this.totalPathLength = 0;
    this.segmentLengths = [];
    this.decorations = [];
    this.buildGrid();
    this.computePath();
    this.generateDecorations();
  }

  buildGrid() {
    const waypoints = this.config.waypoints;
    for (let r = 0; r < CONFIG.ROWS; r++) {
      this.grid[r] = [];
      for (let c = 0; c < CONFIG.COLS; c++) {
        this.grid[r][c] = 0; // 0 = grass (buildable)
      }
    }
    // Mark path cells safely
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [c1, r1] = waypoints[i];
      const [c2, r2] = waypoints[i + 1];
      if (r1 === r2) {
        // Horizontal segment
        if (r1 >= 0 && r1 < CONFIG.ROWS) {
          const minC = Math.max(0, Math.min(c1, c2));
          const maxC = Math.min(CONFIG.COLS - 1, Math.max(c1, c2));
          for (let c = Math.ceil(minC); c <= Math.floor(maxC); c++) {
            this.grid[r1][c] = 1;
            this.pathCells.add(`${c},${r1}`);
          }
        }
      } else {
        // Vertical segment
        const minR = Math.max(0, Math.min(r1, r2));
        const maxR = Math.min(CONFIG.ROWS - 1, Math.max(r1, r2));
        for (let r = minR; r <= maxR; r++) {
          if (c1 >= 0 && c1 < CONFIG.COLS) {
            this.grid[r][c1] = 1;
            this.pathCells.add(`${c1},${r}`);
          }
        }
      }
    }
  }

  computePath() {
    const waypoints = this.config.waypoints;
    this.pathPixels = waypoints.map(([c, r]) => gridToPixel(c, r));
    this.segmentLengths = [];
    this.totalPathLength = 0;
    for (let i = 0; i < this.pathPixels.length - 1; i++) {
      const a = this.pathPixels[i];
      const b = this.pathPixels[i + 1];
      const len = dist(a.x, a.y, b.x, b.y);
      this.segmentLengths.push(len);
      this.totalPathLength += len;
    }
  }

  generateDecorations() {
    const decoTypes = ['flower1', 'flower2', 'grass', 'mushroom'];
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        if (this.grid[r][c] === 0 && Math.random() < 0.12) {
          this.decorations.push({
            x: c * CONFIG.CELL_SIZE + 10 + Math.random() * 30,
            y: r * CONFIG.CELL_SIZE + 10 + Math.random() * 30,
            decoType: decoTypes[Math.floor(Math.random() * decoTypes.length)],
            size: 10 + Math.random() * 8,
          });
        }
      }
    }
  }

  getPositionAtDistance(distance) {
    let remaining = distance;
    for (let i = 0; i < this.segmentLengths.length; i++) {
      if (remaining <= this.segmentLengths[i]) {
        const t = remaining / this.segmentLengths[i];
        const a = this.pathPixels[i];
        const b = this.pathPixels[i + 1];
        return {
          x: lerp(a.x, b.x, t),
          y: lerp(a.y, b.y, t),
          segIndex: i,
          t: t,
        };
      }
      remaining -= this.segmentLengths[i];
    }
    const last = this.pathPixels[this.pathPixels.length - 1];
    return { x: last.x, y: last.y, segIndex: this.segmentLengths.length - 1, t: 1 };
  }

  isBuildable(col, row) {
    if (col < 0 || col >= CONFIG.COLS || row < 0 || row >= CONFIG.ROWS) return false;
    if (this.grid[row][col] !== 0) return false;
    if (typeof this.config.customBuildable === 'function') {
      return this.config.customBuildable(col, row);
    }
    return true;
  }
}

// ─── 9. 敵人類別 ─────────────────────────────
class Enemy {
  constructor(typeKey, gameMap, waveIndex = 0) {
    const data = ENEMY_DATA[typeKey];
    // 難度成長只看「第幾關」，同一關卡內第1波跟第15波的血量一樣，只有怪物組成/密度變難
    const hpMult = LEVEL_DATA[CURRENT_LEVEL_INDEX].hpMultiplier;
    this.typeKey = typeKey;
    this.waveIndex = waveIndex;
    this.name = data.name;
    this.emoji = data.emoji;
    this.maxHp = Math.round(data.hp * hpMult);
    this.hp = this.maxHp;
    this.baseSpeed = data.speed;
    this.speed = data.speed;
    this.reward = data.reward;
    this.damage = data.damage;
    this.map = gameMap;

    this.distance = 0;
    const pos = gameMap.getPositionAtDistance(0);
    this.x = pos.x;
    this.y = pos.y;

    this.alive = true;
    this.reachedEnd = false;
    this.slowTimer = 0;
    this.slowFactor = 1;

    // 特性旗標與技能計時
    this.canEnrage = !!data.canEnrage;
    this.isEnraged = false;
    this.armor = data.armor || 0; // 0.5 = 50% 物理減傷
    this.isBoss = !!data.isBoss;
    this.summonThresholds = [0.75, 0.5, 0.25]; // 小龍在 75%, 50%, 25% 血量召喚小蜜蜂
    this.summonedStages = new Set();

    // Poison DOT (劇毒持續傷害)
    this.poisonTimer = 0;
    this.poisonDps = 0;
    this.poisonTickTimer = 0;

    // Visual
    this.hitFlash = 0;
    this.scale = 0;
    this.targetScale = 1;
    this.animTime = Math.random() * 10;
  }

  update(dt, game) {
    this.animTime += dt;
    // Scale animation (spawn pop)
    this.scale = lerp(this.scale, this.targetScale, dt * 8);

    // 狂暴加速 (低於 20% 血量狂暴；原本 35% 觸發太早，蜜蜂/蝴蝶常常被打一兩下就狂暴衝出塔的射程外，變成怎麼打都追不上的漏怪)
    if (this.canEnrage && !this.isEnraged && (this.hp / this.maxHp) <= 0.20) {
      this.isEnraged = true;
      if (game) {
        game.spawnParticle(this.x, this.y - 18, {
          text: '⚡ 狂暴！',
          color: '#ff1744',
          fontSize: 13,
          vx: 0,
          vy: -35,
          gravity: 0,
          life: 1.0,
        });
      }
    }

    // Slow effect
    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      if (this.slowTimer <= 0) {
        this.slowFactor = 1;
      }
    }

    // Poison DOT effect (毒霧可完全無視護甲融甲)
    if (this.poisonTimer > 0) {
      this.poisonTimer -= dt;
      this.poisonTickTimer += dt;
      if (this.poisonTickTimer >= 0.5) { // 每 0.5 秒跳一次毒傷
        this.poisonTickTimer = 0;
        const tickDamage = (this.poisonDps || 0) * 0.5;
        if (tickDamage > 0) {
          this.hp = Math.max(0, this.hp - tickDamage);
          this.hitFlash = 0.5;
          if (game) {
            game.spawnParticle(this.x, this.y - 10, {
              text: `-${Math.round(tickDamage)} 🧪`,
              color: '#76ff03',
              fontSize: 11,
              vx: (Math.random() - 0.5) * 30,
              vy: -35,
              gravity: 0,
              life: 0.8,
            });
          }
          if (this.hp <= 0 || isNaN(this.hp)) {
            this.hp = 0;
            this.alive = false;
          }
        }
      }
    }

    // Hit flash
    if (this.hitFlash > 0) this.hitFlash -= dt * 4;

    // Move along path (狂暴時速度 1.5 倍；原本 1.8 倍會蓋掉減速塔效果，讓怪直接衝出去)
    const enrageMultiplier = this.isEnraged ? 1.5 : 1.0;
    const currentSpeed = this.baseSpeed * this.slowFactor * enrageMultiplier;
    this.distance += currentSpeed * dt;
    const pos = this.map.getPositionAtDistance(this.distance);
    this.x = pos.x;
    this.y = pos.y;

    // Check if reached end
    if (this.distance >= this.map.totalPathLength) {
      this.reachedEnd = true;
      this.alive = false;
    }
  }

  takeDamage(amount, slowFactor, slowDuration, poisonDps, poisonDuration, isPhysical = false, game = null) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return;

    // 鐵甲甲蟲物理減傷 25%（原本 50% 太重，新手開局只有 petal 這種物理塔可用時打不動），非物理（毒/雷/冰/流星）全額承受
    let finalAmount = amount;
    if (this.armor > 0 && isPhysical) {
      finalAmount = amount * (1 - this.armor);
    }
    this.hp = Math.max(0, this.hp - finalAmount);
    this.hitFlash = 1;

    // Boss 小龍召喚護衛術 (75%, 50%, 25% 觸發)
    if (this.isBoss && game && game.enemies) {
      const ratio = this.hp / this.maxHp;
      for (const th of this.summonThresholds) {
        if (ratio <= th && !this.summonedStages.has(th)) {
          this.summonedStages.add(th);
          game.sfx.play('explosion');
          game.spawnParticle(this.x, this.y - 25, {
            text: '🐉 召喚護衛！',
            color: '#ffd700',
            fontSize: 14,
            vx: 0,
            vy: -40,
            gravity: 0,
            life: 1.2
          });
          // 召喚 2 隻蜜蜂護衛
          for (let i = 0; i < 2; i++) {
            const minion = new Enemy('bee', this.map, this.waveIndex);
            minion.distance = Math.max(0, this.distance - (i + 1) * 20);
            const mPos = this.map.getPositionAtDistance(minion.distance);
            minion.x = mPos.x;
            minion.y = mPos.y;
            game.enemies.push(minion);
          }
        }
      }
    }

    if (typeof slowFactor === 'number' && typeof slowDuration === 'number' && slowDuration > 0) {
      this.slowFactor = slowFactor;
      this.slowTimer = slowDuration;
    }
    if (typeof poisonDps === 'number' && typeof poisonDuration === 'number' && poisonDps > 0 && poisonDuration > 0) {
      this.poisonDps = Math.max(this.poisonDps || 0, poisonDps);
      this.poisonTimer = Math.max(this.poisonTimer || 0, poisonDuration);
    }
    if (this.hp <= 0 || isNaN(this.hp)) {
      this.hp = 0;
      this.alive = false;
    }
  }

  render(ctx) {
    const s = this.scale;
    if (s < 0.01) return;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(s, s);

    // 1. 落地立體陰影 (消除漂浮感)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(0, 12, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. 行進間左右扭動微動作 (Wobble Walk)
    const wobble = Math.sin(this.distance * 0.15) * 0.08;
    ctx.rotate(wobble);

    // 3. 狂暴微光 (紅色光環與蒸氣)
    if (this.isEnraged) {
      ctx.fillStyle = 'rgba(255, 23, 68, 0.35)';
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.fill();
    }

    // Slow tint
    if (this.slowTimer > 0) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#88ddff';
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Poison tint (劇毒綠色毒雲光環)
    if (this.poisonTimer > 0) {
      ctx.globalAlpha = 0.35 + Math.sin(this.animTime * 10) * 0.15;
      ctx.fillStyle = '#76ff03';
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Draw SVG Image or Canvas Sprite
    const enemyImg = assets.get('enemy_' + this.typeKey);
    if (enemyImg) {
      ctx.save();
      // Wobble walk
      ctx.rotate(this.wobbleAngle || 0);
      ctx.drawImage(enemyImg, -20, -20, 40, 40);
      ctx.restore();
    } else {
      const drawFunc = Sprites['drawEnemy_' + this.typeKey];
      if (drawFunc) {
        drawFunc.call(Sprites, ctx, this.animTime, !!this.isBoss);
      }
    }

    // Hit flash overlay
    if (this.hitFlash > 0) {
      ctx.globalAlpha = this.hitFlash * 0.5;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Health bar
    const barW = 30;
    const barH = 4;
    const barY = -24;
    const hpRatio = this.hp / this.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-barW / 2, barY, barW, barH);
    const hpColor = hpRatio > 0.5 ? '#88d8b0' : hpRatio > 0.25 ? '#ffd700' : '#ff6b6b';
    ctx.fillStyle = hpColor;
    ctx.fillRect(-barW / 2, barY, barW * hpRatio, barH);

    ctx.restore();
  }
}

// ─── 10. 投射物類別 ──────────────────────────
class Projectile {
  constructor(fromX, fromY, target, tower) {
    this.x = fromX;
    this.y = fromY;
    this.target = target;
    this.speed = tower.data.projectileSpeed || 300;
    this.damage = tower.getStats().damage;
    this.color = tower.data.projectileColor || '#ff69b4';
    this.alive = true;
    this.trail = [];

    // Special properties
    this.splashRadius = tower.getStats().splashRadius || 0;
    this.slowFactor = tower.getStats().slowFactor || null;
    this.slowDuration = tower.getStats().slowDuration || 0;
    this.piercing = tower.getStats().piercing || 0;
    this.piercedEnemies = new Set();
    this.towerType = tower.typeKey;

    // Thunder Chain & Poison DOT properties
    this.chainCount = tower.getStats().chainCount || 0;
    this.chainRange = tower.getStats().chainRange || 0;
    this.poisonDps = tower.getStats().poisonDps || 0;
    this.poisonDuration = tower.getStats().poisonDuration || 0;
    this.chainedEnemies = new Set();
  }

  update(dt, game) {
    if (!this.alive) return;

    // Track target or fly to last known position
    let tx, ty;
    if (this.target && this.target.alive) {
      tx = this.target.x;
      ty = this.target.y;
    } else if (this.piercing > 0) {
      // Piercing continues in same direction
      this.alive = false;
      return;
    } else {
      this.alive = false;
      return;
    }

    const d = dist(this.x, this.y, tx, ty);
    if (d < 8) {
      // Hit!
      this.onHit(game);
      return;
    }

    // Move towards target
    const dx = (tx - this.x) / d;
    const dy = (ty - this.y) / d;
    this.x += dx * this.speed * dt;
    this.y += dy * this.speed * dt;

    // Trail
    this.trail.push({ x: this.x, y: this.y, alpha: 1 });
    if (this.trail.length > 6) this.trail.shift();
  }

  onHit(game) {
    if (this.target && this.target.alive) {
      const isPhysical = (this.towerType === 'petal' || this.towerType === 'candy');
      // 穿透彈每貫穿一體衰減 20% 傷害，比照連鎖閃電的衰減比例，避免穿透塔在多怪排隊時全額暴擊每一隻
      const pierceFalloff = this.piercing > 0 ? Math.pow(0.8, this.piercedEnemies.size) : 1;
      this.target.takeDamage(this.damage * pierceFalloff, this.slowFactor, this.slowDuration, this.poisonDps, this.poisonDuration, isPhysical, game);
      this.piercedEnemies.add(this.target);
      this.chainedEnemies.add(this.target);

      // 連鎖閃電折射演算法 (Chain Lightning Jump)
      if (this.chainCount > 1 && game && game.enemies) {
        let currentTarget = this.target;
        for (let c = 1; c < this.chainCount; c++) {
          let nextTarget = null;
          let minD = this.chainRange;
          for (const other of game.enemies) {
            if (!other.alive || this.chainedEnemies.has(other)) continue;
            const d = dist(currentTarget.x, currentTarget.y, other.x, other.y);
            if (d < minD) {
              minD = d;
              nextTarget = other;
            }
          }
          if (nextTarget) {
            this.chainedEnemies.add(nextTarget);
            const chainDmg = this.damage * Math.pow(0.8, c); // 每次彈射衰減 20% 傷害
            nextTarget.takeDamage(chainDmg, null, 0, 0, 0, false, game); // 閃電為魔法傷害

            // 閃電折射火花粒子
            for (let k = 0; k < 5; k++) {
              game.spawnParticle((currentTarget.x + nextTarget.x) / 2, (currentTarget.y + nextTarget.y) / 2, {
                color: '#00e5ff',
                size: 2.5,
                vx: (Math.random() - 0.5) * 120,
                vy: (Math.random() - 0.5) * 120,
                life: 0.3,
                gravity: 0
              });
            }
            currentTarget = nextTarget;
          } else {
            break;
          }
        }
      }
    }
    if (this.piercing > 0 && this.piercedEnemies.size < this.piercing) {
      this.target = null;
    } else {
      this.alive = false;
    }
  }

  render(ctx) {
    ctx.save();

    // 1. 發光拖尾 (Neon Particle Trail)
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const alpha = (i / this.trail.length) * 0.55;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 2.5 + i * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 子彈外層霓虹光暈 (Glow Effect)
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 10;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 5.5, 0, Math.PI * 2);
    ctx.fill();

    // 3. 子彈中心晶瑩白色核心 (Specular Core)
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.x - 1, this.y - 1, 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

// ─── 11. 粒子效果 ────────────────────────────
class Particle {
  constructor(x, y, options = {}) {
    this.x = x;
    this.y = y;
    this.vx = options.vx || (Math.random() - 0.5) * 100;
    this.vy = options.vy || (Math.random() - 0.5) * 100 - 50;
    this.life = options.life || 0.8;
    this.maxLife = this.life;
    this.color = options.color || '#ffb6c1';
    this.size = options.size || 4;
    this.text = options.text || null;
    this.fontSize = options.fontSize || 14;
    this.gravity = options.gravity !== undefined ? options.gravity : 80;
    this.alive = true;
  }

  update(dt) {
    this.life -= dt;
    if (this.life <= 0) {
      this.alive = false;
      return;
    }
    this.vy += this.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  render(ctx) {
    const alpha = clamp(this.life / this.maxLife, 0, 1);
    ctx.globalAlpha = alpha;

    if (this.text) {
      ctx.font = `bold ${this.fontSize}px 'Zen Maru Gothic', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.color;
      // Shadow for readability
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 3;
      ctx.fillText(this.text, this.x, this.y);
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ─── 12. 防禦塔類別 ──────────────────────────
class Tower {
  constructor(typeKey, col, row) {
    this.typeKey = typeKey;
    this.data = TOWER_DATA[typeKey];
    this.col = col;
    this.row = row;
    const pos = gridToPixel(col, row);
    this.x = pos.x;
    this.y = pos.y;
    this.level = 1;
    this.totalInvested = this.data.cost;

    // Combat
    this.cooldown = 0;
    this.target = null;
    this.angle = 0;

    // Gold generation
    this.goldTimer = 0;

    // Visual
    this.scale = 0;
    this.pulseTimer = 0;
    this.animTime = Math.random() * 10;
  }

  getStats() {
    const levelData = this.data.levels[this.level - 1];
    return { ...this.data, ...levelData };
  }

  getUpgradeCost() {
    if (this.level >= CONFIG.MAX_LEVEL) return null;
    return this.data.levels[this.level].upgradeCost;
  }

  getSellValue() {
    return Math.floor(this.totalInvested * CONFIG.SELL_RATIO);
  }

  upgrade() {
    if (this.level >= CONFIG.MAX_LEVEL) return false;
    const cost = this.getUpgradeCost();
    this.level++;
    this.totalInvested += cost;
    this.pulseTimer = 0.5;
    return true;
  }

  update(dt, enemies, game) {
    this.animTime += dt;
    // Spawn animation
    this.scale = lerp(this.scale, 1, dt * 8);
    if (this.pulseTimer > 0) this.pulseTimer -= dt;

    const stats = this.getStats();

    // Sunflower: generate gold (only when wave is active)
    if (this.typeKey === 'sunflower' && stats.goldPerSecond) {
      if (game.state === 'wave') {
        this.goldTimer += dt;
        if (this.goldTimer >= 1.0) {
          this.goldTimer -= 1.0;
          game.addGold(stats.goldPerSecond);
          game.spawnParticle(this.x, this.y - 15, {
            text: `+${stats.goldPerSecond}💰`,
            color: '#ffa500',
            fontSize: 12,
            vx: (Math.random() - 0.5) * 20,
            vy: -40,
            gravity: 0,
            life: 1.0,
          });
          game.sfx.play('gold');
        }
      }
      return null; // Sunflower doesn't attack
    }

    // Combat tower
    if (stats.fireRate <= 0) return null;

    this.cooldown -= dt;

    // Find target
    this.target = this.findTarget(enemies, stats.range);

    if (this.target) {
      this.angle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
    }

    if (this.cooldown <= 0 && this.target) {
      this.cooldown = 1.0 / stats.fireRate;
      game.sfx.play('shoot');
      return new Projectile(this.x, this.y, this.target, this);
    }

    return null;
  }

  findTarget(enemies, range) {
    let bestTarget = null;
    let bestProgress = -1;

    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const d = dist(this.x, this.y, enemy.x, enemy.y);
      if (d <= range && enemy.distance > bestProgress) {
        bestProgress = enemy.distance;
        bestTarget = enemy;
      }
    }
    return bestTarget;
  }

  render(ctx) {
    const s = this.scale;
    if (s < 0.01) return;

    ctx.save();
    ctx.translate(this.x, this.y);

    const pulse = this.pulseTimer > 0 ? 1 + Math.sin(this.pulseTimer * 20) * 0.1 : 1;
    ctx.scale(s * pulse, s * pulse);

    // 1. 落地立體陰影 (消除漂浮感)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(0, 14, 18, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. 精緻底座 (立體微光圓環)
    const stats = this.getStats();
    const baseGrad = ctx.createRadialGradient(-3, -3, 2, 0, 0, 20);
    baseGrad.addColorStop(0, '#ffffff');
    baseGrad.addColorStop(0.3, this.data.color);
    baseGrad.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = baseGrad;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 3. 底座外邊框高光
    ctx.strokeStyle = this.data.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, 19, 0, Math.PI * 2);
    ctx.stroke();

    // 4. 優先繪製 SVG 超高清貼圖 (GPU 硬體加速省電零失焦)
    const svgImg = assets.get('tower_' + this.typeKey);
    if (svgImg) {
      ctx.save();
      ctx.drawImage(svgImg, -24, -28, 48, 48);
      ctx.restore();
    } else {
      const drawFunc = Sprites['drawTower_' + this.typeKey];
      if (drawFunc) {
        ctx.save();
        drawFunc.call(Sprites, ctx, this.animTime);
        ctx.restore();
      }
    }

    // Level stars (hand-drawn)
    if (this.level > 1) {
      ctx.fillStyle = '#ffdf00';
      ctx.strokeStyle = '#d4af37';
      ctx.lineWidth = 1;
      for (let i = 0; i < this.level - 1; i++) {
        const starX = -6 + i * 12;
        const starY = -24;
        ctx.beginPath();
        for (let j = 0; j < 5; j++) {
          const a = (Math.PI * 2 / 5) * j - Math.PI / 2;
          ctx.lineTo(starX + Math.cos(a) * 4, starY + Math.sin(a) * 4);
          const a2 = (Math.PI * 2 / 5) * j + Math.PI / 5 - Math.PI / 2;
          ctx.lineTo(starX + Math.cos(a2) * 2, starY + Math.sin(a2) * 2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  renderRange(ctx) {
    const stats = this.getStats();
    if (stats.range <= 0) return;

    ctx.save();
    // 1. 半透明填充（增強能見度）
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = this.data.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, stats.range, 0, Math.PI * 2);
    ctx.fill();

    // 2. 實線發光外圈
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = this.data.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(this.x, this.y, stats.range, 0, Math.PI * 2);
    ctx.stroke();

    // 3. 內層精緻亮白色虛線圈，對比更鮮明
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(this.x, this.y, stats.range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ─── 13. 波次管理器 ──────────────────────────
class WaveManager {
  constructor(waveData = WAVE_DATA_L1) {
    this.waveData = waveData;
    this.currentWave = -1;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.active = false;
    this.allSpawned = false;
  }

  startWave(waveIndex) {
    this.currentWave = waveIndex;
    const wave = this.waveData[waveIndex];
    this.spawnQueue = [];
    if (!wave) {
      dbgLog(`⚠️ WaveData not found for wave ${waveIndex}`);
      return;
    }

    dbgLog(`🌊 [Wave] 第 ${waveIndex + 1} 波開始生成，組數: ${wave.enemies.length}`);
    for (const group of wave.enemies) {
      for (let i = 0; i < group.count; i++) {
        this.spawnQueue.push({
          type: group.type,
          delay: group.interval,
        });
      }
    }
    dbgLog(`👾 [Wave] 總預定出怪數: ${this.spawnQueue.length}`);

    this.spawnTimer = 0.5; // Initial delay
    this.active = true;
    this.allSpawned = false;
  }

  update(dt, gameMap) {
    if (!this.active || this.allSpawned) return null;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.spawnQueue.length > 0) {
      const spawn = this.spawnQueue.shift();
      this.spawnTimer = spawn.delay;

      if (this.spawnQueue.length === 0) {
        this.allSpawned = true;
        dbgLog(`✨ [Wave] 第 ${this.currentWave + 1} 波出怪完畢 (allSpawned = true)`);
      }

      return new Enemy(spawn.type, gameMap, this.currentWave);
    }
    return null;
  }

  isComplete(enemies) {
    const aliveCount = enemies.filter((e) => e.alive).length;
    return this.allSpawned && aliveCount === 0;
  }

  getWaveBonus() {
    return this.waveData[this.currentWave]?.bonus || 0;
  }
}

// 設定面板音效開關圖示 (SVG，隨按鈕文字顏色變化，取代 Emoji)
const SOUND_ICON_SVG = {
  on: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  off: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.19v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3z"/></svg>',
};

// ─── 13.5 SVG 圖片資源管理器 (AssetManager - 無限放大絕不失焦) ──────────
class AssetManager {
  constructor() {
    this.images = {};
    this.loaded = false;
  }

  loadAll() {
    const assets = {
      tower_petal: 'assets/towers/tower_petal.svg',
      tower_sunflower: 'assets/towers/tower_sunflower.svg',
      tower_lavender: 'assets/towers/tower_lavender.svg',
      tower_cannon: 'assets/towers/tower_cannon.svg',
      tower_ice_crystal: 'assets/towers/tower_ice_crystal.svg',
      tower_laser: 'assets/towers/tower_laser.svg',
      tower_mushroom: 'assets/towers/tower_mushroom.svg',
      tower_treant: 'assets/towers/tower_treant.svg',
      spawn_portal: 'assets/ui/spawn_portal.svg',
      sacred_tree: 'assets/ui/sacred_tree.svg',
      spawn_badge: 'assets/ui/spawn_badge.svg',
      pedestal_tile: 'assets/ui/pedestal_tile.svg',
      icon_gold: 'assets/ui/icon_gold.svg',
      icon_heart: 'assets/ui/icon_heart.svg',
      icon_star: 'assets/ui/icon_star.svg',
      icon_settings: 'assets/ui/icon_settings.svg',
      icon_trophy: 'assets/ui/icon_trophy.svg',
    };

    const promises = [];
    for (const [key, src] of Object.entries(assets)) {
      promises.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this.images[key] = img;
          resolve();
        };
        img.onerror = () => {
          dbgLog(`⚠️ SVG 圖片載入失敗: ${src}`);
          resolve();
        };
        // 加上版本號做快取破壞，避免改版後瀏覽器（尤其手機）還在吃舊的 SVG 快取
        img.src = `${src}?v=${CONFIG.VERSION}`;
      }));
    }

    return Promise.all(promises).then(() => {
      this.loaded = true;
      dbgLog('🎨 [AssetManager] 所有 SVG 圖片資源預載完畢！');
    });
  }

  get(key) {
    return this.images[key] || null;
  }
}

const assets = new AssetManager();
assets.loadAll().then(() => {
  const game = window.gameInstance;
  if (!game) return;
  game.refreshIcons();
  // 地圖（含建造平台、入口傳送門、出口世界樹）是畫在離屏 buffer 上只畫一次，
  // init() 當下 SVG 通常還沒載入完成，所以載入完後要重畫一次，不然畫面會卡在手繪版本
  game.renderMapToBuffer();
});

// ─── 14. 主遊戲類別 ──────────────────────────
class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;

    // Offscreen map canvas
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = CANVAS_W;
    this.mapCanvas.height = CANVAS_H;
    this.mapCtx = this.mapCanvas.getContext('2d');

    this.map = new GameMap();
    this.sfx = new SoundManager();
    this.waveManager = new WaveManager(LEVEL_DATA[CURRENT_LEVEL_INDEX].waves);

    // Game state
    this.state = 'menu'; // menu, planning, wave, gameover, victory
    this.gold = CONFIG.STARTING_GOLD;
    this.lives = CONFIG.STARTING_LIVES;
    this.score = 0;
    this.bestScore = parseInt(localStorage.getItem(CONFIG.LS_KEY)) || 0;
    this.currentWave = 0;
    this.speedMultiplier = 1;

    // Collections
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.particles = [];

    // Active Skills System
    this.skills = {
      meteor: { cd: 30, timer: 0, cost: 0, range: 110, damage: 150 },
      freeze: { cd: 45, timer: 0, cost: 0, duration: 3.5 }
    };
    this.activeTargetingSkill = null; // 'meteor' or null

    // Base & Gate Dynamic Feedback
    this.baseHurtTimer = 0;
    this.gatePulseTimer = 0;

    // Interaction
    this.selectedTowerType = null;
    this.selectedTower = null;
    this.hoverCell = null;
    this.mouseX = -1;
    this.mouseY = -1;
    this.draggingTowerType = null;
    this.dragPos = null; // { x, y } in canvas coords
    this.isDragging = false;

    // Timing
    this.lastTime = 0;
    this.animFrame = null;

    // Shop tabs & filters
    this.shopStatusTab = 'all'; // 'all', 'locked', 'unlocked'
    this.shopKindFilter = 'all'; // 'all', 'tower', 'skill'

    // Build tower map for quick lookup
    this.towerGrid = {};
  }

  init() {
    this.sfx.init();
    this.renderMapToBuffer();
    this.setupUI();
    this.setupEvents();
    this.updateUI();
    this.renderLeaderboards();
    this.gameLoop(0);
  }

  // ─── Map rendering (to offscreen buffer: 暖金黃沙海島/古代石陣風格) ───
  renderMapToBuffer() {
    const ctx = this.mapCtx;
    const cs = CONFIG.CELL_SIZE;

    // 1. 基底大地：4號晨曦暖陽金沙 溫暖淡金純淨色系
    ctx.fillStyle = '#fffdf5';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 2. 建造平台 2.5D 立體石台基座 (Elevated Stone Pedestals - 4號晨曦暖金純白大理石台)
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        if (this.map.grid[r][c] === 0) {
          const px = c * cs + 3;
          const py = r * cs + 3;
          const pw = cs - 6;
          const ph = cs - 6;

          // 2.2 繪製 2.5D 石頭/草皮建造基座 (#5 露珠草皮丘)
          const pedestalImg = assets.get('pedestal_tile');
          if (pedestalImg) {
            ctx.drawImage(pedestalImg, px, py, pw, ph);
          } else {
            // 2.1 底部草丘厚度陰影
            ctx.fillStyle = 'rgba(85, 139, 47, 0.42)';
            ctx.beginPath();
            ctx.roundRect(px, py + 4, pw, ph, 10);
            ctx.fill();

            const grassGrad = ctx.createRadialGradient(px + pw * 0.35, py + ph * 0.3, 1, px + pw * 0.5, py + ph * 0.5, pw * 0.75);
            grassGrad.addColorStop(0, '#c5e1a5');
            grassGrad.addColorStop(1, '#8bc34a');
            ctx.fillStyle = grassGrad;
            ctx.beginPath();
            ctx.roundRect(px, py, pw, ph, 10);
            ctx.fill();

            // 2.3 內細邊框
            ctx.strokeStyle = 'rgba(104, 159, 56, 0.55)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.roundRect(px + 1, py + 1, pw - 2, ph - 2, 8);
            ctx.stroke();

            // 2.4 草尖細節
            ctx.strokeStyle = '#558b2f';
            ctx.lineWidth = 1.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(px + pw * 0.2, py + ph * 0.85); ctx.lineTo(px + pw * 0.18, py + ph * 0.75);
            ctx.moveTo(px + pw * 0.25, py + ph * 0.85); ctx.lineTo(px + pw * 0.27, py + ph * 0.73);
            ctx.moveTo(px + pw * 0.75, py + ph * 0.25); ctx.lineTo(px + pw * 0.78, py + ph * 0.15);
            ctx.stroke();

            // 2.5 水滴露珠
            ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.beginPath(); ctx.arc(px + pw * 0.6, py + ph * 0.55, 3.5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath(); ctx.arc(px + pw * 0.59, py + ph * 0.53, 1.2, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }

    // 3. 怪物行徑道路：圓潤平滑的古代青石步道
    const pathWidth = cs * 0.76;
    const waypoints = this.map.pathPixels;

    // 3.1 道路深色外框與立體陰影
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(60, 40, 20, 0.25)';
    ctx.lineWidth = pathWidth + 12;
    ctx.beginPath();
    waypoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // 3.2 道路石緣底層
    ctx.strokeStyle = '#a68058';
    ctx.lineWidth = pathWidth + 4;
    ctx.beginPath();
    waypoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // 3.3 道路石板主體（米白古代石磚）
    ctx.strokeStyle = '#f4ecd8';
    ctx.lineWidth = pathWidth;
    ctx.beginPath();
    waypoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // 3.4 鋪設自然鵝卵石 / 復古石紋
    ctx.restore();
    ctx.save();
    for (const cellKey of this.map.pathCells) {
      const [c, r] = cellKey.split(',').map(Number);
      const cx = c * cs + cs / 2;
      const cy = r * cs + cs / 2;
      
      const stones = [
        { dx: -18, dy: -14, rw: 12, rh: 8, col: '#e8dcbf' },
        { dx: 12, dy: -16, rw: 14, rh: 9, col: '#eee4cd' },
        { dx: -10, dy: 14, rw: 16, rh: 10, col: '#dfd2b0' },
        { dx: 16, dy: 12, rw: 11, rh: 8, col: '#e5d7b5' },
        { dx: 0, dy: 0, rw: 18, rh: 12, col: '#fbf5e6' },
      ];
      for (const st of stones) {
        ctx.fillStyle = st.col;
        ctx.beginPath();
        ctx.ellipse(cx + st.dx, cy + st.dy, st.rw, st.rh, (c * 7 + r * 13) % 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(140, 100, 60, 0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();

    // 3.5 道路中心行徑導引點
    ctx.save();
    ctx.strokeStyle = 'rgba(160, 120, 80, 0.45)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    waypoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();

    // 4. 自然裝飾（立體花草、彩色小蘑菇）
    for (const d of this.map.decorations) {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.scale(d.size / 15, d.size / 15);
      if (d.decoType === 'flower1') {
        // 精緻粉紅小花
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.beginPath(); ctx.ellipse(0, 4, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff80ab';
        for (let a = 0; a < 5; a++) {
          const ang = (a * Math.PI * 2) / 5;
          ctx.beginPath();
          ctx.arc(Math.cos(ang) * 5, Math.sin(ang) * 5, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#ffe082';
        ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
      } else if (d.decoType === 'flower2') {
        // 精緻淡藍小花
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.beginPath(); ctx.ellipse(0, 4, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#80d8ff';
        for (let a = 0; a < 4; a++) {
          const ang = (a * Math.PI * 2) / 4 + Math.PI / 4;
          ctx.beginPath();
          ctx.arc(Math.cos(ang) * 5, Math.sin(ang) * 5, 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#fff9c4';
        ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.fill();
      } else if (d.decoType === 'grass') {
        // 金黃荒漠晶石 / 仙人掌灌木
        ctx.fillStyle = '#b8860b';
        ctx.beginPath(); ctx.moveTo(-5, 4); ctx.lineTo(-8, -8); ctx.lineTo(-2, 4); ctx.fill();
        ctx.fillStyle = '#cd853f';
        ctx.beginPath(); ctx.moveTo(-2, 4); ctx.lineTo(0, -12); ctx.lineTo(2, 4); ctx.fill();
        ctx.fillStyle = '#d2691e';
        ctx.beginPath(); ctx.moveTo(2, 4); ctx.lineTo(8, -8); ctx.lineTo(5, 4); ctx.fill();
      } else if (d.decoType === 'mushroom') {
        // 紅色白點小蘑菇
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.beginPath(); ctx.ellipse(0, 6, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(-3, 0, 6, 7);
        ctx.fillStyle = '#ff5252';
        ctx.beginPath(); ctx.arc(0, 0, 8, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(-3, -3, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(3, -4, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(0, -1, 1.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    // 5. 起點主題建築：深淵召喚符文傳送門 (Void Rift Portal)
    const entry = this.map.pathPixels[0];
    const exit = this.map.pathPixels[this.map.pathPixels.length - 1];

    ctx.save();
    ctx.translate(entry.x, entry.y);
    const portalImg = assets.get('spawn_portal');
    if (portalImg) {
      ctx.drawImage(portalImg, -36, -36, 72, 72);
    } else {
      // 5.1 魔法陣基座陰影
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath(); ctx.ellipse(0, 16, 28, 12, 0, 0, Math.PI * 2); ctx.fill();

      // 5.2 古代紫晶黑石魔法底座 (八角星石陣)
      const riftBase = ctx.createRadialGradient(0, 0, 2, 0, 0, 24);
      riftBase.addColorStop(0, '#4a148c');
      riftBase.addColorStop(0.5, '#311b92');
      riftBase.addColorStop(1, '#1a237e');
      ctx.fillStyle = riftBase;
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#b388ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 5.3 內圈神秘符文同心金環
      ctx.strokeStyle = '#ea80fc';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      // 5.4 傳送門立體紫晶立柱（左右兩側黑曜石尖碑）
      for (let side of [-1, 1]) {
        ctx.fillStyle = '#212121';
        ctx.beginPath();
        ctx.moveTo(side * 18, 14);
        ctx.lineTo(side * 22, -18);
        ctx.lineTo(side * 16, -26);
        ctx.lineTo(side * 12, -16);
        ctx.lineTo(side * 14, 14);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#7c4dff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // 尖碑頂端鑲嵌懸浮紫水晶
        ctx.fillStyle = '#e040fb';
        ctx.beginPath();
        ctx.moveTo(side * 16, -28);
        ctx.lineTo(side * 18, -34);
        ctx.lineTo(side * 16, -40);
        ctx.lineTo(side * 14, -34);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();

    // 6. 終點主題建築：極光琉璃水晶樹 (Aurora Crystal Tree)
    ctx.save();
    ctx.translate(exit.x, exit.y);
    const treeImg = assets.get('sacred_tree');
    if (treeImg) {
      // sacred_tree.svg 內已內建地面陰影橢圓，這裡不再重複畫，避免陰影疊加變得混濁

      // 青色外光暈，跟暖色調地圖背景拉開對比，避免淺色水晶樹融進背景
      ctx.save();
      ctx.shadowColor = 'rgba(0, 229, 255, 0.9)';
      ctx.shadowBlur = 16;
      ctx.drawImage(treeImg, -36, -36, 72, 72);
      ctx.restore();
    } else {
      // 6.1 地面晶光倒影陰影
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.beginPath(); ctx.ellipse(0, 20, 28, 10, 0, 0, Math.PI * 2); ctx.fill();

      // 6.2 冰晶折射基座
      ctx.fillStyle = 'rgba(0, 229, 255, 0.35)';
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-24, 10, 48, 13, 5);
      ctx.fill();
      ctx.stroke();

      // 6.3 極光琉璃水晶主幹 (藍白晶透漸層)
      const cGrad = ctx.createLinearGradient(-15, 0, 15, 0);
      cGrad.addColorStop(0, '#80d8ff');
      cGrad.addColorStop(0.5, '#ffffff');
      cGrad.addColorStop(1, '#00b0ff');
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.moveTo(-8, 10);
      ctx.lineTo(-20, -26);
      ctx.lineTo(0, -38);
      ctx.lineTo(20, -26);
      ctx.lineTo(8, 10);
      ctx.closePath();
      ctx.fill();

      // 6.4 琉璃棱鏡多面體立體切面
      const facets = [
        { p: [[0, -38], [-20, -26], [-11, -11], [0, -20]], c: '#e1f5fe' },
        { p: [[0, -38], [20, -26], [11, -11], [0, -20]], c: '#b3e5fc' },
        { p: [[0, -20], [-11, -11], [0, 8]], c: '#4fc3f7' },
        { p: [[0, -20], [11, -11], [0, 8]], c: '#29b6f6' }
      ];
      for (let f of facets) {
        ctx.fillStyle = f.c;
        ctx.beginPath();
        f.p.forEach((pt, idx) => idx === 0 ? ctx.moveTo(pt[0], pt[1]) : ctx.lineTo(pt[0], pt[1]));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }

    // 6.5 頂端神聖晶核亮點
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, -42, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 繪製單一防禦塔卡槽圖示：優先用已載入的 SVG，否則退回手繪 Sprite
  drawTowerIcon(ictx, key) {
    ictx.setTransform(1, 0, 0, 1, 0, 0);
    ictx.clearRect(0, 0, 38, 38);
    const svgImg = assets.get('tower_' + key);
    if (svgImg) {
      ictx.drawImage(svgImg, 3, 3, 32, 32);
    } else {
      ictx.save();
      ictx.translate(19, 21);
      ictx.scale(0.68, 0.68);
      const drawFn = Sprites['drawTower_' + key];
      if (drawFn) drawFn.call(Sprites, ictx, 0, 1);
      ictx.restore();
    }
  }

  // 繪製主動技能快捷欄圖示：#1 卡通天火隕石 & #4 永凍雪花晶核 (Canvas 動態 Sprite)
  drawSkillIcon(ctx, key, time = 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 36, 36);
    ctx.save();
    ctx.translate(18, 18);

    if (key === 'meteor') {
      // ─── #1 卡通天火隕石 (縮小適配 36x36 HUD 圖示) ───
      ctx.save();
      ctx.scale(0.55, 0.55);
      ctx.rotate(-0.65);

      // 1. 最外層深藍氣流光環
      ctx.fillStyle = 'rgba(74, 107, 160, 0.35)';
      ctx.beginPath();
      ctx.arc(-8, 0, 19, Math.PI * 0.5, Math.PI * 1.5);
      ctx.lineTo(24, -14);
      ctx.lineTo(20, 14);
      ctx.closePath();
      ctx.fill();

      // 2. 外層亮橘火焰本體 (#ff732c)
      ctx.fillStyle = '#ff732c';
      ctx.beginPath();
      ctx.arc(-8, 0, 16, Math.PI * 0.5, Math.PI * 1.5);
      ctx.lineTo(2, -16);
      ctx.lineTo(14, -13);
      ctx.lineTo(22, -10);
      ctx.lineTo(16, -6);
      ctx.lineTo(28, 0);
      ctx.lineTo(18, 4);
      ctx.lineTo(24, 8);
      ctx.lineTo(10, 12);
      ctx.lineTo(18, 15);
      ctx.lineTo(-8, 16);
      ctx.closePath();
      ctx.fill();

      // 3. 亮橘色火滴
      [[26, -15, 2.5, 1.8], [29, 10, 2.2, 1.6], [10, -18, 2, 1.5], [12, 18, 2, 1.5]].forEach(([dx, dy, rx, ry]) => {
        ctx.beginPath(); ctx.ellipse(dx, dy, rx, ry, -0.3, 0, Math.PI * 2); ctx.fill();
      });

      // 4. 內層金黃火焰包覆 (#ffc926)
      ctx.fillStyle = '#ffc926';
      ctx.beginPath();
      ctx.arc(-8, 0, 13, Math.PI * 0.5, Math.PI * 1.5);
      ctx.quadraticCurveTo(-1, -13, 1, -8);
      ctx.quadraticCurveTo(8, -4, 4, 0);
      ctx.quadraticCurveTo(9, 6, 2, 9);
      ctx.quadraticCurveTo(-2, 13, -8, 13);
      ctx.closePath();
      ctx.fill();

      // 5. 橘色火尾內部的黃色亮斑
      [[10, -6, 3, 2], [16, -3, 2.5, 1.8], [12, 4, 2.2, 1.5]].forEach(([gx, gy, rx, ry]) => {
        ctx.beginPath(); ctx.ellipse(gx, gy, rx, ry, -0.2, 0, Math.PI * 2); ctx.fill();
      });

      // 6. 灰褐色隕石核心 (#8e7c75)
      ctx.fillStyle = '#8e7c75';
      ctx.beginPath(); ctx.arc(-8, 0, 10, 0, Math.PI * 2); ctx.fill();

      // 7. 隕石坑洞細節 (#63534d)
      ctx.fillStyle = '#63534d';
      ctx.beginPath(); ctx.ellipse(-6, 2, 2.6, 2.2, 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-10, 4, 1.8, 1.4, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-9, -4, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-5, -3, 1, 0, Math.PI * 2); ctx.fill();

      ctx.restore();
    } else if (key === 'freeze') {
      // ─── #4 永凍雪花晶核 (六角青藍雪花 + 冰晶分叉 + 冰霜微粒) ───
      ctx.save();
      ctx.scale(0.85, 0.85);

      // 六角雪花主幹與分叉
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';

      for (let i = 0; i < 6; i++) {
        const ang = (i * Math.PI) / 3;
        const x = Math.cos(ang) * 15;
        const y = Math.sin(ang) * 15;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x, y);
        ctx.stroke();

        // 冰晶分叉
        const bx = Math.cos(ang) * 8;
        const by = Math.sin(ang) * 8;
        const a1 = ang + Math.PI / 4;
        const a2 = ang - Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a1) * 4.5, by + Math.sin(a1) * 4.5);
        ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a2) * 4.5, by + Math.sin(a2) * 4.5);
        ctx.stroke();
      }

      // 冰核光芒光環
      ctx.fillStyle = 'rgba(0, 229, 255, 0.35)';
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#e0f7fa';
      ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();

      ctx.restore();
    }
    ctx.restore();
  }

  // 繪製首頁精靈世界樹大插畫：優先用已載入的 SVG，否則退回手繪 Sprite
  drawTitleTree(tctx) {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, 80, 80);
    tctx.translate(40, 48);

    const treeImg = assets.get('sacred_tree');
    if (treeImg) {
      tctx.save();
      tctx.shadowColor = 'rgba(0, 229, 255, 0.9)';
      tctx.shadowBlur = 10;
      tctx.drawImage(treeImg, -38, -46, 76, 76);
      tctx.restore();
      return;
    }

    // 地面晶光微光倒影
    tctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    tctx.beginPath(); tctx.ellipse(0, 22, 28, 10, 0, 0, Math.PI * 2); tctx.fill();

    // 水晶台座
    tctx.fillStyle = '#26c6da';
    tctx.strokeStyle = '#00e5ff';
    tctx.lineWidth = 1.5;
    tctx.beginPath();
    tctx.roundRect(-22, 10, 44, 12, 4);
    tctx.fill();
    tctx.stroke();

    // 琉璃晶樹主幹
    const tcGrad = tctx.createLinearGradient(-16, 0, 16, 0);
    tcGrad.addColorStop(0, '#80d8ff');
    tcGrad.addColorStop(0.5, '#ffffff');
    tcGrad.addColorStop(1, '#00b0ff');
    tctx.fillStyle = tcGrad;
    tctx.beginPath();
    tctx.moveTo(-9, 10);
    tctx.lineTo(-24, -22);
    tctx.lineTo(0, -38);
    tctx.lineTo(24, -22);
    tctx.lineTo(9, 10);
    tctx.closePath();
    tctx.fill();

    // 晶芒切面
    const titleFacets = [
      { p: [[0, -38], [-24, -22], [-12, -8], [0, -18]], c: '#e1f5fe' },
      { p: [[0, -38], [24, -22], [12, -8], [0, -18]], c: '#b3e5fc' },
      { p: [[0, -18], [-12, -8], [0, 8]], c: '#4fc3f7' },
      { p: [[0, -18], [12, -8], [0, 8]], c: '#29b6f6' }
    ];
    for (let tf of titleFacets) {
      tctx.fillStyle = tf.c;
      tctx.beginPath();
      tf.p.forEach((pt, idx) => idx === 0 ? tctx.moveTo(pt[0], pt[1]) : tctx.lineTo(pt[0], pt[1]));
      tctx.closePath();
      tctx.fill();
      tctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      tctx.lineWidth = 0.8;
      tctx.stroke();
    }

    // 頂端神聖守護晶核光芒
    tctx.shadowColor = '#00e5ff';
    tctx.shadowBlur = 14;
    tctx.fillStyle = '#ffffff';
    tctx.beginPath();
    tctx.arc(0, -42, 6, 0, Math.PI * 2);
    tctx.fill();
  }

  // SVG 資源在塔卡槽/技能欄/首頁插畫建立當下往往還沒載入完成，等全部載入完後重繪一次圖示
  refreshIcons() {
    document.querySelectorAll('.tower-item').forEach((item) => {
      const canvas = item.querySelector('.tower-mini-canvas');
      if (canvas) this.drawTowerIcon(canvas.getContext('2d'), item.dataset.type);
    });
    const meteorCv = document.getElementById('skill-canvas-meteor');
    if (meteorCv) this.drawSkillIcon(meteorCv.getContext('2d'), 'meteor');
    const freezeCv = document.getElementById('skill-canvas-freeze');
    if (freezeCv) this.drawSkillIcon(freezeCv.getContext('2d'), 'freeze');
    const titleCv = document.getElementById('menu-title-canvas');
    if (titleCv) this.drawTitleTree(titleCv.getContext('2d'));
  }

  // ─── UI Setup ───
  setupUI() {
    // 動態綁定程式設定的版本號
    const versionBadge = document.getElementById('menu-version-badge');
    if (versionBadge) {
      const isDev = CONFIG.VERSION.includes('dev');
      versionBadge.textContent = `${isDev ? '開發版' : '正式版'} ${CONFIG.VERSION}`;
    }

    // 繪製專屬技能 Canvas 圖標 (完全告別 Emoji)
    const meteorCv = document.getElementById('skill-canvas-meteor');
    if (meteorCv) this.drawSkillIcon(meteorCv.getContext('2d'), 'meteor');

    const freezeCv = document.getElementById('skill-canvas-freeze');
    if (freezeCv) this.drawSkillIcon(freezeCv.getContext('2d'), 'freeze');

    // 繪製首頁精靈世界樹大插畫 Canvas (Aurora Crystal World Tree)
    const titleCv = document.getElementById('menu-title-canvas');
    if (titleCv) this.drawTitleTree(titleCv.getContext('2d'));

    // 繪製勝利金冠插畫 Canvas (告別 🎉 Emoji)
    const vicCv = document.getElementById('victory-canvas');
    if (vicCv) {
      const vctx = vicCv.getContext('2d');
      vctx.clearRect(0, 0, 70, 70);
      vctx.translate(35, 38);
      // 金色皇冠
      const crGrad = vctx.createLinearGradient(0, -20, 0, 15);
      crGrad.addColorStop(0, '#fff59d');
      crGrad.addColorStop(0.5, '#ffd54f');
      crGrad.addColorStop(1, '#ff8f00');
      vctx.fillStyle = crGrad;
      vctx.beginPath();
      vctx.moveTo(-24, 12);
      vctx.lineTo(-26, -14);
      vctx.lineTo(-12, -4);
      vctx.lineTo(0, -22);
      vctx.lineTo(12, -4);
      vctx.lineTo(26, -14);
      vctx.lineTo(24, 12);
      vctx.closePath();
      vctx.fill();
      vctx.strokeStyle = '#ff6f00';
      vctx.lineWidth = 2;
      vctx.stroke();
      // 皇冠頂端 3 顆紅寶石
      vctx.fillStyle = '#ff1744';
      vctx.beginPath(); vctx.arc(-26, -14, 3, 0, Math.PI * 2); vctx.fill();
      vctx.beginPath(); vctx.arc(0, -22, 4, 0, Math.PI * 2); vctx.fill();
      vctx.beginPath(); vctx.arc(26, -14, 3, 0, Math.PI * 2); vctx.fill();
    }

    // 繪製失敗碎裂心之水晶 Canvas (告別 💔 Emoji)
    const govCv = document.getElementById('gameover-canvas');
    if (govCv) {
      const gctx = govCv.getContext('2d');
      gctx.clearRect(0, 0, 70, 70);
      gctx.translate(35, 35);
      // 暗紫裂紋心靈護盾
      const hGrad = gctx.createRadialGradient(-4, -4, 2, 0, 0, 22);
      hGrad.addColorStop(0, '#ef5350');
      hGrad.addColorStop(0.7, '#c62828');
      hGrad.addColorStop(1, '#3e2723');
      gctx.fillStyle = hGrad;
      // 繪製心形
      gctx.beginPath();
      gctx.moveTo(0, 16);
      gctx.bezierCurveTo(-22, 2, -22, -16, 0, -8);
      gctx.bezierCurveTo(22, -16, 22, 2, 0, 16);
      gctx.fill();
      // 心形中央閃電裂痕
      gctx.strokeStyle = '#ffffff';
      gctx.lineWidth = 2.5;
      gctx.beginPath();
      gctx.moveTo(0, -10);
      gctx.lineTo(-4, -2);
      gctx.lineTo(5, 5);
      gctx.lineTo(-2, 10);
      gctx.lineTo(0, 16);
      gctx.stroke();
    }

    const list = document.getElementById('tower-list');
    list.innerHTML = '';

    for (const [key, data] of Object.entries(TOWER_DATA)) {
      const item = document.createElement('div');
      item.className = 'tower-item';
      item.dataset.type = key;

      // 建立專屬 Mini Canvas 進行 SVG / 3D 繪製 (無限放大不失焦)
      const iconCanvas = document.createElement('canvas');
      iconCanvas.width = 38;
      iconCanvas.height = 38;
      iconCanvas.className = 'tower-mini-canvas';
      this.drawTowerIcon(iconCanvas.getContext('2d'), key);

      item.appendChild(iconCanvas);

      const details = document.createElement('div');
      details.className = 'tower-details';
      details.innerHTML = `
        <div class="tower-cost">💰${data.cost}</div>
      `;
      item.appendChild(details);

      // 支援手勢鎖定：'pending' | 'scrolling' | 'dragging' 互斥機制
      let isPressed = false;
      let startX = 0, startY = 0;
      let gestureState = 'pending'; // 手勢狀態獨佔鎖

      const startPress = (clientX, clientY) => {
        if (this.state !== 'planning' && this.state !== 'wave') return;
        if (!isTowerUnlocked(key)) {
          this.showToast('🔒 這座塔尚未在商店解鎖');
          return;
        }
        startX = clientX;
        startY = clientY;
        isPressed = true;
        gestureState = 'pending';

        // 按下狀態立即顯示塔的資訊
        this.deselectTower();
        this.showTowerPreviewInfo(key);
      };

      const movePress = (clientX, clientY, isTouch = false) => {
        if (!isPressed) return;
        const deltaX = clientX - startX;
        const deltaY = clientY - startY;

        // 向上位移 (Y 軸) 超過 20pt (deltaY < -20)，不論之前是否在滾動中，立刻轉為「拖曳建塔」
        if (gestureState !== 'dragging') {
          if (deltaY < -20) {
            if (this.gold < data.cost) {
              return;
            }
            gestureState = 'dragging';
            document.getElementById('tower-info')?.classList.add('hidden');
            const cancelZone = document.getElementById('tower-cancel-zone');
            const cancelText = document.getElementById('cancel-zone-text');
            if (cancelZone) cancelZone.classList.remove('hidden');
            if (cancelText) cancelText.textContent = '取消建設';

            this.draggingTowerType = key;
            this.isDragging = true;
            item.classList.add('is-dragging');
            document.getElementById('game-viewport')?.classList.add('is-dragging-active');
          } else if (gestureState === 'pending') {
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            if (absX > absY && absX > 4) {
              gestureState = 'scrolling';
            }
          }
        }

        // 2. 已鎖定為建塔狀態：計算拖曳放塔位置與取消區域碰撞
        if (gestureState === 'dragging') {
          const panel = document.getElementById('tower-panel');
          const cancelZone = document.getElementById('tower-cancel-zone');
          if (panel && cancelZone) {
            const panelRect = panel.getBoundingClientRect();
            if (
              clientX >= panelRect.left &&
              clientX <= panelRect.right &&
              clientY >= panelRect.top &&
              clientY <= panelRect.bottom
            ) {
              cancelZone.classList.add('hover-cancel');
              this.isHoveringCancelZone = true;
            } else {
              cancelZone.classList.remove('hover-cancel');
              this.isHoveringCancelZone = false;
            }
          }

          const rect = this.canvas.getBoundingClientRect();
          const scaleX = this.canvas.width / rect.width;
          const scaleY = this.canvas.height / rect.height;

          // 計算 Canvas 內座標（手機觸控時向上偏移 35px 避免手指遮擋視線）
          const offsetY = isTouch ? -35 : 0;
          const cx = (clientX - rect.left) * scaleX;
          const cy = (clientY - rect.top + offsetY) * scaleY;
          this.dragPos = { x: cx, y: cy };

          const { col, row } = pixelToGrid(cx, cy);
          if (col >= 0 && col < CONFIG.COLS && row >= 0 && row < CONFIG.ROWS) {
            this.hoverCell = { col, row };
          } else {
            this.hoverCell = null;
          }
        }
      };

      const endPress = (clientX, clientY, isTouch = false) => {
        isPressed = false;
        // 隱藏取消覆蓋層
        const cancelZone = document.getElementById('tower-cancel-zone');
        if (cancelZone) {
          cancelZone.classList.add('hidden');
          cancelZone.classList.remove('hover-cancel');
        }

        if (gestureState === 'dragging') {
          item.classList.remove('is-dragging');

          if (this.isHoveringCancelZone) {
            this.isHoveringCancelZone = false;
            this.showToast('已取消防禦塔建造');
            this.sfx.play('tap');
          } else {
            // 直接沿用拖曳預覽最後一次算出的 hoverCell，確保放置位置與預覽 100% 一致
            const cell = this.hoverCell;
            if (cell) {
              const { col, row } = cell;
              this.selectedTowerType = key;
              this.placeTower(col, row);
              this.selectedTowerType = null;
            }
          }
          this.draggingTowerType = null;
          this.dragPos = null;
          this.isDragging = false;
          this.hoverCell = null;
          document.getElementById('game-viewport')?.classList.remove('is-dragging-active');
          this.updateTowerPanel();
        }

        // 手指放開後隱藏預覽資訊框
        document.getElementById('tower-info')?.classList.add('hidden');
        gestureState = 'pending';
      };

      // Touch 全域監聽（確保手指移出卡片時 100% 能實時追蹤位置）
      item.addEventListener('touchstart', (e) => {
        this.sfx.init();
        this.sfx.resume();
        if (e.touches.length > 0) {
          startPress(e.touches[0].clientX, e.touches[0].clientY);

          const onTouchMove = (ev) => {
            if (ev.touches.length > 0) {
              movePress(ev.touches[0].clientX, ev.touches[0].clientY, true);
              if (gestureState === 'dragging' && ev.cancelable) {
                ev.preventDefault();
              }
            }
          };

          const onTouchEnd = (ev) => {
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
            window.removeEventListener('touchcancel', onTouchEnd);
            const touch = ev.changedTouches[0];
            endPress(touch.clientX, touch.clientY, true);
          };

          window.addEventListener('touchmove', onTouchMove, { passive: false });
          window.addEventListener('touchend', onTouchEnd, { passive: true });
          window.addEventListener('touchcancel', onTouchEnd, { passive: true });
        }
      }, { passive: true });

      item.addEventListener('touchcancel', () => {
        isPressed = false;
        const towerList = document.getElementById('tower-list');
        if (towerList) towerList.style.overflowX = 'auto';

        if (gestureState === 'dragging') {
          item.classList.remove('is-dragging');
          this.draggingTowerType = null;
          this.dragPos = null;
          this.isDragging = false;
          this.hoverCell = null;
        }
        gestureState = 'pending';
        document.getElementById('tower-info').classList.add('hidden');
      });

      // Mouse 事件（桌機相容）
      item.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        startPress(e.clientX, e.clientY);

        const onMouseMove = (ev) => {
          movePress(ev.clientX, ev.clientY);
        };
        const onMouseUp = (ev) => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          endPress(ev.clientX, ev.clientY);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      list.appendChild(item);
    }

    // 關卡輪探初始化
    this.renderLevelCarousel();
    this.setupLevelStarTip();

    // Buttons (使用 pointer/click 防重複觸發機制)
    const bindTap = (btnId, handler) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      let lastTrigger = 0;
      const trigger = (e) => {
        const now = Date.now();
        if (now - lastTrigger < 350) return; // 防短時間內 click 與 touchend 連續觸發
        lastTrigger = now;
        dbgLog('🎯 Button triggered: #' + btnId);
        handler();
      };
      btn.addEventListener('click', trigger);
      btn.addEventListener('touchend', (e) => {
        e.preventDefault(); // 阻止緊隨其後的 300ms 模擬 click
        trigger(e);
      }, { passive: false });
    };

    bindTap('start-btn', () => this.startGame());
    bindTap('level-prev-btn', () => this.changeLevel(-1));
    bindTap('level-next-btn', () => this.changeLevel(1));
    bindTap('start-wave-btn', () => this.startNextWave());
    bindTap('retry-btn', () => this.restartGame());
    bindTap('replay-btn', () => this.restartGame());
    bindTap('gameover-menu-btn', () => this.quitToMenu());
    bindTap('victory-menu-btn', () => this.quitToMenu());
    bindTap('open-leaderboard-btn', () => this.openLeaderboardModal());
    bindTap('gameover-open-lb-btn', () => this.openLeaderboardModal());
    bindTap('victory-open-lb-btn', () => this.openLeaderboardModal());
    bindTap('close-leaderboard-btn', () => this.closeLeaderboardModal());
    bindTap('open-shop-btn', () => this.openShopModal());
    bindTap('close-shop-btn', () => this.closeShopModal());
    
    // 商店主狀態頁籤 (全部 / 未解鎖 / 已解鎖)
    document.querySelectorAll('.shop-status-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.shop-status-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.shopStatusTab = btn.dataset.tab;
        this.renderShopItems();
        this.sfx.play('tap');
      });
    });

    // 商店子種類過濾 (全部種類 / 防禦塔 / 魔法技能)
    document.querySelectorAll('.shop-sub-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.shop-sub-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.shopKindFilter = btn.dataset.filter;
        this.renderShopItems();
        this.sfx.play('tap');
      });
    });

    bindTap('lb-tab-score', () => this.switchLeaderboardTab('score'));
    bindTap('lb-tab-gold', () => this.switchLeaderboardTab('gold'));
    bindTap('speed-btn', () => this.toggleSpeed());
    bindTap('upgrade-btn', () => this.upgradeTower());
    bindTap('sell-btn', () => this.sellTower());
    bindTap('close-info-btn', () => this.deselectTower());
    
    // Settings modal bindings
    bindTap('settings-btn', () => this.openSettingsModal());
    bindTap('settings-close-btn', () => this.closeSettingsModal());
    bindTap('settings-resume-btn', () => this.closeSettingsModal());
    bindTap('settings-sound-btn', () => {
      const enabled = this.sfx.toggle();
      const statusText = document.getElementById('sound-status-text');
      if (statusText) statusText.textContent = enabled ? '音效：開啟' : '音效：靜音';
      const icon = document.querySelector('#settings-sound-btn .settings-opt-icon');
      if (icon) icon.innerHTML = SOUND_ICON_SVG[enabled ? 'on' : 'off'];
    });
    bindTap('settings-fullscreen-btn', () => this.toggleFullscreen());
    bindTap('settings-retry-btn', () => {
      this.closeSettingsModal();
      this.restartGame();
    });
    bindTap('settings-quit-btn', () => {
      this.closeSettingsModal();
      this.quitToMenu();
    });

    // Fullscreen change listener
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
    document.addEventListener('webkitfullscreenchange', () => this.onFullscreenChange());

    // Responsive canvas scaling
    window.addEventListener('resize', () => this.resizeCanvas());
    this.resizeCanvas();

    // Best score
    const menuScore = document.getElementById('menu-best-score');
    if (menuScore) menuScore.textContent = this.bestScore;
  }

  // 解鎖是連續的（解鎖第 N 關必先通關第 N-1 關）。可瀏覽範圍 = 已解鎖的關卡，
  // 再加上緊接在解鎖前線後面的「下一個尚未解鎖」關卡（讓玩家能預覽鎖著的下一關），
  // 但不能再往後預覽更遠的關卡。
  getMaxBrowsableLevelIndex() {
    const progress = loadLevelProgress();
    let lastUnlockedIndex = -1;
    for (let i = 0; i < LEVEL_DATA.length; i++) {
      const entry = progress.levels[LEVEL_DATA[i].id];
      if (entry && entry.unlocked) {
        lastUnlockedIndex = i;
      } else {
        break;
      }
    }
    return Math.min(lastUnlockedIndex + 1, LEVEL_DATA.length - 1);
  }

  // 切換關卡輪探目前顯示的關卡（只能瀏覽已通關關卡，或緊接著的下一個未通關關卡）
  changeLevel(delta) {
    const next = CURRENT_LEVEL_INDEX + delta;
    if (next < 0 || next > this.getMaxBrowsableLevelIndex()) return;
    CURRENT_LEVEL_INDEX = next;
    this.sfx.play('tap');
    this.renderLevelCarousel();
  }

  renderLevelCarousel() {
    this.updateCrystalBalanceUI();
    const level = LEVEL_DATA[CURRENT_LEVEL_INDEX];
    const progress = loadLevelProgress();
    const entry = progress.levels[level.id] || { stars: 0, unlocked: CURRENT_LEVEL_INDEX === 0 };

    // 套用該關卡的地圖（僅預覽用途，實際遊玩以 startGame() 的檢查為準）
    CURRENT_MAP_ID = level.mapId;
    this.map = new GameMap(level.mapId);
    this.renderMapToBuffer();

    const nameEl = document.getElementById('level-card-name');
    if (nameEl) nameEl.textContent = `${level.name}${entry.unlocked ? '' : '（尚未解鎖）'}`;

    const starsEl = document.getElementById('level-card-stars');
    if (starsEl) {
      starsEl.innerHTML = [1, 2, 3].map(i => `<span class="${i <= entry.stars ? 'star-filled' : 'star-empty'}">★</span>`).join('');
    }

    const lockEl = document.getElementById('level-lock-overlay');
    if (lockEl) lockEl.classList.toggle('hidden', entry.unlocked);

    dbgLog(`🗺️ 關卡輪探顯示：index=${CURRENT_LEVEL_INDEX} (${level.id}) unlocked=${entry.unlocked}`);

    const prevBtn = document.getElementById('level-prev-btn');
    if (prevBtn) prevBtn.disabled = (CURRENT_LEVEL_INDEX === 0);
    const nextBtn = document.getElementById('level-next-btn');
    if (nextBtn) nextBtn.disabled = (CURRENT_LEVEL_INDEX >= this.getMaxBrowsableLevelIndex());

    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.classList.toggle('btn-locked', !entry.unlocked);
  }

  // 按住關卡卡片顯示每顆星的寶箱獎勵，放開就消失（只綁一次，內容每次按下時即時計算）
  setupLevelStarTip() {
    const card = document.getElementById('level-carousel-card');
    const tip = document.getElementById('level-star-tip');
    if (!card || !tip) return;

    const showTip = () => {
      const level = LEVEL_DATA[CURRENT_LEVEL_INDEX];
      const progress = loadLevelProgress();
      const entry = progress.levels[level.id] || { stars: 0 };
      tip.innerHTML = [1, 2, 3].map(tier => {
        const reward = CHEST_REWARDS[tier - 1];
        const done = entry.stars >= tier;
        return `<div class="star-tip-row${done ? ' star-tip-done' : ''}">★${tier} 💎${reward}${done ? ' ✅' : ''}</div>`;
      }).join('');
      tip.classList.remove('hidden');
    };
    const hideTip = () => tip.classList.add('hidden');

    card.addEventListener('mousedown', showTip);
    card.addEventListener('mouseup', hideTip);
    card.addEventListener('mouseleave', hideTip);
    card.addEventListener('touchstart', showTip, { passive: true });
    card.addEventListener('touchend', hideTip);
    card.addEventListener('touchcancel', hideTip);
  }

  setupEvents() {
    // 統一座標轉換輔助函式（完美相容 iOS Safari 與 Android Touch/Mouse）
    const getCanvasPos = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    };

    // Mouse events
    this.canvas.addEventListener('click', (e) => {
      const pos = getCanvasPos(e.clientX, e.clientY);
      this.handleCanvasPoint(pos.x, pos.y);
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const pos = getCanvasPos(e.clientX, e.clientY);
      this.mouseX = pos.x;
      this.mouseY = pos.y;
      const { col, row } = pixelToGrid(pos.x, pos.y);
      if (col >= 0 && col < CONFIG.COLS && row >= 0 && row < CONFIG.ROWS) {
        this.hoverCell = { col, row };
      } else {
        this.hoverCell = null;
      }

      if (this.state === 'planning' && this.map.pathPixels.length > 0) {
        const entry = this.map.pathPixels[0];
        const distToEntry = Math.hypot(pos.x - entry.x, pos.y - entry.y);
        if (distToEntry <= CONFIG.CELL_SIZE * 0.65) {
          this.canvas.style.cursor = 'pointer';
          return;
        }
      }
      if (!this.selectedTowerType) {
        this.canvas.style.cursor = 'crosshair';
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoverCell = null;
    });

    // Touch support (iOS Safari & Android)
    this.canvas.addEventListener('touchstart', (e) => {
      this.sfx.init();
      this.sfx.resume();
      if (e.cancelable) {
        e.preventDefault();
      }
      if (e.touches && e.touches.length > 0) {
        const touch = e.touches[0];
        const pos = getCanvasPos(touch.clientX, touch.clientY);
        const { col, row } = pixelToGrid(pos.x, pos.y);
        if (col >= 0 && col < CONFIG.COLS && row >= 0 && row < CONFIG.ROWS) {
          this.hoverCell = { col, row };
        }
        this.handleCanvasPoint(pos.x, pos.y);
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      if (e.target === this.canvas) {
        e.preventDefault();
      }
      if (e.touches && e.touches.length > 0) {
        const touch = e.touches[0];
        const pos = getCanvasPos(touch.clientX, touch.clientY);
        const { col, row } = pixelToGrid(pos.x, pos.y);
        if (col >= 0 && col < CONFIG.COLS && row >= 0 && row < CONFIG.ROWS) {
          this.hoverCell = { col, row };
        } else {
          this.hoverCell = null;
        }
      }
    }, { passive: false });

    // 全域解鎖 iOS AudioContext
    window.addEventListener('touchstart', () => {
      this.sfx.init();
      this.sfx.resume();
    }, { once: true });

    window.addEventListener('click', () => {
      this.sfx.init();
      this.sfx.resume();
    }, { once: true });

    // 全域防止 iOS Safari 長按呼叫選單、雙擊放大與手勢縮放
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('gesturestart', (e) => {
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('gesturechange', (e) => {
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('gestureend', (e) => {
      e.preventDefault();
    }, { passive: false });

    // 阻斷 iOS 快速雙擊觸發 Viewport Zoom（在 touchstart 階段若兩次間隔小於 350ms 且非可點擊元件，直接 preventDefault）
    let lastTouchTime = 0;
    document.addEventListener('touchstart', (e) => {
      const now = Date.now();
      if (now - lastTouchTime <= 350) {
        // 商店裡一律禁止雙擊縮放，不論點到什麼元件
        const inShopModal = e.target && e.target.closest('#shop-modal');
        // 如果不是按鈕或卡片元件，阻止雙擊放大行為
        const isClickable = e.target && (
          e.target.tagName === 'BUTTON' ||
          e.target.tagName === 'SELECT' ||
          e.target.tagName === 'OPTION' ||
          e.target.closest('button') ||
          e.target.closest('select') ||
          e.target.closest('.level-carousel-card') ||
          e.target.closest('.tower-item') ||
          e.target.closest('.menu-champion-card') ||
          e.target.closest('.leaderboard-modal-content') ||
          e.target.closest('#debug-container')
        );
        if ((inShopModal || !isClickable) && e.cancelable) {
          e.preventDefault();
        }
      }
      lastTouchTime = now;
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchTime <= 300) {
        const inShopModal = e.target && e.target.closest('#shop-modal');
        const isClickable = e.target && (
          e.target.tagName === 'BUTTON' ||
          e.target.tagName === 'SELECT' ||
          e.target.tagName === 'OPTION' ||
          e.target.closest('button') ||
          e.target.closest('select') ||
          e.target.closest('.level-carousel-card') ||
          e.target.closest('.tower-item') ||
          e.target.closest('.menu-champion-card') ||
          e.target.closest('.leaderboard-modal-content') ||
          e.target.closest('#debug-container')
        );
        if ((inShopModal || !isClickable) && e.cancelable) {
          e.preventDefault();
        }
      }
    }, { passive: false });

    // 防止多指縮放手勢 (Pinch to zoom)，以及阻止 iOS 整頁被拖曳彈跳捲動
    // （overflow:hidden 對 iOS Safari 的整頁橡皮筋捲動無效，只有在允許捲動的區塊內才放行）
    document.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
        return;
      }
      const inScrollableArea = e.target && e.target.closest('.screen, #tower-list, #debug-log, #debug-test-panel');
      if (!inScrollableArea && e.cancelable) {
        e.preventDefault();
      }
    }, { passive: false });

    // Active skill buttons (流星轟炸拖曳施法 Drag-to-Cast)
    const meteorBtn = document.getElementById('skill-meteor-btn');
    if (meteorBtn) {
      let isDraggingMeteor = false;

      const startMeteorDrag = (clientX, clientY) => {
        if (!isSkillUnlocked('meteor')) {
          this.showToast('🔒 這個技能尚未在商店解鎖');
          this.sfx.play('error');
          return;
        }
        if (this.state !== 'wave') {
          this.showToast('戰鬥開始後才能施放技能！');
          this.sfx.play('error');
          return;
        }
        const skill = this.skills.meteor;
        if (skill.timer > 0) {
          this.showToast(`技能冷卻中 (${Math.ceil(skill.timer)} 秒)`);
          this.sfx.play('error');
          return;
        }

        isDraggingMeteor = true;
        this.activeTargetingSkill = 'meteor';
        meteorBtn.classList.add('targeting');
        
        // 動態顯示取消覆蓋層並設定文案
        const cancelZone = document.getElementById('tower-cancel-zone');
        const cancelText = document.getElementById('cancel-zone-text');
        if (cancelZone) cancelZone.classList.remove('hidden');
        if (cancelText) cancelText.textContent = '取消施放';

        // 計算 Canvas 座標
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        this.mouseX = (clientX - rect.left) * scaleX;
        this.mouseY = (clientY - rect.top) * scaleY;
      };

      const moveMeteorDrag = (clientX, clientY) => {
        if (!isDraggingMeteor) return;
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        this.mouseX = (clientX - rect.left) * scaleX;
        this.mouseY = (clientY - rect.top) * scaleY;

        // 檢查是否移入底部塔面板取消區域 (#tower-panel / #tower-cancel-zone)
        const panel = document.getElementById('tower-panel');
        const cancelZone = document.getElementById('tower-cancel-zone');
        if (panel && cancelZone) {
          const panelRect = panel.getBoundingClientRect();
          if (
            clientX >= panelRect.left &&
            clientX <= panelRect.right &&
            clientY >= panelRect.top &&
            clientY <= panelRect.bottom
          ) {
            cancelZone.classList.add('hover-cancel');
            this.isHoveringCancelZone = true;
          } else {
            cancelZone.classList.remove('hover-cancel');
            this.isHoveringCancelZone = false;
          }
        }
      };

      const endMeteorDrag = (clientX, clientY) => {
        if (!isDraggingMeteor) return;
        isDraggingMeteor = false;
        meteorBtn.classList.remove('targeting');

        // 隱藏取消覆蓋層
        const cancelZone = document.getElementById('tower-cancel-zone');
        if (cancelZone) {
          cancelZone.classList.add('hidden');
          cancelZone.classList.remove('hover-cancel');
        }

        if (this.isHoveringCancelZone) {
          this.isHoveringCancelZone = false;
          this.activeTargetingSkill = null;
          this.showToast('已取消技能施放');
          this.sfx.play('tap');
          return;
        }

        // 判定放開位置是否在 Canvas 有效區域內
        const rect = this.canvas.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          const scaleX = this.canvas.width / rect.width;
          const scaleY = this.canvas.height / rect.height;
          const px = (clientX - rect.left) * scaleX;
          const py = (clientY - rect.top) * scaleY;
          this.castMeteor(px, py);
        } else {
          this.activeTargetingSkill = null;
          this.showToast('取消施放 (請拖曳至戰場區域)');
        }
      };

      // 觸控事件
      meteorBtn.addEventListener('touchstart', (e) => {
        if (e.touches.length > 0) {
          startMeteorDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: true });

      meteorBtn.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
          moveMeteorDrag(e.touches[0].clientX, e.touches[0].clientY);
          if (isDraggingMeteor) e.preventDefault();
        }
      }, { passive: false });

      meteorBtn.addEventListener('touchend', (e) => {
        const touch = e.changedTouches[0];
        endMeteorDrag(touch.clientX, touch.clientY);
      }, { passive: true });

      // 滑鼠事件 (桌機測試)
      meteorBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        startMeteorDrag(e.clientX, e.clientY);
        const onMouseMove = (ev) => moveMeteorDrag(ev.clientX, ev.clientY);
        const onMouseUp = (ev) => {
          endMeteorDrag(ev.clientX, ev.clientY);
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    }

    document.getElementById('skill-freeze-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSkillTargeting('freeze');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.activeTargetingSkill = null;
        document.getElementById('skill-meteor-btn')?.classList.remove('targeting');
        this.selectedTowerType = null;
        this.deselectTower();
        this.updateTowerPanel();
      }
      if (e.key === ' ' && this.state === 'planning') {
        e.preventDefault();
        this.startNextWave();
      }
      if (e.key === '1') {
        this.toggleSkillTargeting('meteor');
      }
      if (e.key === '2') {
        this.toggleSkillTargeting('freeze');
      }
    });
  }

  // ─── Canvas interaction ───
  handleCanvasPoint(px, py) {
    const { col, row } = pixelToGrid(px, py);

    if (this.state !== 'planning' && this.state !== 'wave') return;

    // 施放主動瞄準技能（如：流星轟炸）
    if (this.activeTargetingSkill === 'meteor') {
      this.castMeteor(px, py);
      return;
    }

    // 點擊起點出怪口：直接觸發出怪開始波次
    if (this.state === 'planning' && this.map.pathPixels.length > 0) {
      const entry = this.map.pathPixels[0];
      const distToEntry = Math.hypot(px - entry.x, py - entry.y);
      if (distToEntry <= CONFIG.CELL_SIZE * 0.65) {
        this.startNextWave();
        return;
      }
    }

    // Placing a tower
    if (this.selectedTowerType) {
      this.placeTower(col, row);
      return;
    }

    // Check if clicking on existing tower
    const key = `${col},${row}`;
    const existingTower = this.towerGrid[key];
    if (existingTower) {
      this.selectTower(existingTower);
    } else {
      this.deselectTower();
    }
  }

  // ─── Active Skills (主動技能系統) ───
  toggleSkillTargeting(skillKey) {
    if (!isSkillUnlocked(skillKey)) {
      this.showToast('🔒 這個技能尚未在商店解鎖');
      this.sfx.play('error');
      return;
    }
    if (this.state !== 'wave') {
      this.showToast('戰鬥開始後才能施放技能！');
      this.sfx.play('error');
      return;
    }
    const skill = this.skills[skillKey];
    if (skill.timer > 0) {
      this.showToast(`技能冷卻中 (${Math.ceil(skill.timer)} 秒)`);
      this.sfx.play('error');
      return;
    }

    if (skillKey === 'freeze') {
      // 絕對零度立即全螢幕生效
      this.castFreeze();
      return;
    }

    if (this.activeTargetingSkill === skillKey) {
      this.activeTargetingSkill = null;
      document.getElementById('skill-meteor-btn')?.classList.remove('targeting');
      this.showToast('取消技能施放');
    } else {
      this.activeTargetingSkill = skillKey;
      this.selectedTowerType = null;
      this.deselectTower();
      this.updateTowerPanel();
      document.getElementById('skill-meteor-btn')?.classList.add('targeting');
      this.showToast('請點擊地圖任意區域施放流星轟炸！');
    }
  }

  castMeteor(px, py) {
    // 無論是否真的成功施放，都要先清掉瞄準狀態，避免拖曳中途波次結束
    // 導致 activeTargetingSkill 卡死（畫面範圍圈不消失、點擊畫布被攔截）
    this.activeTargetingSkill = null;
    document.getElementById('skill-meteor-btn')?.classList.remove('targeting');

    if (this.state !== 'wave') return;
    const skill = this.skills.meteor;
    skill.timer = skill.cd;

    this.sfx.play('explosion');
    this.showToast('流星轟炸降臨！');

    // 螢幕震動
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    // 巨大衝擊波與火焰火花粒子
    for (let i = 0; i < 25; i++) {
      this.spawnParticle(px, py, {
        color: Math.random() < 0.6 ? '#ff1744' : '#ff9100',
        size: 4 + Math.random() * 6,
        vx: (Math.random() - 0.5) * 240,
        vy: (Math.random() - 0.5) * 240 - 30,
        gravity: 120,
        life: 0.6 + Math.random() * 0.4
      });
    }

    // 範圍傷害判定
    let hitCount = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const d = dist(px, py, enemy.x, enemy.y);
      if (d <= skill.range) {
        enemy.takeDamage(skill.damage, null, 0);
        hitCount++;
      }
    }

    this.spawnParticle(px, py - 30, {
      text: `-${skill.damage}`,
      color: '#ff1744',
      fontSize: 22,
      vx: 0,
      vy: -60,
      gravity: 0,
      life: 1.2
    });
  }

  castFreeze() {
    if (this.state !== 'wave') return;
    const skill = this.skills.freeze;
    skill.timer = skill.cd;

    this.sfx.play('ice');
    this.showToast('全體冰封 3.5 秒！');

    // 全體怪物定身並凍結
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.slowFactor = 0; // 完全定身
      enemy.slowTimer = skill.duration;
      this.spawnParticle(enemy.x, enemy.y - 15, {
        text: '冰凍',
        color: '#00e5ff',
        fontSize: 12,
        vx: 0,
        vy: -30,
        gravity: 0,
        life: 1.0
      });
    }
  }

  updateSkills(dt) {
    // 只有在戰鬥波次進行中 (wave 狀態) 才倒數技能 CD，準備階段 (planning) 凍結 CD
    if (this.state === 'wave') {
      for (const [key, skill] of Object.entries(this.skills)) {
        if (skill.timer > 0) {
          skill.timer = Math.max(0, skill.timer - dt);
        }
      }
    }
    this.updateSkillsUI();
  }

  updateSkillsUI() {
    const meteorBtn = document.getElementById('skill-meteor-btn');
    if (meteorBtn) {
      const s = this.skills.meteor;
      const onCd = s.timer > 0;
      meteorBtn.classList.toggle('on-cd', onCd);
      const overlay = meteorBtn.querySelector('.skill-cd-overlay');
      const text = meteorBtn.querySelector('.skill-cd-text');
      if (overlay) overlay.style.transform = `scaleY(${s.timer / s.cd})`;
      if (text) text.textContent = onCd ? Math.ceil(s.timer) : '';
    }

    const freezeBtn = document.getElementById('skill-freeze-btn');
    if (freezeBtn) {
      const s = this.skills.freeze;
      const onCd = s.timer > 0;
      freezeBtn.classList.toggle('on-cd', onCd);
      const overlay = freezeBtn.querySelector('.skill-cd-overlay');
      const text = freezeBtn.querySelector('.skill-cd-text');
      if (overlay) overlay.style.transform = `scaleY(${s.timer / s.cd})`;
      if (text) text.textContent = onCd ? Math.ceil(s.timer) : '';
    }
  }

  // ─── Tower management ───
  selectTowerType(typeKey) {
    if (this.state !== 'planning' && this.state !== 'wave') return;
    if (this.selectedTowerType === typeKey) {
      this.selectedTowerType = null;
      this.deselectTower();
      this.updateTowerPanel();
      document.getElementById('tower-info').classList.add('hidden');
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const data = TOWER_DATA[typeKey];
    if (this.gold < data.cost) {
      this.showToast(`金幣不足！需要 ${data.cost}`);
      this.sfx.play('error');
      return;
    }
    this.selectedTowerType = typeKey;
    this.deselectTower();
    this.updateTowerPanel();
    this.canvas.style.cursor = 'cell';
  }

  placeTower(col, row) {
    if (!this.selectedTowerType) return;
    const data = TOWER_DATA[this.selectedTowerType];

    if (!this.map.isBuildable(col, row)) {
      this.showToast('不能放在道路上！');
      this.sfx.play('error');
      return;
    }

    const key = `${col},${row}`;
    if (this.towerGrid[key]) {
      this.showToast('該位置已有防禦塔！');
      this.sfx.play('error');
      return;
    }

    if (this.gold < data.cost) {
      this.showToast(`金幣不足！需要 ${data.cost}`);
      this.sfx.play('error');
      return;
    }

    this.gold -= data.cost;
    const tower = new Tower(this.selectedTowerType, col, row);
    this.towers.push(tower);
    this.towerGrid[key] = tower;
    this.sfx.play('place');
    this.updateUI();
    this.updateTowerPanel();

    // Keep type selected for multi-place (unless not enough gold)
    if (this.gold < data.cost) {
      this.selectedTowerType = null;
      document.getElementById('tower-info').classList.add('hidden');
      this.canvas.style.cursor = 'crosshair';
      this.updateTowerPanel();
    }
  }

  selectTower(tower) {
    this.selectedTower = tower;
    this.selectedTowerType = null;
    this.canvas.style.cursor = 'crosshair';
    this.updateTowerPanel();
    this.showTowerInfo(tower);
  }

  deselectTower() {
    this.selectedTower = null;
    if (!this.selectedTowerType) {
      document.getElementById('tower-info').classList.add('hidden');
    }
    this.canvas.style.cursor = 'crosshair';
  }

  showTowerInfo(tower) {
    const stats = tower.getStats();
    const info = document.getElementById('tower-info');
    info.classList.remove('hidden');

    document.getElementById('tower-info-name').textContent = `${tower.data.name}`;
    document.getElementById('tower-info-level').textContent = `等級 ${tower.level} / ${CONFIG.MAX_LEVEL}`;
    document.getElementById('tower-info-actions').style.display = 'flex';

    let statsHtml = `<div style="color:#e06088;font-weight:bold;margin-bottom:3px;">${tower.data.description}</div>`;
    if (tower.typeKey === 'sunflower') {
      statsHtml += `產金：${stats.goldPerSecond}/秒（僅出怪時生效）`;
    } else {
      statsHtml += `傷害：${stats.damage}<br>`;
      statsHtml += `範圍：${stats.range}<br>`;
      statsHtml += `攻速：${stats.fireRate.toFixed(1)}/秒`;
      if (stats.splashRadius) statsHtml += `<br>爆炸：${stats.splashRadius}`;
      if (stats.slowFactor) statsHtml += `<br>減速：${Math.round((1 - stats.slowFactor) * 100)}%`;
      if (stats.piercing) statsHtml += `<br>穿透：${stats.piercing}體`;
      if (stats.chainCount) statsHtml += `<br>連鎖：${stats.chainCount}體`;
      if (stats.poisonDps) statsHtml += `<br>劇毒：${stats.poisonDps}/秒 (${stats.poisonDuration}s)`;
    }
    document.getElementById('tower-info-stats').innerHTML = statsHtml;

    const upgradeBtn = document.getElementById('upgrade-btn');
    const upgradeCost = tower.getUpgradeCost();
    if (upgradeCost) {
      upgradeBtn.disabled = this.gold < upgradeCost;
      upgradeBtn.textContent = `⬆️ 升級 (💰${upgradeCost})`;
    } else {
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = '⬆️ 已滿級';
    }

    document.getElementById('sell-btn').textContent = `💰 出售 (+${tower.getSellValue()})`;
  }

  showTowerPreviewInfo(typeKey) {
    const data = TOWER_DATA[typeKey];
    const info = document.getElementById('tower-info');
    info.classList.remove('hidden');

    document.getElementById('tower-info-name').textContent = `${data.name}`;
    document.getElementById('tower-info-level').textContent = '';
    document.getElementById('tower-info-actions').style.display = 'none';

    let statsHtml = `<div style="color:#e06088;font-weight:bold;margin-bottom:3px;">${data.description}</div>`;
    if (typeKey === 'sunflower') {
      statsHtml += `💰 產金：${data.goldPerSecond}/秒 (波次進行中自動獲得)`;
    } else {
      statsHtml += `⚔️ 基礎傷害：${data.damage}<br>`;
      statsHtml += `📏 攻擊範圍：${data.range}<br>`;
      statsHtml += `💫 攻擊速度：${data.fireRate.toFixed(1)}/秒`;
      if (data.splashRadius) statsHtml += `<br>💥 爆炸範圍：${data.splashRadius}`;
      if (data.slowFactor) statsHtml += `<br>❄️ 減速效果：${Math.round((1 - data.slowFactor) * 100)}% (持續 ${data.slowDuration}s)`;
      if (data.piercing) statsHtml += `<br>🌈 穿透數量：${data.piercing} 體`;
      if (data.chainCount) statsHtml += `<br>⚡ 連鎖彈射：${data.chainCount} 體`;
      if (data.poisonDps) statsHtml += `<br>🧪 劇毒腐蝕：${data.poisonDps}/秒 (持續 ${data.poisonDuration}s)`;
    }
    document.getElementById('tower-info-stats').innerHTML = statsHtml;
  }

  upgradeTower() {
    if (!this.selectedTower) return;
    const cost = this.selectedTower.getUpgradeCost();
    if (!cost || this.gold < cost) {
      this.sfx.play('error');
      return;
    }
    this.gold -= cost;
    this.selectedTower.upgrade();
    this.sfx.play('upgrade');
    this.showToast(`⬆️ ${this.selectedTower.data.name} 升級到 Lv.${this.selectedTower.level}！`);
    this.showTowerInfo(this.selectedTower);
    this.updateUI();
  }

  sellTower() {
    if (!this.selectedTower) return;
    const value = this.selectedTower.getSellValue();
    const key = `${this.selectedTower.col},${this.selectedTower.row}`;
    delete this.towerGrid[key];
    this.towers = this.towers.filter((t) => t !== this.selectedTower);
    this.gold += value;
    this.sfx.play('sell');
    this.showToast(`💰 出售獲得 ${value} 金幣`);
    this.deselectTower();
    this.updateUI();
    this.updateTowerPanel();
  }

  // ─── Wave management ───
  startNextWave() {
    if (this.state !== 'planning') return;
    this.state = 'wave';
    this.waveManager.startWave(this.currentWave);
    this.sfx.play('wave');
    this.showToast(`🌊 第 ${this.currentWave + 1} 波開始！`);
    document.getElementById('start-wave-btn').disabled = true;
    this.selectedTowerType = null;
    this.updateTowerPanel();
    this.updateUI();
  }

  checkWaveComplete() {
    if (this.state !== 'wave') return;
    if (!this.waveManager.isComplete(this.enemies)) return;

    dbgLog(`🎉 [Wave] 第 ${this.currentWave + 1} 波擊殺完畢，觸發結算！`);
    const bonus = this.waveManager.getWaveBonus();
    this.addGold(bonus);
    this.score += bonus;
    this.showToast(`✅ 第 ${this.currentWave + 1} 波完成！獎勵 💰${bonus}`);
    this.sfx.play('wave');

    this.currentWave++;
    if (this.currentWave >= CONFIG.TOTAL_WAVES) {
      dbgLog(`🏆 達成全部 ${CONFIG.TOTAL_WAVES} 波通關，進入 victory 狀態`);
      this.victory();
    } else {
      dbgLog(`⏳ 進入第 ${this.currentWave + 1} 波 planning 狀態`);
      this.state = 'planning';
      document.getElementById('start-wave-btn').disabled = false;
      this.updateWavePreview();
    }
    this.updateUI();
  }

  // ─── Game state ───
  startGame() {
    const level = LEVEL_DATA[CURRENT_LEVEL_INDEX];
    const progress = loadLevelProgress();
    const entry = progress.levels[level.id] || { unlocked: CURRENT_LEVEL_INDEX === 0 };
    if (!entry.unlocked) {
      this.showToast('🔒 請先通關上一關才能解鎖！');
      return;
    }
    // 確保本局波次資料對應目前選擇的關卡（切換關卡輪探時 this.map 已同步，這裡補上 waveManager）
    this.waveManager = new WaveManager(level.waves);
    this.updateSkillBarLockState();

    dbgLog('🎮 startGame triggered!');
    try {
      this.sfx.init();
      this.sfx.resume();
      dbgLog('🔊 Sound initialized');
    } catch (e) {
      dbgLog('⚠️ Audio warning: ' + e.message);
    }
    const menu = document.getElementById('menu-screen');
    if (menu) {
      menu.classList.add('hidden');
      menu.style.display = 'none';
      dbgLog('✅ Menu screen hidden');
    } else {
      dbgLog('❌ menu-screen not found!');
    }
    this.state = 'planning';
    const startWaveBtn = document.getElementById('start-wave-btn');
    if (startWaveBtn) startWaveBtn.disabled = false;
    this.showToast('🏗️ 放置防禦塔，然後開始波次！');
    this.updateWavePreview();
    this.updateUI();
    this.resizeCanvas();
    dbgLog('🚀 Game state is now PLANNING');
  }

  restartGame() {
    this.map = new GameMap(CURRENT_MAP_ID);
    this.renderMapToBuffer();
    this.gold = CONFIG.STARTING_GOLD;
    this.lives = CONFIG.STARTING_LIVES;
    this.score = 0;
    this.currentWave = 0;
    this.speedMultiplier = 1;
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.particles = [];
    this.towerGrid = {};
    this.selectedTower = null;
    this.selectedTowerType = null;
    this.waveManager = new WaveManager(LEVEL_DATA[CURRENT_LEVEL_INDEX].waves);
    this.state = 'planning';

    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('victory-screen').classList.add('hidden');
    document.getElementById('start-wave-btn').disabled = false;
    document.getElementById('speed-btn').textContent = '1x';

    this.deselectTower();
    this.updateWavePreview();
    this.updateUI();
    this.updateTowerPanel();
    this.showToast('🏗️ 新遊戲開始！');
  }

  gameOver() {
    this.state = 'gameover';
    this.sfx.play('gameover');
    this.saveGameRecord();
    document.getElementById('final-wave').textContent = this.currentWave + 1;
    document.getElementById('final-score').textContent = this.score;
    document.getElementById('gameover-screen').classList.remove('hidden');
    this.enemies = [];
    this.projectiles = [];
  }

  victory() {
    this.state = 'victory';
    this.sfx.play('victory');
    this.score += this.lives * 50; // Bonus for remaining lives

    const lifeRatio = this.lives / CONFIG.STARTING_LIVES;
    const stars = lifeRatio >= 1 ? 3 : (lifeRatio >= 0.5 ? 2 : 1);
    const { crystalsEarned } = recordLevelResult(CURRENT_LEVEL_INDEX, stars);
    this.lastVictoryStars = stars;

    this.saveGameRecord();
    document.getElementById('victory-score').textContent = this.score;
    const vicGoldEl = document.getElementById('victory-gold');
    if (vicGoldEl) vicGoldEl.textContent = `💰 ${this.gold}`;
    const vicStarsEl = document.getElementById('victory-stars');
    if (vicStarsEl) {
      vicStarsEl.innerHTML = [1, 2, 3].map(i => `<span class="${i <= stars ? 'star-filled' : 'star-empty'}">★</span>`).join('');
    }
    const vicChestEl = document.getElementById('victory-chest-reward');
    if (vicChestEl) {
      vicChestEl.textContent = crystalsEarned > 0 ? `🎁 寶箱獎勵：💎${crystalsEarned}` : '';
      vicChestEl.classList.toggle('hidden', crystalsEarned <= 0);
    }
    document.getElementById('victory-screen').classList.remove('hidden');
    this.enemies = [];
    this.projectiles = [];
  }

  openSettingsModal() {
    if (this.state === 'menu' || this.state === 'gameover' || this.state === 'victory') return;
    this.previousState = this.state;
    this.state = 'paused';
    document.getElementById('settings-screen').classList.remove('hidden');
    this.sfx.play('tap');
    dbgLog('⏸️ Game paused via Settings modal');
  }

  closeSettingsModal() {
    if (this.state === 'paused') {
      this.state = this.previousState || 'planning';
      this.previousState = null;
    }
    document.getElementById('settings-screen').classList.add('hidden');
    this.sfx.play('tap');
    dbgLog('▶️ Game resumed');
  }

  quitToMenu() {
    this.state = 'menu';
    const menu = document.getElementById('menu-screen');
    if (menu) {
      menu.classList.remove('hidden');
      menu.style.display = 'flex';
    }
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('victory-screen').classList.add('hidden');
    document.getElementById('settings-screen').classList.add('hidden');
    document.getElementById('tower-info').classList.add('hidden');

    // 重置遊戲進行中的單位與狀態
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.particles = [];
    this.towerGrid = {};
    this.selectedTower = null;
    this.selectedTowerType = null;
    this.gold = CONFIG.STARTING_GOLD;
    this.lives = CONFIG.STARTING_LIVES;
    this.score = 0;
    this.currentWave = 0;
    this.speedMultiplier = 1;
    this.waveManager = new WaveManager(LEVEL_DATA[CURRENT_LEVEL_INDEX].waves);
    const speedBtn = document.getElementById('speed-btn');
    if (speedBtn) speedBtn.textContent = '1x';

    const menuScore = document.getElementById('menu-best-score');
    if (menuScore) menuScore.textContent = this.bestScore;
    this.renderLevelCarousel(); // 回首頁時刷新關卡輪探（可能剛解鎖新關卡或拿到新星等）
    this.showToast('🏠 已返回首頁');
  }

  saveGameRecord() {
    try {
      const recordsKey = 'dd_td_leaderboard_v1';
      let records = [];
      try {
        records = JSON.parse(localStorage.getItem(recordsKey)) || [];
      } catch (e) {
        records = [];
      }

      const mapName = MAP_CONFIGS[this.map.mapId]?.name || '外環道路';
      const isVictory = (this.state === 'victory');
      const newRecord = {
        score: this.score,
        wave: Math.min(this.currentWave + 1, CONFIG.TOTAL_WAVES),
        gold: this.gold,
        isVictory: isVictory,
        map: mapName,
        date: new Date().toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      };

      records.push(newRecord);
      // 依分數由高到低排序，取 Top 10
      records.sort((a, b) => b.score - a.score);
      records = records.slice(0, 10);

      localStorage.setItem(recordsKey, JSON.stringify(records));

      // 若勝利通關，額外存入「通關金幣榜」
      if (isVictory) {
        const goldKey = 'dd_td_gold_leaderboard_v1';
        let goldRecords = [];
        try {
          goldRecords = JSON.parse(localStorage.getItem(goldKey)) || [];
        } catch (e) {
          goldRecords = [];
        }
        goldRecords.push(newRecord);
        // 依剩餘金幣由高到低排序，取 Top 10
        goldRecords.sort((a, b) => b.gold - a.gold);
        goldRecords = goldRecords.slice(0, 10);
        localStorage.setItem(goldKey, JSON.stringify(goldRecords));
      }

      if (this.score > this.bestScore) {
        this.bestScore = this.score;
        localStorage.setItem(CONFIG.LS_KEY, this.bestScore);
      }
    } catch (err) {
      console.warn('LocalStorage error:', err);
    }
    this.renderLeaderboards();
  }

  switchLeaderboardTab(type) {
    this.activeLeaderboardTab = type; // 'score' | 'gold'
    const btnScore = document.getElementById('lb-tab-score');
    const btnGold = document.getElementById('lb-tab-gold');
    if (type === 'gold') {
      btnGold?.classList.add('active');
      btnScore?.classList.remove('active');
    } else {
      btnScore?.classList.add('active');
      btnGold?.classList.remove('active');
    }
    this.renderLeaderboards();
  }

  renderLeaderboards() {
    let records = [];
    let goldRecords = [];
    try {
      records = JSON.parse(localStorage.getItem('dd_td_leaderboard_v1')) || [];
      goldRecords = JSON.parse(localStorage.getItem('dd_td_gold_leaderboard_v1')) || [];
    } catch (e) {
      records = [];
      goldRecords = [];
    }

    if (!this.activeLeaderboardTab) {
      this.activeLeaderboardTab = 'score';
    }

    // 1. 榜首精簡預覽更新 (首頁與結算頁)
    const champ = records[0];
    const updateChampionCard = (scoreElId, descElId) => {
      const scoreEl = document.getElementById(scoreElId);
      const descEl = document.getElementById(descElId);
      if (champ) {
        if (scoreEl) scoreEl.textContent = `⭐ ${champ.score}`;
        if (descEl) descEl.textContent = `${champ.map} · 第 ${champ.wave} 波 (${champ.date || ''})`;
      } else {
        if (scoreEl) scoreEl.textContent = '0';
        if (descEl) descEl.textContent = '尚無紀錄，點擊挑戰！';
      }
    };

    updateChampionCard('menu-champion-score', 'menu-champion-desc');
    updateChampionCard(null, 'gameover-champion-desc');
    updateChampionCard(null, 'victory-champion-desc');

    // 2. 獨立 Top 10 彈窗清單渲染
    const modalListEl = document.getElementById('modal-leaderboard-list');
    if (modalListEl) {
      const currentList = (this.activeLeaderboardTab === 'gold') ? goldRecords : records;
      if (currentList.length === 0) {
        const emptyMsg = (this.activeLeaderboardTab === 'gold') 
          ? '尚無通關金幣戰績，順利通關即可上榜！' 
          : '尚無歷史戰績，快來挑戰首殺！';
        modalListEl.innerHTML = `<div style="color:#888;text-align:center;padding:12px;">${emptyMsg}</div>`;
      } else {
        modalListEl.innerHTML = currentList.map((rec, idx) => {
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
          const valDisplay = (this.activeLeaderboardTab === 'gold')
            ? `<span style="color:#d84315;font-weight:bold;">💰 ${rec.gold}</span>`
            : `<span>⭐ ${rec.score}</span>`;
          
          return `
            <div class="leaderboard-row ${idx === 0 ? 'rank-1' : ''}">
              <div class="leaderboard-row-left">
                <span style="font-size:13px;width:18px;">${medal}</span>
                <span>${rec.map} ${rec.isVictory ? '🏆' : `(W${rec.wave})`}</span>
              </div>
              <div class="leaderboard-row-right">
                ${valDisplay}
                <span style="font-size:9px;color:#999;">${rec.date || ''}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  openLeaderboardModal() {
    this.renderLeaderboards();
    document.getElementById('leaderboard-modal')?.classList.remove('hidden');
    this.sfx.play('tap');
  }

  closeLeaderboardModal() {
    document.getElementById('leaderboard-modal')?.classList.add('hidden');
    this.sfx.play('tap');
  }

  updateCrystalBalanceUI() {
    const balance = loadCrystals();
    const menuEl = document.getElementById('menu-crystal-balance');
    if (menuEl) menuEl.textContent = balance;
    const shopEl = document.getElementById('shop-crystal-balance');
    if (shopEl) shopEl.textContent = balance;
  }

  openShopModal() {
    this.renderShopItems();
    document.getElementById('shop-modal')?.classList.remove('hidden');
    this.sfx.play('tap');
  }

  closeShopModal() {
    document.getElementById('shop-modal')?.classList.add('hidden');
    this.sfx.play('tap');
  }

  renderShopT1Card(item, balance) {
    const meta = SHOP_METADATA[item.key] || {
      icon: item.kind === 'skill' ? 'assets/skills/skill_meteor.svg' : 'assets/towers/tower_petal.svg',
      badges: [{ text: item.kind === 'skill' ? '☄️ 主動魔法' : '🌸 守護花靈', type: 'pierce' }],
      desc: item.desc || '',
      stats: { dmg: '-', range: '-', rate: '-' }
    };
    const canAfford = balance >= item.cost;
    const badgeHtml = meta.badges.map(b => `<span class="role-badge ${getShopBadgeClass(b.type)}">${b.text}</span>`).join('');
    
    return `
      <div class="shop-card-t1 ${item.unlocked ? 'owned' : ''}">
        <div class="shop-card-t1-top">
          <div class="shop-card-t1-icon">
            <img src="${meta.icon}" alt="${item.name}">
          </div>
          <div class="shop-card-t1-name-box">
            <div class="shop-card-t1-name" title="${item.name}">${item.name}</div>
            <div class="shop-card-t1-badges">${badgeHtml}</div>
          </div>
        </div>
        <div class="shop-card-t1-desc">${meta.desc}</div>
        <div class="shop-card-t1-stats">
          <span>⚔️ ${meta.stats.dmg}</span>
          <span>🎯 ${meta.stats.range}</span>
          <span>⏱️ ${meta.stats.rate}</span>
        </div>
        <button class="shop-card-t1-btn ${item.unlocked ? 'btn-owned' : 'btn-buy'}" 
                data-kind="${item.kind}" 
                data-key="${item.key}" 
                ${item.unlocked ? 'disabled' : (canAfford ? '' : 'disabled')}>
          ${item.unlocked ? '✅ 已解鎖' : `💎 ${item.cost} 解鎖`}
        </button>
      </div>
    `;
  }

  renderShopItems() {
    this.updateCrystalBalanceUI();
    const container = document.getElementById('shop-item-list');
    if (!container) return;
    const balance = loadCrystals();

    // 彙整所有塔與技能清單
    const allItems = [];
    
    // 初始免費塔 (粉櫻)
    allItems.push({
      kind: 'tower',
      key: 'petal',
      name: TOWER_DATA.petal?.name || '粉櫻花靈之箭',
      cost: 0,
      unlocked: true,
      desc: SHOP_METADATA.petal?.desc
    });

    // 商店解鎖塔
    for (const [key, item] of Object.entries(SHOP_ITEMS.towers)) {
      const unlocked = isTowerUnlocked(key);
      const name = TOWER_DATA[key]?.name || key;
      allItems.push({ kind: 'tower', key, name, cost: item.cost, unlocked, desc: SHOP_METADATA[key]?.desc });
    }

    // 商店解鎖技能
    for (const [key, item] of Object.entries(SHOP_ITEMS.skills)) {
      const unlocked = isSkillUnlocked(key);
      allItems.push({ kind: 'skill', key, name: item.name, cost: item.cost, unlocked, desc: item.desc });
    }

    // 依種類過濾 (全部 / 防禦塔 / 魔法技能)
    const filteredByKind = allItems.filter(item => {
      if (this.shopKindFilter === 'tower') return item.kind === 'tower';
      if (this.shopKindFilter === 'skill') return item.kind === 'skill';
      return true;
    });

    const lockedList = filteredByKind.filter(x => !x.unlocked);
    const unlockedList = filteredByKind.filter(x => x.unlocked);

    let targetList = [];
    let isSplitView = false;

    if (this.shopStatusTab === 'locked') {
      targetList = lockedList;
    } else if (this.shopStatusTab === 'unlocked') {
      targetList = unlockedList;
    } else {
      isSplitView = true; // 全部頁籤：分區呈現
    }

    // 空狀態處理
    if (!isSplitView && targetList.length === 0) {
      if (this.shopStatusTab === 'locked') {
        container.innerHTML = `
          <div class="shop-empty-box">
            <div class="shop-empty-icon">🎉</div>
            <div class="shop-empty-text">太厲害了！你已成功解鎖所有塔防單位與魔法技能！</div>
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="shop-empty-box">
            <div class="shop-empty-icon">📦</div>
            <div class="shop-empty-text">尚無已解鎖項目<br>請前往「未解鎖」頁籤消耗魔法水晶解鎖！</div>
          </div>
        `;
      }
      return;
    }

    // 方案一：魔導卡牌矩陣渲染
    let html = '';
    if (isSplitView) {
      if (lockedList.length > 0) {
        html += `<div class="shop-section-banner"><span class="shop-section-title">🛒 未解鎖商品</span></div>`;
        html += `<div class="shop-cards-grid">${lockedList.map(item => this.renderShopT1Card(item, balance)).join('')}</div>`;
      }
      if (unlockedList.length > 0) {
        html += `<div class="shop-section-banner" style="margin-top:14px;"><span class="shop-section-title">📦 已解鎖圖鑑</span></div>`;
        html += `<div class="shop-cards-grid">${unlockedList.map(item => this.renderShopT1Card(item, balance)).join('')}</div>`;
      }
    } else {
      html += `<div class="shop-cards-grid">${targetList.map(item => this.renderShopT1Card(item, balance)).join('')}</div>`;
    }

    container.innerHTML = html;

    // 綁定購買點擊事件
    container.querySelectorAll('.shop-card-t1-btn.btn-buy:not(:disabled)').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.buyShopItem(btn.dataset.kind, btn.dataset.key);
      });
    });
  }

  buyShopItem(kind, key) {
    const result = kind === 'skill' ? purchaseSkill(key) : purchaseTower(key);
    if (result.ok) {
      this.sfx.play('upgrade');
      this.showToast('✅ 解鎖成功！');
    } else if (result.reason === 'insufficient') {
      this.sfx.play('error');
      this.showToast('💎 水晶不足');
    } else {
      this.sfx.play('error');
      this.showToast('⚠️ 購買失敗');
    }
    this.renderShopItems();
    this.updateTowerPanel();
    this.updateSkillBarLockState();
  }

  // ─── Helpers ───
  addGold(amount) {
    this.gold += amount;
    this.updateUI();
  }

  spawnParticle(x, y, options) {
    this.particles.push(new Particle(x, y, options));
  }

  showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  toggleSpeed() {
    this.speedMultiplier = this.speedMultiplier === 1 ? 2 : this.speedMultiplier === 2 ? 3 : 1;
    document.getElementById('speed-btn').textContent = `${this.speedMultiplier}x`;
  }

  toggleFullscreen() {
    const docEl = document.documentElement;
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    
    if (!isFullscreen) {
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen().catch(() => {
          this.showToast('📱 iOS 點擊「分享」>「加入主畫面」即可全螢幕遊玩');
        });
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        docEl.msRequestFullscreen();
      } else {
        this.showToast('📱 iOS 點擊「分享」>「加入主畫面」即可全螢幕遊玩');
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(err => console.log(err));
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      }
    }
  }

  onFullscreenChange() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const fsBtn = document.getElementById('fullscreen-btn');
    if (fsBtn) {
      fsBtn.textContent = isFs ? '🗗' : '⛶';
      fsBtn.title = isFs ? '退出全螢幕' : '全螢幕';
    }
    this.resizeCanvas();
  }

  resizeCanvas() {
    const viewport = document.getElementById('game-viewport');
    if (!viewport || !this.canvas) return;

    const availW = viewport.clientWidth - 4;
    const availH = viewport.clientHeight - 4;
    
    if (availW <= 0 || availH <= 0) return;
    
    // 依據 viewport 可用區域自適應等比例縮放（完整顯示 6x8 戰場與石板路，不遮擋頂部與底部）
    const scale = Math.min(availW / CANVAS_W, availH / CANVAS_H);
    this.canvas.style.width = `${Math.floor(CANVAS_W * scale)}px`;
    this.canvas.style.height = `${Math.floor(CANVAS_H * scale)}px`;
  }

  updateUI() {
    const updateStatWithPunch = (id, newVal) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.textContent !== String(newVal)) {
        el.textContent = newVal;
        el.classList.remove('stat-punch');
        void el.offsetWidth; // 強制重繪觸發動畫
        el.classList.add('stat-punch');
      }
    };

    updateStatWithPunch('gold', this.gold);
    updateStatWithPunch('lives', this.lives);
    updateStatWithPunch('score', this.score);

    // 波次資訊 (純淨文本無怪物 Emoji)
    const waveEl = document.getElementById('wave-info');
    if (waveEl) {
      if (this.state === 'menu') {
        waveEl.textContent = '準備中';
      } else {
        waveEl.textContent = `第 ${this.currentWave + 1}/${CONFIG.TOTAL_WAVES} 波`;
      }
    }

    this.updateTowerPanel();
  }

  updateSkillBarLockState() {
    const meteorBtn = document.getElementById('skill-meteor-btn');
    if (meteorBtn) meteorBtn.classList.toggle('locked', !isSkillUnlocked('meteor'));
    const freezeBtn = document.getElementById('skill-freeze-btn');
    if (freezeBtn) freezeBtn.classList.toggle('locked', !isSkillUnlocked('freeze'));
  }

  updateTowerPanel() {
    const items = document.querySelectorAll('.tower-item');
    items.forEach((item) => {
      const type = item.dataset.type;
      const cost = TOWER_DATA[type].cost;
      const unlocked = isTowerUnlocked(type);
      const canAfford = this.gold >= cost;
      item.classList.toggle('disabled', !canAfford || !unlocked);
      item.classList.toggle('locked', !unlocked);
      item.classList.remove('selected');
      const details = item.querySelector('.tower-details');
      if (details) {
        details.innerHTML = unlocked
          ? `<div class="tower-cost">💰${cost}</div>`
          : `<div class="tower-cost tower-cost-locked">🔒 商店解鎖</div>`;
      }
    });
  }

  updateWavePreview() {
    const preview = document.getElementById('wave-preview');
    if (preview) {
      preview.textContent = '';
    }
  }

  // ─── Game Loop ───
  gameLoop(timestamp) {
    try {
      const rawDt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
      this.lastTime = timestamp;
      const dt = rawDt * this.speedMultiplier;

      if (this.state === 'wave' || this.state === 'planning') {
        this.update(dt);
      } else {
        // 在 victory / gameover 狀態下依然更新粒子特效
        for (const p of this.particles) {
          p.update(dt);
        }
        this.particles = this.particles.filter((p) => p.alive);
      }
      this.render();
    } catch (err) {
      dbgLog(`🔥 gameLoop Crash: ${err.message} \nStack: ${err.stack}`);
    }
    this.animFrame = requestAnimationFrame((t) => this.gameLoop(t));
  }

  update(dt) {
    // 1. Update Active Skills
    this.updateSkills(dt);

    // 2. Spawn enemies
    if (this.state === 'wave') {
      const newEnemy = this.waveManager.update(dt, this.map);
      if (newEnemy) this.enemies.push(newEnemy);
    }

    // Update enemies
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.update(dt, this);

      if (enemy.reachedEnd) {
        this.lives -= enemy.damage;
        this.baseHurtTimer = 0.45; // 觸發基地受損紅光與劇烈震顫
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);

        // 基地受創爆炸煙塵與碎石
        for (let i = 0; i < 10; i++) {
          this.spawnParticle(enemy.x, enemy.y - 10, {
            color: Math.random() < 0.5 ? '#ff5252' : '#ffb74d',
            size: 3 + Math.random() * 4,
            vx: (Math.random() - 0.5) * 160,
            vy: (Math.random() - 0.5) * 160 - 40,
            gravity: 100,
            life: 0.5 + Math.random() * 0.3,
          });
        }

        this.spawnParticle(enemy.x, enemy.y - 20, {
          text: `-${enemy.damage} ❤️`,
          color: '#ff1744',
          fontSize: 18,
          vx: 0,
          vy: -55,
          gravity: 0,
          life: 1.5,
        });
        if (this.lives <= 0) {
          this.lives = 0;
          this.gameOver();
          return;
        }
        this.updateUI();
      }
    }

    // 基地受擊計時
    if (this.baseHurtTimer > 0) {
      this.baseHurtTimer -= dt;
    }

    // Update towers
    for (const tower of this.towers) {
      const projectile = tower.update(dt, this.enemies, this);
      if (projectile) {
        this.projectiles.push(projectile);
      }
    }

    // Update projectiles
    for (const proj of this.projectiles) {
      if (!proj.alive) continue;
      proj.update(dt, this);

      // Handle splash damage on hit
      if (!proj.alive && proj.splashRadius > 0) {
        for (const enemy of this.enemies) {
          if (!enemy.alive || proj.piercedEnemies.has(enemy)) continue;
          const d = dist(proj.x, proj.y, enemy.x, enemy.y);
          if (d <= proj.splashRadius) {
            enemy.takeDamage(proj.damage * 0.5, proj.slowFactor, proj.slowDuration, 0, 0, false, this);
          }
        }
        // Splash effect
        for (let i = 0; i < 8; i++) {
          this.spawnParticle(proj.x, proj.y, {
            color: proj.color,
            size: 3 + Math.random() * 3,
            vx: (Math.random() - 0.5) * 150,
            vy: (Math.random() - 0.5) * 150,
            life: 0.4,
            gravity: 0,
          });
        }
        this.sfx.play('hit');
      }

      // Handle piercing projectile - find next target
      if (proj.alive && proj.piercing > 0 && !proj.target) {
        let nearestDist = Infinity;
        let nearest = null;
        for (const enemy of this.enemies) {
          if (!enemy.alive || proj.piercedEnemies.has(enemy)) continue;
          const d = dist(proj.x, proj.y, enemy.x, enemy.y);
          if (d < nearestDist && d < 100) {
            nearestDist = d;
            nearest = enemy;
          }
        }
        if (nearest) {
          proj.target = nearest;
        } else {
          proj.alive = false;
        }
      }
    }

    // Check kills & rewards
    for (const enemy of this.enemies) {
      if (!enemy.alive && !enemy.reachedEnd && !enemy._rewarded) {
        enemy._rewarded = true;
        this.gold += enemy.reward;
        this.score += enemy.reward;
        dbgLog(`💀 [Kill] 擊殺 ${enemy.typeKey}，剩餘存活怪數: ${this.enemies.filter(e => e.alive).length - 1}`);

        // Kill effects
        for (let i = 0; i < 6; i++) {
          this.spawnParticle(enemy.x, enemy.y, {
            color: '#ffb6c1',
            size: 3 + Math.random() * 4,
            vx: (Math.random() - 0.5) * 120,
            vy: (Math.random() - 0.5) * 120 - 30,
            life: 0.5 + Math.random() * 0.3,
          });
        }
        this.spawnParticle(enemy.x, enemy.y - 20, {
          text: `+${enemy.reward}💰`,
          color: '#ffa500',
          fontSize: 13,
          vx: (Math.random() - 0.5) * 20,
          vy: -40,
          gravity: 0,
          life: 1.0,
        });
        this.sfx.play('kill');
        this.updateUI();
      }
    }

    // Cleanup dead entities
    this.enemies = this.enemies.filter((e) => e.alive);
    this.projectiles = this.projectiles.filter((p) => p.alive);

    // Update particles
    for (const p of this.particles) {
      p.update(dt);
    }
    this.particles = this.particles.filter((p) => p.alive);

    // Check wave complete
    if (this.state === 'wave') {
      this.checkWaveComplete();
    }

    // Update tower info if selected
    if (this.selectedTower) {
      this.showTowerInfo(this.selectedTower);
    }
  }

  // ─── Rendering ───
  render() {
    const ctx = this.ctx;

    // Draw pre-rendered map
    ctx.drawImage(this.mapCanvas, 0, 0);

    // Hover cell highlight
    if (this.hoverCell && this.selectedTowerType) {
      const { col, row } = this.hoverCell;
      const cs = CONFIG.CELL_SIZE;
      const canBuild = this.map.isBuildable(col, row) && !this.towerGrid[`${col},${row}`];

      ctx.fillStyle = canBuild ? 'rgba(136, 216, 176, 0.4)' : 'rgba(255, 107, 107, 0.4)';
      ctx.fillRect(col * cs, row * cs, cs, cs);

      // Preview range
      if (canBuild) {
        const data = TOWER_DATA[this.selectedTowerType];
        if (data.range > 0) {
          const center = gridToPixel(col, row);
          ctx.save();
          ctx.globalAlpha = 0.2;
          ctx.fillStyle = data.color;
          ctx.beginPath();
          ctx.arc(center.x, center.y, data.range, 0, Math.PI * 2);
          ctx.fill();

          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = data.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(center.x, center.y, data.range, 0, Math.PI * 2);
          ctx.stroke();

          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.arc(center.x, center.y, data.range, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }

        // Preview tower Sprite
        const center = gridToPixel(col, row);
        const drawFunc = Sprites['drawTower_' + this.selectedTowerType];
        if (drawFunc) {
          ctx.save();
          ctx.translate(center.x, center.y);
          ctx.globalAlpha = 0.65;
          drawFunc.call(Sprites, ctx, performance.now() / 1000);
          ctx.restore();
        }
      }
    }

    // Selected tower range
    if (this.selectedTower) {
      this.selectedTower.renderRange(ctx);
      // Highlight selected cell
      const cs = CONFIG.CELL_SIZE;
      ctx.strokeStyle = '#ff69b4';
      ctx.lineWidth = 2;
      ctx.strokeRect(
        this.selectedTower.col * cs + 1,
        this.selectedTower.row * cs + 1,
        cs - 2,
        cs - 2
      );
    }

    // Towers
    for (const tower of this.towers) {
      tower.render(ctx);
    }

    // Enemies (sort by distance for proper layering)
    const sortedEnemies = [...this.enemies].sort((a, b) => a.distance - b.distance);
    for (const enemy of sortedEnemies) {
      enemy.render(ctx);
    }

    // Projectiles
    for (const proj of this.projectiles) {
      proj.render(ctx);
    }

    // Active Skill Targeting Preview (流星轟炸拖曳瞄準光圈與傷害範圍)
    if (this.activeTargetingSkill === 'meteor' && this.mouseX >= 0 && this.mouseY >= 0) {
      const skill = this.skills.meteor;
      const now = performance.now() / 1000;
      const isHoverCancel = !!this.isHoveringCancelZone;
      ctx.save();
      ctx.translate(this.mouseX, this.mouseY);

      if (isHoverCancel) {
        // 拖到取消區：呈現灰色廢棄警示風格
        ctx.fillStyle = 'rgba(120, 120, 120, 0.25)';
        ctx.beginPath();
        ctx.arc(0, 0, skill.range, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#9e9e9e';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(0, 0, skill.range, 0, Math.PI * 2);
        ctx.stroke();

        // 畫斜紅叉 X
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ef5350';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-16, -16); ctx.lineTo(16, 16);
        ctx.moveTo(16, -16); ctx.lineTo(-16, 16);
        ctx.stroke();
      } else {
        // 戰場拖曳：呈現極其酷炫的火焰紅色爆炸傷害範圍圈
        ctx.fillStyle = 'rgba(255, 23, 68, 0.25)';
        ctx.beginPath();
        ctx.arc(0, 0, skill.range, 0, Math.PI * 2);
        ctx.fill();

        // 旋轉發光虛線外框
        ctx.strokeStyle = '#ff1744';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#ff1744';
        ctx.shadowBlur = 10;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.arc(0, 0, skill.range, now * 2, now * 2 + Math.PI * 2);
        ctx.stroke();

        // 中央準心十字與傷害範圍標示
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-12, 0); ctx.lineTo(12, 0);
        ctx.moveTo(0, -12); ctx.lineTo(0, 12);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`💥 傷害範圍 (${skill.range}px)`, 0, skill.range + 16);
      }

      ctx.restore();
    }

    // Dragging Tower Preview (Range & Emoji following cursor/finger)
    if (this.isDragging && this.draggingTowerType && this.dragPos) {
      const data = TOWER_DATA[this.draggingTowerType];
      const { x, y } = this.dragPos;

      // 1. 如果在有效格子內，高亮格子
      if (this.hoverCell) {
        const { col, row } = this.hoverCell;
        const cs = CONFIG.CELL_SIZE;
        const canBuild = this.map.isBuildable(col, row) && !this.towerGrid[`${col},${row}`];
        ctx.fillStyle = canBuild ? 'rgba(136, 216, 176, 0.4)' : 'rgba(255, 107, 107, 0.4)';
        ctx.fillRect(col * cs, row * cs, cs, cs);
      }

      // 2. 射程圈跟著拖曳位置（若在可建格子上則對齊格子中心，否則跟著手指/滑鼠）
      let rangeCenterX = x;
      let rangeCenterY = y;
      if (this.hoverCell && this.map.isBuildable(this.hoverCell.col, this.hoverCell.row) && !this.towerGrid[`${this.hoverCell.col},${this.hoverCell.row}`]) {
        const center = gridToPixel(this.hoverCell.col, this.hoverCell.row);
        rangeCenterX = center.x;
        rangeCenterY = center.y;
      }

      if (data.range > 0) {
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = data.color;
        ctx.beginPath();
        ctx.arc(rangeCenterX, rangeCenterY, data.range, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = data.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(rangeCenterX, rangeCenterY, data.range, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(rangeCenterX, rangeCenterY, data.range, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // 3. 繪製跟隨手指/滑鼠的防禦塔與浮空陰影 (精準跟隨落點，不吸附格子中心)
      ctx.save();
      ctx.translate(x, y);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.beginPath();
      ctx.ellipse(0, 16, 16, 7, 0, 0, Math.PI * 2);
      ctx.fill();

      const dragSvgImg = assets.get('tower_' + this.draggingTowerType);
      if (dragSvgImg) {
        ctx.save();
        ctx.globalAlpha = 0.95;
        ctx.drawImage(dragSvgImg, -24, -28, 48, 48);
        ctx.restore();
      } else {
        const drawFunc = Sprites['drawTower_' + this.draggingTowerType];
        if (drawFunc) {
          ctx.save();
          ctx.globalAlpha = 0.95;
          drawFunc.call(Sprites, ctx, performance.now() / 1000);
          ctx.restore();
        } else {
          ctx.font = '32px serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(data.emoji, 0, -5);
        }
      }
      ctx.restore();
    }

    // 4.2 終點保衛小屋：懸浮守護水晶與受損紅光警報 (Sanctuary Crystal & Base Shake)
    if (this.map.pathPixels.length > 0) {
      const exit = this.map.pathPixels[this.map.pathPixels.length - 1];
      const now = performance.now() / 1000;
      ctx.save();

      // 若受傷則產生劇烈畫面震顫與紅光
      if (this.baseHurtTimer > 0) {
        const shakeX = (Math.random() - 0.5) * 8;
        const shakeY = (Math.random() - 0.5) * 8;
        ctx.translate(exit.x + shakeX, exit.y + shakeY);

        // 紅色受創光罩
        ctx.fillStyle = 'rgba(255, 23, 68, 0.45)';
        ctx.beginPath();
        ctx.arc(0, 0, 32, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.translate(exit.x, exit.y);
      }

      // 懸浮守護水晶 (翡翠綠/黃金旋轉菱形)
      const crystalY = -34 + Math.sin(now * 3.5) * 3;
      const crystalScale = 1 + Math.sin(now * 5) * 0.08;
      ctx.save();
      ctx.translate(0, crystalY);
      ctx.scale(crystalScale, crystalScale);

      // 水晶微光光暈
      ctx.shadowColor = '#69f0ae';
      ctx.shadowBlur = 12;
      const cGrad = ctx.createLinearGradient(-6, -8, 6, 8);
      cGrad.addColorStop(0, '#ffffff');
      cGrad.addColorStop(0.4, '#b9f6ca');
      cGrad.addColorStop(0.8, '#00e676');
      cGrad.addColorStop(1, '#00c853');
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6.5, 0);
      ctx.lineTo(0, 9);
      ctx.lineTo(-6.5, 0);
      ctx.closePath();
      ctx.fill();

      // 水晶立體切面高光
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6.5, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.restore();
    }

    // 4.3 起點出怪口按鈕（在 planning 狀態下極為醒目，帶有呼吸縮放與點擊提示）
    if (this.state === 'planning' && this.map.pathPixels.length > 0) {
      const entry = this.map.pathPixels[0];
      const now = performance.now() / 1000;
      const pulseScale = 1 + Math.sin(now * 5) * 0.08;
      const waveNum = this.currentWave + 1;

      ctx.save();
      ctx.translate(entry.x, entry.y);
      ctx.scale(pulseScale, pulseScale);

      // 外圍發光呼吸圈
      ctx.fillStyle = 'rgba(255, 152, 0, 0.35)';
      ctx.beginPath();
      ctx.arc(0, 0, 36, 0, Math.PI * 2);
      ctx.fill();

      // 出怪徽章按鈕：優先使用超高清 SVG 向量貼圖 (100% 絕對不失焦)
      const badgeImg = assets.get('spawn_badge');
      if (badgeImg) {
        ctx.drawImage(badgeImg, -35, 14, 70, 30);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`出怪 第${waveNum}波`, 0, 14 + 30 / 2 + 1);
      } else {
        const btnW = 68;
        const btnH = 26;
        const btnR = 13;
        const bx = -btnW / 2;
        const by = 16;
        ctx.fillStyle = 'rgba(255, 107, 0, 0.95)';
        ctx.beginPath();
        ctx.roundRect(bx, by, btnW, btnH, btnR);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`出怪 第${waveNum}波`, 0, by + btnH / 2 + 1);
      }

      ctx.restore();
    }

    // 5. 路徑動態引導微光 (Path Flow Particle Beam)
    if (this.map && this.map.pathPixels && this.map.pathPixels.length > 1) {
      const now = performance.now() / 1000;
      const waypoints = this.map.pathPixels;
      const totalLen = this.map.totalPathLength || 1000;
      // 沿路徑循環游動的 3 顆引導光球
      for (let i = 0; i < 3; i++) {
        const offset = ((now * 120 + i * (totalLen / 3)) % totalLen);
        const pos = this.map.getPositionAtDistance(offset);
        if (pos) {
          ctx.save();
          ctx.globalAlpha = 0.5 + Math.sin(now * 8 + i) * 0.2;
          ctx.fillStyle = '#fff9c4';
          ctx.shadowColor = '#ffd54f';
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // Particles
    for (const p of this.particles) {
      p.render(ctx);
    }
  }
}

// ─── 15. 初始化 ──────────────────────────────
function bootGame() {
  if (window.gameInstance) return;
  dbgLog('⚡ bootGame executing...');
  try {
    const game = new Game();
    window.gameInstance = game;
    game.init();
    dbgLog('✅ game.init() finished successfully!');
  } catch (e) {
    dbgLog('❌ Game init exception: ' + e.message + '\n' + e.stack);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootGame);
} else {
  bootGame();
}
