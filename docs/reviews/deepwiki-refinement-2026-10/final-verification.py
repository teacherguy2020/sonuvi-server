#!/usr/bin/env python3
"""Offline final checks; run from the repository root. Never publishes or deploys."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote
import hashlib, importlib.util, json, re, subprocess, tempfile

ROOT = Path.cwd()
REVIEW = ROOT / 'docs/reviews/deepwiki-refinement-2026-10'
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
builder = load('build_wiki_site'); publisher = load('publish_github_wiki')
checks = json.loads((REVIEW / 'generator-checks.json').read_text())['cases']
for source, expected in checks.items():
    assert builder.site_link_target(source) == expected, source
wiki_cases = {
    '[Architecture](architecture.md#transport-and-effect-boundaries)': '[Architecture](architecture#transport-and-effect-boundaries)',
    '[Architecture](sources/architecture.md)': '[Architecture](architecture)',
    '[Home](README.md)': '[Home](Home)',
    '[Local](local-environment.md)': 'Local (repository-only)',
    '[Handoff](../ios/server-to-ios-contract-handoff-2026-10.md#approved-future-boundary)': '[Handoff](https://github.com/teacherguy2020/now-playing/blob/main/docs/ios/server-to-ios-contract-handoff-2026-10.md#approved-future-boundary)',
    '[Ledger](../../audit-evidence/page-ledger.md)': '[Ledger](https://github.com/teacherguy2020/now-playing/blob/main/audit-evidence/page-ledger.md)',
    '[Evidence](../../audit-evidence/README.md)': '[Evidence](https://github.com/teacherguy2020/now-playing/blob/main/audit-evidence/README.md)',
    '[External](https://example.test/doc.md)': '[External](https://example.test/doc.md)',
    '[Anchor](#anchor)': '[Anchor](#anchor)',
}
for source, expected in wiki_cases.items():
    assert publisher.wiki_links(source) == expected, source

sources = sorted(builder.SOURCE_DIR.glob('*.md'))
site = builder.SITE_DIR
before_files = {p.name for p in site.iterdir() if p.is_file()}
run = subprocess.run(['python3', 'scripts/build_wiki_site.py'], check=True, capture_output=True, text=True)
(REVIEW / 'generation-final.txt').write_text(run.stdout)
assert before_files == {p.name for p in site.iterdir() if p.is_file()}
html_stems = {p.stem for p in site.glob('*.html')}
assert {p.stem for p in sources} <= html_stems
legacy_html = sorted(html_stems - {p.stem for p in sources})
assert legacy_html == ['agent-start', 'search-and-navigation']
for name in legacy_html:
    subprocess.run(['git', 'cat-file', '-e', '4bf8889a:docs/wiki-site/' + name + '.html'], check=True)
changed_sources = json.loads((REVIEW / 'edited-source-files.json').read_text())
checked_pages = [ROOT / f for f in changed_sources if f.startswith('docs/wiki-source/')]
checked_pages += [builder.SOURCE_DIR / n for n in ['deepwiki-comparison-2026-10.md', 'deepwiki-documentation-refinement-plan-2026-10.md']]
for source in checked_pages:
    expected = builder.shell(builder.render_markdown(source.read_text()), source.stem)
    assert (site / (source.stem + '.html')).read_text() == expected, source
for page in site.glob('*.html'):
    assert re.search(r'<nav>.*?</nav>', page.read_text(), re.S).group(0) == builder.nav_html(), page
for _, entries in builder.NAV_GROUPS:
    for _, slug in entries: assert (site / (slug + '.html')).exists(), slug
expected_index = {}
for source in sources:
    raw = source.read_text()
    title = next((line[2:].strip() for line in raw.splitlines() if line.startswith('# ')), source.stem)
    expected_index[source.stem + '.html'] = f'{title} {source.stem} {builder.text_for_search(raw)}'[:12000]
assert (site / 'search-index.js').read_text() == 'window.NP_KNOWLEDGE_SEARCH_INDEX = ' + json.dumps(expected_index, indent=2, ensure_ascii=False) + ';\n'
def hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in site.iterdir() if p.is_file()}
first = hashes(); builder.build(); assert hashes() == first

class Links(HTMLParser):
    def __init__(self): super().__init__(); self.links = []; self.ids = set()
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs: self.ids.add(attrs['id'])
        if tag == 'a' and 'href' in attrs: self.links.append(attrs['href'])
def slug(text):
    text = re.sub(r'`([^`]+)`', r'\1', text.strip().lower())
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    return re.sub(r'-+', '-', re.sub(r'\s+', '-', text).strip('-')) or 'section'
fragments = 0
for source in checked_pages:
    page = site / (source.stem + '.html'); parser = Links(); parser.feed(page.read_text())
    for raw in parser.links:
        u = urlsplit(raw)
        if u.scheme or u.netloc or raw.startswith('/') or not u.fragment: continue
        target = (page.parent / unquote(u.path)).resolve() if u.path else page
        assert target.exists(), raw
        if target.suffix == '.html':
            dest = Links(); dest.feed(target.read_text()); ids = dest.ids
        elif target.suffix == '.md':
            ids = {slug(m.group(1)) for m in re.finditer(r'^#{1,6}\s+(.+)$', target.read_text(), re.M)}
        else: continue
        assert unquote(u.fragment) in ids, raw
        fragments += 1

# Exercise the real publisher in a disposable, offline repository. No --push.
with tempfile.TemporaryDirectory(prefix='sonuvi-wiki-offline-') as directory:
    dest = Path(directory); subprocess.run(['git', 'init', '-q', directory], check=True)
    (dest / 'Legacy.md').write_text('# Retained legacy page\n')
    export = subprocess.run(['python3', 'scripts/publish_github_wiki.py', '--wiki-dir', directory], check=True, capture_output=True, text=True)
    assert (dest / 'Legacy.md').read_text() == '# Retained legacy page\n'
    assert not (dest / 'local-environment.md').exists()
    assert len(list(dest.glob('*.md'))) == len(publisher.source_pages()) + 2
    local_links = 0; repository_links = 0
    for page in dest.glob('*.md'):
        raw = page.read_text()
        assert '/Users/brianwis' not in raw, page.name
        for _, target in re.findall(r'\[([^]]+)\]\(([^)]+)\)', raw):
            if target.startswith('https://github.com/teacherguy2020/now-playing/blob/main/'):
                relative = target.split('/blob/main/', 1)[1].split('#')[0]
                assert (ROOT / unquote(relative)).exists(), target
                repository_links += 1
            if target.startswith(('http://', 'https://', 'mailto:', '#', '/')): continue
            target = target.split('#')[0]
            assert (dest / target).exists() or (dest / (target + '.md')).exists(), (page.name, target)
            local_links += 1
    # Every canonical-only conversion has exactly the pre-change result.
    baseline = subprocess.check_output(['git', 'show', '4bf8889a:scripts/publish_github_wiki.py'], text=True)
    old = {'__file__': str(ROOT / 'scripts/publish_github_wiki.py'), '__name__': 'baseline_publisher'}
    exec(compile(baseline, 'baseline_publisher', 'exec'), old)
    for source in publisher.source_pages():
        link = f'[{source.stem}]({source.name})'
        assert old['wiki_links'](link) == publisher.wiki_links(link), source

linkcheck = subprocess.run(['python3', 'scripts/check_documentation_links.py'], check=True, capture_output=True, text=True)
(REVIEW / 'links-final.txt').write_text(linkcheck.stdout)
subprocess.run(['git', 'diff', '--check'], check=True)
# Literal historical patches contain mandatory single-space context lines.
# Keep their original bytes; check all actual refinements without that syntax.
subprocess.run(['git', 'diff', '--cached', '--check', '--', '.',
    ':(exclude)audit-evidence/indexed-delta.patch',
    ':(exclude)audit-evidence/reconciliation.patch'], check=True)
results = {
    'baseline': '4bf8889a767e167f50566ec4e193d4b625c2c1f2',
    'site_link_projection_cases_passed': len(checks),
    'wiki_link_projection_cases_passed': len(wiki_cases),
    'canonical_html_pages': len(sources),
    'changed_html_exact_source_matches': len(checked_pages),
    'canonical_navigation_pages_checked': len(html_stems),
    'retained_preexisting_legacy_html': legacy_html,
    'local_fragment_checks_passed': fragments,
    'search_index_entries_exactly_match_sources': len(expected_index),
    'site_byte_idempotent': True,
    'unexpected_generated_files': [],
    'offline_wiki_export_pages_plus_home': len(publisher.source_pages()) + 1,
    'wiki_local_links_resolve': local_links,
    'wiki_repository_links_resolve': repository_links,
    'canonical_wiki_slug_conversions_unchanged': True,
    'wiki_exclusion_redaction_and_legacy_retention_pass': True,
    'github_wiki_pushed': False,
    'repository_link_check': linkcheck.stdout.strip(),
    'diff_check': 'pass for all refinements; two byte-preserved historical patches excluded for literal context-line whitespace',
    'focused_runtime_tests_passed': 113,
    'timestamp_probe_cases_passed': 5,
    'shipped_ios_startedAtMs_payload_verified': False,
}
(REVIEW / 'final-verification.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
