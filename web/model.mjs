// Transformations only. The page renders the objects returned here.

const EARTH = 6371000;

export function formatDelay(seconds, onTimeSeconds = 60) {
  if (seconds == null || !Number.isFinite(seconds)) return "no prediction";
  const rounded = Math.round(seconds);
  if (Math.abs(rounded) < onTimeSeconds) return "on time";
  const minutes = Math.round(Math.abs(rounded) / 60);
  return rounded > 0 ? `${minutes} min late` : `${minutes} min early`;
}

export function formatMetres(metres) {
  if (!Number.isFinite(metres)) return "unknown";
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function formatPacific(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function sortLabels(labels) {
  return [...labels].sort((a, b) => {
    const na = /^\d+$/.test(a);
    const nb = /^\d+$/.test(b);
    if (na && nb) return Number(a) - Number(b);
    if (na) return -1;
    if (nb) return 1;
    return a.localeCompare(b, "en-CA");
  });
}

export function matchRoutes(query, routes) {
  if (typeof query !== "string" || !Array.isArray(routes)) throw new TypeError("Expected a route query");
  const text = query.trim();
  if (!text) return [];
  const fold = (value) => value.toLocaleLowerCase("en-CA");
  const wanted = fold(text);
  const exact = routes.filter((route) => fold(route.label) === wanted || fold(route.name) === wanted || route.id === text);
  if (exact.length) return exact;
  if (/^\d+$/.test(text)) {
    const number = String(Number(text));
    return routes.filter((route) => route.label === number);
  }
  if (wanted.length >= 4) {
    return routes.filter((route) => fold(route.label).startsWith(wanted) || fold(route.name).startsWith(wanted));
  }
  return [];
}

function toXY(lat, lon, refLat) {
  const rad = Math.PI / 180;
  return [lon * rad * Math.cos(refLat * rad) * EARTH, lat * rad * EARTH];
}

export function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function projectOnto(lat, lon, line) {
  if (!Array.isArray(line) || line.length < 2) return null;
  const ref = line[0][0];
  const point = toXY(lat, lon, ref);
  let walked = 0;
  let best = null;
  for (let i = 1; i < line.length; i += 1) {
    const start = toXY(line[i - 1][0], line[i - 1][1], ref);
    const end = toXY(line[i][0], line[i][1], ref);
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const len2 = dx * dx + dy * dy;
    const length = Math.sqrt(len2);
    let t = 0;
    if (len2 > 0) t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = start[0] + dx * t;
    const qy = start[1] + dy * t;
    const offset = Math.hypot(point[0] - qx, point[1] - qy);
    const along = walked + length * t;
    if (!best || offset < best.offset) best = { along, offset };
    walked += length;
  }
  return { along: best.along, offset: best.offset, length: walked };
}

export function boundsFor(points, mode = "route") {
  const region = { south: 49, north: 49.4, west: -123.28, east: -122.25 };
  if (mode === "region" || !points.length) return region;
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const [lat, lon] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }
  const latPad = Math.max(0.012, (north - south) * 0.2);
  const lonPad = Math.max(0.016, (east - west) * 0.2);
  let nextSouth = south - latPad;
  let nextNorth = north + latPad;
  let nextWest = west - lonPad;
  let nextEast = east + lonPad;
  if (nextNorth - nextSouth < 0.04) {
    const mid = (nextNorth + nextSouth) / 2;
    nextSouth = mid - 0.02;
    nextNorth = mid + 0.02;
  }
  if (nextEast - nextWest < 0.05) {
    const mid = (nextEast + nextWest) / 2;
    nextWest = mid - 0.025;
    nextEast = mid + 0.025;
  }
  return { south: nextSouth, north: nextNorth, west: nextWest, east: nextEast };
}

function lineLimit(limits) {
  return Number.isFinite(limits?.lineMetres) ? limits.lineMetres : 80;
}

function canceledCount(capture, routeId) {
  const summary = capture.summary && capture.summary[routeId];
  if (summary && Number.isFinite(summary.canceled)) return summary.canceled;
  return (capture.canceled || []).filter((item) => item.routeId === routeId).length;
}

function place(vehicle, shapes) {
  const directions = shapes ? Object.keys(shapes) : [];
  if (!directions.length) return null;
  const preferred = vehicle.direction != null && shapes[vehicle.direction] ? [vehicle.direction] : [];
  const order = [...preferred, ...directions.filter((key) => !preferred.includes(key))];
  let best = null;
  for (const key of order) {
    const projected = projectOnto(vehicle.lat, vehicle.lon, shapes[key]);
    if (!projected) continue;
    const candidate = { ...projected, direction: key };
    if (!best || candidate.offset < best.offset) best = candidate;
    if (preferred.includes(key) && candidate.offset <= 700) break;
  }
  if (!best || best.offset > 1200) return null;
  return best;
}

export function inspectRoute({ capture, routes, query, limits }) {
  if (!capture || !Array.isArray(capture.vehicles)) throw new TypeError("Expected a capture");
  const matched = matchRoutes(query, routes);
  if (!query.trim()) return { status: "empty", sentence: "Choose a route. A number such as 99 or a name such as Expo Line both work." };
  if (!matched.length) {
    return { status: "unknown", sentence: `No saved route matches “${query.trim()}”. Try 99, R5, Expo Line or SeaBus.` };
  }
  if (matched.length > 1) {
    return {
      status: "ambiguous",
      matches: matched.map((route) => route.label),
      sentence: `“${query.trim()}” matches ${matched.map((route) => route.label).join(", ")}. Choose one.`,
    };
  }
  const route = matched[0];
  const vehicles = capture.vehicles.filter((vehicle) => vehicle.routeId === route.id);
  const shapes = route.shapes || null;
  const lineSaved = Boolean(shapes && Object.keys(shapes).length);
  const lineMetres = lineLimit(limits);
  const placed = vehicles.map((vehicle) => ({ ...vehicle, place: place(vehicle, shapes) }));
  const byDirection = new Map();
  for (const vehicle of placed) {
    const key = vehicle.place ? vehicle.place.direction : vehicle.direction || "unknown";
    if (!byDirection.has(key)) byDirection.set(key, []);
    byDirection.get(key).push(vehicle);
  }
  const directions = [];
  let closest = null;
  for (const [key, group] of byDirection) {
    const named = route.dir && route.dir[key] ? route.dir[key] : key === "unknown" ? "unknown direction" : `direction ${key}`;
    const snug = group.filter((vehicle) => vehicle.place && vehicle.place.offset <= lineMetres);
    const along = snug.length >= 2;
    const ordered = along ? [...snug].sort((a, b) => a.place.along - b.place.along) : [...group];
    const trail = along ? group.filter((vehicle) => !snug.includes(vehicle)) : [];
    if (!along && group.length >= 2) {
      let best = null;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const metres = haversine([group[i].lat, group[i].lon], [group[j].lat, group[j].lon]);
          if (!best || metres < best.metres) best = { metres, direction: named, along: false };
        }
      }
      if (best && (!closest || best.metres < closest.metres)) closest = best;
    }
    const buses = ordered.map((vehicle, index) => {
      const next = ordered[index + 1];
      let gap = null;
      if (next && along) {
        const alongGap = next.place.along - vehicle.place.along;
        const bird = haversine([vehicle.lat, vehicle.lon], [next.lat, next.lon]);
        // A simplified shape can stack two buses that are still a block apart.
        const faithful = alongGap + 25 >= bird;
        gap = faithful ? Math.max(alongGap, bird) : bird;
        if (!closest || gap < closest.metres) closest = { metres: gap, direction: named, along: faithful };
      }
      return {
        id: vehicle.id,
        fraction: along && vehicle.place.length ? vehicle.place.along / vehicle.place.length : null,
        along: along ? vehicle.place.along : null,
        gap,
        delay: vehicle.delay ?? null,
        age: vehicle.age ?? null,
        kph: vehicle.kph ?? null,
        status: vehicle.status || "",
        occupancy: vehicle.occupancy || "",
        lat: vehicle.lat,
        lon: vehicle.lon,
      };
    });
    directions.push({
      id: key,
      name: named,
      along,
      length: along ? snug[0].place.length : null,
      buses: [...buses, ...trail.map((vehicle) => ({
        id: vehicle.id,
        fraction: null,
        along: null,
        gap: null,
        delay: vehicle.delay ?? null,
        age: vehicle.age ?? null,
        kph: vehicle.kph ?? null,
        status: vehicle.status || "",
        occupancy: vehicle.occupancy || "",
        lat: vehicle.lat,
        lon: vehicle.lon,
      }))],
    });
  }
  const delays = vehicles.map((vehicle) => vehicle.delay).filter((value) => Number.isFinite(value));
  const delayMedian = median(delays);
  const stale = vehicles.filter((vehicle) => Number.isFinite(vehicle.age) && vehicle.age > limits.staleSeconds).length;
  const canceled = canceledCount(capture, route.id);
  const alerts = (capture.alerts || []).filter((alert) => (alert.routes || []).includes(route.id));
  const offLine = placed.filter((vehicle) => lineSaved && !vehicle.place).length;
  let sentence;
  if (!vehicles.length) {
    const title = route.name && route.name !== route.label ? `${route.label}, ${route.name}` : route.label;
    sentence = capture.coverage === "full"
      ? `No vehicle on the ${title} reported a position in this capture.`
      : `This capture does not include the ${title}.`;
    if (!lineSaved) sentence += " No line is saved for this route.";
  } else {
    sentence = describe({ route, count: vehicles.length, closest, delayMedian, canceled, stale, lineSaved, limits });
  }
  return {
    status: vehicles.length ? "ok" : "none",
    route,
    vehicles: placed,
    directions,
    delayMedian,
    canceled,
    stale,
    alerts,
    lineSaved,
    offLine,
    closest,
    sentence,
  };
}

function describe({ route, count, closest, delayMedian, canceled, stale, lineSaved, limits }) {
  const title = route.name && route.name !== route.label ? `${route.label}, ${route.name}` : route.label;
  const parts = [`${count} ${count === 1 ? "bus is" : "buses are"} reporting on the ${title}.`];
  if (closest) {
    const bunched = closest.metres <= limits.bunchMeters;
    const how = closest.along ? "along the saved line" : "as the crow flies";
    const towards = closest.direction && closest.direction !== "unknown direction" ? ` towards ${closest.direction}` : "";
    parts.push(
      `The closest two${towards} are ${bunched ? "bunched, " : ""}${formatMetres(closest.metres)} apart ${how}.`,
    );
  }
  if (delayMedian != null) parts.push(`Median delay ${formatDelay(delayMedian, limits.onTimeSeconds)}.`);
  if (canceled) parts.push(`${canceled} ${canceled === 1 ? "trip is" : "trips are"} cancelled.`);
  if (stale) parts.push(`${stale} ${stale === 1 ? "position is" : "positions are"} stale.`);
  if (!lineSaved) parts.push("No line is saved for this route.");
  return parts.join(" ");
}

function counts(capture, labelFor) {
  const map = new Map();
  for (const vehicle of capture.vehicles || []) {
    const label = labelFor(vehicle.routeId) || vehicle.routeId || "unknown";
    map.set(label, (map.get(label) || 0) + 1);
  }
  return map;
}

export function compareCaptures(newer, older, labelFor) {
  if (!newer || !older) return { changes: [], note: "Only one capture is saved, so there is no earlier fleet to compare.", exclusive: [] };
  const left = counts(newer, labelFor);
  const right = counts(older, labelFor);
  const full = newer.coverage === "full" && older.coverage === "full";
  const labels = full
    ? new Set([...left.keys(), ...right.keys()])
    : new Set([...left.keys()].filter((label) => right.has(label)));
  const exclusive = full
    ? []
    : [...new Set([...left.keys(), ...right.keys()].filter((label) => !left.has(label) || !right.has(label)))].sort((a, b) => a.localeCompare(b, "en-CA"));
  const changes = [...labels]
    .map((label) => ({ label, before: right.get(label) || 0, after: left.get(label) || 0 }))
    .filter((row) => row.before !== row.after)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || a.label.localeCompare(b.label, "en-CA"));
  const note = exclusive.length
    ? `Left out of the difference because the captures do not cover the same routes: ${exclusive.join(", ")}. A route missing from one of them is not counted as zero.`
    : full
      ? "Both captures are full fleet readings, so a route that disappeared is counted as zero."
      : "These captures cover the same routes.";
  return { changes, note, exclusive };
}
