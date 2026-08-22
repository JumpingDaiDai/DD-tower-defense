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
    name: '🏰 經典外廊 (4×6 建造)',
    desc: '左上 [0,0] 出發繞最外圍一圈至右上 [5,0]，中央 4×6 蓋塔',
    icon: '🔲',
    cols: 6,
    rows: 8,
    // 怪物緊貼畫布最外圍一圈：左上 -> 左下 -> 右下 -> 右上
    waypoints: [
      [0, 0],
      [0, 7],
      [5, 7],
      [5, 0],
    ],
  },
  serpentine: {
    id: 'serpentine',
    name: '🌸 花園小徑 (蛇形)',
    desc: '經典蜿蜒路線，適合均衡佈局',
    icon: '〰️',
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
    name: '🎯 競技之環 (中央競技)',
    desc: '外圍環繞一圈，中央為建造平台',
    icon: '⭕',
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

// ─── 3. 防禦塔數據 ──────────────────────────
const TOWER_DATA = {
  petal: {
    name: '花瓣塔',
    emoji: '🌸',
    cost: 100,
    range: 120,
    damage: 15,
    fireRate: 1.0,
    projectileSpeed: 300,
    projectileColor: '#ffb6c1',
    description: '基礎攻擊塔',
    color: '#ffb6c1',
    levels: [
      { damage: 15, range: 120, fireRate: 1.0 },
      { damage: 25, range: 135, fireRate: 1.2, upgradeCost: 80 },
      { damage: 40, range: 150, fireRate: 1.4, upgradeCost: 160 },
    ],
  },
  ice: {
    name: '冰淇淋塔',
    emoji: '🍦',
    cost: 150,
    range: 110,
    damage: 8,
    fireRate: 0.8,
    slowFactor: 0.4,
    slowDuration: 2.0,
    projectileSpeed: 250,
    projectileColor: '#b5e8ff',
    description: '減速敵人',
    color: '#b5e8ff',
    levels: [
      { damage: 8, range: 110, fireRate: 0.8, slowFactor: 0.4, slowDuration: 2.0 },
      { damage: 14, range: 120, fireRate: 1.0, slowFactor: 0.35, slowDuration: 2.5, upgradeCost: 100 },
      { damage: 22, range: 140, fireRate: 1.2, slowFactor: 0.25, slowDuration: 3.0, upgradeCost: 200 },
    ],
  },
  sunflower: {
    name: '向日葵',
    emoji: '🌻',
    cost: 75,
    range: 0,
    damage: 0,
    fireRate: 0,
    goldPerSecond: 8,
    description: '自動產金幣',
    color: '#ffd700',
    levels: [
      { goldPerSecond: 8 },
      { goldPerSecond: 18, upgradeCost: 75 },
      { goldPerSecond: 32, upgradeCost: 150 },
    ],
  },
  candy: {
    name: '糖果炮',
    emoji: '🍬',
    cost: 200,
    range: 130,
    damage: 45,
    fireRate: 0.5,
    splashRadius: 55,
    projectileSpeed: 200,
    projectileColor: '#ff69b4',
    description: '範圍傷害',
    color: '#ff69b4',
    levels: [
      { damage: 45, range: 130, fireRate: 0.5, splashRadius: 55 },
      { damage: 70, range: 145, fireRate: 0.6, splashRadius: 65, upgradeCost: 150 },
      { damage: 110, range: 160, fireRate: 0.7, splashRadius: 80, upgradeCost: 300 },
    ],
  },
  rainbow: {
    name: '彩虹塔',
    emoji: '🌈',
    cost: 300,
    range: 150,
    damage: 28,
    fireRate: 1.5,
    piercing: 3,
    projectileSpeed: 400,
    projectileColor: '#dda0dd',
    description: '穿透多個敵人',
    color: '#dda0dd',
    levels: [
      { damage: 28, range: 150, fireRate: 1.5, piercing: 3 },
      { damage: 42, range: 165, fireRate: 1.8, piercing: 4, upgradeCost: 200 },
      { damage: 60, range: 180, fireRate: 2.0, piercing: 5, upgradeCost: 400 },
    ],
  },
};

// ─── 4. 敵人數據 ─────────────────────────────
const ENEMY_DATA = {
  caterpillar: { name: '毛毛蟲', emoji: '🐛', hp: 50, speed: 50, reward: 10, damage: 1 },
  bee: { name: '蜜蜂', emoji: '🐝', hp: 35, speed: 90, reward: 12, damage: 1 },
  snail: { name: '蝸牛', emoji: '🐌', hp: 160, speed: 28, reward: 25, damage: 2 },
  butterfly: { name: '蝴蝶', emoji: '🦋', hp: 80, speed: 65, reward: 18, damage: 1 },
  dragon: { name: '小龍', emoji: '🐉', hp: 600, speed: 32, reward: 100, damage: 5 },
};

// ─── 5. 波次數據 (15波) ─────────────────────
const WAVE_DATA = [
  { enemies: [{ type: 'caterpillar', count: 5, interval: 1.5 }], bonus: 50 },
  { enemies: [{ type: 'caterpillar', count: 8, interval: 1.2 }], bonus: 60 },
  { enemies: [{ type: 'caterpillar', count: 5, interval: 1.0 }, { type: 'bee', count: 3, interval: 0.8 }], bonus: 80 },
  { enemies: [{ type: 'bee', count: 10, interval: 0.7 }], bonus: 90 },
  { enemies: [{ type: 'caterpillar', count: 6, interval: 0.8 }, { type: 'snail', count: 2, interval: 2.5 }], bonus: 120 },
  { enemies: [{ type: 'bee', count: 8, interval: 0.5 }, { type: 'caterpillar', count: 8, interval: 0.7 }], bonus: 130 },
  { enemies: [{ type: 'butterfly', count: 6, interval: 0.8 }, { type: 'bee', count: 5, interval: 0.6 }], bonus: 150 },
  { enemies: [{ type: 'snail', count: 4, interval: 1.8 }, { type: 'caterpillar', count: 12, interval: 0.4 }], bonus: 170 },
  { enemies: [{ type: 'bee', count: 15, interval: 0.35 }, { type: 'butterfly', count: 6, interval: 0.5 }], bonus: 180 },
  { enemies: [{ type: 'dragon', count: 1, interval: 3 }, { type: 'snail', count: 4, interval: 1.2 }, { type: 'caterpillar', count: 10, interval: 0.6 }], bonus: 250 },
  { enemies: [{ type: 'butterfly', count: 12, interval: 0.4 }, { type: 'snail', count: 5, interval: 1.0 }], bonus: 220 },
  { enemies: [{ type: 'bee', count: 20, interval: 0.25 }, { type: 'butterfly', count: 8, interval: 0.4 }], bonus: 240 },
  { enemies: [{ type: 'snail', count: 8, interval: 0.8 }, { type: 'dragon', count: 1, interval: 4 }], bonus: 280 },
  { enemies: [{ type: 'bee', count: 15, interval: 0.2 }, { type: 'butterfly', count: 12, interval: 0.3 }, { type: 'snail', count: 6, interval: 0.6 }], bonus: 320 },
  { enemies: [{ type: 'dragon', count: 3, interval: 4 }, { type: 'snail', count: 8, interval: 0.8 }, { type: 'butterfly', count: 10, interval: 0.3 }, { type: 'bee', count: 20, interval: 0.15 }], bonus: 500 },
];

// ─── 5.5 Canvas 手繪角色系統 ─────────────────
const Sprites = {
  drawFace: function(ctx) {
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-4, -2, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(4, -2, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 3, 1.5, 0, Math.PI, false); ctx.stroke();
    ctx.fillStyle = '#ffb3ba';
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.arc(-6, 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(6, 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  },

  drawTower_petal: function(ctx, time) {
    ctx.save();
    ctx.rotate(time * 0.5);
    ctx.fillStyle = '#ffb3ba';
    for(let i = 0; i < 5; i++) {
      ctx.rotate((Math.PI * 2) / 5);
      ctx.beginPath(); ctx.ellipse(0, -12, 6, 10, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = '#000';
    this.drawFace(ctx);
  },

  drawTower_ice: function(ctx, time) {
    ctx.fillStyle = '#ffdead';
    ctx.beginPath(); ctx.moveTo(-8, -4); ctx.lineTo(8, -4); ctx.lineTo(0, 12); ctx.fill();
    ctx.fillStyle = '#bae1ff';
    ctx.beginPath(); ctx.arc(0, -8, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-3, -11, 2, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(0, -6); this.drawFace(ctx); ctx.restore();
  },

  drawTower_sunflower: function(ctx, time) {
    ctx.save();
    ctx.rotate(Math.sin(time * 2) * 0.1);
    ctx.fillStyle = '#ffffba';
    for(let i = 0; i < 8; i++) {
      ctx.rotate((Math.PI * 2) / 8);
      ctx.beginPath(); ctx.ellipse(0, -12, 5, 8, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#8b4513';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-3, -2, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(3, -2, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 2, 3, 0.2, Math.PI - 0.2, false); ctx.stroke();
    ctx.restore();
  },

  drawTower_candy: function(ctx, time) {
    ctx.fillStyle = '#ffb3ba';
    ctx.beginPath(); ctx.moveTo(-12, -4); ctx.lineTo(-16, -8); ctx.lineTo(-16, 8); ctx.lineTo(-12, 4); ctx.fill();
    ctx.beginPath(); ctx.moveTo(12, -4); ctx.lineTo(16, -8); ctx.lineTo(16, 8); ctx.lineTo(12, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.rotate(time);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI, false); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 10, Math.PI, Math.PI * 2, false); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ffd1dc';
    ctx.fillRect(-3, -18, 6, 8);
    ctx.save(); ctx.translate(0, 2); this.drawFace(ctx); ctx.restore();
  },

  drawTower_rainbow: function(ctx, time) {
    const colors = ['#ffb3ba', '#ffffba', '#baffc9', '#bae1ff'];
    for(let i=0; i<4; i++) {
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 4, 12 - i*3, Math.PI, 0);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-10, 4, 5, 0, Math.PI*2); ctx.arc(-14, 6, 4, 0, Math.PI*2); ctx.arc(-6, 6, 4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(10, 4, 5, 0, Math.PI*2); ctx.arc(14, 6, 4, 0, Math.PI*2); ctx.arc(6, 6, 4, 0, Math.PI*2); ctx.fill();
  },

  drawEnemy_caterpillar: function(ctx, time) {
    const offset = Math.sin(time * 5) * 2;
    ctx.fillStyle = '#baffc9';
    ctx.beginPath(); ctx.arc(8 - offset, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0 + offset*0.5, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(-8 + offset, 0, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-10, -5); ctx.lineTo(-14, -10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6, -5); ctx.lineTo(-4, -10); ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-10, -2, 1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(-6, -2, 1, 0, Math.PI * 2); ctx.fill();
  },

  drawEnemy_bee: function(ctx, time) {
    const flap = Math.sin(time * 20) * 4;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath(); ctx.ellipse(-2, -6 - flap, 4, 6, Math.PI/4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(4, -6 - flap, 4, 6, -Math.PI/4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffffba';
    ctx.beginPath(); ctx.ellipse(0, 0, 10, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.fillRect(-2, -7.5, 4, 15);
    ctx.fillRect(4, -6, 3, 12);
    ctx.beginPath(); ctx.arc(-6, -2, 1.5, 0, Math.PI * 2); ctx.fill();
  },

  drawEnemy_snail: function(ctx, time) {
    const slide = Math.sin(time * 2) * 1;
    ctx.fillStyle = '#baffc9';
    ctx.beginPath(); ctx.ellipse(slide, 6, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#baffc9'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-8 + slide, 4); ctx.lineTo(-12 + slide, -2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-4 + slide, 4); ctx.lineTo(-6 + slide, -4); ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-12 + slide, -2, 1, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(-6 + slide, -4, 1, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffb347';
    ctx.beginPath(); ctx.arc(2, 0, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#a65e2e'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(2, 0, 4, 0, Math.PI*1.5); ctx.stroke();
  },

  drawEnemy_butterfly: function(ctx, time) {
    const flap = Math.sin(time * 10);
    const wingY = flap * 6;
    ctx.fillStyle = '#bae1ff';
    ctx.beginPath(); ctx.ellipse(-6, -2 + wingY/2, 8, 10, -Math.PI/6, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6, -2 + wingY/2, 8, 10, Math.PI/6, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffb3ba';
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-1, -8); ctx.quadraticCurveTo(-4, -12, -6, -10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(1, -8); ctx.quadraticCurveTo(4, -12, 6, -10); ctx.stroke();
  },

  drawEnemy_dragon: function(ctx, time) {
    const floatY = Math.sin(time * 3) * 2;
    ctx.save();
    ctx.translate(0, floatY);
    const flap = Math.sin(time * 15) * 3;
    ctx.fillStyle = '#ff9aa2';
    ctx.beginPath(); ctx.moveTo(-6, -4); ctx.lineTo(-16, -10 - flap); ctx.lineTo(-12, 0); ctx.fill();
    ctx.beginPath(); ctx.moveTo(6, -4); ctx.lineTo(16, -10 - flap); ctx.lineTo(12, 0); ctx.fill();
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath(); ctx.ellipse(0, 2, 10, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffba';
    ctx.beginPath(); ctx.ellipse(0, 5, 6, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-4, -3, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(4, -3, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(-2, 1); ctx.lineTo(-1, 3); ctx.lineTo(0, 1); ctx.fill();
    ctx.beginPath(); ctx.moveTo(2, 1); ctx.lineTo(1, 3); ctx.lineTo(0, 1); ctx.fill();
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
  constructor(typeKey, gameMap) {
    const data = ENEMY_DATA[typeKey];
    this.typeKey = typeKey;
    this.name = data.name;
    this.emoji = data.emoji;
    this.maxHp = data.hp;
    this.hp = data.hp;
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

    // Visual
    this.hitFlash = 0;
    this.scale = 0;
    this.targetScale = 1;
    this.animTime = Math.random() * 10;
  }

  update(dt) {
    this.animTime += dt;
    // Scale animation (spawn pop)
    this.scale = lerp(this.scale, this.targetScale, dt * 8);

    // Slow effect
    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      if (this.slowTimer <= 0) {
        this.slowFactor = 1;
      }
    }

    // Hit flash
    if (this.hitFlash > 0) this.hitFlash -= dt * 4;

    // Move along path
    const currentSpeed = this.baseSpeed * this.slowFactor;
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

  takeDamage(amount, slowFactor, slowDuration) {
    this.hp -= amount;
    this.hitFlash = 1;
    if (slowFactor && slowDuration) {
      this.slowFactor = slowFactor;
      this.slowTimer = slowDuration;
    }
    if (this.hp <= 0) {
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

    // Slow tint
    if (this.slowTimer > 0) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#88ddff';
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Draw Canvas Sprite
    const drawFunc = Sprites['drawEnemy_' + this.typeKey];
    if (drawFunc) {
      drawFunc.call(Sprites, ctx, this.animTime);
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
  }

  update(dt) {
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
      this.onHit();
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

  onHit() {
    if (this.target && this.target.alive) {
      this.target.takeDamage(this.damage, this.slowFactor, this.slowDuration);
      this.piercedEnemies.add(this.target);
    }
    if (this.piercing > 0 && this.piercedEnemies.size < this.piercing) {
      // Don't die yet, continue to next target
      this.target = null; // Will be reassigned by game
    } else {
      this.alive = false;
    }
  }

  render(ctx) {
    // Trail
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const alpha = (i / this.trail.length) * 0.4;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Projectile body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Glow
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
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

    // Base circle
    const stats = this.getStats();
    ctx.fillStyle = this.data.color;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Border
    ctx.strokeStyle = this.data.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Canvas Sprite
    const drawFunc = Sprites['drawTower_' + this.typeKey];
    if (drawFunc) {
      ctx.save();
      drawFunc.call(Sprites, ctx, this.animTime);
      ctx.restore();
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
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = this.data.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, stats.range, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = this.data.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(this.x, this.y, stats.range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ─── 13. 波次管理器 ──────────────────────────
class WaveManager {
  constructor() {
    this.currentWave = -1;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.active = false;
    this.allSpawned = false;
  }

  startWave(waveIndex) {
    this.currentWave = waveIndex;
    const wave = WAVE_DATA[waveIndex];
    this.spawnQueue = [];

    // Build spawn queue (flatten all enemy groups in sequence)
    for (const group of wave.enemies) {
      for (let i = 0; i < group.count; i++) {
        this.spawnQueue.push({
          type: group.type,
          delay: group.interval,
        });
      }
    }

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
      }

      return new Enemy(spawn.type, gameMap);
    }
    return null;
  }

  isComplete(enemies) {
    return this.allSpawned && enemies.every((e) => !e.alive);
  }

  getWaveBonus() {
    return WAVE_DATA[this.currentWave]?.bonus || 0;
  }
}

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
    this.waveManager = new WaveManager();

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

    // Build tower map for quick lookup
    this.towerGrid = {};
  }

  init() {
    this.sfx.init();
    this.renderMapToBuffer();
    this.setupUI();
    this.setupEvents();
    this.updateUI();
    this.gameLoop(0);
  }

  // ─── Map rendering (to offscreen buffer: 暖金黃沙海島/古代石陣風格) ───
  renderMapToBuffer() {
    const ctx = this.mapCtx;
    const cs = CONFIG.CELL_SIZE;

    // 1. 基底大地：暖金黃沙大地色系
    ctx.fillStyle = '#deb887';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 2. 建造平台格線微光
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        if (this.map.grid[r][c] === 0) {
          // 建造區基座立體石台微光
          ctx.fillStyle = (r + c) % 2 === 0 ? 'rgba(255, 255, 255, 0.15)' : 'rgba(100, 60, 20, 0.04)';
          ctx.fillRect(c * cs + 2, r * cs + 2, cs - 4, cs - 4);

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.lineWidth = 1;
          ctx.strokeRect(c * cs + 3, r * cs + 3, cs - 6, cs - 6);
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
        // 立體小草叢
        ctx.fillStyle = '#689f38';
        ctx.beginPath(); ctx.moveTo(-6, 4); ctx.quadraticCurveTo(-8, -4, -12, -8); ctx.quadraticCurveTo(-6, -2, -4, 4); ctx.fill();
        ctx.fillStyle = '#7cb342';
        ctx.beginPath(); ctx.moveTo(-2, 4); ctx.quadraticCurveTo(0, -6, 0, -12); ctx.quadraticCurveTo(2, -4, 2, 4); ctx.fill();
        ctx.fillStyle = '#8bc34a';
        ctx.beginPath(); ctx.moveTo(4, 4); ctx.quadraticCurveTo(8, -2, 12, -8); ctx.quadraticCurveTo(6, -4, 6, 4); ctx.fill();
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

    // 5. 起點：精緻石造城門 (Top-Left [0,0])
    const entry = this.map.pathPixels[0];
    const exit = this.map.pathPixels[this.map.pathPixels.length - 1];

    ctx.save();
    ctx.translate(entry.x, entry.y);
    // 陰影
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, 22, 24, 10, 0, 0, Math.PI * 2); ctx.fill();
    // 石門外框
    ctx.fillStyle = '#78909c';
    ctx.fillRect(-22, -26, 44, 48);
    ctx.beginPath(); ctx.arc(0, -26, 22, Math.PI, 0); ctx.fill();
    // 石磚刻痕
    ctx.fillStyle = '#546e7a';
    ctx.fillRect(-20, -24, 40, 4);
    ctx.fillRect(-20, -10, 40, 3);
    // 門洞深處（暗紅色惡魔傳送門）
    ctx.fillStyle = '#263238';
    ctx.fillRect(-14, -18, 28, 40);
    ctx.beginPath(); ctx.arc(0, -18, 14, Math.PI, 0); ctx.fill();
    // 傳送門旋渦微光
    ctx.fillStyle = '#e91e63';
    ctx.beginPath(); ctx.arc(0, -6, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff80ab';
    ctx.beginPath(); ctx.arc(0, -6, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // 6. 終點：精緻保衛守護小屋 (Top-Right [5,0])
    ctx.save();
    ctx.translate(exit.x, exit.y);
    // 房屋陰影
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, 20, 26, 10, 0, 0, Math.PI * 2); ctx.fill();
    // 主牆體
    ctx.fillStyle = '#fff8e1';
    ctx.fillRect(-24, -10, 48, 32);
    ctx.strokeStyle = '#ffe082';
    ctx.lineWidth = 2;
    ctx.strokeRect(-24, -10, 48, 32);
    // 紅色三角瓦片屋頂
    ctx.fillStyle = '#e53935';
    ctx.beginPath();
    ctx.moveTo(-30, -10);
    ctx.lineTo(0, -32);
    ctx.lineTo(30, -10);
    ctx.closePath();
    ctx.fill();
    // 屋頂陰影與紋路
    ctx.strokeStyle = '#b71c1c';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 煙囪
    ctx.fillStyle = '#8d6e63';
    ctx.fillRect(12, -28, 7, 12);
    // 門
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(-7, 4, 14, 18);
    ctx.fillStyle = '#ffd54f';
    ctx.beginPath(); ctx.arc(3, 13, 2, 0, Math.PI * 2); ctx.fill();
    // 玻璃窗戶（發光藍）
    ctx.fillStyle = '#81d4fa';
    ctx.fillRect(-18, -2, 8, 8);
    ctx.fillRect(10, -2, 8, 8);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(-18, -2, 8, 8);
    ctx.strokeRect(10, -2, 8, 8);
    ctx.restore();
  }

  // ─── UI Setup ───
  setupUI() {
    const list = document.getElementById('tower-list');
    list.innerHTML = '';

    for (const [key, data] of Object.entries(TOWER_DATA)) {
      const item = document.createElement('div');
      item.className = 'tower-item';
      item.dataset.type = key;
      item.innerHTML = `
        <span class="tower-emoji">${data.emoji}</span>
        <div class="tower-details">
          <div class="tower-name">${data.name}</div>
          <div class="tower-cost">💰 ${data.cost}</div>
          <div class="tower-desc">${data.description}</div>
        </div>
      `;

      // 支援長按顯示資訊、拖曳建立防禦塔
      let pressTimer = null;
      let isLongPressed = false;
      let startX = 0, startY = 0;
      let isItemDragging = false;

      const clearPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };

      const startPress = (clientX, clientY) => {
        if (this.state !== 'planning' && this.state !== 'wave') return;
        startX = clientX;
        startY = clientY;
        isLongPressed = false;
        isItemDragging = false;

        pressTimer = setTimeout(() => {
          isLongPressed = true;
          this.deselectTower();
          this.showTowerPreviewInfo(key);
          if (navigator.vibrate) navigator.vibrate(40);
        }, 350); // 350ms 觸發長按資訊
      };

      const movePress = (clientX, clientY) => {
        const distMoved = Math.hypot(clientX - startX, clientY - startY);
        if (distMoved > 8) {
          // 移動超過閾值，代表開始拖曳，取消長按計時並關閉資訊
          clearPress();
          if (isLongPressed) {
            isLongPressed = false;
            document.getElementById('tower-info').classList.add('hidden');
          }
          if (!isItemDragging) {
            if (this.gold < data.cost) {
              return;
            }
            isItemDragging = true;
            this.draggingTowerType = key;
            this.isDragging = true;
            item.classList.add('is-dragging');
            document.getElementById('tower-info').classList.add('hidden');
          }
          // 計算 Canvas 內座標
          const rect = this.canvas.getBoundingClientRect();
          const scaleX = this.canvas.width / rect.width;
          const scaleY = this.canvas.height / rect.height;
          const cx = (clientX - rect.left) * scaleX;
          const cy = (clientY - rect.top) * scaleY;
          this.dragPos = { x: cx, y: cy };
          const { col, row } = pixelToGrid(cx, cy);
          if (col >= 0 && col < CONFIG.COLS && row >= 0 && row < CONFIG.ROWS) {
            this.hoverCell = { col, row };
          } else {
            this.hoverCell = null;
          }
        }
      };

      const endPress = (clientX, clientY) => {
        clearPress();
        if (isItemDragging) {
          item.classList.remove('is-dragging');
          // 嘗試在目標位置放置防禦塔
          const rect = this.canvas.getBoundingClientRect();
          const scaleX = this.canvas.width / rect.width;
          const scaleY = this.canvas.height / rect.height;
          const cx = (clientX - rect.left) * scaleX;
          const cy = (clientY - rect.top) * scaleY;
          const { col, row } = pixelToGrid(cx, cy);
          if (col >= 0 && col < CONFIG.COLS && row >= 0 && row < CONFIG.ROWS) {
            this.selectedTowerType = key;
            this.placeTower(col, row);
            this.selectedTowerType = null;
          }
          this.draggingTowerType = null;
          this.dragPos = null;
          this.isDragging = false;
          this.hoverCell = null;
          this.updateTowerPanel();
        } else if (isLongPressed) {
          // 長按後放開 -> 關閉資訊
          isLongPressed = false;
          document.getElementById('tower-info').classList.add('hidden');
        } else {
          // 點擊生產區塔卡片 -> 關閉現有的場上塔資訊面板並取消場上塔選取
          this.deselectTower();
        }
      };

      // Touch 事件
      item.addEventListener('touchstart', (e) => {
        this.sfx.init();
        this.sfx.resume();
        if (e.touches.length > 0) {
          startPress(e.touches[0].clientX, e.touches[0].clientY);
        }
      }, { passive: true });

      item.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
          movePress(e.touches[0].clientX, e.touches[0].clientY);
          if (isItemDragging) {
            e.preventDefault();
          }
        }
      }, { passive: false });

      item.addEventListener('touchend', (e) => {
        const touch = e.changedTouches[0];
        endPress(touch.clientX, touch.clientY);
      }, { passive: true });

      item.addEventListener('touchcancel', () => {
        clearPress();
        if (isItemDragging) {
          item.classList.remove('is-dragging');
          this.draggingTowerType = null;
          this.dragPos = null;
          this.isDragging = false;
          this.hoverCell = null;
        }
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

    // Map selector setup
    const mapSelectContainer = document.getElementById('map-selection-list');
    if (mapSelectContainer) {
      mapSelectContainer.innerHTML = '';
      for (const [key, mapCfg] of Object.entries(MAP_CONFIGS)) {
        const card = document.createElement('div');
        card.className = `map-select-card ${key === this.map.mapId ? 'active' : ''}`;
        card.dataset.mapId = key;
        card.innerHTML = `
          <div class="map-card-icon">${mapCfg.icon}</div>
          <div class="map-card-info">
            <div class="map-card-title">${mapCfg.name}</div>
            <div class="map-card-desc">${mapCfg.desc}</div>
          </div>
          <div class="map-card-radio"></div>
        `;
        card.addEventListener('click', () => this.selectMap(key));
        mapSelectContainer.appendChild(card);
      }
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

    bindTap('start-btn', () => this.startGame());
    bindTap('start-wave-btn', () => this.startNextWave());
    bindTap('retry-btn', () => this.restartGame());
    bindTap('replay-btn', () => this.restartGame());
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
      if (icon) icon.textContent = enabled ? '🔊' : '🔇';
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

  selectMap(mapId) {
    if (!MAP_CONFIGS[mapId]) return;
    CURRENT_MAP_ID = mapId;
    this.map = new GameMap(mapId);
    this.renderMapToBuffer();
    
    // Update map selection card UI
    document.querySelectorAll('.map-select-card').forEach(card => {
      if (card.dataset.mapId === mapId) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });

    this.sfx.play('tap');
    this.showToast(`🗺️ 已切換地圖：${MAP_CONFIGS[mapId].name}`);
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
        // 如果不是按鈕或卡片元件，阻止雙擊放大行為
        const isClickable = e.target && (
          e.target.tagName === 'BUTTON' ||
          e.target.closest('button') ||
          e.target.closest('.map-select-card') ||
          e.target.closest('.tower-item')
        );
        if (!isClickable && e.cancelable) {
          e.preventDefault();
        }
      }
      lastTouchTime = now;
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchTime <= 300) {
        const isClickable = e.target && (
          e.target.tagName === 'BUTTON' ||
          e.target.closest('button') ||
          e.target.closest('.map-select-card') ||
          e.target.closest('.tower-item')
        );
        if (!isClickable && e.cancelable) {
          e.preventDefault();
        }
      }
    }, { passive: false });

    // 防止多指縮放手勢 (Pinch to zoom)
    document.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    }, { passive: false });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.selectedTowerType = null;
        this.deselectTower();
        this.updateTowerPanel();
      }
      if (e.key === ' ' && this.state === 'planning') {
        e.preventDefault();
        this.startNextWave();
      }
    });
  }

  // ─── Canvas interaction ───
  handleCanvasPoint(px, py) {
    const { col, row } = pixelToGrid(px, py);

    if (this.state !== 'planning' && this.state !== 'wave') return;

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
      this.showToast(`💰 金幣不足！需要 ${data.cost}`);
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
      this.showToast('❌ 不能放在路上！');
      this.sfx.play('error');
      return;
    }

    const key = `${col},${row}`;
    if (this.towerGrid[key]) {
      this.showToast('❌ 已有防禦塔！');
      this.sfx.play('error');
      return;
    }

    if (this.gold < data.cost) {
      this.showToast(`💰 金幣不足！需要 ${data.cost}`);
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

    document.getElementById('tower-info-name').textContent = `${tower.data.emoji} ${tower.data.name}`;
    document.getElementById('tower-info-level').textContent = `等級 ${tower.level} / ${CONFIG.MAX_LEVEL}`;
    document.getElementById('tower-info-actions').style.display = 'flex';

    let statsHtml = `<div style="color:#e06088;font-weight:bold;margin-bottom:3px;">${tower.data.description}</div>`;
    if (tower.typeKey === 'sunflower') {
      statsHtml += `💰 產金：${stats.goldPerSecond}/秒（僅出怪時生效）`;
    } else {
      statsHtml += `⚔️ 傷害：${stats.damage}<br>`;
      statsHtml += `📏 範圍：${stats.range}<br>`;
      statsHtml += `💫 攻速：${stats.fireRate.toFixed(1)}/秒`;
      if (stats.splashRadius) statsHtml += `<br>💥 爆炸：${stats.splashRadius}`;
      if (stats.slowFactor) statsHtml += `<br>❄️ 減速：${Math.round((1 - stats.slowFactor) * 100)}%`;
      if (stats.piercing) statsHtml += `<br>🌈 穿透：${stats.piercing}體`;
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

    document.getElementById('tower-info-name').textContent = `${data.emoji} ${data.name} (建造預覽)`;
    document.getElementById('tower-info-level').textContent = `造價 💰${data.cost} | 點擊地圖空地放置`;
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

    const bonus = this.waveManager.getWaveBonus();
    this.addGold(bonus);
    this.score += bonus;
    this.showToast(`✅ 第 ${this.currentWave + 1} 波完成！獎勵 💰${bonus}`);
    this.sfx.play('wave');

    this.currentWave++;
    if (this.currentWave >= CONFIG.TOTAL_WAVES) {
      this.victory();
    } else {
      this.state = 'planning';
      document.getElementById('start-wave-btn').disabled = false;
      this.updateWavePreview();
    }
    this.updateUI();
  }

  // ─── Game state ───
  startGame() {
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
    this.waveManager = new WaveManager();
    this.state = 'planning';

    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('victory-screen').classList.add('hidden');
    document.getElementById('start-wave-btn').disabled = false;
    document.getElementById('speed-btn').textContent = '⏩ 1x';

    this.deselectTower();
    this.updateWavePreview();
    this.updateUI();
    this.updateTowerPanel();
    this.showToast('🏗️ 新遊戲開始！');
  }

  gameOver() {
    this.state = 'gameover';
    this.sfx.play('gameover');
    this.saveBestScore();
    document.getElementById('final-wave').textContent = this.currentWave + 1;
    document.getElementById('final-score').textContent = this.score;
    document.getElementById('gameover-screen').classList.remove('hidden');
  }

  victory() {
    this.state = 'victory';
    this.sfx.play('victory');
    this.score += this.lives * 50; // Bonus for remaining lives
    this.saveBestScore();
    document.getElementById('victory-score').textContent = this.score;
    document.getElementById('victory-screen').classList.remove('hidden');
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
    this.waveManager = new WaveManager();

    const menuScore = document.getElementById('menu-best-score');
    if (menuScore) menuScore.textContent = this.bestScore;
    this.showToast('🏠 已返回首頁');
  }

  saveBestScore() {
    if (this.score > this.bestScore) {
      this.bestScore = this.score;
      localStorage.setItem(CONFIG.LS_KEY, this.bestScore);
      const menuScore = document.getElementById('menu-best-score');
      if (menuScore) menuScore.textContent = this.bestScore;
    }
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

  toggleSound() {
    const enabled = this.sfx.toggle();
    const soundBtn = document.getElementById('sound-btn');
    if (soundBtn) soundBtn.textContent = enabled ? '🔊' : '🔇';
    const statusText = document.getElementById('sound-status-text');
    if (statusText) statusText.textContent = enabled ? '音效：開啟' : '音效：靜音';
    const icon = document.querySelector('#settings-sound-btn .settings-opt-icon');
    if (icon) icon.textContent = enabled ? '🔊' : '🔇';
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
    document.getElementById('gold').textContent = this.gold;
    document.getElementById('lives').textContent = this.lives;
    document.getElementById('wave-info').textContent =
      this.state === 'menu'
        ? '準備中'
        : `第 ${this.currentWave + 1} / ${CONFIG.TOTAL_WAVES} 波`;
    document.getElementById('score').textContent = this.score;
    this.updateTowerPanel();
  }

  updateTowerPanel() {
    const items = document.querySelectorAll('.tower-item');
    items.forEach((item) => {
      const type = item.dataset.type;
      const cost = TOWER_DATA[type].cost;
      const canAfford = this.gold >= cost;
      item.classList.toggle('disabled', !canAfford);
      item.classList.remove('selected');
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
    const rawDt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
    this.lastTime = timestamp;
    const dt = rawDt * this.speedMultiplier;

    if (this.state === 'wave' || this.state === 'planning') {
      this.update(dt);
    }
    this.render();
    this.animFrame = requestAnimationFrame((t) => this.gameLoop(t));
  }

  update(dt) {
    // Spawn enemies
    if (this.state === 'wave') {
      const newEnemy = this.waveManager.update(dt, this.map);
      if (newEnemy) this.enemies.push(newEnemy);
    }

    // Update enemies
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.update(dt);

      if (enemy.reachedEnd) {
        this.lives -= enemy.damage;
        this.spawnParticle(enemy.x, enemy.y, {
          text: `-${enemy.damage} ❤️`,
          color: '#ff4444',
          fontSize: 16,
          vx: 0,
          vy: -50,
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
      proj.update(dt);

      // Handle splash damage on hit
      if (!proj.alive && proj.splashRadius > 0) {
        for (const enemy of this.enemies) {
          if (!enemy.alive || proj.piercedEnemies.has(enemy)) continue;
          const d = dist(proj.x, proj.y, enemy.x, enemy.y);
          if (d <= proj.splashRadius) {
            enemy.takeDamage(proj.damage * 0.5, proj.slowFactor, proj.slowDuration);
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
          ctx.globalAlpha = 0.08;
          ctx.fillStyle = data.color;
          ctx.beginPath();
          ctx.arc(center.x, center.y, data.range, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.2;
          ctx.strokeStyle = data.color;
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(center.x, center.y, data.range, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }

        // Preview tower emoji
        const center = gridToPixel(col, row);
        ctx.globalAlpha = 0.6;
        ctx.font = '28px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(data.emoji, center.x, center.y + 1);
        ctx.globalAlpha = 1;
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
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = data.color;
        ctx.beginPath();
        ctx.arc(rangeCenterX, rangeCenterY, data.range, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = data.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(rangeCenterX, rangeCenterY, data.range, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 3. 繪製跟隨手指/滑鼠的塔圖示
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.font = '32px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(data.emoji, x, y - 10);
      ctx.restore();
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
