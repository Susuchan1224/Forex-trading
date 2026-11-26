/**
 * API 路由模块
 * ---------------------------------------------------------------
 * 数据模型（data/sessions.json）：
 *   [
 *     {
 *       id: "uuid",
 *       startedAt: 1690000000000,
 *       lastActive: 1690000100000,
 *       userAgent: "...",        // 浏览器标识（用于判断设备类型）
 *       language: "zh",
 *       maxDepth: 0.87,          // 最大滚动深度 0..1
 *       completed: false,        // 是否到达页面底部
 *       abstained: false,        // 是否点击了「我决定远离 FX」
 *       events: [ { t, type, value }, ... ]
 *     }
 *   ]
 *
 * 隐私说明：仅记录行为统计，不收集姓名、IP、联系方式等身份信息。
 * 前端页面已明确告知这一点。
 *
 * 学习要点：
 *   - RESTful 设计（资源命名、HTTP 方法语义）
 *   - 文件系统持久化（同步写入，适合低并发学习项目）
 *   - 参数校验与错误处理
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- 存储层 ---------- */

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

// 初始化：目录与文件不存在则创建
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

/** 读取全部会话。损坏时返回空数组并输出错误，避免服务崩溃。 */
function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('[storage] 读取数据失败:', err.message);
    return [];
  }
}

/** 全量写入。低并发场景下用同步写足够，且实现简单。 */
function writeAll(sessions) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

/** 限制单次上报的事件数量，防止恶意刷数据 */
const MAX_EVENTS = 200;
/**
 * 事件白名单。
 * 早期版本漏掉了 account_bust / horror_revealed / scroll_next_btn / theme_switch
 * 四类事件——恰恰是叙事上最关键的那几个，被静默丢弃且无任何报错。
 * 现在补全，并且未列入的类型仍会被接收（记为 unknown），方便日后加了埋点才发现丢数据。
 */
const ALLOWED_EVENTS = new Set([
  'scroll', 'section_enter', 'sound_on', 'sound_off',
  'lang_switch', 'hover_forever', 'quiz_answer',
  'abstain', 'leave', 'return', 'idle_whisper',
  'account_bust', 'horror_revealed', 'scroll_next_btn', 'theme_switch',
  'apply_click', 'chart_crash', 'chart_complete', 'losscut_title',
  'losscut_copy', 'log_end'
]);

/* ---------- 路由 ---------- */

/**
 * POST /api/session
 * 创建一次访问会话，返回会话 ID 与访问序号（用于「你是第 N 位访客」）
 */
router.post('/session', (req, res) => {
  const sessions = readAll();
  const id = crypto.randomUUID();
  const now = Date.now();

  const session = {
    id,
    startedAt: now,
    lastActive: now,
    userAgent: String(req.body.userAgent || '').slice(0, 300),
    screen: String(req.body.screen || '').slice(0, 60),
    language: req.body.language === 'en' ? 'en' : 'zh',
    maxDepth: 0,
    completed: false,
    abstained: false,
    events: []
  };

  sessions.push(session);
  writeAll(sessions);

  res.status(201).json({
    sessionId: id,
    visitNumber: sessions.length,
    startedAt: now
  });
});

/**
 * POST /api/track
 * 上报行为事件（可批量）。前端节流后每 2~3 秒上报一次。
 *
 * Body:
 *   { sessionId, events: [{ type, value, t? }] }
 */
router.post('/track', (req, res) => {
  const { sessionId, events } = req.body || {};
  if (!sessionId || !Array.isArray(events)) {
    return res.status(400).json({ ok: false, error: 'sessionId 与 events 必填' });
  }

  const sessions = readAll();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: '会话不存在' });
  }

  const now = Date.now();
  // 只校验类型格式（短 slug），不按白名单丢弃——白名单漏项曾导致关键事件全丢
  const valid = events
    .filter(e => e && typeof e.type === 'string' && /^[a-z_]{2,40}$/.test(e.type))
    .slice(0, MAX_EVENTS)
    .map(e => ({
      t: Number(e.t) || now,
      type: ALLOWED_EVENTS.has(e.type) ? e.type : 'unknown:' + e.type,
      value: e.value === undefined || e.value === null ? null : String(e.value).slice(0, 120)
    }));

  session.events.push(...valid);
  session.lastActive = now;

  // 更新最大深度
  const depthEvent = valid.filter(e => e.type === 'scroll').pop();
  if (depthEvent) {
    const depth = Math.max(0, Math.min(1, Number(depthEvent.value) || 0));
    session.maxDepth = Math.max(session.maxDepth, depth);
    if (depth >= 0.99) session.completed = true;
  }

  // 记录「决定远离 FX」
  if (valid.some(e => e.type === 'abstain')) session.abstained = true;

  writeAll(sessions);
  res.json({ ok: true, received: valid.length });
});

/**
 * GET /api/stats
 * 全局统计。前端在结尾处调用，用真实数据强化劝导：
 *   「共 N 人读过，X 人选择远离 FX」
 */
router.get('/stats', (req, res) => {
  const sessions = readAll();
  const total = sessions.length;
  const completed = sessions.filter(s => s.completed).length;
  const abstained = sessions.filter(s => s.abstained).length;
  const depths = sessions.map(s => s.maxDepth).filter(d => d > 0);
  const avgDepth = depths.length
    ? depths.reduce((a, b) => a + b, 0) / depths.length
    : 0;

  // 平均停留时长（秒），过滤掉过短的测试请求
  const dwells = sessions
    .map(s => (s.lastActive - s.startedAt) / 1000)
    .filter(d => d > 3 && d < 3600);
  const avgDwell = dwells.length
    ? dwells.reduce((a, b) => a + b, 0) / dwells.length
    : 0;

  res.json({
    total,
    completed,
    abstained,
    avgDepth: Number(avgDepth.toFixed(3)),
    avgDwell: Math.round(avgDwell)
  });
});

/**
 * GET /api/session/:id
 * 返回单个会话详情，供前端显示「你已停留 X 秒」
 */
router.get('/session/:id', (req, res) => {
  const session = readAll().find(s => s.id === req.params.id);
  if (!session) {
    return res.status(404).json({ error: '会话不存在' });
  }
  res.json({
    id: session.id,
    startedAt: session.startedAt,
    lastActive: session.lastActive,
    maxDepth: session.maxDepth,
    completed: session.completed,
    abstained: session.abstained,
    eventCount: session.events.length
  });
});

/**
 * GET /api/fortune
 * 模拟行情数字：返回一条随机走势，用于前端 K 线/盈亏演示。
 * 明确标注为「模拟数据」，不提供任何真实投资建议。
 */
router.get('/fortune', (req, res) => {
  const base = 300000;          // 初始本金 30 万日元（对应剧情）
  const factor = Math.random() * 2.4 - 1.1;  // -110% ~ +130%
  const value = Math.max(0, Math.round(base * (1 + factor)));
  res.json({
    simulated: true,
    base,
    value,
    pnl: value - base,
    leverage: [5, 10, 25, 50][Math.floor(Math.random() * 4)],
    disclaimer: '模拟数据，仅供警示演示，不构成任何投资建议'
  });
});

module.exports = router;
