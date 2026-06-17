# QIMA TIC Weekly Market Report

面向 QIMA PM 与业务团队的中国 TIC 行业周度市场研究报告。每期**优先收录竞品新闻**（新系统/平台/业务/并购）与**竞品 AI 使用方向**，监管与市场数据作为附录参考。

## GitHub Pages

站点通过 GitHub Actions 自动部署，访问地址：

**https://asiainspection.github.io/PM-/**

最新报告：

- [2026-06-17 中国 TIC 行业整体市场研究周报](https://asiainspection.github.io/PM-/reports/china-tic-market-weekly-2026-06-17.html)

## 自动化发布流程

```text
Cursor Automation (每周五 09:00 UTC)
  └─ 生成 reports/china-tic-market-weekly-YYYY-MM-DD.html
  └─ 提交并 push 到 main

GitHub Actions: weekly-tic-report-publish.yml (每周五 09:00 UTC)
  └─ scripts/prepare-pages.sh
       ├─ scripts/generate-pages-index.sh  (自动更新 docs/index.html)
       └─ 同步 reports/ → docs/reports/
  └─ 如有变更，提交 docs/ 回 main
  └─ 调用 deploy-pages.yml 发布 GitHub Pages

GitHub Actions: deploy-pages.yml
  └─ push 到 main（reports/docs 变更）或 workflow_call 时触发
  └─ 构建 docs/ 并部署 Pages
```

## 目录结构

- `reports/`：报告源文件（每周新增 HTML）
- `docs/`：GitHub Pages 发布目录（索引可自动生成）
- `scripts/prepare-pages.sh`：同步 logo、报告与首页索引
- `scripts/generate-pages-index.sh`：从 `reports/` 自动生成 `docs/index.html`
- `scripts/publish-weekly-report.sh`：本地/Agent 一键提交并触发 Pages
- `.github/workflows/weekly-tic-report-publish.yml`：每周五 cron 同步 + 发布
- `.github/workflows/deploy-pages.yml`：Pages 构建与部署

## 周报内容结构（竞品新闻优先）

1. **竞品新闻雷达** — 各 TIC 竞品官方新闻：新系统/平台、新业务线、并购；**必扫** Amazon DV 平台直连、ESG 数字化（LRQA EiQ）、工业 cyber 一体包（Kiwa 等）
2. **竞品 AI 使用方向动态** — 表格对照：AI 动作、方向判断、对 QIMA 的含义
3. **Executive Summary** — 给 PM/业务团队的 3–4 条要点
4. **QIMA Implications** — 产品/销售可执行建议
5. **Evidence Pack** — 3–5 条核心证据（含来源链接与可信度）
6. **附录（默认折叠）** — Market/Regulation Trends、数字化补充信号

不要单独展开大段「研究方法与证据等级」章节；证据标准仅在 Evidence Pack 中体现。

## Cursor Automation 设置

Automation 配置与 Prompt 已纳入仓库，便于团队复用：

- 配置参考：`.cursor/automations/weekly-tic-competitor-news-report.yaml`
- 完整 Prompt：`.cursor/prompts/weekly-tic-competitor-news-report.md`
- 创建步骤：`.cursor/automations/README.md`

在 [cursor.com/automations](https://cursor.com/automations) 新建 Automation：

| 项 | 值 |
|----|-----|
| Trigger | Cron `0 9 * * 5`（每周五 09:00 UTC） |
| Repository | `asiainspection/PM-` · `main` |
| Prompt | 粘贴上述 `.md` 文件全文 |
| Tools | Memories（建议开启） |

## Cursor Automation 发布步骤

1. 生成报告到 `reports/china-tic-market-weekly-YYYY-MM-DD.html`（按上述结构）
2. 确保 logo 引用为 `../assets/logo.svg`
3. 提交并 push 到 `main`
4. （可选）运行 `bash scripts/publish-weekly-report.sh YYYY-MM-DD` 立即同步 docs 并触发部署

即使不手动运行 publish 脚本，周五 cron 也会自动同步并发布。

## 手动触发

在 GitHub Actions 中可手动运行：

- **Weekly TIC Report Publish**：同步 docs 并发布 Pages
- **Deploy GitHub Pages**：仅重新部署 Pages

## 新增周报命名规范

`china-tic-market-weekly-YYYY-MM-DD.html`

## 首次启用 GitHub Pages

1. 在仓库 **Settings → Pages** 中确认 Source 为 **GitHub Actions**
2. 首次 workflow 成功运行后，站点地址为：**https://asiainspection.github.io/PM-/**
