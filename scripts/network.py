"""Turn the public GTFS zip into route names and a few simplified lines.

No API key is used. The watchlist chooses which lines are saved. It does not
decide which routes a visitor can ask about.
"""
import csv
from io import TextIOWrapper
import json
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
STATIC = "https://gtfs-static.translink.ca/gtfs/google_transit.zip"


def display_label(short, long):
    short = (short or "").strip()
    long = (long or "").strip()
    if short.isdigit():
        return str(int(short))
    if short:
        return short
    if not long:
        raise ValueError("Route has neither a short name nor a long name")
    return long


def simplify(points, limit):
    if limit < 2:
        raise ValueError("A line needs at least two points")
    if len(points) <= limit:
        return points
    step = (len(points) - 1) / (limit - 1)
    chosen = [points[round(i * step)] for i in range(limit)]
    chosen[0] = points[0]
    chosen[-1] = points[-1]
    return chosen


def resolve_watch(routes, labels):
    """Map watchlist labels to route ids. Unknown labels are reported, not fatal."""
    by_label = {}
    by_name = {}
    for route in routes:
        by_label.setdefault(route["label"].casefold(), []).append(route["id"])
        by_name.setdefault(route["name"].casefold(), []).append(route["id"])
    found = []
    missing = []
    for label in labels:
        key = label.casefold()
        match = by_label.get(key) or by_name.get(key)
        if match:
            found.extend(match)
        else:
            missing.append(label)
    return found, missing


def _rows(archive, name):
    with archive.open(name) as raw:
        yield from csv.DictReader(TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def _color(value):
    text = (value or "").strip()
    if len(text) == 6 and all(c in "0123456789abcdefABCDEF" for c in text):
        return "#" + text.lower()
    return None


def build_network(archive, watchlist, shape_points):
    raw_routes = list(_rows(archive, "routes.txt"))
    routes = []
    for row in raw_routes:
        routes.append(
            {
                "id": row["route_id"],
                "label": display_label(row["route_short_name"], row["route_long_name"]),
                "name": (row["route_long_name"] or "").strip() or display_label(row["route_short_name"], row["route_long_name"]),
                "type": row["route_type"],
                "color": _color(row.get("route_color")),
                "dir": {},
            }
        )
    labels = [route["label"] for route in routes]
    if len(labels) != len(set(labels)):
        dupes = sorted({label for label in labels if labels.count(label) > 1})
        raise ValueError("Route labels are not unique: " + ", ".join(dupes))
    by_id = {route["id"]: route for route in routes}
    watched, missing = resolve_watch(routes, watchlist)
    watched = set(watched)

    exceptions = {}
    for row in _rows(archive, "direction_names_exceptions.txt"):
        exceptions[(row["route_name"].casefold(), row["direction_id"])] = row["direction_name"].strip()
    for route in routes:
        for direction in ("0", "1"):
            name = exceptions.get((route["label"].casefold(), direction)) or exceptions.get((route["name"].casefold(), direction))
            if name:
                route["dir"][direction] = name
    for row in _rows(archive, "directions.txt"):
        route = by_id.get(row["route_id"])
        if route and row["direction_id"] not in route["dir"] and row["direction"].strip():
            route["dir"][row["direction_id"]] = row["direction"].strip().lower()

    votes = {}
    for row in _rows(archive, "trips.txt"):
        if row["route_id"] not in watched or not row["shape_id"]:
            continue
        key = (row["shape_id"], row["route_id"], row["direction_id"])
        votes[key] = votes.get(key, 0) + 1
    shape_owner = {}
    for (shape_id, route_id, direction), count in votes.items():
        current = shape_owner.get(shape_id)
        if current is None or count > current[2]:
            shape_owner[shape_id] = (route_id, direction, count)

    collected = {shape_id: [] for shape_id in shape_owner}
    if collected:
        for row in _rows(archive, "shapes.txt"):
            bucket = collected.get(row["shape_id"])
            if bucket is None:
                continue
            bucket.append((int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"])))
    best = {}
    for shape_id, (route_id, direction, _) in shape_owner.items():
        points = collected.get(shape_id) or []
        if len(points) < 2:
            continue
        points.sort()
        line = [[round(lat, 5), round(lon, 5)] for _, lat, lon in points]
        key = (route_id, direction)
        if key not in best or len(line) > len(best[key]):
            best[key] = line
    for (route_id, direction), line in best.items():
        route = by_id[route_id]
        shapes = route.setdefault("shapes", {})
        shapes[str(direction)] = simplify(line, shape_points)

    feed = next(_rows(archive, "feed_info.txt"))
    routes.sort(key=lambda route: (0, int(route["label"])) if route["label"].isdigit() else (1, route["label"].casefold()))
    return {
        "retrieved": None,
        "source": STATIC,
        "feedStart": _day(feed["feed_start_date"]),
        "feedEnd": _day(feed["feed_end_date"]),
        "feedVersion": feed["feed_version"],
        "routes": routes,
        "missingWatch": missing,
        "lines": sum(1 for route in routes if route.get("shapes")),
    }


def _day(value):
    return f"{value[0:4]}-{value[4:6]}-{value[6:8]}"


def load_config(root=ROOT):
    return json.loads((root / "web" / "config.json").read_text(encoding="utf-8"))


def atomic_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def open_feed(path=None):
    if path:
        return Path(path).read_bytes()
    request = Request(STATIC, headers={"User-Agent": "coolcode-translink"})
    with urlopen(request, timeout=120) as response:
        if response.status != 200:
            raise ValueError(f"GTFS download failed with HTTP {response.status}")
        host = response.geturl().split("/")[2]
        if host != "gtfs-static.translink.ca":
            raise ValueError("GTFS download left the expected host")
        return response.read()
