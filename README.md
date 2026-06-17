# QIMA TIC Weekly Market Report

面向 QIMA PM 与业务团队的中国 TIC 行业周度市场研究报告。

## GitHub Pages

站点通过 GitHub Actions 自动部署，访问地址：

**https://asiainspection.github.io/PM-/**

最新报告：

- [2026-06-17 中国 TIC 行业整体市场研究周报](https://asiainspection.github.io/PM-/reports/china-tic-weekly-market-report-2026-06-17.html)

## 目录结构

- `reports/`：报告源文件（每周新增 HTML）
- `docs/`：GitHub Pages 发布目录
- `scripts/prepare-pages.sh`：同步 logo 与报告到 `docs/`
- `.github/workflows/deploy-pages.yml`：自动部署工作流

## 首次启用 GitHub Pages

1. 合并 PR 到 `main`
2. 在仓库 **Settings → Pages** 中确认 Source 为 **GitHub Actions**
3. 首次 workflow 成功运行后，站点地址为：**https://asiainspection.github.io/PM-/**

## 新增周报

1. 将新报告 HTML 放入 `reports/`
2. 更新 `docs/index.html` 中的报告列表
3. 推送后 workflow 会自动同步并发布
