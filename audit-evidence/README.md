# DeepWiki comparison evidence — 2026-10-28

This directory belongs to the isolated analysis worktree, not the production deployment. It contains read-only observations plus audit-only extraction/ledger scripts. No credentials were needed for retrieval.

## Primary review artifacts

- `page-ledger.md` / `page-ledger.json`: all 77 current pages, exact canonical URLs, hierarchy, revisions, body hashes, source references, comparison limitations and source-check conclusions.
- `coverage-summary.json`: four coverage stages and historical body limitations.
- `full-pages/`: complete current substantive Markdown, one file per numbered page.
- `source-checks.json`: selected implementation windows with exact source line numbers. These are static checks, not test-run output or an endorsement of every page claim.
- `wiki-metadata.json`: index version, full indexed SHA and raw generation timestamp.
- `link-closure.json`: navigation/body fixed point and alias/removal probe details.
- `validation.json`: artifact checks and final worktree status.

## Retrieval provenance

Direct DeepWiki requests returned HTTP 429. `mirror-overview.txt` and `pages/` are article-only read-only Jina fallback responses. `crawl.json` records the **initial incomplete** article-only crawl; its five-URL result is not the final coverage count.

`navigation.html` is the Jina HTML fallback response for the overview, requested with `X-Return-Format: html` and `X-With-Links-Summary: all`. It contains the full wiki navigation and all page Markdown bodies in React Flight records. `extract.py` resolves actual content references, validates the declared UTF-8 byte lengths and saves individual bodies. `flight.txt`, `navigation-script-*.txt`, and `navigation-links.json` preserve the intermediate evidence. All 77 extracted bodies were read, not inferred from navigation.

`old-9.7-probe.txt` is the response to a candidate historical slug reconstructed from the old title. It returns Overview; it is not archived Audio Info. Exact historical slug/alias inventory was not found.

## Historical/revision evidence

- `old-report-audit.md`: byte-identical copy of the original untracked audit report.
- `old-report-publication.md`, `old-report-reconcile.md`: copies from preserved historical worktrees.
- These contain the old 77-title inventory and specific findings, **not full historical page bodies**.
- `indexed-delta.patch`: exact Git binary-capable diff between the two indexed SHAs.
- `indexed-delta-files.txt`, `indexed-delta-numstat.tsv`, `indexed-commits.txt`, `reconciliation.patch`, `baselines.json`: precise revision and attribution evidence.
- `worktrees-before.txt` / `worktrees-after.txt`: worktree registrations around analysis (the new comparison worktree already exists in the before snapshot). No old worktree was pruned or changed.

## Reproduction caveat

`extract.py` is the raw body extractor. `verify-source.py` captures selected source windows. `finalize-ledger.py` applies the audit's manually reasoned page assessments. The latter's classifications are analytical judgments, not automatic truth inferred from successful regex matches. `read-pages.py` is a reading convenience; the unabridged originals remain under `full-pages/`.

Do not run extraction on top of the final ledger without preserving that ledger: extraction initializes comparison statuses. To reproduce, use a fresh directory/worktree and retain raw evidence. Retrieval of a later website refresh will describe a different snapshot.

All 73 historically indeterminate shared pages are labeled as such. Zero literal old/new body diffs were possible. Source citation extraction is an inventory, not validation that every cited filename exists or every cited line supports its claim.

Last reviewed: 2026-10-28 America/Chicago.
