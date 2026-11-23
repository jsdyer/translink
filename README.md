# Fleet Sheet

[Open Fleet Sheet](https://coolcode.ca/translink/) to see which TransLink vehicles are out, where a route is bunched, and what changed since the previous capture.

<!-- coolcode:guide -->
Pick a capture, then a route. The closest pair is measured along the saved line when this network file has one, and as the crow flies when it does not. A route missing from a partial capture is not counted as zero.
<!-- /coolcode:guide -->

## Reading a capture

The sheet reads one saved capture at a time. A full capture is every vehicle that reported a position in that GTFS-Realtime reading. An illustrated capture is only an example, and it is labelled as such. Delays come from trip updates joined by trip id. A cancellation is counted even when that trip has no position. A position older than `staleSeconds` in `web/config.json` is marked stale. The median uses the vehicles you can see on the selected route, not every scheduled trip.

“Along the saved line” means the distance between consecutive vehicles after each one is dropped onto the simplified GTFS shape. It is not a prediction of the next stop. A position more than `lineMetres` off that shape (80 m unless you change it) is kept on the map, but it is not used to measure an along-route gap. Bird-distance is used when that route has no saved line, when a position sits more than 1.2 km off every saved line, or when the shape would claim a smaller gap than the map shows. The watchlist does not limit which route you can type. It only chooses which lines are kept in the network file.

## Sources

[GTFS-Realtime v3](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-realtime) for positions, trip updates and alerts. [GTFS static](https://gtfs-static.translink.ca/gtfs/google_transit.zip) for route names and lines. Streets are [OpenFreeMap](https://openfreemap.org/) Positron, from OpenStreetMap, drawn with MapLibre GL 5.15.0 in `web/vendor/` (BSD-3-Clause). The RTTI API was retired on 3 December 2024 and is not called.

Each fleet refresh makes three realtime requests. An hourly schedule stays well under the 1,000 requests per day on a TransLink developer key. The static zip does not use the key. The key is read from `TRANSLINK_API_KEY` and is not written into the page, the captures, or the log.

Route and arrival data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service.

## Expand or customize

Defaults live in [web/config.json](web/config.json). `watchlist` is the set of route lines to draw. `retain` is how many captures to keep. `bunchMeters` is the gap at which the sheet says two vehicles are bunched. `lineMetres` is how close a ping must be to the saved line before that gap is measured along it. `mapStyle` is the street-map style URL. `staleSeconds` and `shapePoints` are the other tunables.

To draw the 410 as well as the routes already listed, add it and refresh the network. Visitors can already type 410 before that change; the line appears after the network file includes it.

```sh
python3 scripts/refresh_network.py
```

That command rewrites `web/data/network.json` and `web/data/network-status.json`. It does not need the API key and it does not delete captures.

A fleet capture needs the key in the environment. Nothing is replaced if the feed rejects the key or the download fails.

```sh
TRANSLINK_API_KEY=… python3 scripts/refresh.py
```

On GitHub, set repository variable `TRANSLINK_API_KEY` (a current GTFS-RT v3 key, not a retired RTTI key) and run **Refresh fleet snapshot**. The workflow refreshes the network, collects one capture, tests, and only then commits `web/data` and starts **Browser tool · Check and publish**. A failed refresh leaves the last good capture in place. The schedule is hourly at minute 17. Pushing ordinary code does not collect a new capture.

Publish the site by enabling **Settings → Pages → GitHub Actions** and pushing to `main`. Check `https://coolcode.ca/translink/`. After it is up, copy `tool.json` into `data/tools.json` in [jsdyer/jsdyer.github.io](https://github.com/jsdyer/jsdyer.github.io) and run `scripts/sync_guides.py --tool translink` there before regenerating the hub README.

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build.py
```

Illustrated captures, written by `python3 scripts/illustrate.py`, are removed automatically when the first live capture is published.
