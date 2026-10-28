#!/usr/bin/env python3
"""Build the generated HTML companion for docs/wiki-source.

The Markdown in docs/wiki-source is canonical. This small renderer intentionally
has no network or credential behavior; it only updates docs/wiki-site and its
search index from the repository-local source tree.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "wiki-source"
SITE_DIR = ROOT / "docs" / "wiki-site"
STYLE = "style.css?v=20260922"
SEARCH = "search-index.js?v=20260922"


NAV_GROUPS = [
    ("Start", [("README", "README"), ("Getting Started", "getting-started"), ("Using Sonuvi", "using-now-playing"), ("Core Concepts", "core-concepts")]),
    ("Displays", [("Displays", "displays"), ("User Interfaces", "user-interfaces"), ("Kiosk", "kiosk-interface"), ("Visualizer", "visualizer-in-embedded-mode")]),
    ("Playback and Library", [("Playback Features", "playback-features"), ("Queue and Playback", "queue-and-playback-model"), ("Queue Wizard", "queue-wizard-internals"), ("Media Library", "media-library"), ("Listen on Device", "listen-on-device")]),
    ("Integrations", [("Integrations", "integrations"), ("Alexa", "alexa-interface"), ("YouTube", "youtube-interface"), ("Radio", "radio-interface"), ("Mabel", "mabel-integration"), ("Jukebox Priority", "jukebox-priority-model")]),
    ("Administration", [("Configuration and Administration", "configuration-and-administration"), ("Config", "config-interface"), ("Diagnostics", "diagnostics-interface"), ("Deployment and Ops", "deployment-and-ops")]),
    ("Developer Reference", [("Developer Reference", "developer-reference"), ("Architecture", "architecture"), ("API Overview", "api-service-overview"), ("API Catalog", "api-endpoint-catalog"), ("Source Map", "source-map")]),
    ("Troubleshooting and Maintenance", [("Troubleshooting", "troubleshooting-and-technical-notes"), ("Playback Triage", "playback-issue-triage-runbook"), ("Display Triage", "display-surface-troubleshooting"), ("Documentation Audit", "documentation-sources-audit"), ("Wiki Operations", "wiki-operations")]),
]


def site_link_target(target: str) -> str:
    """Convert repository Markdown links to links in docs/wiki-site."""
    if target.startswith(("http://", "https://", "mailto:", "#", "/")):
        return target
    path, fragment = (target.split("#", 1) + [""])[:2]
    if path.startswith("sources/"):
        # The sources/ tree is an ingestion/export detail. Prefer its
        # corresponding canonical top-level page when one exists.
        candidate = SOURCE_DIR / Path(path).name
        if candidate.exists():
            path = candidate.stem + ".html"
    elif (
        path.endswith(".md")
        and (SOURCE_DIR / path).exists()
        and (SOURCE_DIR / path).resolve().parent == SOURCE_DIR.resolve()
    ):
        # Only top-level canonical pages are emitted by build(). Standalone
        # handoffs/runbooks and audit evidence remain Markdown destinations.
        path = str(Path(path).with_suffix(".html"))
    return path + (("#" + fragment) if fragment else "")


def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        _, rest = text.split("\n---\n", 1)
        return rest
    return text


def strip_generated_blocks(text: str) -> str:
    """Omit plugin-managed inventory blocks from the public HTML view."""
    return re.sub(
        r"<!-- openclaw:wiki:index:start -->.*?<!-- openclaw:wiki:index:end -->",
        "",
        text,
        flags=re.S,
    )


def slugify(text: str) -> str:
    text = re.sub(r"`([^`]+)`", r"\1", text.strip().lower())
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    return re.sub(r"-+", "-", re.sub(r"\s+", "-", text).strip("-")) or "section"


def inline_md(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"!\[([^]]*)\]\(([^)]+)\)", r'<img alt="\1" src="\2">', escaped)
    escaped = re.sub(
        r"\[([^]]+)\]\(([^)]+)\)",
        lambda match: f'<a href="{html.escape(site_link_target(html.unescape(match.group(2))), quote=True)}">{match.group(1)}</a>',
        escaped,
    )
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", escaped)
    return escaped


def render_markdown(text: str) -> str:
    lines = strip_generated_blocks(strip_frontmatter(text)).splitlines()
    output: list[str] = []
    i = 0
    in_code = False
    code: list[str] = []
    while i < len(lines):
        line = lines[i]
        if line.startswith("```") or line.startswith("~~~"):
            if not in_code:
                in_code = True
                code = []
            else:
                output.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
                in_code = False
            i += 1
            continue
        if in_code:
            code.append(line)
            i += 1
            continue
        if not line.strip():
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2).strip()
            output.append(f'<h{level} id="{slugify(title)}">{inline_md(title)}</h{level}>')
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and "|" in lines[i + 1] and re.match(r"^\s*\|?\s*:?-{3,}", lines[i + 1]):
            rows: list[list[str]] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", cell) or not cell for cell in cells):
                    rows.append(cells)
                i += 1
            if rows:
                head, *body = rows
                table = ["<table><thead><tr>"] + [f"<th>{inline_md(cell)}</th>" for cell in head]
                table += ["</tr></thead><tbody>"]
                for row in body:
                    table.append("<tr>" + "".join(f"<td>{inline_md(cell)}</td>" for cell in row) + "</tr>")
                table.append("</tbody></table>")
                output.append("".join(table))
            continue
        if re.match(r"^[-*+]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^[-*+]\s+", lines[i]):
                items.append("<li>" + inline_md(re.sub(r"^[-*+]\s+", "", lines[i])) + "</li>")
                i += 1
            output.append("<ul>" + "".join(items) + "</ul>")
            continue
        if re.match(r"^\d+\.\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i]):
                items.append("<li>" + inline_md(re.sub(r"^\d+\.\s+", "", lines[i])) + "</li>")
                i += 1
            output.append("<ol>" + "".join(items) + "</ol>")
            continue
        if line.startswith(">"):
            quote = []
            while i < len(lines) and lines[i].startswith(">"):
                quote.append(inline_md(re.sub(r"^>\s?", "", lines[i])))
                i += 1
            output.append("<blockquote>" + " ".join(quote) + "</blockquote>")
            continue
        paragraph = [line.strip()]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,6})\s+", lines[i]) and not re.match(r"^[-*+]\s+", lines[i]) and not re.match(r"^\d+\.\s+", lines[i]) and not lines[i].startswith(("```", "~~~", ">")):
            paragraph.append(lines[i].strip())
            i += 1
        output.append("<p>" + inline_md(" ".join(paragraph)) + "</p>")
    return "".join(output)


def nav_html() -> str:
    groups = []
    for title, pages in NAV_GROUPS:
        links = "".join(f'<li><a href="{slug}.html">{html.escape(label)}</a></li>' for label, slug in pages)
        groups.append(f"<details><summary><strong>{html.escape(title)}</strong></summary><ul>{links}</ul></details>")
    return '<nav><h1><a href="README.html">Sonuvi documentation</a></h1><div class="meta">Canonical source: <code>docs/wiki-source/</code></div>' + "".join(groups) + "</nav>"


def shell(article: str, title: str) -> str:
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(title)}</title><link rel=\"stylesheet\" href=\"{STYLE}\">"
        f'<script src="{SEARCH}"></script></head><body>{nav_html()}<article>{article}</article>'
        '<script>(function(){var p=(location.pathname.split("/").pop()||"README.html");document.querySelectorAll("nav a[href]").forEach(function(a){if(a.getAttribute("href")===p){a.classList.add("nav-current");var d=a.closest("details");if(d)d.open=true;}});})();</script>'
        '<script>(function(){var i=document.getElementById("nav-search");if(!i)return;})();</script></body></html>'
    )


def text_for_search(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-zA-Z0-9\s]", " ", strip_frontmatter(text))).strip().lower()


def build() -> None:
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    source_files = sorted(SOURCE_DIR.glob("*.md"))
    for source in source_files:
        target = SITE_DIR / f"{source.stem}.html"
        if not target.exists() or source.stat().st_mtime > target.stat().st_mtime:
            body = render_markdown(source.read_text(encoding="utf-8"))
            target.write_text(shell(body, source.stem), encoding="utf-8")

    # Navigation is generated for every existing page so new category hubs are reachable.
    for target in SITE_DIR.glob("*.html"):
        document = target.read_text(encoding="utf-8", errors="ignore")
        if "<nav>" in document and "</nav>" in document:
            document = re.sub(r"<nav>.*?</nav>", nav_html(), document, count=1, flags=re.S)
            document = re.sub(r'href="style\.css(?:\?v=[^"]+)?"', f'href="{STYLE}"', document)
            document = re.sub(r'<script src="search-index\.js(?:\?v=[^"]+)?"></script>', f'<script src="{SEARCH}"></script>', document)
            target.write_text(document, encoding="utf-8")

    index = {}
    for source in source_files:
        title = next((line[2:].strip() for line in source.read_text(encoding="utf-8").splitlines() if line.startswith("# ")), source.stem)
        index[f"{source.stem}.html"] = f"{title} {source.stem} {text_for_search(source.read_text(encoding='utf-8'))}"[:12000]
    (SITE_DIR / "search-index.js").write_text(
        "window.NP_KNOWLEDGE_SEARCH_INDEX = " + json.dumps(index, indent=2, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    print(f"built {len(source_files)} source pages in {SITE_DIR}")


if __name__ == "__main__":
    build()
