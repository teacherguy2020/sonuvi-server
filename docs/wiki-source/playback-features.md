---
title: playback-features
page_type: parent
topics:
  - playback
  - transport
  - modes
  - troubleshooting
confidence: medium
---

# playback features

## Purpose

This page documents the playback-features branch of the `now-playing` project.

It exists because playback-related knowledge currently exists across strong pages, but is still spread between authority, troubleshooting, issue triage, and queue-adjacent model pages.

A better current interpretation is:
- playback is not only transport buttons
- it is also about authority by mode, visible state interpretation, failure patterns, and how playback truth appears across surfaces
- queue behavior overlaps with playback behavior, but playback still deserves its own top-level branch identity

So this page should act as the umbrella for playback-specific behavior rather than leaving playback to be inferred from queue pages and runbooks alone.

## Relevant source files

This page is branch-oriented rather than file-complete, but these areas are especially relevant when grounding playback behavior:
- now-playing surfaces such as `controller-now-playing.html` and related variants
- playback-affecting controller actions in controller-family pages
- playback routes under `src/routes/`
- app-host logic that normalizes playback truth for `/now-playing`
- diagnostics and runtime-admin surfaces that can affect or expose playback state

## Playback features at a glance

If you need the compressed branch model first, use this:
- **playback features** are about transport state, mode-specific authority, visible current-track truth, and how those behaviors appear to users
- **playback authority varies by mode**, so not all playback questions have the same owner or truth path
- **playback troubleshooting** often requires distinguishing transport problems from queue problems and state-truth problems
- **playback rendering** depends on upstream truth normalization, not only on one raw backend signal

That is why playback should be treated as its own top-level branch.

## Why this page matters

Without a playback parent page, it is easy to make one of two bad assumptions:
- that playback is just the transport half of queue behavior
- or that playback knowledge mostly lives in troubleshooting runbooks

Both are too narrow.

Playback is a branch because it connects:
- user-visible now-playing behavior
- transport and mode authority
- route-side normalization
- failure analysis across live runtime states

## Read this branch in this order

If you are trying to understand the playback branch as a system, read in this order:
1. [playback-features.md](playback-features.md)
2. [playback-authority-by-mode.md](playback-authority-by-mode.md)
3. [playback-mode-troubleshooting.md](playback-mode-troubleshooting.md)
4. [playback-issue-triage-runbook.md](playback-issue-triage-runbook.md)
5. [queue-and-playback-model.md](queue-and-playback-model.md) for the overlap zone with queue behavior

Then move into route ownership or interface pages when the question becomes more implementation-specific.

## Audio Info is evidence, not playback authority

Open [Audio Info](diagnostics-interface.md#audio-info-entry-points-and-presentation)
through the appropriate client entry: the dedicated native iOS screen or the
Server web tablet Audio info action. The [diagnostics contract](diagnostics-interface.md#audio-info-diagnostics-contract)
separates source, decoded PCM, configured chain, measured ALSA, processing,
freshness and conversion uncertainty. It does not replace source ownership or
prove bit-perfect playback from endpoint format alone.

## Strong current sub-branches

### 1. Playback authority branch
Current strongest page:
- [playback-authority-by-mode.md](playback-authority-by-mode.md)

This branch matters because playback truth is not uniform across modes.
Mode-sensitive authority is one of the most important conceptual guardrails in the project.

### 2. Playback troubleshooting branch
Current strongest page:
- [playback-mode-troubleshooting.md](playback-mode-troubleshooting.md)

This branch matters because playback failures often differ depending on local file playback, AirPlay, UPnP, radio/stream behavior, or fallback paths.

### 3. Playback triage branch
Current strongest page:
- [playback-issue-triage-runbook.md](playback-issue-triage-runbook.md)

This branch matters because practical debugging needs an order of operations, not just conceptual background.

### 4. Queue overlap branch
Current strongest page:
- [queue-and-playback-model.md](queue-and-playback-model.md)

This branch matters because playback and queue are deeply related, but should not collapse into one concept.

## What this branch still needs later

The current parent page is intentionally modest.
It establishes the branch, but it does not yet claim that every playback-oriented surface or route family is fully mapped.

Likely future improvements:
- more explicit mapping of playback-facing now-playing surfaces
- stronger bridge page between playback authority and visible now-playing rendering
- sharper distinction between playback state truth, queue state truth, and display/render consequences

## Relationship to other pages

This page should stay closely linked with:
- [queue-and-playback-model.md](queue-and-playback-model.md)
- [api-state-truth-endpoints.md](api-state-truth-endpoints.md)
- [api-playback-and-queue-endpoints.md](api-playback-and-queue-endpoints.md)
- [user-interfaces.md](user-interfaces.md)
- [display-interface.md](display-interface.md)

## Current status

At the moment, this page establishes Playback Features as a real top-level branch in the local wiki.

That matters because the underlying content already existed, but the branch identity was still weaker than the DeepWiki model.

*Last reviewed: 2026-10-28 America/Chicago*
