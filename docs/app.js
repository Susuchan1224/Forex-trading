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
    const note = $('#visitorNote');
    if (note) {
      note.textContent = `你是第 ${visitNumber.toLocaleString('zh-CN')} 位访客 · 仅记录匿名浏览行为`;
    }
  } catch (e) {
    // 直接双击 index.html 打开时无后端：静默降级
    const note = $('#visitorNote');
    if (note) note.textContent = '匿名浏览模式 · 本地预览';
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
  root.style.setProperty('--bg', mix(s.dataset.bg, n.dataset.bg, p));
  root.style.setProperty('--fg', mix(s.dataset.fg, n.dataset.fg, p));
  root.style.setProperty('--accent', mix(s.dataset.ac, n.dataset.ac, p));
  D = +s.dataset.d + (+n.dataset.d - +s.dataset.d) * p;
  root.style.setProperty('--d', D.toFixed(3));

  // 覆盖层强度随 D 增长
  noiseEl.style.opacity = clamp((D - .40) * .5, 0, .28);
  vig.style.opacity = clamp((D - .30) * 1.3);
  scan.style.opacity = clamp((D - .70) * 1.5, 0, .5);

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

  // 到达结尾：加载真实统计
  if (D > .96 && !statsLoaded) {
    statsLoaded = true;
    loadStats();
  }

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

/* 4.5 顶部 App 迷你 K 线 */
function drawMiniChart() {
  const box = $('#heroChart');
  if (!box) return;
  const W = 300, H = 80;
  let p = 40;
  const pts = [];
  for (let i = 0; i < 30; i++) { p += (Math.random() - .35) * 5; pts.push(Math.max(6, Math.min(H - 6, p))); }
  const coords = pts.map((v, i) => `${(i / 29 * W).toFixed(1)},${v.toFixed(1)}`).join(' ');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${coords}" fill="none" stroke="#2563EB" stroke-width="2"/></svg>`;
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

/* ---------------- 6. 启动 ---------------- */

(function boot() {
  drawChart();
  drawMiniChart();
  applyStatic();
  frame();
  poke();
  initSession();

  // 定期上报队列（防止用户停留时队列积压）
  setInterval(flush, 4000);

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
