# Cursor Automation 设置指南

本目录定义 **「中国 TIC 行业周报（竞品新闻优先）」** 的自动化配置。Cursor 目前需在 UI 中创建 Automation；仓库内的 YAML + Prompt 文件供团队复用与版本管理。

## 一键创建（推荐）

1. 打开 [cursor.com/automations](https://cursor.com/automations) 或 Cursor IDE **Agents → Automations → New Automation**
2. 填写如下配置：

| 字段 | 值 |
|------|-----|
| **名称** | 中国 TIC 行业周报（竞品新闻优先） |
| **Trigger** | Scheduled · Cron `0 9 * * 5`（每周五 09:00 UTC） |
| **Repository** | `asiainspection/PM-` · 分支 `main` |
| **Prompt** | 复制 `.cursor/prompts/weekly-tic-competitor-news-report.md` 全文 |
| **Tools** | ✅ Memories（建议开启） |
| **Permissions** | Team Visible 或 Team Owned |

3. 保存并 **Run once** 测试一次
4. 确认 `main` 上出现新文件 `reports/china-tic-market-weekly-YYYY-MM-DD.html`

## 与 GitHub Actions 的分工

```
Cursor Automation（写内容）          GitHub Actions（发站点）
─────────────────────────          ────────────────────────
周五 09:00 UTC                     周五 09:00 UTC
生成 HTML 报告                      prepare-pages.sh
commit + push main                 同步 docs/ → push → Pages 部署
```

- **Cursor Automation**：检索竞品新闻/AI 动态，生成报告，push 到 `main`
- **weekly-tic-report-publish.yml**：把 `reports/` 同步到 `docs/`，更新首页索引
- **deploy-pages.yml**：部署 https://asiainspection.github.io/PM-/

即使 Agent 已 push `docs/`，GitHub Actions 仍会兜底同步。

## 文件说明

| 文件 | 用途 |
|------|------|
| `weekly-tic-competitor-news-report.yaml` | Automation 配置参考（trigger、repo、tools） |
| `../prompts/weekly-tic-competitor-news-report.md` | Agent 完整任务 Prompt |
| `../../reports/china-tic-market-weekly-2026-06-17.html` | HTML 格式与样式模板 |
| `../../README.md` | 周报结构规范 |

## 修改 Prompt

1. 编辑 `.cursor/prompts/weekly-tic-competitor-news-report.md` 并 merge 到 `main`
2. 在 Cursor UI 中打开 Automation，**重新粘贴**更新后的 Prompt（或引用仓库最新内容）
3. 可选：Run once 验证

## 手动触发

- Cursor UI：Automation 详情页 → **Run**
- 本地等价操作：
  ```bash
  bash scripts/publish-weekly-report.sh $(date -u +%F)
  ```
