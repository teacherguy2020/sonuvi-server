import sys
import types
import unittest
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
        self.assertEqual(run(), [row]); self.assertEqual(len(calls), 2); self.assertEqual(clock.sleeps, [0.5])
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

if __name__ == "__main__": unittest.main()
