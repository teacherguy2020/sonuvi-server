#!/usr/bin/env python3
import argparse
import json
import os
import random
import re
import subprocess
import time
import traceback
from datetime import datetime

import requests
from mpd import MPDClient, CommandError
from mutagen import File as MutagenFile
from vibe_planner import select_diverse_candidates

# Use HTTPS (more reliable than plain HTTP) + retries below
LASTFM_ROOT = "https://ws.audioscrobbler.com/2.0/"
LOG_PATH = os.environ.get("VIBE_LOG", "/home/moode/lastfm_vibe_radio.log")

PAREN_COPY_RE = re.compile(
    r"\s\(\d+\)\.(flac|mp3|m4a|mp4|ogg|oga|opus|wav|aiff|aif)$",
    re.IGNORECASE
)

TITLE_JUNK = [
    "album version", "single version", "radio edit", "edit",
    "remaster", "remastered", "live", "live album version",
    "mono", "stereo", "bonus track", "deluxe edition", "expanded edition",
]

# -----------------------------
# Seasonal / Christmas filter
# -----------------------------
XMAS_WORDS = (
    "christmas", "xmas", "noel", "nativity", "yuletide", "advent",
    "silent night", "jingle bell", "santa", "mistletoe",
    "winter wonderland", "white christmas", "let it snow",
    "have yourself a merry little christmas",
    "it's the most wonderful time of the year",
    "the christmas song", "christmas waltz",
)


def is_seasonal_text(*parts: str) -> bool:
    hay = " ".join([p for p in parts if p]).casefold()
    return any(w in hay for w in XMAS_WORDS)


def log_exc(prefix: str = "TRACEBACK"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        log_dir = os.path.dirname(LOG_PATH)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("\n" + "=" * 72 + "\n")
            f.write(f"{ts} {prefix}\n")
            f.write(traceback.format_exc())
    except Exception:
        pass
    print(f"{prefix}: crashed. See log: {LOG_PATH}", flush=True)


def first_str(value) -> str:
    if isinstance(value, list):
        for item in value:
            s = str(item or "").strip()
            if s:
                return s
        return ""
    return str(value or "").strip()


def norm(s: str) -> str:
    if not s:
        return ""
    s = s.casefold().strip()
    s = re.sub(r"\s*\(.*?\)\s*", " ", s)
    s = re.sub(r"\s*\[.*?\]\s*", " ", s)
    s = re.sub(r"\b(feat|ft)\.?\b.*$", "", s)
    for junk in TITLE_JUNK:
        s = s.replace(junk, " ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def track_key(artist: str, title: str) -> str:
    a = norm(artist)
    t = norm(title)
    return f"{a}|{t}" if a and t else ""


def album_key(album: str) -> str:
    return norm(album)


def genre_tokens(genre: str) -> set[str]:
    g = str(genre or "").strip()
    if not g:
      return set()
    parts = re.split(r"[;,|/]", g)
    out = set()
    for p in parts:
      n = norm(p)
      if n:
        out.add(n)
    return out


def path_score(p: str) -> tuple:
    p_l = (p or "").lower()
    return (1 if PAREN_COPY_RE.search(p_l) else 0, len(p_l))


def ensure_mpd_path(p: str) -> str:
    """Convert absolute /media/... or /var/lib/mpd/music/USB/... to MPD-visible USB/..."""
    if not p:
        return p
    if p.startswith("/media/"):
        return "USB/" + p[len("/media/"):]
    if p.startswith("/var/lib/mpd/music/USB/"):
        return "USB/" + p[len("/var/lib/mpd/music/USB/"):]
    return p


def mpd_to_abs(mpd_file: str) -> str:
    """
    Convert MPD-visible paths to a local filesystem path for Mutagen reads.

    On the API host (sonuvi.local), the library is typically mounted at:
      - /mnt/SamsungMoode/...
      - /mnt/OSDISK/...

    We try common mappings and fall back to the input.
    """
    f = (mpd_file or "").lstrip("/")

    # Already local
    if f.startswith("mnt/"):
        return "/" + f
    if f.startswith("/mnt/"):
        return f

    # Explicit roots your system uses elsewhere
    if f.startswith("USB/SamsungMoode/"):
        return "/mnt/SamsungMoode/" + f[len("USB/SamsungMoode/"):]
    if f.startswith("OSDISK/"):
        return "/mnt/OSDISK/" + f[len("OSDISK/"):]

    # Generic MPD "USB/..." fallback -> assume SamsungMoode mount
    if f.startswith("USB/"):
        return "/mnt/SamsungMoode/" + f[len("USB/"):]

    # Legacy moOde-ish /media mapping (only if your API host actually has /media mounted)
    if f.startswith("media/"):
        return "/" + f
    if f.startswith("/media/"):
        return f

    # As-is (Mutagen will just fail and you’ll get empty tags)
    return f


def mpd_connect(host: str, port: int) -> MPDClient:
    c = MPDClient()
    c.timeout = 10
    c.idletimeout = None
    c.connect(host, port)
    return c


def lastfm_get_similar(api_key: str, artist: str, title: str, limit: int):
    params = {
        "method": "track.getSimilar",
        "artist": artist,
        "track": title,
        "api_key": api_key,
        "format": "json",
        "limit": str(limit),
        "autocorrect": "1",
    }

    last_err = None
    for attempt in range(6):  # 6 tries total
        try:
            r = requests.get(
                LASTFM_ROOT,
                params=params,
                timeout=(5, 20),  # (connect timeout, read timeout)
                headers={"User-Agent": "moode-vibe/chain-2.0"}
            )
            data = r.json()

            if "error" not in data:
                tracks = data.get("similartracks", {}).get("track", [])
                if isinstance(tracks, dict):
                    tracks = [tracks]
                return tracks or []

            err = int(data.get("error") or 0)
            msg = data.get("message") or "Unknown error"

            # Last.fm transient
            if err == 8:
                wait = 1.5 * (attempt + 1)
                print(f"[lastfm] transient error 8 ('{msg}'), retrying in {wait:.1f}s...", flush=True)
                time.sleep(wait)
                continue

            raise RuntimeError(f"Last.fm error {err}: {msg}")

        except (
            requests.exceptions.ReadTimeout,
            requests.exceptions.ConnectTimeout,
            requests.exceptions.Timeout,
            requests.exceptions.ConnectionError,
        ) as e:
            last_err = e
            wait = 1.5 * (attempt + 1)
            print(f"[lastfm] network timeout/conn issue ({e.__class__.__name__}), retrying in {wait:.1f}s...", flush=True)
            time.sleep(wait)
            continue

    raise RuntimeError(f"Last.fm network kept failing after retries: {last_err}")


def pick_best(paths, used_files):
    for p in sorted(paths, key=path_score):
        mpd_file = ensure_mpd_path(p)
        if mpd_file not in used_files:
            return mpd_file
    return None


def fuzzy_within_artist(text_map: dict, rec_artist: str, rec_title: str):
    a = norm(rec_artist)
    t = norm(rec_title)
    if not a or not t:
        return None

    key = f"{a}|{t}"
    if key in text_map:
        return text_map[key]

    t_words = t.split()
    t_prefix = " ".join(t_words[:8]) if len(t_words) > 8 else t

    candidates = []
    prefix = a + "|"
    for k, paths in text_map.items():
        if not k.startswith(prefix):
            continue
        _, title_norm = k.split("|", 1)
        if title_norm == t or title_norm.startswith(t_prefix) or t.startswith(title_norm):
            candidates.extend(paths)

    return candidates or None


def find_seed_file(text_map: dict, artist: str, title: str):
    """Best-effort local-library lookup for seed track file path."""
    key = f"{norm(artist)}|{norm(title)}"
    paths = text_map.get(key)
    if paths:
        return sorted(paths, key=path_score)[0]

    paths = fuzzy_within_artist(text_map, artist, title)
    if paths:
        return sorted(paths, key=path_score)[0]

    return None


def read_tags(mpd_file: str):
    """
    Return (artist, title, album, genre).
    Empty strings if unavailable or unreadable.
    """
    if not mpd_file:
        return ("", "", "", "")

    # Candidate filesystem paths for this MPD file
    candidates = []

    f = mpd_file.lstrip("/")

    if f.startswith("USB/SamsungMoode/"):
        tail = f[len("USB/SamsungMoode/"):]
        candidates.extend([
            f"/mnt/SamsungMoode/{tail}",
            f"/media/SamsungMoode/{tail}",
        ])
    elif f.startswith("USB/"):
        tail = f[len("USB/"):]
        candidates.extend([
            f"/mnt/{tail}",
            f"/media/{tail}",
            f"/mnt/OSDISK/{tail}",
        ])
    else:
        candidates.append(f)

    for path in candidates:
        try:
            mf = MutagenFile(path, easy=True)
            if not mf or not mf.tags:
                continue

            artist = str(mf.tags.get("artist", [""])[0])
            title  = str(mf.tags.get("title", [""])[0])
            album  = str(mf.tags.get("album", [""])[0])
            genre  = str(mf.tags.get("genre", [""])[0])

            return (artist, title, album, genre)
        except Exception:
            continue

    # Nothing worked
    return ("", "", "", "")


def read_indexed_tags(file_meta: dict, mpd_file: str):
    """Use the MPD-built metadata index before falling back to Mutagen I/O."""
    record = file_meta.get(mpd_file) or file_meta.get(ensure_mpd_path(mpd_file))
    if isinstance(record, dict):
        artist = first_str(record.get("artist"))
        title = first_str(record.get("title"))
        album = first_str(record.get("album"))
        genre = first_str(record.get("genre"))
        if artist or title or album or genre:
            return (artist, title, album, genre)
    return read_tags(mpd_file)


def recommendation_fields(recommendation):
    rec_title = str(recommendation.get("name") or "").strip()
    rec_artist_raw = recommendation.get("artist", {})
    if isinstance(rec_artist_raw, dict):
        rec_artist = str(rec_artist_raw.get("name") or "").strip()
    else:
        rec_artist = str(rec_artist_raw or "").strip()
    rec_mbid = str(recommendation.get("mbid") or "").strip().lower()
    return rec_artist, rec_title, rec_mbid


def resolve_local_candidate(recommendation, *, mbid_map, text_map, used_files, file_meta, source_rank):
    """Resolve one Last.fm recommendation to its best local-library file."""
    rec_artist, rec_title, rec_mbid = recommendation_fields(recommendation)
    if not rec_artist or not rec_title:
        return None

    candidate = None
    method = ""
    if rec_mbid and rec_mbid in mbid_map:
        candidate = pick_best(mbid_map[rec_mbid], used_files)
        if candidate:
            method = "mbid"
    if not candidate:
        paths = text_map.get(f"{norm(rec_artist)}|{norm(rec_title)}")
        if paths:
            candidate = pick_best(paths, used_files)
            if candidate:
                method = "text"
    if not candidate:
        paths = fuzzy_within_artist(text_map, rec_artist, rec_title)
        if paths:
            candidate = pick_best(paths, used_files)
            if candidate:
                method = "fuzzy"
    if not candidate:
        return None

    artist, title, album, genre = read_indexed_tags(file_meta, candidate)
    return {
        "file": candidate,
        "artist": artist or rec_artist,
        "title": title or rec_title,
        "album": album,
        "genre": genre,
        "method": method,
        "rec_artist": rec_artist,
        "rec_title": rec_title,
        "source_rank": source_rank,
    }


def build_v2_plan(mpd, args, *, mbid_map, text_map, file_meta, seed_artist, seed_title, seed_genre):
    """Build a small, diverse local queue before making any MPD mutation."""
    used_files = set()
    try:
        for item in mpd.playlistinfo():
            file_name = str(item.get("file") or "").strip()
            if file_name:
                used_files.add(file_name)
    except Exception:
        pass

    used_tracks = {track_key(seed_artist, seed_title)}
    used_tracks.discard("")
    include_xmas = bool(args.include_christmas) and not bool(args.exclude_christmas)
    configured_target = max(1, int(args.target_queue or 12))
    # A cropped queue retains the currently playing seed. Plan only the
    # remaining slots so --target-queue means the final queue size, not
    # "seed plus N new tracks".
    retained_current = 1 if args.crop and not args.append else 0
    target = max(1, configured_target - retained_current)
    max_expansions = max(0, min(3, int(args.planner_max_expansions or 0)))
    started = time.time()
    all_candidates = []
    visited_seeds = set()
    pending_seeds = [(seed_artist, seed_title)]
    pass_number = 0
    plan = []

    def same_artist_family(left, right):
        """Avoid recursively querying a cosmetic variant of the same artist."""
        left_key = norm(left)
        right_key = norm(right)
        return bool(
            left_key and right_key
            and (left_key == right_key or left_key.startswith(f"{right_key} ") or right_key.startswith(f"{left_key} "))
        )

    def select_plan():
        return select_diverse_candidates(
            all_candidates,
            target=target,
            seed_artist=seed_artist,
            seed_genre=seed_genre,
            avoid_files=used_files,
            avoid_tracks=used_tracks,
            include_seasonal=include_xmas,
        )

    while pending_seeds and pass_number <= max_expansions:
        if args.max_seconds > 0 and (time.time() - started) >= args.max_seconds:
            print(f"[v2] Time budget reached ({args.max_seconds}s), finishing available plan.", flush=True)
            break

        query_artist, query_title = pending_seeds.pop(0)
        query_key = track_key(query_artist, query_title)
        if not query_key or query_key in visited_seeds:
            continue
        visited_seeds.add(query_key)
        pass_number += 1

        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] Last.fm get similar "
            f"{query_artist} - {query_title} limit {args.similar_limit} (v2 pass {pass_number})",
            flush=True,
        )
        similar = lastfm_get_similar(args.api_key, query_artist, query_title, args.similar_limit)
        pass_candidates = []
        for rank, recommendation in enumerate(similar, start=1):
            candidate = resolve_local_candidate(
                recommendation,
                mbid_map=mbid_map,
                text_map=text_map,
                used_files=used_files,
                file_meta=file_meta,
                source_rank=((pass_number - 1) * max(1, args.similar_limit)) + rank,
            )
            if candidate:
                all_candidates.append(candidate)
                pass_candidates.append(candidate)
        print(
            f"[v2] pass {pass_number}: {len(similar)} Last.fm candidates, "
            f"{len(pass_candidates)} new local matches, {len(all_candidates)} total local matches",
            flush=True,
        )
        plan = select_plan()
        strict_variety_met = len(plan) >= target and all(int(item.get("selection_stage", 4)) == 0 for item in plan)
        if strict_variety_met:
            print(f"[v2] pass {pass_number}: strict variety target reached.", flush=True)
            break
        if pass_number > max_expansions:
            break

        expansion_seed = next(
            (
                (str(item.get("artist") or ""), str(item.get("title") or ""))
                for item in pass_candidates
                if track_key(str(item.get("artist") or ""), str(item.get("title") or "")) not in visited_seeds
                and not same_artist_family(str(item.get("artist") or ""), seed_artist)
                and not same_artist_family(str(item.get("artist") or ""), query_artist)
            ),
            None,
        )
        if not expansion_seed:
            break
        pending_seeds.append(expansion_seed)

    print(
        f"[v2] selected {len(plan)}/{target} tracks from {len(all_candidates)} local matches across {pass_number} pass(es)",
        flush=True,
    )
    return plan, pass_number


def apply_v2_plan(mpd, args, tracks, *, was_playing):
    """Apply a completed plan only after selection succeeded."""
    if args.dry_run:
        return list(tracks)

    if not tracks:
        print("[v2] No planned tracks; MPD queue left unchanged.", flush=True)
        return []

    if not args.append:
        if args.crop:
            subprocess.run(["mpc", "-h", args.host, "-p", str(args.port), "crop"], check=False)
        else:
            mpd.clear()
        # Keep the freshly planned order audible; random mode otherwise
        # defeats the planner's intentional early-track variety.
        subprocess.run(["mpc", "-h", args.host, "-p", str(args.port), "random", "off"], check=False)

    added = []
    for item in tracks:
        file_name = str(item.get("file") or "").strip()
        if not file_name:
            continue
        try:
            mpd.add(file_name)
            added.append(item)
            print(f"[v2] Added: {item.get('title', '')} — {item.get('artist', '')}", flush=True)
        except CommandError as error:
            print(f"[v2] SKIP (MPD can't add): {file_name} ({error})", flush=True)

    if args.mode == "play" and added:
        try:
            mpd.play()
        except Exception:
            pass
    elif args.mode == "load" and not args.no_final_stop:
        try:
            mpd.stop()
        except Exception:
            pass
    elif args.endless and was_playing:
        try:
            if str(mpd.status().get("state", "")).lower() != "play":
                mpd.play()
        except Exception:
            pass

    return added


def main():
    ap = argparse.ArgumentParser(description="Build a chained Last.fm-based queue in moOde/MPD.")
    ap.add_argument("--api-key", default=os.environ.get("LASTFM_API_KEY", ""))
    ap.add_argument("--index", default="/home/moode/moode_library_index.json")
    ap.add_argument("--host", default="moode.local")
    ap.add_argument("--port", type=int, default=6600)

    ap.add_argument("--similar-limit", type=int, default=150)
    ap.add_argument("--target-queue", type=int, default=50)
    ap.add_argument("--sleep", type=float, default=0.0)
    ap.add_argument("--crop", action="store_true")

    ap.add_argument("--max-misses", type=int, default=10)
    ap.add_argument("--reseed-window", type=int, default=12)
    ap.add_argument("--reseed-random", action="store_true")

    ap.add_argument("--include-christmas", action="store_true",
                    help="Allow Christmas/holiday tracks in the queue")
    ap.add_argument("--exclude-christmas", action="store_true",
                    help="Force-exclude Christmas/holiday tracks (overrides include)")

    ap.add_argument("--shuffle-top", type=int, default=10,
                    help="Randomize candidate order within the top N Last.fm similar results (0 disables)")

    # Orchestration options
    ap.add_argument("--seed-artist", default="", help="Seed artist override")
    ap.add_argument("--seed-title", default="", help="Seed title override")
    ap.add_argument("--mode", choices=["load", "play"], default="load",
                    help="load: build queue and stop, play: build queue and start playback")
    ap.add_argument("--append", action="store_true",
                    help="Append to existing queue instead of replacing")
    ap.add_argument("--max-seconds", type=int, default=0,
                    help="Time budget for build; 0 disables")
    ap.add_argument("--json-out", default="",
                    help="Optional JSON output path")
    ap.add_argument("--debug-trace", action="store_true",
                    help="Emit detailed matching diagnostics for each hop")
    ap.add_argument("--simple-seed-pass", action="store_true",
                    help="One-pass mode: query seed once and add local matches up to target, then stop")
    ap.add_argument("--planner-v2", action="store_true",
                    help="Plan a small, diverse local queue before changing MPD")
    ap.add_argument("--planner-max-expansions", type=int, default=2,
                    help="Additional Last.fm seed expansions for planner v2 (0-3)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Preview tracks without touching MPD")
    ap.add_argument("--no-final-stop", action="store_true",
                    help="When mode=load, do not send a final stop command")
    ap.add_argument("--endless", action="store_true",
                    help="Keep the current seed queued and allow resilient fallback matching")

    args = ap.parse_args()

    if not args.api_key:
        raise SystemExit("ERROR: Provide Last.fm API key via --api-key or env LASTFM_API_KEY")

    env_inc = os.getenv("INCLUDE_CHRISTMAS", "").strip().lower()
    include_xmas = env_inc in ("1", "true", "yes", "y", "on")
    if args.include_christmas:
        include_xmas = True
    if args.exclude_christmas:
        include_xmas = False

    print(f"[{datetime.now().strftime('%H:%M:%S')}] load index {args.index}", flush=True)
    try:
        with open(args.index, "r", encoding="utf-8") as f:
            idx = json.load(f)
        mbid_map = idx.get("mbid_map", {})
        text_map = idx.get("text_map", {})
        file_meta = idx.get("file_meta", {})
        print(f"[{datetime.now().strftime('%H:%M:%S')}] index OK: {sum(len(paths) for paths in text_map.values())} text tracks")
    except Exception as e:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] WARNING index load failed ({args.index}): {e}. Empty library.", flush=True)
        mbid_map = {}
        text_map = {}
        file_meta = {}

    # NOTE: even for preview we still connect to MPD to read current song / playlistinfo.
    print(f"[{datetime.now().strftime('%H:%M:%S')}] STEP: mpd connect {args.host}:{args.port}", flush=True)
    mpd = mpd_connect(args.host, args.port)

    def queue_len() -> int:
        try:
            return int(mpd.status().get("playlistlength", "0"))
        except Exception:
            return 0

    # Track output for UI/API
    out_tracks = []

    # -----------------------------
    # Seed resolution
    # -----------------------------
    seed_artist = (args.seed_artist or "").strip()
    seed_title = (args.seed_title or "").strip()
    original_seed = (seed_artist, seed_title)

    if (seed_artist and not seed_title) or (seed_title and not seed_artist):
        mpd.disconnect()
        print("ERROR: Provide both --seed-artist and --seed-title (or neither).")
        return

    cur = mpd.currentsong()
    was_playing = False
    try:
        was_playing = str(mpd.status().get("state", "")).strip().lower() == "play"
    except Exception:
        pass
    if not seed_artist and not seed_title:
        if not cur:
            mpd.disconnect()
            print("Nothing playing and no explicit seed provided.")
            return
        seed_artist = (cur.get("artist") or "").strip()
        seed_title = (cur.get("title") or "").strip()
        if not seed_artist or not seed_title:
            mpd.disconnect()
            print("Current track missing artist/title.")
            return

    # last album guard (avoid immediate same-album picks)
    last_album_k = ""
    last_genre_n = ""
    seed_genre = ""
    seed_genres = set()
    if cur:
        cur_a = first_str(cur.get("artist"))
        cur_t = first_str(cur.get("title"))
        if norm(cur_a) == norm(seed_artist) and norm(cur_t) == norm(seed_title):
            last_album_k = album_key(first_str(cur.get("album")))
            cur_genre = first_str(cur.get("genre"))
            last_genre_n = norm(cur_genre)
            seed_genre = cur_genre
            seed_genres = genre_tokens(cur_genre)

    # If explicit seed wasn't current song, try local lookup to set album context
    if not last_album_k or not last_genre_n:
        seed_file = find_seed_file(text_map, seed_artist, seed_title)
        if seed_file:
            a0, t0, alb0, g0 = read_tags(seed_file)
            if not last_album_k and alb0:
                last_album_k = album_key(alb0)
            if not last_genre_n and g0:
                last_genre_n = norm(g0)
            if not seed_genre and g0:
                seed_genre = g0
            if not seed_genres and g0:
                seed_genres = genre_tokens(g0)

    # Keep stable fallback seed to break dead-ends.
    original_seed = (seed_artist, seed_title)

    if args.planner_v2:
        plan, discovery_passes = build_v2_plan(
            mpd,
            args,
            mbid_map=mbid_map,
            text_map=text_map,
            file_meta=file_meta,
            seed_artist=seed_artist,
            seed_title=seed_title,
            seed_genre=seed_genre,
        )
        applied_tracks = apply_v2_plan(mpd, args, plan, was_playing=was_playing)
        final_state = "unknown"
        try:
            final_state = mpd.status().get("state", "unknown")
        except Exception:
            pass
        if args.dry_run:
            final_queue = len(plan) + (1 if args.crop and not args.append else 0)
        else:
            final_queue = queue_len()
        summary = {
            "seed_artist": original_seed[0],
            "seed_title": original_seed[1],
            "target_queue": args.target_queue,
            "final_queue": final_queue,
            "mode": args.mode,
            "state": final_state,
            "append": bool(args.append),
            "include_christmas": bool(include_xmas),
            "dry_run": bool(args.dry_run),
            "crop": bool(args.crop),
            "planner": "v2",
            "discovery_passes": discovery_passes,
            "tracks": plan if args.dry_run else applied_tracks,
        }
        if args.json_out:
            try:
                with open(args.json_out, "w", encoding="utf-8") as f:
                    json.dump(summary, f, indent=2)
            except Exception:
                print(f"WARN: failed writing json output to {args.json_out}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] final queue {final_queue}", flush=True)
        mpd.disconnect()
        print(f"Done. Final queue length: {final_queue} | mode={args.mode} | state={final_state} | dry_run={args.dry_run}")
        return

    def resume_endless_playback():
        """Keep an active Endless Vibe session playing through queue extension."""
        if not args.endless or not was_playing or args.dry_run:
            return
        try:
            if str(mpd.status().get("state", "")).strip().lower() != "play":
                mpd.play()
                print("[endless] resumed playback after queue extension", flush=True)
        except Exception:
            pass

    # -----------------------------
    # Queue handling (ONLY when not dry-run)
    # -----------------------------
    if not args.dry_run and not args.append:
        # Prefer crop (keep now playing) if requested, else clear.
        if args.crop:
            subprocess.run(["mpc", "-h", args.host, "-p", str(args.port), "crop"], check=False)
            resume_endless_playback()
        else:
            try:
                mpd.clear()
            except Exception:
                pass

    used_files = set()
    try:
        for item in mpd.playlistinfo():
            if "file" in item:
                used_files.add((item["file"] or "").strip())
    except Exception:
        pass

    used_tracks = set()
    k0 = track_key(seed_artist, seed_title)
    if k0:
        used_tracks.add(k0)

    added_seed_history = []
    reseed_cursor = 0

    album_cache = {}
    bad_files = set()
    last_added_artist_n = ""
    last_added_genres = set(seed_genres) if seed_genres else (set([last_genre_n]) if last_genre_n else set())
    recent_album_keys = [last_album_k] if last_album_k else []
    album_rotate_window = 3

    print(f"Seed: {seed_title} — {seed_artist}")
    print(f"Starting queue length: {queue_len()}  (target {args.target_queue})")
    print(f"Mode: {args.mode}  | Append: {'yes' if args.append else 'no'}")
    print(f"Dry-run: {'YES' if args.dry_run else 'no'}")
    print(f"Christmas/holiday: {'ALLOWED' if include_xmas else 'EXCLUDED'}")
    if args.shuffle_top and args.shuffle_top > 0:
        print(f"Candidate shuffle: top {args.shuffle_top} randomized")
    if args.max_seconds > 0:
        print(f"Time budget: {args.max_seconds}s")

    hops = 0
    misses = 0
    started = time.time()

    # IMPORTANT: in dry-run, we do NOT rely on live MPD queue_len() because we are not modifying it.
    # We instead build up out_tracks to args.target_queue.
    def have_enough() -> bool:
        if args.dry_run:
            return len(out_tracks) >= args.target_queue
        return queue_len() >= args.target_queue

    if args.simple_seed_pass:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] SIMPLE mode: batched seed queries (10 per pass)", flush=True)
        simple_batch = 10
        simple_pass = 0

        while not have_enough():
            simple_pass += 1
            batch_added = 0
            pass_seed_artist, pass_seed_title = seed_artist, seed_title

            print(f"[{datetime.now().strftime('%H:%M:%S')}] SIMPLE pass {simple_pass}: seed {pass_seed_title} — {pass_seed_artist}", flush=True)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Last.fm get similar {pass_seed_artist} - {pass_seed_title} limit {args.similar_limit}", flush=True)
            sim = lastfm_get_similar(args.api_key, pass_seed_artist, pass_seed_title, args.similar_limit)
            if args.shuffle_top and args.shuffle_top > 0 and sim:
                n = min(args.shuffle_top, len(sim))
                head = sim[:n]
                tail = sim[n:]
                random.shuffle(head)
                sim = head + tail

            for t in sim:
                if have_enough() or batch_added >= simple_batch:
                    break

                rec_title = (t.get("name") or "").strip()
                rec_artist = t.get("artist", {})
                if isinstance(rec_artist, dict):
                    rec_artist = (rec_artist.get("name") or "").strip()
                else:
                    rec_artist = str(rec_artist).strip()
                rec_mbid = (t.get("mbid") or "").strip().lower()
                if not rec_title or not rec_artist:
                    continue

                cand = None
                method = ""
                if rec_mbid and rec_mbid in mbid_map:
                    cand = pick_best(mbid_map[rec_mbid], used_files)
                    if cand:
                        method = "mbid"
                if not cand:
                    key = f"{norm(rec_artist)}|{norm(rec_title)}"
                    paths = text_map.get(key)
                    if paths:
                        cand = pick_best(paths, used_files)
                        if cand:
                            method = "text"
                if not cand:
                    paths = fuzzy_within_artist(text_map, rec_artist, rec_title)
                    if paths:
                        cand = pick_best(paths, used_files)
                        if cand:
                            method = "fuzzy"
                if not cand:
                    continue
                if cand in bad_files or cand in used_files:
                    continue

                a2, t2, alb2, g2 = read_tags(cand)
                out_tracks.append({
                    "file": cand,
                    "artist": a2 or rec_artist,
                    "title": t2 or rec_title,
                    "album": alb2 or "",
                    "genre": g2 or "",
                    "method": method,
                    "rec_artist": rec_artist,
                    "rec_title": rec_title,
                })
                if not args.dry_run:
                    try:
                        mpd.add(cand)
                    except Exception:
                        bad_files.add(cand)
                        continue
                used_files.add(cand)
                kx = track_key(rec_artist, rec_title)
                if kx:
                    used_tracks.add(kx)

                # Use the most recently added track as rolling seed, and especially the 10th in each pass.
                seed_artist = a2 or rec_artist
                seed_title = t2 or rec_title
                batch_added += 1
                print(f"[simple] Added: {rec_title} — {rec_artist} ({method})")

            print(f"[simple] pass {simple_pass} added {batch_added} track(s)")
            if batch_added <= 0:
                print(f"[simple] no additions in pass {simple_pass}; stopping to avoid loop")
                break

    while not args.simple_seed_pass and not have_enough():
        if args.max_seconds > 0 and (time.time() - started) >= args.max_seconds:
            print(f"Time budget reached ({args.max_seconds}s), stopping.")
            break

        hops += 1

        print(f"[{datetime.now().strftime('%H:%M:%S')}] Last.fm get similar {seed_artist} - {seed_title} limit {args.similar_limit}", flush=True)
        sim = lastfm_get_similar(args.api_key, seed_artist, seed_title, args.similar_limit)

        if args.shuffle_top and args.shuffle_top > 0 and sim:
            n = min(args.shuffle_top, len(sim))
            head = sim[:n]
            tail = sim[n:]
            random.shuffle(head)
            sim = head + tail

        chosen_file = None
        chosen_label = ""
        chosen_method = ""
        chosen_rec_artist = ""
        chosen_rec_title = ""
        chosen_album_k = ""
        fallback_repeat = None
        fallback_seed_artist = None
        fallback_recent_album = None
        fallback_same_album = None
        fallback_cross_genre = None
        fallback_seed_genre = None

        print(f"[{datetime.now().strftime('%H:%M:%S')}] pick from {len(sim)} similar", flush=True)
        if args.debug_trace:
            sample = []
            for tt in sim[:12]:
                s_title = str((tt.get("name") or "")).strip()
                s_artist_raw = tt.get("artist", {})
                s_artist = str((s_artist_raw.get("name") if isinstance(s_artist_raw, dict) else s_artist_raw) or "").strip()
                s_mbid = str(tt.get("mbid") or "").strip()
                sample.append({"artist": s_artist, "title": s_title, "mbid": s_mbid})
            print(f"[hop {hops}] similar sample: {json.dumps(sample, ensure_ascii=False)}", flush=True)

        reject = {
            "blank": 0,
            "seasonal_rec": 0,
            "already_used_track": 0,
            "no_local_match": 0,
            "bad_file": 0,
            "seasonal_local": 0,
            "same_album": 0,
            "recent_album": 0,
            "seed_genre_disjoint": 0,
            "cross_genre_disjoint": 0,
            "seed_artist_guard": 0,
            "repeat_artist_guard": 0,
        }
        match_method_counts = {"mbid": 0, "text": 0, "fuzzy": 0}

        for t in sim:
            rec_title = (t.get("name") or "").strip()
            rec_artist = t.get("artist", {})
            if isinstance(rec_artist, dict):
                rec_artist = (rec_artist.get("name") or "").strip()
            else:
                rec_artist = str(rec_artist).strip()
            rec_mbid = (t.get("mbid") or "").strip().lower()

            if not rec_title or not rec_artist:
                reject["blank"] += 1
                continue

            # Strong seasonal filter at recommendation level
            if not include_xmas and is_seasonal_text(rec_title, rec_artist):
                reject["seasonal_rec"] += 1
                continue

            rk = track_key(rec_artist, rec_title)
            if rk and rk in used_tracks:
                reject["already_used_track"] += 1
                continue

            cand = None
            method = ""

            # 1) MBID map
            if rec_mbid and rec_mbid in mbid_map:
                cand = pick_best(mbid_map[rec_mbid], used_files)
                if cand:
                    method = "mbid"
                    match_method_counts["mbid"] += 1

            # 2) exact text map
            if not cand:
                key = f"{norm(rec_artist)}|{norm(rec_title)}"
                paths = text_map.get(key)
                if paths:
                    cand = pick_best(paths, used_files)
                    if cand:
                        method = "text"
                        match_method_counts["text"] += 1

            # 3) fuzzy within artist
            if not cand:
                paths = fuzzy_within_artist(text_map, rec_artist, rec_title)
                if paths:
                    cand = pick_best(paths, used_files)
                    if cand:
                        method = "fuzzy"
                        match_method_counts["fuzzy"] += 1

            if not cand:
                reject["no_local_match"] += 1
                continue

            if cand in bad_files:
                reject["bad_file"] += 1
                continue

            # Strong seasonal filter at local file/tag level
            a_tag, t_tag, alb_tag, g_tag = read_tags(cand)
            if not include_xmas:
                if is_seasonal_text(cand):
                    reject["seasonal_local"] += 1
                    continue
                if is_seasonal_text(t_tag, alb_tag, a_tag, g_tag):
                    reject["seasonal_local"] += 1
                    continue

            # same-album guard
            if cand not in album_cache:
                album_cache[cand] = album_key(alb_tag)
            cand_album_k = album_cache.get(cand, "")

            if last_album_k and cand_album_k and cand_album_k == last_album_k:
                if fallback_same_album is None:
                    fallback_same_album = (cand, method, rec_title, rec_artist, cand_album_k)
                reject["same_album"] += 1
                continue

            if cand_album_k and cand_album_k in recent_album_keys:
                if fallback_recent_album is None:
                    fallback_recent_album = (cand, method, rec_title, rec_artist, cand_album_k)
                reject["recent_album"] += 1
                continue

            cand_genres = genre_tokens(g_tag)
            if seed_genres and cand_genres and seed_genres.isdisjoint(cand_genres):
                if fallback_seed_genre is None:
                    fallback_seed_genre = (cand, method, rec_title, rec_artist, cand_album_k)
                reject["seed_genre_disjoint"] += 1
                continue

            if last_added_genres and cand_genres and last_added_genres.isdisjoint(cand_genres):
                if fallback_cross_genre is None:
                    fallback_cross_genre = (cand, method, rec_title, rec_artist, cand_album_k)
                reject["cross_genre_disjoint"] += 1
                continue

            cand_artist_n = norm(a_tag or rec_artist)

            # Strong preference on first added hop: branch to a different artist than the seed.
            if hops == 1 and cand_artist_n and cand_artist_n == norm(seed_artist):
                if fallback_seed_artist is None:
                    fallback_seed_artist = (cand, method, rec_title, rec_artist, cand_album_k)
                reject["seed_artist_guard"] += 1
                continue

            if last_added_artist_n and cand_artist_n and cand_artist_n == last_added_artist_n:
                # Soft guard: avoid back-to-back same artist when possible.
                if fallback_repeat is None:
                    fallback_repeat = (cand, method, rec_title, rec_artist, cand_album_k)
                reject["repeat_artist_guard"] += 1
                continue

            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k
            break

        if not chosen_file and fallback_repeat is not None:
            cand, method, rec_title, rec_artist, cand_album_k = fallback_repeat
            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k

        if not chosen_file and fallback_recent_album is not None:
            cand, method, rec_title, rec_artist, cand_album_k = fallback_recent_album
            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k

        if not chosen_file and fallback_same_album is not None:
            cand, method, rec_title, rec_artist, cand_album_k = fallback_same_album
            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k

        if not chosen_file and fallback_seed_genre is not None:
            cand, method, rec_title, rec_artist, cand_album_k = fallback_seed_genre
            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k

        if not chosen_file and fallback_cross_genre is not None:
            cand, method, rec_title, rec_artist, cand_album_k = fallback_cross_genre
            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k

        # Normal Vibe prefers a cross-artist first hop. Endless Vibe must keep
        # moving when Last.fm has sparse/obscure metadata, so accept a local
        # same-artist fallback rather than declaring the queue exhausted.
        if args.endless and not chosen_file and fallback_seed_artist is not None:
            cand, method, rec_title, rec_artist, cand_album_k = fallback_seed_artist
            chosen_file = cand
            chosen_method = method
            chosen_label = f"{rec_title} — {rec_artist}"
            chosen_rec_artist = rec_artist
            chosen_rec_title = rec_title
            chosen_album_k = cand_album_k

        # In normal mode, do not fall back to same-artist on hop 1.
        # If no cross-artist candidate can be added, treat as miss and reseed.

        if args.debug_trace:
            print(f"[hop {hops}] match summary: methods={json.dumps(match_method_counts)} rejects={json.dumps(reject)} chosen={'yes' if chosen_file else 'no'}", flush=True)

        if not chosen_file:
            misses += 1
            if hops == 1 and fallback_seed_artist is not None:
                print(f"[hop {hops}] No cross-artist add from seed; forcing reseed path.")

            if added_seed_history:
                window = added_seed_history[-args.reseed_window:] if args.reseed_window > 0 else added_seed_history[:]
                window = [s for s in window if s != (seed_artist, seed_title)]
                if not include_xmas:
                    window = [s for s in window if not is_seasonal_text(s[1], s[0])]

                if not window:
                    if original_seed and original_seed != (seed_artist, seed_title):
                        seed_artist, seed_title = original_seed
                        print(f"[hop {hops}] No add (miss {misses}/{args.max_misses}). Reseed -> original {seed_title} — {seed_artist}")
                    else:
                        print(f"[hop {hops}] No add (miss {misses}/{args.max_misses}). No alternate reseed candidates.")
                else:
                    if args.reseed_random:
                        new_seed = random.choice(window)
                    else:
                        idx_back = min(reseed_cursor, len(window) - 1)
                        new_seed = window[-1 - idx_back]
                        reseed_cursor += 1
                        if reseed_cursor >= len(window):
                            reseed_cursor = 0

                    seed_artist, seed_title = new_seed
                    print(f"[hop {hops}] No add (miss {misses}/{args.max_misses}). Reseed -> {seed_title} — {seed_artist}")
            else:
                print(f"[hop {hops}] No add (miss {misses}/{args.max_misses}). No reseed candidates yet.")

            if misses >= args.max_misses:
                break
            continue

        # Record for UI/API (always)
        a2, t2, alb2, g2 = read_tags(chosen_file)
        out_tracks.append({
            "file": chosen_file,
            "artist": a2 or chosen_rec_artist,
            "title": t2 or chosen_rec_title,
            "album": alb2 or "",
            "genre": g2 or "",
            "method": chosen_method,
            "rec_artist": chosen_rec_artist,
            "rec_title": chosen_rec_title,
        })

        # Actually add to MPD only when not dry-run
        if not args.dry_run:
            try:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] added {chosen_label} ({chosen_method}) file {chosen_file}", flush=True)
                mpd.add(chosen_file)
                resume_endless_playback()
            except CommandError as e:
                msg = str(e)
                if "No such directory" in msg or "Not found" in msg:
                    bad_files.add(chosen_file)
                    print(f"[hop {hops}] SKIP (MPD can't add): {chosen_label} -> {chosen_file} ({msg})")
                    misses += 1
                    if misses >= args.max_misses:
                        break
                    continue
                raise
            print(f"[{datetime.now().strftime('%H:%M:%S')}] queue len {queue_len()}", flush=True)

        used_files.add(chosen_file)
        misses = 0
        reseed_cursor = 0

        # Next hop seed from actual local tags when possible
        if a2 and t2:
            seed_artist, seed_title = a2, t2
        else:
            seed_artist, seed_title = chosen_rec_artist, chosen_rec_title

        if chosen_album_k:
            last_album_k = chosen_album_k
        elif alb2:
            last_album_k = album_key(alb2)

        if last_album_k:
            recent_album_keys = [k for k in ([last_album_k] + recent_album_keys) if k]
            dedup = []
            seen = set()
            for k in recent_album_keys:
                if k in seen:
                    continue
                seen.add(k)
                dedup.append(k)
            recent_album_keys = dedup[:album_rotate_window]

        last_added_artist_n = norm(a2 or chosen_rec_artist)
        if g2:
            gs = genre_tokens(g2)
            if gs:
                last_added_genres = gs

        k2 = track_key(seed_artist, seed_title)
        if k2:
            used_tracks.add(k2)

        added_seed_history.append((seed_artist, seed_title))

        print(f"[hop {hops}] Added: {chosen_label} ({chosen_method})")
        if not args.dry_run:
            print(f"Queue length now: {queue_len()}")

        if args.sleep > 0:
            time.sleep(args.sleep)

    # Final state (do not stop/play in dry-run)
    final_state = "unknown"
    try:
        final_state = mpd.status().get("state", "unknown")
    except Exception:
        pass

    final_len = queue_len()
    if args.dry_run:
        final_len = len(out_tracks)

    if not args.dry_run:
        if args.mode == "play":
            try:
                mpd.play()
            except Exception:
                pass
        elif not args.no_final_stop:
            try:
                mpd.stop()
            except Exception:
                pass
        else:
            resume_endless_playback()

    summary = {
        "seed_artist": seed_artist,
        "seed_title": seed_title,
        "target_queue": args.target_queue,
        "final_queue": final_len,
        "mode": args.mode,
        "state": final_state,
        "append": bool(args.append),
        "include_christmas": bool(include_xmas),
        "hops": hops,
        "max_misses": args.max_misses,
        "shuffle_top": args.shuffle_top,
        "dry_run": bool(args.dry_run),
        "crop": bool(args.crop),
        "tracks": out_tracks,
    }

    if args.json_out:
        try:
            with open(args.json_out, "w", encoding="utf-8") as f:
                json.dump(summary, f, indent=2)
        except Exception:
            print(f"WARN: failed writing json output to {args.json_out}")

    print(f"[{datetime.now().strftime('%H:%M:%S')}] final queue {final_len}", flush=True)
    mpd.disconnect()
    print(f"Done. Final queue length: {final_len} | mode={args.mode} | state={final_state} | dry_run={args.dry_run}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log_exc("TRACEBACK")
        raise SystemExit(1)
