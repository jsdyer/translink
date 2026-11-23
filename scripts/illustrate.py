#!/usr/bin/env python3
"""Write two illustrated captures so the sheet can be read before a live refresh.

Live captures are left in place. Illustrated files are replaced only when the
index has no live capture, or when --force is passed. --force still does not
delete live captures.
"""
import argparse
import json
import math
from pathlib import Path

from network import ROOT, atomic_json

DATA = ROOT / "web" / "data"


def metres(a, b):
    radius = 6371000
    rad = math.pi / 180
    dlat = (b[0] - a[0]) * rad
    dlon = (b[1] - a[1]) * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(min(1, math.sqrt(h)))


def point_at(line, distance):
    walked = 0
    for index in range(1, len(line)):
        step = metres(line[index - 1], line[index])
        if walked + step >= distance:
            fraction = 0 if step == 0 else (distance - walked) / step
            return [
                round(line[index - 1][0] + (line[index][0] - line[index - 1][0]) * fraction, 5),
                round(line[index - 1][1] + (line[index][1] - line[index - 1][1]) * fraction, 5),
            ]
        walked += step
    return [round(line[-1][0], 5), round(line[-1][1], 5)]


def longest(route):
    shapes = route.get("shapes") or {}
    if not shapes:
        raise ValueError(f"No saved line for {route['label']}")
    direction = max(shapes, key=lambda key: len(shapes[key]))
    return direction, shapes[direction]


def bus(identifier, route_id, direction, point, delay, age, kph=32):
    return {
        "id": identifier,
        "routeId": route_id,
        "direction": direction,
        "lat": point[0],
        "lon": point[1],
        "kph": kph,
        "delay": delay,
        "age": age,
        "status": "in transit",
    }


def build(network):
    routes = {route["label"]: route for route in network["routes"]}
    broadway = routes["99"]
    hastings = routes["R5"]
    direction, line = longest(broadway)
    other_direction, other_line = longest(hastings)
    first = [bus(f"SAMPLE-99-{i+1}", broadway["id"], direction, point_at(line, distance), delay, age)
             for i, (distance, delay, age) in enumerate(((2800, -40, 20), (3020, 60, 30), (7600, 420, 40), (11000, 480, 400)))]
    second_line = [bus(f"SAMPLE-99-{i+1}", broadway["id"], direction, point_at(line, distance), delay, age)
                   for i, (distance, delay, age) in enumerate(((2800, 60, 25), (3050, 420, 35), (9800, 480, 50)))]
    rapid = [bus(f"SAMPLE-R5-{i+1}", hastings["id"], other_direction, point_at(other_line, distance), 90, 40, 28)
             for i, distance in enumerate((1500, 4200))]
    brighouse = routes["410"]
    extra = [
        bus("SAMPLE-410-1", brighouse["id"], None, [49.168, -123.136], 120, 30, 24),
        bus("SAMPLE-410-2", brighouse["id"], None, [49.1705, -123.136], 180, 45, 22),
    ]
    earlier = {
        "id": "sample-a",
        "kind": "sample",
        "coverage": "sample",
        "captured": "2026-11-23T16:00:00Z",
        "feedTimestamp": "2026-11-23T15:59:30Z",
        "vehicles": first + rapid,
        "summary": {broadway["id"]: {"delayMedian": 240, "delayN": 4, "canceled": 1}},
        "canceled": [{"routeId": broadway["id"], "trip": "ILLUSTRATED-1"}],
        "alerts": [],
        "dropped": 0,
        "unassigned": 0,
    }
    later = {
        "id": "sample-b",
        "kind": "sample",
        "coverage": "sample",
        "captured": "2026-11-23T17:00:00Z",
        "feedTimestamp": "2026-11-23T16:59:30Z",
        "vehicles": second_line + rapid + extra,
        "summary": {broadway["id"]: {"delayMedian": 420, "delayN": 3, "canceled": 1}},
        "canceled": [{"routeId": broadway["id"], "trip": "ILLUSTRATED-2"}],
        "alerts": [{"routes": [broadway["id"]], "header": "Illustrated detour: this is not a real service alert", "effect": "detour"}],
        "dropped": 0,
        "unassigned": 0,
    }
    return earlier, later


def entry(capture):
    routes = {item["routeId"] for item in capture["vehicles"]}
    return {
        "id": capture["id"],
        "file": f"captures/{capture['id']}.json",
        "captured": capture["captured"],
        "feedTimestamp": capture["feedTimestamp"],
        "kind": "sample",
        "coverage": "sample",
        "buses": len(capture["vehicles"]),
        "routes": len(routes),
        "alerts": len(capture["alerts"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    index_path = DATA / "index.json"
    if index_path.exists() and not args.force:
        current = json.loads(index_path.read_text(encoding="utf-8"))
        if any(item.get("kind") == "live" for item in current.get("captures") or []):
            print("Live captures are already saved. Illustrated captures were left untouched.")
            return
    network = json.loads((DATA / "network.json").read_text(encoding="utf-8"))
    earlier, later = build(network)
    folder = DATA / "captures"
    folder.mkdir(parents=True, exist_ok=True)
    atomic_json(folder / "sample-a.json", earlier)
    atomic_json(folder / "sample-b.json", later)
    atomic_json(index_path, {"source": "https://gtfsapi.translink.ca/v3/", "captures": [entry(later), entry(earlier)]})
    atomic_json(DATA / "status.json", {"captured": later["captured"], "buses": len(later["vehicles"]), "routes": 3, "alerts": 1, "kind": "sample", "coverage": "sample", "dropped": 0})
    print("Wrote illustrated captures sample-a and sample-b")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as exc:
        raise SystemExit(f"Illustrated captures were not written: {exc}")
