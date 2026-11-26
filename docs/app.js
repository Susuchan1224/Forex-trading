/* =================================================================
   Kurumi FX 学院 · 前端核心逻辑
   ---------------------------------------------------------------
   模块：
     1. i18n（中文完整 / 英文预留，t() 自动 fallback）
     2. 滚动引擎（section 插值 → CSS 变量 → 视觉渐变）
     3. 后端联动（会话创建 / 行为上报 / 统计回显）
     4. 特效（K 线绘制 / 数字动画 / 抖动 / 耳语 / Web Audio 音效）
     5. 无障碍与降级（无后端时静默降级，不影响浏览）
   ================================================================= */

/* ---------------- 1. I18N ---------------- */

const STORE_KEY = 'kurumi-fx-lang';
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, f) => {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * f).toString(16).padStart(2, '0')).join('');
};

const I18N = { zh: {}, en: {} };

// 从 DOM 的 data-i18n 属性自动抽取中文原文，避免字典与 HTML 重复
(function harvestI18n() {
  $$('[data-i18n]').forEach(el => { I18N.zh[el.dataset.i18n] = el.innerHTML; });
  $$('[data-i18n-html]').forEach(el => { I18N.zh[el.dataset.i18nHtml] = el.innerHTML; });
})();

function detectLang() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }
  return /^zh/i.test(navigator.language) ? 'zh' : 'en';
}
let LANG = detectLang();

/* ---------- 主题转换：保持色相，按角色反转明度 ---------- */
const THEME_KEY = 'kurumi-theme';
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
/**
 * 按主题转换颜色。
 * 关键约束：夜间强调色的亮度上限必须压低（L<=0.56），否则底部高饱和黄色
 * 会被转成了刺眼亮块，造成"闪成浅色"的观感。
 */
function themeColor(hex, role) {
  if (!darkMode) return hex;
  const [h, s, l] = rgb2hsl(...hex.slice(1).match(/../g).map(x => parseInt(x, 16)));
  if (role === 'bg') return hsl2hex(h, Math.min(s, .30), .07 + (1 - l) * .05);   // 暗背景 L 0.07~0.12
  if (role === 'fg') return hsl2hex(h, Math.min(s, .16), .80 + l * .06);         // 亮文字 L 0.80~0.86
  return hsl2hex(h, Math.min(Math.max(s, .35), .62), .44 + l * .10);             // 强调色 L 0.44~0.54，不刺眼
}

/** 取文案。当前语言缺失时回退到中文，最后回退到 key 本身。 */
function t(key) {
  return I18N[LANG]?.[key] ?? I18N.zh[key] ?? key;
}

/**
 * 预留：切换语言。
 * 目前 en 字典为空，切换后所有文案会 fallback 到中文。
 * 未来只需填充 I18N.en 即可支持完整英文，无需改动 HTML 与逻辑。
 */
function setLang(l, persist) {
  LANG = l === 'en' ? 'en' : 'zh';
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  if (persist) { try { localStorage.setItem(STORE_KEY, LANG); } catch (e) {} }
  applyStatic();
  track('lang_switch', LANG);
}
window.setLang = setLang;   // 暴露到控制台，方便练习时调试

function applyStatic() {
  $$('[data-i18n]').forEach(el => {
    const v = t(el.dataset.i18n);
    if (v) el.innerHTML = v;
  });
  $$('[data-i18n-html]').forEach(el => {
    const v = t(el.dataset.i18nHtml);
    if (v) el.innerHTML = v;
  });
}
document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';

/* ---------------- 2. 后端联动 ---------------- */

// 无障碍：尊重系统"减少动态效果"偏好（噪点/抖动等装饰动画会停用）
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 剧情状态：是否已触发回顶惊悚翻转（提前声明，供 frame() 早期读取）
let horrorRevealed = false;

let sessionId = null;
let visitNumber = 0;
let eventQueue = [];
let lastTrackAt = 0;
let backendOK = false;
const API_BASE = '';   // 同源部署；开发时可改为 'http://localhost:3001'

// 发布环境的分享网关要求每个请求携带 sharecode；本地开发时为空，不影响功能
const SHARE_CODE = new URLSearchParams(location.search).get('sharecode') || '';
const apiURL = path => SHARE_CODE ? `${API_BASE}${path}?sharecode=${encodeURIComponent(SHARE_CODE)}` : `${API_BASE}${path}`;

const MAX_QUEUE = 80;        // 队列上限，超出丢弃最旧事件，避免无后端时无限增长
const FLUSH_TIMEOUT = 6000;  // 单次上报超时

async function initSession() {
  // 纯静态部署 / 无后端时，静默降级：统计不显示，但页面功能完全不受影响
  try {
    const res = await fetch(apiURL('/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAgent: navigator.userAgent.slice(0, 300),
        screen: `${innerWidth}x${innerHeight}`,
        language: LANG
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(FLUSH_TIMEOUT) : undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // 校验响应结构，避免把错误页/异常 JSON 当成成功
    if (!data || typeof data.sessionId !== 'string') throw new Error('bad payload');
    sessionId = data.sessionId;
    visitNumber = Number(data.visitNumber) || 0;
    backendOK = true;
    // 访客序号仅用于后端统计，不在页面上展示（避免破坏沉浸感）
  } catch (e) {
    // 无后端：静默降级，且清空队列防止内存增长
    backendOK = false;
    eventQueue.length = 0;
  }
}

/** 把事件放入队列，节流上报（3 秒或 20 条触发一次） */
function track(type, value) {
  // 无后端时不入队——否则队列会永久堆积造成内存泄漏
  if (!backendOK) return;
  eventQueue.push({ type, value: value === undefined ? null : String(value).slice(0, 120), t: Date.now() });
  // 硬上限：丢弃最旧的事件，保留最近的上下文
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
      signal: AbortSignal.timeout ? AbortSignal.timeout(FLUSH_TIMEOUT) : undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    // 失败时把本批事件放回队首（最多保留 MAX_QUEUE 条），下一轮再试
    eventQueue = batch.concat(eventQueue).slice(-MAX_QUEUE);
  } finally {
    flushing = false;
  }
}

async function loadStats() {
  const totalEl = $('#statTotal');
  if (!totalEl) return;
  const showDash = () => {
    totalEl.textContent = '—';
    const a = $('#statAbstain'), d = $('#statDwell');
    if (a) a.textContent = '—';
    if (d) d.textContent = '—';
  };
  try {
    const res = await fetch(apiURL('/api/stats'), {
      signal: AbortSignal.timeout ? AbortSignal.timeout(FLUSH_TIMEOUT) : undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    // 严格校验：任一字段不是有限数字就降级，避免显示 NaN / undefined
    const ok = s && ['total', 'abstained', 'avgDwell'].every(k => Number.isFinite(Number(s[k])));
    if (!ok) throw new Error('bad payload');
    const fmt = n => Number(n).toLocaleString('zh-CN');
    totalEl.textContent = fmt(s.total);
    const a = $('#statAbstain'), d = $('#statDwell');
    if (a) a.textContent = fmt(s.abstained);
    if (d) d.textContent = fmt(s.avgDwell);
  } catch (e) {
    showDash();
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

/* ---------------- 3. 滚动引擎 ---------------- */

const root = document.documentElement;
const secs = $$('[data-bg]');
const noiseEl = $('#noise');
const vig = $('#vig');
const scan = $('#scan');
let D = 0;
let ticking = false;
let currentSection = '';

function frame() {
  ticking = false;
  const vh = innerHeight;
  const mid = scrollY + vh * .5;

  // 定位视口中点所在 section
  let i = secs.findIndex(s => s.offsetTop + s.offsetHeight > mid);
  if (i < 0) i = secs.length - 1;
  const s = secs[i], n = secs[Math.min(i + 1, secs.length - 1)];

  // 在相邻 section 之间插值配色与 dread 值
  const p = clamp((((mid - s.offsetTop) / s.offsetHeight) - .55) / .45);
  root.style.setProperty('--bg', themeColor(mix(s.dataset.bg, n.dataset.bg, p), 'bg'));
  root.style.setProperty('--fg', themeColor(mix(s.dataset.fg, n.dataset.fg, p), 'fg'));
  root.style.setProperty('--accent', themeColor(mix(s.dataset.ac, n.dataset.ac, p), 'ac'));
  D = +s.dataset.d + (+n.dataset.d - +s.dataset.d) * p;
  // 回顶惊悚后：D 不放回 0，而是锁定在"余悸"区间，
  // 让配色、噪点、暗角维持在阴郁状态，与已翻转的文案一致
  if (horrorRevealed) D = Math.max(D, .18);
  root.style.setProperty('--d', D.toFixed(3));

  // 覆盖层强度随 D 增长：噪点在中段冷灰区提前出现，红色段才达到最强
  noiseEl.style.opacity = horrorRevealed ? Math.max(.07, clamp((D - .32) * .42, 0, .24)) : clamp((D - .32) * .42, 0, .24);
  vig.style.opacity = clamp((D - .45) * 1.0);
  scan.style.opacity = clamp((D - .68) * 1.2, 0, .45);

  // 底部红色段之后：逐渐加灰色滤镜并整体压暗（d>=0.80 起）
  // 注意：滤镜只作用于 main/footer，不能加在 body 上——否则会创建包含块，
  // 导致 position:fixed 的导航/噪点/右侧装饰错误地随页面滚动。
  const gray = clamp((D - .80) / .20);
  const filter = gray > .01
    ? `grayscale(${(gray * .35).toFixed(3)}) brightness(${(1 - gray * .18).toFixed(3)})`
    : '';
  const mainEl = $('main');
  const footEl = $('footer');
  if (mainEl) mainEl.style.filter = filter;
  if (footEl) footEl.style.filter = filter;

  // 标题随恐惧深度变化
  const titles = [
    [0,   'Kurumi FX 学院 · 轻松赚回 2000 万'],
    [.32, 'Kurumi FX · 高手的习惯'],
    [.48, 'Kurumi FX · 再等等'],
    [.64, 'Kurumi · 停不下来'],
    [.80, ' kurumi — 风险提示'],
    [.88, '这不是投资'],
    [1,   '别成为下一个久留美']
  ];
  let tt = titles[0][1];
  titles.forEach(([th, v]) => { if (D >= th) tt = v; });
  // 剧情状态优先：回顶惊悚后标题固定为清算语，不被滚动进度覆盖回"轻松赚回"
  if (horrorRevealed) tt = 'Kurumi FX · 清算完成';
  if (!document.hidden && document.title !== tt) document.title = tt;

  // 记录进入新 section（用于行为分析）
  const id = s.id || `sec-${i}`;
  if (id !== currentSection) {
    currentSection = id;
    track('section_enter', id);
  }

  // 到达结尾：加载真实统计 + 记录已读到真相
  if (D > .96 && !statsLoaded) {
    statsLoaded = true;
    loadStats();
  }
  markWitnessedBottom();
  syncScrollBtn();

  updateAudio();
}
let statsLoaded = false;

addEventListener('scroll', () => {
  if (!ticking) { ticking = true; requestAnimationFrame(frame); }
  // 上报滚动深度（节流由 track 内部完成）
  const docH = document.documentElement.scrollHeight - innerHeight;
  if (docH > 0) track('scroll', (scrollY / docH).toFixed(3));
}, { passive: true });
addEventListener('resize', frame);

/* ---------------- 4. 特效 ---------------- */

/* 4.1 噪点画布 */
const nctx = noiseEl.getContext('2d');
const imgData = nctx.createImageData(320, 180);
setInterval(() => {
  if (REDUCED_MOTION) return;              // 用户偏好减少动态效果：不刷新噪点
  if (+noiseEl.style.opacity < .01) return;
  if (document.hidden) return;             // 后台不绘制
  for (let k = 0; k < imgData.data.length; k += 4) {
    const v = Math.random() * 255;
    imgData.data[k] = imgData.data[k + 1] = imgData.data[k + 2] = v;
    imgData.data[k + 3] = 255;
  }
  nctx.putImageData(imgData, 0, 0);
}, 60);

/* 4.2 随机抖动（幅度随 D 增强）——用 CSS 自定义属性驱动，不覆盖元素原有 transform */
setInterval(() => {
  if (REDUCED_MOTION || document.hidden) return;
  if (D < .2) return;
  const all = $$('.twitch');
  if (!all.length) return;
  const el = all[Math.floor(Math.random() * all.length)];
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  if (Math.random() < D * .7) {
    const k = D * D * 9;
    el.style.setProperty('--tw-x', `${(Math.random() - .5) * k}px`);
    el.style.setProperty('--tw-y', `${(Math.random() - .5) * k}px`);
    el.style.setProperty('--tw-sk', `${(Math.random() - .5) * k * .5}deg`);
    setTimeout(() => {
      el.style.setProperty('--tw-x', '0px');
      el.style.setProperty('--tw-y', '0px');
      el.style.setProperty('--tw-sk', '0deg');
    }, 60 + Math.random() * 120);
  }
}, 130);

/* 4.3 耳语（静止 7 秒后、D>0.55 触发） */
const WHISPERS = [
  '再补一点，就快回本了。',
  '你确定要现在平仓吗？',
  '就最后一次。',
  '它还在跳动。',
  '老实赚钱，很枯燥吧？'
];
let whisperIdx = 0, idleTimer;
function poke() {
  const w = $('#whisper');
  if (!w) return;
  w.classList.remove('on');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (D > .55 && !document.hidden) {
      w.textContent = WHISPERS[whisperIdx++ % WHISPERS.length];
      w.classList.add('on');
      track('idle_whisper');
      if (audio) whisperSound();
    }
  }, 7000);
}
addEventListener('pointermove', poke, { passive: true });
addEventListener('keydown', poke);

/* ---------------- 4.4 行情数据源（主图 / 迷你图 / 盈亏 共用） ---------------- */

/**
 * 单一行情源：一个价格序列同时驱动
 *   ① 主图（大图，含刻度与事件标记）
 *   ② 迷你图（顶部账户卡片内的走势）
 *   ③ 账户浮动盈亏（由价格相对建仓价的变动换算）
 * 这样图表与数字不会互相矛盾。
 *
 * 价格为 USD/JPY 的简化模拟值（约 155 附近），与持仓标的一致。
 * 所有数值均为剧情演示，不构成任何投资参考。
 */
const market = {
  base: 155.00,          // 基准价
  price: 155.00,         // 当前价
  entry: 154.80,         // 建仓价
  history: [],           // 最近价格序列（迷你图用）
  points: 30,            // 迷你图保留点数
  tickMs: 2000,
  // 每 1 日元价格变动对应的盈亏（简化：仓位规模 × 手数换算后的系数）
  pnlPerYen: 6000
};

/** 由当前价与建仓价换算浮动盈亏，保证与图表同源 */
function pnlFromPrice(price) {
  return (price - market.entry) * market.pnlPerYen;
}

/** 初始化历史序列，使首帧就有完整走势 */
function initMarketHistory() {
  market.price = market.entry;
  market.history = [];
  let p = market.entry;
  for (let i = 0; i < market.points; i++) {
    p += (Math.random() - .42) * .08;
    market.history.push(p);
  }
  market.price = market.history[market.history.length - 1];
  ACCOUNT.floatingPnl = pnlFromPrice(market.price);
}

/** 行情推进一站：更新价格 → 历史窗口 → 盈亏 → 两图 + 账户 */
function tickMarket() {
  // 爆仓后价格停摆（“行情停止”也是叙事的一部分）
  if (ACCOUNT.state === 'bust') return;

  // 缓慢上行的随机漫步：α 决定趋势偏向，β 决定波动幅度
  const drift = .012;                       // 轻微上行（制造“一直在赚”的错觉）
  const vol = .10;                          // 波动幅度（日元）
  const next = market.price + (Math.random() - .5) * vol + drift;
  market.price = Math.max(market.base * .8, Math.min(market.base * 1.2, next));
  market.history.push(market.price);
  if (market.history.length > market.points) market.history.shift();

  // 盈亏由价格派生——不再独立随机
  ACCOUNT.floatingPnl = pnlFromPrice(market.price);

  drawMiniChart();
  renderAccount();
}

/* 4.4a 迷你图：直接用 market.history 绘制 */
function drawMiniChart() {
  const box = $('#heroChart');
  if (!box) return;
  const W = 300, H = 80;
  const pts = market.history;
  if (!pts.length) return;
  const max = Math.max(...pts), min = Math.min(...pts);
  const span = max - min || 1;
  const norm = v => H - 8 - ((v - min) / span) * (H - 16);
  const coords = pts.map((v, i) =>
    `${(i / (pts.length - 1) * W).toFixed(1)},${norm(v).toFixed(1)}`).join(' ');
  const up = ACCOUNT.state !== 'bust' && pts[pts.length - 1] >= pts[0];
  const color = up ? '#2563EB' : '#DC2626';
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

/* 4.4b 主图：以完整售价序列绘制，带刻度、事件标记与图例 */
function drawChart() {
  const box = $('#bigChart');
  if (!box) return;
  const W = 1000, H = 320;
  const N = 64;

  // 从 market.entry 出发构造一段“先涨后暴跌”的完整行情（与迷你图同一价格体系）
  const pts = [];
  let p = market.entry;
  const crashAt = 44;                        // 第 44 根开始转折
  for (let i = 0; i < N; i++) {
    if (i < crashAt) p += .05 + Math.random() * .12;         // 稳步上行
    else p -= .55 + Math.random() * .45;                     // 暴跌
    pts.push(p);
  }
  const max = Math.max(...pts), min = Math.min(...pts);
  const span = max - min || 1;
  const norm = v => H - 46 - ((v - min) / span) * (H - 76);
  const coords = pts.map((v, i) => `${(i / (N - 1) * W).toFixed(1)},${norm(v).toFixed(1)}`).join(' ');
  const area = `M0,${H - 30} L${coords.replaceAll(' ', ' L')} L${W},${H - 30} Z`;
  const lastY = norm(pts[pts.length - 1]);
  const crashX = crashAt / (N - 1) * W;
  const maxY = norm(max);

  // 价格刻度（右轴）：4 档，用真实价格数值
  const priceTicks = Array.from({ length: 4 }, (_, k) => {
    const v = min + (span / 3) * k;
    const y = norm(v);
    return `<text x="${W - 8}" y="${y - 5}" fill="#94A3B8" font-size="18"
              font-family="monospace" text-anchor="end">${v.toFixed(2)}</text>`;
  }).join('');

  // 时间刻度（底轴）
  const timeTicks = ['09:00', '12:00', '15:00', '18:00', '21:00'].map((t, k) => {
    const x = (k / 4) * (W - 120) + 20;
    return `<text x="${x}" y="${H - 8}" fill="#94A3B8" font-size="17"
              font-family="monospace">${t}</text>`;
  }).join('');

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="USD/JPY 模拟行情：先上涨后暴跌，非真实数据">
      <defs>
        <linearGradient id="upArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#22C55E" stop-opacity=".30"/>
          <stop offset="100%" stop-color="#22C55E" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="downArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#EF4444" stop-opacity=".35"/>
          <stop offset="100%" stop-color="#EF4444" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${Array.from({ length: 5 }, (_, k) => {
        const y = 20 + k * (H - 50) / 4;
        return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#1E293B"
                 stroke-width="1" opacity=".45"/>`;
      }).join('')}
      ${Array.from({ length: 6 }, (_, k) => {
        const x = k * W / 5;
        return `<line x1="${x}" y1="20" x2="${x}" y2="${H - 30}" stroke="#1E293B"
                 stroke-width="1" opacity=".28"/>`;
      }).join('')}
      <path d="${area}" fill="url(#upArea)"/>
      <polyline points="${coords}" fill="none" stroke="#4ADE80"
                stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="${crashX}" y1="20" x2="${crashX}" y2="${H - 30}"
            stroke="#EF4444" stroke-width="1" stroke-dasharray="5 5" opacity=".7"/>
      <circle cx="${crashX}" cy="${maxY}" r="5" fill="#EF4444"/>
      <text x="${crashX + 12}" y="${maxY - 10}" fill="#EF4444" font-size="18"
            font-family="monospace">高点 ${max.toFixed(2)}</text>
      ${priceTicks}
      ${timeTicks}
    </svg>`;

  // 主图下方的图例/注释（说明是模拟数据与转折事件）
  const legend = $('#chartLegend');
  if (legend) {
    legend.innerHTML = `
      <span class="lg-dot up"></span><span>USD/JPY · 模拟行情</span>
      <span class="lg-dot crash"></span><span>事件：强制平仓触发点</span>
      <span class="lg-note">数值为剧情演示，非真实市场数据</span>`;
  }
}

/* 4.5b 账户模型：单一数据源，所有显示值由 derive() 派生 */

/**
 * 说明（也写进 README）：
 * 这是一个简化的演示模型，用于叙事而非真实交易计算。
 *   equity      = deposit + floatingPnl          （账户净值）
 *   usedMargin  = notional / leverage            （已用保证金，此处固定）
 *   freeMargin  = equity - usedMargin            （可用保证金）
 *   marginLevel = equity / usedMargin * 100%     （保证金率）
 * 真实市场里保证金、强平线与负余额保护规则因平台和品种而异，
 * 这里的换算只服务于剧情，不能当作实际交易依据。
 */
const ACCOUNT = {
  deposit: 300000,        // 初始本金
  floatingPnl: 12450,     // 浮动盈亏（可正可负）
  usedMargin: 60000,      // 已用保证金（50 倍杠杆下的占用）
  state: 'profit'         // 'profit' | 'bust'
};

let witnessedBottom = false;

/** 从 ACCOUNT 派生全部展示值——任何显示都必须走这里，避免数字互相矛盾 */
function derive() {
  const equity = ACCOUNT.deposit + ACCOUNT.floatingPnl;
  const freeMargin = equity - ACCOUNT.usedMargin;
  // 保证金率：净值 / 已用保证金。净值 <= 0 时视为 0，避免出现负百分比
  const marginLevel = ACCOUNT.usedMargin > 0 ? Math.max(0, equity / ACCOUNT.usedMargin * 100) : 0;
  return { equity, freeMargin, marginLevel };
}

/** 保证金率文案分级：随亏损逐级恶化，这是叙事张力的来源 */
function marginText(level) {
  if (level >= 300) return { text: '充足', cls: 'ok' };
  if (level >= 150) return { text: '偏低', cls: 'warn' };
  if (level >= 100) return { text: '危险', cls: 'bad' };
  return { text: '即将强平', cls: 'bad' };
}

/** 统一的渲染入口：所有数字只在这里写入 DOM */
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
  pnlEl.textContent = (p >= 0 ? '+' : '-') + '¥' + Math.abs(Math.round(p)).toLocaleString('zh-CN');
  if (pnlBox) pnlBox.className = 'pnl ' + (p >= 0 ? 'up' : 'down');
  if (freeEl) freeEl.textContent = '¥' + Math.round(Math.max(0, freeMargin)).toLocaleString('zh-CN');
  if (marginEl) {
    const m = marginText(marginLevel);
    marginEl.textContent = m.text;
    marginEl.className = m.cls;
  }
  return { equity, freeMargin, marginLevel };
}

/** 定时器驱动：账户缓慢增长（仅 profit 状态），行情与盈亏同源 */
function tickAccount() {
  if (ACCOUNT.state !== 'profit') return;
  // 由行情 tick 决定盈亏变化，保证图表与数字一致（见 tickMarket）
  tickMarket();
}

/** 仅用于测试/调试：重置到初始状态 */
function resetAccount() {
  ACCOUNT.deposit = 300000;
  ACCOUNT.floatingPnl = 12450;
  ACCOUNT.usedMargin = 60000;
  ACCOUNT.state = 'profit';
  witnessedBottom = false;
  renderAccount();
}

/**
 * 爆仓：从「当前显示值」开始动画，避免数字先回跳。
 * 亏损推进到本金耗尽，保证金率跌破强平线，持仓被清空。
 */
function bustAccount() {
  if (ACCOUNT.state === 'bust') return;
  // 先快照当前值，再切换状态——避免中途异常导致“状态已变但画面没动”
  const startEquity = derive().equity;
  const startPnl = ACCOUNT.floatingPnl;

  // 记录爆仓起点，供 K 线绘制使用
  market.mode = 'bust';
  market.crashFrom = market.history[market.history.length - 1] || market.price;
  ACCOUNT.state = 'bust';

  const balanceEl = $('#heroBalance');
  const pnlEl = $('#heroToday');
  const pnlBox = $('#heroTodayBox');
  const marginEl = $('#heroMargin');
  const freeEl = $('#heroFree');
  const posEl = $('#heroPosition');

  track('account_bust');

  // 净值从当前值平滑跌到 0
  if (balanceEl) animateNumber(balanceEl, startEquity, 0, 1600, '¥');
  // 浮亏从当前值跌到 -本金，两者同步推进
  const st = performance.now();
  (function stepPnl(now) {
    const k = clamp((now - st) / 1600);
    const eased = 1 - Math.pow(1 - k, 3);
    const pnl = startPnl + (-ACCOUNT.deposit - startPnl) * eased;
    ACCOUNT.floatingPnl = pnl;
    if (pnlEl) {
      pnlEl.textContent = (pnl >= 0 ? '+' : '-') + '¥' + Math.abs(Math.round(pnl)).toLocaleString('zh-CN');
    }
    // 保证金率随净值同步下降
    const lvl = Math.max(0, (ACCOUNT.deposit + pnl) / ACCOUNT.usedMargin * 100);
    if (marginEl) {
      const m = marginText(lvl);
      marginEl.textContent = m.text;
      marginEl.className = m.cls;
    }
    if (freeEl) freeEl.textContent = '¥' + Math.round(Math.max(0, ACCOUNT.deposit + pnl - ACCOUNT.usedMargin)).toLocaleString('zh-CN');
    if (k < 1) requestAnimationFrame(stepPnl);
  })(st);

  if (pnlBox) pnlBox.className = 'pnl down';
  if (balanceEl) balanceEl.style.color = '#DC2626';
  if (posEl) posEl.textContent = '已强平';
}

// 记录是否已读到真相（D>0.95 视为读完）
function markWitnessedBottom() {
  if (D > .95 && !witnessedBottom) {
    witnessedBottom = true;
  }
}

/* 4.6 数字滚动动画 */
function animateNumber(el, from, to, duration = 1600, prefix = '', suffix = '') {
  if (!el) return;
  const st = performance.now();
  (function step(now) {
    const k = clamp((now - st) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    const v = Math.round(from + (to - from) * eased);
    el.textContent = prefix + v.toLocaleString('zh-CN') + suffix;
    if (k < 1) requestAnimationFrame(step);
  })(st);
}

/* 4.7 决定按钮 */
$('#abstainBtn')?.addEventListener('click', e => {
  track('abstain');
  flush();
  const btn = e.currentTarget;
  btn.textContent = '✓ 已记下这个决定';
  btn.disabled = true;
  btn.style.opacity = '.75';
  loadStats();
});

/* 4.8 音效开关 */
$('#sound')?.addEventListener('click', () => audio ? stopAudio() : startAudio());
$('#heroSound')?.addEventListener('click', () => { startAudio(); track('sound_on'); });

/* 4.8b 右下滚动按钮：跳到下一节，底部隐藏 */
const scrollBtn = $('#scrollNext');
scrollBtn?.addEventListener('click', () => {
  // 找出下一个 section 的顶部
  const all = [...document.querySelectorAll('section[id], section.sec')];
  const y = scrollY + innerHeight * .4;
  const next = all.find(s => s.offsetTop > y);
  if (next) {
    scrollTo({ top: next.offsetTop - 50, behavior: 'smooth' });
    track('scroll_next_btn');
  } else {
    scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }
});
// 在 frame 中同步按钮显隐（通过全局函数）
function syncScrollBtn() {
  if (!scrollBtn) return;
  const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 120;
  scrollBtn.classList.toggle('hidden', atBottom);
}

/* 4.9 昼夜模式切换 */
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

/* ---------------- 5. WEB AUDIO ---------------- */

let AC, audio = false, master, padG, lpf, pads = [], droneG, noiseG, nbuf;

function startAudio() {
  if (audio) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = .65; master.connect(AC.destination);

    // 和弦 pad：开始时温暖，随 D 衰减
    padG = AC.createGain(); padG.gain.value = 0;
    lpf = AC.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 1800;
    padG.connect(lpf); lpf.connect(master);
    [261.63, 329.63, 392, 523.25].forEach(f => {
      const o = AC.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = AC.createGain(); g.gain.value = .25;
      o.connect(g); g.connect(padG); o.start(); pads.push(o);
    });

    // 低频 drone：随 D 增强
    droneG = AC.createGain(); droneG.gain.value = 0;
    const dl = AC.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 140;
    [41, 43.6, 61.7].forEach(f => {
      const o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(dl); o.start();
    });
    dl.connect(droneG); droneG.connect(master);

    // 带通噪声：后期出现
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
  AC.close(); audio = false; pads = [];
  syncSoundLabel();
}

function syncSoundLabel() {
  const btn = $('#sound');
  if (!btn) return;
  btn.textContent = audio ? '♪ 氛围音效：开' : '♪ 氛围音效：关';
  const h = $('#heroSound');
  if (h) h.textContent = audio ? '氛围音效已开启' : '开启氛围音效';
}

function updateAudio() {
  if (!audio) return;
  const now = AC.currentTime;
  padG.gain.setTargetAtTime(.05 * (1 - clamp((D - .35) * 1.5)), now, .6);
  lpf.frequency.setTargetAtTime(1800 - D * 1500, now, .6);
  pads.forEach((o, k) => o.detune.setTargetAtTime((k - 1.5) * D * D * 90, now, .8));
  droneG.gain.setTargetAtTime(Math.pow(clamp((D - .25) / .75), 1.6) * .22, now, .8);
  noiseG.gain.setTargetAtTime(clamp(D - .55) * .09, now, .8);
}

function whisperSound() {
  if (!audio) return;
  const src = AC.createBufferSource(); src.buffer = nbuf;
  const f = AC.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 3;
  const g = AC.createGain(), t = AC.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(.10, t + .4);
  g.gain.linearRampToValueAtTime(0, t + 1.6);
  src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + 1.7);
}

/* 心跳：D > .84 时低频敲击 */
setInterval(() => {
  if (audio && D > .84) {
    const t = AC.currentTime;
    [0, .22].forEach((delay, idx) => {
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(70, t + delay);
      o.frequency.exponentialRampToValueAtTime(38, t + delay + .18);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(idx ? .2 : .32, t + delay + .01);
      g.gain.exponentialRampToValueAtTime(.001, t + delay + .25);
      o.connect(g); g.connect(master);
      o.start(t + delay); o.stop(t + delay + .3);
    });
  }
}, 850);

/* ---------------- 5.4 回顶后的惊悚文案翻转 ---------------- */
/**
 * 用户读完真相后点击"回到顶部"，叙事发生翻转：
 *   - 顶部介绍文案被替换为惊悚版本
 *   - 账户爆仓（bustAccount）
 *   - 保留轻微噪点（即使回到 D=0 也不完全清除）
 */
const HORROR_COPY = {
  horrorBadge:  '已经来不及了',
  horrorBadge2: '你早就入场了',
  horrorH1:     '它一直在<em>等你回来。</em>',
  horrorLead:   '你以为自己离开了。可市场记得你，账户记得你，那些深夜的犹豫也记得你。你回来了——这一次，是为清算而来的。',
  horrorCta1:   '别再往下看了 →',
  horrorCta2:   '他们还在等你',
  horrorTiny:   '这里没有模拟 · 亏损都是真的',
  horrorTrusted:'已有 11,998 人再也回不去',
  horrorAppTitle:'你的账户（已清算）',
};
function applyHorrorCopy() {
  for (const [id, text] of Object.entries(HORROR_COPY)) {
    const el = document.getElementById(id);
    if (!el) continue;
    // 保留 h1 的 <em> 结构，其余纯文本替换
    if (id === 'horrorH1') el.innerHTML = text;
    else el.textContent = text;
  }
  document.body.classList.add('horror-mode');
  track('horror_revealed');
}

/** 回到顶部按钮点击处理：触发叙事翻转 */
function goBackToTop() {
  if (witnessedBottom && !horrorRevealed) {
    horrorRevealed = true;
    applyHorrorCopy();
    bustAccount();
  }
  // 清除可能在底部触发过的低语，避免回顶后与顶部文案重叠
  const w = $('#whisper');
  if (w) { w.classList.remove('on'); clearTimeout(idleTimer); }
  // 先滚回顶部（平滑），噪点在 frame 中因 horrorRevealed 保留
  scrollTo({ top: 0, behavior: 'smooth' });
  toast('你回来了。可有些东西，已经回不去了。');
}

// 绑定两处回顶按钮：end 内的按钮 + footer 的链接
$('#backToTop')?.addEventListener('click', goBackToTop);
$('footer .back')?.addEventListener('click', e => { e.preventDefault(); goBackToTop(); });

/* ---------------- 5.5 滚动进入动画 ---------------- */
function initReveal() {
  const targets = $$('.card, .thought, .quote, .step, .fact, .chip, .voices blockquote, .official-warning');
  if (!targets.length) return;

  // 降级：不支持 IntersectionObserver 或用户要求减少动效时，直接显示，绝不让正文一直隐藏
  if (!('IntersectionObserver' in window) || REDUCED_MOTION) {
    targets.forEach(el => el.classList.add('in'));
    return;
  }

  targets.forEach(el => el.classList.add('reveal'));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('in'), (i % 4) * 90);
        io.unobserve(e.target);
      }
    });
  }, { threshold: .14, rootMargin: '0px 0px -40px 0px' });
  targets.forEach(el => io.observe(el));

  // 兜底：若 3 秒后仍有元素未显示（例如 IO 被某些环境静默禁用），强制全部显示
  setTimeout(() => {
    targets.forEach(el => {
      if (!el.classList.contains('in')) el.classList.add('in');
    });
  }, 3000);
}

/* ---------------- 5.8 行情循环（页面隐藏时暂停，降低无谓开销） ---------------- */

let marketTimer = null;

function startMarketLoop() {
  if (marketTimer) return;
  marketTimer = setInterval(() => {
    // 页面在后台时不推进行情，避免无意义的计算与耗电
    if (document.hidden) return;
    tickMarket();
  }, market.TICK_MS || market.tickMs);
}

function stopMarketLoop() {
  if (marketTimer) { clearInterval(marketTimer); marketTimer = null; }
}

// 前后台切换：回到前台时恢复推进（并补算一次，避免数字“停滞”观感）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMarketLoop();
  else startMarketLoop();
});

/* ---------------- 6. 启动 ---------------- */

(function boot() {
  initReveal();
  initMarketHistory();     // 建立行情序列（主图/迷你图/盈亏的唯一来源）
  drawChart();
  drawMiniChart();
  renderAccount();         // 首帧渲染账户全部字段
  applyStatic();
  frame();
  poke();
  initSession();

  // 定期上报队列（防止用户停留时队列积压）
  setInterval(flush, 4000);

  // 行情/账户推进：单一 tick 同时更新价格、盈亏、两图（页面隐藏时跳过）
  startMarketLoop();

  // 调试/分享：URL 加 ?at=0.5 可跳转到指定滚动进度（0~1）
  // 用途：快速定位到某个叙事阶段截图、分享特定章节给朋友
  const at = parseFloat(new URLSearchParams(location.search).get('at'));
  if (!Number.isNaN(at) && at >= 0 && at <= 1) {
    setTimeout(() => {
      const docH = document.documentElement.scrollHeight - innerHeight;
      // behavior:'instant' 绕过 CSS 的 scroll-behavior:smooth，确保立即定位
      scrollTo({ top: docH * at, behavior: 'instant' });
      frame();
    }, 400);
  }

  // 控制台提示（学习用）
  console.log('%cKurumi FX 学院', 'color:#2563EB;font-size:16px;font-weight:bold');
  console.log('提示：在控制台输入 setLang("en") 可预留英文模式；window.D 可查看当前恐惧值。');
})();
