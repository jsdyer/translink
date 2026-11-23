#!/usr/bin/env python3
"""Save one GTFS-Realtime capture. The API key stays in the environment."""
import argparse
from datetime import datetime, timezone
import json
import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from gtfsrt import parse_feed
from network import ROOT, atomic_json, load_config

HOST = "gtfsapi.translink.ca"


def with_key(url, key):
    parts = urlsplit(url)
    if parts.hostname != HOST or parts.scheme != "https":
        raise ValueError("Realtime URL must be https://gtfsapi.translink.ca/...")
    query = [(name, value) for name, value in parse_qsl(parts.query) if name.lower() != "apikey"]
    query.append(("apikey", key))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def redact(text, key):
    if key and key in text:
        return text.replace(key, "[redacted]")
    return text


def fetch(url, key):
    request = Request(with_key(url, key), headers={"Accept": "application/x-protobuf, application/json", "User-Agent": "coolcode-translink"})
    try:
        with urlopen(request, timeout=60) as response:
            final = urlsplit(response.geturl())
            if final.hostname != HOST:
                raise ValueError("Realtime request left the expected host")
            if response.status != 200:
                raise ValueError(f"Realtime feed returned HTTP {response.status}")
            return response.read()
    except HTTPError as exc:
        if exc.code == 403:
            raise ValueError(
                "GTFS-Realtime rejected the API key (HTTP 403). "
                "The old RTTI API was retired on 3 December 2024; "
                "TRANSLINK_API_KEY must be a current GTFS-RT v3 key."
            ) from None
        raise ValueError(f"Realtime feed returned HTTP {exc.code}") from None
    except URLError as exc:
        raise ValueError("Realtime feed could not be reached") from exc


def _median(values):
    nums = sorted(values)
    if not nums:
        return None
    mid = len(nums) // 2
    if len(nums) % 2:
        return nums[mid]
    return round((nums[mid - 1] + nums[mid]) / 2)


def assemble(parsed, captured):
    feed_ts = parsed.get("timestamp")
    vehicles = []
    dropped = 0
    unassigned = 0
    for item in parsed.get("vehicles") or []:
        lat, lon = item.get("lat"), item.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            dropped += 1
            continue
        if not (48 < lat < 50 and -124 < lon < -121):
            dropped += 1
            continue
        if not item.get("route_id"):
            unassigned += 1
        age = None
        if feed_ts and item.get("timestamp"):
            age = int(feed_ts) - int(item["timestamp"])
            if age < 0:
                age = 0
        speed = item.get("mps")
        record = {
            "id": item.get("id") or "unknown",
            "routeId": item.get("route_id"),
            "direction": item.get("direction"),
            "lat": round(float(lat), 5),
            "lon": round(float(lon), 5),
        }
        if item.get("bearing") is not None:
            record["bearing"] = int(round(item["bearing"]))
        if isinstance(speed, (int, float)):
            record["kph"] = int(round(speed * 3.6))
        if age is not None:
            record["age"] = age
        if item.get("status"):
            record["status"] = item["status"]
        if item.get("occupancy"):
            record["occupancy"] = item["occupancy"]
        if item.get("trip_id"):
            record["trip"] = item["trip_id"]
        vehicles.append(record)

    delay_by_trip = {}
    delays = {}
    canceled_count = {}
    canceled = []
    for trip in parsed.get("trips") or []:
        route_id = trip.get("route_id")
        if not route_id:
            continue
        if trip.get("canceled"):
            canceled_count[route_id] = canceled_count.get(route_id, 0) + 1
            if len(canceled) < 100:
                canceled.append({"routeId": route_id, "trip": trip.get("trip_id") or ""})
            continue
        delay = trip.get("delay")
        if isinstance(delay, (int, float)) and trip.get("trip_id"):
            delay_by_trip[trip["trip_id"]] = int(delay)
            delays.setdefault(route_id, []).append(int(delay))
    for vehicle in vehicles:
        delay = delay_by_trip.get(vehicle.get("trip"))
        if delay is not None:
            vehicle["delay"] = delay

    summary = {}
    for route_id in set(delays) | set(canceled_count):
        summary[route_id] = {
            "delayMedian": _median(delays.get(route_id, [])),
            "delayN": len(delays.get(route_id, [])),
            "canceled": canceled_count.get(route_id, 0),
        }
    for route_id, count in canceled_count.items():
        summary.setdefault(route_id, {"delayMedian": None, "delayN": 0, "canceled": count})

    alerts = []
    for alert in parsed.get("alerts") or []:
        if len(alerts) >= 80:
            break
        header = (alert.get("header") or "").strip()
        if not header:
            continue
        alerts.append({"routes": list(alert.get("routes") or []), "header": header[:280], "effect": alert.get("effect") or "unknown"})

    if vehicles and not any(item.get("routeId") for item in vehicles) and not summary:
        raise ValueError("Decoded positions but no route ids; the feed shape was not recognised")

    stamp = datetime.fromtimestamp(int(feed_ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if feed_ts else None
    return {
        "id": captured.strftime("%Y%m%dT%H%M%SZ"),
        "kind": "live",
        "coverage": "full",
        "captured": captured.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feedTimestamp": stamp,
        "vehicles": vehicles,
        "summary": summary,
        "canceled": canceled,
        "alerts": alerts,
        "dropped": dropped,
        "unassigned": unassigned,
    }


def publish(root, capture, retain):
    data = root / "web" / "data"
    folder = data / "captures"
    folder.mkdir(parents=True, exist_ok=True)
    index_path = data / "index.json"
    if index_path.exists():
        current = json.loads(index_path.read_text(encoding="utf-8"))
        entries = list(current.get("captures") or [])
    else:
        entries = []
    entries = [entry for entry in entries if entry.get("kind") != "sample"]
    entries = [entry for entry in entries if entry.get("id") != capture["id"]]
    entries.append(_entry(capture))
    entries.sort(key=lambda entry: entry.get("captured") or "", reverse=True)
    removed = entries[retain:]
    entries = entries[:retain]
    atomic_json(folder / f"{capture['id']}.json", capture)
    atomic_json(index_path, {"source": "https://gtfsapi.translink.ca/v3/", "captures": entries})
    atomic_json(data / "status.json", _status(entries[0], capture))
    for entry in removed:
        path = folder / f"{entry['id']}.json"
        if path.is_file():
            path.unlink()
    for stale in folder.glob("sample-*.json"):
        stale.unlink()


def _entry(capture):
    routes = {item.get("routeId") for item in capture["vehicles"] if item.get("routeId")}
    return {
        "id": capture["id"],
        "file": f"captures/{capture['id']}.json",
        "captured": capture["captured"],
        "feedTimestamp": capture.get("feedTimestamp"),
        "kind": capture["kind"],
        "coverage": capture["coverage"],
        "buses": len(capture["vehicles"]),
        "routes": len(routes),
        "alerts": len(capture.get("alerts") or []),
    }


def _status(entry, capture):
    return {
        "captured": entry["captured"],
        "buses": entry["buses"],
        "routes": entry["routes"],
        "alerts": entry["alerts"],
        "kind": entry["kind"],
        "coverage": entry["coverage"],
        "dropped": capture.get("dropped", 0),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", help="Read a JSON payload instead of the network, for tests")
    args = parser.parse_args()
    key = os.environ.get("TRANSLINK_API_KEY", "").strip()
    config = load_config()
    try:
        if args.fixture:
            parsed = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
        else:
            if not key:
                raise ValueError("TRANSLINK_API_KEY is not set. Nothing was changed.")
            positions = parse_feed(fetch(config["realtime"]["positions"], key))
            updates = parse_feed(fetch(config["realtime"]["trips"], key))
            notices = parse_feed(fetch(config["realtime"]["alerts"], key))
            parsed = {
                "timestamp": positions.get("timestamp") or updates.get("timestamp"),
                "vehicles": positions["vehicles"],
                "trips": updates["trips"],
                "alerts": notices["alerts"],
            }
        capture = assemble(parsed, datetime.now(timezone.utc).replace(microsecond=0))
        publish(ROOT, capture, int(config["retain"]))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        raise SystemExit("Fleet refresh failed: " + redact(str(exc), key))
    print(f"Saved capture {capture['id']} with {len(capture['vehicles'])} vehicles")


if __name__ == "__main__":
    main()
