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

// 驗證用共用密鑰：開機時自動跟 devserver 要目前這台機器的 token（GET /__token，GET 本來就不驗證），
// 不用再手動把這台機器的 .debug_token 內容貼回來 commit——兩台輪流開發的電腦各自產生的 token 不同也沒差
let DEBUG_TOKEN = '';
fetch('/__token').then(r => (r.ok ? r.text() : '')).then(t => { DEBUG_TOKEN = t.trim(); }).catch(() => {});

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
  VERSION: 'v1.13.2-dev',
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

// 唯一的開發版判斷依據（跟版本號後綴綁在一起，release 到 main 時 version-guard hook 會自動去掉 -dev，
// 這裡也會跟著自動生效，不需要每次發版另外手動記得拔掉偵錯面板）
const IS_DEV_BUILD = CONFIG.VERSION.includes('dev');

// 正式版預設隱藏偵錯用 UI，避免玩家在正式環境看到測試用按鈕：
// - Log／截圖是給開發者看的，正式版永遠不開放
// - 「關卡進度測試／水晶測試」的入口按鈕（🧪）藏起來，但可以靠下面「連點首頁關卡區塊 5 下」的隱藏開關喚出，
//   方便正式環境測試人員取用；#debug-container 本身保持顯示，只隱藏個別按鈕，不整個藏起來
(function hideDebugPanelOnProd() {
  if (IS_DEV_BUILD) return;
  const logBtn = document.getElementById('debug-toggle-btn');
  if (logBtn) logBtn.style.display = 'none';
  const shotBtn = document.getElementById('debug-shot-btn');
  if (shotBtn) shotBtn.style.display = 'none';
  const testToggleBtn = document.getElementById('debug-test-toggle-btn');
  if (testToggleBtn) testToggleBtn.style.display = 'none';
})();

const CANVAS_W = CONFIG.COLS * CONFIG.CELL_SIZE; // 480
const CANVAS_H = CONFIG.ROWS * CONFIG.CELL_SIZE; // 640

// ─── 2. 多地圖配置數據 (純 6×8 規格，中央 4×6 建造) ──────────
const MAP_CONFIGS = {
  outer_ring: {
    id: 'outer_ring',
    name: '經典外廊 (Outer Ring)',
    desc: '左上 [0,0] 出發繞最外圍一圈至右上 [5,0]，中央 4×6 蓋塔',
    pathType: 'outer',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [0, 7], [5, 7], [5, 0]],
  },
  serpentine: {
    id: 'serpentine',
    name: '蛇形曲徑 (Serpentine)',
    desc: '經典蜿蜒路線，適合均衡佈局',
    pathType: 'snake',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [0, 2], [5, 2], [5, 5], [0, 5], [0, 7], [5, 7]],
  },
  ring: {
    id: 'ring',
    name: '競技之環 (Ring)',
    desc: '外圍環繞一圈，中央為建造平台',
    pathType: 'spiral',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [0, 7], [5, 7], [5, 2], [1, 2]],
  },
  zigzag: {
    id: 'zigzag',
    name: '之字鋸齒 (Zigzag Path)',
    desc: '緊密的 4 折橫向往復路線，橫向直線極長',
    pathType: 'zigzag',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [5, 0], [5, 2], [0, 2], [0, 4], [5, 4], [5, 7], [0, 7]],
  },
  crossroad: {
    id: 'crossroad',
    name: '交織十字 (Crossroad)',
    desc: '中軸直線貫穿後繞外環，形成橫切十字多點交會',
    pathType: 'crossroad',
    cols: 6,
    rows: 8,
    waypoints: [[2, 0], [2, 7], [5, 7], [5, 4], [0, 4], [0, 1], [5, 1]],
  },
  spiral_deep: {
    id: 'spiral_deep',
    name: '深層渦旋 (Deep Spiral)',
    desc: '雙層順時針向心螺旋，怪物由外往中心核心逼近',
    pathType: 'spiral',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [5, 0], [5, 7], [0, 7], [0, 3], [3, 3], [3, 5]],
  },
  dual_loop: {
    id: 'dual_loop',
    name: '雙子無限之環 (Dual Loop)',
    desc: '上下雙循環 8 字型折返路徑，路線最長、轉折最多',
    pathType: 'dual_loop',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [5, 0], [5, 3], [0, 3], [0, 7], [5, 7], [5, 4], [2, 4]],
  },
  hourglass: {
    id: 'hourglass',
    name: '時光沙漏 (Hourglass)',
    desc: '雙漏斗結構，中央 (col 2~3, row 3~4) 緊縮為極窄咽喉',
    pathType: 'hourglass',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [5, 0], [5, 3], [3, 3], [3, 4], [5, 4], [5, 7], [0, 7], [0, 4], [2, 4], [2, 3], [0, 3]],
  },
  canyon_switchback: {
    id: 'canyon_switchback',
    name: '大峽谷迴旋 (Canyon Switchback)',
    desc: '垂直走向為主的險峻峭壁山道，左右縱向穿梭於深谷之間',
    pathType: 'canyon',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [0, 7], [2, 7], [2, 1], [4, 1], [4, 7], [5, 7]],
  },
  pinwheel: {
    id: 'pinwheel',
    name: '四葉風車 (Pinwheel Vortex)',
    desc: '四象限旋轉向外擴散走廊，如風車葉片般旋轉擴散',
    pathType: 'pinwheel',
    cols: 6,
    rows: 8,
    waypoints: [[1, 0], [1, 3], [0, 3], [0, 7], [4, 7], [4, 4], [5, 4], [5, 1], [3, 1], [3, 4]],
  },
  twin_bridges: {
    id: 'twin_bridges',
    name: '雙子虹橋 (Twin Bridges)',
    desc: '兩座對稱的懸空高架石橋路徑，將戰場分為左右兩座獨立島嶼',
    pathType: 'twin_bridges',
    cols: 6,
    rows: 8,
    waypoints: [[1, 0], [1, 7], [4, 7], [4, 3], [2, 3], [2, 1], [5, 1]],
  },
  labyrinth_core: {
    id: 'labyrinth_core',
    name: '迷宮核心 (Labyrinth Core)',
    desc: '高密度直角折角迷宮，道路佔比極高，考驗極限微操',
    pathType: 'labyrinth',
    cols: 6,
    rows: 8,
    waypoints: [[0, 0], [3, 0], [3, 2], [1, 2], [1, 5], [4, 5], [4, 2], [5, 2], [5, 7], [0, 7]],
  },
};

let CURRENT_MAP_ID = 'outer_ring';
let PATH_WAYPOINTS = MAP_CONFIGS[CURRENT_MAP_ID].waypoints;

// ─── 3. 防禦塔數據 (Group 1: 5 大自然花靈與植物魔法流派) ──────────────────────────
const TOWER_DATA = {
  petal: {
    name: '粉櫻花靈之箭',
    cost: 100,
    damageType: 'physical',
    range: 120,
    damage: 21,
    fireRate: 1.1,
    projectileSpeed: 320,
    projectileColor: '#ff80ab',
    description: '旋轉五瓣粉櫻 · 翡翠光箭速射',
    color: '#ff80ab',
    levels: [
      { damage: 21, range: 120, fireRate: 1.1 },
      { damage: 31, range: 135, fireRate: 1.3, upgradeCost: 80 },
      { damage: 47, range: 150, fireRate: 1.5, upgradeCost: 160 },
    ],
  },
  sunflower: {
    name: '暖陽向日葵金壇',
    cost: 75,
    range: 0,
    damage: 0,
    fireRate: 0,
    goldPerSecond: 10,
    description: '金黃花瓣 · 每 5 秒定時產出陽光金幣',
    color: '#ffb300',
    levels: [
      { goldPerSecond: 10 },
      { goldPerSecond: 15, upgradeCost: 75 },
      { goldPerSecond: 20, upgradeCost: 150 },
    ],
  },
  lavender: {
    name: '月影薰衣草法杖',
    cost: 220,
    damageType: 'magic',
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
    damageType: 'poison',
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
    damageType: 'physical',
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
    damageType: 'physical',
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
    damageType: 'magic',
    range: 130,
    damage: 12,
    fireRate: 0.8,
    slowFactor: 0.5,
    slowDuration: 3.0,
    piercing: 3,
    projectileSpeed: 380,
    projectileColor: '#40c4ff',
    description: '極地冰晶 · 霜雪穿透與集體凍結',
    color: '#00b0ff',
    levels: [
      { damage: 12, range: 130, fireRate: 0.8, slowFactor: 0.5, slowDuration: 3.0, piercing: 3 },
      { damage: 22, range: 145, fireRate: 0.9, slowFactor: 0.4, slowDuration: 3.5, piercing: 4, upgradeCost: 120 },
      { damage: 38, range: 160, fireRate: 1.0, slowFactor: 0.3, slowDuration: 4.0, piercing: 6, upgradeCost: 240 },
    ],
  },
  laser: {
    name: '星核日光雷射塔',
    cost: 350,
    damageType: 'magic',
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

// 幻境秘境天賦會直接修改 TOWER_DATA[x].levels（累加穿透/減速等數值），
// 若不還原會跨局永久疊加、甚至污染戰役模式，故載入時先存一份原始快照供每局重置還原
const TOWER_DATA_DEFAULTS = JSON.parse(JSON.stringify(TOWER_DATA));
function restoreTowerDataDefaults() {
  for (const key in TOWER_DATA_DEFAULTS) {
    TOWER_DATA[key].levels = TOWER_DATA_DEFAULTS[key].levels.map(lvl => ({ ...lvl }));
  }
}

// ─── 4. 敵人數據 ─────────────────────────────
const ENEMY_DATA = {
  caterpillar: { name: '毛毛蟲', emoji: '🐛', hp: 60, speed: 50, reward: 10, damage: 1 },
  bee: { name: '蜜蜂', emoji: '🐝', hp: 40, speed: 90, reward: 12, damage: 1, canEnrage: true },
  snail: { name: '蝸牛', emoji: '🐌', hp: 170, speed: 28, reward: 25, damage: 2 },
  beetle: { name: '鐵甲甲蟲', emoji: '🪲', hp: 260, speed: 38, reward: 35, damage: 2, resist: { physical: 0.30 } },
  butterfly: { name: '蝴蝶', emoji: '🦋', hp: 90, speed: 65, reward: 18, damage: 1, canEnrage: true },
  dragon: { name: '小龍', emoji: '🐉', hp: 300, speed: 32, reward: 100, damage: 4, isBoss: true },
  armored_ladybug: { name: '裝甲瓢蟲', emoji: '🐞', hp: 200, speed: 34, reward: 45, damage: 3, resist: { physical: 0.50 } },
  mist_moth: { name: '迷霧幽蛾', emoji: '🦇', hp: 140, speed: 70, reward: 42, damage: 2, canEnrage: true, resist: { magic: 0.50 } },
  mantis: { name: '疾風螳螂', emoji: '🦗', hp: 190, speed: 76, reward: 38, damage: 2, immuneSlow: true },
};

// ─── 5. 各關卡波次數據 (每關 15 波，難度各自獨立設計) ─────────────────────
// ─── 5. 各關卡波次數據 (每關 15 波，第 10 波中繼領主 Mid-Boss，第 15 波終極魔王 Final Boss) ───
// 第一關：新手平原（第 10 波：黃金毛毛蟲王，第 15 波：赤焰巨龍王）
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
  { enemies: [{ type: 'caterpillar', count: 1, interval: 3.0, isBoss: true }, { type: 'beetle', count: 2, interval: 1.5 }, { type: 'bee', count: 6, interval: 0.6 }], bonus: 300 },
  { enemies: [{ type: 'butterfly', count: 12, interval: 0.4 }, { type: 'beetle', count: 5, interval: 1.0 }], bonus: 220 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.25 }, { type: 'butterfly', count: 8, interval: 0.4 }], bonus: 240 },
  { enemies: [{ type: 'snail', count: 8, interval: 0.8 }, { type: 'beetle', count: 4, interval: 1.2 }], bonus: 280 },
  { enemies: [{ type: 'beetle', count: 8, interval: 0.6 }, { type: 'butterfly', count: 12, interval: 0.3 }, { type: 'snail', count: 6, interval: 0.6 }], bonus: 320 },
  { enemies: [{ type: 'dragon', count: 1, interval: 4.0, isBoss: true, hpMultiplier: 3.5 }, { type: 'beetle', count: 4, interval: 1.0 }, { type: 'butterfly', count: 8, interval: 0.4 }, { type: 'bee', count: 12, interval: 0.2 }], bonus: 600 },
];

// 第二關：森林小徑（第 10 波：黃金蜂皇，第 15 波：泰坦鐵甲王 + 赤焰巨龍）
const WAVE_DATA_L2 = [
  { enemies: [{ type: 'caterpillar', count: 8, interval: 1.2 }], bonus: 60 },
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.9 }, { type: 'bee', count: 4, interval: 0.7 }], bonus: 70 },
  { enemies: [{ type: 'bee', count: 10, interval: 0.55 }, { type: 'snail', count: 3, interval: 2.0 }], bonus: 100 },
  { enemies: [{ type: 'bee', count: 12, interval: 0.45 }, { type: 'beetle', count: 3, interval: 1.6 }], bonus: 120 },
  { enemies: [{ type: 'caterpillar', count: 6, interval: 0.6 }, { type: 'snail', count: 4, interval: 1.6 }, { type: 'beetle', count: 3, interval: 1.4 }], bonus: 150 },
  { enemies: [{ type: 'bee', count: 12, interval: 0.4 }, { type: 'beetle', count: 5, interval: 1.2 }], bonus: 170 },
  { enemies: [{ type: 'butterfly', count: 8, interval: 0.5 }, { type: 'bee', count: 10, interval: 0.4 }], bonus: 190 },
  { enemies: [{ type: 'snail', count: 6, interval: 1.3 }, { type: 'beetle', count: 6, interval: 1.0 }], bonus: 260 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.25 }, { type: 'butterfly', count: 10, interval: 0.35 }], bonus: 230 },
  { enemies: [{ type: 'bee', count: 1, interval: 3.0, isBoss: true }, { type: 'beetle', count: 4, interval: 1.2 }, { type: 'caterpillar', count: 8, interval: 0.5 }], bonus: 360 },
  { enemies: [{ type: 'butterfly', count: 16, interval: 0.28 }, { type: 'beetle', count: 8, interval: 0.7 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 26, interval: 0.18 }, { type: 'butterfly', count: 12, interval: 0.28 }], bonus: 300 },
  { enemies: [{ type: 'snail', count: 10, interval: 0.6 }, { type: 'beetle', count: 6, interval: 0.8 }], bonus: 380 },
  { enemies: [{ type: 'beetle', count: 10, interval: 0.5 }, { type: 'butterfly', count: 16, interval: 0.25 }, { type: 'snail', count: 8, interval: 0.5 }], bonus: 420 },
  { enemies: [{ type: 'beetle', count: 1, interval: 4.0, isBoss: true, hpMultiplier: 4.0 }, { type: 'dragon', count: 1, interval: 3.5, isBoss: true }, { type: 'butterfly', count: 12, interval: 0.25 }, { type: 'bee', count: 16, interval: 0.15 }], bonus: 700 },
];

// 第三關：蘑菇洞穴（第 10 波：黃金蝸牛王，第 15 波：幻彩蝶后 + 雙巨龍）
const WAVE_DATA_L3 = [
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.9 }, { type: 'bee', count: 3, interval: 1.0 }], bonus: 70 },
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.7 }, { type: 'bee', count: 6, interval: 0.6 }, { type: 'snail', count: 2, interval: 2.0 }], bonus: 90 },
  { enemies: [{ type: 'bee', count: 12, interval: 0.45 }, { type: 'snail', count: 4, interval: 1.6 }, { type: 'beetle', count: 2, interval: 1.6 }], bonus: 130 },
  { enemies: [{ type: 'bee', count: 14, interval: 0.35 }, { type: 'beetle', count: 4, interval: 1.3 }, { type: 'butterfly', count: 4, interval: 0.8 }], bonus: 150 },
  { enemies: [{ type: 'caterpillar', count: 8, interval: 0.5 }, { type: 'snail', count: 5, interval: 1.4 }, { type: 'beetle', count: 4, interval: 1.1 }], bonus: 190 },
  { enemies: [{ type: 'bee', count: 16, interval: 0.3 }, { type: 'beetle', count: 6, interval: 1.0 }, { type: 'butterfly', count: 6, interval: 0.6 }], bonus: 210 },
  { enemies: [{ type: 'butterfly', count: 10, interval: 0.4 }, { type: 'bee', count: 14, interval: 0.32 }], bonus: 300 },
  { enemies: [{ type: 'snail', count: 8, interval: 1.1 }, { type: 'beetle', count: 8, interval: 0.8 }, { type: 'bee', count: 10, interval: 0.35 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 24, interval: 0.2 }, { type: 'butterfly', count: 14, interval: 0.28 }, { type: 'beetle', count: 4, interval: 0.9 }], bonus: 320 },
  { enemies: [{ type: 'snail', count: 1, interval: 3.0, isBoss: true }, { type: 'beetle', count: 5, interval: 1.0 }, { type: 'caterpillar', count: 10, interval: 0.4 }], bonus: 460 },
  { enemies: [{ type: 'butterfly', count: 20, interval: 0.22 }, { type: 'beetle', count: 10, interval: 0.6 }, { type: 'snail', count: 6, interval: 0.9 }], bonus: 380 },
  { enemies: [{ type: 'bee', count: 30, interval: 0.15 }, { type: 'butterfly', count: 16, interval: 0.22 }, { type: 'beetle', count: 6, interval: 0.6 }], bonus: 420 },
  { enemies: [{ type: 'snail', count: 12, interval: 0.5 }, { type: 'beetle', count: 8, interval: 0.5 }], bonus: 500 },
  { enemies: [{ type: 'beetle', count: 14, interval: 0.4 }, { type: 'butterfly', count: 20, interval: 0.2 }, { type: 'snail', count: 10, interval: 0.42 }, { type: 'bee', count: 16, interval: 0.15 }], bonus: 560 },
  { enemies: [{ type: 'butterfly', count: 1, interval: 4.0, isBoss: true, hpMultiplier: 4.5 }, { type: 'dragon', count: 2, interval: 3.0, isBoss: true }, { type: 'beetle', count: 8, interval: 0.6 }, { type: 'bee', count: 20, interval: 0.12 }], bonus: 900 },
];

// 第四關：迷霧沼澤（第 10 波：裝甲神盾王，第 15 波：赤焰始祖巨龍王）
const WAVE_DATA_L4 = [
  { enemies: [{ type: 'caterpillar', count: 12, interval: 0.8 }, { type: 'bee', count: 4, interval: 0.9 }], bonus: 80 },
  { enemies: [{ type: 'caterpillar', count: 12, interval: 0.65 }, { type: 'bee', count: 7, interval: 0.55 }, { type: 'snail', count: 3, interval: 1.8 }], bonus: 105 },
  { enemies: [{ type: 'bee', count: 14, interval: 0.4 }, { type: 'snail', count: 5, interval: 1.45 }, { type: 'beetle', count: 3, interval: 1.45 }], bonus: 150 },
  { enemies: [{ type: 'bee', count: 16, interval: 0.32 }, { type: 'beetle', count: 5, interval: 1.2 }, { type: 'butterfly', count: 5, interval: 0.75 }], bonus: 175 },
  { enemies: [{ type: 'caterpillar', count: 9, interval: 0.45 }, { type: 'snail', count: 6, interval: 1.3 }, { type: 'beetle', count: 5, interval: 1.0 }], bonus: 220 },
  { enemies: [{ type: 'bee', count: 19, interval: 0.28 }, { type: 'beetle', count: 7, interval: 0.9 }, { type: 'butterfly', count: 7, interval: 0.55 }], bonus: 240 },
  { enemies: [{ type: 'butterfly', count: 12, interval: 0.37 }, { type: 'bee', count: 16, interval: 0.29 }], bonus: 345 },
  { enemies: [{ type: 'snail', count: 9, interval: 1.0 }, { type: 'beetle', count: 9, interval: 0.75 }, { type: 'bee', count: 12, interval: 0.32 }], bonus: 320 },
  { enemies: [{ type: 'bee', count: 28, interval: 0.18 }, { type: 'butterfly', count: 17, interval: 0.26 }, { type: 'beetle', count: 5, interval: 0.8 }], bonus: 370 },
  { enemies: [{ type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true }, { type: 'beetle', count: 6, interval: 0.8 }, { type: 'bee', count: 14, interval: 0.25 }], bonus: 520 },
  { enemies: [{ type: 'butterfly', count: 23, interval: 0.2 }, { type: 'beetle', count: 12, interval: 0.55 }, { type: 'snail', count: 7, interval: 0.8 }], bonus: 440 },
  { enemies: [{ type: 'bee', count: 35, interval: 0.14 }, { type: 'butterfly', count: 19, interval: 0.2 }, { type: 'beetle', count: 7, interval: 0.55 }], bonus: 485 },
  { enemies: [{ type: 'snail', count: 14, interval: 0.46 }, { type: 'beetle', count: 9, interval: 0.46 }], bonus: 575 },
  { enemies: [{ type: 'beetle', count: 17, interval: 0.37 }, { type: 'butterfly', count: 23, interval: 0.18 }, { type: 'snail', count: 12, interval: 0.39 }, { type: 'bee', count: 19, interval: 0.14 }], bonus: 645 },
  { enemies: [{ type: 'dragon', count: 1, interval: 4.0, isBoss: true, hpMultiplier: 5.0 }, { type: 'armored_ladybug', count: 2, interval: 1.5 }, { type: 'beetle', count: 10, interval: 0.5 }, { type: 'butterfly', count: 16, interval: 0.2 }], bonus: 1050 },
];

// 第五關：冰霜山脊（第 10 波：薄暮幽蛾神，第 15 波：泰坦金甲王 + 雙巨龍）
const WAVE_DATA_L5 = [
  { enemies: [{ type: 'caterpillar', count: 14, interval: 0.72 }, { type: 'bee', count: 5, interval: 0.82 }], bonus: 95 },
  { enemies: [{ type: 'caterpillar', count: 14, interval: 0.58 }, { type: 'bee', count: 8, interval: 0.5 }, { type: 'snail', count: 3, interval: 1.62 }], bonus: 120 },
  { enemies: [{ type: 'bee', count: 16, interval: 0.36 }, { type: 'snail', count: 6, interval: 1.3 }, { type: 'beetle', count: 3, interval: 1.3 }], bonus: 170 },
  { enemies: [{ type: 'bee', count: 18, interval: 0.29 }, { type: 'beetle', count: 6, interval: 1.08 }, { type: 'butterfly', count: 6, interval: 0.68 }], bonus: 200 },
  { enemies: [{ type: 'caterpillar', count: 10, interval: 0.4 }, { type: 'snail', count: 7, interval: 1.17 }, { type: 'beetle', count: 6, interval: 0.9 }], bonus: 250 },
  { enemies: [{ type: 'bee', count: 22, interval: 0.25 }, { type: 'beetle', count: 8, interval: 0.81 }, { type: 'butterfly', count: 8, interval: 0.5 }], bonus: 275 },
  { enemies: [{ type: 'butterfly', count: 10, interval: 0.33 }, { type: 'mantis', count: 4, interval: 0.65 }, { type: 'bee', count: 14, interval: 0.26 }], bonus: 395 },
  { enemies: [{ type: 'snail', count: 10, interval: 0.9 }, { type: 'beetle', count: 10, interval: 0.68 }, { type: 'bee', count: 14, interval: 0.29 }], bonus: 365 },
  { enemies: [{ type: 'bee', count: 32, interval: 0.16 }, { type: 'butterfly', count: 19, interval: 0.23 }, { type: 'beetle', count: 6, interval: 0.72 }], bonus: 425 },
  { enemies: [{ type: 'mantis', count: 1, interval: 3.0, isBoss: true }, { type: 'snail', count: 8, interval: 0.8 }, { type: 'butterfly', count: 12, interval: 0.3 }], bonus: 600 },
  { enemies: [{ type: 'butterfly', count: 26, interval: 0.18 }, { type: 'beetle', count: 14, interval: 0.5 }, { type: 'snail', count: 8, interval: 0.72 }], bonus: 505 },
  { enemies: [{ type: 'bee', count: 40, interval: 0.12 }, { type: 'butterfly', count: 22, interval: 0.18 }, { type: 'mantis', count: 6, interval: 0.5 }], bonus: 555 },
  { enemies: [{ type: 'snail', count: 16, interval: 0.41 }, { type: 'beetle', count: 10, interval: 0.41 }], bonus: 660 },
  { enemies: [{ type: 'mantis', count: 8, interval: 0.35 }, { type: 'beetle', count: 15, interval: 0.33 }, { type: 'snail', count: 12, interval: 0.35 }, { type: 'bee', count: 22, interval: 0.12 }], bonus: 740 },
  { enemies: [{ type: 'beetle', count: 1, interval: 4.0, isBoss: true, hpMultiplier: 4.5 }, { type: 'dragon', count: 2, interval: 3.0, isBoss: true }, { type: 'mantis', count: 5, interval: 0.7 }, { type: 'bee', count: 24, interval: 0.1 }], bonus: 1250 },
];

// 第六關：水晶裂谷（第 10 波：裝甲神盾王，第 15 波：薄暮幽蛾神 + 雙抗性霸主）
const WAVE_DATA_L6 = [
  { enemies: [{ type: 'caterpillar', count: 16, interval: 0.65 }, { type: 'bee', count: 6, interval: 0.75 }], bonus: 105 },
  { enemies: [{ type: 'caterpillar', count: 16, interval: 0.52 }, { type: 'bee', count: 9, interval: 0.45 }, { type: 'snail', count: 4, interval: 1.45 }], bonus: 135 },
  { enemies: [{ type: 'bee', count: 18, interval: 0.32 }, { type: 'snail', count: 7, interval: 1.15 }, { type: 'beetle', count: 4, interval: 1.15 }], bonus: 195 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.26 }, { type: 'beetle', count: 7, interval: 0.95 }, { type: 'butterfly', count: 7, interval: 0.6 }], bonus: 225 },
  { enemies: [{ type: 'caterpillar', count: 11, interval: 0.36 }, { type: 'snail', count: 8, interval: 1.05 }, { type: 'beetle', count: 7, interval: 0.8 }], bonus: 285 },
  { enemies: [{ type: 'bee', count: 25, interval: 0.22 }, { type: 'beetle', count: 9, interval: 0.72 }, { type: 'butterfly', count: 9, interval: 0.45 }, { type: 'mist_moth', count: 3, interval: 0.9 }], bonus: 315 },
  { enemies: [{ type: 'butterfly', count: 16, interval: 0.29 }, { type: 'bee', count: 20, interval: 0.23 }, { type: 'armored_ladybug', count: 3, interval: 1.3 }], bonus: 450 },
  { enemies: [{ type: 'snail', count: 12, interval: 0.8 }, { type: 'beetle', count: 12, interval: 0.6 }, { type: 'bee', count: 16, interval: 0.26 }], bonus: 420 },
  { enemies: [{ type: 'bee', count: 36, interval: 0.14 }, { type: 'butterfly', count: 22, interval: 0.2 }, { type: 'beetle', count: 7, interval: 0.65 }, { type: 'mist_moth', count: 4, interval: 0.8 }], bonus: 480 },
  { enemies: [{ type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true }, { type: 'mist_moth', count: 4, interval: 0.8 }, { type: 'caterpillar', count: 16, interval: 0.28 }], bonus: 680 },
  { enemies: [{ type: 'butterfly', count: 30, interval: 0.16 }, { type: 'beetle', count: 16, interval: 0.45 }, { type: 'snail', count: 9, interval: 0.65 }], bonus: 570 },
  { enemies: [{ type: 'bee', count: 45, interval: 0.1 }, { type: 'butterfly', count: 25, interval: 0.16 }, { type: 'beetle', count: 9, interval: 0.45 }, { type: 'mist_moth', count: 5, interval: 0.65 }], bonus: 630 },
  { enemies: [{ type: 'snail', count: 18, interval: 0.37 }, { type: 'beetle', count: 12, interval: 0.37 }, { type: 'armored_ladybug', count: 5, interval: 0.75 }], bonus: 750 },
  { enemies: [{ type: 'beetle', count: 22, interval: 0.29 }, { type: 'butterfly', count: 30, interval: 0.14 }, { type: 'snail', count: 16, interval: 0.32 }, { type: 'bee', count: 25, interval: 0.1 }], bonus: 840 },
  { enemies: [{ type: 'mist_moth', count: 1, interval: 4.0, isBoss: true, hpMultiplier: 4.5 }, { type: 'dragon', count: 2, interval: 3.0, isBoss: true }, { type: 'armored_ladybug', count: 4, interval: 0.7 }, { type: 'butterfly', count: 20, interval: 0.15 }], bonus: 1450 },
];

// 第七關：熔岩核心（第 10 波：雙生蜂皇，第 15 波：毀滅赤焰雙龍王）
const WAVE_DATA_L7 = [
  { enemies: [{ type: 'caterpillar', count: 18, interval: 0.6 }, { type: 'bee', count: 7, interval: 0.65 }], bonus: 140 },
  { enemies: [{ type: 'caterpillar', count: 18, interval: 0.46 }, { type: 'bee', count: 11, interval: 0.4 }, { type: 'snail', count: 5, interval: 1.3 }], bonus: 180 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.28 }, { type: 'snail', count: 8, interval: 1.0 }, { type: 'beetle', count: 5, interval: 1.0 }], bonus: 260 },
  { enemies: [{ type: 'bee', count: 22, interval: 0.22 }, { type: 'beetle', count: 8, interval: 0.85 }, { type: 'butterfly', count: 8, interval: 0.52 }], bonus: 300 },
  { enemies: [{ type: 'caterpillar', count: 12, interval: 0.32 }, { type: 'snail', count: 9, interval: 0.95 }, { type: 'beetle', count: 8, interval: 0.7 }], bonus: 380 },
  { enemies: [{ type: 'bee', count: 28, interval: 0.19 }, { type: 'beetle', count: 10, interval: 0.62 }, { type: 'butterfly', count: 11, interval: 0.4 }, { type: 'mist_moth', count: 4, interval: 0.85 }], bonus: 420 },
  { enemies: [{ type: 'butterfly', count: 18, interval: 0.25 }, { type: 'bee', count: 22, interval: 0.2 }, { type: 'armored_ladybug', count: 4, interval: 1.2 }], bonus: 600 },
  { enemies: [{ type: 'snail', count: 14, interval: 0.7 }, { type: 'beetle', count: 14, interval: 0.52 }, { type: 'bee', count: 18, interval: 0.22 }], bonus: 560 },
  { enemies: [{ type: 'bee', count: 40, interval: 0.12 }, { type: 'butterfly', count: 25, interval: 0.17 }, { type: 'beetle', count: 8, interval: 0.55 }, { type: 'mist_moth', count: 5, interval: 0.75 }], bonus: 640 },
  { enemies: [{ type: 'bee', count: 1, interval: 3.0, isBoss: true }, { type: 'dragon', count: 1, interval: 3.5, isBoss: true }, { type: 'beetle', count: 10, interval: 0.5 }], bonus: 900 },
  { enemies: [{ type: 'butterfly', count: 34, interval: 0.14 }, { type: 'beetle', count: 18, interval: 0.4 }, { type: 'snail', count: 10, interval: 0.55 }], bonus: 760 },
  { enemies: [{ type: 'bee', count: 50, interval: 0.09 }, { type: 'butterfly', count: 28, interval: 0.14 }, { type: 'beetle', count: 10, interval: 0.4 }, { type: 'mist_moth', count: 6, interval: 0.6 }], bonus: 840 },
  { enemies: [{ type: 'snail', count: 20, interval: 0.32 }, { type: 'beetle', count: 14, interval: 0.32 }, { type: 'armored_ladybug', count: 6, interval: 0.65 }], bonus: 1000 },
  { enemies: [{ type: 'beetle', count: 25, interval: 0.25 }, { type: 'butterfly', count: 34, interval: 0.12 }, { type: 'snail', count: 18, interval: 0.28 }, { type: 'bee', count: 28, interval: 0.09 }], bonus: 1120 },
  { enemies: [{ type: 'dragon', count: 2, interval: 3.5, isBoss: true, hpMultiplier: 5.0 }, { type: 'armored_ladybug', count: 5, interval: 0.6 }, { type: 'mist_moth', count: 5, interval: 0.6 }, { type: 'bee', count: 30, interval: 0.08 }], bonus: 1800 },
];

// 第八關：時光沙漏 (雙三角咽喉)（第 10 波：黃金神盾領主，第 15 波：遠古時空巨龍王）
const WAVE_DATA_L8 = [
  { enemies: [{ type: 'caterpillar', count: 20, interval: 0.55 }, { type: 'bee', count: 8, interval: 0.6 }], bonus: 150 },
  { enemies: [{ type: 'caterpillar', count: 20, interval: 0.42 }, { type: 'bee', count: 12, interval: 0.38 }, { type: 'snail', count: 6, interval: 1.2 }], bonus: 195 },
  { enemies: [{ type: 'bee', count: 22, interval: 0.26 }, { type: 'snail', count: 9, interval: 0.95 }, { type: 'beetle', count: 6, interval: 0.95 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 24, interval: 0.2 }, { type: 'beetle', count: 9, interval: 0.8 }, { type: 'butterfly', count: 9, interval: 0.48 }], bonus: 320 },
  { enemies: [{ type: 'caterpillar', count: 14, interval: 0.3 }, { type: 'snail', count: 10, interval: 0.9 }, { type: 'beetle', count: 9, interval: 0.65 }], bonus: 400 },
  { enemies: [{ type: 'bee', count: 30, interval: 0.18 }, { type: 'beetle', count: 11, interval: 0.58 }, { type: 'butterfly', count: 12, interval: 0.38 }, { type: 'mist_moth', count: 4, interval: 0.8 }], bonus: 450 },
  { enemies: [{ type: 'butterfly', count: 20, interval: 0.23 }, { type: 'bee', count: 24, interval: 0.18 }, { type: 'armored_ladybug', count: 5, interval: 1.1 }], bonus: 650 },
  { enemies: [{ type: 'snail', count: 15, interval: 0.65 }, { type: 'beetle', count: 15, interval: 0.48 }, { type: 'bee', count: 20, interval: 0.2 }], bonus: 600 },
  { enemies: [{ type: 'bee', count: 42, interval: 0.11 }, { type: 'butterfly', count: 26, interval: 0.16 }, { type: 'beetle', count: 9, interval: 0.5 }, { type: 'mist_moth', count: 6, interval: 0.7 }], bonus: 680 },
  { enemies: [{ type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true }, { type: 'snail', count: 8, interval: 0.7 }, { type: 'butterfly', count: 15, interval: 0.2 }], bonus: 950 },
  { enemies: [{ type: 'butterfly', count: 36, interval: 0.13 }, { type: 'beetle', count: 20, interval: 0.38 }, { type: 'snail', count: 11, interval: 0.52 }], bonus: 820 },
  { enemies: [{ type: 'bee', count: 55, interval: 0.08 }, { type: 'butterfly', count: 30, interval: 0.13 }, { type: 'beetle', count: 11, interval: 0.38 }, { type: 'mist_moth', count: 7, interval: 0.55 }], bonus: 900 },
  { enemies: [{ type: 'snail', count: 22, interval: 0.3 }, { type: 'beetle', count: 15, interval: 0.3 }, { type: 'armored_ladybug', count: 7, interval: 0.6 }], bonus: 1100 },
  { enemies: [{ type: 'beetle', count: 28, interval: 0.23 }, { type: 'butterfly', count: 36, interval: 0.11 }, { type: 'snail', count: 20, interval: 0.26 }, { type: 'bee', count: 30, interval: 0.08 }], bonus: 1200 },
  { enemies: [{ type: 'dragon', count: 2, interval: 3.2, isBoss: true, hpMultiplier: 5.5 }, { type: 'butterfly', count: 1, interval: 3.0, isBoss: true }, { type: 'armored_ladybug', count: 6, interval: 0.5 }, { type: 'bee', count: 32, interval: 0.07 }], bonus: 1950 },
];

// 第九關：大峽谷迴旋 (垂直長廊)（第 10 波：幽蛾神 + 蝶后雙魔王，第 15 波：物法雙始祖霸主）
const WAVE_DATA_L9 = [
  { enemies: [{ type: 'caterpillar', count: 22, interval: 0.5 }, { type: 'bee', count: 9, interval: 0.55 }], bonus: 160 },
  { enemies: [{ type: 'caterpillar', count: 22, interval: 0.39 }, { type: 'bee', count: 13, interval: 0.35 }, { type: 'snail', count: 7, interval: 1.1 }], bonus: 210 },
  { enemies: [{ type: 'bee', count: 24, interval: 0.24 }, { type: 'snail', count: 10, interval: 0.9 }, { type: 'beetle', count: 7, interval: 0.9 }], bonus: 300 },
  { enemies: [{ type: 'bee', count: 26, interval: 0.18 }, { type: 'beetle', count: 10, interval: 0.75 }, { type: 'butterfly', count: 10, interval: 0.45 }], bonus: 350 },
  { enemies: [{ type: 'caterpillar', count: 15, interval: 0.28 }, { type: 'snail', count: 11, interval: 0.85 }, { type: 'beetle', count: 10, interval: 0.6 }], bonus: 430 },
  { enemies: [{ type: 'bee', count: 32, interval: 0.17 }, { type: 'beetle', count: 12, interval: 0.55 }, { type: 'butterfly', count: 13, interval: 0.36 }, { type: 'mist_moth', count: 5, interval: 0.75 }], bonus: 480 },
  { enemies: [{ type: 'butterfly', count: 22, interval: 0.21 }, { type: 'bee', count: 26, interval: 0.17 }, { type: 'armored_ladybug', count: 5, interval: 1.05 }], bonus: 700 },
  { enemies: [{ type: 'snail', count: 16, interval: 0.6 }, { type: 'beetle', count: 16, interval: 0.45 }, { type: 'bee', count: 22, interval: 0.18 }], bonus: 650 },
  { enemies: [{ type: 'bee', count: 45, interval: 0.1 }, { type: 'butterfly', count: 28, interval: 0.15 }, { type: 'beetle', count: 10, interval: 0.48 }, { type: 'mist_moth', count: 6, interval: 0.65 }], bonus: 730 },
  { enemies: [{ type: 'mist_moth', count: 1, interval: 3.0, isBoss: true }, { type: 'butterfly', count: 1, interval: 2.5, isBoss: true }, { type: 'bee', count: 20, interval: 0.15 }], bonus: 1050 },
  { enemies: [{ type: 'butterfly', count: 38, interval: 0.12 }, { type: 'beetle', count: 22, interval: 0.36 }, { type: 'snail', count: 12, interval: 0.5 }], bonus: 880 },
  { enemies: [{ type: 'bee', count: 60, interval: 0.07 }, { type: 'butterfly', count: 32, interval: 0.12 }, { type: 'beetle', count: 12, interval: 0.36 }, { type: 'mist_moth', count: 8, interval: 0.5 }], bonus: 960 },
  { enemies: [{ type: 'snail', count: 24, interval: 0.28 }, { type: 'beetle', count: 16, interval: 0.28 }, { type: 'armored_ladybug', count: 8, interval: 0.55 }], bonus: 1180 },
  { enemies: [{ type: 'beetle', count: 30, interval: 0.21 }, { type: 'butterfly', count: 38, interval: 0.1 }, { type: 'snail', count: 22, interval: 0.24 }, { type: 'bee', count: 32, interval: 0.07 }], bonus: 1300 },
  { enemies: [{ type: 'dragon', count: 2, interval: 3.0, isBoss: true, hpMultiplier: 5.5 }, { type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true }, { type: 'mist_moth', count: 6, interval: 0.5 }, { type: 'bee', count: 36, interval: 0.06 }], bonus: 2100 },
];

// 第十關：四葉風車 (多向外旋)（第 10 波：泰坦甲蟲王 + 神盾王，第 15 波：四方風車神話領主）
const WAVE_DATA_L10 = [
  { enemies: [{ type: 'caterpillar', count: 24, interval: 0.46 }, { type: 'bee', count: 10, interval: 0.5 }], bonus: 175 },
  { enemies: [{ type: 'caterpillar', count: 24, interval: 0.36 }, { type: 'bee', count: 14, interval: 0.32 }, { type: 'snail', count: 8, interval: 1.0 }], bonus: 230 },
  { enemies: [{ type: 'bee', count: 26, interval: 0.22 }, { type: 'snail', count: 11, interval: 0.85 }, { type: 'beetle', count: 8, interval: 0.85 }], bonus: 330 },
  { enemies: [{ type: 'bee', count: 28, interval: 0.16 }, { type: 'beetle', count: 11, interval: 0.7 }, { type: 'butterfly', count: 11, interval: 0.42 }], bonus: 380 },
  { enemies: [{ type: 'caterpillar', count: 16, interval: 0.26 }, { type: 'snail', count: 12, interval: 0.8 }, { type: 'beetle', count: 11, interval: 0.55 }], bonus: 470 },
  { enemies: [{ type: 'bee', count: 35, interval: 0.15 }, { type: 'beetle', count: 13, interval: 0.52 }, { type: 'butterfly', count: 14, interval: 0.34 }, { type: 'mist_moth', count: 5, interval: 0.7 }], bonus: 520 },
  { enemies: [{ type: 'butterfly', count: 24, interval: 0.19 }, { type: 'bee', count: 28, interval: 0.15 }, { type: 'armored_ladybug', count: 6, interval: 1.0 }], bonus: 760 },
  { enemies: [{ type: 'snail', count: 18, interval: 0.55 }, { type: 'beetle', count: 18, interval: 0.42 }, { type: 'bee', count: 24, interval: 0.16 }], bonus: 700 },
  { enemies: [{ type: 'bee', count: 48, interval: 0.09 }, { type: 'butterfly', count: 30, interval: 0.14 }, { type: 'beetle', count: 11, interval: 0.45 }, { type: 'mist_moth', count: 7, interval: 0.6 }], bonus: 790 },
  { enemies: [{ type: 'beetle', count: 1, interval: 3.0, isBoss: true }, { type: 'armored_ladybug', count: 1, interval: 2.5, isBoss: true }, { type: 'bee', count: 24, interval: 0.12 }], bonus: 1150 },
  { enemies: [{ type: 'butterfly', count: 40, interval: 0.11 }, { type: 'beetle', count: 24, interval: 0.34 }, { type: 'snail', count: 13, interval: 0.48 }], bonus: 950 },
  { enemies: [{ type: 'bee', count: 65, interval: 0.06 }, { type: 'butterfly', count: 35, interval: 0.11 }, { type: 'beetle', count: 13, interval: 0.34 }, { type: 'mist_moth', count: 9, interval: 0.46 }], bonus: 1040 },
  { enemies: [{ type: 'snail', count: 26, interval: 0.26 }, { type: 'beetle', count: 18, interval: 0.26 }, { type: 'armored_ladybug', count: 9, interval: 0.5 }], bonus: 1280 },
  { enemies: [{ type: 'beetle', count: 32, interval: 0.19 }, { type: 'butterfly', count: 40, interval: 0.09 }, { type: 'snail', count: 24, interval: 0.22 }, { type: 'bee', count: 35, interval: 0.06 }], bonus: 1400 },
  { enemies: [{ type: 'dragon', count: 2, interval: 3.0, isBoss: true, hpMultiplier: 6.0 }, { type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true }, { type: 'mist_moth', count: 1, interval: 3.0, isBoss: true }, { type: 'bee', count: 40, interval: 0.05 }], bonus: 2300 },
];

// 第十一關：雙子虹橋 (雙島空域)（第 10 波：雙子蜂皇 + 雙子幽蛾神，第 15 波：雙島始祖巨龍雙首領）
const WAVE_DATA_L11 = [
  { enemies: [{ type: 'caterpillar', count: 26, interval: 0.42 }, { type: 'bee', count: 11, interval: 0.46 }], bonus: 190 },
  { enemies: [{ type: 'caterpillar', count: 26, interval: 0.33 }, { type: 'bee', count: 15, interval: 0.29 }, { type: 'snail', count: 9, interval: 0.9 }], bonus: 250 },
  { enemies: [{ type: 'bee', count: 28, interval: 0.2 }, { type: 'snail', count: 12, interval: 0.8 }, { type: 'beetle', count: 9, interval: 0.8 }], bonus: 360 },
  { enemies: [{ type: 'bee', count: 30, interval: 0.14 }, { type: 'beetle', count: 12, interval: 0.65 }, { type: 'butterfly', count: 12, interval: 0.39 }], bonus: 410 },
  { enemies: [{ type: 'caterpillar', count: 18, interval: 0.24 }, { type: 'snail', count: 13, interval: 0.75 }, { type: 'beetle', count: 12, interval: 0.5 }], bonus: 510 },
  { enemies: [{ type: 'bee', count: 38, interval: 0.13 }, { type: 'beetle', count: 14, interval: 0.48 }, { type: 'butterfly', count: 15, interval: 0.31 }, { type: 'mist_moth', count: 6, interval: 0.65 }], bonus: 570 },
  { enemies: [{ type: 'butterfly', count: 26, interval: 0.17 }, { type: 'bee', count: 30, interval: 0.14 }, { type: 'armored_ladybug', count: 6, interval: 0.95 }], bonus: 830 },
  { enemies: [{ type: 'snail', count: 20, interval: 0.5 }, { type: 'beetle', count: 20, interval: 0.38 }, { type: 'bee', count: 26, interval: 0.15 }], bonus: 770 },
  { enemies: [{ type: 'bee', count: 52, interval: 0.08 }, { type: 'butterfly', count: 33, interval: 0.13 }, { type: 'beetle', count: 12, interval: 0.4 }, { type: 'mist_moth', count: 8, interval: 0.55 }], bonus: 860 },
  { enemies: [{ type: 'bee', count: 1, interval: 3.0, isBoss: true }, { type: 'mist_moth', count: 1, interval: 2.5, isBoss: true }, { type: 'snail', count: 12, interval: 0.5 }], bonus: 1250 },
  { enemies: [{ type: 'butterfly', count: 43, interval: 0.1 }, { type: 'beetle', count: 26, interval: 0.31 }, { type: 'snail', count: 14, interval: 0.45 }], bonus: 1040 },
  { enemies: [{ type: 'bee', count: 70, interval: 0.05 }, { type: 'butterfly', count: 38, interval: 0.1 }, { type: 'beetle', count: 14, interval: 0.31 }, { type: 'mist_moth', count: 9, interval: 0.42 }], bonus: 1140 },
  { enemies: [{ type: 'snail', count: 28, interval: 0.24 }, { type: 'beetle', count: 20, interval: 0.24 }, { type: 'armored_ladybug', count: 10, interval: 0.46 }], bonus: 1390 },
  { enemies: [{ type: 'beetle', count: 35, interval: 0.17 }, { type: 'butterfly', count: 43, interval: 0.08 }, { type: 'snail', count: 26, interval: 0.2 }, { type: 'bee', count: 38, interval: 0.05 }], bonus: 1530 },
  { enemies: [{ type: 'dragon', count: 2, interval: 3.0, isBoss: true, hpMultiplier: 6.5 }, { type: 'beetle', count: 1, interval: 3.0, isBoss: true }, { type: 'armored_ladybug', count: 8, interval: 0.4 }, { type: 'mist_moth', count: 8, interval: 0.4 }], bonus: 2500 },
];

// 第十二關：迷宮核心 (極限微操)（第 10 波：迷宮三領主大集結，第 15 波：終極萬魔之王大決戰）
const WAVE_DATA_L12 = [
  { enemies: [{ type: 'caterpillar', count: 28, interval: 0.38 }, { type: 'bee', count: 12, interval: 0.42 }], bonus: 210 },
  { enemies: [{ type: 'caterpillar', count: 28, interval: 0.3 }, { type: 'bee', count: 16, interval: 0.26 }, { type: 'snail', count: 10, interval: 0.8 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 30, interval: 0.18 }, { type: 'snail', count: 13, interval: 0.75 }, { type: 'beetle', count: 10, interval: 0.75 }], bonus: 400 },
  { enemies: [{ type: 'bee', count: 32, interval: 0.12 }, { type: 'beetle', count: 13, interval: 0.6 }, { type: 'butterfly', count: 13, interval: 0.36 }], bonus: 460 },
  { enemies: [{ type: 'caterpillar', count: 20, interval: 0.21 }, { type: 'snail', count: 14, interval: 0.7 }, { type: 'beetle', count: 13, interval: 0.45 }], bonus: 570 },
  { enemies: [{ type: 'bee', count: 42, interval: 0.11 }, { type: 'beetle', count: 15, interval: 0.44 }, { type: 'butterfly', count: 17, interval: 0.28 }, { type: 'mist_moth', count: 6, interval: 0.6 }], bonus: 640 },
  { enemies: [{ type: 'butterfly', count: 28, interval: 0.15 }, { type: 'bee', count: 32, interval: 0.12 }, { type: 'armored_ladybug', count: 7, interval: 0.9 }], bonus: 930 },
  { enemies: [{ type: 'snail', count: 22, interval: 0.45 }, { type: 'beetle', count: 22, interval: 0.34 }, { type: 'bee', count: 28, interval: 0.13 }], bonus: 860 },
  { enemies: [{ type: 'bee', count: 56, interval: 0.07 }, { type: 'butterfly', count: 36, interval: 0.11 }, { type: 'beetle', count: 13, interval: 0.36 }, { type: 'mist_moth', count: 8, interval: 0.5 }], bonus: 970 },
  { enemies: [{ type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true }, { type: 'mist_moth', count: 1, interval: 2.5, isBoss: true }, { type: 'dragon', count: 1, interval: 3.0, isBoss: true }], bonus: 1400 },
  { enemies: [{ type: 'butterfly', count: 46, interval: 0.09 }, { type: 'beetle', count: 28, interval: 0.28 }, { type: 'snail', count: 16, interval: 0.4 }], bonus: 1160 },
  { enemies: [{ type: 'bee', count: 75, interval: 0.045 }, { type: 'butterfly', count: 42, interval: 0.09 }, { type: 'beetle', count: 16, interval: 0.28 }, { type: 'mist_moth', count: 10, interval: 0.4 }], bonus: 1280 },
  { enemies: [{ type: 'snail', count: 30, interval: 0.21 }, { type: 'beetle', count: 22, interval: 0.21 }, { type: 'armored_ladybug', count: 11, interval: 0.42 }], bonus: 1550 },
  { enemies: [{ type: 'beetle', count: 38, interval: 0.15 }, { type: 'butterfly', count: 46, interval: 0.07 }, { type: 'snail', count: 28, interval: 0.18 }, { type: 'bee', count: 42, interval: 0.045 }], bonus: 1720 },
  { enemies: [{ type: 'dragon', count: 2, interval: 3.0, isBoss: true, hpMultiplier: 7.5 }, { type: 'armored_ladybug', count: 1, interval: 3.0, isBoss: true, hpMultiplier: 5.0 }, { type: 'mist_moth', count: 1, interval: 3.0, isBoss: true, hpMultiplier: 5.0 }, { type: 'butterfly', count: 30, interval: 0.08 }, { type: 'bee', count: 45, interval: 0.04 }], bonus: 3000 },
];

// ─── 5.1 關卡定義：地圖 + 專屬波次 (12 大關卡全部獨立專屬地圖) ─────
// hpMultiplier：難度成長依關卡依序遞增 (1.0x ➔ 4.3x)
const LEVEL_DATA = [
  { id: 'level_1', name: '第一關・晨光花園', mapId: 'outer_ring', waves: WAVE_DATA_L1, hpMultiplier: 1.0 },
  { id: 'level_2', name: '第二關・迷霧小徑', mapId: 'serpentine', waves: WAVE_DATA_L2, hpMultiplier: 1.0 },
  { id: 'level_3', name: '第三關・競技之環', mapId: 'ring', waves: WAVE_DATA_L3, hpMultiplier: 1.0 },
  { id: 'level_4', name: '第四關・深林迴廊', mapId: 'zigzag', waves: WAVE_DATA_L4, hpMultiplier: 1.3 },
  { id: 'level_5', name: '第五關・炎陽廢墟', mapId: 'crossroad', waves: WAVE_DATA_L5, hpMultiplier: 1.3 },
  { id: 'level_6', name: '第六關・冰封絕地', mapId: 'spiral_deep', waves: WAVE_DATA_L6, hpMultiplier: 1.7 },
  { id: 'level_7', name: '第七關・龍王聖殿', mapId: 'dual_loop', waves: WAVE_DATA_L7, hpMultiplier: 1.7 },
  { id: 'level_8', name: '第八關・時光沙漏', mapId: 'hourglass', waves: WAVE_DATA_L8, hpMultiplier: 2.3 },
  { id: 'level_9', name: '第九關・大峽谷迴旋', mapId: 'canyon_switchback', waves: WAVE_DATA_L9, hpMultiplier: 2.3 },
  { id: 'level_10', name: '第十關・四葉風車', mapId: 'pinwheel', waves: WAVE_DATA_L10, hpMultiplier: 3.0 },
  { id: 'level_11', name: '第十一關・雙子虹橋', mapId: 'twin_bridges', waves: WAVE_DATA_L11, hpMultiplier: 3.0 },
  { id: 'level_12', name: '第十二關・迷宮核心', mapId: 'labyrinth_core', waves: WAVE_DATA_L12, hpMultiplier: 3.8 },
];

// ─── 5.1.5 Roguelike 肉鴿幻境秘境專屬關卡定義 (啟用三選一隨機抽卡) ─────
const GAME_MODES = {
  CAMPAIGN: 'campaign',     // 主線戰役：純粹硬核佈陣
  ROGUELIKE: 'roguelike',   // 幻境秘境：每 3 波三選一神力賜福
};
let CURRENT_GAME_MODE = GAME_MODES.CAMPAIGN;

const ROGUELIKE_LEVEL_DATA = [
  { id: 'rogue_1', name: '幻境・初醒之森', mapId: 'outer_ring', waves: WAVE_DATA_L1, hpMultiplier: 1.0, mode: GAME_MODES.ROGUELIKE },
  { id: 'rogue_2', name: '幻境・迷霧之谷', mapId: 'serpentine', waves: WAVE_DATA_L3, hpMultiplier: 1.15, mode: GAME_MODES.ROGUELIKE },
  { id: 'rogue_3', name: '幻境・深淵之環', mapId: 'ring', waves: WAVE_DATA_L5, hpMultiplier: 1.3, mode: GAME_MODES.ROGUELIKE },
  { id: 'rogue_4', name: '幻境・混沌迷宮', mapId: 'labyrinth_core', waves: WAVE_DATA_L12, hpMultiplier: 1.5, mode: GAME_MODES.ROGUELIKE },
];

// ─── 5.1.6 Roguelike 天賦技能樹 (Branch + Level + Hidden Combo) ─────────
// 每個流派有 2 條分支，各自可獨立升到 Lv.3；兩條分支都到達門檻等級後，
// 會解鎖只出現一次的隱藏合成天賦（不佔用分支升級名額，取得後永久生效）
// 冰爆殉爆連鎖：被炸死的敵人會在原地引爆下一輪冰爆，chainsLeft 用來防止無限遞迴
function triggerIceShatterExplosion(origin, game, cfg, chainsLeft) {
  const justKilled = [];
  for (const other of game.enemies) {
    if (!other.alive || other === origin) continue;
    if (dist(origin.x, origin.y, other.x, other.y) <= cfg.radius) {
      let boomDmg = Math.max(20, Math.floor(origin.maxHp * cfg.pct));
      // 百分比傷害保護上限：單次冰爆對任何目標（小怪與首領）最高 250 點
      boomDmg = Math.min(boomDmg, 250);
      
      // 傷害歸屬：將冰爆傷害精準計入「極光冰晶塔」的傷害統計
      if (game) {
        const iceTower = game.towers.find(t => t.typeKey === 'ice_crystal');
        if (iceTower) {
          iceTower.totalDamageDealt = (iceTower.totalDamageDealt || 0) + boomDmg;
        } else if (game.typeTotalDamage) {
          game.typeTotalDamage.ice_crystal = (game.typeTotalDamage.ice_crystal || 0) + boomDmg;
        }
      }

      other.takeDamage(boomDmg, cfg.extraSlow ? 0.4 : null, cfg.extraSlow ? 1.5 : 0, 0, 0, 'magic', game);
      if (!other.alive) justKilled.push(other);
    }
  }
  for (let i = 0; i < 10; i++) {
    game.spawnParticle(origin.x, origin.y, {
      color: '#80d8ff', size: 3 + Math.random() * 4,
      vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160,
      life: 0.4, gravity: 0
    });
  }
  game.spawnParticle(origin.x, origin.y - 15, {
    text: '❄️ 冰爆！', color: '#00e5ff', fontSize: 12, vx: 0, vy: -35, life: 0.8, gravity: 0
  });
  if (chainsLeft > 0) {
    for (const dead of justKilled) {
      triggerIceShatterExplosion(dead, game, cfg, chainsLeft - 1);
    }
  }
}

const TALENT_SCHOOLS = {
  ice: {
    branches: {
      ice_pierce: {
        name: '強化貫穿',
        icon: '❄️',
        levels: [
          {
            desc: '冰晶塔穿透數量 +1 體，減速強度再提升 8%',
            apply: () => {
              TOWER_DATA.ice_crystal.levels.forEach(lvl => {
                lvl.piercing = (lvl.piercing || 3) + 1;
                lvl.slowFactor = Math.max(0.08, (lvl.slowFactor || 0.5) * 0.92);
              });
            }
          },
          {
            desc: '穿透數量再 +1 體，減速強度再提升 8%',
            apply: () => {
              TOWER_DATA.ice_crystal.levels.forEach(lvl => {
                lvl.piercing = (lvl.piercing || 3) + 1;
                lvl.slowFactor = Math.max(0.08, (lvl.slowFactor || 0.5) * 0.92);
              });
            }
          },
          {
            desc: '穿透數量 +2 體，減速強度再提升 10%',
            apply: () => {
              TOWER_DATA.ice_crystal.levels.forEach(lvl => {
                lvl.piercing = (lvl.piercing || 3) + 2;
                lvl.slowFactor = Math.max(0.05, (lvl.slowFactor || 0.5) * 0.9);
              });
            }
          },
        ]
      },
      ice_shatter: {
        name: '強化冰爆',
        icon: '💠',
        levels: [
          { desc: '解鎖冰爆：擊殺緩速目標時，55px 範圍造成 20% 最大血量傷害（最高 250 點）' },
          { desc: '冰爆範圍擴至 70px，爆炸傷害提升至 27% 最大血量（最高 250 點）' },
          { desc: '冰爆範圍 85px，傷害 34% 最大血量（最高 250 點）且附加 1.5 秒緩速' },
        ],
        onKill: (enemy, game, level) => {
          if (!game) return;
          const hasAbsoluteZero = typeof relicManager !== 'undefined' && relicManager.hasHidden('absolute_zero');
          if (!(enemy.slowTimer > 0) && !hasAbsoluteZero) return;
          const cfg = [null, { radius: 55, pct: 0.20 }, { radius: 70, pct: 0.27 }, { radius: 85, pct: 0.34, extraSlow: true }][level];
          if (!cfg) return;
          triggerIceShatterExplosion(enemy, game, cfg, hasAbsoluteZero ? 5 : 0);
        }
      },
      ice_aura: {
        name: '極地霜環',
        icon: '🌨️',
        levels: [
          {
            desc: '冰晶塔周圍 100px 散發霜環，踏入者跑速降低 15%',
            onHitTarget: (proj, target, game) => {
              // passive aura tick handled or on hit slow booster
            }
          },
          {
            desc: '霜寒光環擴至 125px，跑速 -25%，受魔傷 +15%',
          },
          {
            desc: '霜寒光環擴至 150px，跑速 -35%，受魔傷 +30%',
          },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          if (damageType === 'magic' && target && target.slowTimer > 0) {
            const mults = [1, 1.15, 1.15, 1.30];
            return rawDmg * (mults[level] || 1);
          }
          return rawDmg;
        }
      }
    },
    hidden: [
      {
        id: 'absolute_zero',
        name: '絕對凍土',
        icon: '🧊',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】冰晶塔任何命中皆觸發冰爆，被炸死敵人連鎖引爆，最多連鎖 5 次。',
        requires: { ice_pierce: 3, ice_shatter: 2, ice_aura: 1 },
      }
    ]
  },
  poison: {
    branches: {
      toxin_potency: {
        name: '強化猛毒',
        icon: '🧪',
        levels: [
          {
            desc: '毒傷 +15%，持續時間 +1 秒',
            apply: () => {
              TOWER_DATA.mushroom.levels.forEach(lvl => {
                lvl.poisonDps = Math.round((lvl.poisonDps || 18) * 1.15);
                lvl.poisonDuration = (lvl.poisonDuration || 4) + 1;
              });
            }
          },
          {
            desc: '毒傷再 +15%，持續時間再 +1 秒',
            apply: () => {
              TOWER_DATA.mushroom.levels.forEach(lvl => {
                lvl.poisonDps = Math.round((lvl.poisonDps || 18) * 1.15);
                lvl.poisonDuration = (lvl.poisonDuration || 4) + 1;
              });
            }
          },
          {
            desc: '毒傷再 +20%，持續時間再 +1 秒',
            apply: () => {
              TOWER_DATA.mushroom.levels.forEach(lvl => {
                lvl.poisonDps = Math.round((lvl.poisonDps || 18) * 1.20);
                lvl.poisonDuration = (lvl.poisonDuration || 4) + 1;
              });
            }
          },
        ]
      },
      toxin_spread: {
        name: '強化擴散',
        icon: '☠️',
        levels: [
          { desc: '解鎖擴散：中毒死亡時，60px 內感染 70% 毒素' },
          { desc: '擴散半徑 75px，感染強度提升至 100%' },
          { desc: '擴散半徑 95px，感染 100% 且具備無限連鎖傳染' },
        ],
        onKill: (enemy, game, level) => {
          if (!(enemy.poisonTimer > 0) || !game) return;
          const cfg = [null, { radius: 60, ratio: 0.7 }, { radius: 75, ratio: 1.0 }, { radius: 95, ratio: 1.0 }][level];
          if (!cfg) return;
          const isPlague = typeof relicManager !== 'undefined' && relicManager.hasHidden('lethal_plague');
          for (const other of game.enemies) {
            if (!other.alive || other === enemy) continue;
            if (isPlague || dist(enemy.x, enemy.y, other.x, other.y) <= cfg.radius) {
              other.poisonDps = Math.max(other.poisonDps || 0, (enemy.poisonDps || 20) * cfg.ratio);
              other.poisonTimer = Math.max(other.poisonTimer || 0, 4.0);
            }
          }
          game.spawnParticle(enemy.x, enemy.y - 15, {
            text: isPlague ? '☠️ 瘟疫全場擴散！' : '☠️ 毒素擴散！', color: '#76ff03', fontSize: 12, vx: 0, vy: -35, life: 0.8, gravity: 0
          });
        }
      },
      toxin_corrosion: {
        name: '腐蝕溶甲',
        icon: '⚗️',
        levels: [
          {
            desc: '中毒敵人護甲遭受腐蝕：受到的所有物理與魔法傷害 +15%',
          },
          {
            desc: '受傷加深提升至 +25%，且毒傷跳傷害頻率加快 30%',
          },
          {
            desc: '受傷加深提升至 +40%，且中毒期間敵人移動速度額外降低 20%',
          },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          if (target && target.poisonTimer > 0) {
            const mults = [1, 1.15, 1.25, 1.40];
            return rawDmg * (mults[level] || 1);
          }
          return rawDmg;
        }
      }
    },
    hidden: [
      {
        id: 'lethal_plague',
        name: '絕命疫爆',
        icon: '💀',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】疫病擴散無距離限制，全場傳染；且殘血 12% 敵人直接被毒素斬殺（首領免疫直接斬殺，改為承受 1.5 倍加深毒傷）。',
        requires: { toxin_potency: 2, toxin_spread: 2, toxin_corrosion: 1 },
        modifyDamage: (rawDmg, damageType, attacker, target, game) => {
          if (target && target.poisonTimer > 0 && target.hp > 0 && target.hp <= target.maxHp * 0.12) {
            if (target.isBoss) {
              return rawDmg * 1.5; // 首領免疫直接斬殺秒殺，轉化為 1.5 倍毒傷加深
            }
            return target.hp + 1; // 普通怪直接斬殺
          }
          return rawDmg;
        }
      }
    ]
  },
  chain: {
    branches: {
      chain_reach: {
        name: '強化連鎖',
        icon: '⚡',
        levels: [
          {
            desc: '彈射次數 +1 次，彈射範圍 +12%',
            apply: () => {
              TOWER_DATA.lavender.levels.forEach(lvl => {
                lvl.chainCount = (lvl.chainCount || 3) + 1;
                lvl.chainRange = Math.round((lvl.chainRange || 90) * 1.12);
              });
            }
          },
          {
            desc: '彈射次數再 +1 次，彈射範圍再 +12%',
            apply: () => {
              TOWER_DATA.lavender.levels.forEach(lvl => {
                lvl.chainCount = (lvl.chainCount || 3) + 1;
                lvl.chainRange = Math.round((lvl.chainRange || 90) * 1.12);
              });
            }
          },
          {
            desc: '彈射次數再 +1 次，彈射範圍再 +13%',
            apply: () => {
              TOWER_DATA.lavender.levels.forEach(lvl => {
                lvl.chainCount = (lvl.chainCount || 3) + 1;
                lvl.chainRange = Math.round((lvl.chainRange || 90) * 1.13);
              });
            }
          },
        ]
      },
      crit_strike: {
        name: '強化暴擊',
        icon: '💥',
        levels: [
          { desc: '解鎖暴擊：所有植物塔 10% 機率造成 1.8 倍暴擊傷害' },
          { desc: '暴擊機率提升至 15%，倍率提升至 2.0 倍' },
          { desc: '暴擊機率提升至 20%，倍率提升至 2.4 倍' },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          const cfg = [null, { chance: 0.10, mult: 1.8 }, { chance: 0.15, mult: 2.0 }, { chance: 0.20, mult: 2.4 }][level];
          if (!cfg || Math.random() >= cfg.chance) return rawDmg;
          if (game && target) {
            game.spawnParticle(target.x, target.y - 12, {
              text: '💥 CRIT!', color: '#ffd700', fontSize: 13, vx: 0, vy: -40, life: 0.6, gravity: 0
            });
          }
          return rawDmg * cfg.mult;
        }
      },
      electromagnetic_field: {
        name: '電磁感應',
        icon: '🧲',
        levels: [
          {
            desc: '電弧每次命中，使敵人陷入 1.5 秒感電（受魔傷 +15%）',
          },
          {
            desc: '感電增傷 +25%，彈射衰減由 20% 減半為 10%',
          },
          {
            desc: '感電增傷 +40%，且彈射傷害不再衰減（每擊 100%）',
          },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          if (damageType === 'magic' && attacker && attacker.towerType === 'lavender') {
            const boosts = [1, 1.15, 1.25, 1.40];
            return rawDmg * (boosts[level] || 1);
          }
          return rawDmg;
        }
      }
    },
    hidden: [
      {
        id: 'thunder_overload',
        name: '雷霆過載',
        icon: '🌩️',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】電弧每次彈射獨立判定暴擊，且全額無衰減，連鎖越多暴擊越強。',
        requires: { chain_reach: 2, crit_strike: 1, electromagnetic_field: 2 },
      }
    ]
  },
  economy: {
    branches: {
      gold_boost: {
        name: '強化產金',
        icon: '🌻',
        levels: [
          {
            desc: '向日葵產金 +20%，每波結束額外 +40 金幣',
            apply: () => {
              TOWER_DATA.sunflower.levels.forEach(lvl => {
                lvl.goldPerSecond = Math.round((lvl.goldPerSecond || 10) * 1.2);
              });
            }
          },
          {
            desc: '向日葵產金再 +20%，每波結束額外再 +40 金幣',
            apply: () => {
              TOWER_DATA.sunflower.levels.forEach(lvl => {
                lvl.goldPerSecond = Math.round((lvl.goldPerSecond || 10) * 1.2);
              });
            }
          },
          {
            desc: '向日葵產金再 +25%，每波結束額外再 +40 金幣',
            apply: () => {
              TOWER_DATA.sunflower.levels.forEach(lvl => {
                lvl.goldPerSecond = Math.round((lvl.goldPerSecond || 10) * 1.25);
              });
            }
          },
        ],
        onWaveEnd: (wave, game, level) => {
          const bonus = [0, 40, 80, 120][level];
          if (game && bonus) {
            game.addGold(bonus);
            game.showToast(`🌻 陽光賜福：+${bonus} 金幣！`);
          }
        }
      },
      tower_growth: {
        name: '強化生長',
        icon: '🍃',
        levels: [
          {
            desc: '所有植物塔射速 +7%，射程 +5%',
            apply: () => {
              Object.values(TOWER_DATA).forEach(tower => {
                if (!tower.levels) return;
                tower.levels.forEach(lvl => {
                  if (lvl.fireRate) lvl.fireRate = Number((lvl.fireRate * 1.07).toFixed(2));
                  if (lvl.range) lvl.range = Math.round(lvl.range * 1.05);
                });
              });
            }
          },
          {
            desc: '射速再 +7%，射程再 +5%',
            apply: () => {
              Object.values(TOWER_DATA).forEach(tower => {
                if (!tower.levels) return;
                tower.levels.forEach(lvl => {
                  if (lvl.fireRate) lvl.fireRate = Number((lvl.fireRate * 1.07).toFixed(2));
                  if (lvl.range) lvl.range = Math.round(lvl.range * 1.05);
                });
              });
            }
          },
          {
            desc: '射速再 +8%，射程再 +5%',
            apply: () => {
              Object.values(TOWER_DATA).forEach(tower => {
                if (!tower.levels) return;
                tower.levels.forEach(lvl => {
                  if (lvl.fireRate) lvl.fireRate = Number((lvl.fireRate * 1.08).toFixed(2));
                  if (lvl.range) lvl.range = Math.round(lvl.range * 1.05);
                });
              });
            }
          },
        ]
      },
      gold_interest: {
        name: '利滾利息',
        icon: '🪙',
        levels: [
          {
            desc: '每波結束時，依現有金幣獲得 4% 利息獎勵（上限 +60 金幣）',
            onWaveEnd: (wave, game) => {
              if (!game) return;
              const interest = Math.min(60, Math.floor(game.gold * 0.04));
              if (interest > 0) {
                game.addGold(interest);
                game.showToast(`🪙 銀行利息：+${interest} 金幣！`);
              }
            }
          },
          {
            desc: '利息比率提升至 7%（上限 +120 金幣）',
            onWaveEnd: (wave, game) => {
              if (!game) return;
              const interest = Math.min(120, Math.floor(game.gold * 0.07));
              if (interest > 0) {
                game.addGold(interest);
                game.showToast(`🪙 銀行利息：+${interest} 金幣！`);
              }
            }
          },
          {
            desc: '利息提升至 10%（上限 +200 💰），全塔升級費 -15%',
            apply: () => {
              Object.values(TOWER_DATA).forEach(tower => {
                if (!tower.levels) return;
                tower.levels.forEach(lvl => {
                  if (lvl.upgradeCost) lvl.upgradeCost = Math.round(lvl.upgradeCost * 0.85);
                });
              });
            },
            onWaveEnd: (wave, game) => {
              if (!game) return;
              const interest = Math.min(200, Math.floor(game.gold * 0.10));
              if (interest > 0) {
                game.addGold(interest);
                game.showToast(`🪙 銀行利息：+${interest} 金幣！`);
              }
            }
          },
        ]
      }
    },
    hidden: [
      {
        id: 'bountiful_blessing',
        name: '豐饒祝福',
        icon: '💖',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】全場擊殺額外獲得 50% 金幣，每波結束基地自動回復 1 點生命。',
        requires: { gold_boost: 1, tower_growth: 2, gold_interest: 2 },
        onKill: (enemy, game) => {
          if (!game || !enemy.reward) return;
          const bonus = Math.ceil(enemy.reward * 0.5);
          game.addGold(bonus);
        },
        onWaveEnd: (wave, game) => {
          if (!game) return;
          if (game.lives < getStartingLives()) {
            game.lives = Math.min(getStartingLives(), game.lives + 1);
            game.updateUI();
            game.showToast('💖 豐饒祝福：回復 1 ❤️');
          }
        }
      },
      {
        id: 'solar_wrath',
        name: '日輪天罰・金耀天劫',
        icon: '☀️',
        rarity: 'legendary',
        weight: 25,
        desc: '【專屬技能】戰鬥中消耗 10% 現有金幣，召喚全屏日冕金光造成等額真實傷害！',
        requires: { gold_boost: 3, laser_overcharge: 2, cannon_blast: 2 },
        apply: (game) => {
          if (game && game.updateSkillBarLockState) {
            game.updateSkillBarLockState();
            game.showToast('☀️ 究極技能【日輪天罰】已覺醒！');
          }
        }
      }
    ]
  },
  petal: {
    branches: {
      petal_speed: {
        name: '風馳箭雨',
        icon: '🌸',
        levels: [
          {
            desc: '粉櫻箭射速 +20%，射程 +10%',
            apply: () => {
              TOWER_DATA.petal.levels.forEach(lvl => {
                lvl.fireRate = Number((lvl.fireRate * 1.20).toFixed(2));
                lvl.range = Math.round(lvl.range * 1.10);
              });
            }
          },
          {
            desc: '粉櫻箭射速再 +25%，射程再 +10%',
            apply: () => {
              TOWER_DATA.petal.levels.forEach(lvl => {
                lvl.fireRate = Number((lvl.fireRate * 1.25).toFixed(2));
                lvl.range = Math.round(lvl.range * 1.10);
              });
            }
          },
          {
            desc: '粉櫻箭射速再 +30%，射程再 +15%',
            apply: () => {
              TOWER_DATA.petal.levels.forEach(lvl => {
                lvl.fireRate = Number((lvl.fireRate * 1.30).toFixed(2));
                lvl.range = Math.round(lvl.range * 1.15);
              });
            }
          },
        ]
      },
      petal_pierce_armor: {
        name: '穿甲重矢',
        icon: '🏹',
        levels: [
          {
            desc: '粉櫻箭傷害 +25%，無視敵人 30% 物理抗性',
            apply: () => {
              TOWER_DATA.petal.levels.forEach(lvl => {
                lvl.damage = Math.round(lvl.damage * 1.25);
              });
            }
          },
          {
            desc: '粉櫻箭傷害再 +25%，無視敵人 60% 物理抗性',
            apply: () => {
              TOWER_DATA.petal.levels.forEach(lvl => {
                lvl.damage = Math.round(lvl.damage * 1.25);
              });
            }
          },
          {
            desc: '粉櫻箭傷害 +35%，無視 100% 物理抗性（全額真傷）',
            apply: () => {
              TOWER_DATA.petal.levels.forEach(lvl => {
                lvl.damage = Math.round(lvl.damage * 1.35);
              });
            }
          },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          if (damageType === 'physical' && attacker && attacker.towerType === 'petal' && target && target.resist && target.resist.physical) {
            const ignoreRatios = [0, 0.3, 0.6, 1.0];
            const ratio = ignoreRatios[level] || 0;
            const originalResist = target.resist.physical;
            const effectiveResist = originalResist * (1 - ratio);
            const factor = (1 - effectiveResist) / Math.max(0.01, 1 - originalResist);
            return rawDmg * factor;
          }
          return rawDmg;
        }
      },
      petal_multishot: {
        name: '多重齊射',
        icon: '🪶',
        levels: [
          {
            desc: '粉櫻塔攻擊有 25% 機率額外發射 1 枚散射花箭',
          },
          {
            desc: '多重箭機率提升至 45%，且散射箭傷害提升至 80%',
          },
          {
            desc: '多重箭機率提升至 70%，且每次散射 2 枚全額花箭',
          },
        ],
        onHitTarget: (proj, target, game, level) => {
          if (proj.towerType !== 'petal' || !game || !game.enemies) return;
          const cfgs = [null, { chance: 0.25, count: 1, ratio: 0.6 }, { chance: 0.45, count: 1, ratio: 0.8 }, { chance: 0.70, count: 2, ratio: 1.0 }][level];
          if (!cfgs || Math.random() >= cfgs.chance) return;
          let shot = 0;
          for (const other of game.enemies) {
            if (!other.alive || other === target) continue;
            if (dist(target.x, target.y, other.x, other.y) <= 100) {
              other.takeDamage(proj.damage * cfgs.ratio, null, 0, 0, 0, 'physical', game);
              game.spawnParticle(other.x, other.y, {
                color: '#ff4081', size: 3, vx: (Math.random() - 0.5) * 70, vy: (Math.random() - 0.5) * 70, life: 0.3, gravity: 0
              });
              shot++;
              if (shot >= cfgs.count) break;
            }
          }
        }
      }
    },
    hidden: [
      {
        id: 'petal_blossom_storm',
        name: '萬花齊放',
        icon: '🌺',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】擊中炸裂 3 枚追蹤花瓣，自動追擊周遭造成 60% 傷害。',
        requires: { petal_speed: 2, petal_pierce_armor: 2, petal_multishot: 1 },
        onHitTarget: (proj, target, game) => {
          if (proj.towerType !== 'petal' || !game || !game.enemies) return;
          let count = 0;
          for (const other of game.enemies) {
            if (!other.alive || other === target) continue;
            if (dist(target.x, target.y, other.x, other.y) <= 120) {
              other.takeDamage(proj.damage * 0.6, null, 0, 0, 0, 'physical', game);
              game.spawnParticle(other.x, other.y, {
                color: '#ff80ab', size: 3, vx: (Math.random() - 0.5) * 80, vy: (Math.random() - 0.5) * 80, life: 0.35, gravity: 0
              });
              count++;
              if (count >= 3) break;
            }
          }
        }
      }
    ]
  },
  cannon: {
    branches: {
      cannon_blast: {
        name: '核能彈頭',
        icon: '💣',
        levels: [
          {
            desc: '熔岩巨砲爆炸半徑 +20px，基礎傷害 +20%',
            apply: () => {
              TOWER_DATA.cannon.levels.forEach(lvl => {
                lvl.splashRadius = (lvl.splashRadius || 70) + 20;
                lvl.damage = Math.round(lvl.damage * 1.20);
              });
            }
          },
          {
            desc: '爆炸半徑再 +20px，基礎傷害再 +25%',
            apply: () => {
              TOWER_DATA.cannon.levels.forEach(lvl => {
                lvl.splashRadius = (lvl.splashRadius || 70) + 20;
                lvl.damage = Math.round(lvl.damage * 1.25);
              });
            }
          },
          {
            desc: '爆炸半徑 +25px，傷害 +30%，中心 40px 雙倍傷害',
            apply: () => {
              TOWER_DATA.cannon.levels.forEach(lvl => {
                lvl.splashRadius = (lvl.splashRadius || 70) + 25;
                lvl.damage = Math.round(lvl.damage * 1.30);
              });
            }
          },
        ]
      },
      cannon_scorched_earth: {
        name: '焦土餘燼',
        icon: '🔥',
        levels: [
          { desc: '解鎖焦土：地面留下 2.5 秒焦土，每秒受到 30 點燃燒傷害' },
          { desc: '焦土持續時間提升至 4.0 秒，燃燒傷害提升至 55/秒' },
          { desc: '焦土持續 5.5 秒，燃燒 85/秒且降低敵人 25% 跑速' },
        ],
        onHitTarget: (proj, target, game, level) => {
          if (proj.towerType !== 'cannon' || !game) return;
          const cfgs = [null, { duration: 2.5, dps: 30, slow: null }, { duration: 4.0, dps: 55, slow: null }, { duration: 5.5, dps: 85, slow: 0.75 }];
          const cfg = cfgs[level];
          if (!cfg) return;
          const px = target ? target.x : proj.x;
          const py = target ? target.y : proj.y;
          const radius = proj.splashRadius || 80;
          for (const other of game.enemies) {
            if (!other.alive) continue;
            if (dist(px, py, other.x, other.y) <= radius) {
              other.poisonDps = Math.max(other.poisonDps || 0, cfg.dps);
              other.poisonTimer = Math.max(other.poisonTimer || 0, cfg.duration);
              if (cfg.slow && (other.slowTimer <= 0 || cfg.slow <= other.slowFactor)) {
                other.slowFactor = cfg.slow;
                other.slowTimer = cfg.duration;
              }
            }
          }
          game.spawnParticle(px, py - 15, {
            text: '🔥 焦土燃燒！', color: '#ff3d00', fontSize: 12, vx: 0, vy: -30, life: 0.8, gravity: 0
          });
        }
      },
      cannon_cluster_shrapnel: {
        name: '集束彈片',
        icon: '💥',
        levels: [
          {
            desc: '爆炸噴射 4 枚高溫彈片，對 70px 隨機敵人造成 35 點傷害',
          },
          {
            desc: '彈片數量提升至 6 枚，每枚傷害提升至 60 點',
          },
          {
            desc: '彈片提升至 8 枚，每枚傷害 95 點且附帶微震擊退',
          },
        ],
        onHitTarget: (proj, target, game, level) => {
          if (proj.towerType !== 'cannon' || !game || !game.enemies) return;
          const cfgs = [null, { count: 4, dmg: 35 }, { count: 6, dmg: 60 }, { count: 8, dmg: 95 }][level];
          if (!cfgs) return;
          const px = target ? target.x : proj.x;
          const py = target ? target.y : proj.y;
          let hit = 0;
          for (const other of game.enemies) {
            if (!other.alive) continue;
            if (dist(px, py, other.x, other.y) <= 85) {
              other.takeDamage(cfgs.dmg, null, 0, 0, 0, 'physical', game);
              game.spawnParticle(other.x, other.y, {
                color: '#ffab00', size: 3, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 120, life: 0.35, gravity: 0
              });
              hit++;
              if (hit >= cfgs.count) break;
            }
          }
        }
      }
    },
    hidden: [
      {
        id: 'orbital_cannon',
        name: '天基毀滅砲',
        icon: '🌋',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】巨砲第 4 發升級天基天火，全場 180px 造成 3 倍真傷。',
        requires: { cannon_blast: 2, cannon_scorched_earth: 2, cannon_cluster_shrapnel: 1 },
        modifyDamage: (rawDmg, damageType, attacker, target, game) => {
          if (attacker && attacker.towerType === 'cannon') {
            attacker._orbitalCounter = (attacker._orbitalCounter || 0) + 1;
            if (attacker._orbitalCounter % 4 === 0) {
              if (game && target) {
                game.spawnParticle(target.x, target.y - 25, {
                  text: '🌋 天基毀滅！3X TRUE DMG', color: '#ff1744', fontSize: 14, vx: 0, vy: -50, life: 1.0, gravity: 0
                });
              }
              return rawDmg * 3.0;
            }
          }
          return rawDmg;
        }
      }
    ]
  },
  treant: {
    branches: {
      treant_entangle: {
        name: '森之纏繞',
        icon: '🌿',
        levels: [
          {
            desc: '古木定身減速強度提升至 75%，持續時間 +1.0 秒',
            apply: () => {
              TOWER_DATA.treant.levels.forEach(lvl => {
                lvl.slowFactor = Math.max(0.1, (lvl.slowFactor || 0.35) * 0.75);
                lvl.slowDuration = (lvl.slowDuration || 2.5) + 1.0;
              });
            }
          },
          {
            desc: '古木定身減速強度提升至 85%，持續時間再 +1.0 秒',
            apply: () => {
              TOWER_DATA.treant.levels.forEach(lvl => {
                lvl.slowFactor = Math.max(0.08, (lvl.slowFactor || 0.35) * 0.65);
                lvl.slowDuration = (lvl.slowDuration || 2.5) + 1.0;
              });
            }
          },
          {
            desc: '古木定身強度提升至 95%，持續時間再 +1.5 秒',
            apply: () => {
              TOWER_DATA.treant.levels.forEach(lvl => {
                lvl.slowFactor = 0.05;
                lvl.slowDuration = (lvl.slowDuration || 2.5) + 1.5;
              });
            }
          },
        ]
      },
      treant_thorns: {
        name: '荊棘倒刺',
        icon: '🌵',
        levels: [
          {
            desc: '處於古木定身/緩速狀態下的敵人，受傷加深 +20%',
          },
          {
            desc: '定身受傷加深 +35%，且古木攻擊附帶 50px 劇烈震裂波',
          },
          {
            desc: '定身受傷加深 +50%，每定身 1 秒承受 100% 攻擊力真傷',
          },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          if (target && target.slowTimer > 0) {
            const mults = [1, 1.20, 1.35, 1.50];
            return rawDmg * (mults[level] || 1);
          }
          return rawDmg;
        }
      },
      treant_earthquake: {
        name: '大地震撼',
        icon: '🪨',
        levels: [
          {
            desc: '古木牢籠攻擊範圍 +15px，擊中震飛 60px 敵人並打斷衝刺',
            apply: () => {
              TOWER_DATA.treant.levels.forEach(lvl => {
                lvl.range = Math.round(lvl.range * 1.15);
              });
            }
          },
          {
            desc: '攻擊範圍再 +20px，震裂波傷害 100% 且附加 1 秒眩暈',
            apply: () => {
              TOWER_DATA.treant.levels.forEach(lvl => {
                lvl.range = Math.round(lvl.range * 1.15);
              });
            }
          },
          {
            desc: '大地震波擴及全圖 100px，全場怪物短暫停滯 1.2 秒',
            apply: () => {
              TOWER_DATA.treant.levels.forEach(lvl => {
                lvl.range = Math.round(lvl.range * 1.20);
              });
            }
          },
        ]
      }
    },
    hidden: [
      {
        id: 'ancient_guardian',
        name: '遠古守護者',
        icon: '🌲',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】古木圖騰：周圍 130px 所有塔攻擊 +35%、射速 +20%。',
        requires: { treant_entangle: 2, treant_thorns: 2, treant_earthquake: 1 },
        apply: (game) => {
          Object.values(TOWER_DATA).forEach(tower => {
            if (!tower.levels) return;
            tower.levels.forEach(lvl => {
              if (lvl.damage) lvl.damage = Math.round(lvl.damage * 1.35);
              if (lvl.fireRate) lvl.fireRate = Number((lvl.fireRate * 1.20).toFixed(2));
            });
          });
        }
      }
    ]
  },
  laser: {
    branches: {
      laser_overcharge: {
        name: '超導聚能',
        icon: '✨',
        levels: [
          {
            desc: '日光雷射射速 +15%，貫穿敵人數量 +1 體',
            apply: () => {
              TOWER_DATA.laser.levels.forEach(lvl => {
                lvl.fireRate = Number((lvl.fireRate * 1.15).toFixed(2));
                lvl.piercing = (lvl.piercing || 2) + 1;
              });
            }
          },
          {
            desc: '射速再 +20%，貫穿數量再 +1 體',
            apply: () => {
              TOWER_DATA.laser.levels.forEach(lvl => {
                lvl.fireRate = Number((lvl.fireRate * 1.20).toFixed(2));
                lvl.piercing = (lvl.piercing || 2) + 1;
              });
            }
          },
          {
            desc: '射速再 +25%，貫穿數量再 +2 體，且穿透傷害不再遞減衰減',
            apply: () => {
              TOWER_DATA.laser.levels.forEach(lvl => {
                lvl.fireRate = Number((lvl.fireRate * 1.25).toFixed(2));
                lvl.piercing = (lvl.piercing || 2) + 2;
              });
            }
          },
        ]
      },
      laser_refract: {
        name: '光束折射',
        icon: '💎',
        levels: [
          { desc: '雷射穿透敵人後，30% 機率折射副光束（50% 傷害）打擊鄰近敵人' },
          { desc: '折射機率提升至 50%，副光束傷害提升至 75%' },
          { desc: '折射機率提升至 75%，副光束傷害 100%，並折射至 2 名敵人' },
        ],
        onHitTarget: (proj, target, game, level) => {
          if (proj.towerType !== 'laser' || !game || !game.enemies) return;
          const cfgs = [null, { chance: 0.3, ratio: 0.5, targets: 1 }, { chance: 0.5, ratio: 0.75, targets: 1 }, { chance: 0.75, ratio: 1.0, targets: 2 }][level];
          if (!cfgs || Math.random() >= cfgs.chance) return;
          let hit = 0;
          for (const other of game.enemies) {
            if (!other.alive || other === target || proj.piercedEnemies.has(other)) continue;
            if (dist(target.x, target.y, other.x, other.y) <= 100) {
              other.takeDamage(proj.damage * cfgs.ratio, null, 0, 0, 0, 'magic', game);
              game.spawnParticle(other.x, other.y, {
                color: '#ffd700', size: 3, vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100, life: 0.3, gravity: 0
              });
              hit++;
              if (hit >= cfgs.targets) break;
            }
          }
        }
      },
      laser_focus_beam: {
        name: '烈陽聚焦',
        icon: '🔬',
        levels: [
          {
            desc: '雷射持續打擊同一敵人時，每次增傷 15%（最多 3 層）',
          },
          {
            desc: '聚焦每層增傷 25%（最多 4 層），打擊 Boss 額外 +20%',
          },
          {
            desc: '聚焦每層增傷 35%（最多 5 層），打擊 Boss 額外 +40%',
          },
        ],
        modifyDamage: (rawDmg, damageType, attacker, target, game, level) => {
          if (attacker && attacker.towerType === 'laser') {
            const isBoss = target && target.isBoss;
            const bossBonus = isBoss ? [1, 1, 1.2, 1.4][level] : 1;
            const focusMult = [1, 1.15, 1.25, 1.35][level];
            return rawDmg * focusMult * bossBonus;
          }
          return rawDmg;
        }
      }
    },
    hidden: [
      {
        id: 'supernova_core',
        name: '超新星爆發',
        icon: '☀️',
        rarity: 'legendary',
        weight: 25,
        desc: '【質變】消滅敵人引發超新星核爆，90px 造成最大血量 25% 傷害（最高 350 點）。',
        requires: { laser_overcharge: 2, laser_refract: 2, laser_focus_beam: 1 },
        onKill: (enemy, game) => {
          if (!game || !game.enemies) return;
          for (const other of game.enemies) {
            if (!other.alive || other === enemy) continue;
            if (dist(enemy.x, enemy.y, other.x, other.y) <= 90) {
              let boomDmg = Math.max(30, Math.floor(enemy.maxHp * 0.25));
              // 百分比傷害保護上限：單次核爆對任何目標（小怪與首領）最高 350 點
              boomDmg = Math.min(boomDmg, 350);

              // 傷害歸屬：將超新星傷害精準計入「日光雷射塔」的傷害統計
              const laserTower = game.towers.find(t => t.typeKey === 'laser');
              if (laserTower) {
                laserTower.totalDamageDealt = (laserTower.totalDamageDealt || 0) + boomDmg;
              } else if (game.typeTotalDamage) {
                game.typeTotalDamage.laser = (game.typeTotalDamage.laser || 0) + boomDmg;
              }

              other.takeDamage(boomDmg, null, 0, 0, 0, 'magic', game);
            }
          }
          for (let i = 0; i < 12; i++) {
            game.spawnParticle(enemy.x, enemy.y, {
              color: '#ffd700', size: 3 + Math.random() * 4,
              vx: (Math.random() - 0.5) * 180, vy: (Math.random() - 0.5) * 180,
              life: 0.4, gravity: 0
            });
          }
          game.spawnParticle(enemy.x, enemy.y - 15, {
            text: '☀️ 超新星核爆！', color: '#ffea00', fontSize: 13, vx: 0, vy: -35, life: 0.8, gravity: 0
          });
        }
      }
    ]
  }
};

// 不分稀有度：Lv.1~3 跟隱藏合成天賦出現機率一律相同（權重都是 25），
// rarity 只留著給卡片視覺樣式用，不再影響抽卡機率
const BRANCH_LEVEL_META = [
  null,
  { rarity: 'common', weight: 25 },
  { rarity: 'rare', weight: 25 },
  { rarity: 'epic', weight: 25 },
];

class RelicManager {
  constructor() {
    this.branchLevels = {};
    this.hiddenAcquired = new Set();
    this.isEnabled = false;
  }

  reset(mode) {
    restoreTowerDataDefaults();
    this.branchLevels = {};
    this.hiddenAcquired = new Set();
    this.isEnabled = (mode === GAME_MODES.ROGUELIKE);
  }

  getBranchLevel(branchId) {
    return this.branchLevels[branchId] || 0;
  }

  hasHidden(id) {
    return this.hiddenAcquired.has(id);
  }

  hasAnyProgress() {
    return Object.keys(this.branchLevels).length > 0 || this.hiddenAcquired.size > 0;
  }

  acquireBranchLevel(schoolKey, branchId, game) {
    const branch = TALENT_SCHOOLS[schoolKey].branches[branchId];
    const nextLevel = this.getBranchLevel(branchId) + 1;
    const levelDef = branch.levels[nextLevel - 1];
    if (levelDef && levelDef.apply) levelDef.apply(game);
    this.branchLevels[branchId] = nextLevel;
  }

  acquireHidden(schoolKey, hiddenId, game) {
    const hidden = TALENT_SCHOOLS[schoolKey].hidden.find(h => h.id === hiddenId);
    if (hidden && hidden.apply) hidden.apply(game);
    this.hiddenAcquired.add(hiddenId);
  }

  modifyDamage(rawDmg, damageType, attacker, target, game) {
    if (!this.isEnabled) return rawDmg;
    let dmg = rawDmg;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = this.getBranchLevel(branchId);
        if (level > 0 && branch.modifyDamage) dmg = branch.modifyDamage(dmg, damageType, attacker, target, game, level);
      }
      for (const hidden of school.hidden) {
        if (this.hasHidden(hidden.id) && hidden.modifyDamage) dmg = hidden.modifyDamage(dmg, damageType, attacker, target, game);
      }
    }
    return dmg;
  }

  onHitTarget(projectile, target, game) {
    if (!this.isEnabled) return;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = this.getBranchLevel(branchId);
        if (level > 0 && branch.onHitTarget) branch.onHitTarget(projectile, target, game, level);
      }
      for (const hidden of school.hidden) {
        if (this.hasHidden(hidden.id) && hidden.onHitTarget) hidden.onHitTarget(projectile, target, game);
      }
    }
  }

  onKill(enemy, game) {
    if (!this.isEnabled) return;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = this.getBranchLevel(branchId);
        if (level > 0 && branch.onKill) branch.onKill(enemy, game, level);
      }
      for (const hidden of school.hidden) {
        if (this.hasHidden(hidden.id) && hidden.onKill) hidden.onKill(enemy, game);
      }
    }
  }

  onSunflowerPulse(sunflowerTower, game) {
    if (!this.isEnabled) return;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = this.getBranchLevel(branchId);
        if (level > 0 && branch.onSunflowerPulse) branch.onSunflowerPulse(sunflowerTower, game, level);
      }
      for (const hidden of school.hidden) {
        if (this.hasHidden(hidden.id) && hidden.onSunflowerPulse) hidden.onSunflowerPulse(sunflowerTower, game);
      }
    }
  }

  onWaveStart(wave, game) {
    if (!this.isEnabled) return;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = this.getBranchLevel(branchId);
        if (level > 0 && branch.onWaveStart) branch.onWaveStart(wave, game, level);
      }
      for (const hidden of school.hidden) {
        if (this.hasHidden(hidden.id) && hidden.onWaveStart) hidden.onWaveStart(wave, game);
      }
    }
  }

  onWaveEnd(wave, game) {
    if (!this.isEnabled) return;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = this.getBranchLevel(branchId);
        if (level > 0 && branch.onWaveEnd) branch.onWaveEnd(wave, game, level);
      }
      for (const hidden of school.hidden) {
        if (this.hasHidden(hidden.id) && hidden.onWaveEnd) hidden.onWaveEnd(wave, game);
      }
    }
  }

  exportState() {
    return {
      branchLevels: { ...this.branchLevels },
      hiddenAcquired: Array.from(this.hiddenAcquired),
      isEnabled: this.isEnabled
    };
  }

  importState(state, game) {
    if (!state) return;
    this.reset(state.isEnabled ? GAME_MODES.ROGUELIKE : GAME_MODES.CAMPAIGN);
    this.branchLevels = { ...(state.branchLevels || {}) };
    this.hiddenAcquired = new Set(state.hiddenAcquired || []);
    this.isEnabled = !!state.isEnabled;

    // 重新應用被動效果 (apply)
    if (this.isEnabled) {
      for (const schoolKey in TALENT_SCHOOLS) {
        const school = TALENT_SCHOOLS[schoolKey];
        for (const branchId in school.branches) {
          const level = this.getBranchLevel(branchId);
          if (level > 0) {
            const branch = school.branches[branchId];
            for (let l = 0; l < level; l++) {
              const lvlDef = branch.levels[l];
              if (lvlDef && lvlDef.apply) lvlDef.apply(game);
            }
          }
        }
        for (const hidden of school.hidden) {
          if (this.hasHidden(hidden.id) && hidden.apply) {
            hidden.apply(game);
          }
        }
      }
    }
  }
}

const relicManager = new RelicManager();

function getTalentVisualInfo(schoolKey, branchId, hiddenId) {
  // 1. 單塔專用天賦（顯示該防禦塔圖示）
  if (schoolKey === 'ice') return { towerKey: 'ice_crystal' };
  if (schoolKey === 'mushroom' || schoolKey === 'poison') return { towerKey: 'mushroom' };
  if (schoolKey === 'thunder' || schoolKey === 'chain') return { towerKey: 'lavender' };
  if (schoolKey === 'petal') return { towerKey: 'petal' };
  if (schoolKey === 'cannon') return { towerKey: 'cannon' };
  if (schoolKey === 'treant') return { towerKey: 'treant' };
  if (schoolKey === 'laser') return { towerKey: 'laser' };

  // 2. 經濟流派（向日葵專用 vs 全域自然/金幣/天罰天賦）
  if (schoolKey === 'economy') {
    if (branchId === 'gold_boost') return { towerKey: 'sunflower' };
    if (branchId === 'tower_growth') return { specialIconKey: 'nature_growth' };
    if (branchId === 'gold_interest') return { specialIconKey: 'gold_interest' };
    if (hiddenId === 'bountiful_blessing') return { specialIconKey: 'bountiful_blessing' };
    if (hiddenId === 'solar_wrath') return { specialIconKey: 'solar_wrath' };
    return { towerKey: 'sunflower' };
  }

  return {};
}

// 把 TALENT_SCHOOLS 展開成當下可抽的候選清單：每條分支只會出現「下一等級」那一張，
// 滿 Lv.3 就不再出現；隱藏合成天賦要兩條指定分支都到達門檻等級、且尚未取得才會出現。
// 【核心規則】若為某個防禦塔專屬天賦，只會出現玩家「建造清單中已解鎖/擁有」的防禦塔天賦！
function buildTalentCandidates() {
  const candidates = [];
  for (const schoolKey in TALENT_SCHOOLS) {
    const school = TALENT_SCHOOLS[schoolKey];
    for (const branchId in school.branches) {
      const branch = school.branches[branchId];
      const currentLevel = relicManager.getBranchLevel(branchId);
      if (currentLevel >= branch.levels.length) continue;
      const nextLevel = currentLevel + 1;
      const meta = BRANCH_LEVEL_META[nextLevel];
      const visual = getTalentVisualInfo(schoolKey, branchId, null);

      // 【建造清單擁有過濾】若為某座防禦塔專屬天賦，但玩家建造清單中尚未解鎖該塔，則絕對不出現！
      if (visual.towerKey) {
        const towerKey = (visual.towerKey === 'ice') ? 'ice_crystal' : visual.towerKey;
        if (typeof isTowerUnlocked === 'function') {
          if (!isTowerUnlocked(towerKey) && !isTowerUnlocked(visual.towerKey)) {
            continue; // 建造清單沒有這個塔，跳過
          }
        }
      }

      candidates.push({
        id: `${branchId}_lv${nextLevel}`,
        kind: 'branch',
        schoolKey,
        branchId,
        targetLevel: nextLevel,
        name: `${branch.name} Lv.${nextLevel}`,
        desc: branch.levels[nextLevel - 1].desc,
        icon: branch.icon,
        rarity: meta.rarity,
        weight: meta.weight,
        towerKey: visual.towerKey,
        specialIconKey: visual.specialIconKey,
      });
    }
    for (const hidden of school.hidden) {
      if (relicManager.hasHidden(hidden.id)) continue;
      const meetsRequirement = Object.entries(hidden.requires).every(
        ([branchId, minLevel]) => relicManager.getBranchLevel(branchId) >= minLevel
      );
      if (!meetsRequirement) continue;
      const visual = getTalentVisualInfo(schoolKey, null, hidden.id);

      // 隱藏質變天賦同樣檢查建造清單解鎖
      if (visual.towerKey) {
        const towerKey = (visual.towerKey === 'ice') ? 'ice_crystal' : visual.towerKey;
        if (typeof isTowerUnlocked === 'function') {
          if (!isTowerUnlocked(towerKey) && !isTowerUnlocked(visual.towerKey)) {
            continue;
          }
        }
      }

      candidates.push({
        id: hidden.id,
        kind: 'hidden',
        schoolKey,
        hiddenId: hidden.id,
        name: hidden.name,
        desc: hidden.desc,
        icon: hidden.icon,
        rarity: hidden.rarity,
        weight: hidden.weight,
        towerKey: visual.towerKey,
        specialIconKey: visual.specialIconKey,
      });
    }
  }
  return candidates;
}

function drawRandomTalents(count = 3) {
  let pool = buildTalentCandidates();
  
  // 若因當前可用卡片不足 count 張，則放寬所有未滿級分支補充，保證有選項可抽
  if (pool.length < count) {
    const allPool = [];
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const nextLevel = relicManager.getBranchLevel(branchId) + 1;
        if (nextLevel <= branch.levels.length) {
          const meta = BRANCH_LEVEL_META[nextLevel];
          const visual = getTalentVisualInfo(schoolKey, branchId, null);
          allPool.push({
            id: `${branchId}_lv${nextLevel}`,
            kind: 'branch',
            schoolKey,
            branchId,
            targetLevel: nextLevel,
            name: `${branch.name} Lv.${nextLevel}`,
            desc: branch.levels[nextLevel - 1].desc,
            icon: branch.icon,
            rarity: meta.rarity,
            weight: meta.weight,
            towerKey: visual.towerKey,
            specialIconKey: visual.specialIconKey,
          });
        }
      }
    }
    for (const item of allPool) {
      if (!pool.some(t => t.id === item.id)) {
        pool.push(item);
        if (pool.length >= count) break;
      }
    }
  }

  const poolCopy = [...pool];
  const picked = [];
  const targetCount = Math.min(count, poolCopy.length);

  for (let step = 0; step < targetCount; step++) {
    const totalWeight = poolCopy.reduce((sum, t) => sum + (t.weight || 25), 0);
    if (totalWeight <= 0) {
      picked.push(poolCopy.shift());
      continue;
    }
    let rand = Math.random() * totalWeight;
    let chosenIdx = poolCopy.length - 1;
    for (let j = 0; j < poolCopy.length; j++) {
      rand -= (poolCopy[j].weight || 25);
      if (rand <= 0) {
        chosenIdx = j;
        break;
      }
    }
    picked.push(poolCopy[chosenIdx]);
    poolCopy.splice(chosenIdx, 1);
  }

  return picked;
}

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
  if (!level) return { crystalsEarned: 0, essenceEarned: 0 };
  const progress = loadLevelProgress();
  const entry = progress.levels[level.id] || { stars: 0, unlocked: levelIndex === 0 };
  const previousStars = entry.stars;
  const newStars = Math.max(previousStars, stars);

  let crystalsEarned = 0;
  for (let tier = previousStars + 1; tier <= newStars; tier++) {
    crystalsEarned += CHEST_REWARDS[tier - 1] || 0;
  }

  // 精靈樹精華：跟水晶寶箱不同，每次通關都會給（不限首次達成），用來養精靈樹的持續獎勵
  const essenceEarned = stars >= 1 ? stars * 5 * (levelIndex + 1) : 0;

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
  if (essenceEarned > 0) addEssence(essenceEarned);
  return { entry, crystalsEarned, essenceEarned };
}

// 測試用：直接把關卡進度設成「通關到第 clearedThroughIndex 關、拿 starsOnLast 星」
// clearedThroughIndex 傳 -1 代表重置成「尚未通關任何關卡」
// 自動精確計算累計應得水晶與精華數量，並將商店與精靈樹重置為初始未購買狀態
function debugApplyLevelProgress(clearedThroughIndex, starsOnLast) {
  const levels = {};
  let totalCrystals = 0;
  let totalEssence = 0;

  // 計算每星等水晶累計值
  const getTierCrystals = (stars) => {
    let sum = 0;
    for (let t = 1; t <= stars; t++) {
      sum += CHEST_REWARDS[t - 1] || 0;
    }
    return sum;
  };

  LEVEL_DATA.forEach((lvl, idx) => {
    if (clearedThroughIndex < 0) {
      levels[lvl.id] = { stars: 0, unlocked: idx === 0 };
    } else if (idx < clearedThroughIndex) {
      // 之前所有關卡均為 3 星通關
      levels[lvl.id] = { stars: 3, unlocked: true };
      totalCrystals += getTierCrystals(3);
      totalEssence += 3 * 5 * (idx + 1);
    } else if (idx === clearedThroughIndex) {
      // 當前選擇的關卡
      levels[lvl.id] = { stars: starsOnLast, unlocked: true };
      totalCrystals += getTierCrystals(starsOnLast);
      if (starsOnLast >= 1) {
        totalEssence += starsOnLast * 5 * (idx + 1);
      }
    } else if (idx === clearedThroughIndex + 1 && starsOnLast >= 1) {
      // 解鎖下一關（尚未通關）
      levels[lvl.id] = { stars: 0, unlocked: true };
    } else {
      levels[lvl.id] = { stars: 0, unlocked: false };
    }
  });

  // 1. 存入關卡進度
  saveLevelProgress({ version: 1, levels });

  // 2. 存入精確累計水晶與精華
  saveCrystals(totalCrystals);
  saveEssence(totalEssence);

  // 3. 商店所有項目重置為「尚未購買 / 未締約」狀態（僅保留 starter petal 塔）
  saveUnlocks({ towers: [...FREE_STARTER_TOWERS], skills: [] });

  // 4. 精靈樹重置為「初始狀態（Level 1 幼苗初生）」
  saveSpiritTreeLevel(1);

  // 5. 焦點跳至選中的關卡（或已解鎖的下一關）
  CURRENT_LEVEL_INDEX = Math.max(0, clearedThroughIndex < 0 ? 0 : (starsOnLast >= 1 && clearedThroughIndex + 1 < LEVEL_DATA.length ? clearedThroughIndex + 1 : clearedThroughIndex));

  // 6. 即時更新所有 UI 面板
  if (window.gameInstance) {
    if (window.gameInstance.renderLevelCarousel) {
      window.gameInstance.renderLevelCarousel();
    }
    if (window.gameInstance.updateCrystalBalanceUI) {
      window.gameInstance.updateCrystalBalanceUI();
    }
    if (window.gameInstance.updateSpiritTreeUpBadge) {
      window.gameInstance.updateSpiritTreeUpBadge();
    }
    if (window.gameInstance.renderShopItems) {
      window.gameInstance.renderShopItems();
    }
    if (window.gameInstance.renderSpiritTreeModal) {
      window.gameInstance.renderSpiritTreeModal();
    }
    if (window.gameInstance.showToast) {
      if (clearedThroughIndex < 0) {
        window.gameInstance.showToast(`🧪 已重置為初始進度 (0 關通關，💎0 水晶，商店與精靈樹已歸零)`);
      } else {
        window.gameInstance.showToast(`🧪 已套用通關至第 ${clearedThroughIndex + 1} 關 (${starsOnLast}★)！獲得 💎${totalCrystals} 水晶 · ✨${totalEssence} 精華 (商店與精靈樹已重置)`);
      }
    }
  }

  dbgLog(`🧪 關卡進度測試套用成功：clearedThroughIndex=${clearedThroughIndex}, stars=${starsOnLast}, crystals=${totalCrystals}, essence=${totalEssence}, 商店與精靈樹已重置`);
}
window.dbgApplyLevelProgress = debugApplyLevelProgress;

// 測試用：直接加水晶餘額，方便開發測試時快速解鎖商店塔/技能
function debugAddCrystals(n) {
  const total = addCrystals(n);
  if (window.gameInstance && window.gameInstance.updateCrystalBalanceUI) {
    window.gameInstance.updateCrystalBalanceUI();
  }
  dbgLog(`🧪 測試加值水晶：+${n}，目前餘額 ${total}`);
  return total;
}
window.dbgAddCrystals = debugAddCrystals;

// 測試用：直接加精華餘額，方便開發測試時升級精靈樹
function debugAddEssence(n) {
  const total = addEssence(n);
  if (window.gameInstance) {
    if (window.gameInstance.updateSpiritTreeUpBadge) {
      window.gameInstance.updateSpiritTreeUpBadge();
    }
    if (window.gameInstance.renderSpiritTreeModal) {
      window.gameInstance.renderSpiritTreeModal();
    }
  }
  dbgLog(`🧪 測試加值精華：+${n}，目前餘額 ${total}`);
  return total;
}
window.dbgAddEssence = debugAddEssence;

// 測試用：不用實際打到那一波，直接在偵錯面板的小畫布上畫出指定怪物，用來確認美術是不是真的接上了
// （跟 Enemy.render() 走同一套判斷順序：SVG 圖片 → 手繪 Sprites 函式 → emoji fallback）
function debugPreviewEnemy(typeKey) {
  const canvas = document.getElementById('debug-enemy-preview-canvas');
  const data = ENEMY_DATA[typeKey];
  if (!canvas || !data) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(1.6, 1.6);
  const drawFunc = Sprites['drawEnemy_' + typeKey];
  let usedFallback = false;
  if (drawFunc) {
    drawFunc.call(Sprites, ctx, performance.now() / 1000, false);
  } else {
    usedFallback = true;
    ctx.font = '28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(data.emoji, 0, 0);
  }
  ctx.restore();
  dbgLog(`🧪 預覽怪物：${data.name}（${usedFallback ? '⚠️ 目前是 emoji fallback，還沒有手繪精靈' : '✅ 使用手繪 Sprites 精靈'}）`);
}
window.dbgPreviewEnemy = debugPreviewEnemy;

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
    stats: { dmg: '21', range: '120', rate: '1.1/s' },
  },
  sunflower: {
    kind: 'tower',
    icon: 'assets/towers/tower_sunflower.svg',
    badges: [{ text: '💰 產金 +10/5s', type: 'econ' }, { text: '📈 經濟核心', type: 'econ' }],
    desc: '不進行攻擊，每 5 秒定時產出 +10 陽光金幣（波次進行中），升級大幅增加金幣產能，越早蓋越賺。',
    stats: { dmg: '0', range: '-', rate: '產金 +10/5s' },
  },
  ice_crystal: {
    kind: 'tower',
    icon: 'assets/towers/tower_ice_crystal.svg',
    badges: [{ text: '🧊 霜凍減速 50%', type: 'slow' }, { text: '✨ 貫穿 3 體', type: 'pierce' }],
    desc: '發射極寒冰晶貫穿前排 3 隻敵人，命中附加 50% 緩速持續 3 秒，聚怪控場核心。',
    stats: { dmg: '12', range: '130', rate: '0.8/s' },
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
    desc: '召喚天外熾熱流星群，對指定圓形區域造成 60 點範圍爆炸傷害。',
    stats: { dmg: '60', range: '全圖選點', rate: 'CD 30s' },
  },
  freeze: {
    kind: 'skill',
    icon: 'assets/skills/skill_freeze.svg',
    badges: [{ text: '🧊 全場定身凍結', type: 'skill' }, { text: '⏱️ 冷卻 45s', type: 'skill' }],
    desc: '降下極地暴風雪，強制全場所有移動中的敵人減速 80% 並冰凍定身 3.5 秒。',
    stats: { dmg: '50', range: '全場敵人', rate: 'CD 45s' },
  }
};

// 傷害類型標示：物理/魔法/毒素，讓玩家看得到抗性剋制關係（裝甲瓢蟲抗物理、迷霧幽蛾抗魔法）
function getDamageTypeBadge(damageType) {
  switch (damageType) {
    case 'physical': return { text: '⚔️ 物理', cls: 'badge-physical' };
    case 'magic': return { text: '✨ 魔法', cls: 'badge-magic' };
    case 'poison': return { text: '☠️ 毒素', cls: 'badge-poison' };
    default: return null;
  }
}

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

// ─── 5.4 精靈樹：通關會獲得「精華」，累積精華可以升級精靈樹，每一級提供不同的永久強化 ─────
const ESSENCE_KEY = 'dd_td_essence_v1';
let _essenceMemoryFallback = null;

function loadEssence() {
  try {
    const raw = localStorage.getItem(ESSENCE_KEY);
    if (raw === null) return _essenceMemoryFallback ?? 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return _essenceMemoryFallback ?? 0;
  }
}

function saveEssence(n) {
  _essenceMemoryFallback = n;
  try {
    localStorage.setItem(ESSENCE_KEY, String(n));
  } catch (e) {
    dbgLog('⚠️ 精華存檔失敗（可能為無痕模式或配額已滿），本次僅暫存於記憶體');
  }
}

function addEssence(n) {
  const total = loadEssence() + n;
  saveEssence(total);
  return total;
}

// 每一級都是「升到這一級後」的總加成（已經是累加後的數字，不用在別處再加總）；
// cost 是從上一級升到這一級要花的精華。index 0 = 第 1 級（初始狀態，免費）。
// 規則：金幣每級 +20 / +30 交錯提升；生命則偶數等級一律 +2。
const SPIRIT_TREE_LEVELS = [
  { cost: 0,   bonusGold: 0,   bonusLives: 0, desc: '幼苗初生' },
  { cost: 20,  bonusGold: 20,  bonusLives: 2, desc: '初始金幣 +20 ・ 初始生命 +2' },
  { cost: 40,  bonusGold: 50,  bonusLives: 2, desc: '初始金幣再 +30' },
  { cost: 70,  bonusGold: 70,  bonusLives: 4, desc: '初始金幣再 +20 ・ 初始生命再 +2' },
  { cost: 110, bonusGold: 100, bonusLives: 4, desc: '初始金幣再 +30' },
  { cost: 160, bonusGold: 120, bonusLives: 6, desc: '初始金幣再 +20 ・ 初始生命再 +2' },
  { cost: 220, bonusGold: 150, bonusLives: 6, desc: '初始金幣再 +30' },
];
const SPIRIT_TREE_LEVEL_KEY = 'dd_td_spirit_tree_level_v1';
let _spiritTreeLevelMemoryFallback = null;

function loadSpiritTreeLevel() {
  try {
    const raw = localStorage.getItem(SPIRIT_TREE_LEVEL_KEY);
    if (raw === null) return _spiritTreeLevelMemoryFallback ?? 1;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch (e) {
    return _spiritTreeLevelMemoryFallback ?? 1;
  }
}

function saveSpiritTreeLevel(n) {
  _spiritTreeLevelMemoryFallback = n;
  try {
    localStorage.setItem(SPIRIT_TREE_LEVEL_KEY, String(n));
  } catch (e) {
    dbgLog('⚠️ 精靈樹等級存檔失敗（可能為無痕模式或配額已滿），本次僅暫存於記憶體');
  }
}

function getSpiritTreeBonus() {
  const level = Math.min(loadSpiritTreeLevel(), SPIRIT_TREE_LEVELS.length);
  return SPIRIT_TREE_LEVELS[level - 1];
}

function getStartingGold() {
  return CONFIG.STARTING_GOLD + getSpiritTreeBonus().bonusGold;
}

function getStartingLives() {
  return CONFIG.STARTING_LIVES + getSpiritTreeBonus().bonusLives;
}

// 檢查精靈樹當前是否可以升級（未滿級且精華足夠）
function canUpgradeSpiritTree() {
  const level = loadSpiritTreeLevel();
  if (level >= SPIRIT_TREE_LEVELS.length) return false;
  const nextTier = SPIRIT_TREE_LEVELS[level];
  return loadEssence() >= nextTier.cost;
}

// 花精華把精靈樹升一級；精華不足或已經滿級都會失敗
function upgradeSpiritTree() {
  const level = loadSpiritTreeLevel();
  if (level >= SPIRIT_TREE_LEVELS.length) return { ok: false, reason: 'maxed' };
  const nextTier = SPIRIT_TREE_LEVELS[level]; // 0-based，index=level 剛好是「下一級」
  const balance = loadEssence();
  if (balance < nextTier.cost) return { ok: false, reason: 'insufficient' };
  saveEssence(balance - nextTier.cost);
  saveSpiritTreeLevel(level + 1);
  return { ok: true, level: level + 1 };
}

// 用水晶購買（締約）一座塔；回傳 { ok, reason? }
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

// 賣出（解除契約）一座塔，全額退還水晶；回傳 { ok, reason?, refund }
function refundTower(typeKey) {
  if (FREE_STARTER_TOWERS.includes(typeKey)) return { ok: false, reason: 'starter' };
  const item = SHOP_ITEMS.towers[typeKey];
  if (!item) return { ok: false, reason: 'not-found' };
  if (!isTowerUnlocked(typeKey)) return { ok: false, reason: 'not-owned' };
  const unlocks = loadUnlocks();
  unlocks.towers = unlocks.towers.filter(k => k !== typeKey);
  saveUnlocks(unlocks);
  saveCrystals(loadCrystals() + item.cost);
  return { ok: true, refund: item.cost };
}

// 用水晶購買（締約）一個主動技能；回傳 { ok, reason? }
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

// 賣出（解除契約）一個主動技能，全額退還水晶；回傳 { ok, reason?, refund }
function refundSkill(skillKey) {
  const item = SHOP_ITEMS.skills[skillKey];
  if (!item) return { ok: false, reason: 'not-found' };
  if (!isSkillUnlocked(skillKey)) return { ok: false, reason: 'not-owned' };
  const unlocks = loadUnlocks();
  unlocks.skills = unlocks.skills.filter(k => k !== skillKey);
  saveUnlocks(unlocks);
  saveCrystals(loadCrystals() + item.cost);
  return { ok: true, refund: item.cost };
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
  },

  // 7. 裝甲瓢蟲 (S3 龜甲陣青銅圓盾衛士 / 黃金神盾王)
  drawEnemy_armored_ladybug: function(ctx, time, isBoss) {
    ctx.save();
    const bob = Math.sin(time * 5) * 1.0;
    ctx.translate(0, bob);

    if (isBoss) {
      // 腳足 (強化金甲足)
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      [-1, 1].forEach(s => {
        ctx.beginPath();
        ctx.moveTo(s * 6, 2); ctx.lineTo(s * 13, 8); ctx.lineTo(s * 15, 15);
        ctx.moveTo(s * 5, 8); ctx.lineTo(s * 11, 15);
        ctx.stroke();
      });

      // 巨型神金凸面圓盾 (Boss 形態)
      const rg = ctx.createRadialGradient(-3, -3, 2, 0, 0, 16);
      rg.addColorStop(0, '#fffde7'); rg.addColorStop(0.3, '#ffd600'); rg.addColorStop(0.7, '#ff8f00'); rg.addColorStop(1, '#b71c1c');
      ctx.fillStyle = rg;
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      // 盾面鉚釘環
      ctx.fillStyle = '#b71c1c';
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        const rx = Math.cos(a) * 12;
        const ry = Math.sin(a) * 12;
        ctx.beginPath(); ctx.arc(rx, ry, 1.3, 0, Math.PI * 2); ctx.fill();
      }

      // 盾心紅寶石撞擊錐 (Umbo)
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd600';
      ctx.beginPath(); ctx.arc(-1.2, -1.2, 2.2, 0, Math.PI * 2); ctx.fill();

      // 皇冠
      this.drawMiniCrown(ctx, 0, -18);

      // 雙目
      ctx.fillStyle = '#00e5ff';
      ctx.beginPath(); ctx.arc(-3.5, -12, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3.5, -12, 1.3, 0, Math.PI * 2); ctx.fill();
    } else {
      // 普通 S3 龜甲陣青銅圓盾
      // 短粗重裝足
      ctx.strokeStyle = '#212121'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      [-1, 1].forEach(s => {
        ctx.beginPath();
        ctx.moveTo(s * 6, 2); ctx.lineTo(s * 11, 7); ctx.lineTo(s * 13, 13);
        ctx.moveTo(s * 5, 7); ctx.lineTo(s * 9, 13);
        ctx.stroke();
      });

      // 巨型凸面青銅圓盾 (覆蓋全背與頭頂)
      const rg = ctx.createRadialGradient(-3, -3, 2, 0, 0, 14);
      rg.addColorStop(0, '#ffe082'); rg.addColorStop(0.3, '#ffb300'); rg.addColorStop(0.8, '#ff6f00'); rg.addColorStop(1, '#3e2723');
      ctx.fillStyle = rg;
      ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, 0, 13.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      // 盾圈鉚釘環
      ctx.fillStyle = '#3e2723';
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        const rx = Math.cos(a) * 10.5;
        const ry = Math.sin(a) * 10.5;
        ctx.beginPath(); ctx.arc(rx, ry, 1.1, 0, Math.PI * 2); ctx.fill();
      }

      // 盾心尖銳撞擊錐 (Umbo)
      ctx.fillStyle = '#b71c1c';
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd600';
      ctx.beginPath(); ctx.arc(-1, -1, 1.8, 0, Math.PI * 2); ctx.fill();

      // 盾下露出的亮藍機械雙目
      ctx.fillStyle = '#00e5ff';
      ctx.beginPath(); ctx.arc(-3, -11, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -11, 1.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },

  // 8. 迷霧幽蛾 (M4 隱匿呼吸薄暮 / 零粒子純漸層)
  drawEnemy_mist_moth: function(ctx, time, isBoss) {
    ctx.save();
    const bob = Math.sin(time * 4) * 2;
    const flap = Math.sin(time * 20) * 0.4;
    // 呼吸式隱匿半透明度 (35% ~ 75% 波動，零額外粒子)
    const pulse = 0.45 + Math.sin(time * 3) * 0.28;
    ctx.translate(0, bob);

    ctx.save();
    ctx.globalAlpha = isBoss ? Math.min(1, pulse + 0.2) : pulse;

    // 幽幻雙翅 (薄暮彩光)
    ctx.save();
    ctx.rotate(flap * 0.3);
    const wg = ctx.createLinearGradient(-12, -10, 12, 10);
    if (isBoss) {
      wg.addColorStop(0, '#ffd600'); wg.addColorStop(0.5, '#e040fb'); wg.addColorStop(1, '#00e5ff');
    } else {
      wg.addColorStop(0, '#ff4081'); wg.addColorStop(0.5, '#7c4dff'); wg.addColorStop(1, '#18ffff');
    }
    ctx.fillStyle = wg;
    ctx.strokeStyle = isBoss ? '#ffd600' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;

    // 主副翅
    [-1, 1].forEach(s => {
      ctx.beginPath(); ctx.ellipse(s * 8, -4, 7.5, 11, s * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(s * 6, 5, 5, 7.5, s * 0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      // 符文魔眼
      ctx.fillStyle = '#18ffff';
      ctx.beginPath(); ctx.arc(s * 8, -4, 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#311b92';
      ctx.beginPath(); ctx.arc(s * 8, -4, 1, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();

    // 幽靈絨毛身軀
    ctx.fillStyle = isBoss ? '#fffde7' : '#ede7f6';
    ctx.beginPath(); ctx.ellipse(0, 1, 3.5, 8, 0, 0, Math.PI * 2); ctx.fill();

    // 羽毛觸角
    ctx.strokeStyle = '#e040fb'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-1.5, -6); ctx.quadraticCurveTo(-6, -12, -10, -14); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(1.5, -6); ctx.quadraticCurveTo(6, -12, 10, -14); ctx.stroke();

    if (isBoss) {
      this.drawMiniCrown(ctx, 0, -13);
      ctx.fillStyle = '#ff4081';
      ctx.beginPath(); ctx.arc(-1.5, -6, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(1.5, -6, 1.2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#ff4081';
      ctx.beginPath(); ctx.arc(-1.5, -5.5, 1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(1.5, -5.5, 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(-1.8, -5.8, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(1.2, -5.8, 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  },

  // 9. 疾風螳螂 (Mantis - 緩速免疫 / 破風雙鐮)
  drawEnemy_mantis: function(ctx, time, isBoss) {
    ctx.save();
    const bob = Math.sin(time * 9) * 1.2;
    const slash = Math.sin(time * 6) * 0.15;
    ctx.translate(0, bob);

    if (isBoss) {
      // ─── 黃金疾風螳螂王 (Boss) ───
      // 1. 破風疾行氣流光環
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(0, 0, 18, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();

      // 2. 金甲六足
      ctx.strokeStyle = '#e65100'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      [-1, 1].forEach(s => {
        ctx.beginPath();
        ctx.moveTo(s * 5, 2); ctx.lineTo(s * 12, 6); ctx.lineTo(s * 15, 14);
        ctx.moveTo(s * 4, 6); ctx.lineTo(s * 10, 14);
        ctx.stroke();
      });

      // 3. 腹部流線金甲
      const abGrad = ctx.createLinearGradient(0, 0, 0, 16);
      abGrad.addColorStop(0, '#ffd600'); abGrad.addColorStop(1, '#ff6f00');
      ctx.fillStyle = abGrad;
      ctx.beginPath();
      ctx.ellipse(0, 6, 7, 12, 0, 0, Math.PI * 2);
      ctx.fill();

      // 4. 胸部與頭部
      ctx.fillStyle = '#ffb300';
      ctx.beginPath(); ctx.ellipse(0, -4, 6, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffe082';
      ctx.beginPath(); ctx.moveTo(-6, -8); ctx.lineTo(6, -8); ctx.lineTo(0, -2); ctx.closePath(); ctx.fill();

      // 5. 雙持赤金破風巨鐮
      [-1, 1].forEach(s => {
        ctx.save();
        ctx.translate(s * 6, -6);
        ctx.rotate(s * (0.4 + slash));
        // 上臂
        ctx.strokeStyle = '#ff8f00'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * 5, -8); ctx.stroke();
        // 前鐮刀刃
        ctx.fillStyle = '#ffd600'; ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(s * 5, -8);
        ctx.quadraticCurveTo(s * 14, -6, s * 11, 6);
        ctx.quadraticCurveTo(s * 7, 0, s * 5, -8);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      });

      // 6. 皇冠與複眼
      this.drawMiniCrown(ctx, 0, -18);
      ctx.fillStyle = '#00e5ff';
      ctx.beginPath(); ctx.arc(-3.5, -9, 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3.5, -9, 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(-4, -10, 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -10, 0.8, 0, Math.PI * 2); ctx.fill();
    } else {
      // ─── 疾風螳螂 (普通) ───
      // 1. 破風氣流
      ctx.strokeStyle = 'rgba(0, 230, 118, 0.35)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 2, 14, Math.PI * 0.25, Math.PI * 0.75); ctx.stroke();

      // 2. 翡翠細足
      ctx.strokeStyle = '#1b5e20'; ctx.lineWidth = 2.0; ctx.lineCap = 'round';
      [-1, 1].forEach(s => {
        ctx.beginPath();
        ctx.moveTo(s * 4, 1); ctx.lineTo(s * 10, 5); ctx.lineTo(s * 13, 12);
        ctx.moveTo(s * 3, 5); ctx.lineTo(s * 8, 12);
        ctx.stroke();
      });

      // 3. 翠綠流線水滴身軀
      const bgGrad = ctx.createLinearGradient(0, -6, 0, 14);
      bgGrad.addColorStop(0, '#76ff03'); bgGrad.addColorStop(0.5, '#00e676'); bgGrad.addColorStop(1, '#1b5e20');
      ctx.fillStyle = bgGrad;
      ctx.beginPath();
      ctx.ellipse(0, 4, 5.5, 10, 0, 0, Math.PI * 2);
      ctx.fill();

      // 4. 頭部 (倒三角)
      ctx.fillStyle = '#69f0ae';
      ctx.beginPath();
      ctx.moveTo(-5, -7); ctx.lineTo(5, -7); ctx.lineTo(0, -2);
      ctx.closePath();
      ctx.fill();

      // 5. 雙前鐮 (綠光刀刃)
      [-1, 1].forEach(s => {
        ctx.save();
        ctx.translate(s * 5, -5);
        ctx.rotate(s * (0.35 + slash));
        ctx.strokeStyle = '#2e7d32'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * 4, -7); ctx.stroke();
        // 鐮刃
        ctx.fillStyle = '#b9f6ca'; ctx.strokeStyle = '#00c853'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s * 4, -7);
        ctx.quadraticCurveTo(s * 12, -5, s * 9, 5);
        ctx.quadraticCurveTo(s * 6, -1, s * 4, -7);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      });

      // 6. 水汪汪大金眼
      ctx.fillStyle = '#ffd600';
      ctx.beginPath(); ctx.arc(-3, -7.5, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -7.5, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b5e20';
      ctx.beginPath(); ctx.arc(-2.8, -7.5, 1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(2.8, -7.5, 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(-3.2, -8, 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(2.4, -8, 0.6, 0, Math.PI * 2); ctx.fill();

      // 7. 纖細觸角
      ctx.strokeStyle = '#00c853'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-2, -8); ctx.quadraticCurveTo(-6, -13, -8, -15); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, -8); ctx.quadraticCurveTo(6, -13, 8, -15); ctx.stroke();
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
  constructor(typeKey, gameMap, waveIndex = 0, isBossOverride = null, customHpMult = 1.0) {
    const data = ENEMY_DATA[typeKey];
    const isRogue = (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE);
    // 難度成長依關卡倍率與 Boss 倍率
    const levelHpMult = (isRogue
      ? (ROGUELIKE_LEVEL_DATA[CURRENT_LEVEL_INDEX]?.hpMultiplier || 1.0)
      : (LEVEL_DATA[CURRENT_LEVEL_INDEX]?.hpMultiplier || 1.0));
    this.typeKey = typeKey;
    this.waveIndex = waveIndex;
    this.name = data.name;
    this.emoji = data.emoji;
    this.isBoss = isBossOverride !== null ? isBossOverride : !!data.isBoss;

    // 波次血量倍率計算（修正倍率重複疊乘平方問題）：
    let waveHpMult = 1.0;
    if (customHpMult > 1.0) {
      waveHpMult = customHpMult;
    } else if (isRogue) {
      waveHpMult = Number((1.0 + waveIndex * 0.10 + Math.pow(waveIndex, 1.35) * 0.05).toFixed(2));
    }

    // 若波次數據中未特別指定 customHpMult，且此怪物為 Boss，則套用標準 Boss 加成 (2.5x ~ 3.5x)
    let bossHpMult = 1.0;
    if (this.isBoss && !(customHpMult > 1.0)) {
      bossHpMult = data.isBoss ? 2.5 : 3.5;
    }

    this.maxHp = Math.round(data.hp * levelHpMult * bossHpMult * waveHpMult);
    this.hp = this.maxHp;
    this.baseSpeed = this.isBoss ? Math.max(22, data.speed * 0.82) : data.speed;
    this.speed = this.baseSpeed;
    this.reward = this.isBoss ? Math.round(data.reward * 3) : data.reward;
    this.damage = this.isBoss ? Math.max(3, data.damage * 2) : data.damage;
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
    this.immuneSlow = !!data.immuneSlow; // 緩速/冰凍/控制免疫

    // 抗性機制：取消全怪物無差別增加雙抗！
    // 只有原本即具備該抗性特性的怪物（如裝甲瓢蟲物抗、迷霧幽蛾魔抗），才隨波次提升其專屬抗性
    // 其餘怪物（毛毛蟲、蜜蜂、蝴蝶、蝸牛、小龍、螳螂等）物抗與魔抗永遠為 0%
    this.resist = Object.assign({}, data.resist || {});
    if (isRogue) {
      const rogueResistBonus = Math.min(0.15, 0.04 + Math.floor(waveIndex / 5) * 0.03);
      if (this.resist.physical) {
        this.resist.physical = Math.min(0.65, this.resist.physical + rogueResistBonus);
      }
      if (this.resist.magic) {
        this.resist.magic = Math.min(0.65, this.resist.magic + rogueResistBonus);
      }
    }

    // 緩速抵抗 (Slow Resistance)：隨波次平緩提高，每 25 波上升 10%（每波 +0.4%），最高上限 60% (0.60)
    // 算法：第 1 波為 0%，第 25 波 10%，第 50 波 20%，至第 150 波達到最高 60% 封頂
    this.slowResist = Math.min(0.60, Math.max(0, (waveIndex || 0) * 0.004));

    this.summonThresholds = [0.75, 0.5, 0.25]; // 小龍在 75%, 50%, 25% 血量召喚小蜜蜂
    this.summonedStages = new Set();

    // Poison DOT (劇毒持續傷害)
    this.poisonTimer = 0;
    this.poisonDps = 0;
    this.poisonTickTimer = 0;

    // Visual
    this.hitFlash = 0;
    this.scale = 0;
    this.targetScale = this.isBoss ? 1.25 : 1;
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

  takeDamage(amount, slowFactor, slowDuration, poisonDps, poisonDuration, damageType = null, game = null) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return;

    // 依傷害類型套用該敵人對應抗性；damageType 為 null 或該敵人沒有對應抗性一律不減傷
    const resistRatio = this.resist[damageType] || 0;
    const finalAmount = amount * (1 - resistRatio);
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

    // 減速/定身效果不能被更弱的效果蓋掉：例如絕對零度把怪完全定身（slowFactor=0）之後，
    // 冰晶塔之類的普通減速（slowFactor=0.5）打中同一隻怪，不該把它蓋掉變成又能動；
    // 若該怪物具備 immuneSlow（如疾風螳螂），則完全免疫任何緩速與定身效果；
    // 其餘怪物套用隨波次成長的 slowResist（最高 50%），減少減速深度與減速持續時間
    if (typeof slowFactor === 'number' && typeof slowDuration === 'number' && slowDuration > 0) {
      if (this.immuneSlow) {
        // 緩速免疫，不套用 slowFactor
      } else {
        const resist = this.slowResist || 0;
        // 計算抵抗後的緩速係數：原始減速量 (1 - slowFactor) 乘上 (1 - resist)
        // 例如：原始減速 50% (slowFactor=0.5)，有 50% 抵抗時，減速量降為 25% (effectiveSlowFactor=0.75)
        const baseSlowPercent = 1 - Math.max(0, Math.min(1, slowFactor));
        const effectiveSlowPercent = baseSlowPercent * (1 - resist);
        const effectiveSlowFactor = 1 - effectiveSlowPercent;
        const effectiveDuration = Math.max(0.5, slowDuration * (1 - resist * 0.5));

        if (this.slowTimer <= 0 || effectiveSlowFactor <= this.slowFactor) {
          this.slowFactor = effectiveSlowFactor;
          this.slowTimer = effectiveDuration;
        }
      }
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

    // Boss 金色領主霸氣光環
    if (this.isBoss) {
      ctx.save();
      const bossPulse = 0.25 + Math.sin(this.animTime * 6) * 0.12;
      ctx.globalAlpha = bossPulse;
      ctx.fillStyle = '#ffd700';
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    // 優先使用手繪 Canvas 精靈 (Sprites)，保持逐幀呼吸、拍翅、擺動與發光等高畫質動畫
    const drawFunc = Sprites['drawEnemy_' + this.typeKey];
    if (drawFunc) {
      drawFunc.call(Sprites, ctx, this.animTime, !!this.isBoss);
    } else {
      const enemyImg = assets.get('enemy_' + this.typeKey);
      if (enemyImg) {
        ctx.save();
        ctx.rotate(this.wobbleAngle || 0);
        ctx.drawImage(enemyImg, -20, -20, 40, 40);
        ctx.restore();
      } else {
        // Fallback：還沒有手繪 Canvas 精靈的敵人類型直接畫 emoji，避免整隻怪變成隱形（只剩陰影＋血條）
        ctx.font = '28px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.emoji, 0, 0);
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

    // Health bar (Boss 擁有加寬金邊血條)
    const barW = this.isBoss ? 44 : 30;
    const barH = this.isBoss ? 6 : 4;
    const barY = this.isBoss ? -30 : -24;
    const hpRatio = this.hp / this.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-barW / 2, barY, barW, barH);
    if (this.isBoss) {
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 1;
      ctx.strokeRect(-barW / 2 - 0.5, barY - 0.5, barW + 1, barH + 1);
    }
    const hpColor = hpRatio > 0.5 ? (this.isBoss ? '#ffd700' : '#88d8b0') : hpRatio > 0.25 ? '#ff9800' : '#ff5252';
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
    this.damageType = TOWER_DATA[tower.typeKey]?.damageType || 'physical';
    this.tower = tower; // 來源防禦塔參照

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
      // 穿透彈每貫穿一體衰減 20% 傷害，比照連鎖閃電的衰減比例，避免穿透塔在多怪排隊時全額暴擊每一隻
      const pierceFalloff = this.piercing > 0 ? Math.pow(0.8, this.piercedEnemies.size) : 1;
      let finalDamage = this.damage * pierceFalloff;
      if (typeof relicManager !== 'undefined') {
        finalDamage = relicManager.modifyDamage(finalDamage, this.damageType, this, this.target, game);
      }
      if (this.tower) {
        this.tower.totalDamageDealt = (this.tower.totalDamageDealt || 0) + finalDamage;
      }
      this.target.takeDamage(finalDamage, this.slowFactor, this.slowDuration, this.poisonDps, this.poisonDuration, this.damageType, game);
      this.piercedEnemies.add(this.target);
      this.chainedEnemies.add(this.target);
      this.lastHitDistance = this.target.distance;

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
            let chainDmg = this.damage * Math.pow(0.8, c); // 每次彈射衰減 20% 傷害
            // 雷霆過載：每一次彈射獨立判定暴擊，而不是只有初擊能觸發
            if (typeof relicManager !== 'undefined' && relicManager.hasHidden('thunder_overload')) {
              chainDmg = relicManager.modifyDamage(chainDmg, 'magic', this, nextTarget, game);
            }
            if (this.tower) {
              this.tower.totalDamageDealt = (this.tower.totalDamageDealt || 0) + chainDmg;
            }
            nextTarget.takeDamage(chainDmg, null, 0, 0, 0, 'magic', game); // 閃電為魔法傷害

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
      // 觸發命中 Hook（包含焦土、萬花齊放、雷射折射等天賦）
      if (typeof relicManager !== 'undefined') {
        relicManager.onHitTarget(this, this.target, game);
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
    this.totalDamageDealt = 0; // 本局累計輸出傷害

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
        if (this.goldTimer >= 5.0) {
          this.goldTimer -= 5.0;
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
          if (typeof relicManager !== 'undefined') {
            relicManager.onSunflowerPulse(this, game);
          }
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

  render(ctx, game) {
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

    // 5. 懸浮升級星星按鈕 (只有升級費用夠且未滿級時才顯示)
    if (game && this.level < CONFIG.MAX_LEVEL) {
      const upgradeCost = this.getUpgradeCost();
      if (upgradeCost !== null && game.gold >= upgradeCost) {
        const now = performance.now() / 1000;
        const bob = Math.sin(now * 6) * 2.5;
        const btnY = -34 + bob;
        const btnR = 11;

        ctx.save();
        ctx.translate(0, btnY);

        // 外層金黃流光光暈
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 10;
        const starGrad = ctx.createLinearGradient(0, -btnR, 0, btnR);
        starGrad.addColorStop(0, '#fff9c4');
        starGrad.addColorStop(0.3, '#ffd700');
        starGrad.addColorStop(1, '#ff8f00');

        // 圓形底座
        ctx.fillStyle = starGrad;
        ctx.beginPath();
        ctx.arc(0, 0, btnR, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // 中央閃亮五角星
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        for (let j = 0; j < 5; j++) {
          const a = (Math.PI * 2 / 5) * j - Math.PI / 2;
          ctx.lineTo(Math.cos(a) * 6, Math.sin(a) * 6);
          const a2 = (Math.PI * 2 / 5) * j + Math.PI / 5 - Math.PI / 2;
          ctx.lineTo(Math.cos(a2) * 2.8, Math.sin(a2) * 2.8);
        }
        ctx.closePath();
        ctx.fill();

        // 頂部「UP▲」精緻小標籤
        ctx.fillStyle = '#ff3d00';
        ctx.font = '900 7.5px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('▲', 0, -btnR + 2);

        ctx.restore();
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
    let wave = this.waveData ? this.waveData[waveIndex] : null;

    // 🔮 幻境秘境無盡動態波次生成器 (超過預設波次或無盡模式動態延展)
    if (!wave && CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
      wave = this.generateEndlessWave(waveIndex);
    }

    if (!wave) {
      dbgLog(`⚠️ WaveData not found for wave ${waveIndex}`);
      return;
    }

    const isRogue = (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE);
    dbgLog(`🌊 [Wave] 第 ${waveIndex + 1} 波開始生成，組數: ${wave.enemies.length}`);
    for (const group of wave.enemies) {
      // 幻境關卡怪物數量大幅精簡 (每組數量減半至 40%~50%，避免怪海，突顯單怪精銳強度)
      const count = isRogue
        ? Math.max(1, Math.round(group.count * 0.45))
        : group.count;
      const interval = isRogue
        ? Math.max(0.2, (group.interval || 0.5) * 1.3)
        : group.interval;

      for (let i = 0; i < count; i++) {
        this.spawnQueue.push({
          type: group.type,
          isBoss: group.isBoss,
          hpMultiplier: group.hpMultiplier,
          delay: interval,
          waveIndex: waveIndex,
        });
      }
    }
    dbgLog(`👾 [Wave] 當前排隊出怪數: ${this.spawnQueue.length}`);

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
        dbgLog(`✨ [Wave] 出怪完畢 (allSpawned = true)`);
      }

      return new Enemy(spawn.type, gameMap, spawn.waveIndex ?? this.currentWave, spawn.isBoss, spawn.hpMultiplier);
    }
    return null;
  }

  // 🔮 幻境秘境全域指數性數值成長 (數量精簡 + 單體高血高抗精銳化)
  generateEndlessWave(waveIndex) {
    const waveNum = waveIndex + 1;
    // 基礎血量係數：前 50 波 100% 保持原本平滑成長；50 波之後指數狂暴提升
    let hpScale;
    if (waveNum <= 50) {
      hpScale = 1.0 + (waveNum - 1) * 0.10 + Math.pow(waveNum - 1, 1.35) * 0.05;
    } else {
      const extra50 = waveNum - 50;
      // 50 波基準值 (16.32) + 超過 50 波後以 1.85 次方高強度飆升
      hpScale = 16.32 + extra50 * 0.8 + Math.pow(extra50, 1.85) * 0.22;
    }
    hpScale = Number(hpScale.toFixed(2));

    const isBossWave = (waveNum % 10 === 0);
    const isMidBossWave = (waveNum % 5 === 0 && !isBossWave);

    const enemyTypes = ['caterpillar', 'bee', 'snail', 'beetle', 'butterfly', 'armored_ladybug', 'mist_moth', 'mantis'];
    const selectedTypes = [];

    // 依波數解鎖更高階怪物（包含免疫緩速的疾風螳螂）
    if (waveNum > 10) selectedTypes.push('mist_moth', 'armored_ladybug');
    if (waveNum > 6) selectedTypes.push('mantis');
    if (waveNum > 4) selectedTypes.push('beetle', 'butterfly');
    selectedTypes.push('caterpillar', 'bee', 'snail');

    const enemies = [];
    // 精簡怪群數量（每組僅 4~8 隻精銳，最高不超過 10 隻）
    const countScale = Math.min(1.6, 1 + Math.floor(waveNum / 10) * 0.12);

    // 隨機組裝 2 組精銳怪群
    for (let g = 0; g < 2; g++) {
      const type = selectedTypes[Math.floor(Math.random() * selectedTypes.length)];
      enemies.push({
        type: type,
        count: Math.max(3, Math.floor((4 + Math.random() * 3) * countScale)),
        interval: Math.max(0.25, 0.65 - waveNum * 0.006),
        hpMultiplier: hpScale
      });
    }

    // 每 5 波 Mid-Boss / 每 10 波 Final Boss (單體血量極高)
    if (isBossWave) {
      enemies.push({
        type: 'dragon',
        count: Math.min(2, 1 + Math.floor(waveNum / 25)),
        interval: 3.5,
        isBoss: true,
        hpMultiplier: Number((hpScale * 3.5).toFixed(2))
      });
    } else if (isMidBossWave) {
      const bossTypes = ['armored_ladybug', 'mist_moth', 'mantis'];
      const bossType = bossTypes[Math.floor(Math.random() * bossTypes.length)];
      enemies.push({
        type: bossType,
        count: 1,
        interval: 2.5,
        isBoss: true,
        hpMultiplier: Number((hpScale * 2.4).toFixed(2))
      });
    }

    return {
      enemies: enemies,
      bonus: Math.floor(100 + waveNum * 30)
    };
  }

  isComplete(enemies) {
    if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
      return false; // 幻境秘境為無盡模式，直到基地淪陷才結算
    }
    const aliveCount = enemies.filter((e) => e.alive).length;
    return this.allSpawned && this.currentWave >= CONFIG.TOTAL_WAVES - 1 && aliveCount === 0;
  }

  getWaveBonus(waveIdx = this.currentWave) {
    if (this.waveData && this.waveData[waveIdx]) {
      return this.waveData[waveIdx].bonus || 0;
    }
    return Math.floor(100 + (waveIdx + 1) * 30);
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
    this.gold = getStartingGold();
    this.lives = getStartingLives();
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
      meteor: { cd: 30, timer: 0, cost: 0, range: 110, damage: 60 },
      freeze: { cd: 45, timer: 0, cost: 0, duration: 3.5 },
      solar_wrath: { cd: 4, timer: 0 }
    };
    this.activeTargetingSkill = null; // 'meteor' or null

    // Base & Gate Dynamic Feedback
    this.baseHurtTimer = 0;
    this.gatePulseTimer = 0;
    this.nextWaveCountdown = null; // 倒數計時秒數（總共 15 秒，剩 10 秒才開始顯示 UI），null 表示無倒數

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

    // 歷史累計各塔總傷害（賣掉塔後依然永久保留在本局統計中）
    this.typeTotalDamage = {};
    for (const key in TOWER_DATA) {
      this.typeTotalDamage[key] = 0;
    }

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

  // 繪製天賦卡牌/徽章專屬圖示：若為防禦塔專屬天賦則繪製該塔圖案；若非則繪製專屬圖標
  drawTalentIcon(ictx, talent, width = 40, height = 40) {
    ictx.setTransform(1, 0, 0, 1, 0, 0);
    ictx.clearRect(0, 0, width, height);

    // 1. 若為某個防禦塔專用的天賦，繪製該塔的專屬圖片
    if (talent.towerKey) {
      const towerKey = (talent.towerKey === 'ice') ? 'ice_crystal' : talent.towerKey;
      const svgImg = assets.get('tower_' + towerKey);
      if (svgImg) {
        ictx.drawImage(svgImg, 2, 2, width - 4, height - 4);
      } else {
        ictx.save();
        ictx.translate(width / 2, height / 2 + 1);
        ictx.scale(width / 52, height / 52);
        const drawFn = Sprites['drawTower_' + towerKey];
        if (drawFn) drawFn.call(Sprites, ictx, 0, 1);
        ictx.restore();
      }
      return;
    }

    // 2. 若不是單塔專用，繪製精心設計的專屬圖標
    const iconKey = talent.specialIconKey || talent.hiddenId || talent.branchId || talent.id;
    ictx.save();
    ictx.translate(width / 2, height / 2);

    if (iconKey === 'solar_wrath') {
      // ☀️ 日輪天罰：日冕光環 + 八芒烈焰金陽
      ictx.save();
      ictx.scale(width / 42, height / 42);
      this.drawSkillIcon(ictx, 'solar_wrath');
      ictx.restore();
    } else if (iconKey === 'bountiful_blessing') {
      // 💖 豐饒祝福：神聖粉金之心 + 金幣散落 + 祝福晶芒
      ictx.save();
      ictx.scale(width / 44, height / 44);
      // 光暈
      ictx.fillStyle = 'rgba(255, 105, 180, 0.25)';
      ictx.beginPath(); ictx.arc(0, 0, 18, 0, Math.PI * 2); ictx.fill();
      // 愛心本體
      const ctx = ictx;
      ctx.fillStyle = '#ff4081';
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.bezierCurveTo(-10, -5, -12, -14, 0, -12);
      ctx.bezierCurveTo(12, -14, 10, -5, 0, 5);
      ctx.fill();
      // 金幣微粒
      ctx.fillStyle = '#ffd700'; ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1;
      [[-7, 7], [7, 7], [0, 12]].forEach(([cx, cy]) => {
        ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
      // 高光晶芒
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(-4, -8, 1.5, 0, Math.PI * 2); ctx.fill();
      ictx.restore();
    } else if (iconKey === 'nature_growth' || iconKey === 'tower_growth') {
      // 🍃 強化生長 / 自然之靈：翡翠旋轉生命雙葉 + 露珠高光
      ictx.save();
      ictx.scale(width / 44, height / 44);
      const ctx = ictx;
      // 翡翠光環
      ctx.fillStyle = 'rgba(105, 240, 174, 0.25)';
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
      // 主葉片
      ctx.save(); ctx.rotate(-0.35);
      const leafGrad = ctx.createLinearGradient(0, -14, 0, 14);
      leafGrad.addColorStop(0, '#b9f6ca'); leafGrad.addColorStop(0.5, '#00e676'); leafGrad.addColorStop(1, '#1b5e20');
      ctx.fillStyle = leafGrad;
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.quadraticCurveTo(12, -4, 0, 14);
      ctx.quadraticCurveTo(-12, -4, 0, -14);
      ctx.fill();
      // 葉脈
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(0, 12); ctx.stroke();
      ctx.restore();
      // 副小葉
      ctx.save(); ctx.rotate(0.65);
      ctx.fillStyle = '#69f0ae';
      ctx.beginPath();
      ctx.moveTo(0, -8); ctx.quadraticCurveTo(8, -2, 0, 10); ctx.quadraticCurveTo(-8, -2, 0, -8);
      ctx.fill();
      ctx.restore();
      // 晶瑩露珠
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-2, -3, 2, 0, Math.PI * 2); ctx.fill();
      ictx.restore();
    } else if (iconKey === 'gold_interest') {
      // 🪙 利滾利息 / 銀行金庫：金幣山丘 + 閃亮四角星芒
      ictx.save();
      ictx.scale(width / 44, height / 44);
      const ctx = ictx;
      // 金色光環
      ctx.fillStyle = 'rgba(255, 215, 0, 0.25)';
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
      // 金幣堆
      const coinPositions = [[-6, 3], [6, 3], [0, -4], [-3, 7], [4, 7]];
      coinPositions.forEach(([cx, cy]) => {
        const cg = ctx.createLinearGradient(cx - 5, cy - 5, cx + 5, cy + 5);
        cg.addColorStop(0, '#fff59d'); cg.addColorStop(0.5, '#ffd600'); cg.addColorStop(1, '#ff8f00');
        ctx.fillStyle = cg; ctx.strokeStyle = '#e65100'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e65100'; ctx.font = '900 5.5px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('$', cx, cy);
      });
      // 閃爍星芒
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(8, -10); ctx.lineTo(10, -8); ctx.lineTo(8, -6); ctx.lineTo(6, -8); ctx.closePath(); ctx.fill();
      ictx.restore();
    } else {
      // 通用回退圖示
      ictx.font = `${Math.round(width * 0.55)}px sans-serif`;
      ictx.textAlign = 'center';
      ictx.textBaseline = 'middle';
      ictx.fillText(talent.icon || '✨', 0, 0);
    }
    ictx.restore();
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
    } else if (key === 'solar_wrath' || key === 'solar-wrath') {
      // ─── ☀️ 日輪天罰・金耀天劫 (耀陽八芒光冕 + 金耀神聖核心 + 審判烈芒) ───
      ctx.save();
      ctx.scale(0.85, 0.85);

      // 1. 最外層日冕神聖金色光暈 (脈動)
      const pulse = 1 + Math.sin(time * 6) * 0.08;
      ctx.fillStyle = 'rgba(255, 215, 0, 0.28)';
      ctx.beginPath();
      ctx.arc(0, 0, 17 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // 2. 旋轉 8 芒日輪尖芒
      ctx.save();
      ctx.rotate(time * 0.5);
      ctx.fillStyle = '#ffb300';
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.lineTo(3.5, -9);
        ctx.lineTo(-3.5, -9);
        ctx.closePath();
        ctx.fill();
        ctx.rotate(Math.PI / 4);
      }
      ctx.restore();

      // 3. 內層交錯 8 芒烈焰尖芒
      ctx.save();
      ctx.rotate(-time * 0.3 + Math.PI / 8);
      ctx.fillStyle = '#ff9100';
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(0, -14);
        ctx.lineTo(2.5, -7);
        ctx.lineTo(-2.5, -7);
        ctx.closePath();
        ctx.fill();
        ctx.rotate(Math.PI / 4);
      }
      ctx.restore();

      // 4. 金陽外環
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.stroke();

      // 5. 金黃耀眼核心漸層
      const sunGrad = ctx.createRadialGradient(0, 0, 1, 0, 0, 9);
      sunGrad.addColorStop(0, '#ffffff');
      sunGrad.addColorStop(0.4, '#fff59d');
      sunGrad.addColorStop(0.8, '#ffd700');
      sunGrad.addColorStop(1, '#ff6d00');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();

      // 6. 核心高光白點
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(-2, -2, 2.5, 0, Math.PI * 2);
      ctx.fill();

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
    const solarCv = document.getElementById('skill-canvas-solar_wrath');
    if (solarCv) this.drawSkillIcon(solarCv.getContext('2d'), 'solar_wrath');
    const titleCv = document.getElementById('menu-title-canvas');
    if (titleCv) this.drawTitleTree(titleCv.getContext('2d'));
  }

  // ─── UI Setup ───
  setupUI() {
    // 動態綁定程式設定的版本號
    const versionBadge = document.getElementById('menu-version-badge');
    if (versionBadge) {
      versionBadge.textContent = `${IS_DEV_BUILD ? '開發版' : '正式版'} ${CONFIG.VERSION}`;
    }

    // 繪製專屬技能 Canvas 圖標 (完全告別 Emoji)
    const meteorCv = document.getElementById('skill-canvas-meteor');
    if (meteorCv) this.drawSkillIcon(meteorCv.getContext('2d'), 'meteor');

    const freezeCv = document.getElementById('skill-canvas-freeze');
    if (freezeCv) this.drawSkillIcon(freezeCv.getContext('2d'), 'freeze');

    const solarCv = document.getElementById('skill-canvas-solar_wrath');
    if (solarCv) this.drawSkillIcon(solarCv.getContext('2d'), 'solar_wrath');

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

    // 模式切換按鈕 (主線戰役 vs 幻境秘境)
    const setGameMode = (mode) => {
      CURRENT_GAME_MODE = mode;
      CURRENT_LEVEL_INDEX = 0;
      document.getElementById('mode-tab-campaign')?.classList.toggle('active', mode === GAME_MODES.CAMPAIGN);
      document.getElementById('mode-tab-roguelike')?.classList.toggle('active', mode === GAME_MODES.ROGUELIKE);
      this.renderLevelCarousel();
      this.sfx.play('tap');
    };
    bindTap('mode-tab-campaign', () => setGameMode(GAME_MODES.CAMPAIGN));
    bindTap('mode-tab-roguelike', () => setGameMode(GAME_MODES.ROGUELIKE));

    // 關卡輪探初始化
    this.renderLevelCarousel();
    this.setupLevelStarTip();

    bindTap('start-btn', () => {
      if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE && this.hasRogueSession()) {
        this.resumeRogueGame();
      } else {
        this.startGame();
      }
    });
    bindTap('rogue-abandon-btn', () => {
      const ok = window.confirm('確定要放棄當前暫存的幻境進度，從第 1 波重新開始嗎？');
      if (ok) {
        this.clearRogueSession();
        this.renderLevelCarousel();
        this.showToast('已清除暫存進度，可重新開始第 1 波');
      }
    });
    bindTap('level-prev-btn', () => this.changeLevel(-1));
    bindTap('level-next-btn', () => this.changeLevel(1));
    bindTap('start-wave-btn', () => this.startNextWave());
    bindTap('retry-btn', () => this.restartGame());
    bindTap('replay-btn', () => this.restartGame());
    bindTap('next-level-btn', () => this.playNextLevel());
    bindTap('gameover-menu-btn', () => this.quitToMenu());
    bindTap('victory-menu-btn', () => this.quitToMenu());
    bindTap('open-leaderboard-btn', () => this.openLeaderboardModal());
    bindTap('gameover-open-lb-btn', () => this.openLeaderboardModal());
    bindTap('victory-open-lb-btn', () => this.openLeaderboardModal());
    bindTap('close-leaderboard-btn', () => this.closeLeaderboardModal());
    bindTap('relic-btn', () => this.openAcquiredTalentsModal());
    bindTap('close-acquired-talents-btn', () => this.closeAcquiredTalentsModal());

    // ⚔️ 塔傷害統計彈窗開關
    bindTap('dps-btn', () => this.openDamageStatsModal());
    bindTap('close-damage-stats-btn', () => this.closeDamageStatsModal());

    bindTap('open-shop-btn', () => this.openShopModal());
    bindTap('reset-data-btn', () => {
      const ok = window.confirm('確定要重置所有資料嗎？已解鎖的塔/技能、水晶、通關進度、排行榜都會清空，且無法復原。');
      if (!ok) return;
      [
        LEVEL_PROGRESS_KEY,
        CRYSTALS_KEY,
        UNLOCKS_KEY,
        CONFIG.LS_KEY,
        ESSENCE_KEY,
        SPIRIT_TREE_LEVEL_KEY,
        'dd_td_leaderboard_v1',
        'dd_td_gold_leaderboard_v1',
      ].forEach(key => {
        try { localStorage.removeItem(key); } catch (e) {}
      });
      location.reload();
    });

    // 點精靈樹：開啟精靈樹升級面板
    bindTap('menu-title-canvas', () => {
      this.openSpiritTreeModal();
    });

    // 關卡輪探卡牌區塊：連點 5 下解鎖測試按鈕（Log／截圖永遠不開放，不受此影響）
    let secretTapCount = 0;
    let secretTapLastTime = 0;
    bindTap('level-carousel-card', () => {
      const now = Date.now();
      if (now - secretTapLastTime > 2000) secretTapCount = 0;
      secretTapLastTime = now;
      secretTapCount++;
      if (secretTapCount >= 5) {
        secretTapCount = 0;
        const testToggleBtn = document.getElementById('debug-test-toggle-btn');
        if (testToggleBtn && testToggleBtn.style.display === 'none') {
          testToggleBtn.style.display = '';
          this.showToast('🧪 測試按鈕已解鎖');
        }
      }
    });
    bindTap('close-shop-btn', () => this.closeShopModal());
    bindTap('close-spirit-tree-btn', () => this.closeSpiritTreeModal());
    bindTap('spirit-tree-upgrade-btn', () => {
      const result = upgradeSpiritTree();
      if (result.ok) {
        this.sfx.play('upgrade');
        this.showToast(`🌳 精靈樹升級到 Lv.${result.level}！`);
      } else if (result.reason === 'insufficient') {
        this.sfx.play('error');
        this.showToast('✨ 精華不足');
      }
      this.renderSpiritTreeModal();
      this.updateSpiritTreeUpBadge();
    });
    
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

  getActiveLevelList() {
    return CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE ? ROGUELIKE_LEVEL_DATA : LEVEL_DATA;
  }

  // 解鎖是連續的（解鎖第 N 關必先通關第 N-1 關）。可瀏覽範圍 = 已解鎖的關卡，
  // 再加上緊接在解鎖前線後面的「下一個尚未解鎖」關卡（讓玩家能預覽鎖著的下一關），
  // 但不能再往後預覽更遠的關卡。
  getMaxBrowsableLevelIndex() {
    const list = this.getActiveLevelList();
    if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
      return list.length - 1; // 肉鴿模式全關卡開放體驗
    }
    const progress = loadLevelProgress();
    let lastUnlockedIndex = -1;
    for (let i = 0; i < list.length; i++) {
      const entry = progress.levels[list[i].id];
      if (entry && entry.unlocked) {
        lastUnlockedIndex = i;
      } else {
        break;
      }
    }
    return Math.min(lastUnlockedIndex + 1, list.length - 1);
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
    const list = this.getActiveLevelList();
    if (CURRENT_LEVEL_INDEX >= list.length) CURRENT_LEVEL_INDEX = 0;
    const level = list[CURRENT_LEVEL_INDEX];
    const progress = loadLevelProgress();
    const isRogue = CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE;
    const entry = isRogue 
      ? { stars: 0, unlocked: true }
      : (progress.levels[level.id] || { stars: 0, unlocked: CURRENT_LEVEL_INDEX === 0 });

    // 套用該關卡的地圖（僅預覽用途，實際遊玩以 startGame() 的檢查為準）
    CURRENT_MAP_ID = level.mapId;
    this.map = new GameMap(level.mapId);
    this.renderMapToBuffer();

    const nameEl = document.getElementById('level-card-name');
    if (nameEl) nameEl.textContent = level.name;

    const badgeEl = document.getElementById('level-card-mode-badge');
    if (badgeEl) badgeEl.classList.toggle('hidden', !isRogue);

    const starsEl = document.getElementById('level-card-stars');
    if (starsEl) {
      if (isRogue) {
        let rogueBestWaves = {};
        try {
          rogueBestWaves = JSON.parse(localStorage.getItem('dd_td_rogue_best_waves_v1')) || {};
        } catch (e) {
          rogueBestWaves = {};
        }
        const bestWave = rogueBestWaves[level.id] || 0;
        starsEl.innerHTML = bestWave > 0 
          ? `<span style="font-size:12px;font-weight:800;color:#7c4dff;letter-spacing:0.5px;">最高紀錄：第 ${bestWave} 波</span>`
          : `<span style="font-size:12px;font-weight:700;color:#8d6e63;letter-spacing:0.5px;">尚未挑戰</span>`;
      } else {
        starsEl.innerHTML = [1, 2, 3].map(i => `<span class="${i <= entry.stars ? 'star-filled' : 'star-empty'}">★</span>`).join('');
      }
    }

    const lockEl = document.getElementById('level-lock-overlay');
    if (lockEl) lockEl.classList.toggle('hidden', entry.unlocked);

    dbgLog(`🗺️ 關卡輪探顯示：mode=${CURRENT_GAME_MODE} index=${CURRENT_LEVEL_INDEX} (${level.id}) unlocked=${entry.unlocked}`);

    const prevBtn = document.getElementById('level-prev-btn');
    if (prevBtn) prevBtn.disabled = (CURRENT_LEVEL_INDEX === 0);
    const nextBtn = document.getElementById('level-next-btn');
    if (nextBtn) nextBtn.disabled = (CURRENT_LEVEL_INDEX >= this.getMaxBrowsableLevelIndex());

    const startBtn = document.getElementById('start-btn');
    const startBtnText = document.getElementById('start-btn-text');
    const abandonBtn = document.getElementById('rogue-abandon-btn');

    if (isRogue && this.hasRogueSession()) {
      let sessionData = null;
      try {
        sessionData = JSON.parse(localStorage.getItem('dd_td_rogue_session_v1'));
      } catch (e) {}
      const resumeWave = (sessionData && typeof sessionData.currentWave === 'number') ? sessionData.currentWave + 1 : 1;
      if (startBtnText) startBtnText.textContent = `繼續幻境 (第 ${resumeWave} 波)`;
      if (abandonBtn) abandonBtn.classList.remove('hidden');
    } else {
      if (startBtnText) startBtnText.textContent = isRogue ? '開始挑戰' : '開始守衛';
      if (abandonBtn) abandonBtn.classList.add('hidden');
    }

    if (startBtn) startBtn.classList.toggle('btn-locked', !entry.unlocked);
  }

  // 按住關卡卡片顯示每顆星的寶箱獎勵，放開就消失（主線模式生效）
  setupLevelStarTip() {
    const card = document.getElementById('level-carousel-card');
    const tip = document.getElementById('level-star-tip');
    if (!card || !tip) return;

    const showTip = () => {
      if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) return;
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

    // 阻斷 iOS 快速雙擊觸發 Viewport Zoom：同一個位置附近、350ms 內點第二次才算雙擊。
    // 按鈕/榮譽榜彈窗過去被整個排除在外，理由是怕擋住點擊，但這樣快速連點按鈕
    // （例如商店「締結契約」）或在榮譽榜裡連點，就完全沒有防護，會被 iOS 判定成雙擊放大。
    // bindTap 綁定的按鈕本來就是靠自己的 touchend 處理點擊，不吃這裡的 preventDefault；
    // 商店這類用原生 click 事件的按鈕，最多只是「350ms 內同位置的第二下不會再觸發一次」，
    // 對一次性購買按鈕來說是好事（不會被連點誤買兩次）。
    //
    // 注意：判斷「是不是雙擊」一定要在 touchstart 當下就算好、記住結果給 touchend 用，
    // 不能讓 touchend 自己重新拿 lastTapTime 去比較——touchstart 結尾已經把 lastTapTime
    // 更新成「這次觸控自己」的時間，等這次的 touchend 觸發時再比一次，比出來的其實是
    // 「這次觸控按了多久」，一般正常點擊都遠小於 300ms，等於每次單純點擊都會被誤判成
    // 雙擊而擋掉，按鈕就完全點不到了。
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let currentTapIsDouble = false;
    const isDoubleTapExempt = (target) => target && (
      target.tagName === 'SELECT' ||
      target.tagName === 'OPTION' ||
      target.closest('select') ||
      target.closest('.level-carousel-card') ||
      target.closest('.tower-item') ||
      target.closest('.menu-champion-card') ||
      target.closest('#debug-container')
    );
    document.addEventListener('touchstart', (e) => {
      const now = Date.now();
      const touch = e.touches[0];
      currentTapIsDouble = !!touch
        && (now - lastTapTime <= 350)
        && Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 40;
      if (currentTapIsDouble && !isDoubleTapExempt(e.target) && e.cancelable) {
        e.preventDefault();
      }
      if (touch) {
        lastTapTime = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
      }
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      if (currentTapIsDouble && !isDoubleTapExempt(e.target) && e.cancelable) {
        e.preventDefault();
      }
    }, { passive: false });

    // 防止多指縮放手勢 (Pinch to zoom)，以及阻止 iOS 整頁被拖曳彈跳捲動
    // （overflow:hidden 對 iOS Safari 的整頁橡皮筋捲動無效，只有在允許捲動的區塊內才放行）
    document.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
        return;
      }
      const inScrollableArea = e.target && e.target.closest('.screen, #tower-list, #debug-log, #debug-test-panel, .talent-cards-container');
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

    document.getElementById('skill-solar_wrath-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSkillTargeting('solar_wrath');
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
      if (e.key === '3') {
        this.toggleSkillTargeting('solar_wrath');
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

    // 點擊起點出怪口或下方出怪徽章：直接觸發出怪開始波次（或在倒數時點擊直接提前出怪）
    if (this.map.pathPixels.length > 0) {
      const entry = this.map.pathPixels[0];
      const distToEntry = Math.hypot(px - entry.x, py - entry.y);
      // 擴大出怪口與出怪按鈕點擊判定範圍（涵蓋 entry 中心與下方 badge 區域）
      const inBadgeBox = (Math.abs(px - entry.x) <= 45 && py >= entry.y && py <= entry.y + 50);
      if (distToEntry <= CONFIG.CELL_SIZE * 0.8 || inBadgeBox) {
        if (this.state === 'planning') {
          this.startNextWave();
          return;
        }
        if (this.state === 'wave' && this.nextWaveCountdown !== null) {
          this.advanceToNextWave(true);
          return;
        }
      }
    }

    // Placing a tower
    if (this.selectedTowerType) {
      this.placeTower(col, row);
      return;
    }

    // 1. 優先檢測：是否點擊了任何防禦塔上方的「懸浮升級星星按鈕」
    for (const tower of this.towers) {
      if (tower.level < CONFIG.MAX_LEVEL) {
        const upgradeCost = tower.getUpgradeCost();
        if (upgradeCost !== null && this.gold >= upgradeCost) {
          // 星星按鈕位於 (tower.x, tower.y - 34)，半徑判定寬容度 18px (方便手機觸控點擊)
          const btnX = tower.x;
          const btnY = tower.y - 34;
          const distToStar = Math.hypot(px - btnX, py - btnY);
          if (distToStar <= 18) {
            this.gold -= upgradeCost;
            tower.upgrade();
            this.sfx.play('upgrade');
            this.showToast(`⭐ ${tower.data.name} 升級到 Lv.${tower.level}！`);
            if (this.selectedTower === tower) {
              this.showTowerInfo(tower);
            }
            this.updateUI();
            return;
          }
        }
      }
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
    if (skillKey === 'solar_wrath') {
      if (typeof relicManager === 'undefined' || !relicManager.hasHidden('solar_wrath')) {
        this.showToast('🔒 尚未領悟【日輪天罰】天賦！');
        this.sfx.play('error');
        return;
      }
      if (this.state !== 'wave') {
        this.showToast('戰鬥開始後才能施放技能！');
        this.sfx.play('error');
        return;
      }
      const skill = this.skills.solar_wrath;
      if (skill && skill.timer > 0) {
        this.showToast(`天罰冷卻中 (${Math.ceil(skill.timer)} 秒)`);
        this.sfx.play('error');
        return;
      }
      this.castSolarWrath();
      return;
    }

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

    // 範圍傷害判定（技能為「真實傷害」，無視所有敵人抗性，不歸屬任何塔的傷害類型）
    let hitCount = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const d = dist(px, py, enemy.x, enemy.y);
      if (d <= skill.range) {
        enemy.takeDamage(skill.damage, null, 0, 0, 0, 'true', this);
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

    // 全體怪物定身並凍結（緩速免疫怪不受定身影響）
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      if (enemy.immuneSlow) {
        this.spawnParticle(enemy.x, enemy.y - 15, {
          text: '💨 免疫',
          color: '#00e676',
          fontSize: 12,
          vx: 0,
          vy: -30,
          gravity: 0,
          life: 0.8
        });
        continue;
      }
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

  castSolarWrath() {
    if (this.state !== 'wave') return;
    const skill = this.skills.solar_wrath;
    const currentGold = this.gold || 0;
    const cost = Math.floor(currentGold * 0.10);
    if (cost < 1) {
      this.showToast('🪙 金幣不足 10，無法消耗 10% 引導天罰！');
      this.sfx.play('error');
      return;
    }

    // 扣除 10% 現有金幣
    this.gold -= cost;
    this.updateUI();
    if (skill) skill.timer = skill.cd;

    this.sfx.play('explosion');
    this.showToast(`☀️ 日輪天罰！消耗 ${cost} 金幣，全場造成 ${cost} 毀滅傷害！`);

    // 螢幕震動
    if (navigator.vibrate) navigator.vibrate([150, 60, 150]);

    // 全場天罰日輪金色光柱與神聖粒子
    for (let i = 0; i < 35; i++) {
      this.spawnParticle(Math.random() * CANVAS_W, Math.random() * CANVAS_H, {
        color: Math.random() < 0.6 ? '#ffd700' : '#fff59d',
        size: 3 + Math.random() * 5,
        vx: (Math.random() - 0.5) * 160,
        vy: (Math.random() - 0.5) * 160 - 40,
        gravity: 60,
        life: 0.8 + Math.random() * 0.4
      });
    }

    // 全場存活敵人受到等同消耗金幣的真實傷害
    let hitCount = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.takeDamage(cost, null, 0, 0, 0, 'true', this);
      this.spawnParticle(enemy.x, enemy.y, {
        color: '#ffea00',
        size: 4,
        vx: (Math.random() - 0.5) * 120,
        vy: (Math.random() - 0.5) * 120,
        gravity: 0,
        life: 0.5
      });
      hitCount++;
    }

    this.spawnParticle(CANVAS_W / 2, CANVAS_H / 2 - 40, {
      text: `☀️ -${cost} (天罰)`,
      color: '#ffd700',
      fontSize: 24,
      vx: 0,
      vy: -50,
      gravity: 0,
      life: 1.5
    });
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

  resetSkills() {
    this.activeTargetingSkill = null;
    this.skills.meteor.timer = 0;
    this.skills.freeze.timer = 0;
    if (this.skills.solar_wrath) this.skills.solar_wrath.timer = 0;
    document.getElementById('skill-meteor-btn')?.classList.remove('targeting', 'on-cd');
    document.getElementById('skill-freeze-btn')?.classList.remove('targeting', 'on-cd');
    document.getElementById('skill-solar_wrath-btn')?.classList.remove('targeting', 'on-cd');
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

    const solarWrathBtn = document.getElementById('skill-solar_wrath-btn');
    if (solarWrathBtn && this.skills.solar_wrath) {
      const s = this.skills.solar_wrath;
      const onCd = s.timer > 0;
      solarWrathBtn.classList.toggle('on-cd', onCd);
      const overlay = solarWrathBtn.querySelector('.skill-cd-overlay');
      const text = solarWrathBtn.querySelector('.skill-cd-text');
      if (overlay) overlay.style.transform = `scaleY(${s.timer / s.cd})`;
      if (text) text.textContent = onCd ? Math.ceil(s.timer) : '';
    }
  }

  // 更新技能快捷欄鎖定與顯示狀態（日輪天罰只在學會天賦時顯示）
  updateSkillBarLockState() {
    const solarWrathBtn = document.getElementById('skill-solar_wrath-btn');
    if (solarWrathBtn) {
      const hasSolar = typeof relicManager !== 'undefined' && relicManager.hasHidden('solar_wrath');
      solarWrathBtn.style.display = hasSolar ? 'flex' : 'none';
      if (hasSolar) {
        const canvas = document.getElementById('skill-canvas-solar_wrath');
        if (canvas) this.drawSkillIcon(canvas.getContext('2d'), 'solar_wrath');
      }
    }

    const meteorBtn = document.getElementById('skill-meteor-btn');
    if (meteorBtn) {
      const unlocked = isSkillUnlocked('meteor');
      meteorBtn.classList.toggle('locked-skill', !unlocked);
      meteorBtn.style.display = unlocked ? 'flex' : 'none';
    }

    const freezeBtn = document.getElementById('skill-freeze-btn');
    if (freezeBtn) {
      const unlocked = isSkillUnlocked('freeze');
      freezeBtn.classList.toggle('locked-skill', !unlocked);
      freezeBtn.style.display = unlocked ? 'flex' : 'none';
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
    this.saveRogueSession();

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
      statsHtml += `💰 產金：+${stats.goldPerSecond}/5秒（僅出怪時生效）`;
    } else {
      const dmgTypeBadge = getDamageTypeBadge(tower.data.damageType);
      if (dmgTypeBadge) statsHtml += `<span class="role-badge ${dmgTypeBadge.cls}" style="margin-bottom:4px;">${dmgTypeBadge.text}</span><br>`;
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
      statsHtml += `💰 產金：+${data.goldPerSecond}/5秒 (波次進行中自動獲得)`;
    } else {
      const dmgTypeBadge = getDamageTypeBadge(data.damageType);
      if (dmgTypeBadge) statsHtml += `<span class="role-badge ${dmgTypeBadge.cls}" style="margin-bottom:4px;">${dmgTypeBadge.text}</span><br>`;
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
    this.saveRogueSession();
  }

  sellTower() {
    if (!this.selectedTower) return;
    const value = this.selectedTower.getSellValue();
    const key = `${this.selectedTower.col},${this.selectedTower.row}`;
    const typeKey = this.selectedTower.typeKey;
    // 將已賣掉防禦塔的累積傷害存入全域本局統計
    if (this.typeTotalDamage) {
      this.typeTotalDamage[typeKey] = (this.typeTotalDamage[typeKey] || 0) + (this.selectedTower.totalDamageDealt || 0);
    }
    delete this.towerGrid[key];
    this.towers = this.towers.filter((t) => t !== this.selectedTower);
    this.gold += value;
    this.sfx.play('sell');
    this.showToast(`💰 出售獲得 ${value} 金幣`);
    this.deselectTower();
    this.updateUI();
    this.updateTowerPanel();
    this.saveRogueSession();
  }

  // ─── Wave management ───
  advanceToNextWave(isEarlySkip = false) {
    if (this.nextWaveCountdown === null && this.state !== 'planning') return;
    this.nextWaveCountdown = null;
    this.currentWave++;

    // 遺物每波結束 Hook
    if (typeof relicManager !== 'undefined') {
      relicManager.onWaveEnd(this.currentWave, this);
    }

    const isRogue = CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE;
    
    // 🔮 幻境秘境：每往後一波即時持久化記錄最高波次（即使重新整理或中途離開亦能保留）
    if (isRogue) {
      try {
        const list = this.getActiveLevelList();
        const levelId = list[CURRENT_LEVEL_INDEX]?.id || 'rogue_1';
        const rogueKey = 'dd_td_rogue_best_waves_v1';
        const rogueBestWaves = JSON.parse(localStorage.getItem(rogueKey)) || {};
        const currentWaveNum = this.currentWave + 1;
        if (!rogueBestWaves[levelId] || currentWaveNum > rogueBestWaves[levelId]) {
          rogueBestWaves[levelId] = currentWaveNum;
          localStorage.setItem(rogueKey, JSON.stringify(rogueBestWaves));
        }
      } catch (e) {
        console.warn('Rogue best wave live save error:', e);
      }
    }

    // 🔮 幻境秘境：統一每滿 5 波（第 5, 10, 15, 20... 波）觸發三選一神力抽卡
    if (isRogue && this.currentWave % 5 === 0) {
      this.openTalentPickModal();
    } else {
      this.state = 'wave';
      this.waveManager.startWave(this.currentWave);
      if (typeof relicManager !== 'undefined') {
        relicManager.onWaveStart(this.currentWave, this);
      }
      this.sfx.play('wave');
      if (isEarlySkip) {
        this.showToast(`第 ${this.currentWave + 1} 波提早降臨！`);
      } else {
        this.showToast(`第 ${this.currentWave + 1} 波降臨！`);
      }
    }
    this.saveRogueSession();
    this.updateUI();
  }

  startNextWave() {
    if (this.state !== 'planning' && this.state !== 'wave') return;
    this.nextWaveCountdown = null;
    this.state = 'wave';
    this.waveManager.startWave(this.currentWave);
    if (typeof relicManager !== 'undefined') {
      relicManager.onWaveStart(this.currentWave, this);
    }
    this.sfx.play('wave');
    if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
      try {
        const list = this.getActiveLevelList();
        const levelId = list[CURRENT_LEVEL_INDEX]?.id || 'rogue_1';
        const rogueKey = 'dd_td_rogue_best_waves_v1';
        const rogueBestWaves = JSON.parse(localStorage.getItem(rogueKey)) || {};
        const currentWaveNum = this.currentWave + 1;
        if (!rogueBestWaves[levelId] || currentWaveNum > rogueBestWaves[levelId]) {
          rogueBestWaves[levelId] = currentWaveNum;
          localStorage.setItem(rogueKey, JSON.stringify(rogueBestWaves));
        }
      } catch (e) {
        console.warn('Rogue best wave live save error:', e);
      }
    }
    if (this.currentWave === 9) {
      this.showToast(`👑 第 10 波：中繼領主 (Mid-Boss) 來襲！`);
    } else if (this.currentWave === 14) {
      this.showToast(`🔥 第 15 波：終極魔王 (Final Boss) 決戰！`);
    } else {
      this.showToast(`🌊 第 ${this.currentWave + 1} 波開始！`);
    }
    const startWaveBtn = document.getElementById('start-wave-btn');
    if (startWaveBtn) startWaveBtn.disabled = true;
    this.selectedTowerType = null;
    this.updateTowerPanel();
    this.updateUI();
    this.saveRogueSession();
  }

  triggerNextWaveAutoCountdown() {
    // 檢查是否還有下一波（主線戰役最後一波出完後不再倒數下一波；幻境模式為無盡倒數）
    if (CURRENT_GAME_MODE !== GAME_MODES.ROGUELIKE && this.currentWave + 1 >= CONFIG.TOTAL_WAVES) return;
    if (this.nextWaveCountdown !== null) return;
    this.nextWaveCountdown = 15.0;
    dbgLog(`⏱️ 最後一隻怪已出！第 ${this.currentWave + 2} 波倒數 15 秒後自動降臨（前 5 秒不顯示倒數 UI，剩 10 秒才開始顯示）`);
  }

  checkWaveComplete() {
    if (this.state !== 'wave') return;
    if (!this.waveManager.isComplete(this.enemies)) return;

    dbgLog(`🎉 [Wave] 全部波次擊殺完畢，觸發通關結算！`);
    const bonus = this.waveManager.getWaveBonus(this.currentWave);
    this.addGold(bonus);
    this.score += bonus;
    this.showToast(`✅ 全部波次完成！獎勵 💰${bonus}`);
    this.sfx.play('wave');
    this.victory();
    this.updateUI();
  }

  // ─── 🔮 幻境中斷即時存檔與接關系統 ───
  saveRogueSession() {
    if (CURRENT_GAME_MODE !== GAME_MODES.ROGUELIKE) return;
    if (this.state === 'gameover' || this.state === 'victory' || this.state === 'menu') return;
    try {
      const list = this.getActiveLevelList();
      const level = list[CURRENT_LEVEL_INDEX] || ROGUELIKE_LEVEL_DATA[0];
      const sessionData = {
        levelId: level.id,
        levelIndex: CURRENT_LEVEL_INDEX,
        currentWave: this.currentWave,
        gold: this.gold,
        lives: this.lives,
        score: this.score,
        // 保存場上防禦塔陣型與各塔傷害
        towers: this.towers.map(t => ({
          col: t.col,
          row: t.row,
          typeKey: t.typeKey,
          level: t.level,
          totalDamageDealt: t.totalDamageDealt || 0
        })),
        // 歷史賣塔傷害累積
        typeTotalDamage: { ...(this.typeTotalDamage || {}) },
        // 完整神力天賦進度
        relicState: relicManager.exportState(),
        timestamp: Date.now()
      };
      localStorage.setItem('dd_td_rogue_session_v1', JSON.stringify(sessionData));
      dbgLog(`💾 [Rogue Save] 已自動儲存第 ${this.currentWave + 1} 波幻境進度 (金幣:${this.gold}, 塔數:${this.towers.length})`);
    } catch (e) {
      console.warn('Rogue session save error:', e);
    }
  }

  hasRogueSession() {
    try {
      const raw = localStorage.getItem('dd_td_rogue_session_v1');
      if (!raw) return false;
      const data = JSON.parse(raw);
      return !!(data && typeof data.currentWave === 'number' && data.levelId);
    } catch (e) {
      return false;
    }
  }

  clearRogueSession() {
    try {
      localStorage.removeItem('dd_td_rogue_session_v1');
      dbgLog('🗑️ [Rogue Save] 已清除幻境中斷存檔');
    } catch (e) {
      console.warn('Clear rogue session error:', e);
    }
  }

  resumeRogueGame() {
    try {
      const raw = localStorage.getItem('dd_td_rogue_session_v1');
      if (!raw) {
        this.showToast('⚠️ 查無暫存進度，重新開始新挑戰');
        this.startGame();
        return;
      }
      const data = JSON.parse(raw);
      CURRENT_GAME_MODE = GAME_MODES.ROGUELIKE;
      CURRENT_LEVEL_INDEX = typeof data.levelIndex === 'number' ? data.levelIndex : 0;
      const list = this.getActiveLevelList();
      const level = list[CURRENT_LEVEL_INDEX] || ROGUELIKE_LEVEL_DATA[0];

      // 地圖與波次核心初始化
      CURRENT_MAP_ID = level.mapId;
      this.map = new GameMap(level.mapId);
      this.renderMapToBuffer();
      this.waveManager = new WaveManager(level.waves);

      // 還原基礎數值
      this.gold = typeof data.gold === 'number' ? data.gold : getStartingGold();
      this.lives = typeof data.lives === 'number' ? data.lives : getStartingLives();
      this.score = typeof data.score === 'number' ? data.score : 0;
      this.currentWave = typeof data.currentWave === 'number' ? data.currentWave : 0;
      this.speedMultiplier = 1;

      // 還原歷史賣塔傷害
      this.typeTotalDamage = {};
      for (const key in TOWER_DATA) {
        this.typeTotalDamage[key] = (data.typeTotalDamage && data.typeTotalDamage[key]) || 0;
      }

      // 還原防禦塔
      this.towers = [];
      this.towerGrid = {};
      if (Array.isArray(data.towers)) {
        for (const tInfo of data.towers) {
          const tower = new Tower(tInfo.typeKey, tInfo.col, tInfo.row);
          tower.level = tInfo.level || 1;
          tower.totalDamageDealt = tInfo.totalDamageDealt || 0;
          this.towers.push(tower);
          this.towerGrid[`${tInfo.col},${tInfo.row}`] = tower;
        }
      }

      // 還原神力天賦
      if (typeof relicManager !== 'undefined' && data.relicState) {
        relicManager.importState(data.relicState, this);
        this.updateRelicBarUI();
      }

      this.enemies = [];
      this.projectiles = [];
      this.particles = [];
      this.selectedTower = null;
      this.selectedTowerType = null;
      this.nextWaveCountdown = null; // 恢復時絕不自動倒數，等玩家準備好點擊開始

      // 關閉開始選單與各彈窗
      const menu = document.getElementById('menu-screen');
      if (menu) {
        menu.classList.add('hidden');
        menu.style.display = 'none';
      }
      document.getElementById('gameover-screen').classList.add('hidden');
      document.getElementById('victory-screen').classList.add('hidden');
      document.getElementById('talent-pick-modal')?.classList.add('hidden');
      document.getElementById('acquired-talents-modal')?.classList.add('hidden');
      document.getElementById('damage-stats-modal')?.classList.add('hidden');

      this.state = 'planning';
      const startWaveBtn = document.getElementById('start-wave-btn');
      if (startWaveBtn) startWaveBtn.disabled = false;
      document.getElementById('speed-btn').textContent = '1x';

      this.resetSkills();
      this.updateSkillBarLockState();
      this.deselectTower();
      this.updateWavePreview();
      this.updateUI();
      this.updateTowerPanel();
      this.resizeCanvas();

      this.sfx.init();
      this.sfx.resume();
      this.sfx.play('tap');

      this.showToast(`幻境進度已恢復！第 ${this.currentWave + 1} 波，準備好後點擊【開始波次】`);
      dbgLog(`🚀 [Rogue Resume] 成功恢復第 ${this.currentWave + 1} 波戰局！`);
    } catch (e) {
      console.error('Resume rogue error:', e);
      this.showToast('讀取存檔失敗，重新開始新挑戰');
      this.startGame();
    }
  }

  // ─── Game state ───
  startGame() {
    // 開啟全新局前清空先前的中斷存檔
    if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
      this.clearRogueSession();
    }
    const list = this.getActiveLevelList();
    const level = list[CURRENT_LEVEL_INDEX];
    const isRogue = CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE;
    const progress = loadLevelProgress();
    const entry = isRogue ? { unlocked: true } : (progress.levels[level.id] || { unlocked: CURRENT_LEVEL_INDEX === 0 });
    if (!entry.unlocked) {
      this.showToast('🔒 請先通關上一關才能解鎖！');
      return;
    }
    // 確保本局波次資料對應目前選擇的關卡
    this.waveManager = new WaveManager(level.waves);
    // 重新套用精靈樹加成（避免升級後未反映在生命/金幣初始值上）
    this.gold = getStartingGold();
    this.lives = getStartingLives();
    this.updateSkillBarLockState();

    // 🔮 重置遺物管理器
    if (typeof relicManager !== 'undefined') {
      relicManager.reset(CURRENT_GAME_MODE);
      this.updateRelicBarUI();
    }

    dbgLog('🎮 startGame triggered! mode=' + CURRENT_GAME_MODE);
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
    this.resetSkills();
    this.showToast(isRogue ? '幻境秘境啟動！每 5 波可選一項神力賜福！' : '放置防禦塔，然後開始波次！');
    this.updateWavePreview();
    this.updateUI();
    this.resizeCanvas();
    dbgLog('🚀 Game state is now PLANNING');
  }

  restartGame() {
    const list = this.getActiveLevelList();
    const level = list[CURRENT_LEVEL_INDEX];
    this.map = new GameMap(CURRENT_MAP_ID);
    this.renderMapToBuffer();
    this.gold = getStartingGold();
    this.lives = getStartingLives();
    this.score = 0;
    this.currentWave = 0;
    this.speedMultiplier = 1;
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.particles = [];
    this.towerGrid = {};
    this.typeTotalDamage = {};
    for (const key in TOWER_DATA) this.typeTotalDamage[key] = 0;
    this.selectedTower = null;
    this.selectedTowerType = null;
    this.waveManager = new WaveManager(level.waves);
    this.state = 'planning';
    this.resetSkills();

    // 重置遺物
    if (typeof relicManager !== 'undefined') {
      relicManager.reset(CURRENT_GAME_MODE);
      this.updateRelicBarUI();
    }
    this.updateSkillBarLockState();

    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('victory-screen').classList.add('hidden');
    document.getElementById('talent-pick-modal')?.classList.add('hidden');
    document.getElementById('acquired-talents-modal')?.classList.add('hidden');
    document.getElementById('damage-stats-modal')?.classList.add('hidden');
    const startWaveBtn = document.getElementById('start-wave-btn');
    if (startWaveBtn) startWaveBtn.disabled = false;
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
    this.clearRogueSession();
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
    this.clearRogueSession();
    this.score += this.lives * 50; // Bonus for remaining lives

    const lifeRatio = this.lives / getStartingLives();
    const stars = lifeRatio >= 1 ? 3 : (lifeRatio >= 0.5 ? 2 : 1);
    const { crystalsEarned, essenceEarned } = recordLevelResult(CURRENT_LEVEL_INDEX, stars);
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
    const vicEssenceEl = document.getElementById('victory-essence-reward');
    if (vicEssenceEl) {
      vicEssenceEl.textContent = essenceEarned > 0 ? `🌳 精靈樹精華：✨${essenceEarned}` : '';
      vicEssenceEl.classList.toggle('hidden', essenceEarned <= 0);
    }

    // 按鈕切換：3星通關且有下一關顯示「進入下一關」，未滿3星顯示「再試一次」
    const hasNextLevel = CURRENT_LEVEL_INDEX + 1 < LEVEL_DATA.length;
    const nextLvlBtn = document.getElementById('next-level-btn');
    const replayBtn = document.getElementById('replay-btn');
    
    if (stars >= 3 && hasNextLevel) {
      if (nextLvlBtn) nextLvlBtn.classList.remove('hidden');
      if (replayBtn) replayBtn.classList.add('hidden');
    } else {
      if (nextLvlBtn) nextLvlBtn.classList.add('hidden');
      if (replayBtn) {
        replayBtn.classList.remove('hidden');
        const span = replayBtn.querySelector('span');
        if (span) span.textContent = '再試一次';
      }
    }

    document.getElementById('victory-screen').classList.remove('hidden');
    this.enemies = [];
    this.projectiles = [];
  }

  playNextLevel() {
    if (CURRENT_LEVEL_INDEX + 1 >= LEVEL_DATA.length) {
      this.showToast('🎉 恭喜！您已通關目前所有關卡！');
      this.quitToMenu();
      return;
    }
    CURRENT_LEVEL_INDEX++;
    const nextLevel = LEVEL_DATA[CURRENT_LEVEL_INDEX];
    CURRENT_MAP_ID = nextLevel.mapId;
    this.map = new GameMap(nextLevel.mapId);
    this.renderMapToBuffer();
    this.waveManager = new WaveManager(nextLevel.waves);
    this.gold = getStartingGold();
    this.lives = getStartingLives();
    this.score = 0;
    this.currentWave = 0;
    this.speedMultiplier = 1;
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.particles = [];
    this.towerGrid = {};
    this.selectedTower = null;
    this.state = 'planning';
    this.resetSkills();

    // 跨關卡重置幻境神力天賦
    if (typeof relicManager !== 'undefined') {
      relicManager.reset(CURRENT_GAME_MODE);
      this.updateRelicBarUI();
    }
    this.updateSkillBarLockState();

    document.getElementById('victory-screen').classList.add('hidden');
    document.getElementById('speed-btn').textContent = '1x';
    const startWaveBtn = document.getElementById('start-wave-btn');
    if (startWaveBtn) startWaveBtn.disabled = false;

    this.deselectTower();
    this.updateWavePreview();
    this.updateUI();
    this.updateTowerPanel();
    this.showToast(`🚀 開始挑戰第 ${CURRENT_LEVEL_INDEX + 1} 關：${nextLevel.name}！`);
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
    document.getElementById('talent-pick-modal')?.classList.add('hidden');
    document.getElementById('acquired-talents-modal')?.classList.add('hidden');
    document.getElementById('damage-stats-modal')?.classList.add('hidden');

    // 重置遊戲進行中的單位與狀態
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.particles = [];
    this.towerGrid = {};
    this.typeTotalDamage = {};
    for (const key in TOWER_DATA) this.typeTotalDamage[key] = 0;
    this.selectedTower = null;
    this.selectedTowerType = null;
    this.gold = getStartingGold();
    this.lives = getStartingLives();
    this.score = 0;
    this.currentWave = 0;
    this.speedMultiplier = 1;
    this.waveManager = new WaveManager(this.getActiveLevelList()[CURRENT_LEVEL_INDEX].waves);
    this.resetSkills();

    if (typeof relicManager !== 'undefined') {
      relicManager.reset(CURRENT_GAME_MODE);
      this.updateRelicBarUI();
    }
    this.updateSkillBarLockState();
    const speedBtn = document.getElementById('speed-btn');
    if (speedBtn) speedBtn.textContent = '1x';

    const menuScore = document.getElementById('menu-best-score');
    if (menuScore) menuScore.textContent = this.bestScore;
    this.renderLevelCarousel(); // 回首頁時刷新關卡輪探（可能剛解鎖新關卡或拿到新星等）
    this.showToast('🏠 已返回首頁');
  }

  // ─── Roguelike 抽卡與遺物 UI 系統 ───
  openTalentPickModal() {
    this.previousState = this.state;
    this.state = 'paused';
    const modal = document.getElementById('talent-pick-modal');
    const container = document.getElementById('talent-card-container');
    if (!modal || !container) return;

    const cards = drawRandomTalents(3, this);
    if (cards.length === 0) {
      // 牌庫被抽乾，直接開始出怪
      this.state = 'wave';
      this.waveManager.startWave(this.currentWave);
      return;
    }

    container.innerHTML = cards.map(talent => {
      let iconHtml = '';
      if (talent.towerKey) {
        const towerKey = (talent.towerKey === 'ice') ? 'ice_crystal' : talent.towerKey;
        iconHtml = `<img class="talent-card-tower-img" src="assets/towers/tower_${towerKey}.svg" alt="${talent.name}" />`;
      } else {
        iconHtml = `<canvas class="talent-card-canvas" width="40" height="40" data-id="${talent.id}"></canvas>`;
      }
      return `
        <div class="talent-card rarity-${talent.rarity}" data-id="${talent.id}">
          <div class="talent-card-icon">${iconHtml}</div>
          <div class="talent-card-info">
            <div class="talent-card-title">
              <span>${talent.name}</span>
              <span class="talent-rarity-pill ${talent.rarity}">${talent.rarity}</span>
            </div>
            <div class="talent-card-desc">${talent.desc}</div>
          </div>
        </div>
      `;
    }).join('');

    // 繪製非塔專屬的特殊天賦圖標
    container.querySelectorAll('.talent-card-canvas').forEach(cv => {
      const talentId = cv.dataset.id;
      const t = cards.find(item => item.id === talentId);
      if (t) this.drawTalentIcon(cv.getContext('2d'), t, 40, 40);
    });

    // 綁定卡牌點擊事件
    container.querySelectorAll('.talent-card').forEach(cardEl => {
      cardEl.addEventListener('click', () => {
        const talentId = cardEl.dataset.id;
        const chosen = cards.find(t => t.id === talentId);
        if (chosen) {
          this.pickTalent(chosen);
        }
      });
    });

    modal.classList.remove('hidden');
    this.sfx.play('victory');
    dbgLog('🔮 進入 Roguelike 三選一神力賜福介面');
  }

  pickTalent(talent) {
    if (typeof relicManager !== 'undefined') {
      if (talent.kind === 'hidden') {
        relicManager.acquireHidden(talent.schoolKey, talent.hiddenId, this);
      } else {
        relicManager.acquireBranchLevel(talent.schoolKey, talent.branchId, this);
      }
    }
    this.sfx.play('upgrade');
    this.showToast(`✨ 獲得神力：【${talent.name}】！`);
    document.getElementById('talent-pick-modal')?.classList.add('hidden');
    this.updateRelicBarUI();
    this.updateSkillBarLockState();

    // 恢復遊戲並開始該波次
    this.state = 'wave';
    this.waveManager.startWave(this.currentWave);
    if (typeof relicManager !== 'undefined') {
      relicManager.onWaveStart(this.currentWave, this);
    }
    this.saveRogueSession();
    this.updateUI();
  }

  updateRelicBarUI() {
    const relicBtn = document.getElementById('relic-btn');
    const relicBtnCount = document.getElementById('relic-btn-count');
    if (!relicBtn) return;

    if (CURRENT_GAME_MODE !== GAME_MODES.ROGUELIKE || !relicManager.hasAnyProgress()) {
      relicBtn.classList.add('hidden');
      return;
    }

    let count = 0;
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        if (relicManager.getBranchLevel(branchId) > 0) count++;
      }
      for (const hidden of school.hidden) {
        if (relicManager.hasHidden(hidden.id)) count++;
      }
    }

    relicBtn.classList.remove('hidden');
    if (relicBtnCount) relicBtnCount.textContent = count;
  }

  // 取得該天賦分支在指定等級下的累計總效果文字
  getTalentCumulativeDesc(schoolKey, branchId, level) {
    const table = {
      ice_pierce: [
        '穿透 +1 體，減速強度提升 8%',
        '穿透 +2 體，減速強度提升 16%',
        '穿透 +4 體，減速強度提升 26%'
      ],
      ice_shatter: [
        '55px 範圍造成 20% 最大血量傷害（最高 250 點）',
        '70px 範圍造成 27% 最大血量傷害（最高 250 點）',
        '85px 範圍造成 34% 最大血量傷害（最高 250 點）+ 緩速 1.5 秒'
      ],
      ice_aura: [
        '100px 霜環，敵人跑速 -15%',
        '125px 霜環，跑速 -25%，受魔傷 +15%',
        '150px 霜環，跑速 -35%，受魔傷 +30%'
      ],
      toxin_potency: [
        '毒傷 +15%，持續時間 +1 秒',
        '毒傷 +32%，持續時間 +2 秒',
        '毒傷 +58%，持續時間 +3 秒'
      ],
      toxin_spread: [
        '中毒死亡時 60px 感染 70% 毒素',
        '中毒死亡時 75px 感染 100% 毒素',
        '中毒死亡時 95px 感染 100% 毒素（具備無限連鎖傳染）'
      ],
      toxin_corrosion: [
        '中毒受傷加深 +15%',
        '中毒受傷加深 +25%，跳毒頻率加快 30%',
        '中毒受傷加深 +40%，跳毒加快 30%，跑速 -20%'
      ],
      chain_reach: [
        '彈射 +1 次，彈射範圍 +12%',
        '彈射 +2 次，彈射範圍 +25%',
        '彈射 +3 次，彈射範圍 +40%'
      ],
      crit_strike: [
        '10% 機率造成 1.8 倍暴擊傷害',
        '15% 機率造成 2.0 倍暴擊傷害',
        '20% 機率造成 2.4 倍暴擊傷害'
      ],
      electromagnetic_field: [
        '電弧命中使敵人陷入 1.5 秒感電（受魔傷 +15%）',
        '感電增傷 +25%，彈射衰減降至 10%',
        '感電增傷 +40%，彈射傷害不再衰減（每擊 100%）'
      ],
      gold_boost: [
        '向日葵產金 +20%，每波結束 +40 金幣',
        '向日葵產金 +44%，每波結束 +80 金幣',
        '向日葵產金 +80%，每波結束 +120 金幣'
      ],
      tower_growth: [
        '全植物塔射速 +7.0%，射程 +5.0%',
        '全植物塔射速 +14.5%，射程 +10.3%',
        '全植物塔射速 +23.6%，射程 +15.8%'
      ],
      gold_interest: [
        '每波結束依現有金幣獲得 4% 利息（上限 +60 💰）',
        '每波結束依現有金幣獲得 7% 利息（上限 +120 💰）',
        '每波結束依現有金幣獲得 10% 利息（上限 +200 💰），全塔升級費 -15%'
      ],
      petal_speed: [
        '粉櫻箭射速 +20.0%，射程 +10.0%',
        '粉櫻箭射速 +50.0%，射程 +21.0%',
        '粉櫻箭射速 +95.0%，射程 +39.2%'
      ],
      petal_pierce_armor: [
        '粉櫻箭傷害 +25%，無視 30% 物理抗性',
        '粉櫻箭傷害 +56%，無視 60% 物理抗性',
        '粉櫻箭傷害 +111%，無視 100% 物理抗性（2.1 倍全額真傷）'
      ],
      petal_multishot: [
        '25% 機率散射 1 枚箭（60% 傷害）',
        '45% 機率散射 1 枚箭（80% 傷害）',
        '70% 機率散射 2 枚全額花箭'
      ],
      cannon_blast: [
        '爆炸半徑 +20px，傷害 +20%',
        '爆炸半徑 +40px，傷害 +50%',
        '爆炸半徑 +65px，傷害 +95%，中心 40px 雙倍傷害'
      ],
      cannon_scorched_earth: [
        '砲擊留下 2.5 秒焦土，燃燒 30/秒',
        '砲擊留下 4.0 秒焦土，燃燒 55/秒',
        '砲擊留下 5.5 秒焦土，燃燒 85/秒，跑速 -25%'
      ],
      cannon_cluster_shrapnel: [
        '爆炸噴射 4 枚彈片（每枚 35 物理傷害）',
        '爆炸噴射 6 枚彈片（每枚 60 物理傷害）',
        '爆炸噴射 8 枚彈片（每枚 95 物理傷害 + 微震擊退）'
      ],
      treant_entangle: [
        '古木定身減速強度 75%，持續時間 +1.0 秒',
        '古木定身減速強度 85%，持續時間 +2.0 秒',
        '古木定身減速強度 95%，持續時間 +3.5 秒'
      ],
      treant_thorns: [
        '處於定身/緩速目標受傷加深 +20%',
        '定身受傷加深 +35%，附帶 50px 劇烈震裂波',
        '定身受傷加深 +50%，每秒承受 100% 攻擊力真傷'
      ],
      treant_earthquake: [
        '攻擊範圍 +15px，震飛 60px 敵人打斷衝刺',
        '攻擊範圍 +35px，震波 100% 傷害 + 1 秒眩暈',
        '攻擊範圍 +60px，全圖 100px 震波全場怪物停滯 1.2 秒'
      ],
      laser_overcharge: [
        '日光雷射射速 +15%，貫穿 +1 體',
        '日光雷射射速 +38%，貫穿 +2 體',
        '日光雷射射速 +72%，貫穿 +4 體且穿透不衰減'
      ],
      laser_refract: [
        '穿透後 30% 機率折射副光束（50% 傷害）',
        '穿透後 50% 機率折射副光束（75% 傷害）',
        '穿透後 75% 機率折射 2 名敵人（100% 傷害）'
      ],
      laser_focus_beam: [
        '持續打擊同一敵人每次增傷 15%（最多 3 層 +45%）',
        '聚焦每層增傷 25%（最多 4 層 +100%），打擊 Boss +20%',
        '聚焦每層增傷 35%（最多 5 層 +175%），打擊 Boss +40%'
      ]
    };
    if (table[branchId] && table[branchId][level - 1]) {
      return table[branchId][level - 1];
    }
    const branch = TALENT_SCHOOLS[schoolKey]?.branches[branchId];
    return branch?.levels[level - 1]?.desc || '';
  }

  // ─── 自然神力累計總效果彈窗 ───
  openAcquiredTalentsModal() {
    if (this.state === 'menu' || this.state === 'gameover' || this.state === 'victory') return;
    this.previousState = this.state;
    this.state = 'paused';

    const modal = document.getElementById('acquired-talents-modal');
    const summaryContainer = document.getElementById('acquired-summary-list');
    const subtitle = document.getElementById('acquired-talents-subtitle');
    if (!modal || !summaryContainer) return;

    const acquiredList = [];
    for (const schoolKey in TALENT_SCHOOLS) {
      const school = TALENT_SCHOOLS[schoolKey];
      for (const branchId in school.branches) {
        const branch = school.branches[branchId];
        const level = relicManager.getBranchLevel(branchId);
        if (level > 0) {
          const meta = BRANCH_LEVEL_META[level];
          const visual = getTalentVisualInfo(schoolKey, branchId, null);
          acquiredList.push({
            id: `${branchId}_lv${level}`,
            schoolKey,
            branchId,
            level,
            name: `${branch.name} Lv.${level}`,
            desc: branch.levels[level - 1].desc,
            cumulativeDesc: this.getTalentCumulativeDesc(schoolKey, branchId, level),
            icon: branch.icon,
            rarity: meta.rarity,
            towerKey: visual.towerKey,
            specialIconKey: visual.specialIconKey,
          });
        }
      }
      for (const hidden of school.hidden) {
        if (relicManager.hasHidden(hidden.id)) {
          const visual = getTalentVisualInfo(schoolKey, null, hidden.id);
          acquiredList.push({
            id: hidden.id,
            schoolKey,
            hiddenId: hidden.id,
            name: hidden.name,
            desc: hidden.desc,
            cumulativeDesc: hidden.desc,
            icon: hidden.icon,
            rarity: hidden.rarity,
            towerKey: visual.towerKey,
            specialIconKey: visual.specialIconKey,
          });
        }
      }
    }

    if (subtitle) {
      subtitle.textContent = `本局累計已啟動 ${acquiredList.length} 項神力總效果`;
    }

    if (acquiredList.length === 0) {
      summaryContainer.innerHTML = `<div class="acquired-talents-empty" style="text-align:center;padding:24px 0;color:#a1887f;font-size:13px;font-weight:700;">本局尚未獲取任何神力天賦</div>`;
    } else {
      // 直接渲染「累計總效果」列表
      summaryContainer.innerHTML = acquiredList.map(talent => {
        let iconHtml = '';
        if (talent.towerKey) {
          const towerKey = (talent.towerKey === 'ice') ? 'ice_crystal' : talent.towerKey;
          iconHtml = `<img class="talent-card-tower-img" src="assets/towers/tower_${towerKey}.svg" alt="${talent.name}" />`;
        } else {
          iconHtml = `<canvas class="talent-card-canvas acquired-summary-canvas" width="40" height="40" data-id="${talent.id}"></canvas>`;
        }
        return `
          <div class="talent-card rarity-${talent.rarity} unclickable" data-id="${talent.id}">
            <div class="talent-card-icon">${iconHtml}</div>
            <div class="talent-card-info">
              <div class="talent-card-title">
                <span>${talent.name}</span>
                <span class="talent-rarity-pill ${talent.rarity}">${talent.rarity}</span>
              </div>
              <div class="talent-card-desc" style="color:#ffe082;font-weight:700;line-height:1.4;">${talent.cumulativeDesc}</div>
            </div>
          </div>
        `;
      }).join('');

      summaryContainer.querySelectorAll('.acquired-summary-canvas').forEach(cv => {
        const talentId = cv.dataset.id;
        const t = acquiredList.find(item => item.id === talentId);
        if (t) this.drawTalentIcon(cv.getContext('2d'), t, 40, 40);
      });
    }

    modal.classList.remove('hidden');
    this.sfx.play('tap');
    dbgLog('🔮 開啟自然神力累計效果面板');
  }

  closeAcquiredTalentsModal() {
    if (this.state === 'paused') {
      this.state = this.previousState || 'planning';
      this.previousState = null;
    }
    document.getElementById('acquired-talents-modal')?.classList.add('hidden');
    this.sfx.play('tap');
  }

  // ─── ⚔️ 各防禦塔總輸出傷害統計彈窗 ───
  openDamageStatsModal() {
    if (this.state === 'menu' || this.state === 'gameover' || this.state === 'victory') return;
    this.previousState = this.state;
    this.state = 'paused';

    const modal = document.getElementById('damage-stats-modal');
    const container = document.getElementById('damage-stats-list');
    const subtitle = document.getElementById('damage-stats-subtitle');
    if (!modal || !container) return;

    // 計算各種類塔的總傷害聚合（場上現存塔 + 本局已賣掉的塔）
    const typeDamageMap = {};
    let totalTeamDamage = 0;
    for (const key in TOWER_DATA) {
      typeDamageMap[key] = (this.typeTotalDamage && this.typeTotalDamage[key]) || 0;
    }
    for (const tower of this.towers) {
      typeDamageMap[tower.typeKey] = (typeDamageMap[tower.typeKey] || 0) + (tower.totalDamageDealt || 0);
    }
    for (const key in typeDamageMap) {
      totalTeamDamage += typeDamageMap[key];
    }

    // 依傷害高低降序排序（只顯示有實際造成傷害 dmg > 0 的塔，排除 0 傷或未攻擊的塔）
    const statsList = Object.keys(TOWER_DATA)
      .map(key => ({
        key,
        data: TOWER_DATA[key],
        dmg: Math.round(typeDamageMap[key] || 0),
        count: this.towers.filter(t => t.typeKey === key).length
      }))
      .filter(item => item.dmg > 0)
      .sort((a, b) => b.dmg - a.dmg);

    if (subtitle) {
      subtitle.textContent = `本局隊伍總輸出傷害：${Math.round(totalTeamDamage).toLocaleString()} 點`;
    }

    if (statsList.length === 0 || totalTeamDamage === 0) {
      container.innerHTML = `<div class="acquired-talents-empty" style="text-align:center;padding:24px 0;color:#a1887f;font-size:13px;font-weight:700;">防禦塔尚未造成任何戰鬥傷害</div>`;
    } else {
      container.innerHTML = statsList.map(item => {
        const pct = totalTeamDamage > 0 ? Math.round((item.dmg / totalTeamDamage) * 100) : 0;
        const iconKey = (item.key === 'ice') ? 'ice_crystal' : item.key;
        return `
          <div class="talent-card rarity-rare unclickable" style="border-color: rgba(255, 215, 0, 0.3);">
            <div class="talent-card-icon">
              <img class="talent-card-tower-img" src="assets/towers/tower_${iconKey}.svg" alt="${item.data.name}" />
            </div>
            <div class="talent-card-info" style="gap: 2px;">
              <div class="talent-card-title">
                <span>${item.data.name}</span>
                <span class="dps-val-text">${item.dmg.toLocaleString()} 點 (${pct}%)</span>
              </div>
              <div style="font-size: 10px; color: #bcaaa4;">場上現存：${item.count} 座 · 傷害類型：${item.data.damageType === 'magic' ? '🔮 魔法' : '🏹 物理'}</div>
              <div class="dps-bar-container">
                <div class="dps-bar-fill" style="width: ${Math.max(3, pct)}%;"></div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    modal.classList.remove('hidden');
    this.sfx.play('tap');
    dbgLog('⚔️ 開啟防禦塔傷害統計面板');
  }

  closeDamageStatsModal() {
    if (this.state === 'paused') {
      this.state = this.previousState || 'planning';
      this.previousState = null;
    }
    document.getElementById('damage-stats-modal')?.classList.add('hidden');
    this.sfx.play('tap');
  }

  closeAcquiredTalentsModal() {
    if (this.state === 'paused') {
      this.state = this.previousState || 'planning';
      this.previousState = null;
    }
    document.getElementById('acquired-talents-modal')?.classList.add('hidden');
    this.sfx.play('tap');
    dbgLog('▶️ 關閉已獲取神力天賦詳情面板');
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

      // 🔮 幻境秘境：記錄該關卡的個人最高生存波次
      if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
        try {
          const list = this.getActiveLevelList();
          const levelId = list[CURRENT_LEVEL_INDEX]?.id || 'rogue_1';
          const rogueKey = 'dd_td_rogue_best_waves_v1';
          const rogueBestWaves = JSON.parse(localStorage.getItem(rogueKey)) || {};
          const currentWaveNum = this.currentWave + 1;
          if (!rogueBestWaves[levelId] || currentWaveNum > rogueBestWaves[levelId]) {
            rogueBestWaves[levelId] = currentWaveNum;
            localStorage.setItem(rogueKey, JSON.stringify(rogueBestWaves));
          }
        } catch (e) {
          console.warn('Rogue best wave save error:', e);
        }
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

  updateSpiritTreeUpBadge() {
    const canUp = canUpgradeSpiritTree();
    const badge = document.getElementById('spirit-tree-up-badge');
    if (badge) {
      badge.classList.toggle('hidden', !canUp);
    }
    const sparkles = document.getElementById('spirit-tree-sparkles');
    if (sparkles) {
      sparkles.classList.toggle('hidden', !canUp);
    }
    const titleCv = document.getElementById('menu-title-canvas');
    if (titleCv) {
      titleCv.classList.toggle('spirit-tree-glowing', canUp);
    }
  }

  updateCrystalBalanceUI() {
    const balance = loadCrystals();
    const menuEl = document.getElementById('menu-crystal-balance');
    if (menuEl) menuEl.textContent = balance;
    const shopEl = document.getElementById('shop-crystal-balance');
    if (shopEl) shopEl.textContent = balance;
    this.updateSpiritTreeUpBadge();
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

  openSpiritTreeModal() {
    this.renderSpiritTreeModal();
    document.getElementById('spirit-tree-modal')?.classList.remove('hidden');
    this.sfx.play('tap');
  }

  closeSpiritTreeModal() {
    document.getElementById('spirit-tree-modal')?.classList.add('hidden');
    this.sfx.play('tap');
  }

  renderSpiritTreeModal() {
    const level = loadSpiritTreeLevel();
    const essence = loadEssence();
    const current = SPIRIT_TREE_LEVELS[level - 1];
    const maxed = level >= SPIRIT_TREE_LEVELS.length;

    const levelBadge = document.getElementById('spirit-tree-level-badge');
    if (levelBadge) levelBadge.textContent = `Lv.${level}`;
    const balanceEl = document.getElementById('spirit-tree-essence-balance');
    if (balanceEl) balanceEl.textContent = essence;
    const currentBonusEl = document.getElementById('spirit-tree-current-bonus');
    if (currentBonusEl) {
      currentBonusEl.textContent = level === 1
        ? current.desc
        : `💰 初始金幣 +${current.bonusGold} ・ ❤️ 初始生命 +${current.bonusLives}`;
    }

    const nextBox = document.getElementById('spirit-tree-next-box');
    const maxedText = document.getElementById('spirit-tree-maxed-text');
    if (nextBox) nextBox.classList.toggle('hidden', maxed);
    if (maxedText) maxedText.classList.toggle('hidden', !maxed);

    if (!maxed) {
      const next = SPIRIT_TREE_LEVELS[level];
      const nextBonusEl = document.getElementById('spirit-tree-next-bonus');
      if (nextBonusEl) nextBonusEl.textContent = `${next.desc}（需要 ✨${next.cost}）`;
      const upgradeBtn = document.getElementById('spirit-tree-upgrade-btn');
      if (upgradeBtn) {
        upgradeBtn.disabled = essence < next.cost;
        upgradeBtn.textContent = essence < next.cost ? `精華不足（${essence}/${next.cost}）` : `升級（消耗 ✨${next.cost}）`;
      }
    }
  }

  renderShopT1Card(item, balance) {
    const meta = SHOP_METADATA[item.key] || {
      icon: item.kind === 'skill' ? 'assets/skills/skill_meteor.svg' : 'assets/towers/tower_petal.svg',
      badges: [{ text: item.kind === 'skill' ? '☄️ 主動魔法' : '🌸 守護花靈', type: 'pierce' }],
      desc: item.desc || '',
      stats: { dmg: '-', range: '-', rate: '-' }
    };
    const canAfford = balance >= item.cost;
    const towerGoldCost = item.kind === 'tower' && TOWER_DATA[item.key] ? TOWER_DATA[item.key].cost : null;
    const dmgTypeBadge = item.kind === 'tower' ? getDamageTypeBadge(TOWER_DATA[item.key]?.damageType) : null;
    const dmgTypeBadgeHtml = dmgTypeBadge ? `<span class="role-badge ${dmgTypeBadge.cls}">${dmgTypeBadge.text}</span>` : '';
    const badgeHtml = dmgTypeBadgeHtml + meta.badges.map(b => `<span class="role-badge ${getShopBadgeClass(b.type)}">${b.text}</span>`).join('');
    // 技能用跟遊戲內技能按鈕一致的手繪 Canvas 圖示（drawSkillIcon），不是 assets/skills/*.svg 那張舊圖
    const iconHtml = item.kind === 'skill'
      ? `<canvas class="shop-skill-icon-canvas" data-skill-key="${item.key}" width="36" height="36"></canvas>`
      : `<img src="${meta.icon}" alt="${item.name}">`;

    const costBadgeUnderIcon = towerGoldCost !== null
      ? `<div class="shop-card-t1-cost-pill">💰${towerGoldCost}</div>`
      : '';

    // 按鈕呈現：
    // 1. 若為初始必備塔（粉櫻），不可解除契約
    // 2. 若已締約，顯示「解除契約 (+💎cost)」按鈕（無圖標）
    // 3. 若未締約，顯示「💎 cost 締結契約」按鈕
    let buttonHtml = '';
    if (item.isStarter) {
      buttonHtml = `<button class="shop-card-t1-btn btn-starter" disabled>🌸 初始守護 (常駐)</button>`;
    } else if (item.unlocked) {
      buttonHtml = `
        <button class="shop-card-t1-btn btn-refund" 
                data-kind="${item.kind}" 
                data-key="${item.key}"
                data-cost="${item.cost}">
          解除契約 (+💎${item.cost})
        </button>
      `;
    } else {
      buttonHtml = `
        <button class="shop-card-t1-btn btn-buy" 
                data-kind="${item.kind}" 
                data-key="${item.key}"
                data-cost="${item.cost}"
                ${canAfford ? '' : 'disabled'}>
          💎 ${item.cost} 締結契約
        </button>
      `;
    }

    return `
      <div class="shop-card-t1 ${item.unlocked ? 'owned' : ''}">
        <div class="shop-card-t1-top">
          <div class="shop-card-t1-icon-container">
            <div class="shop-card-t1-icon">
              ${iconHtml}
            </div>
            ${costBadgeUnderIcon}
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
        ${buttonHtml}
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
      isStarter: true,
      desc: SHOP_METADATA.petal?.desc
    });

    // 商店解鎖塔
    for (const [key, item] of Object.entries(SHOP_ITEMS.towers)) {
      const unlocked = isTowerUnlocked(key);
      const name = TOWER_DATA[key]?.name || key;
      allItems.push({ kind: 'tower', key, name, cost: item.cost, unlocked, isStarter: false, desc: SHOP_METADATA[key]?.desc });
    }

    // 商店解鎖技能
    for (const [key, item] of Object.entries(SHOP_ITEMS.skills)) {
      const unlocked = isSkillUnlocked(key);
      allItems.push({ kind: 'skill', key, name: item.name, cost: item.cost, unlocked, isStarter: false, desc: item.desc });
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
            <div class="shop-empty-icon">✨</div>
            <div class="shop-empty-text">太厲害了！你已成功與所有守護花靈及魔法技能完成締約！</div>
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="shop-empty-box">
            <div class="shop-empty-icon">📦</div>
            <div class="shop-empty-text">尚無已締約項目<br>請前往「未締約」頁籤消耗魔法水晶進行締結契約！</div>
          </div>
        `;
      }
      return;
    }

    // 方案一：魔導卡牌矩陣渲染
    let html = '';
    if (isSplitView) {
      if (lockedList.length > 0) {
        html += `<div class="shop-section-banner"><span class="shop-section-title">未締約夥伴與技能</span></div>`;
        html += `<div class="shop-cards-grid">${lockedList.map(item => this.renderShopT1Card(item, balance)).join('')}</div>`;
      }
      if (unlockedList.length > 0) {
        html += `<div class="shop-section-banner" style="margin-top:14px;"><span class="shop-section-title">已締約守護陣容（點擊可解除契約返還水晶）</span></div>`;
        html += `<div class="shop-cards-grid">${unlockedList.map(item => this.renderShopT1Card(item, balance)).join('')}</div>`;
      }
    } else {
      html += `<div class="shop-cards-grid">${targetList.map(item => this.renderShopT1Card(item, balance)).join('')}</div>`;
    }

    container.innerHTML = html;

    // 技能卡片的圖示是 Canvas 佔位，插入 DOM 後才畫得出來（跟遊戲內技能按鈕同一套 drawSkillIcon）
    container.querySelectorAll('.shop-skill-icon-canvas').forEach(canvas => {
      this.drawSkillIcon(canvas.getContext('2d'), canvas.dataset.skillKey);
    });

    // 綁定締約購買點擊事件
    container.querySelectorAll('.shop-card-t1-btn.btn-buy:not(:disabled)').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.buyShopItem(btn.dataset.kind, btn.dataset.key);
      });
    });

    // 綁定解除契約退款點擊事件
    container.querySelectorAll('.shop-card-t1-btn.btn-refund').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.refundShopItem(btn.dataset.kind, btn.dataset.key);
      });
    });
  }

  buyShopItem(kind, key) {
    const result = kind === 'skill' ? purchaseSkill(key) : purchaseTower(key);
    const itemName = (kind === 'skill' ? SHOP_ITEMS.skills[key]?.name : TOWER_DATA[key]?.name) || key;
    if (result.ok) {
      this.sfx.play('upgrade');
      this.showToast(`✨ 成功與「${itemName}」締結契約！`);
    } else if (result.reason === 'insufficient') {
      this.sfx.play('error');
      this.showToast('💎 水晶不足');
    } else {
      this.sfx.play('error');
      this.showToast('⚠️ 締約失敗');
    }
    this.renderShopItems();
    this.updateTowerPanel();
    this.updateSkillBarLockState();
  }

  refundShopItem(kind, key) {
    const itemName = (kind === 'skill' ? SHOP_ITEMS.skills[key]?.name : TOWER_DATA[key]?.name) || key;
    const result = kind === 'skill' ? refundSkill(key) : refundTower(key);
    if (result.ok) {
      this.sfx.play('sell');
      this.showToast(`🍃 已解除「${itemName}」契約，返還 💎${result.refund} 水晶！`);
    } else if (result.reason === 'starter') {
      this.sfx.play('error');
      this.showToast('🌸 初始守護單位不可解除契約');
    } else {
      this.sfx.play('error');
      this.showToast('⚠️ 解除契約失敗');
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

    // 波次資訊 (幻境無盡模式僅顯示當前波數，主線戰役顯示 當前/總波數)
    const waveEl = document.getElementById('wave-info');
    if (waveEl) {
      if (this.state === 'menu') {
        waveEl.textContent = '準備中';
      } else if (CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE) {
        waveEl.textContent = `第 ${this.currentWave + 1} 波`;
      } else {
        waveEl.textContent = `第 ${this.currentWave + 1}/${CONFIG.TOTAL_WAVES} 波`;
      }
    }

    this.updateRelicBarUI();
    this.updateTowerPanel();
  }

  updateSkillBarLockState() {
    // 未解鎖的技能直接從技能列隱藏，不在遊戲畫面裡用鎖頭佔位（商店裡還是看得到、可以解鎖）
    const meteorBtn = document.getElementById('skill-meteor-btn');
    if (meteorBtn) meteorBtn.style.display = isSkillUnlocked('meteor') ? '' : 'none';
    const freezeBtn = document.getElementById('skill-freeze-btn');
    if (freezeBtn) freezeBtn.style.display = isSkillUnlocked('freeze') ? '' : 'none';

    // ☀️ 日輪天罰主動技能：只有在當前局中學會【日輪天罰】質變天賦後才會出現！
    const solarWrathBtn = document.getElementById('skill-solar_wrath-btn');
    if (solarWrathBtn) {
      const isLearned = (typeof relicManager !== 'undefined' && relicManager.hasHidden('solar_wrath'));
      solarWrathBtn.style.display = isLearned ? '' : 'none';
      if (isLearned) {
        const cv = document.getElementById('skill-canvas-solar_wrath');
        if (cv) this.drawSkillIcon(cv.getContext('2d'), 'solar_wrath');
      }
    }
  }

  updateTowerPanel() {
    const items = document.querySelectorAll('.tower-item');
    items.forEach((item) => {
      const type = item.dataset.type;
      const cost = TOWER_DATA[type].cost;
      const unlocked = isTowerUnlocked(type);
      // 未解鎖的塔直接從牌組隱藏，不在遊戲畫面裡用鎖頭佔位（商店裡還是看得到、可以解鎖）
      item.style.display = unlocked ? '' : 'none';
      if (!unlocked) return;
      const canAfford = this.gold >= cost;
      item.classList.toggle('disabled', !canAfford);
      item.classList.remove('selected');
      const details = item.querySelector('.tower-details');
      if (details) {
        // 不能用 details.innerHTML = ... 整個砍掉重建：如果手指拖曳的起點剛好按在
        // .tower-cost 這個子元素上，拖曳途中只要金幣變動觸發這裡重繪，原本那個元素
        // 就從 DOM 上消失了，瀏覽器會直接停止再送出這根手指後續的 touchmove/touchend
        // （這是拖曳建塔會卡住不跟手的真正原因）。改成原地更新文字，同一個節點留著不動。
        let costEl = details.querySelector('.tower-cost');
        if (!costEl) {
          costEl = document.createElement('div');
          costEl.className = 'tower-cost';
          details.appendChild(costEl);
        }
        const costText = `💰${cost}`;
        if (costEl.textContent !== costText) costEl.textContent = costText;
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
            const splashDmg = proj.damage * 0.5;
            if (proj.tower) {
              proj.tower.totalDamageDealt = (proj.tower.totalDamageDealt || 0) + splashDmg;
            }
            enemy.takeDamage(splashDmg, proj.slowFactor, proj.slowDuration, 0, 0, proj.damageType, this);
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
      // 只往「路徑佇列中排在後面」(distance 更小) 的敵人繼續貫穿，避免子彈在轉角/平行走道
      // 誤跳到路徑順序不相鄰、只是物理座標剛好近的怪，變成像 AOE 一樣波及一整群怪
      if (proj.alive && proj.piercing > 0 && !proj.target) {
        let nearestDist = Infinity;
        let nearest = null;
        for (const enemy of this.enemies) {
          if (!enemy.alive || proj.piercedEnemies.has(enemy)) continue;
          if (typeof proj.lastHitDistance === 'number' && enemy.distance >= proj.lastHitDistance) continue;
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
        if (typeof relicManager !== 'undefined') {
          relicManager.onKill(enemy, this);
        }
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

    // Check wave countdown & auto start next wave
    if (this.state === 'wave') {
      const isRogue = CURRENT_GAME_MODE === GAME_MODES.ROGUELIKE;
      if (this.waveManager.allSpawned && this.nextWaveCountdown === null && (isRogue || this.currentWave + 1 < CONFIG.TOTAL_WAVES)) {
        this.triggerNextWaveAutoCountdown();
      }
      if (this.nextWaveCountdown !== null) {
        this.nextWaveCountdown -= dt;
        if (this.nextWaveCountdown <= 0) {
          this.advanceToNextWave(false);
        }
      }
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
      tower.render(ctx, this);
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

    // 4.3 起點出怪口按鈕與倒數提示
    if (this.map.pathPixels.length > 0) {
      const entry = this.map.pathPixels[0];
      const now = performance.now() / 1000;
      const waveNum = this.currentWave + 1;

      // (A) planning 狀態：顯示點擊開始出怪按鈕
      if (this.state === 'planning') {
        const pulseScale = 1 + Math.sin(now * 5) * 0.08;
        ctx.save();
        ctx.translate(entry.x, entry.y);
        ctx.scale(pulseScale, pulseScale);

        // 外圍發光呼吸圈
        ctx.fillStyle = 'rgba(255, 152, 0, 0.35)';
        ctx.beginPath();
        ctx.arc(0, 0, 36, 0, Math.PI * 2);
        ctx.fill();

        // 出怪徽章按鈕：優先使用超高清 SVG 向量貼圖
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

      // (B) wave 進行中且倒數下一波剩餘 ≤10 秒時：在傳送門上方浮現倒數發光光圈與數字
      // （總共等待 15 秒，前 5 秒不顯示，剩 10 秒才開始顯示倒數，避免波次剛結束就一直閃倒數字）
      if (this.state === 'wave' && this.nextWaveCountdown !== null && this.nextWaveCountdown <= 10) {
        const secs = Math.max(1, Math.ceil(this.nextWaveCountdown));
        const nextWaveNum = this.currentWave + 2;
        const countPulse = 1 + Math.sin(now * 8) * 0.12;

        ctx.save();
        ctx.translate(entry.x, entry.y);
        ctx.scale(countPulse, countPulse);

        // 發光倒數能量圈
        ctx.shadowColor = '#00e5ff';
        ctx.shadowBlur = 16;
        const ringGrad = ctx.createRadialGradient(0, 0, 10, 0, 0, 32);
        ringGrad.addColorStop(0, 'rgba(0, 229, 255, 0.6)');
        ringGrad.addColorStop(0.7, 'rgba(0, 230, 118, 0.4)');
        ringGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = ringGrad;
        ctx.beginPath();
        ctx.arc(0, 0, 32, 0, Math.PI * 2);
        ctx.fill();

        // 倒數膠囊面板
        const cdW = 86;
        const cdH = 28;
        const cdR = 14;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.roundRect(-cdW / 2, 14, cdW, cdH, cdR);
        ctx.fill();
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.fillStyle = '#00e5ff';
        ctx.font = '900 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`⏳ ${secs}s 第${nextWaveNum}波`, 0, 14 + cdH / 2 + 1);

        ctx.restore();
      }
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
