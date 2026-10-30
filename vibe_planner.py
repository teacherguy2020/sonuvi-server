#!/usr/bin/env python3
"""Pure candidate selection for the local-library Vibe queue builder.

This module deliberately knows nothing about MPD, Last.fm, or the filesystem.
Keeping selection here makes the queue plan testable before a caller is allowed
to change playback.
"""

from __future__ import annotations

from collections import Counter, deque
import random
import re
from typing import Iterable, Mapping


TITLE_JUNK = (
    "album version", "single version", "radio edit", "edit",
    "remaster", "remastered", "live", "live album version",
    "mono", "stereo", "bonus track", "deluxe edition", "expanded edition",
)

XMAS_WORDS = (
    "christmas", "xmas", "noel", "nativity", "yuletide", "advent",
    "silent night", "jingle bell", "santa", "mistletoe",
    "winter wonderland", "white christmas", "let it snow",
    "have yourself a merry little christmas",
    "it's the most wonderful time of the year",
    "the christmas song", "christmas waltz",
)

_ENSEMBLE_SUFFIX_RE = re.compile(r"\b(?:trio|quartet|quintet|sextet|septet|octet)\b$")


def norm(value: str) -> str:
    """Normalize library and Last.fm text for stable comparison."""
    text = str(value or "").casefold().strip()
    if not text:
        return ""
    text = re.sub(r"\s*\(.*?\)\s*", " ", text)
    text = re.sub(r"\s*\[.*?\]\s*", " ", text)
    text = re.sub(r"\b(feat|ft)\.?\b.*$", "", text)
    for junk in TITLE_JUNK:
        text = text.replace(junk, " ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def artist_family_key(value: str) -> str:
    """Collapse simple ensemble variants (for example, ``John Mayer Trio``)."""
    key = norm(value)
    collapsed = _ENSEMBLE_SUFFIX_RE.sub("", key).strip()
    return collapsed or key


def track_key(artist: str, title: str) -> str:
    artist_key = norm(artist)
    title_key = norm(title)
    return f"{artist_key}|{title_key}" if artist_key and title_key else ""


def album_key(album: str) -> str:
    return norm(album)


def genre_tokens(genre: str) -> set[str]:
    return {norm(part) for part in re.split(r"[;,|/]", str(genre or "")) if norm(part)}


def is_seasonal_text(*parts: str) -> bool:
    haystack = " ".join(str(part or "") for part in parts).casefold()
    return any(word in haystack for word in XMAS_WORDS)


def _positive_int(value, fallback: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return fallback


def _prepare_candidates(
    candidates: Iterable[Mapping[str, object]],
    *,
    avoid_files: set[str],
    avoid_tracks: set[str],
    include_seasonal: bool,
) -> list[dict[str, object]]:
    """Normalize, de-duplicate, and filter raw resolved local candidates."""
    raw_items: list[dict[str, object]] = []

    for ordinal, raw in enumerate(candidates, start=1):
        file_name = str(raw.get("file") or "").strip()
        artist = str(raw.get("artist") or raw.get("rec_artist") or "").strip()
        title = str(raw.get("title") or raw.get("rec_title") or "").strip()
        album = str(raw.get("album") or "").strip()
        genre = str(raw.get("genre") or "").strip()
        if not file_name or not artist or not title:
            continue

        item_track_key = track_key(artist, title)
        if file_name in avoid_files or (item_track_key and item_track_key in avoid_tracks):
            continue
        if not include_seasonal and is_seasonal_text(file_name, artist, title, album, genre):
            continue
        source_rank = _positive_int(raw.get("source_rank"), ordinal)
        item = dict(raw)
        item.update({
            "file": file_name,
            "artist": artist,
            "title": title,
            "album": album,
            "genre": genre,
            "source_rank": source_rank,
            "_artist_key": norm(artist),
            "_artist_family_key": artist_family_key(artist),
            "_album_key": album_key(album),
            "_track_key": item_track_key,
            "_genres": genre_tokens(genre),
        })

        raw_items.append(item)

    # Sort before de-duplicating so the closest Last.fm recommendation wins
    # even if the incoming source was not rank-ordered.
    prepared: list[dict[str, object]] = []
    seen_files: set[str] = set()
    seen_tracks: set[str] = set()
    for item in sorted(raw_items, key=lambda value: int(value["source_rank"])):
        file_name = str(item["file"])
        candidate_track_key = str(item["_track_key"])
        if file_name in seen_files or (candidate_track_key and candidate_track_key in seen_tracks):
            continue
        seen_files.add(file_name)
        if candidate_track_key:
            seen_tracks.add(candidate_track_key)
        prepared.append(item)

    return prepared


def _is_eligible(
    candidate: Mapping[str, object],
    *,
    stage: int,
    selected_count: int,
    seed_artist_key: str,
    artist_counts: Counter[str],
    album_counts: Counter[str],
    recent_artists: deque[str],
) -> bool:
    artist_key = str(candidate["_artist_family_key"])
    album = str(candidate["_album_key"])
    is_seed_artist = bool(seed_artist_key and artist_key == seed_artist_key)
    artist_count = artist_counts[artist_key]
    album_count = album_counts[album] if album else 0

    # Prefer broad discovery for the first few tracks, then relax only when
    # the candidate pool genuinely cannot sustain that level of variety.
    if stage == 0:
        return (
            artist_key not in recent_artists
            and artist_count == 0
            and album_count == 0
            and not (is_seed_artist and selected_count < 4)
        )
    if stage == 1:
        return artist_key not in list(recent_artists)[-2:] and artist_count < 2 and album_count == 0
    if stage == 2:
        return artist_key not in list(recent_artists)[-1:] and artist_count < 2
    if stage == 3:
        return artist_count < 3
    return True


def _score(
    candidate: Mapping[str, object],
    *,
    seed_genres: set[str],
    artist_counts: Counter[str],
    album_counts: Counter[str],
    rng: random.Random,
) -> float:
    """Prioritize relevance, then reward variety and controlled randomness."""
    source_rank = int(candidate["source_rank"])
    artist_key = str(candidate["_artist_family_key"])
    album = str(candidate["_album_key"])
    candidate_genres = set(candidate["_genres"])

    score = max(0.0, 440.0 - (source_rank * 2.6))
    if artist_counts[artist_key] == 0:
        score += 65.0
    if album and album_counts[album] == 0:
        score += 45.0
    if seed_genres:
        score += 28.0 if candidate_genres.intersection(seed_genres) else 4.0

    # Enough jitter to make repeats feel alive, not enough to turn distant
    # recommendations into arbitrary picks.
    return score + rng.uniform(0.0, 42.0)


def select_diverse_candidates(
    candidates: Iterable[Mapping[str, object]],
    *,
    target: int = 12,
    seed_artist: str = "",
    seed_genre: str = "",
    avoid_files: Iterable[str] = (),
    avoid_tracks: Iterable[str] = (),
    include_seasonal: bool = False,
    random_seed: int | None = None,
) -> list[dict[str, object]]:
    """Return a relevant but varied, locally resolvable Vibe queue plan.

    The caller owns external discovery and any queue mutation. This function
    only decides which candidates are suitable for the first small Vibe list.
    """
    wanted = max(1, int(target or 12))
    prepared = _prepare_candidates(
        candidates,
        avoid_files={str(item or "").strip() for item in avoid_files if str(item or "").strip()},
        avoid_tracks={str(item or "").strip() for item in avoid_tracks if str(item or "").strip()},
        include_seasonal=include_seasonal,
    )
    if not prepared:
        return []

    seed_artist_key = artist_family_key(seed_artist)
    seed_genres = genre_tokens(seed_genre)
    rng = random.Random(random_seed)
    remaining = list(prepared)
    chosen: list[dict[str, object]] = []
    artist_counts: Counter[str] = Counter()
    album_counts: Counter[str] = Counter()
    recent_artists: deque[str] = deque(maxlen=3)

    while remaining and len(chosen) < wanted:
        selected = None
        selected_stage = 4
        for stage in range(5):
            eligible = [
                item for item in remaining
                if _is_eligible(
                    item,
                    stage=stage,
                    selected_count=len(chosen),
                    seed_artist_key=seed_artist_key,
                    artist_counts=artist_counts,
                    album_counts=album_counts,
                    recent_artists=recent_artists,
                )
            ]
            if eligible:
                selected = max(
                    eligible,
                    key=lambda item: _score(
                        item,
                        seed_genres=seed_genres,
                        artist_counts=artist_counts,
                        album_counts=album_counts,
                        rng=rng,
                    ),
                )
                selected_stage = stage
                break

        if selected is None:
            break

        remaining.remove(selected)
        artist_key = str(selected["_artist_family_key"])
        album = str(selected["_album_key"])
        artist_counts[artist_key] += 1
        if album:
            album_counts[album] += 1
        recent_artists.append(artist_key)

        public = {key: value for key, value in selected.items() if not key.startswith("_")}
        public["selection_stage"] = selected_stage
        chosen.append(public)

    return chosen
