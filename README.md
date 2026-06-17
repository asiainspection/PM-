# QIMA TIC Weekly Market Report

面向 QIMA PM 与业务团队的中国 TIC 行业周度市场研究报告。

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

## Cursor Automation 发布步骤

1. 生成报告到 `reports/china-tic-market-weekly-YYYY-MM-DD.html`
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
