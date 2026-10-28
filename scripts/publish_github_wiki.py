#!/usr/bin/env python3
"""Publish docs/wiki-source to a checked-out GitHub Wiki repository.

This script never asks for or stores credentials. Authentication and pushing
remain the operator's Git/SSH responsibility. Existing Wiki pages are retained
by default so an audit can be reviewed before any legacy pruning.
"""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "wiki-source"

# This page contains Brian's installation-specific host map and deployment
# paths. Keep it in the repository-only knowledge base; never publish it to
# the public Wiki.
EXCLUDED_SOURCE_PAGES = {"local-environment.md"}

# The repository contains useful operational notes that mention Brian's
# installation addresses and paths. Keep the public Wiki useful without
# publishing those installation-specific values.
PUBLIC_REDACTIONS = (
    (r"\bbrianwis@10\.0\.0\.4\b", "{app-user}@{app-host}"),
    (r"\bmoode@10\.0\.0\.254\b", "{moode-user}@{moode-host}"),
    (r"\b10\.0\.0\.4(?::\d+)?\b", "{app-host}"),
    (r"\b10\.0\.0\.254(?::\d+)?\b", "{moode-host}"),
    (r"\b10\.0\.0\.233(?::\d+)?\b", "{legacy-pi-host}"),
    (r"\b10\.0\.0\.7(?::\d+)?\b", "{mills-pico-host}"),
    (r"/opt/now-playing", "{now-playing-install-dir}"),
    (r"/Users/brianwis(?:/[^ `)\]]+)?", "{workspace}"),
    (r"\bBrian(?:’|')s current setup\b", "the local setup"),
)


def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        _, rest = text.split("\n---\n", 1)
        return rest
    return text


def strip_generated_blocks(text: str) -> str:
    return re.sub(
        r"<!-- openclaw:wiki:index:start -->.*?<!-- openclaw:wiki:index:end -->",
        "",
        text,
        flags=re.S,
    )


def public_text(text: str) -> str:
    for pattern, replacement in PUBLIC_REDACTIONS:
        text = re.sub(pattern, replacement, text)
    return text


def wiki_links(text: str) -> str:
    """Convert repository links to public Wiki slugs.

    Generated ``sources/`` links point at the corresponding canonical page
    when it exists. Links to excluded installation-local pages become plain
    text rather than exposing or creating a broken public link.
    """

    def replace(match: re.Match[str]) -> str:
        label, target = match.group(1), match.group(2)
        if target.startswith(("http://", "https://", "mailto:", "#", "/")):
            return match.group(0)
        path, fragment = (target.split("#", 1) + [""])[:2]
        if path.startswith("sources/"):
            candidate = SOURCE_DIR / Path(path).name
            if candidate.exists():
                path = candidate.name
        elif path.startswith("../"):
            candidate = SOURCE_DIR / path
            if candidate.exists():
                if candidate.resolve().parent != SOURCE_DIR.resolve():
                    # Standalone repository documents/evidence are not Wiki pages.
                    repository_path = candidate.resolve().relative_to(ROOT.resolve()).as_posix()
                    url = "https://github.com/teacherguy2020/now-playing/blob/main/" + repository_path
                    return f"[{label}]({url}{('#' + fragment) if fragment else ''})"
                path = candidate.name
        if path in {"README", "README.md"}:
            path = "Home"
        if path in EXCLUDED_SOURCE_PAGES:
            return label + " (repository-only)"
        if path.endswith(".md"):
            path = path[:-3]
        return f"[{label}]({path}{('#' + fragment) if fragment else ''})"

    return re.sub(r"\[([^]]+)\]\(([^)]+)\)", replace, text)


def source_pages() -> list[Path]:
    return sorted(
        p for p in SOURCE_DIR.glob("*.md")
        if p.name != "README.md" and p.name not in EXCLUDED_SOURCE_PAGES
    )


def home_text() -> str:
    return """# Sonuvi documentation

This Wiki is a published view of the canonical Markdown in
[`docs/wiki-source/`](https://github.com/teacherguy2020/now-playing/tree/main/docs/wiki-source).
Edit the repository source and publish it with
`scripts/publish_github_wiki.py`; do not maintain feature pages directly in
the Wiki.

## Start here

- [Getting Started](getting-started)
- [Using Sonuvi](using-now-playing)
- [Displays](displays)
- [Integrations](integrations)
- [Configuration and Administration](configuration-and-administration)
- [Developer Reference](developer-reference)
- [Troubleshooting and Technical Notes](troubleshooting-and-technical-notes)

## Feature pages

- [Listen on Device](listen-on-device)
- [Radio Interface](radio-interface)
- [Podcasts Interface](podcasts-interface)
- [Mabel Integration](mabel-integration)
- [Jukebox Priority Model](jukebox-priority-model)

The source comparison and legacy-page disposition are recorded in
[Documentation Sources Audit](documentation-sources-audit).

Installation-specific host maps remain repository-only and are intentionally
not published to this Wiki; public copies of operational examples redact
installation-specific host addresses and paths.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki-dir", required=True, type=Path, help="checked-out now-playing.wiki repository")
    parser.add_argument("--push", action="store_true", help="commit and push the generated Wiki copy")
    args = parser.parse_args()
    wiki_dir = args.wiki_dir.resolve()
    if not (wiki_dir / ".git").exists():
        raise SystemExit(f"not a Git repository: {wiki_dir}")

    pages = source_pages()
    (wiki_dir / "Home.md").write_text(home_text(), encoding="utf-8")
    for source in pages:
        target = wiki_dir / source.name
        source_text = public_text(
            strip_generated_blocks(strip_frontmatter(source.read_text(encoding="utf-8")))
        )
        target.write_text(wiki_links(source_text), encoding="utf-8")

    published = {"Home.md", *(p.name for p in pages)}
    legacy = sorted(p.name for p in wiki_dir.glob("*.md") if p.name not in published)
    print(f"published {len(pages)} canonical pages plus Home.md")
    print("excluded repository-only pages:")
    for name in sorted(EXCLUDED_SOURCE_PAGES):
        print(f"- {name}")
    if legacy:
        print("retained legacy Wiki pages:")
        for name in legacy:
            print(f"- {name}")

    if args.push:
        subprocess.run(["git", "-C", str(wiki_dir), "add", "Home.md", *[p.name for p in pages]], check=True)
        staged = subprocess.run(["git", "-C", str(wiki_dir), "diff", "--cached", "--quiet"])
        if staged.returncode == 1:
            subprocess.run(["git", "-C", str(wiki_dir), "commit", "-m", "Publish canonical repository documentation"], check=True)
            subprocess.run(["git", "-C", str(wiki_dir), "push", "origin", "master"], check=True)
        else:
            print("Wiki already matches the canonical pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
