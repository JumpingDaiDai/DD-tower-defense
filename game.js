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
      headers: { 'Content-Type': 'application/json' },
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
    fetch('/__upload', { method: 'POST', body: blob })
      .then(() => dbgLog('📷 截圖已上傳'))
      .catch(() => dbgLog('📷 截圖上傳失敗（devserver 未啟動？）'));
  }, 'image/png');
}

dbgLog('Script loading...');

// ─── 1. 遊戲設定 ─────────────────────────────
const CONFIG = {
  COLS: 10,
  ROWS: 14,
  CELL_SIZE: 50,
  STARTING_GOLD: 200,
  STARTING_LIVES: 20,
  SELL_RATIO: 0.7,
  MAX_LEVEL: 3,
  TOTAL_WAVES: 15,
  LS_KEY: 'dd_tower_defense_best',
};

const CANVAS_W = CONFIG.COLS * CONFIG.CELL_SIZE; // 500
const CANVAS_H = CONFIG.ROWS * CONFIG.CELL_SIZE; // 700

// ─── 2. 路徑定義 (直向手機地圖：由上往下蜿蜒穿梭) ──
const PATH_WAYPOINTS = [
  [1, 0],   // 上方入口
  [1, 2],
  [8, 2],
  [8, 5],
  [1, 5],
  [1, 8],
  [8, 8],
  [8, 11],
  [2, 11],
  [2, 13],  // 下方城堡終點
];

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
  constructor() {
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
    for (let r = 0; r < CONFIG.ROWS; r++) {
      this.grid[r] = [];
      for (let c = 0; c < CONFIG.COLS; c++) {
        this.grid[r][c] = 0; // 0 = grass (buildable)
      }
    }
    // Mark path cells safely
    for (let i = 0; i < PATH_WAYPOINTS.length - 1; i++) {
      const [c1, r1] = PATH_WAYPOINTS[i];
      const [c2, r2] = PATH_WAYPOINTS[i + 1];
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
    this.pathPixels = PATH_WAYPOINTS.map(([c, r]) => gridToPixel(c, r));
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
    return this.grid[row][col] === 0;
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

    // Sunflower: generate gold
    if (this.typeKey === 'sunflower' && stats.goldPerSecond) {
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

  // ─── Map rendering (to offscreen buffer) ───
  renderMapToBuffer() {
    const ctx = this.mapCtx;
    const cs = CONFIG.CELL_SIZE;

    // Background grass
    ctx.fillStyle = '#d3f9d8';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Subtle grass texture
    for (let r = 0; r < CONFIG.ROWS; r++) {
      for (let c = 0; c < CONFIG.COLS; c++) {
        if (this.map.grid[r][c] === 0) {
          // Subtle checker pattern
          const shade = (r + c) % 2 === 0 ? '#d3f9d8' : '#c5f5ca';
          ctx.fillStyle = shade;
          ctx.fillRect(c * cs, r * cs, cs, cs);
        }
      }
    }

    // Path
    for (const cellKey of this.map.pathCells) {
      const [c, r] = cellKey.split(',').map(Number);
      ctx.fillStyle = '#ffe8cc';
      ctx.fillRect(c * cs, r * cs, cs, cs);
      // Path border/shadow
      ctx.fillStyle = '#ffd9a0';
      ctx.fillRect(c * cs, r * cs, cs, 2);
      ctx.fillRect(c * cs, r * cs, 2, cs);
    }

    // Path center line (dotted)
    ctx.save();
    ctx.strokeStyle = 'rgba(200, 160, 100, 0.3)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    for (let i = 0; i < this.map.pathPixels.length; i++) {
      const p = this.map.pathPixels[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= CONFIG.ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cs);
      ctx.lineTo(CANVAS_W, r * cs);
      ctx.stroke();
    }
    for (let c = 0; c <= CONFIG.COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cs, 0);
      ctx.lineTo(c * cs, CANVAS_H);
      ctx.stroke();
    }

    // Decorations (Canvas hand-drawn)
    for (const d of this.map.decorations) {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.scale(d.size / 15, d.size / 15);
      if (d.decoType === 'flower1') {
        ctx.fillStyle = '#ffb3ba'; ctx.beginPath(); ctx.arc(0,-4,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffb3ba'; ctx.beginPath(); ctx.arc(-4,2,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffb3ba'; ctx.beginPath(); ctx.arc(4,2,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffffba'; ctx.beginPath(); ctx.arc(0,0,3,0,Math.PI*2); ctx.fill();
      } else if (d.decoType === 'flower2') {
        ctx.fillStyle = '#bae1ff'; ctx.beginPath(); ctx.arc(-3,-3,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#bae1ff'; ctx.beginPath(); ctx.arc(3,-3,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#bae1ff'; ctx.beginPath(); ctx.arc(-3,3,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#bae1ff'; ctx.beginPath(); ctx.arc(3,3,4,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffffba'; ctx.beginPath(); ctx.arc(0,0,3,0,Math.PI*2); ctx.fill();
      } else if (d.decoType === 'grass') {
        ctx.fillStyle = '#baffc9';
        ctx.beginPath(); ctx.moveTo(0,4); ctx.quadraticCurveTo(-4,0,-6,-6); ctx.quadraticCurveTo(-2,2,0,4); ctx.fill();
        ctx.beginPath(); ctx.moveTo(0,4); ctx.quadraticCurveTo(0,-2,0,-8); ctx.quadraticCurveTo(2,0,0,4); ctx.fill();
        ctx.beginPath(); ctx.moveTo(0,4); ctx.quadraticCurveTo(4,0,6,-6); ctx.quadraticCurveTo(2,2,0,4); ctx.fill();
      } else if (d.decoType === 'mushroom') {
        ctx.fillStyle = '#fff'; ctx.fillRect(-2,0,4,6);
        ctx.fillStyle = '#ffb3ba'; ctx.beginPath(); ctx.arc(0,0,6,Math.PI,0); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-3,-2,1.5,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(2,-3,1,0,Math.PI*2); ctx.fill();
      }
      ctx.restore();
    }

    // Entry (Cute Doorway at top)
    const entry = this.map.pathPixels[0];
    const exit = this.map.pathPixels[this.map.pathPixels.length - 1];
    ctx.save();
    ctx.translate(entry.x, Math.max(16, entry.y + 25));
    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(-12, -18, 24, 36);
    ctx.beginPath(); ctx.arc(0, -18, 12, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#6b4226';
    ctx.fillRect(-10, -16, 20, 34);
    ctx.beginPath(); ctx.arc(0, -16, 10, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#ffd700';
    ctx.beginPath(); ctx.arc(6, 0, 2, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // Exit (Cute House at bottom)
    ctx.save();
    ctx.translate(exit.x, Math.min(CANVAS_H - 16, exit.y - 25));
    ctx.fillStyle = '#f5deb3';
    ctx.fillRect(-14, -10, 28, 20);
    ctx.fillStyle = '#fa8072';
    ctx.beginPath(); ctx.moveTo(-18, -10); ctx.lineTo(0, -22); ctx.lineTo(18, -10); ctx.fill();
    ctx.fillStyle = '#8b4513';
    ctx.fillRect(-4, -2, 8, 12);
    ctx.fillStyle = '#87ceeb';
    ctx.fillRect(-10, -6, 6, 6);
    ctx.fillRect(4, -6, 6, 6);
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
      item.addEventListener('click', () => this.selectTowerType(key));
      list.appendChild(item);
    }

    // Buttons
    const bindTap = (btnId, handler) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.onclick = (e) => {
        dbgLog('🎯 Button click: #' + btnId);
        handler();
      };
      btn.ontouchend = (e) => {
        dbgLog('📱 Button touchend: #' + btnId);
        handler();
      };
    };

    bindTap('start-btn', () => this.startGame());
    bindTap('start-wave-btn', () => this.startNextWave());
    bindTap('retry-btn', () => this.restartGame());
    bindTap('replay-btn', () => this.restartGame());
    bindTap('speed-btn', () => this.toggleSpeed());
    bindTap('sound-btn', () => this.toggleSound());
    bindTap('upgrade-btn', () => this.upgradeTower());
    bindTap('sell-btn', () => this.sellTower());
    bindTap('close-info-btn', () => this.deselectTower());
    bindTap('fullscreen-btn', () => this.toggleFullscreen());

    // Fullscreen change listener
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
    document.addEventListener('webkitfullscreenchange', () => this.onFullscreenChange());

    // Responsive canvas scaling
    window.addEventListener('resize', () => this.resizeCanvas());
    this.resizeCanvas();

    // Best score
    document.getElementById('best-score').textContent = this.bestScore;
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
      if (e.touches && e.touches.length > 0) {
        const touch = e.touches[0];
        const pos = getCanvasPos(touch.clientX, touch.clientY);
        this.handleCanvasPoint(pos.x, pos.y);
      }
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      if (e.target === this.canvas) {
        e.preventDefault();
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

    // Right click to cancel
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.selectedTowerType = null;
      this.deselectTower();
      this.updateTowerPanel();
    });

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
    document.getElementById('tower-info').classList.add('hidden');
    this.canvas.style.cursor = 'crosshair';
  }

  showTowerInfo(tower) {
    const stats = tower.getStats();
    const info = document.getElementById('tower-info');
    info.classList.remove('hidden');

    document.getElementById('tower-info-name').textContent = `${tower.data.emoji} ${tower.data.name}`;
    document.getElementById('tower-info-level').textContent = `等級 ${tower.level} / ${CONFIG.MAX_LEVEL}`;

    let statsHtml = '';
    if (tower.typeKey === 'sunflower') {
      statsHtml = `💰 產金：${stats.goldPerSecond}/秒`;
    } else {
      statsHtml = `⚔️ 傷害：${stats.damage}<br>`;
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

  saveBestScore() {
    if (this.score > this.bestScore) {
      this.bestScore = this.score;
      localStorage.setItem(CONFIG.LS_KEY, this.bestScore);
      document.getElementById('best-score').textContent = this.bestScore;
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
    document.getElementById('speed-btn').textContent = `⏩ ${this.speedMultiplier}x`;
  }

  toggleSound() {
    const enabled = this.sfx.toggle();
    document.getElementById('sound-btn').textContent = enabled ? '🔊' : '🔇';
  }

  toggleFullscreen() {
    const docEl = document.documentElement;
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    
    if (!isFullscreen) {
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen().catch(err => {
          this.showToast('📱 可將網頁「加入主畫面」享受全螢幕體驗');
        });
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      } else {
        // iOS Safari 通常不支援 DOM 全螢幕 API
        this.showToast('📱 點擊「分享」>「加入主畫面」即可全螢幕遊玩');
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(err => console.log(err));
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
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

    if (window.innerWidth >= 1024) {
      // 桌機模式保持原生 900x550 或適當縮放
      const maxW = Math.min(window.innerWidth - 230, CANVAS_W);
      const maxH = Math.min(window.innerHeight - 70, CANVAS_H);
      const scale = Math.min(maxW / CANVAS_W, maxH / CANVAS_H, 1);
      this.canvas.style.width = `${Math.floor(CANVAS_W * scale)}px`;
      this.canvas.style.height = `${Math.floor(CANVAS_H * scale)}px`;
    } else {
      // 行動端模式：依據 game-viewport 實體可用空間填滿最大可能面積
      const availW = viewport.clientWidth - 8;
      const availH = viewport.clientHeight - 8;
      
      if (availW <= 0 || availH <= 0) return;
      
      const scale = Math.min(availW / CANVAS_W, availH / CANVAS_H);
      this.canvas.style.width = `${Math.floor(CANVAS_W * scale)}px`;
      this.canvas.style.height = `${Math.floor(CANVAS_H * scale)}px`;
    }
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
      item.classList.toggle('selected', this.selectedTowerType === type);
    });
  }

  updateWavePreview() {
    const preview = document.getElementById('wave-preview');
    if (this.currentWave >= CONFIG.TOTAL_WAVES) {
      preview.textContent = '';
      return;
    }
    const wave = WAVE_DATA[this.currentWave];
    const enemies = wave.enemies.map((g) => `${ENEMY_DATA[g.type].emoji}×${g.count}`).join(' ');
    preview.textContent = `下一波：${enemies}`;
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
