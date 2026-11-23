#!/usr/bin/env python3
"""Refresh route names and watchlist lines from the public GTFS zip."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile
from io import BytesIO

from network import ROOT, atomic_json, build_network, load_config, open_feed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed", type=Path, help="Existing GTFS zip, for offline checks")
    args = parser.parse_args()
    config = load_config()
    raw = open_feed(args.feed)
    with ZipFile(BytesIO(raw)) as archive:
        network = build_network(archive, config["watchlist"], int(config["shapePoints"]))
    network["retrieved"] = datetime.now(timezone.utc).date().isoformat()
    missing = network.pop("missingWatch")
    data = ROOT / "web" / "data"
    atomic_json(data / "network.json", network)
    atomic_json(
        data / "network-status.json",
        {
            "retrieved": network["retrieved"],
            "feedStart": network["feedStart"],
            "feedEnd": network["feedEnd"],
            "feedVersion": network["feedVersion"],
            "routes": len(network["routes"]),
            "lines": network["lines"],
        },
    )
    print(f"Saved {len(network['routes'])} routes and {network['lines']} lines")
    if missing:
        print("Watchlist labels not in this feed: " + ", ".join(missing))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as exc:
        raise SystemExit(f"Network refresh failed: {exc}")
