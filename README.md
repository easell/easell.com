# easell.com · 易采通官网

湖南易采通供应链有限公司（湖南省集采集供平台）官方网站。中文站，面向百度检索。

> 规则：**每建一个新网站都新开一个目录**。本目录即 easell.com 的唯一工程目录；上一版临时目录（`../易采通/`）仅作历史参考，不再维护。

## 基本信息

| 项 | 值 |
|---|---|
| 域名 | https://www.easell.com （canonical 规范域） |
| GitHub | https://github.com/easell/easell.com |
| Cloudflare Pages | 项目 `easell-com`，Git 连接型，`main` 推送即构建 |
| 技术栈 | Astro 4.16 静态站点（与 kyson / molyn / yuhao.group 同基座） |
| 构建 | `npm run build` → `dist/` |
| 公司 | 湖南易采通供应链有限公司（统一社会信用代码 91430104MABEXYD64） |
| 备案号 | 湘ICP备2022019296号-1 |

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # 产物在 dist/
```

## 目录结构

```
src/
  data/site.ts       站点常量：公司信息、导航、备案号（全站唯一信息源）
  data/products.ts   产品与规格数据（唯一数据源）
  layouts/           基础布局（SEO/OG/JSON-LD）
  components/        页头、页脚
  pages/             首页、产品中心（4 品类）、溯源品控、集采集供、禁塑政策、经销合作、关于、联系、404
public/              图片、_headers（安全头与缓存策略）、robots.txt
docs/                事实底座、内容方案、部署运维
```

## 发布流程

1. 改代码 → `git commit` → `git push`
2. Cloudflare Pages 自动构建并上线（约 1–2 分钟）
3. 若推送后未触发构建：Cloudflare Pages 的 GitHub App 未包含本仓库，去
   https://github.com/settings/installations → Cloudflare Pages → Configure 勾选本仓库（详见 docs/03）

## 内容纪律

1. 只写可核验的事实，对外数字须有来源（docs/01 事实底座）。
2. 环保宣称必须挂标准号或检测报告编号；"可降解"≠"可堆肥"，不泛称"环保无污染"。
3. 图片不得含第三方品牌 logo 或水印。
