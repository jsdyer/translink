"""Decode a GTFS-Realtime feed with the standard library.

Field numbers follow the GTFS-Realtime proto: trip route_id is 5 and
direction_id is 6. The API key is never read or logged here.
"""
import json
import struct

OCCUPANCY = {
    0: "empty",
    1: "many seats",
    2: "few seats",
    3: "standing room",
    4: "crushed",
    5: "full",
    6: "not accepting",
    7: "no data",
    8: "not boardable",
}
STOP_STATUS = {0: "incoming", 1: "stopped", 2: "in transit"}
EFFECT = {
    1: "no service",
    2: "reduced service",
    3: "significant delays",
    4: "detour",
    5: "additional service",
    6: "modified service",
    7: "other",
    8: "unknown",
    9: "stop moved",
    10: "no effect",
    11: "accessibility",
}


def _varint(buf, i):
    shift = 0
    value = 0
    while True:
        if i >= len(buf):
            raise ValueError("Truncated varint")
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7
        if shift > 70:
            raise ValueError("Varint too long")


def _signed(value):
    if value >= 1 << 63:
        value -= 1 << 64
    return value


def read_fields(buf):
    fields = []
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            if i + 8 > len(buf):
                raise ValueError("Truncated 64-bit field")
            value = buf[i : i + 8]
            i += 8
        elif wire == 2:
            length, i = _varint(buf, i)
            if i + length > len(buf):
                raise ValueError("Truncated length-delimited field")
            value = buf[i : i + length]
            i += length
        elif wire == 5:
            if i + 4 > len(buf):
                raise ValueError("Truncated 32-bit field")
            value = buf[i : i + 4]
            i += 4
        else:
            raise ValueError(f"Unsupported protobuf wire type {wire}")
        fields.append((number, wire, value))
    return fields


def _sub(fields, number):
    return [value for num, wire, value in fields if num == number and wire == 2]


def _first(fields, number):
    found = _sub(fields, number)
    return found[0] if found else None


def _var(fields, number):
    for num, wire, value in fields:
        if num == number and wire == 0:
            return value
    return None


def _text(fields, number):
    raw = _first(fields, number)
    return raw.decode("utf-8", "replace") if raw is not None else None


def _float(fields, number):
    for num, wire, value in fields:
        if num == number and wire == 5:
            return struct.unpack("<f", value)[0]
    return None


def _message(fields, number):
    raw = _first(fields, number)
    return read_fields(raw) if raw is not None else None


def _translation(raw):
    if raw is None:
        return None
    best = None
    for chunk in _sub(read_fields(raw), 1):
        fields = read_fields(chunk)
        text = _text(fields, 1)
        if not text:
            continue
        language = (_text(fields, 2) or "").lower()
        if language.startswith("en") or best is None:
            best = text.strip()
        if language.startswith("en"):
            break
    return best


def _trip(raw):
    if raw is None:
        return {}
    fields = read_fields(raw)
    relationship = _var(fields, 4)
    return {
        "trip_id": _text(fields, 1),
        "start_time": _text(fields, 2),
        "start_date": _text(fields, 3),
        "schedule_relationship": relationship,
        "route_id": _text(fields, 5),
        "direction_id": None if _var(fields, 6) is None else str(_var(fields, 6)),
        "canceled": relationship in (3, 7),
    }


def _delay(fields):
    direct = _var(fields, 5)
    if direct is not None:
        return _signed(direct)
    for raw in _sub(fields, 2):
        stop = read_fields(raw)
        for event_field in (3, 2):
            event = _message(stop, event_field)
            if event is None:
                continue
            delay = _var(event, 1)
            if delay is not None:
                return _signed(delay)
    return None


def parse_feed(buf):
    if not buf:
        raise ValueError("Empty realtime payload")
    if buf[:1] in (b"{", b"["):
        return _parse_json(json.loads(buf))
    root = read_fields(buf)
    header = _message(root, 1) or []
    timestamp = _var(header, 3)
    vehicles = []
    trips = []
    alerts = []
    for raw in _sub(root, 2):
        entity = read_fields(raw)
        if _var(entity, 2):
            continue
        vehicle = _message(entity, 4)
        if vehicle is not None:
            parsed = _vehicle(vehicle)
            if parsed:
                vehicles.append(parsed)
        update = _message(entity, 3)
        if update is not None:
            trips.append(_trip_update(update))
        alert = _message(entity, 5)
        if alert is not None:
            parsed = _alert(alert)
            if parsed:
                alerts.append(parsed)
    return {"timestamp": timestamp, "vehicles": vehicles, "trips": trips, "alerts": alerts}


def _vehicle(fields):
    trip = _trip(_first(fields, 1))
    position = _message(fields, 2)
    lat = lon = bearing = speed = None
    if position is not None:
        lat = _float(position, 1)
        lon = _float(position, 2)
        bearing = _float(position, 3)
        speed = _float(position, 5)
    descriptor = _message(fields, 8)
    vehicle_id = _text(descriptor, 1) if descriptor else None
    label = _text(descriptor, 2) if descriptor else None
    status = _var(fields, 4)
    occupancy = _var(fields, 9)
    return {
        "id": label or vehicle_id,
        "route_id": trip.get("route_id"),
        "trip_id": trip.get("trip_id"),
        "direction": trip.get("direction_id"),
        "lat": lat,
        "lon": lon,
        "bearing": None if bearing is None else round(bearing),
        "mps": speed,
        "timestamp": _var(fields, 5),
        "status": STOP_STATUS.get(status or 2, "in transit"),
        "occupancy": OCCUPANCY.get(occupancy) if occupancy is not None else None,
    }


def _trip_update(fields):
    trip = _trip(_first(fields, 1))
    trip["delay"] = _delay(fields)
    return trip


def _alert(fields):
    routes = []
    for raw in _sub(fields, 5):
        route_id = _text(read_fields(raw), 2)
        if route_id:
            routes.append(route_id)
    header = _translation(_first(fields, 10))
    effect = EFFECT.get(_var(fields, 7) or 8, "unknown")
    if not header and effect in (None, "unknown"):
        return None
    return {"routes": routes, "header": header or effect, "effect": effect}


def _parse_json(obj):
    """Accept proto3 JSON if a feed is ever served that way."""
    if isinstance(obj, list):
        obj = {"entity": obj}
    entities = obj.get("entity") or []
    vehicles = []
    trips = []
    alerts = []
    for entity in entities:
        if entity.get("isDeleted"):
            continue
        vehicle = entity.get("vehicle")
        if vehicle:
            trip = vehicle.get("trip") or {}
            pos = vehicle.get("position") or {}
            desc = vehicle.get("vehicle") or {}
            vehicles.append(
                {
                    "id": desc.get("label") or desc.get("id"),
                    "route_id": trip.get("routeId"),
                    "trip_id": trip.get("tripId"),
                    "direction": None if trip.get("directionId") is None else str(trip.get("directionId")),
                    "lat": pos.get("latitude"),
                    "lon": pos.get("longitude"),
                    "bearing": pos.get("bearing"),
                    "mps": pos.get("speed"),
                    "timestamp": vehicle.get("timestamp"),
                    "status": str(vehicle.get("currentStatus") or "in transit").replace("_", " ").lower(),
                    "occupancy": None,
                }
            )
        update = entity.get("tripUpdate")
        if update:
            trip = update.get("trip") or {}
            relationship = str(trip.get("scheduleRelationship") or "")
            trips.append(
                {
                    "trip_id": trip.get("tripId"),
                    "route_id": trip.get("routeId"),
                    "direction_id": None if trip.get("directionId") is None else str(trip.get("directionId")),
                    "canceled": relationship in ("CANCELED", "DELETED"),
                    "delay": update.get("delay"),
                }
            )
        alert = entity.get("alert")
        if alert:
            header = ((alert.get("headerText") or {}).get("translation") or [{}])[0].get("text")
            routes = [item.get("routeId") for item in alert.get("informedEntity") or [] if item.get("routeId")]
            if header or routes:
                alerts.append({"routes": routes, "header": header or "Alert", "effect": str(alert.get("effect") or "unknown").lower()})
    header = obj.get("header") or {}
    return {"timestamp": header.get("timestamp"), "vehicles": vehicles, "trips": trips, "alerts": alerts}
