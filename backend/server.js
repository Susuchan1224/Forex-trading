/**
 * 《FX战士久留美》同人劝导网页 · 后端入口
 * ---------------------------------------------------------------
 * 职责：
 *   1. 提供 RESTful API（见 routes/api.js）
 *   2. 生产环境下托管前端静态文件
 *   3. 全局中间件：CORS、JSON 解析、请求日志
 *
 * 运行：
 *   npm install
 *   npm start          # http://localhost:3001
 *   npm run dev        # 修改后自动重启
 *
 * 环境变量：
 *   PORT       服务端口，默认 3001
 *   FRONTEND   开发模式下的前端地址，用于 CORS 白名单
 *
 * 学习要点：
 *   - Express 中间件执行顺序
 *   - 环境变量与配置分离
 *   - 静态文件托管与 SPA fallback
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const FRONTEND = process.env.FRONTEND || 'http://localhost:5173';

/* ---------- 中间件 ---------- */

// CORS：开发时允许前端(dev server)跨域访问 API
// 生产环境前后端同源，此配置不会产生影响
app.use(cors({
  origin: [FRONTEND, 'http://localhost:3001', 'http://127.0.0.1:3001'],
  credentials: true
}));

// 解析 JSON 请求体，限制大小防止滥用
app.use(express.json({ limit: '16kb' }));

// 简易请求日志（学习用：可替换为 morgan）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

/* ---------- 路由 ---------- */

// 健康检查：部署平台（Render/Railway）常用它判断服务是否存活
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), time: Date.now() });
});

// 所有 /api/* 交给路由模块处理
app.use('/api', apiRoutes);

/* ---------- 静态文件托管 ---------- */

// 生产环境：后端同时服务前端构建产物
// 前端文件位于项目根目录的 public/ 下
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// SPA fallback：任何未匹配的 GET 请求返回 index.html
// 注意：必须放在 API 路由之后，否则会吞掉 API 请求
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ---------- 启动 ---------- */

app.listen(PORT, () => {
  console.log(`\n  Kurumi FX Warning · Backend`);
  console.log(`  ─────────────────────────────`);
  console.log(`  API:      http://localhost:${PORT}/api`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  Frontend: ${PUBLIC_DIR}\n`);
});
