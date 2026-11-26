# Kurumi FX 学院 · 反 FX 赌博劝导网页

> 《FX战士久留美》同人学习作品。用你喜欢的动画，讲清楚 FX 赌博的实质。
> 非官方、无商业用途。所有行情数字均为模拟数据，不构成任何投资建议。

## 一句话概述

一个"渐进式异化"的交互网页：表面是专业的 FX 交易教学平台，随着用户向下滚动，页面逐渐暴露赌徒心理陷阱、强平爆仓的真实后果，最后以动画台词和真实访客统计收尾——劝导读者远离 FX 赌博。

技术内核复刻自 [Hearthly](https://github.com/jikol1906/Hearthly)（Claude 生成的滚动恐怖网页），但叙事主题、视觉设计和后端联动均为原创。

---

## 项目结构

```
fx-kurumi-trap/
├── public/                    # 前端（原版 Hearthly 是单文件，这里做了模块化）
│   ├── index.html             14 个 section 的叙事结构 + 全部文案
│   ├── style.css              CSS 变量驱动的视觉系统
│   └── app.js                 滚动引擎 / 后端联动 / 特效 / 音效
├── backend/
│   ├── server.js              Express 入口、中间件、静态托管
│   ├── routes/api.js          RESTful API
│   ├── data/sessions.json     行为数据存储（自动创建）
│   └── package.json
└── README.md
```

---

## 快速开始

### 方式一：本地完整运行（推荐，含后端）

```bash
# 1. 进入后端目录
cd backend

# 2. 安装依赖
npm install

# 3. 启动服务
npm start

# 4. 浏览器打开
# http://localhost:3001
```

### 方式二：仅看前端（无后端，静默降级）

直接双击 `public/index.html`。页面视觉与交互全部正常，只是：
- 顶部不显示"你是第 N 位访客"
- 结尾统计显示为 `—`

### 开发模式（前后端分离）

```bash
# 终端 1：后端（端口 3001）
cd backend && npm run dev

# 终端 2：前端静态服务（端口 5173）
cd public && npx serve -l 5173

# 此时需把 app.js 中的 API_BASE 改为 'http://localhost:3001'
```

---

## 核心机制解析（学习重点）

### 1. 数据驱动的 section 体系

每个 `<section>` 携带四个数据属性：

```html
<section data-bg="#F8FAFC" data-fg="#0F172A" data-ac="#2563EB" data-d="0">
```

- `data-bg/fg/ac`：该阶段的背景/前景/强调色
- `data-d`：dread（恐惧）值，从 0（正常）线性递增到 1（真相）

叙事配色轨迹：**蓝白(希望) → 黄橙(警示) → 深红(崩坏) → 近黑(真相) → 暖光(清醒)**

### 2. 滚动引擎（app.js 的 `frame()`）

```
视口中点 → 定位当前 section → 与下一节插值 → 写入 CSS 变量
```

关键代码逻辑：

```js
const mid = scrollY + innerHeight * .5;
let i = secs.findIndex(s => s.offsetTop + s.offsetHeight > mid);
const s = secs[i], n = secs[Math.min(i + 1, secs.length - 1)];
const p = clamp((((mid - s.offsetTop) / s.offsetHeight) - .55) / .45);

root.style.setProperty('--bg', mix(s.dataset.bg, n.dataset.bg, p));
root.style.setProperty('--accent', mix(s.dataset.ac, n.dataset.ac, p));
D = +s.dataset.d + (+n.dataset.d - +s.dataset.d) * p;
root.style.setProperty('--d', D.toFixed(3));
```

`D` 值驱动：噪点透明度、暗角、扫描线、随机抖动幅度、音效调制、标题栏文字。

使用 `requestAnimationFrame` + `ticking` 标志做节流，避免滚动时主线程过载。

### 3. 前后端联动（本项目相对原版的创新）

| 前端行为 | API | 反馈到页面 |
|---------|-----|-----------|
| 页面加载 | `POST /api/session` | 顶部显示"你是第 N 位访客" |
| 滚动/进入 section | `POST /api/track` | 后端记录深度，用于统计 |
| 到达结尾 | `GET /api/stats` | 显示"共 N 人读到此处，X 人决定远离" |
| 点击按钮 | `POST /api/track (abstain)` | 计数并更新统计 |
| 静止 7 秒 | 本地触发 | 低语提示 + Web Audio 耳语音效 |

**隐私说明**：只记录匿名行为（滚动深度、停留时间、事件类型），不收集姓名、IP、联系方式。

### 4. Web Audio 程序化音效

零音频文件依赖，全部用 `AudioContext` 合成：
- **pad**：4 个三角波和弦，随 D 衰减
- **drone**：3 个锯齿波低频，随 D 增强
- **noise**：带通白噪声，D>0.55 出现
- **心跳**：D>0.84 时每 850ms 低频敲击

### 5. 预留英文模式

文案通过 `data-i18n` 属性绑定。中文从 DOM 自动抽取到 `I18N.zh`，英文字典 `I18N.en` 为空。

```js
// 控制台切换（当前 en 为空，会 fallback 到中文）
setLang('en')
```

未来填 `I18N.en` 即可支持完整英文，无需改动 HTML 和逻辑。

---

## 调试技巧

- **URL 参数 `?at=0.5`**：直接跳转到 50% 滚动位置，方便快速检查某个叙事阶段
- **控制台 `D` 变量**：`root.style.getPropertyValue('--d')` 查看当前恐惧值
- **API 测试**：
  ```bash
  curl http://localhost:3001/health
  curl http://localhost:3001/api/stats
  ```

---

## 部署到 GitHub

> 待补充：需提供你的 GitHub 用户名和仓库名。

推荐方案（前后端一起部署）：
- **前端**：GitHub Pages（免费，但只能托管静态文件）
- **后端**：Render / Railway / Fly.io（免费额度足够学习项目）
- 前端 `API_BASE` 改为后端地址，后端 CORS 白名单加入 GitHub Pages 域名

---

## 同人创作声明

- 原作：《FX战士久留美》（FX戦士くるみちゃん），でむにゃん原作、炭酸だいすき作画，2026 年 TV 动画
- 本页面为非商业同人学习作品，剧情台词引用均标注来源
- 动画本身即为警示题材，本页沿用其劝导意图，无任何投资引导

---

## 学习建议

按以下顺序阅读代码，能最快掌握"渐进式异化网页"的设计模式：

1. `index.html` — 看 section 的 `data-*` 属性如何编排叙事节奏
2. `style.css` — 理解 CSS 变量如何承接 JS 的视觉指令
3. `app.js` 的 `frame()` — 掌握插值算法（这是整个机制的核心）
4. `app.js` 的音效部分 — 学习 Web Audio API 的程序化合成
5. `backend/routes/api.js` — 练习 RESTful 设计与数据持久化
