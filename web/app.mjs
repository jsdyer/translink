import { boundsFor, compareCaptures, formatDelay, formatMetres, formatPacific, inspectRoute, sortLabels } from "./model.mjs";

const finding = document.querySelector("#finding");
const state = { captures: new Map(), frame: "route", query: "99" };
const EMPTY = { type: "FeatureCollection", features: [] };

function url(path) {
  return new URL(path, import.meta.url);
}

async function loadJson(path) {
  const response = await fetch(url(path));
  if (!response.ok) throw new Error(`Could not read ${path}`);
  return response.json();
}

function text(node, value) {
  node.textContent = value;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function colorOf(value) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#147c73";
}

function labelFor(routes, id) {
  return routes.find((route) => route.id === id)?.label || id || "unknown";
}

function fillSelect(select, entries, selected) {
  clear(select);
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${formatPacific(entry.captured)} · ${entry.buses} buses${entry.kind === "sample" ? " · illustrated" : ""}`;
    select.append(option);
  }
  select.value = selected;
  select.disabled = entries.length < 2 && select.id === "earlier";
}

function renderChips(labels) {
  const box = document.querySelector("#chips");
  clear(box);
  for (const label of labels) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(label.toLocaleLowerCase("en-CA") === state.query.trim().toLocaleLowerCase("en-CA")));
    button.addEventListener("click", () => {
      state.query = label;
      document.querySelector("#route").value = label;
      render();
    });
    box.append(button);
  }
}

function routeFeatures(shapes) {
  const features = [];
  for (const shape of Object.values(shapes || {})) {
    if (!Array.isArray(shape) || shape.length < 2) continue;
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: shape.map(([lat, lon]) => [lon, lat]) },
    });
  }
  return { type: "FeatureCollection", features };
}

function busFeatures(vehicles, selectedIds, color) {
  return {
    type: "FeatureCollection",
    features: (vehicles || []).filter((vehicle) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon)).map((vehicle) => ({
      type: "Feature",
      properties: {
        on: selectedIds.has(vehicle.id) ? 1 : 0,
        color,
        id: vehicle.id || "",
        delay: formatDelay(vehicle.delay, state.config.onTimeSeconds),
      },
      geometry: { type: "Point", coordinates: [vehicle.lon, vehicle.lat] },
    })),
  };
}

function paintMap() {
  const map = state.map;
  const result = state.mapResult;
  if (!map || !state.mapReady || !result) return;
  const selected = result.vehicles || [];
  const selectedIds = new Set(selected.map((vehicle) => vehicle.id));
  const color = colorOf(result.route?.color);
  const shown = state.frame === "region" ? state.mapVehicles : selected;
  map.getSource("route").setData(routeFeatures(result.route?.shapes));
  map.getSource("buses").setData(busFeatures(shown, selectedIds, color));
  map.setPaintProperty("route-line", "line-color", color);
  const focus = state.frame === "region"
    ? boundsFor((state.mapVehicles || []).map((vehicle) => [vehicle.lat, vehicle.lon]), "region")
    : boundsFor([
      ...selected.map((vehicle) => [vehicle.lat, vehicle.lon]),
      ...Object.values(result.route?.shapes || {}).flat(),
    ], "route");
  map.resize();
  map.fitBounds([[focus.west, focus.south], [focus.east, focus.north]], { padding: 40, animate: false, maxZoom: 14.5 });
}

function ensureMap() {
  if (state.map || state.mapFailed) return;
  const holder = document.querySelector("#map");
  if (!window.maplibregl) {
    state.mapFailed = true;
    holder.textContent = "The street map did not load.";
    return;
  }
  try {
    const map = new window.maplibregl.Map({
      container: holder,
      style: state.config.mapStyle || "https://tiles.openfreemap.org/styles/positron",
      center: [-123.05, 49.25],
      zoom: 10,
      scrollZoom: false,
      attributionControl: true,
    });
    map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: EMPTY });
      map.addSource("buses", { type: "geojson", data: EMPTY });
      const before = (map.getStyle().layers || []).find((layer) => layer.type === "symbol");
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: { "line-color": "#147c73", "line-width": 5, "line-opacity": 0.92 },
        layout: { "line-cap": "round", "line-join": "round" },
      }, before && before.id);
      map.addLayer({
        id: "buses",
        type: "circle",
        source: "buses",
        paint: {
          "circle-radius": ["case", ["==", ["to-number", ["get", "on"]], 1], 7, 3.5],
          "circle-color": ["case", ["==", ["to-number", ["get", "on"]], 1], ["coalesce", ["get", "color"], "#147c73"], "#60746c"],
          "circle-stroke-width": ["case", ["==", ["to-number", ["get", "on"]], 1], 1.5, 0],
          "circle-stroke-color": "#1b2826",
        },
      });
      map.on("click", "buses", (event) => {
        const feature = event.features && event.features[0];
        if (!feature) return;
        const id = feature.properties.id || "Vehicle";
        const delay = feature.properties.delay || "";
        new window.maplibregl.Popup({ closeButton: true, maxWidth: "240px" })
          .setLngLat(event.lngLat)
          .setText(delay ? `${id} · ${delay}` : id)
          .addTo(map);
      });
      map.on("mouseenter", "buses", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "buses", () => { map.getCanvas().style.cursor = ""; });
      state.mapReady = true;
      paintMap();
    });
    state.map = map;
  } catch (error) {
    state.mapFailed = true;
    holder.textContent = "The street map did not start in this browser.";
  }
}

function drawMap(result, allVehicles) {
  state.mapResult = result;
  state.mapVehicles = allVehicles;
  ensureMap();
  if (state.mapReady) paintMap();
}

function renderTracks(result) {
  const box = document.querySelector("#tracks");
  clear(box);
  for (const direction of result.directions || []) {
    if (!direction.along) continue;
    const block = document.createElement("div");
    block.className = "track";
    const title = document.createElement("p");
    title.textContent = direction.name;
    const rail = document.createElement("div");
    rail.className = "rail";
    const bunch = Number.isFinite(state.config.bunchMeters) ? state.config.bunchMeters : 500;
    const closest = result.closest && result.closest.along && result.closest.metres <= bunch ? result.closest.metres : null;
    for (const bus of direction.buses) {
      if (bus.fraction == null) continue;
      const pip = document.createElement("span");
      pip.className = "pip" + (closest != null && bus.gap != null && Math.abs(bus.gap - closest) < 1 ? " bunched" : "");
      pip.style.left = `${Math.max(0, Math.min(1, bus.fraction)) * 100}%`;
      pip.title = bus.id;
      rail.append(pip);
    }
    block.append(title, rail);
    box.append(block);
  }
}

function addCell(row, value, className) {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
}

function renderTable(result) {
  const body = document.querySelector("#rows");
  clear(body);
  const buses = (result.directions || []).flatMap((direction) => direction.buses.map((bus) => ({ ...bus, towards: direction.name })));
  const showSpeed = buses.some((bus) => bus.kph != null);
  body.closest("table").classList.toggle("no-speed", !showSpeed);
  for (const bus of buses) {
    const row = document.createElement("tr");
    addCell(row, bus.id);
    addCell(row, bus.towards);
    addCell(row, bus.along == null ? "—" : formatMetres(bus.along));
    addCell(row, bus.gap == null ? "—" : formatMetres(bus.gap));
    addCell(row, formatDelay(bus.delay, state.config.onTimeSeconds), Number.isFinite(bus.delay) && bus.delay >= state.config.onTimeSeconds ? "late" : "");
    if (showSpeed) addCell(row, `${bus.kph} km/h`);
    else addCell(row, "—");
    addCell(row, bus.age == null ? "—" : `${bus.age} s`, Number.isFinite(bus.age) && bus.age > state.config.staleSeconds ? "stale" : "");
    body.append(row);
  }
  if (!buses.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No vehicles in this capture for that route.";
    row.append(cell);
    body.append(row);
  }
}

function renderAlerts(result) {
  const list = document.querySelector("#alerts");
  clear(list);
  const alerts = result.alerts || [];
  if (!alerts.length) {
    const item = document.createElement("li");
    item.textContent = "No alert in this capture names this route.";
    list.append(item);
    return;
  }
  for (const alert of alerts) {
    const item = document.createElement("li");
    item.textContent = alert.effect ? `${alert.effect}: ${alert.header}` : alert.header;
    list.append(item);
  }
}

function renderCompare(capture, earlier) {
  const note = document.querySelector("#compare");
  const body = document.querySelector("#deltas");
  clear(body);
  if (!earlier || earlier.id === capture.id) {
    text(note, "Only one capture is saved, so there is no earlier fleet to compare.");
    return;
  }
  const report = compareCaptures(capture, earlier, (id) => labelFor(state.network.routes, id));
  text(note, report.note);
  for (const change of report.changes.slice(0, 12)) {
    const row = document.createElement("tr");
    addCell(row, change.label);
    addCell(row, String(change.before));
    addCell(row, String(change.after));
    const delta = change.after - change.before;
    addCell(row, delta > 0 ? `+${delta}` : String(delta));
    body.append(row);
  }
}

function render() {
  const capture = state.captures.get(document.querySelector("#capture").value);
  if (!capture) {
    text(finding, "No capture has been saved yet.");
    return;
  }
  const entry = state.index.captures.find((item) => item.id === capture.id);
  document.querySelector("#banner").hidden = capture.kind !== "sample";
  text(
    document.querySelector("#edition"),
    `${capture.kind === "sample" ? "Illustrated" : "Live"} capture · ${formatPacific(capture.captured)} Pacific · ${capture.vehicles.length} buses · ${entry?.routes ?? "—"} routes`,
  );
  const result = inspectRoute({
    capture,
    routes: state.network.routes,
    query: state.query,
    limits: state.config,
  });
  text(finding, result.sentence);
  text(document.querySelector("#stat-buses"), result.vehicles ? String(result.vehicles.length) : "—");
  text(document.querySelector("#stat-gap"), result.closest ? formatMetres(result.closest.metres) : "—");
  text(document.querySelector("#stat-delay"), result.delayMedian == null ? "—" : formatDelay(result.delayMedian, state.config.onTimeSeconds));
  text(document.querySelector("#stat-cancel"), result.canceled == null ? "—" : String(result.canceled));
  drawMap(result, capture.vehicles);
  renderTracks(result);
  renderTable(result);
  renderAlerts(result);
  const earlierId = document.querySelector("#earlier").value;
  renderCompare(capture, earlierId ? state.captures.get(earlierId) : null);
  renderChips(state.config.watchlist.filter((label) => state.network.routes.some((route) => route.label === label)));
  const frame = document.querySelector("#frame");
  frame.textContent = state.frame === "region" ? "Fit this route" : "Whole region";
  frame.setAttribute("aria-pressed", String(state.frame === "region"));
}

async function ensure(id) {
  if (!id || state.captures.has(id)) return;
  const entry = state.index.captures.find((item) => item.id === id);
  if (!entry) return;
  state.captures.set(id, await loadJson(`./data/${entry.file}`));
}

async function show() {
  const selected = document.querySelector("#capture").value;
  const earlier = document.querySelector("#earlier").value;
  await ensure(selected);
  await ensure(earlier);
  render();
}

async function init() {
  const [index, network, config] = await Promise.all([
    loadJson("./data/index.json"),
    loadJson("./data/network.json"),
    loadJson("./config.json"),
  ]);
  state.index = index;
  state.network = network;
  state.config = config;
  const names = document.querySelector("#route-names");
  for (const label of sortLabels(network.routes.map((route) => route.label))) {
    const option = document.createElement("option");
    option.value = label;
    names.append(option);
  }
  const entries = index.captures || [];
  if (!entries.length) {
    text(finding, "No capture has been saved yet. Run the fleet refresh to collect one.");
    return;
  }
  fillSelect(document.querySelector("#capture"), entries, entries[0].id);
  const earlier = entries[1] ? entries[1].id : entries[0].id;
  fillSelect(document.querySelector("#earlier"), entries, earlier);
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  state.query = hash || "99";
  document.querySelector("#route").value = state.query;
  await show();
}

document.querySelector("#route").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});
document.querySelector("#capture").addEventListener("change", () => {
  show().catch((error) => text(finding, error.message));
});
document.querySelector("#earlier").addEventListener("change", () => {
  show().catch((error) => text(finding, error.message));
});
document.querySelector("#frame").addEventListener("click", () => {
  state.frame = state.frame === "region" ? "route" : "region";
  render();
});
document.querySelector("#route").addEventListener("change", () => {
  const matched = state.query.trim();
  if (matched) history.replaceState(null, "", `#${encodeURIComponent(matched)}`);
});
window.addEventListener("resize", () => {
  if (state.map) state.map.resize();
});

init().catch((error) => text(finding, error.message || "The saved captures did not load."));
