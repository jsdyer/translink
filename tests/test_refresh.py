import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gtfsrt import parse_feed
from network import display_label, resolve_watch, simplify
from refresh import assemble, publish, redact

ROOT = Path(__file__).resolve().parents[1]


def varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def signed(value):
    if value < 0:
        value += 1 << 64
    return varint(value)


def key(field, wire):
    return varint((field << 3) | wire)


def text(field, value):
    raw = value.encode()
    return key(field, 2) + varint(len(raw)) + raw


def message(field, body):
    return key(field, 2) + varint(len(body)) + body


def number(field, value):
    return key(field, 0) + varint(value)


def real(field, value):
    return key(field, 5) + struct.pack("<f", value)


class DecoderTests(unittest.TestCase):
    def test_route_direction_and_negative_delay_use_current_field_numbers(self):
        trip = text(1, "trip-1") + number(4, 0) + text(5, "6641") + number(6, 1)
        position = real(1, 49.25) + real(2, -123.1) + real(5, 8.5)
        vehicle = message(1, trip) + message(2, position) + number(5, 1_700_000_000) + message(8, text(1, "18421"))
        update = message(1, trip) + number(5, 0)  # overwritten below with a real negative
        update = message(1, text(1, "trip-1") + number(4, 0) + text(5, "6641") + number(6, 1)) + signed_field(5, -120)
        canceled = message(1, text(1, "trip-x") + number(4, 3) + text(5, "6641"))
        header = message(1, text(1, "2.0") + number(3, 1_700_000_100))
        body = header + message(2, text(1, "v1") + message(4, vehicle)) + message(2, text(1, "u1") + message(3, update))
        body += message(2, text(1, "c1") + message(3, canceled))
        parsed = parse_feed(body)
        self.assertEqual(parsed["timestamp"], 1_700_000_100)
        self.assertEqual(parsed["vehicles"][0]["route_id"], "6641")
        self.assertEqual(parsed["vehicles"][0]["direction"], "1")
        self.assertEqual(parsed["vehicles"][0]["id"], "18421")
        self.assertAlmostEqual(parsed["vehicles"][0]["lat"], 49.25, places=4)
        self.assertEqual(parsed["trips"][0]["delay"], -120)
        self.assertTrue(parsed["trips"][1]["canceled"])

    def test_key_is_redacted(self):
        self.assertNotIn("secret-key", redact("failed for secret-key", "secret-key"))


def signed_field(field, value):
    return key(field, 0) + signed(value)


class AssembleTests(unittest.TestCase):
    def test_drops_null_island_and_attaches_delay(self):
        parsed = {
            "timestamp": 1_700_000_100,
            "vehicles": [
                {"id": "1", "route_id": "6641", "trip_id": "t", "direction": "1", "lat": 49.2, "lon": -123.1, "mps": 10, "timestamp": 1_700_000_000, "status": "in transit"},
                {"id": "bad", "route_id": "6641", "lat": 0, "lon": 0},
            ],
            "trips": [
                {"trip_id": "t", "route_id": "6641", "delay": 125, "canceled": False},
                {"trip_id": "c", "route_id": "6641", "delay": None, "canceled": True},
            ],
            "alerts": [{"routes": ["6641"], "header": "Stop moved", "effect": "detour"}],
        }
        from datetime import datetime, timezone
        capture = assemble(parsed, datetime(2026, 11, 23, 16, 0, tzinfo=timezone.utc))
        self.assertEqual(len(capture["vehicles"]), 1)
        self.assertEqual(capture["vehicles"][0]["delay"], 125)
        self.assertEqual(capture["vehicles"][0]["kph"], 36)
        self.assertEqual(capture["vehicles"][0]["age"], 100)
        self.assertEqual(capture["summary"]["6641"]["canceled"], 1)
        self.assertEqual(capture["dropped"], 1)
        self.assertEqual(capture["coverage"], "full")

    def test_refuses_positions_with_no_route_ids(self):
        parsed = {"timestamp": 1, "vehicles": [{"id": "1", "lat": 49.2, "lon": -123.1}], "trips": [], "alerts": []}
        from datetime import datetime, timezone
        with self.assertRaisesRegex(ValueError, "route ids"):
            assemble(parsed, datetime(2026, 11, 23, tzinfo=timezone.utc))


class PublishTests(unittest.TestCase):
    def test_live_capture_replaces_samples_and_keeps_only_retain(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "web" / "data" / "captures"
            folder.mkdir(parents=True)
            (folder / "sample-a.json").write_text("{}\n")
            index = {"captures": [{"id": "sample-a", "kind": "sample", "captured": "2026-11-23T15:00:00Z"}]}
            (root / "web" / "data" / "index.json").write_text(json.dumps(index))
            first = {"id": "20261123T160000Z", "kind": "live", "coverage": "full", "captured": "2026-11-23T16:00:00Z", "vehicles": [{"routeId": "1"}], "alerts": []}
            second = {"id": "20261123T170000Z", "kind": "live", "coverage": "full", "captured": "2026-11-23T17:00:00Z", "vehicles": [{"routeId": "1"}, {"routeId": "2"}], "alerts": []}
            publish(root, first, 1)
            publish(root, second, 1)
            saved = json.loads((root / "web" / "data" / "index.json").read_text())
            self.assertEqual([item["id"] for item in saved["captures"]], ["20261123T170000Z"])
            self.assertFalse((folder / "sample-a.json").exists())
            self.assertFalse((folder / "20261123T160000Z.json").exists())
            self.assertTrue((folder / "20261123T170000Z.json").exists())
            status = json.loads((root / "web" / "data" / "status.json").read_text())
            self.assertEqual(status["buses"], 2)


class NetworkTests(unittest.TestCase):
    def test_labels_drop_leading_zeros(self):
        self.assertEqual(display_label("099", "Broadway B-Line"), "99")
        self.assertEqual(display_label("", "Expo Line"), "Expo Line")
        self.assertEqual(display_label("R5", "Hastings St"), "R5")

    def test_watchlist_can_grow_past_the_defaults(self):
        config = json.loads((ROOT / "web" / "config.json").read_text())
        self.assertNotIn("410", config["watchlist"])
        routes = [
            {"id": "6641", "label": "99", "name": "Broadway B-Line"},
            {"id": "6728", "label": "410", "name": "Brighouse Station/22nd St Station"},
        ]
        found, missing = resolve_watch(routes, config["watchlist"] + ["410"])
        self.assertIn("6641", found)
        self.assertIn("6728", found)
        self.assertNotIn("410", missing)
        self.assertGreater(len(config["watchlist"]) + 1, len(config["watchlist"]))

    def test_simplify_keeps_the_ends(self):
        points = [[i, i] for i in range(10)]
        simplified = simplify(points, 4)
        self.assertEqual(simplified[0], [0, 0])
        self.assertEqual(simplified[-1], [9, 9])
        self.assertEqual(len(simplified), 4)


if __name__ == "__main__":
    unittest.main()
