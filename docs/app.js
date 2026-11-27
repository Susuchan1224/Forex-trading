/* =================================================================
   Kurumi FX 学院 · 前端核心逻辑
   ---------------------------------------------------------------
   模块：
     1. 工具 / i18n / 主题
     2. 后端联动（会话 / 上报 / 统计，静默降级）
     3. 单一账户模型 + 单一行情源
     4. 滚动引擎（section 插值 → CSS 变量 → 覆盖层强度）
     5. 颜料转场（动画同款：前半段彩色，亏钱后变暗红并往下淌）
     6. 事件：通知堆栈 / K 线崩塌 / 强制平仓 / 系统日志 / 你的记录
     7. 回顶清算 + 全屏惊吓
     8. Web Audio 程序化音效

   设计原则：
     同一个数字只能有一个来源。
     图表上的盈亏 = 图表最后一根已揭示 K 线的收盘价换算，不是另一段字符串。
   ================================================================= */

/* ---------------- 1. 工具 ---------------- */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, f) => {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * f).toString(16).padStart(2, '0')).join('');
};
const fmtJPY = n => (n < 0 ? '−' : '+') + '¥' + Math.abs(Math.round(n)).toLocaleString('zh-CN');
const pad2 = n => String(n).padStart(2, '0');
const mmss = ms => {
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
};

/* ---------------- 1.1 i18n ---------------- */

const STORE_KEY = 'kurumi-fx-lang';
const I18N = { zh: {}, en: {} };

(function harvestI18n() {
  $$('[data-i18n]').forEach(el => { I18N.zh[el.dataset.i18n] = el.innerHTML; });
  $$('[data-i18n-html]').forEach(el => { I18N.zh[el.dataset.i18nHtml] = el.innerHTML; });
})();

function detectLang() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (e) { /* 隐私模式 */ }
  return /^zh/i.test(navigator.language) ? 'zh' : 'en';
}
let LANG = detectLang();
const t = key => I18N[LANG]?.[key] ?? I18N.zh[key] ?? key;

function applyStatic() {
  $$('[data-i18n]').forEach(el => { const v = t(el.dataset.i18n); if (v) el.innerHTML = v; });
  $$('[data-i18n-html]').forEach(el => { const v = t(el.dataset.i18nHtml); if (v) el.innerHTML = v; });
}
function setLang(l, persist) {
  LANG = l === 'en' ? 'en' : 'zh';
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  if (persist) { try { localStorage.setItem(STORE_KEY, LANG); } catch (e) {} }
  applyStatic();
}
window.setLang = setLang;
document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';

/* ---------------- 1.2 主题 ---------------- */

const THEME_KEY = 'kurumi-theme';
/**
 * 默认必须是浅色。
 * 叙事建立在「蓝白可信 → 夜蓝失眠 → 近黑爆仓」的渐变上，若跟随系统深色模式，
 * 第一屏就是黑的，整条色彩叙事线全部失效。只有用户显式点过切换才启用深色。
 */
let darkMode = (() => {
  try { return localStorage.getItem(THEME_KEY) === 'dark'; } catch (e) { return false; }
})();

const rgb2hsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - b) / d + 4) / 6;
  }
  return [h, s, l];
};
const hsl2hex = (h, s, l) => {
  const f = n => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
};
function themeColor(h, role) {
  if (!darkMode) return h;
  const [H, S, L] = rgb2hsl(...hex(h));
  if (role === 'bg') return hsl2hex(H, Math.min(S, .30), .07 + (1 - L) * .05);
  if (role === 'fg') return hsl2hex(H, Math.min(S, .14), .84 + L * .05);
  return hsl2hex(H, Math.min(Math.max(S, .35), .60), .52 + L * .08);
}

/* ---------------- 2. 后端联动 ---------------- */

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

let sessionId = null;
let eventQueue = [];
let lastTrackAt = 0;
let backendOK = false;
const API_BASE = '';
const SHARE_CODE = new URLSearchParams(location.search).get('sharecode') || '';
const apiURL = path => SHARE_CODE ? `${API_BASE}${path}?sharecode=${encodeURIComponent(SHARE_CODE)}` : `${API_BASE}${path}`;

const MAX_QUEUE = 80;
const FLUSH_TIMEOUT = 6000;
const withTimeout = () => (AbortSignal.timeout ? AbortSignal.timeout(FLUSH_TIMEOUT) : undefined);

async function initSession() {
  try {
    const res = await fetch(apiURL('/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAgent: navigator.userAgent.slice(0, 300),
        screen: `${innerWidth}x${innerHeight}`,
        language: LANG
      }),
      signal: withTimeout()
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || typeof data.sessionId !== 'string') throw new Error('bad payload');
    sessionId = data.sessionId;
    backendOK = true;
  } catch (e) {
    backendOK = false;
    eventQueue.length = 0;
  }
}

function track(type, value) {
  if (!backendOK) return;
  eventQueue.push({ type, value: value === undefined ? null : String(value).slice(0, 120), t: Date.now() });
  if (eventQueue.length > MAX_QUEUE) eventQueue.splice(0, eventQueue.length - MAX_QUEUE);
  if (Date.now() - lastTrackAt > 3000 || eventQueue.length >= 20) flush();
}

let flushing = false;
async function flush() {
  if (!backendOK || !sessionId || !eventQueue.length || flushing) return;
  flushing = true;
  const batch = eventQueue.splice(0);
  lastTrackAt = Date.now();
  try {
    const res = await fetch(apiURL('/api/track'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, events: batch }),
      signal: withTimeout()
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    eventQueue = batch.concat(eventQueue).slice(-MAX_QUEUE);
  } finally {
    flushing = false;
  }
}

/**
 * 结尾统计。
 * 冷启动时真实值很小（1~5 人），直接显示「0 人决定远离 FX」会反过来削弱劝导效果
 * ——它证明的不是 FX 危险，而是这个页面没人看。
 * 因此：真实值 + 固定基线，且基线在页面上明示过。
 */
const STAT_BASE = { total: 8124, abstain: 1793, dwell: 4.6 };

async function loadStats() {
  const totalEl = $('#statTotal');
  if (!totalEl) return;
  const set = (tot, abs, dwell) => {
    totalEl.textContent = Math.round(tot).toLocaleString('zh-CN');
    const a = $('#statAbstain'), d = $('#statDwell');
    if (a) a.textContent = Math.round(abs).toLocaleString('zh-CN');
    if (d) d.textContent = dwell.toFixed(1);
  };
  try {
    const res = await fetch(apiURL('/api/stats'), { signal: withTimeout() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    const ok = s && ['total', 'abstained', 'avgDwell'].every(k => Number.isFinite(Number(s[k])));
    if (!ok) throw new Error('bad payload');
    set(STAT_BASE.total + Number(s.total), STAT_BASE.abstain + Number(s.abstained), STAT_BASE.dwell + Number(s.avgDwell) / 60);
  } catch (e) {
    set(STAT_BASE.total, STAT_BASE.abstain, STAT_BASE.dwell);
  }
}

function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.remove('on'), 3600);
}

/* ---------------- 3. 账户与行情（唯一数据源） ---------------- */

const LEVERAGE = 25;
const ENTRY = 154.80;

const ACCOUNT = {
  deposit: 300000,
  floatingPnl: 12450,
  usedMargin: 120000,
  state: 'profit'
};

const market = {
  base: 155.00,
  entry: ENTRY,
  price: 155.12,
  notional: ACCOUNT.usedMargin * LEVERAGE,
  get pnlPerYen() { return this.notional / this.base; },
  history: [],
  points: 30,
  tickMs: 2000
};

const pnlFromPrice = price => (price - market.entry) * market.pnlPerYen;

function derive() {
  const equity = ACCOUNT.deposit + ACCOUNT.floatingPnl;
  const freeMargin = equity - ACCOUNT.usedMargin;
  const marginLevel = ACCOUNT.usedMargin > 0 ? Math.max(0, equity / ACCOUNT.usedMargin * 100) : 0;
  return { equity, freeMargin, marginLevel };
}

/** 维持率分级：100% 追证 / 50% 强平（日本实务常见档位） */
function marginText(level) {
  if (level >= 200) return { text: '充足', cls: 'ok' };
  if (level >= 100) return { text: '注意', cls: 'warn' };
  if (level >= 50) return { text: '危险', cls: 'bad' };
  return { text: '即将强平', cls: 'bad' };
}

function renderAccount() {
  const { equity, freeMargin, marginLevel } = derive();
  const balanceEl = $('#heroBalance');
  const pnlEl = $('#heroToday');
  const pnlBox = $('#heroTodayBox');
  const marginEl = $('#heroMargin');
  const freeEl = $('#heroFree');
  if (!balanceEl || !pnlEl) return;

  balanceEl.textContent = '¥' + Math.round(equity).toLocaleString('zh-CN');
  const p = ACCOUNT.floatingPnl;
  pnlEl.textContent = fmtJPY(p);
  if (pnlBox) pnlBox.className = 'pnl ' + (p >= 0 ? 'up' : 'down');
  if (freeEl) freeEl.textContent = '¥' + Math.round(Math.max(0, freeMargin)).toLocaleString('zh-CN');
  if (marginEl) {
    const m = marginText(marginLevel);
    marginEl.textContent = m.text;
    marginEl.className = m.cls;
  }
}

function initMarketHistory() {
  const end = market.entry + ACCOUNT.floatingPnl / market.pnlPerYen;
  const start = market.entry - 0.35;
  market.history = [];
  for (let i = 0; i < market.points; i++) {
    const k = i / (market.points - 1);
    market.history.push(start + (end - start) * k + (Math.random() - .45) * .10);
  }
  market.price = market.history[market.history.length - 1];
  ACCOUNT.floatingPnl = pnlFromPrice(market.price);
}

function tickMarket() {
  if (ACCOUNT.state === 'bust' || marketFrozen) return;
  const drift = .014, vol = .09;
  const next = market.price + (Math.random() - .5) * vol + drift;
  market.price = Math.max(market.base * .9, Math.min(market.base * 1.1, next));
  market.history.push(market.price);
  if (market.history.length > market.points) market.history.shift();
  ACCOUNT.floatingPnl = pnlFromPrice(market.price);
  drawMiniChart();
  renderAccount();
}

function drawMiniChart() {
  const box = $('#heroChart');
  if (!box) return;
  const W = 300, H = 80;
  const pts = market.history;
  if (!pts.length) return;
  const max = Math.max(...pts), min = Math.min(...pts);
  const span = max - min || 1;
  const norm = v => H - 8 - ((v - min) / span) * (H - 16);
  const coords = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${norm(v).toFixed(1)}`).join(' ');
  const up = ACCOUNT.state !== 'bust' && pts[pts.length - 1] >= pts[0];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${coords}" fill="none" stroke="${up ? '#2563EB' : '#DC2626'}" stroke-width="2"/></svg>`;
}

let marketTimer = null, marketFrozen = false;
function startMarketLoop() {
  if (marketTimer) return;
  marketTimer = setInterval(() => { if (!document.hidden) tickMarket(); }, market.tickMs);
}
function stopMarketLoop() {
  if (marketTimer) { clearInterval(marketTimer); marketTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMarketLoop(); else startMarketLoop();
});

/* ---------------- 4. 滚动引擎 ---------------- */

const root = document.documentElement;
const secs = $$('[data-bg]');
const noiseEl = $('#noise');
const vig = $('#vig');
const scan = $('#scan');
const mainEl = $('main');
const footEl = $('footer');

let D = 0;
let ticking = false;
let currentSection = '';
let statsLoaded = false;
let horrorRevealed = false;
let witnessedBottom = false;
let pendingBust = false;
let titleLockUntil = 0;

const BOOT_AT = Date.now();
const sectionMs = {};          // 每个 section 累计停留
let lastSectionAt = BOOT_AT;
let peakY = 0;
let backScrolls = 0;

/** 粘性区进度：0 = 刚贴顶，1 = 粘性结束 */
function stickyP(el) {
  if (!el) return 0;
  const span = el.offsetHeight - innerHeight;
  if (span <= 0) return clamp((scrollY - el.offsetTop) / (innerHeight || 1));
  return clamp((scrollY - el.offsetTop) / span);
}

function frame() {
  ticking = false;
  const vh = innerHeight;
  const mid = scrollY + vh * .5;

  let i = secs.findIndex(s => s.offsetTop + s.offsetHeight > mid);
  if (i < 0) i = secs.length - 1;
  const s = secs[i], n = secs[Math.min(i + 1, secs.length - 1)];

  const p = clamp((((mid - s.offsetTop) / s.offsetHeight) - .55) / .45);
  let bgC = mix(s.dataset.bg, n.dataset.bg, p);
  let fgC = mix(s.dataset.fg, n.dataset.fg, p);
  let acC = mix(s.dataset.ac, n.dataset.ac, p);

  /**
   * 回顶后的「世界翻转」。
   * 只改文案不够——白底蓝字里写着「它一直在等你回来」，情绪是错的。
   * 接近顶部时把整套配色压成近黑 + 血红，越往下滚恢复得越多。
   */
  let horrorK = 0;
  if (horrorRevealed) {
    horrorK = clamp(1 - scrollY / (vh * 1.15));
    if (horrorK > 0) {
      const k = Math.pow(horrorK, .8);
      bgC = mix(bgC, '#0F0A0C', k * .96);
      fgC = mix(fgC, '#F2DADA', k * .92);
      acC = mix(acC, '#C8102E', k * .92);
    }
  }

  root.style.setProperty('--bg', themeColor(bgC, 'bg'));
  root.style.setProperty('--fg', themeColor(fgC, 'fg'));
  root.style.setProperty('--accent', themeColor(acC, 'ac'));
  D = +s.dataset.d + (+n.dataset.d - +s.dataset.d) * p;
  if (horrorRevealed) D = Math.max(D, .22);
  root.style.setProperty('--d', D.toFixed(3));

  noiseEl.style.opacity = clamp((D - .3) * .5, 0, .34);
  vig.style.opacity = Math.max(clamp((D - .42) * .95), horrorK * .5);
  scan.style.opacity = clamp((D - .66) * 1.1, 0, .4);

  // 灰化收束只压到 .22：早期版本用 .35，把「我决定远离 FX」这个唯一的
  // 行动按钮也一起灰掉了——越是需要红色警示的段落，红色被吃得越狠。
  const gray = clamp((D - .82) / .18);
  const filter = gray > .01 ? `grayscale(${(gray * .22).toFixed(3)}) brightness(${(1 - gray * .10).toFixed(3)})` : '';
  if (mainEl) mainEl.style.filter = filter;
  if (footEl) footEl.style.filter = filter;

  const titles = [
    [0,   'Kurumi FX 学院 · 轻松赚回 2000 万'],
    [.26, 'Kurumi FX · 关于讲师'],
    [.42, 'Kurumi FX · 03:14'],
    [.50, 'Kurumi FX · 今晚'],
    [.58, 'Kurumi FX · 再等等'],
    [.66, 'Kurumi · 强制平仓'],
    [.74, 'kurumi — 系统日志'],
    [.82, 'kurumi — 你的记录'],
    [.93, '这不是投资'],
    [1,   '别成为下一个久留美']
  ];
  let tt = titles[0][1];
  titles.forEach(([th, v]) => { if (D >= th) tt = v; });
  if (horrorRevealed) tt = 'Kurumi FX · 清算完成';
  if (!document.hidden && Date.now() > titleLockUntil && document.title !== tt) document.title = tt;

  const id = s.id || `sec-${i}`;
  if (id !== currentSection) {
    const now = Date.now();
    sectionMs[currentSection] = (sectionMs[currentSection] || 0) + (now - lastSectionAt);
    lastSectionAt = now;
    currentSection = id;
    track('section_enter', id);
  }

  if (D > .96 && !statsLoaded) { statsLoaded = true; loadStats(); }
  if (D > .95) witnessedBottom = true;

  checkSplashes();
  updateNotify();
  updateChart();
  updateLosscut();
  updateLog();
  updateYou();
  updateWhisperAnchor();
  updateDeepMode();

  syncScrollBtn();
  updateAudio();
}

/** 深度区：隐藏营销导航与悬浮控件 */
const DEEP_SECS = ['#losscut', '#log'];
function updateDeepMode() {
  const deep = DEEP_SECS.some(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < innerHeight * .35 && r.bottom > innerHeight * .65;
  });
  document.body.classList.toggle('deep', deep);
}

addEventListener('scroll', () => {
  if (!ticking) { ticking = true; requestAnimationFrame(frame); }
  const docH = document.documentElement.scrollHeight - innerHeight;
  if (docH > 0) track('scroll', (scrollY / docH).toFixed(3));

  // 「往回滚」计数：每次明显上滑（>250px）记一次
  if (scrollY > peakY) peakY = scrollY;
  else if (peakY - scrollY > 250) { backScrolls++; peakY = scrollY; }
}, { passive: true });
addEventListener('resize', () => { frame(); sizeNoise(); sizePaint(); });

/* ---------------- 4.1 噪点 ---------------- */

let nctx = noiseEl.getContext('2d');
let imgData = nctx.createImageData(320, 180);

function sizeNoise() {
  // 1 个噪声像素 ≈ 2 个 CSS 像素：放大后是颗粒，不是马赛克
  const w = Math.max(160, Math.ceil(innerWidth / 2));
  const h = Math.max(120, Math.ceil(innerHeight / 2));
  if (noiseEl.width === w && noiseEl.height === h) return;
  noiseEl.width = w; noiseEl.height = h;
  imgData = nctx.createImageData(w, h);
}

let noiseFrame = 0;
function drawNoise() {
  if (REDUCED_MOTION || document.hidden) return;
  if (+noiseEl.style.opacity < .01) return;
  const w = noiseEl.width, h = noiseEl.height;
  const band = Math.ceil(h / 4);
  const from = (noiseFrame % 4) * band;
  const to = Math.min(h, from + band);
  const d = imgData.data;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const v = 90 + Math.random() * 90;
      d[k] = d[k + 1] = d[k + 2] = v;
      d[k + 3] = 255;
    }
  }
  nctx.putImageData(imgData, 0, 0, 0, from, w, to - from);
  noiseFrame++;
}

/* ---------------- 4.2 抖动 ---------------- */

setInterval(() => {
  if (REDUCED_MOTION || document.hidden || D < .18) return;
  const all = $$('.twitch');
  if (!all.length) return;
  const el = all[Math.floor(Math.random() * all.length)];
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  if (Math.random() < D * .75) {
    const k = D * D * 10;
    el.style.setProperty('--tw-x', `${(Math.random() - .5) * k}px`);
    el.style.setProperty('--tw-y', `${(Math.random() - .5) * k}px`);
    el.style.setProperty('--tw-sk', `${(Math.random() - .5) * k * .4}deg`);
    setTimeout(() => {
      el.style.setProperty('--tw-x', '0px');
      el.style.setProperty('--tw-y', '0px');
      el.style.setProperty('--tw-sk', '0deg');
    }, 70 + Math.random() * 130);
  }
}, 120);

/* ---------------- 4.3 耳语 ---------------- */

const WHISPERS = [
  '再补一点，就快回本了。',
  '你确定要现在平仓吗？',
  '就最后一次。',
  '它还在跳动。',
  '老实赚钱，很枯燥吧？'
];
let whisperIdx = 0, idleTimer;
const whisperEl = $('#whisper');

function poke() {
  if (!whisperEl) return;
  whisperEl.classList.remove('on');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (D > .5 && !document.hidden) {
      whisperEl.textContent = WHISPERS[whisperIdx++ % WHISPERS.length];
      whisperEl.classList.add('on');
      track('idle_whisper');
      if (audio) whisperSound();
    }
  }, 7000);
}
addEventListener('pointermove', poke, { passive: true });
addEventListener('keydown', poke);

function updateWhisperAnchor() {
  if (!whisperEl) return;
  const end = $('#end');
  const nearEnd = end && end.offsetTop - scrollY < innerHeight * .8;
  whisperEl.classList.toggle('high', !!nearEnd);

  // 恐惧值不足时清掉残留的低语（程序化滚动不会触发 pointermove）
  if (D < .45) whisperEl.classList.remove('on');

  const dense = ['#notify', '#chart', '#losscut', '#log', '#you', '#end', '.kurumi-stage'];
  const collide = dense.some(id => {
    const el = $(id);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < innerHeight * .72 && r.bottom > innerHeight * .3;
  });
  whisperEl.classList.toggle('mute', collide);
}

/* =================================================================
   5. 颜料转场
   -----------------------------------------------------------------
   参考原作 OP 的转场：不是「模糊色块铺满屏幕」，而是
     · 黑底上极锐利的不透明颜料块，大小差异极大
     · 被甩出来的细长液体丝线，末端带一颗珠子
     · 大量细小的飞溅颗粒，密度沿喷射方向衰减
     · 颜料「挂」在画面上停一会儿，然后才开始消失
   所以这里分三层画：颜料块（不规则多边形 + 二次曲线平滑）、
   拖丝（沿贝塞尔采样成锥形）、颗粒。整层先画进离屏缓冲，
   再统一淡出 —— 这样颜料是真的「留在墙上」，而不是每帧随机闪烁。

   配色由调用方决定：同一个效果，前半段是糖纸色，后半段是血色。
   ================================================================= */

const paintEl = $('#paint');
const pctx = paintEl.getContext('2d');
let paintBuf = document.createElement('canvas');
let bctx = paintBuf.getContext('2d');
let splashToken = 0;

const TAU = Math.PI * 2;

/**
 * 调色板。
 * veil 是转场时压住页面的底色 —— 必须是深的。
 * 早期版本用同色系亮色当 veil，结果整屏变成一层粉色滤镜，
 * 而原作是「黑底上的彩色颜料」：底色越暗，颜料才越跳。
 */
const PALETTES = {
  bright: { colors: ['#FF4D6D', '#FFC93C', '#2EC4B6', '#7C5CFF', '#FF8A3D'], w: [.46, .22, .14, .1, .08], veil: '#2A1220', veilA: .52, drip: false },
  // 混进一块脏红：还是糖纸色，但有一个颜色不对
  wrong:  { colors: ['#FF4D6D', '#FFC93C', '#2EC4B6', '#7C5CFF', '#6E0C14'], w: [.38, .2, .12, .1, .2], veil: '#241020', veilA: .55, drip: false },
  red:    { colors: ['#E03A3A', '#C8102E', '#8C0F1C', '#5C0A12'], w: [.34, .3, .22, .14], veil: '#240508', veilA: .60, drip: true },
  blood:  { colors: ['#C8102E', '#A3140B', '#8C0F1C', '#5C0A12'], w: [.32, .3, .24, .14], veil: '#1A0306', veilA: .66, drip: true }
};

function sizePaint() {
  paintEl.width = innerWidth;
  paintEl.height = innerHeight;
  paintBuf.width = innerWidth;
  paintBuf.height = innerHeight;
  bctx = paintBuf.getContext('2d');
}

/** 按权重取色，避免均匀随机导致五彩斑斓像糖果 */
function pickColor(pal) {
  let r = Math.random();
  for (let i = 0; i < pal.colors.length; i++) {
    r -= pal.w[i];
    if (r <= 0) return pal.colors[i];
  }
  return pal.colors[0];
}

/**
 * 一块颜料：极坐标上抖动的多边形 + 二次曲线过中点平滑。
 * 抖动幅度故意放大（0.42~1.6），否则每块都长成同一颗糖豆。
 */
function paintBlob(ctx, x, y, r, ang, stretch, color, irregular = 1) {
  const n = 8 + (r > 58 ? 6 : 0) + (Math.random() * 6 | 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + (Math.random() - .5) * .5;
    const rr = r * (1 - .42 * irregular + Math.random() * 1.2 * irregular);
    const lx = Math.cos(a) * rr * stretch;
    const ly = Math.sin(a) * rr;
    pts.push([
      x + Math.cos(ang) * lx - Math.sin(ang) * ly,
      y + Math.sin(ang) * lx + Math.cos(ang) * ly
    ]);
  }
  ctx.beginPath();
  ctx.moveTo((pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2);
  for (let i = 0; i < n; i++) {
    const c = pts[i], nx = pts[(i + 1) % n];
    ctx.quadraticCurveTo(c[0], c[1], (c[0] + nx[0]) / 2, (c[1] + nx[1]) / 2);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // 朝来向拖一条尾 —— 这是「液体」和「色块」最大的区别
  if (stretch > 1.15) {
    const tl = r * (0.9 + Math.random() * 2.4) * stretch;
    const back = ang + Math.PI;
    const side = Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(back + side) * r * .42, y + Math.sin(back + side) * r * .42);
    ctx.lineTo(x + Math.cos(back) * tl, y + Math.sin(back) * tl);
    ctx.lineTo(x + Math.cos(back - side) * r * .42, y + Math.sin(back - side) * r * .42);
    ctx.closePath();
    ctx.fill();
  }
}

const qbez = (p0, p1, p2, t) => {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
  ];
};

/** 拖丝：沿贝塞尔采样成锥形，由粗到细，尾巴挂一颗珠子 */
function filament(ctx, x0, y0, ang, len, w, color, curl) {
  const a = ang + curl;
  const p0 = [x0, y0];
  const p1 = [x0 + Math.cos(a - curl * .9) * len * .5, y0 + Math.sin(a - curl * .9) * len * .5];
  const p2 = [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len];
  const N = 16;
  const pts = [];
  for (let i = 0; i <= N; i++) pts.push(qbez(p0, p1, p2, i / N));

  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const o = pts[Math.max(0, i - 1)];
    let dx = q[0] - o[0], dy = q[1] - o[1];
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const ww = lerp(w, w * .1, Math.pow(i / (pts.length - 1), .7)) / 2;
    left.push([p[0] - dy * ww, p[1] + dx * ww]);
    right.push([p[0] + dy * ww, p[1] - dx * ww]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p2[0], p2[1], Math.max(1.1, w * .22), 0, TAU);
  ctx.fill();
}

/**
 * 一次转场。
 *
 * 密度分布是关键：早期版本用均匀随机，结果全屏撒得像彩纸。
 * 现在按指数衰减堆在喷射源附近 —— 近处是几个大团块叠成的一整片，
 * 远处只剩零星的小点和拖丝，这才是「喷」出来的样子。
 *
 * 每一块都有出生时间，按序永久画进离屏缓冲，所以颜料是真的挂在墙上，
 * 主画布每帧只做「底色 + 缓冲 + 淡出」。
 */
function splash(key, opts = {}) {
  const pal = PALETTES[key] || PALETTES.bright;
  if (REDUCED_MOTION) { flashScreen(pal.veil, .34, 320); return; }

  const token = ++splashToken;
  const W = paintEl.width, H = paintEl.height;
  if (!W || !H) return;

  const BURST = opts.burst ?? 430;
  const HOLD = opts.hold ?? 340;
  const FADE = opts.fade ?? 620;
  const total = BURST + HOLD + FADE;

  bctx.clearRect(0, 0, W, H);

  // 喷射源：靠近某条边，朝画面内侧
  const side = Math.random() < .5 ? -1 : 1;
  const ox = W * (0.5 + side * (0.3 + Math.random() * 0.14));
  const oy = H * (0.26 + Math.random() * 0.48);
  const dir = Math.atan2(H * .5 - oy, W * .5 - ox) + (Math.random() - .5) * .4;
  const maxR = Math.hypot(W, H) * .9;

  const queue = [];
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * .9;

  // 每一层：数量、距离分布、半径范围、角扩散
  const layers = [
    { n: 24, dExp: 2.2, dMul: .36, rMin: 30, rMax: 88, spread: .34, tMul: .55 },
    { n: 34, dExp: 1.8, dMul: .62, rMin: 14, rMax: 52, spread: .55, tMul: .72 },
    { n: 54, dExp: 1.35, dMul: 1.0, rMin: 4, rMax: 16, spread: .85, tMul: .88 },
    { n: 115, dExp: 1.7, dMul: .92, rMin: .8, rMax: 3.4, spread: 1.0, tMul: 1 }
  ];

  layers.forEach(L => {
    for (let i = 0; i < L.n; i++) {
      const k = Math.pow(Math.random(), L.dExp);
      const dist = k * maxR * L.dMul;
      const ang = dir + gauss() * L.spread * (.4 + k);
      const x = ox + Math.cos(ang) * dist;
      const y = oy + Math.sin(ang) * dist;
      if (x < -160 || x > W + 160 || y < -160 || y > H + 160) continue;
      const r = lerp(L.rMax, L.rMin, k) * (0.5 + Math.random() * 1.0);
      const stretch = 1 + k * 2.1;
      const color = pickColor(pal);
      const at = 24 + k * BURST * L.tMul + Math.random() * 70;
      if (L.rMin < 2) {
        push(at, r, ctx => {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.ellipse(0, 0, r * (1.3 + k * 1.8), r, 0, 0, TAU);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.restore();
        });
      } else {
        push(at, r, ctx => paintBlob(ctx, x, y, r, ang, stretch, color));
      }
    }
  });

  // 拖丝：从大团块附近甩出去，短而粗，带卷曲
  for (let i = 0; i < 26; i++) {
    const k = Math.pow(Math.random(), 1.9);
    const ang = dir + gauss() * .7;
    const d0 = k * maxR * .3;
    const x0 = ox + Math.cos(ang) * d0;
    const y0 = oy + Math.sin(ang) * d0;
    const len = 60 + Math.random() * 300 * (1 - k * .5);
    const w = 1.4 + Math.random() * 6.5;
    const curl = (Math.random() - .5) * 2.4;
    const color = pickColor(pal);
    const at = 40 + Math.random() * BURST * .55;
    push(at, w, ctx => filament(ctx, x0, y0, ang, len, w, color, curl));
  }

  function push(at, size, draw) { queue.push({ at, size, draw }); }

  queue.sort((a, b) => a.at - b.at || b.size - a.size);

  // 下淌：只从真正有颜料的地方挂下来
  const drips = !pal.drip ? [] : Array.from({ length: 10 }, () => {
    const k = Math.pow(Math.random(), 1.7);
    const ang = dir + gauss() * .5;
    return {
      x: ox + Math.cos(ang) * k * maxR * .42,
      y: oy + Math.sin(ang) * k * maxR * .42,
      w: 5 + Math.random() * 13,
      len: 50 + Math.random() * 210,
      sp: .7 + Math.random() * .9,
      c: pal.colors[pal.colors.length - 1]
    };
  });

  const t0 = performance.now();
  let drawn = 0;

  (function frame(now) {
    if (token !== splashToken) return;
    const t = now - t0;
    if (t > total) { pctx.clearRect(0, 0, W, H); return; }

    while (drawn < queue.length && queue[drawn].at <= t) {
      queue[drawn].draw(bctx);
      drawn++;
    }

    const kf = clamp((t - BURST - HOLD) / FADE);
    const veilA = pal.veilA * clamp(t / 140) * (1 - kf * .92);

    pctx.clearRect(0, 0, W, H);
    if (veilA > .002) {
      pctx.globalAlpha = veilA;
      pctx.fillStyle = pal.veil;
      pctx.fillRect(0, 0, W, H);
    }
    pctx.globalAlpha = 1 - Math.pow(kf, 1.5) * .97;
    pctx.drawImage(paintBuf, 0, 0);

    // 往下淌：等颜料挂住之后才出现
    if (t > BURST * .55) {
      const kd = clamp((t - BURST * .55) / (total - BURST * .55));
      pctx.globalAlpha = (1 - kf) * .92;
      drips.forEach(d => {
        const y0 = d.y + kd * d.sp * H * 1.15;
        const y1 = y0 + d.len;
        if (y1 < 0) return;
        const wB = d.w * .28;
        pctx.fillStyle = d.c;
        pctx.beginPath();
        pctx.moveTo(d.x - d.w / 2, y0);
        pctx.lineTo(d.x + d.w / 2, y0);
        pctx.lineTo(d.x + wB / 2, y1);
        pctx.lineTo(d.x - wB / 2, y1);
        pctx.closePath();
        pctx.fill();
        pctx.beginPath();
        pctx.arc(d.x, y1, wB * 1.05, 0, TAU);
        pctx.fill();
      });
    }

    pctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  })(t0);

  if (audio) splashSound();
  track('splash_' + key);
}



/* 在哪里放转场：越靠后颜色越像血。
   at 是触发阈值（相对视口高度）——#losscut 提前到 .82，
   因为那一段是粘性全屏立绘，等它铺满屏幕就再也看不见背景了。 */
const SPLASH_AT = {
  '#success': { pal: 'bright', at: .46 },   // 糖纸色，全页最"快乐"的一屏
  '#notify':  { pal: 'wrong',  at: .46 },   // 还是彩色，但混了一块脏红
  '#losscut': { pal: 'blood',  at: .82 }    // 暗红，往下淌
};
const splashFired = {};

function checkSplashes() {
  for (const sel in SPLASH_AT) {
    if (splashFired[sel]) continue;
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const cfg = SPLASH_AT[sel];
    if (r.top < innerHeight * cfg.at && r.bottom > 0) {
      splashFired[sel] = true;
      splash(cfg.pal);
    }
  }
}

/* =================================================================
   6.1 通知堆栈 —— 今晚，你的手机
   ================================================================= */
const NOTES = [
  { time: '21:04', app: 'Kurumi FX', ico: 'K', cls: '',      title: '入金已完成', text: '¥100,000 已入账。祝你交易顺利。' },
  { time: '23:47', app: 'Kurumi FX', ico: 'K', cls: '',      title: '入金已完成', text: '¥300,000 已入账。<b>这笔钱是从哪来的？</b>' },
  { time: '02:31', app: 'Kurumi FX', ico: '!', cls: 'warn',  title: '追加保证金通知', text: '需要入金 <b>¥84,200</b>。剩余时间 47 分钟。' },
  { time: '03:14', app: 'Kurumi FX', ico: '!', cls: 'alert', title: '保证金维持率 96%', text: '已低于警戒线。持仓存在被强制平仓的风险。' },
  { time: '03:16', app: 'Kurumi FX', ico: '×', cls: 'alert', title: '强制平仓已执行', text: '全部持仓已平仓。账户余额 <b>¥0</b>。' }
];

let notifyShown = -1;
const npStack = $('#npStack');
const npCount = $('#npCount');
const npTime = $('#npTime');
const npHint = $('#npHint');

function updateNotify() {
  const sec = $('#notify');
  if (!sec || !npStack) return;
  const p = stickyP(sec);
  const k = p < .18 ? 0 : Math.min(NOTES.length, Math.ceil((p - .18) / .74 * NOTES.length));
  if (k === notifyShown) return;
  const grew = k > notifyShown;
  notifyShown = k;

  npStack.innerHTML = '';
  NOTES.slice(0, k).forEach((nt, idx) => {
    const el = document.createElement('div');
    el.className = 'np-note ' + nt.cls;
    el.innerHTML = `<div class="np-note__ico">${nt.ico}</div>
      <div class="np-note__body">
        <div class="np-note__top"><span>${nt.app}</span><span>${nt.time}</span></div>
        <div class="np-note__title">${nt.title}</div>
        <div class="np-note__text">${nt.text}</div>
      </div>`;
    npStack.appendChild(el);
    requestAnimationFrame(() => setTimeout(() => el.classList.add('on'), 30 + idx * 8));
  });
  if (npCount) npCount.textContent = k;
  if (npTime && k > 0) npTime.textContent = NOTES[k - 1].time;
  // 最后一条落下后，才亮出「发送方是你」——这是整段唯一一句点破的话
  if (npHint) npHint.classList.toggle('on', k >= NOTES.length);
  if (grew && k > 0) tickSound(.03);
}

/* =================================================================
   6.2 K 线：滚动驱动打印 + 崩塌
   ================================================================= */

const CHART = { W: 1000, H: 340, N: 52, pad: 6, crashAt: 40, data: [], revealed: -1, fired: false };
const candleGroups = () => $$('#bigChart .cd');

function buildCandles() {
  const list = [];
  let price = 154.85;
  for (let i = 0; i < CHART.N; i++) {
    const open = price;
    let close;
    if (i < CHART.crashAt) {
      close = Math.random() < .26
        ? open - .08 - Math.random() * .30
        : open + .15 + Math.random() * .55;
    } else if (i === CHART.crashAt) {
      close = open - 9.2;                                 // 那根 K 线
    } else {
      close = open - .55 - Math.random() * 1.05;
    }
    const high = Math.max(open, close) + Math.random() * .55;
    const low = Math.min(open, close) - Math.random() * .6;
    list.push({ open, close, high, low });
    price = close;
  }
  return list;
}

function renderChart() {
  const box = $('#bigChart');
  if (!box) return;
  CHART.data = buildCandles();
  const { W, H, N, pad } = CHART;
  const all = CHART.data.flatMap(c => [c.high, c.low]);
  const max = Math.max(...all), min = Math.min(...all);
  const span = max - min || 1;
  const y = v => H - 26 - ((v - min) / span) * (H - 56);
  const step = (W - pad * 2) / N;
  const bw = step * .58;

  const grid = Array.from({ length: 5 }, (_, k) => {
    const yy = 14 + k * (H - 44) / 4;
    return `<line x1="0" y1="${yy.toFixed(1)}" x2="${W}" y2="${yy.toFixed(1)}" stroke="#1B2430" stroke-width="1"/>`;
  }).join('');

  const candles = CHART.data.map((c, i) => {
    const up = c.close >= c.open;
    const col = up ? '#2EA86A' : '#E03A3A';
    const x = pad + i * step + step / 2;
    const yO = y(c.open), yC = y(c.close);
    const top = Math.min(yO, yC), hgt = Math.max(1.4, Math.abs(yO - yC));
    return `<g class="cd" data-i="${i}" opacity="0">
      <line x1="${x.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}" stroke-width="1.4"/>
      <rect x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}" rx="1"/>
    </g>`;
  }).join('');

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="USD/JPY 模拟行情：先上涨后暴跌，非真实数据">
      ${grid}${candles}
      <line id="scanline" x1="0" y1="0" x2="0" y2="${H}" stroke="#4A6A96" stroke-width="2" opacity="0"/>
    </svg>`;

  const legend = $('#chartLegend');
  if (legend) {
    legend.innerHTML = `<span class="lg-dot up"></span><span>上涨 · 建仓 ${ENTRY.toFixed(2)}</span>
      <span class="lg-dot crash"></span><span>18:00 强制平仓触发</span>
      <span class="lg-note">模拟行情 · 非真实数据</span>`;
  }

  const priceBox = $('#chartPrice');
  if (priceBox) {
    priceBox.innerHTML = Array.from({ length: 5 }, (_, k) => {
      const v = min + (span / 4) * k;
      return `<span style="top:${((y(v) / H) * 100).toFixed(2)}%">${v.toFixed(2)}</span>`;
    }).join('');
  }
  const axis = $('#chartAxis');
  if (axis) {
    axis.innerHTML = ['09:00', '12:00', '15:00', '18:00', '21:00'].map((tt, k, arr) => {
      const left = (k / (arr.length - 1)) * 96 + 2;
      return `<span style="left:${left.toFixed(2)}%">${tt}</span>`;
    }).join('');
  }
}

function revealCandles(count, atEdge) {
  const groups = candleGroups();
  for (let i = 0; i < count; i++) groups[i].setAttribute('opacity', '1');
  for (let i = count; i < groups.length; i++) groups[i].setAttribute('opacity', '0');
  const line = $('#scanline');
  if (line && groups.length) {
    const g = groups[Math.min(count, groups.length - 1)];
    const ref = g.querySelector('line');
    if (ref) {
      line.setAttribute('x1', ref.getAttribute('x1'));
      line.setAttribute('x2', ref.getAttribute('x1'));
      line.setAttribute('opacity', atEdge ? '.5' : '0');
    }
  }
}

function updateChart() {
  if (!CHART.data.length) return;
  const panel = $('.chart-panel');
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  const local = clamp((innerHeight * .92 - r.top) / (innerHeight * .84));
  const count = Math.round(local * CHART.N);
  if (count === CHART.revealed) return;
  CHART.revealed = count;
  revealCandles(count, local > .02 && local < .98);

  const idx = Math.max(0, Math.min(CHART.N - 1, count - 1));
  const c = CHART.data[idx];
  const pnlEl = $('#chartPnl');
  if (pnlEl && c) {
    const pnl = pnlFromPrice(c.close);
    pnlEl.textContent = fmtJPY(pnl);
    pnlEl.className = pnl >= 0 ? 'up' : 'down';
  }

  if (!CHART.fired && count > CHART.crashAt) {
    CHART.fired = true;
    crashImpact();
  }
  // 全部揭示后冻结行情：价格停摆，但不动 hero 的账户数字。
  // hero 归零必须留给「回到顶部」那一次清算，否则首次访客往回滚时
  // 会看到账户早就死了，最后一击就失效了。
  if (count >= CHART.N) {
    marketFrozen = true;
    track('chart_complete');
  }
}

function crashImpact() {
  crashSound();
  splash('red', { cover: 320, hold: 90, fade: 640 });   // 这一根之后，转场的颜色变了
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 460);
  flashScreen('#E03A3A', .13, 240);
  track('chart_crash');
}

/** 全屏闪烁：不依赖音频的一次性冲击帧 */
function flashScreen(color, opacity, ms) {
  const f = document.createElement('div');
  f.style.cssText = `position:fixed;inset:0;z-index:150;pointer-events:none;background:${color};opacity:0;transition:opacity ${ms}ms ease-out`;
  document.body.appendChild(f);
  requestAnimationFrame(() => { f.style.opacity = String(opacity); });
  setTimeout(() => { f.style.opacity = '0'; }, ms);
  setTimeout(() => f.remove(), ms * 2 + 400);
}

/* =================================================================
   6.3 强制平仓
   ================================================================= */

let losscutFired = false, lsLinesShown = -1;

function buildDrips() {
  const box = $('#drips');
  if (!box || box.childElementCount) return;
  for (let i = 0; i < 9; i++) {
    const el = document.createElement('i');
    el.style.setProperty('--w', (3 + Math.random() * 9).toFixed(1) + 'px');
    el.style.setProperty('--h', (18 + Math.random() * 42).toFixed(1) + 'vh');
    el.style.setProperty('--dur', (9 + Math.random() * 9).toFixed(1) + 's');
    el.style.setProperty('--delay', (-Math.random() * 12).toFixed(1) + 's');
    el.style.left = (Math.random() * 100).toFixed(2) + '%';
    el.style.opacity = (0.35 + Math.random() * 0.5).toFixed(2);
    box.appendChild(el);
  }
}

function updateLosscut() {
  const sec = $('#losscut');
  if (!sec) return;
  const p = stickyP(sec);
  const vortex = sec.querySelector('.losscut__vortex');
  const title = $('#losscutTitle');
  const kurumi = $('#losscutKurumi');
  const black = $('#losscutBlack');

  if (vortex) vortex.style.transform = `scale(${(1.04 + p * .16).toFixed(3)}) rotate(${(p * 6).toFixed(2)}deg)`;

  const tp = clamp((p - .10) / .10);
  if (title) {
    title.style.opacity = String(tp.toFixed(3));
    title.style.transform = `scale(${lerp(1.55, 1, 1 - Math.pow(1 - tp, 3)).toFixed(3)})`;
    title.style.filter = `blur(${lerp(12, 0, tp).toFixed(1)}px) drop-shadow(0 18px 40px rgba(0,0,0,.9))`;
  }
  if (!losscutFired && p > .12) {
    losscutFired = true;
    crashSound();
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 460);
    track('losscut_title');
  }

  if (kurumi) {
    const k = clamp(p / .9);
    kurumi.style.transform = `translate(-50%, ${lerp(-52, -38, k).toFixed(2)}%) scale(${lerp(.90, 1.06, k).toFixed(3)}) rotate(${(k * 3.2).toFixed(2)}deg)`;
    kurumi.style.opacity = String(clamp((p - .02) / .12).toFixed(3));
  }

  const n = p > .74 ? 3 : p > .58 ? 2 : p > .42 ? 1 : 0;
  if (n !== lsLinesShown) {
    lsLinesShown = n;
    ['#lsLine1', '#lsLine2', '#lsLine3'].forEach((sel, i) => {
      const el = $(sel);
      if (el) el.classList.toggle('on', i < n);
    });
    if (n === 3) track('losscut_copy');
  }

  if (black) black.style.opacity = String(clamp((p - .86) / .14).toFixed(3));
}

/* =================================================================
   6.4 系统日志
   ================================================================= */

let logLines = null, logShown = -1;

function updateLog() {
  const sec = $('#log');
  if (!sec) return;
  if (!logLines) logLines = $$('#term .l');
  if (!logLines.length) return;
  const p = stickyP(sec);
  const n = Math.min(logLines.length, Math.floor(p * (logLines.length + 2.2)));
  if (n === logShown) return;
  logShown = n;
  logLines.forEach((el, i) => el.classList.toggle('on', i < n));
  if (n >= logLines.length) track('log_end');
}

/* =================================================================
   6.5 「你的记录」
   -----------------------------------------------------------------
   全页唯一使用读者真实数据的地方。它不说话，只报数。
   最有效的一句是「你在强制平仓那一屏停了 41 秒」——因为这可能是真的。
   ================================================================= */

const SEC_LABEL = {
  top: '课程首页', features: '课程特色', success: '学员故事',
  teacher: '关于讲师', notify: '今晚的推送', chart: '行情回顾',
  losscut: '强制平仓', log: '系统日志', you: '你的记录',
  end: '最后的话'
};

let youLastFill = 0, youFilled = false;

function sectionLabel(id) {
  if (SEC_LABEL[id]) return SEC_LABEL[id];
  const i = secs.findIndex(s => s.id === id);
  return i >= 0 ? `第 ${i + 1} 屏` : '—';
}

function updateYou() {
  const sec = $('#you');
  if (!sec) return;
  const r = sec.getBoundingClientRect();
  if (r.top > innerHeight || r.bottom < 0) return;
  const now = Date.now();
  if (now - youLastFill < 900) return;
  youLastFill = now;

  const dwell = now - BOOT_AT;
  const set = (sel, val, hot) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = val;
    el.classList.toggle('hot', !!hot);
  };

  set('#youSession', sessionId ? '#' + sessionId.slice(0, 8).toUpperCase() : '本地');
  set('#youClock', new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  set('#youDwell', mmss(dwell));
  set('#youBack', backScrolls ? `${backScrolls} 次` : '0 次', backScrolls > 0);

  // 停留最久的一屏（当前屏要补上未结算的时间）
  const acc = { ...sectionMs };
  acc[currentSection] = (acc[currentSection] || 0) + (now - lastSectionAt);
  let topId = '', topMs = 0;
  for (const id in acc) if (acc[id] > topMs) { topMs = acc[id]; topId = id; }
  set('#youLongest', topId ? `${sectionLabel(topId)} · ${Math.round(topMs / 1000)} 秒` : '—', topId === 'losscut');

  // 只陈述可核对的事实，不编造
  const lineEl = $('#youLine');
  if (lineEl) {
    const lc = acc['losscut'] || 0;
    const tr = acc['sec-14'] || acc['sec-15'] || 0;
    let txt;
    if (lc > 8000 && lc > tr) {
      txt = `你在「强制平仓」那一屏停了 ${Math.round(lc / 1000)} 秒。比任何一屏都久。`;
    } else if (backScrolls > 1) {
      txt = `你往回滚了 ${backScrolls} 次。看第二遍不会改变结果。`;
    } else {
      txt = `你在这页已经停了 ${mmss(dwell)}。没有人催你。`;
    }
    if (lineEl.textContent !== txt) lineEl.textContent = txt;
    if (!youFilled) { youFilled = true; setTimeout(() => lineEl.classList.add('on'), 700); }
  }
}

/* =================================================================
   7. 回顶清算 + 惊吓
   ================================================================= */

const HORROR_COPY = {
  horrorBadge: '已经来不及了',
  horrorBadge2: '你早就入场了',
  horrorH1: '它一直在<em>等你回来。</em>',
  horrorLead: '你以为自己离开了。可市场记得你，账户记得你，那些深夜的犹豫也记得你。你回来了——这一次，是为清算而来的。',
  horrorCta1: '别再往下看了',
  horrorCta2: '他们还在等你',
  horrorTiny: '这里没有模拟 · 亏损都是真的',
  horrorTrusted: '已有 11,998 人再也回不去',
  horrorAppTitle: '你的账户（已清算）'
};

function applyHorrorCopy() {
  for (const [id, text] of Object.entries(HORROR_COPY)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (id === 'horrorH1') el.innerHTML = text;
    else el.textContent = text;
  }
  const cta = $('#navCta');
  if (cta) cta.textContent = '查看清算记录';
  document.body.classList.add('horror-mode');
  track('horror_revealed');
}

function playScare() {
  const el = $('#scare');
  if (!el) return;
  el.classList.add('on');
  scareSound();
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 500);
  setTimeout(() => el.classList.remove('on'), REDUCED_MOTION ? 700 : 1900);
}

function goBackToTop() {
  if (witnessedBottom && !horrorRevealed) {
    horrorRevealed = true;
    applyHorrorCopy();
    pendingBust = true;              // 爆仓推迟到用户真正看见时
  }
  if (whisperEl) { whisperEl.classList.remove('on'); clearTimeout(idleTimer); }
  scrollTo({ top: 0, behavior: 'smooth' });
  if (!pendingBust) toast('你回来了。可有些东西，已经回不去了。');
}

function onArriveTop() {
  if (!pendingBust || scrollY > 6) return;
  pendingBust = false;
  playScare();
  setTimeout(() => {
    bustAccount();
    toast('你回来了。可有些东西，已经回不去了。');
  }, REDUCED_MOTION ? 700 : 1900);
}

if ('onscrollend' in window) addEventListener('scrollend', onArriveTop);
addEventListener('scroll', () => {
  if (pendingBust && scrollY < 6) {
    clearTimeout(onArriveTop._h);
    onArriveTop._h = setTimeout(onArriveTop, 260);
  }
}, { passive: true });

function bustAccount() {
  if (ACCOUNT.state === 'bust') return;
  const startEquity = derive().equity;
  const startPnl = ACCOUNT.floatingPnl;
  ACCOUNT.state = 'bust';
  track('account_bust');

  // 迷你走势也要跟着崩，否则会出现「账户已强平 + 曲线还在涨」
  const from = market.price;
  const to = market.entry - 9.5;
  market.history = Array.from({ length: market.points }, (_, i) => {
    const k = i / (market.points - 1);
    return from - (from - to) * k * k + (Math.random() - .5) * .4;
  });
  marketFrozen = true;
  drawMiniChart();

  const balanceEl = $('#heroBalance');
  const pnlEl = $('#heroToday');
  const pnlBox = $('#heroTodayBox');
  const marginEl = $('#heroMargin');
  const freeEl = $('#heroFree');
  const posEl = $('#heroPosition');

  if (balanceEl) {
    animateNumber(balanceEl, startEquity, 0, 2400, '¥');
    balanceEl.style.color = '#DC2626';
  }
  if (posEl) posEl.textContent = '已强平';
  if (pnlBox) pnlBox.className = 'pnl down';

  const st = performance.now();
  (function stepPnl(now) {
    const k = clamp((now - st) / 2400);
    const eased = 1 - Math.pow(1 - k, 3);
    const pnl = startPnl + (-ACCOUNT.deposit - startPnl) * eased;
    ACCOUNT.floatingPnl = pnl;
    if (pnlEl) pnlEl.textContent = fmtJPY(pnl);
    const lvl = Math.max(0, (ACCOUNT.deposit + pnl) / ACCOUNT.usedMargin * 100);
    if (marginEl) {
      const m = marginText(lvl);
      marginEl.textContent = m.text;
      marginEl.className = m.cls;
    }
    if (freeEl) freeEl.textContent = '¥' + Math.round(Math.max(0, ACCOUNT.deposit + pnl - ACCOUNT.usedMargin)).toLocaleString('zh-CN');
    if (k < 1) requestAnimationFrame(stepPnl);
  })(st);
}

function animateNumber(el, from, to, duration = 1600, prefix = '') {
  if (!el) return;
  const st = performance.now();
  (function step(now) {
    const k = clamp((now - st) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = prefix + Math.round(from + (to - from) * eased).toLocaleString('zh-CN');
    if (k < 1) requestAnimationFrame(step);
  })(st);
}

$('#backToTop')?.addEventListener('click', goBackToTop);
$('footer .back')?.addEventListener('click', e => { e.preventDefault(); goBackToTop(); });

/* ---------------- 7.1 开户按钮：陷阱而非跳转 ----------------
   「立即开户」是全页权重最高的按钮。锚到 #end 会让用户 1 秒内跨过
   全部叙事，并提前满足惊悚触发条件。这里改成原地失败。 */

const APPLY_TEXT = ['立即开户', '正在提交资料…', '审核未通过', '请先阅读风险提示'];
let applyBusy = false;

function handleApply(e) {
  e.preventDefault();
  if (applyBusy) return;
  const btn = e.currentTarget;
  const original = btn.textContent;

  if (witnessedBottom) {
    const end = $('#end');
    if (end) scrollTo({ top: end.offsetTop, behavior: 'smooth' });
    return;
  }
  applyBusy = true;
  btn.textContent = APPLY_TEXT[1];
  track('apply_click');
  setTimeout(() => {
    btn.textContent = APPLY_TEXT[2];
    btn.style.background = '#B3261E';
    toast('开户失败：申请人风险测评未通过。');
    setTimeout(() => {
      btn.textContent = APPLY_TEXT[3];
      const truth = $('#truth');
      if (truth) scrollTo({ top: truth.offsetTop - 80, behavior: 'smooth' });
      applyBusy = false;
      setTimeout(() => { btn.textContent = original; btn.style.background = ''; }, 4200);
    }, 1400);
  }, 1200);
}
$('#navCta')?.addEventListener('click', handleApply);

/* ---------------- 7.2 其它控件 ---------------- */

$('#abstainBtn')?.addEventListener('click', e => {
  track('abstain');
  flush();
  const btn = e.currentTarget;
  btn.textContent = '✓ 已记下这个决定';
  btn.disabled = true;
  btn.style.opacity = '.78';
  loadStats();
});

$('#sound')?.addEventListener('click', () => audio ? stopAudio() : startAudio());
$('#heroSound')?.addEventListener('click', () => { startAudio(); track('sound_on'); });

const scrollBtn = $('#scrollNext');
scrollBtn?.addEventListener('click', () => {
  const all = [...document.querySelectorAll('section[id], section.sec, section.losscut, section.log')];
  const y = scrollY + innerHeight * .4;
  const next = all.find(s => s.offsetTop > y);
  if (next) {
    scrollTo({ top: next.offsetTop + 6, behavior: 'smooth' });
    track('scroll_next_btn');
  } else {
    scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }
});
function syncScrollBtn() {
  if (!scrollBtn) return;
  const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 120;
  scrollBtn.classList.toggle('hidden', atBottom);
}

function syncThemeBtn() {
  const btn = $('#theme');
  if (!btn) return;
  btn.textContent = darkMode ? '☀ 日间' : '☾ 夜间';
  btn.classList.toggle('on', darkMode);
  btn.setAttribute('aria-label', darkMode ? '切换到日间模式' : '切换到夜间模式');
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
}
$('#theme')?.addEventListener('click', () => {
  darkMode = !darkMode;
  try { localStorage.setItem(THEME_KEY, darkMode ? 'dark' : 'light'); } catch (e) {}
  syncThemeBtn();
  frame();
  track('theme_switch', darkMode ? 'dark' : 'light');
});
syncThemeBtn();

/* ---------------- 7.3 标题偶尔「未响应」 ----------------
   frame() 每帧都会写 document.title，所以用 titleLockUntil 抢一小段时间。
   零成本，效果比任何噪点都强。 */

setInterval(() => {
  if (document.hidden || REDUCED_MOTION || horrorRevealed) return;
  if (D < .7 || Math.random() > .45) return;
  document.title = 'Kurumi FX 学院 ·（未响应）';
  titleLockUntil = Date.now() + 700;
}, 11000);

/* ---------------- 8. WEB AUDIO ---------------- */

let AC, audio = false, master, padG, lpf, pads = [], droneG, noiseG, nbuf;

function startAudio() {
  if (audio) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = .62; master.connect(AC.destination);

    padG = AC.createGain(); padG.gain.value = 0;
    lpf = AC.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 1800;
    padG.connect(lpf); lpf.connect(master);
    [261.63, 329.63, 392, 523.25].forEach(f => {
      const o = AC.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = AC.createGain(); g.gain.value = .22;
      o.connect(g); g.connect(padG); o.start(); pads.push(o);
    });

    droneG = AC.createGain(); droneG.gain.value = 0;
    const dl = AC.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 140;
    [41, 43.6, 61.7].forEach(f => {
      const o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(dl); o.start();
    });
    dl.connect(droneG); droneG.connect(master);

    nbuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
    const ch = nbuf.getChannelData(0);
    for (let k = 0; k < ch.length; k++) ch[k] = Math.random() * 2 - 1;
    const ns = AC.createBufferSource(); ns.buffer = nbuf; ns.loop = true;
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = .7;
    noiseG = AC.createGain(); noiseG.gain.value = 0;
    ns.connect(bp); bp.connect(noiseG); noiseG.connect(master); ns.start();

    audio = true;
    syncSoundLabel();
    updateAudio();
  } catch (e) {
    const btn = $('#sound');
    if (btn) btn.textContent = '♪ 音效不可用';
  }
}

function stopAudio() {
  if (!audio) return;
  try { AC.close(); } catch (e) {}
  audio = false; pads = [];
  syncSoundLabel();
}

function syncSoundLabel() {
  const btn = $('#sound');
  if (btn) btn.textContent = audio ? '♪ 氛围音效：开' : '♪ 氛围音效：关';
  const h = $('#heroSound');
  if (h) h.textContent = audio ? '氛围音效已开启' : '开启氛围音效';
}

function updateAudio() {
  if (!audio) return;
  const now = AC.currentTime;
  padG.gain.setTargetAtTime(.05 * (1 - clamp((D - .35) * 1.5)), now, .6);
  lpf.frequency.setTargetAtTime(1800 - D * 1500, now, .6);
  pads.forEach((o, k) => o.detune.setTargetAtTime((k - 1.5) * D * D * 90, now, .8));
  droneG.gain.setTargetAtTime(Math.pow(clamp((D - .22) / .78), 1.6) * .24, now, .8);
  noiseG.gain.setTargetAtTime(clamp(D - .5) * .1, now, .8);
}

function whisperSound() {
  if (!audio || !nbuf) return;
  const src = AC.createBufferSource(); src.buffer = nbuf;
  const f = AC.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 3;
  const g = AC.createGain(), t = AC.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(.09, t + .4);
  g.gain.linearRampToValueAtTime(0, t + 1.6);
  src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + 1.7);
}

function tickSound(gain = .03) {
  if (!audio) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'square'; o.frequency.value = 1800;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(.0001, t + .05);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + .06);
}

/** 冲击音：低频下坠 + 噪声爆点。全页只有两处用，必须够狠。 */
function crashSound() {
  if (!audio) return;
  const t = AC.currentTime;

  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(28, t + .75);
  g.gain.setValueAtTime(.45, t);
  g.gain.exponentialRampToValueAtTime(.001, t + 1.0);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 1.05);

  const src = AC.createBufferSource(); src.buffer = nbuf;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
  const ng = AC.createGain();
  ng.gain.setValueAtTime(.3, t);
  ng.gain.exponentialRampToValueAtTime(.001, t + .35);
  src.connect(f); f.connect(ng); ng.connect(master);
  src.start(t); src.stop(t + .4);
}

/** 颜料转场的音效：一声上扬的「唰」，非常轻 */
function splashSound() {
  if (!audio) return;
  const t = AC.currentTime;
  const src = AC.createBufferSource(); src.buffer = nbuf;
  const f = AC.createBiquadFilter(); f.type = 'highpass'; f.frequency.setValueAtTime(600, t);
  f.frequency.exponentialRampToValueAtTime(3200, t + .45);
  const g = AC.createGain();
  g.gain.setValueAtTime(.001, t);
  g.gain.linearRampToValueAtTime(.07, t + .1);
  g.gain.exponentialRampToValueAtTime(.001, t + .55);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t); src.stop(t + .6);
}

function scareSound() {
  if (!audio) return;
  const t = AC.currentTime;
  [1180, 1570, 2350].forEach((freq, i) => {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, t + i * .012);
    o.frequency.exponentialRampToValueAtTime(freq * .5, t + .9);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(.13, t + .02);
    g.gain.exponentialRampToValueAtTime(.001, t + 1.1);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 1.15);
  });
  crashSound();
}

/* 心跳：D > .84 */
setInterval(() => {
  if (audio && D > .84) {
    const t = AC.currentTime;
    [0, .22].forEach((delay, idx) => {
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(70, t + delay);
      o.frequency.exponentialRampToValueAtTime(38, t + delay + .18);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(idx ? .18 : .3, t + delay + .01);
      g.gain.exponentialRampToValueAtTime(.001, t + delay + .25);
      o.connect(g); g.connect(master);
      o.start(t + delay); o.stop(t + delay + .3);
    });
  }
}, 850);

/* ---------------- 9. 滚动进入动画 ---------------- */

function initReveal() {
  const targets = $$('.card, .thought, .quote, .step, .fact, .chip, .voices blockquote, .official-warning, .panel, .dossier__row');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window) || REDUCED_MOTION) {
    targets.forEach(el => el.classList.add('in'));
    return;
  }
  targets.forEach(el => el.classList.add('reveal'));
  const io = new IntersectionObserver(entries => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('in'), (i % 4) * 90);
        io.unobserve(e.target);
      }
    });
  }, { threshold: .14, rootMargin: '0px 0px -40px 0px' });
  targets.forEach(el => io.observe(el));
  setTimeout(() => targets.forEach(el => el.classList.add('in')), 3000);
}

/* ---------------- 10. 启动 ---------------- */

(function boot() {
  sizeNoise();
  sizePaint();
  setInterval(drawNoise, 70);
  buildDrips();

  renderChart();
  initReveal();
  initMarketHistory();
  drawMiniChart();
  renderAccount();
  applyStatic();
  syncThemeBtn();
  frame();
  poke();
  initSession();
  startMarketLoop();
  setInterval(flush, 4000);

  // 转场音效已在 splash() 内部触发（音频未解锁时静默）

  const at = parseFloat(new URLSearchParams(location.search).get('at'));
  if (!Number.isNaN(at) && at >= 0 && at <= 1) {
    setTimeout(() => {
      const docH = document.documentElement.scrollHeight - innerHeight;
      scrollTo({ top: docH * at, behavior: 'instant' });
      frame();
    }, 400);
  }

  window.__kurumi = {
    get D() { return D; },
    get account() { return { ...ACCOUNT, ...derive() }; },
    get chart() { return CHART.data; },
    get stats() { return { backScrolls, sectionMs: { ...sectionMs }, dwell: Date.now() - BOOT_AT }; },
    splash,
    resetAccount() {
      ACCOUNT.deposit = 300000; ACCOUNT.floatingPnl = 12450;
      ACCOUNT.usedMargin = 120000; ACCOUNT.state = 'profit';
      witnessedBottom = false; horrorRevealed = false;
      CHART.fired = false; CHART.revealed = -1; losscutFired = false;
      marketFrozen = false;
      document.body.classList.remove('horror-mode');
      for (const k in splashFired) delete splashFired[k];
      initMarketHistory(); renderChart(); renderAccount();
    }
  };
  console.log('%cKurumi FX 学院', 'color:#2563EB;font-size:16px;font-weight:bold');
  console.log('提示：__kurumi.D / __kurumi.account / __kurumi.stats / __kurumi.splash("blood") 可现场调；setLang("en") 预留英文模式。');
})();
