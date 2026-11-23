import { boundsFor, compareCaptures, formatDelay, formatMetres, formatPacific, inspectRoute, sortLabels } from "./model.mjs";

const ANCHORS = [
  ["Waterfront", 49.2859, -123.1117],
  ["UBC", 49.2665, -123.2496],
  ["Metrotown", 49.2256, -123.0036],
  ["Lougheed", 49.2483, -122.8969],
  ["Surrey Central", 49.1897, -122.8479],
  ["Richmond", 49.1681, -123.1364],
  ["Phibbs", 49.3095, -123.0253],
  ["Maple Ridge", 49.219, -122.599],
  ["Lonsdale", 49.3101, -123.0828],
];
const NS = "http://www.w3.org/2000/svg";
const finding = document.querySelector("#finding");
const state = { captures: new Map(), frame: "route", query: "99" };

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

function drawMap(result, allVehicles) {
  const svg = document.querySelector("#map");
  clear(svg);
  const points = [];
  const line = [];
  if (result.route?.shapes) {
    for (const shape of Object.values(result.route.shapes)) line.push(...shape);
  }
  for (const vehicle of result.vehicles || []) points.push([vehicle.lat, vehicle.lon]);
  const fitted = state.frame === "region" ? boundsFor(allVehicles.map((item) => [item.lat, item.lon]), "region") : boundsFor([...points, ...line], "route");
  const width = 1000;
  const height = 620;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const project = (lat, lon) => [
    ((lon - fitted.west) / (fitted.east - fitted.west)) * width,
    ((fitted.north - lat) / (fitted.north - fitted.south)) * height,
  ];
  const backdrop = document.createElementNS(NS, "rect");
  backdrop.setAttribute("width", String(width));
  backdrop.setAttribute("height", String(height));
  backdrop.setAttribute("fill", "#e7efe8");
  svg.append(backdrop);
  if (result.route?.shapes) {
    for (const shape of Object.values(result.route.shapes)) {
      const poly = document.createElementNS(NS, "polyline");
      poly.setAttribute("points", shape.map(([lat, lon]) => project(lat, lon).join(",")).join(" "));
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", colorOf(result.route.color));
      poly.setAttribute("stroke-width", "4");
      poly.setAttribute("stroke-linejoin", "round");
      poly.setAttribute("stroke-linecap", "round");
      svg.append(poly);
    }
  }
  for (const [name, lat, lon] of ANCHORS) {
    if (lat < fitted.south || lat > fitted.north || lon < fitted.west || lon > fitted.east) continue;
    const [x, y] = project(lat, lon);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(x + 6));
    label.setAttribute("y", String(y - 6));
    label.setAttribute("fill", "#4d5e59");
    label.setAttribute("font-size", "18");
    label.textContent = name;
    svg.append(label);
  }
  const seen = new Set((result.vehicles || []).map((vehicle) => vehicle.id));
  if (state.frame === "region") {
    for (const vehicle of allVehicles) {
      if (seen.has(vehicle.id)) continue;
      const dot = document.createElementNS(NS, "circle");
      const [x, y] = project(vehicle.lat, vehicle.lon);
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", "3.5");
      dot.setAttribute("fill", "#8aa097");
      svg.append(dot);
    }
  }
  for (const vehicle of result.vehicles || []) {
    const dot = document.createElementNS(NS, "circle");
    const [x, y] = project(vehicle.lat, vehicle.lon);
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", "7");
    dot.setAttribute("fill", colorOf(result.route?.color));
    dot.setAttribute("stroke", "#1b2826");
    dot.setAttribute("stroke-width", "1.5");
    svg.append(dot);
  }
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
    const closest = result.closest && result.closest.along ? result.closest.metres : null;
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
  for (const bus of buses) {
    const row = document.createElement("tr");
    addCell(row, bus.id);
    addCell(row, bus.towards);
    addCell(row, bus.along == null ? "—" : formatMetres(bus.along));
    addCell(row, bus.gap == null ? "—" : formatMetres(bus.gap));
    addCell(row, formatDelay(bus.delay, state.config.onTimeSeconds), Number.isFinite(bus.delay) && bus.delay >= state.config.onTimeSeconds ? "late" : "");
    addCell(row, bus.kph == null ? "—" : `${bus.kph} km/h`);
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

init().catch((error) => text(finding, error.message || "The saved captures did not load."));
