"""Publish the maintained Markdown manuals to the site's existing online help."""
import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELP = ROOT / "project" / "_help"
STYLE = "body{max-width:1000px;margin:24px auto;padding:0 20px;font:16px/1.7 system-ui;color:#183049}a{color:#125487}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:8px;border:1px solid #b7c7d6;text-align:left}pre{white-space:pre-wrap;background:#edf2f7;padding:12px}code{overflow-wrap:anywhere}h1,h2,h3{line-height:1.4}"


def inline(text):
    text = html.escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return text


def render(text):
    output, paragraph, table, code = [], [], [], None

    def flush():
        if paragraph:
            output.append("<p>" + "<br>".join(paragraph) + "</p>")
            paragraph.clear()
        if table:
            output.append("<table>" + "".join("<tr>" + "".join("<" + ("th" if i == 0 else "td") + ">" + inline(cell.strip()) + "</" + ("th" if i == 0 else "td") + ">" for cell in row) + "</tr>" for i, row in enumerate(table)) + "</table>")
            table.clear()

    for line in text.splitlines():
        if line.startswith("```"):
            if code is None:
                flush()
                code = []
            else:
                output.append("<pre>" + html.escape("\n".join(code)) + "</pre>")
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        if line.startswith("|"):
            if paragraph:
                flush()
            cells = line.strip().strip("|").split("|")
            if not all(re.fullmatch(r"\s*:?-+:?\s*", cell) for cell in cells):
                table.append(cells)
            continue
        if table:
            flush()
        heading = re.match(r"^(#{1,6}) (.*)", line)
        if heading:
            flush()
            level = len(heading[1])
            output.append(f"<h{level}>" + inline(heading[2]) + f"</h{level}>")
        elif not line.strip():
            flush()
        else:
            paragraph.append(inline(line))
    flush()
    return "\n".join(output)


def main():
    HELP.mkdir(parents=True, exist_ok=True)
    manuals = [("产品说明书", "current-product.htm"), ("使用手册", "current-user.htm"), ("部署维护手册", "current-maintenance.htm")]
    links = " · ".join(f'<a href="{file}">{title}</a>' for title, file in manuals)
    for title, file in manuals:
        source = (ROOT / "docs" / (title + ".md")).read_text(encoding="utf-8-sig")
        content = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SCADIA ' + title + '</title><style>' + STYLE + '</style></head><body><nav><a href="index.htm">帮助目录</a> · ' + links + '</nav><p>当前维护版本；现场待验项目以正文说明为准。CHM未重编，属旧版参考。</p>' + render(source) + '</body></html>'
        (HELP / file).write_text(content, encoding="utf-8")
    index = HELP / "index.htm"
    if index.exists():
        text = index.read_text(encoding="utf-8-sig")
        block = '<!-- current-manuals --><h2>当前完整手册</h2><p>' + links + '</p><!-- /current-manuals -->'
        if '<!-- current-manuals -->' in text:
            text = re.sub(r'<!-- current-manuals -->[\s\S]*?<!-- /current-manuals -->', lambda _: block, text)
        else:
            text = text.replace('<h2>', block + '<h2>', 1)
        index.write_text(text, encoding="utf-8")
    print("Published 3 current manuals and updated online help index; CHM unchanged")


if __name__ == "__main__":
    main()
