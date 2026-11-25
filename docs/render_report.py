#!/usr/bin/env python3
"""Render this review report using the installed render-html Markdown parser.

The project explicitly excludes unnecessary hashes, so this renderer records
the source filename and report date without computing a source fingerprint.
No application or source dataset files are changed.
"""
import argparse
from pathlib import Path
import importlib.util
import html

parser = argparse.ArgumentParser(description='Render a local review report with the ARIS HTML renderer.')
parser.add_argument('source', type=Path, help='Path to the local Markdown report')
parser.add_argument('--renderer', type=Path, required=True, help='Path to the ARIS render_html.py helper')
args = parser.parse_args()
HELPER = args.renderer
spec = importlib.util.spec_from_file_location('aris_report_renderer', HELPER)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)

source = args.source
blocks = renderer.parse_blocks(source.read_text(encoding='utf-8').splitlines())
title = blocks.pop(0)['text']
body, toc = renderer._render_blocks(blocks, collect_toc=True)
template = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="source" content="现状分析与优化计划.md">
<meta name="report-date" content="2026-10-25 Asia/Singapore">
<title>{{TITLE}}</title>
<style>
:root{--ink:#172a34;--muted:#5c6d75;--teal:#176d73;--line:#d8e1e1;--paper:#fffefa;--bg:#f3f5f3;--soft:#eaf4f2;--warm:#f6efe3}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.9 "Noto Sans CJK SC","Microsoft YaHei",sans-serif}a{color:var(--teal);text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}strong{font-weight:700}p{margin:12px 0}h1,h2,h3,h4{line-height:1.45}h1{font-size:36px;letter-spacing:-.02em;margin:12px 0 18px;max-width:880px}h2{font-size:25px;margin:56px 0 20px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:20px}h4{font-size:16px;margin:14px 0 8px}code{font: .88em/1.7 "DejaVu Sans Mono",monospace;background:#eef2ef;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre{padding:20px;background:#edf3f1;border:1px solid var(--line);border-radius:10px;overflow:auto;font-size:14px}pre code{padding:0;background:none;white-space:pre}table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;margin:22px 0}th{background:#e8f0ee;text-align:left;font-weight:700}th,td{padding:13px 14px;border:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f7f9f6}table th:first-child{width:19%}ul,ol{padding-left:24px}li{margin:10px 0}hr{border:0;border-top:1px solid var(--line);margin:18px 0}
.top{border-top:7px solid var(--teal);padding:18px 36px;background:var(--paper);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;font-size:12px;color:var(--muted);letter-spacing:.08em}.top b{color:var(--teal)}.layout{max-width:1460px;margin:auto;display:grid;grid-template-columns:230px minmax(0,1fr);gap:36px;padding:38px 34px 70px}.toc{position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;font-size:13px;color:var(--muted)}.toc .label{font-size:11px;letter-spacing:.16em;color:var(--teal);font-weight:700;margin:10px 0 18px}.toc ol{list-style:none;margin:0;padding:0}.toc li{margin:0}.toc a{display:block;text-decoration:none;border-left:2px solid #d8e1e1;padding:10px 14px;color:var(--muted)}.toc a:hover{background:var(--soft);color:var(--teal);border-color:var(--teal)}.toc .note{padding:16px 14px;font-size:12px;line-height:1.8}.paper{min-width:0;background:var(--paper);padding:38px 44px 30px;border:1px solid var(--line);border-radius:4px;box-shadow:0 12px 50px #22352a06}.eyebrow{font-size:12px;color:var(--teal);font-weight:700;letter-spacing:.13em}.lead{font-size:17px;padding:23px 26px;background:var(--soft);border-left:4px solid var(--teal);border-radius:0 10px 10px 0;margin-top:25px}.lead .kicker{font-size:12px;letter-spacing:.04em;color:var(--teal);margin-top:0}.lead p:last-child{font-size:14px;color:var(--muted);margin-bottom:0}
.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin:26px 0}.flow div{background:var(--soft);border-top:3px solid var(--teal);padding:14px 10px;border-radius:4px}.flow b{font-size:14px;display:block}.flow span{font-size:12px;line-height:1.6;display:block;color:var(--muted);margin-top:8px}.example{padding:22px 26px;background:var(--warm);border-left:4px solid #ad8c57;border-radius:0 10px 10px 0;margin:28px 0}.example>b{font-size:14px;color:#725833}.example p{font-size:15px}
.mock{border:1px solid #bdd1d0;border-radius:12px;overflow:hidden;margin:26px 0;background:#f9fbfa}.mock-top{padding:15px 19px;background:#244c53;color:#fff;display:flex;justify-content:space-between;gap:12px;font-size:14px}.mock-top span{font-size:12px;color:#c9dfdd}.mock-grid{display:grid;grid-template-columns:1fr 1.12fr 1fr}.mock-grid>section{padding:20px 18px;min-width:0;font-size:14px;border-right:1px solid var(--line)}.mock-grid>section:last-child{border:0}.mock-grid small{color:var(--teal);font-size:11px;font-weight:bold;letter-spacing:.06em}.mock-grid h3{font-size:16px;margin:14px 0 8px}.mock-grid p{font-size:13px;line-height:1.8}.mock-muted{color:var(--muted);font-size:12px!important}.mock-center{text-align:center;background:#edf4f2}.region-cloud{margin:35px auto 15px;max-width:185px;min-height:135px;border:2px solid #a7c6c3;border-radius:50%;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;padding:28px 12px;background:#dbece7}.region-cloud span{display:inline-block;padding:4px 9px;font-size:12px;background:#fffefa;border:1px solid #7eaaa4;border-radius:20px;color:#205e60}.mock-bottom{padding:12px 18px;font-size:12px;background:#e7efed;color:#526b6c;text-align:center;border-top:1px solid var(--line)}
details{margin:18px 0;border:1px solid var(--line);border-radius:8px;padding:0 20px;background:#fafbf7}summary{cursor:pointer;font-weight:600;padding:17px 0;color:var(--teal);font-size:15px}details[open]{padding-bottom:18px}details p,details li{font-size:14px}details code{font-size:12px}.footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}.footer a{color:var(--muted)}
@media(min-width:1500px){.layout{gap:48px}.paper{padding:42px 54px}}@media(max-width:1100px){.layout{grid-template-columns:180px minmax(0,1fr);gap:20px;padding:25px 20px}.paper{padding:28px}.flow{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:800px){.top{padding:14px 20px}.layout{display:block;padding:20px 14px}.toc{position:static;max-height:none;margin-bottom:20px}.toc ol{display:grid;grid-template-columns:1fr 1fr}.toc .note{display:none}.paper{padding:24px 20px}h1{font-size:28px}h2{font-size:22px;margin-top:40px}body{font-size:15px}.mock-grid{grid-template-columns:1fr}.mock-grid>section{border-right:0;border-bottom:1px solid var(--line)}.mock-top{flex-direction:column;gap:4px}.mock-center{min-height:270px}table{font-size:12px;table-layout:fixed}th,td{padding:10px 7px}.lead{padding:18px;font-size:16px}.flow{grid-template-columns:repeat(2,minmax(0,1fr))}.flow div:last-child{grid-column:1 / -1}}
@media print{body{background:#fff;color:#111;font-size:11pt}.top,.toc{display:none}.layout{display:block;padding:0;max-width:none}.paper{border:0;box-shadow:none;padding:0}h1{font-size:25pt}h2{font-size:18pt;break-after:avoid;margin-top:24pt}table,.flow,.mock,.example{break-inside:avoid}p{orphans:3;widows:3}a{color:#244c53}.lead{background:#f5f7f6}.footer{font-size:9pt}}
</style>
</head>
<body>
<div class="top"><b>QZQ / SEEG DEMO</b><span>SCIENTIFIC DATA → DEMO v3 · 方案审查</span></div>
<div class="layout"><nav class="toc" aria-label="报告目录"><div class="label">报告目录</div>{{TOC}}<div class="note">只读分析原项目与正式数据包。<br>本轮仅交付报告。<br>日期：2026-10-25</div></nav><main class="paper"><header><div class="eyebrow">DATA INTEGRATION / REVIEW DRAFT</div><h1>{{TITLE}}</h1></header>{{BODY}}<footer class="footer"><span>来源：原系统代码、正式数据包及本地研究记录</span><span><a href="现状分析与优化计划.md">报告源文件</a> · <a href="https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/render-html/SKILL.md">render-html</a></span></footer></main></div>
</body>
</html>'''
output = template.replace('{{TITLE}}', html.escape(title)).replace('{{TOC}}', renderer.render_toc(toc)).replace('{{BODY}}', body)
dest = source.with_suffix('.html')
dest.write_text(output, encoding='utf-8')
print(f'Rendered {dest.name}: {len(toc)} section links, {len(output):,} characters; offline self-contained.')
