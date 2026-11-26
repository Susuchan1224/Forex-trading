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
/** 按主题转换颜色：bg 转暗、fg 转亮、ac 提亮但保持色相 */
function themeColor(hex, role) {
  if (!darkMode) return hex;
  const [h, s, l] = rgb2hsl(...hex.slice(1).match(/../g).map(x => parseInt(x, 16)));
  if (role === 'bg') return hsl2hex(h, Math.min(s, .38), .07 + (1 - l) * .06);
  if (role === 'fg') return hsl2hex(h, Math.min(s, .18), .86 + l * .08);
  return hsl2hex(h, Math.min(Math.max(s, .45), .8), .58 + l * .12);
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

let sessionId = null;
let visitNumber = 0;
let eventQueue = [];
let lastTrackAt = 0;
let backendOK = false;
const API_BASE = '';   // 同源部署；开发时可改为 'http://localhost:3001'

// 发布环境的分享网关要求每个请求携带 sharecode；本地开发时为空，不影响功能
const SHARE_CODE = new URLSearchParams(location.search).get('sharecode') || '';
const apiURL = path => SHARE_CODE ? `${API_BASE}${path}?sharecode=${encodeURIComponent(SHARE_CODE)}` : `${API_BASE}${path}`;

async function initSession() {
  try {
    const res = await fetch(apiURL('/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAgent: navigator.userAgent.slice(0, 300),
        screen: `${innerWidth}x${innerHeight}`,
        language: LANG
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    sessionId = data.sessionId;
    visitNumber = data.visitNumber;
    backendOK = true;
    // 访客序号仅用于后端统计，不在页面上展示（避免破坏沉浸感）
  } catch (e) {
    // 直接双击 index.html 打开时无后端：静默降级，不在页面提示
  }
}

/** 把事件放入队列，节流上报（3 秒或 20 条触发一次） */
function track(type, value) {
  eventQueue.push({ type, value: value === undefined ? null : String(value).slice(0, 120), t: Date.now() });
  if (Date.now() - lastTrackAt > 3000 || eventQueue.length >= 20) flush();
}

async function flush() {
  if (!sessionId || !eventQueue.length) return;
  const batch = eventQueue.splice(0);
  lastTrackAt = Date.now();
  try {
    await fetch(apiURL('/api/track'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, events: batch })
    });
  } catch (e) { /* 网络失败不中断浏览体验 */ }
}

async function loadStats() {
  const totalEl = $('#statTotal');
  if (!totalEl) return;
  try {
    const res = await fetch(apiURL('/api/stats'));
    const s = await res.json();
    const fmt = n => Number(n).toLocaleString('zh-CN');
    totalEl.textContent = fmt(s.total);
    $('#statAbstain').textContent = fmt(s.abstained);
    $('#statDwell').textContent = fmt(s.avgDwell);
  } catch (e) {
    totalEl.textContent = '—';
    $('#statAbstain').textContent = '—';
    $('#statDwell').textContent = '—';
  }
}

/* 页面卸载前尽力上报队列 */
addEventListener('pagehide', () => { track('leave'); flush(); });

/* 记录离开 / 返回（配合“回来”提示） */
let leftAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    leftAt = Date.now();
    track('leave');
  } else {
    track('return');
    if (leftAt && Date.now() - leftAt > 1500 && D > .5) {
      toast(`你离开了 ${Math.round((Date.now() - leftAt) / 1000)} 秒。市场可没停。`);
    }
    leftAt = 0;
  }
});

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
  root.style.setProperty('--d', D.toFixed(3));

  // 覆盖层强度随 D 增长：噪点在中段冷灰区提前出现，红色段才达到最强
  noiseEl.style.opacity = clamp((D - .32) * .42, 0, .24);
  vig.style.opacity = clamp((D - .45) * 1.0);
  scan.style.opacity = clamp((D - .68) * 1.2, 0, .45);

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

  // 账户看板：动态数据 + 回到顶部的爆仓翻转
  const scrollProgress = scrollY / (document.documentElement.scrollHeight - innerHeight || 1);
  updateAccountBoard(scrollProgress);

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
  if (+noiseEl.style.opacity < .01) return;
  for (let k = 0; k < imgData.data.length; k += 4) {
    const v = Math.random() * 255;
    imgData.data[k] = imgData.data[k + 1] = imgData.data[k + 2] = v;
    imgData.data[k + 3] = 255;
  }
  nctx.putImageData(imgData, 0, 0);
}, 60);

/* 4.2 随机抖动（幅度随 D 增强） */
setInterval(() => {
  if (D < .2) return;
  const all = $$('.twitch');
  if (!all.length) return;
  const el = all[Math.floor(Math.random() * all.length)];
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  if (Math.random() < D * .7) {
    const k = D * D * 9;
    const base = el.style.transform;
    el.style.transform = `translate(${(Math.random() - .5) * k}px,${(Math.random() - .5) * k}px) skewX(${(Math.random() - .5) * k * .5}deg)`;
    setTimeout(() => { el.style.transform = base; }, 60 + Math.random() * 120);
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

/* 4.4 K 线绘制（模拟：先涨后暴跌） */
function drawChart() {
  const box = $('#bigChart');
  if (!box) return;
  const W = 1000, H = 320;
  const pts = [];
  let price = 60;
  for (let i = 0; i < 64; i++) {
    if (i < 44) price += 1.2 + Math.random() * 2.2;        // 稳步上涨
    else price -= 5 + Math.random() * 4;                    // 暴跌
    pts.push(Math.max(4, Math.min(H - 20, price)));
  }
  const max = Math.max(...pts), min = Math.min(...pts);
  const norm = v => H - 20 - ((v - min) / (max - min || 1)) * (H - 50);
  const coords = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${norm(v).toFixed(1)}`).join(' ');
  const area = `M0,${H} L${coords.replaceAll(' ', ' L')} L${W},${H} Z`;
  const lastX = W, lastY = norm(pts[pts.length - 1]);

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="模拟行情：先上涨后暴跌">
      <defs>
        <linearGradient id="upArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#22C55E" stop-opacity=".35"/>
          <stop offset="100%" stop-color="#22C55E" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="downArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#EF4444" stop-opacity=".4"/>
          <stop offset="100%" stop-color="#EF4444" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${Array.from({ length: 5 }, (_, k) =>
        `<line x1="0" y1="${k * H / 4}" x2="${W}" y2="${k * H / 4}" stroke="#1E293B" stroke-width="1" opacity=".5"/>`
      ).join('')}
      <path d="${area}" fill="url(#upArea)"/>
      <polyline points="${coords}" fill="none" stroke="#4ADE80" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="${W * .68}" y1="0" x2="${W * .68}" y2="${H}" stroke="#EF4444" stroke-width="1" stroke-dasharray="4 4" opacity=".6"/>
      <circle cx="${lastX}" cy="${lastY}" r="5" fill="#EF4444"/>
    </svg>`;
}

/* 4.5 顶部 App 迷你 K 线（动态：随账户状态改变走势） */
let miniTrend = 1;   // 1=上涨盈利，-1=爆仓下跌
function drawMiniChart() {
  const box = $('#heroChart');
  if (!box) return;
  const W = 300, H = 80;
  let p = 40;
  const pts = [];
  // 上涨阶段：随机漫步偏上行；爆仓阶段：断崖式下跌
  for (let i = 0; i < 30; i++) {
    if (miniTrend < 0 && i > 10) p -= 4 + Math.random() * 3;
    else p += (Math.random() - .35) * 5;
    pts.push(Math.max(6, Math.min(H - 6, p)));
  }
  const coords = pts.map((v, i) => `${(i / 29 * W).toFixed(1)},${v.toFixed(1)}`).join(' ');
  const color = miniTrend < 0 ? '#DC2626' : '#2563EB';
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

/* 4.5b 账户看板：动态模拟 + 回到顶部的爆仓翻转 */
let accountState = 'profit';   // 'profit' | 'bust'
let witnessedBottom = false;   // 是否滚到底部读过真相
let balanceBase = 300000;

function updateAccountBoard(progress) {
  const balanceEl = $('#heroBalance');
  const pnlEl = $('#heroToday');
  const pnlBox = $('#heroTodayBox');
  const marginEl = $('#heroMargin');
  const posEl = $('#heroPosition');
  if (!balanceEl || !pnlEl) return;

  // 从底部回到顶部：叙事翻转——账户爆仓
  if (witnessedBottom && progress < .03) {
    if (accountState !== 'bust') {
      accountState = 'bust';
      miniTrend = -1;
      drawMiniChart();
      track('account_bust_after_return');
      balanceEl.style.color = '#DC2626';
      pnlBox.className = 'pnl down';
      pnlEl.textContent = '-¥300,000';
      if (marginEl) { marginEl.textContent = '强制平仓'; marginEl.className = 'bad'; }
      if (posEl) posEl.textContent = '已清空';
      animateNumber(balanceEl, balanceBase, 0, 1400, '¥');
    }
    return;
  }

  // 正常状态：数值随滚动小幅波动（模拟实时行情）
  if (accountState === 'profit') {
    const drift = Math.round(Math.sin(progress * 30) * 3800 + (Math.random() - .5) * 900);
    const pnl = 12450 + drift;
    balanceEl.textContent = '¥' + (balanceBase + pnl).toLocaleString('zh-CN');
    pnlEl.textContent = (pnl >= 0 ? '+' : '-') + '¥' + Math.abs(pnl).toLocaleString('zh-CN');
    // 定时重绘迷你 K 线（节流由 setInterval 控制）
  }
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
  $('#endNote').textContent = '不需要向任何人证明。你只需要记得此刻。';
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

/* ---------------- 5.5 滚动进入动画 ---------------- */
function initReveal() {
  const targets = $$('.card, .thought, .quote, .step, .fact, .chip, .voices blockquote, .official-warning');
  if (!targets.length) return;
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
}

/* ---------------- 6. 启动 ---------------- */

(function boot() {
  initReveal();
  drawChart();
  drawMiniChart();
  applyStatic();
  frame();
  poke();
  initSession();

  // 定期上报队列（防止用户停留时队列积压）
  setInterval(flush, 4000);

  // 账户迷你 K 线每 1.2 秒刷新，模拟实时行情
  setInterval(() => {
    if (scrollY < innerHeight * 1.5 && accountState === 'profit') drawMiniChart();
  }, 1200);

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
