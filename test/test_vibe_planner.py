import unittest

from vibe_planner import select_diverse_candidates


def candidate(file_name, artist, title, album, genre, rank):
    return {
        "file": file_name,
        "artist": artist,
        "title": title,
        "album": album,
        "genre": genre,
        "source_rank": rank,
        "method": "text",
    }


class VibePlannerTests(unittest.TestCase):
    def test_excludes_seasonal_duplicates_and_seed_track(self):
        rows = [
            candidate("USB/A/seed.flac", "Seed Artist", "Seed Song", "Seed Album", "Jazz", 1),
            candidate("USB/A/christmas.flac", "Holiday Artist", "Christmas Song", "Holiday Album", "Jazz", 2),
            candidate("USB/A/one.flac", "Artist One", "One", "Album One", "Jazz", 3),
            candidate("USB/A/one-copy.flac", "Artist One", "One (Remastered)", "Album One", "Jazz", 4),
            candidate("USB/B/two.flac", "Artist Two", "Two", "Album Two", "Jazz", 5),
        ]

        plan = select_diverse_candidates(
            rows,
            target=12,
            avoid_files=["USB/A/seed.flac"],
            avoid_tracks=["seed artist|seed song"],
            random_seed=7,
        )

        self.assertEqual([item["file"] for item in plan], ["USB/A/one.flac", "USB/B/two.flac"])
        self.assertNotIn("USB/A/christmas.flac", [item["file"] for item in plan])

    def test_prefers_artist_and_album_variety_when_available(self):
        rows = [
            candidate("USB/A/one.flac", "Artist A", "A One", "Album A", "Jazz", 1),
            candidate("USB/A/two.flac", "Artist A", "A Two", "Album A", "Jazz", 2),
            candidate("USB/B/one.flac", "Artist B", "B One", "Album B", "Jazz", 3),
            candidate("USB/B/two.flac", "Artist B", "B Two", "Album B", "Jazz", 4),
            candidate("USB/C/one.flac", "Artist C", "C One", "Album C", "Jazz", 5),
            candidate("USB/D/one.flac", "Artist D", "D One", "Album D", "Jazz", 6),
            candidate("USB/E/one.flac", "Artist E", "E One", "Album E", "Jazz", 7),
        ]

        plan = select_diverse_candidates(rows, target=5, seed_artist="Artist A", seed_genre="Jazz", random_seed=11)

        artists = [item["artist"] for item in plan]
        albums = [item["album"] for item in plan]
        self.assertEqual(len(plan), 5)
        self.assertEqual(len(set(artists)), 5)
        self.assertEqual(len(set(albums)), 5)
        self.assertNotEqual(artists[0], "Artist A")

    def test_relaxes_gracefully_when_a_small_library_has_one_artist(self):
        rows = [
            candidate(f"USB/S/{number}.flac", "One Artist", f"Song {number}", f"Album {number}", "Ambient", number)
            for number in range(1, 5)
        ]

        plan = select_diverse_candidates(rows, target=12, seed_artist="Different Seed", random_seed=3)

        self.assertEqual(len(plan), 4)
        self.assertEqual(len({item["file"] for item in plan}), 4)

    def test_initial_trial_is_a_varied_twelve_track_list(self):
        rows = [
            candidate(
                f"USB/V/{number}.flac",
                f"Artist {number}",
                f"Song {number}",
                f"Album {number}",
                "Jazz; Fusion" if number % 2 else "Jazz",
                number,
            )
            for number in range(1, 17)
        ]

        plan = select_diverse_candidates(rows, target=12, seed_artist="Artist 1", seed_genre="Jazz", random_seed=19)

        self.assertEqual(len(plan), 12)
        self.assertEqual(len({item["file"] for item in plan}), 12)
        self.assertEqual(len({item["artist"] for item in plan}), 12)
        self.assertNotIn("Artist 1", [item["artist"] for item in plan[:4]])

    def test_treats_small_ensemble_name_as_the_seed_artist_family(self):
        rows = [
            candidate("USB/M/trio.flac", "John Mayer Trio", "Gravity", "Try!", "Rock", 1),
            candidate("USB/M/solo.flac", "John Mayer", "Belief", "Continuum", "Rock", 2),
            candidate("USB/A/one.flac", "Artist One", "One", "Album One", "Rock", 3),
            candidate("USB/A/two.flac", "Artist Two", "Two", "Album Two", "Rock", 4),
            candidate("USB/A/three.flac", "Artist Three", "Three", "Album Three", "Rock", 5),
            candidate("USB/A/four.flac", "Artist Four", "Four", "Album Four", "Rock", 6),
        ]

        plan = select_diverse_candidates(rows, target=4, seed_artist="John Mayer", random_seed=5)

        self.assertEqual(len(plan), 4)
        self.assertFalse(any("john mayer" in item["artist"].casefold() for item in plan[:4]))


if __name__ == "__main__":
    unittest.main()
