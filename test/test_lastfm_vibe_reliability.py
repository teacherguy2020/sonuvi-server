import sys
import types
import unittest
import json
import tempfile
from types import SimpleNamespace

mpd = types.ModuleType("mpd")
mpd.MPDClient = object
mpd.CommandError = Exception
sys.modules.setdefault("mpd", mpd)
mutagen = types.ModuleType("mutagen")
mutagen.File = lambda *args, **kwargs: None
sys.modules.setdefault("mutagen", mutagen)
requests = types.ModuleType("requests")
class NetworkError(Exception): pass
requests.exceptions = types.SimpleNamespace(ReadTimeout=NetworkError, ConnectTimeout=NetworkError, Timeout=NetworkError, ConnectionError=NetworkError)
requests.get = lambda *_args, **_kwargs: None
sys.modules.setdefault("requests", requests)

import lastfm_vibe_radio as vibe
from lastfm_vibe_radio import VibeFailure, lastfm_get_similar

class Clock:
    def __init__(self): self.value = 0.0; self.sleeps = []
    def now(self): return self.value
    def sleep(self, value): self.sleeps.append(value); self.value += value

class Response:
    def __init__(self, status=200, data=None, headers=None, json_error=None):
        self.status_code, self._data, self.headers, self.json_error = status, data, headers or {}, json_error
    def json(self):
        if self.json_error: raise self.json_error
        return self._data

class LastfmReliabilityTests(unittest.TestCase):
    def call(self, responses, deadline=30):
        clock = Clock(); calls = []
        def request(*_args, **_kwargs):
            calls.append(1); value = responses.pop(0)
            if isinstance(value, Exception): raise value
            return value
        return clock, calls, lambda: lastfm_get_similar("not-a-real-key", "seed", "track", 10, deadline=deadline, request_get=request, clock=clock.now, sleeper=clock.sleep)
    def test_malformed_json_recovers_and_preserves_valid_empty(self):
        clock, calls, run = self.call([Response(json_error=ValueError("bad")), Response(data={"similartracks": {"track": []}})])
        self.assertEqual(run(), []); self.assertEqual(len(calls), 2); self.assertEqual(clock.sleeps, [0.5])
    def test_schema_and_bad_rows_retry_then_return_valid_rows(self):
        row = {"name": "ok", "artist": {"name": "artist"}}
        clock, calls, run = self.call([Response(data=[]), Response(data={"similartracks": {"track": [None, row]}})])
        self.assertEqual(run(), [{"name": "ok", "artist": {"name": "artist"}, "mbid": ""}]); self.assertEqual(len(calls), 2); self.assertEqual(clock.sleeps, [0.5])
    def test_transient_exhaustion_and_permanent_no_retry(self):
        clock, calls, run = self.call([Response(503) for _ in range(4)])
        with self.assertRaisesRegex(VibeFailure, "LASTFM_UNAVAILABLE"): run()
        self.assertEqual(len(calls), 4); self.assertEqual(clock.sleeps, [0.5, 1.0, 2.0])
        clock, calls, run = self.call([Response(401)])
        with self.assertRaisesRegex(VibeFailure, "LASTFM_UPSTREAM_REJECTED"): run()
        self.assertEqual(len(calls), 1); self.assertEqual(clock.sleeps, [])
    def test_retry_after_and_deadline_bound_backoff(self):
        clock, calls, run = self.call([Response(429, headers={"Retry-After": "100"}), Response(data={"similartracks": {"track": []}})])
        self.assertEqual(run(), []); self.assertEqual(clock.sleeps, [8.0])
        clock, calls, run = self.call([Response(503)], deadline=0.25)
        with self.assertRaisesRegex(VibeFailure, "VIBE_DEADLINE_EXCEEDED"): run()
        self.assertEqual(len(calls), 1); self.assertEqual(clock.sleeps, [0.25])
    def test_later_failure_keeps_partial_v2_plan_and_dry_run_never_writes_mpd(self):
        class Mpd:
            def __init__(self): self.added = []; self.cleared = False
            def playlistinfo(self): return []
            def add(self, value): self.added.append(value)
            def clear(self): self.cleared = True
        args = SimpleNamespace(api_key="test", target_queue=2, crop=False, append=False, planner_max_expansions=1,
                               include_christmas=False, exclude_christmas=False, similar_limit=10,
                               max_seconds=10, dry_run=True, mode="load", no_final_stop=False, endless=False)
        first = [{"name": "One", "artist": {"name": "Artist One"}}]
        original = vibe.lastfm_get_similar
        calls = []
        def discover(*_args, **_kwargs):
            calls.append(1)
            if len(calls) == 1: return first
            raise VibeFailure("LASTFM_UNAVAILABLE", "network")
        vibe.lastfm_get_similar = discover
        try:
            mpd = Mpd()
            plan, passes, warning = vibe.build_v2_plan(mpd, args, mbid_map={},
                text_map={"artist one|one": ["USB/one.flac"]},
                file_meta={"USB/one.flac": {"artist": "Artist One", "title": "One"}},
                seed_artist="Seed", seed_title="Seed Song", seed_genre="")
            self.assertEqual(passes, 2); self.assertEqual(warning, "LASTFM_UNAVAILABLE")
            self.assertEqual([row["file"] for row in plan], ["USB/one.flac"])
            self.assertEqual(vibe.apply_v2_plan(mpd, args, plan, was_playing=False), plan)
            self.assertEqual(mpd.added, []); self.assertFalse(mpd.cleared)
        finally:
            vibe.lastfm_get_similar = original

    def test_missing_track_schema_and_mixed_rows_are_safely_classified(self):
        with self.assertRaisesRegex(VibeFailure, "LASTFM_MALFORMED_RESPONSE"):
            vibe._valid_recommendations({"similartracks": {}})
        rows = vibe._valid_recommendations({"similartracks": {"track": [
            {"name": "Good", "artist": {"name": "Artist"}, "mbid": 99},
            {"name": "", "artist": {"name": "Bad"}},
            "not-a-row",
        ]}})
        self.assertEqual(rows, [{"name": "Good", "artist": {"name": "Artist"}, "mbid": ""}])

    def test_lastfm_retry_categories_and_permanent_api_error(self):
        for api_error in (8, 16, 29):
            with self.subTest(api_error=api_error):
                clock, calls, run = self.call([
                    Response(data={"error": api_error}),
                    Response(data={"similartracks": {"track": []}}),
                ])
                self.assertEqual(run(), [])
                self.assertEqual(len(calls), 2)
                self.assertEqual(clock.sleeps, [0.5])
        clock, calls, run = self.call([Response(data={"error": 6})])
        with self.assertRaisesRegex(VibeFailure, "LASTFM_UPSTREAM_REJECTED"):
            run()
        self.assertEqual(len(calls), 1)
        self.assertEqual(clock.sleeps, [])

    def test_network_recovery_retry_after_zero_and_request_deadline(self):
        clock, calls, run = self.call([
            NetworkError("offline"),
            Response(data={"similartracks": {"track": []}}),
        ])
        self.assertEqual(run(), [])
        self.assertEqual(len(calls), 2)
        self.assertEqual(clock.sleeps, [0.5])

        clock, calls, run = self.call([
            Response(429, headers={"Retry-After": "0"}),
            Response(data={"similartracks": {"track": []}}),
        ])
        self.assertEqual(run(), [])
        self.assertEqual(len(calls), 2)
        self.assertEqual(clock.sleeps, [])

        clock = Clock()
        observed = []
        def slow_request(*_args, **kwargs):
            observed.append(kwargs["timeout"])
            clock.value = 2.0
            return Response(data={"similartracks": {"track": []}})
        with self.assertRaisesRegex(VibeFailure, "VIBE_DEADLINE_EXCEEDED"):
            lastfm_get_similar("not-a-real-key", "seed", "track", 10, deadline=1,
                               request_get=slow_request, clock=clock.now, sleeper=clock.sleep)
        self.assertEqual(len(observed), 1)
        self.assertLessEqual(sum(observed[0]), 1.0)

    def test_first_failure_empty_and_no_local_match_outcomes(self):
        class Mpd:
            def playlistinfo(self): return []
        args = SimpleNamespace(api_key="test", target_queue=2, crop=False, append=False, planner_max_expansions=0,
                               include_christmas=False, exclude_christmas=False, similar_limit=10,
                               max_seconds=10, dry_run=True, mode="load", no_final_stop=False, endless=False)
        original = vibe.lastfm_get_similar
        try:
            vibe.lastfm_get_similar = lambda *_args, **_kwargs: (_ for _ in ()).throw(VibeFailure("LASTFM_UNAVAILABLE", "network"))
            plan, _, warning = vibe.build_v2_plan(Mpd(), args, mbid_map={}, text_map={}, file_meta={},
                seed_artist="Seed", seed_title="Song", seed_genre="")
            self.assertEqual((plan, warning), ([], "LASTFM_UNAVAILABLE"))
            vibe.lastfm_get_similar = lambda *_args, **_kwargs: []
            plan, _, warning = vibe.build_v2_plan(Mpd(), args, mbid_map={}, text_map={}, file_meta={},
                seed_artist="Seed", seed_title="Song", seed_genre="")
            self.assertEqual((plan, warning), ([], "VIBE_NO_RECOMMENDATIONS"))
            vibe.lastfm_get_similar = lambda *_args, **_kwargs: [{"name": "Nope", "artist": {"name": "Other"}}]
            plan, _, warning = vibe.build_v2_plan(Mpd(), args, mbid_map={}, text_map={}, file_meta={},
                seed_artist="Seed", seed_title="Song", seed_genre="")
            self.assertEqual((plan, warning), ([], "VIBE_NO_LOCAL_MATCHES"))
        finally:
            vibe.lastfm_get_similar = original

    def test_legacy_partial_json_dry_run_never_writes_mpd(self):
        class Mpd:
            def __init__(self): self.added = []; self.stopped = False
            def currentsong(self): return {}
            def status(self): return {"state": "stop", "playlistlength": "0"}
            def playlistinfo(self): return []
            def add(self, value): self.added.append(value)
            def clear(self): raise AssertionError("dry run must not clear MPD")
            def stop(self): self.stopped = True
            def disconnect(self): pass
        mpd_client = Mpd()
        original_connect, original_discover, original_argv = vibe.mpd_connect, vibe.lastfm_get_similar, sys.argv
        try:
            with tempfile.TemporaryDirectory() as tmp:
                index_path = f"{tmp}/index.json"
                output_path = f"{tmp}/result.json"
                with open(index_path, "w", encoding="utf-8") as handle:
                    json.dump({"mbid_map": {}, "text_map": {"artist one|one": ["USB/one.flac"]}, "file_meta": {}}, handle)
                calls = []
                def discover(*_args, **_kwargs):
                    calls.append(1)
                    if len(calls) == 1:
                        return [{"name": "One", "artist": {"name": "Artist One"}}]
                    raise VibeFailure("LASTFM_UNAVAILABLE", "network")
                vibe.mpd_connect = lambda *_args, **_kwargs: mpd_client
                vibe.lastfm_get_similar = discover
                sys.argv = ["lastfm_vibe_radio.py", "--api-key", "test", "--index", index_path,
                            "--seed-artist", "Seed", "--seed-title", "Song", "--target-queue", "2",
                            "--dry-run", "--json-out", output_path, "--max-seconds", "10"]
                vibe.main()
                with open(output_path, "r", encoding="utf-8") as handle:
                    summary = json.load(handle)
                self.assertEqual(summary["outcome"], "partial")
                self.assertEqual(summary["warning_code"], "LASTFM_UNAVAILABLE")
                self.assertEqual([row["file"] for row in summary["tracks"]], ["USB/one.flac"])
                self.assertEqual(mpd_client.added, [])
                self.assertFalse(mpd_client.stopped)
        finally:
            vibe.mpd_connect, vibe.lastfm_get_similar, sys.argv = original_connect, original_discover, original_argv

if __name__ == "__main__": unittest.main()
