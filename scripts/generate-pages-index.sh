#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTS_DIR="$ROOT/reports"
OUTPUT="$ROOT/docs/index.html"
GENERATED_AT="$(date -u +"%Y-%m-%d %H:%M UTC")"

python3 - <<'PY' "$REPORTS_DIR" "$OUTPUT" "$GENERATED_AT"
import html
import re
import sys
from pathlib import Path

reports_dir = Path(sys.argv[1])
output = Path(sys.argv[2])
generated_at = sys.argv[3]

entries = []
for path in sorted(reports_dir.glob("china-tic-market-weekly-*.html"), reverse=True):
    match = re.search(r"china-tic-market-weekly-(\d{4}-\d{2}-\d{2})\.html$", path.name)
    if not match:
        continue
    report_date = match.group(1)
    title = "中国 TIC 行业整体市场研究周报"
    text = path.read_text(encoding="utf-8", errors="ignore")
    title_match = re.search(r"<title>(.*?)</title>", text, re.I | re.S)
    if title_match:
        raw_title = re.sub(r"\s+", " ", title_match.group(1)).strip()
        raw_title = raw_title.split("|")[0].strip()
        if raw_title:
            title = raw_title
    entries.append({
        "date": report_date,
        "file": path.name,
        "title": title,
    })

items = []
for entry in entries:
    items.append(
        "        <li>\n"
        "          <div>\n"
        f"            <div class=\"report-title\">{html.escape(entry['title'])}</div>\n"
        f"            <div class=\"report-meta\">报告日期：{html.escape(entry['date'])} · 竞品新闻雷达 · AI 动态 · QIMA 启示</div>\n"
        "          </div>\n"
        f"          <a class=\"btn\" href=\"reports/{html.escape(entry['file'])}\">阅读报告</a>\n"
        "        </li>"
    )

if not items:
    items.append(
        "        <li>\n"
        "          <div>\n"
        "            <div class=\"report-title\">暂无已发布报告</div>\n"
        "            <div class=\"report-meta\">等待 weekly automation 生成 <code>reports/china-tic-market-weekly-YYYY-MM-DD.html</code></div>\n"
        "          </div>\n"
        "        </li>"
    )

report_list = "\n".join(items)
latest_note = entries[0]["date"] if entries else "暂无"

page = f"""<!doctype html>
<html lang=\"zh-CN\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>QIMA TIC 行业周报 | GitHub Pages</title>
  <meta name=\"description\" content=\"QIMA PM 与业务团队的中国 TIC 行业周度市场研究报告\">
  <style>
    :root {{
      --qima-red: #e4002b;
      --ink: #171923;
      --muted: #5b6475;
      --line: #e7eaf0;
      --blue: #2454ff;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", Arial, sans-serif;
      color: var(--ink);
      background: #f3f5f9;
      line-height: 1.6;
    }}
    a {{ color: var(--blue); text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .wrap {{
      width: min(960px, calc(100% - 32px));
      margin: 32px auto 64px;
    }}
    header {{
      padding: 36px 32px;
      border-radius: 22px;
      color: #fff;
      background:
        radial-gradient(circle at 85% 15%, rgba(255,255,255,.22), transparent 26%),
        linear-gradient(135deg, #111827 0%, #3a0d17 46%, var(--qima-red) 100%);
      box-shadow: 0 24px 60px rgba(15, 23, 42, .12);
    }}
    .brand {{ display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }}
    .brand img {{ width: 140px; background: #fff; border-radius: 12px; padding: 10px; }}
    .badge {{
      display: inline-block;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(255,255,255,.16);
      border: 1px solid rgba(255,255,255,.28);
    }}
    h1 {{ margin: 22px 0 10px; font-size: 34px; line-height: 1.15; }}
    .subtitle {{ color: rgba(255,255,255,.88); max-width: 760px; }}
    .card {{
      margin-top: 20px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 10px 24px rgba(15,23,42,.04);
    }}
    h2 {{ margin: 0 0 14px; font-size: 20px; }}
    .report-list {{ list-style: none; padding: 0; margin: 0; }}
    .report-list li {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 16px 0;
      border-bottom: 1px solid var(--line);
      flex-wrap: wrap;
    }}
    .report-list li:last-child {{ border-bottom: 0; }}
    .report-title {{ font-weight: 700; font-size: 16px; }}
    .report-meta {{ color: var(--muted); font-size: 13px; margin-top: 4px; }}
    .btn {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      border-radius: 12px;
      background: var(--qima-red);
      color: #fff;
      font-weight: 700;
      white-space: nowrap;
    }}
    .btn:hover {{ text-decoration: none; filter: brightness(.95); }}
    .grid {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }}
    .pill {{
      background: #f8fafc;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      font-size: 14px;
    }}
    footer {{ margin-top: 24px; color: var(--muted); font-size: 13px; text-align: center; }}
    @media (max-width: 760px) {{
      .grid {{ grid-template-columns: 1fr; }}
      h1 {{ font-size: 28px; }}
    }}
  </style>
</head>
<body>
  <div class=\"wrap\">
    <header>
      <div class=\"brand\">
        <img src=\"assets/logo.svg\" alt=\"QIMA\">
        <span class=\"badge\">GitHub Pages · Weekly Intelligence</span>
      </div>
      <h1>中国 TIC 行业周度市场研究</h1>
      <p class=\"subtitle\">面向 QIMA PM 与业务团队的行业情报站点。每期优先收录竞品最新系统/平台/业务动作与 AI 使用方向，监管与市场背景作为附录参考。</p>
    </header>

    <section class=\"card\">
      <h2>最新报告</h2>
      <ul class=\"report-list\">
{report_list}
      </ul>
    </section>

    <div class=\"grid\">
      <div class=\"pill\"><strong>更新频率</strong><br>每周五 09:00 UTC 自动同步发布</div>
      <div class=\"pill\"><strong>内容优先级</strong><br>竞品新闻 &gt; AI 动态 &gt; 监管背景</div>
      <div class=\"pill\"><strong>部署方式</strong><br>GitHub Actions 自动发布 Pages</div>
    </div>

    <footer>
      <p>索引自动生成时间：{html.escape(generated_at)} · 最新报告日期：{html.escape(latest_note)}</p>
      <p>站点由 <code>docs/</code> 目录提供，推送至 GitHub 后自动部署。</p>
      <p>仓库：<a href=\"https://github.com/asiainspection/PM-\" target=\"_blank\" rel=\"noreferrer\">asiainspection/PM-</a></p>
    </footer>
  </div>
</body>
</html>
"""

output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(page, encoding="utf-8")
print(f"Generated {output} with {len(entries)} report(s)")
PY
