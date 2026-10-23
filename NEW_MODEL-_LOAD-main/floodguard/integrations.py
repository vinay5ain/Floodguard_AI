from __future__ import annotations

import json
import math
import os
import re
import socket
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable

from .risk_engine import haversine_km


class IntegrationError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class TTLCache:
    """Small process-local cache; no source data is persisted to disk."""

    def __init__(self, max_entries: int = 256):
        self.max_entries = max_entries
        self._items: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        now = time.monotonic()
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            expires, value = item
            if expires <= now:
                self._items.pop(key, None)
                return None
            self._items.move_to_end(key)
            return value

    def set(self, key: str, value: Any, ttl_seconds: float) -> None:
        with self._lock:
            self._items[key] = (time.monotonic() + ttl_seconds, value)
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)


def _json_request(
    url: str,
    *,
    timeout: float,
    headers: dict[str, str] | None = None,
    max_bytes: int = 2 * 1024 * 1024,
) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", **(headers or {})},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise IntegrationError(f"Upstream service returned HTTP {response.status}.")
            content_type = response.headers.get("Content-Type", "").lower()
            if "json" not in content_type:
                raise IntegrationError("Upstream service returned a non-JSON response.")
            body = response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        raise IntegrationError(f"Upstream service returned HTTP {error.code}.") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            raise IntegrationError("Upstream service request timed out.", 504) from None
        raise IntegrationError("Could not connect to the upstream service.") from None
    except OSError:
        raise IntegrationError("Could not read the upstream response.") from None
    if len(body) > max_bytes:
        raise IntegrationError("Upstream response exceeded the configured size limit.")
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise IntegrationError("Upstream service returned malformed JSON.") from None


def _valid_coordinate_pair(latitude: Any, longitude: Any) -> tuple[float, float] | None:
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(lat) or not math.isfinite(lon):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


class WeatherService:
    def __init__(self) -> None:
        self.cache = TTLCache(128)

    def fetch(self, latitude: float, longitude: float) -> dict[str, Any]:
        cache_key = f"{latitude:.4f},{longitude:.4f}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        endpoint = os.environ.get("OPEN_METEO_ENDPOINT", "https://api.open-meteo.com/v1/forecast")
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            raise IntegrationError("OPEN_METEO_ENDPOINT must be a valid HTTPS URL.", 500)
        params = urllib.parse.urlencode(
            {
                "latitude": f"{latitude:.5f}",
                "longitude": f"{longitude:.5f}",
                "current": (
                    "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,"
                    "precipitation,rain,showers,wind_speed_10m,weather_code"
                ),
                "hourly": "precipitation,precipitation_probability,temperature_2m",
                "daily": (
                    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,"
                    "precipitation_probability_max,wind_speed_10m_max"
                ),
                "forecast_days": "7",
                "past_days": "1",
                "timezone": "auto",
            }
        )
        payload = _json_request(f"{endpoint}?{params}", timeout=12, max_bytes=2 * 1024 * 1024)
        if not isinstance(payload, dict):
            raise IntegrationError("Open-Meteo returned an unexpected response shape.")
        current = payload.get("current")
        hourly = payload.get("hourly")
        daily = payload.get("daily")
        if (
            not isinstance(current, dict)
            or not isinstance(hourly, dict)
            or not isinstance(daily, dict)
            or not isinstance(hourly.get("time"), list)
            or not isinstance(hourly.get("precipitation"), list)
            or len(hourly["time"]) != len(hourly["precipitation"])
            or not isinstance(daily.get("time"), list)
            or not isinstance(daily.get("precipitation_sum"), list)
            or len(daily["time"]) != len(daily["precipitation_sum"])
        ):
            raise IntegrationError("Open-Meteo response is missing required forecast fields.")
        payload["retrieved_at_utc"] = datetime.now(timezone.utc).isoformat()
        payload["source"] = "Open-Meteo Forecast API"
        self.cache.set(cache_key, payload, 600)
        return payload


class GeocodingService:
    """User-triggered, cached Nominatim searches with a one-request-per-second cap."""

    def __init__(self) -> None:
        self.cache = TTLCache(256)
        self._lock = threading.Lock()
        self._last_request = 0.0

    def search(self, query: str) -> list[dict[str, Any]]:
        query = " ".join(query.split())
        if not query or len(query) > 120:
            raise ValueError("Enter a location between 1 and 120 characters.")
        key = query.casefold()
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        with self._lock:
            wait = 1.0 - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()
        endpoint = os.environ.get(
            "GEOCODING_ENDPOINT", "https://nominatim.openstreetmap.org/search"
        )
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            raise IntegrationError("GEOCODING_ENDPOINT must be a valid HTTPS URL.", 500)
        params = urllib.parse.urlencode(
            {"q": query, "format": "jsonv2", "addressdetails": "1", "countrycodes": "in", "limit": "5"}
        )
        results = _json_request(
            f"{endpoint}?{params}",
            timeout=10,
            headers={"User-Agent": "FloodGuardAI/1.0 (India urban flood awareness application)"},
            max_bytes=512 * 1024,
        )
        if not isinstance(results, list):
            raise IntegrationError("The geocoding service returned an unexpected response shape.")
        normalized: list[dict[str, Any]] = []
        for result in results[:5]:
            if not isinstance(result, dict):
                continue
            pair = _valid_coordinate_pair(result.get("lat"), result.get("lon"))
            display_name = result.get("display_name")
            address = result.get("address")
            if pair is None or not isinstance(display_name, str) or not isinstance(address, dict):
                continue
            normalized.append(
                {
                    "latitude": pair[0],
                    "longitude": pair[1],
                    "display_name": display_name[:300],
                    "address": {
                        str(key): str(value)[:100]
                        for key, value in address.items()
                        if isinstance(value, (str, int, float))
                    },
                    "osm_type": str(result.get("osm_type", ""))[:20],
                    "osm_id": str(result.get("osm_id", ""))[:32],
                }
            )
        self.cache.set(key, normalized, 24 * 60 * 60)
        return normalized

    def reverse(self, latitude: float, longitude: float) -> dict[str, Any]:
        key = f"reverse:{latitude:.5f},{longitude:.5f}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        with self._lock:
            wait = 1.0 - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()
        endpoint = os.environ.get("GEOCODING_REVERSE_ENDPOINT")
        if not endpoint:
            search_endpoint = os.environ.get(
                "GEOCODING_ENDPOINT", "https://nominatim.openstreetmap.org/search"
            )
            endpoint = search_endpoint.rsplit("/", 1)[0] + "/reverse"
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            raise IntegrationError("GEOCODING_REVERSE_ENDPOINT must be a valid HTTPS URL.", 500)
        params = urllib.parse.urlencode(
            {
                "lat": f"{latitude:.5f}",
                "lon": f"{longitude:.5f}",
                "format": "jsonv2",
                "addressdetails": "1",
            }
        )
        result = _json_request(
            f"{endpoint}?{params}",
            timeout=10,
            headers={"User-Agent": "FloodGuardAI/1.0 (India urban flood awareness application)"},
            max_bytes=512 * 1024,
        )
        if not isinstance(result, dict) or not isinstance(result.get("address"), dict):
            raise IntegrationError("The reverse-geocoding service returned an unexpected response shape.")
        normalized = {
            "latitude": latitude,
            "longitude": longitude,
            "display_name": str(result.get("display_name") or "Current location")[:300],
            "address": {
                str(key): str(value)[:100]
                for key, value in result["address"].items()
                if isinstance(value, (str, int, float))
            },
            "osm_type": str(result.get("osm_type", ""))[:20],
            "osm_id": str(result.get("osm_id", ""))[:32],
        }
        self.cache.set(key, normalized, 24 * 60 * 60)
        return normalized


def _normalize_place(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_marks = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(re.findall(r"[a-z0-9]+", without_marks))


def _location_names(location: dict[str, Any]) -> list[tuple[str, str]]:
    names: list[tuple[str, str]] = []
    address = location.get("address")
    if not isinstance(address, dict):
        address = {}
    for key in ("neighbourhood", "suburb", "city_district", "village", "town", "city", "municipality"):
        value = address.get(key)
        if isinstance(value, str) and value.strip():
            names.append(("local", value))
    for key in ("district", "county"):
        value = address.get(key)
        if isinstance(value, str) and value.strip():
            names.append(("district", value))
    for key in ("state", "state_district"):
        value = address.get(key)
        if isinstance(value, str) and value.strip():
            names.append(("state", value))
    # Use structured geocoder components for matching. Splitting the entire
    # display label into locality names could promote a state name to a city match.
    if not names:
        name = location.get("name")
        if isinstance(name, str) and name.strip():
            names.append(("local", name.strip()))
    unique: list[tuple[str, str]] = []
    seen: set[str] = set()
    for kind, name in names:
        normalized = _normalize_place(name)
        if normalized and normalized not in seen and normalized not in {"india", "bharat"}:
            seen.add(normalized)
            unique.append((kind, name.strip()))
    return unique


def _alert_coordinates(record: dict[str, Any]) -> tuple[float, float] | None:
    for obj in (record, record.get("location")):
        if isinstance(obj, dict):
            pair = _valid_coordinate_pair(
                obj.get("latitude", obj.get("lat")), obj.get("longitude", obj.get("lon", obj.get("lng")))
            )
            if pair is not None:
                return pair
    geometry = record.get("geometry")
    if isinstance(geometry, dict) and str(geometry.get("type", "")).casefold() == "point":
        coordinates = geometry.get("coordinates")
        if isinstance(coordinates, (list, tuple)) and len(coordinates) == 2:
            # GeoJSON Point coordinates are [longitude, latitude].
            pair = _valid_coordinate_pair(coordinates[1], coordinates[0])
            if pair is not None:
                return pair
    # The current public SACHET response exposes its point as "centroid" in
    # longitude,latitude order. Validate the live field rather than geocoding
    # area text or assuming a geometry for records where it is absent.
    centroid = record.get("centroid")
    if isinstance(centroid, str):
        values = centroid.strip().split(",")
        if len(values) == 2:
            pair = _valid_coordinate_pair(values[1], values[0])
            if pair is not None:
                return pair
    return None


def _alert_area_text(record: dict[str, Any]) -> str:
    fields = (
        "area_description", "affected_area", "area", "district", "city", "town",
        "village", "location", "place", "state",
    )
    values = [record.get(key) for key in fields]
    return " | ".join(value.strip() for value in values if isinstance(value, str) and value.strip())[:1500]


def _contains_phrase(haystack: str, phrase: str) -> bool:
    normalized_haystack = f" {_normalize_place(haystack)} "
    normalized_phrase = _normalize_place(phrase)
    return bool(normalized_phrase) and f" {normalized_phrase} " in normalized_haystack


def _contains_admin_area(haystack: str, phrase: str) -> bool:
    normalized_phrase = _normalize_place(phrase)
    if not normalized_phrase:
        return False
    components = [
        _normalize_place(part)
        for part in re.split(r"[,;|()]+", haystack)
        if _normalize_place(part)
    ]
    if normalized_phrase in components:
        return True
    return any(
        re.search(rf"\b(?:districts?|state|region) of {re.escape(normalized_phrase)}\b", component)
        for component in components
    )


def _severity(record: dict[str, Any]) -> tuple[str, str]:
    color = str(record.get("severity_color", "")).strip().casefold()
    raw = " ".join(str(record.get(key, "")) for key in ("severity", "severity_level")).casefold()
    if color == "red" or re.search(r"\b(severe|extreme|critical|very severe)\b", raw):
        return "severe", str(record.get("severity_level") or record.get("severity") or "Severe")
    if color == "orange" or re.search(r"\b(warning|alert)\b", raw):
        return "warning", str(record.get("severity_level") or record.get("severity") or "Warning")
    if color == "yellow" or re.search(r"\b(watch|advisory)\b", raw):
        return "watch", str(record.get("severity_level") or record.get("severity") or "Watch")
    return "unknown", str(record.get("severity_level") or record.get("severity") or "Unspecified")


def _compact_alert(record: dict[str, Any], match_type: str, distance_km: float | None) -> dict[str, Any]:
    severity, severity_label = _severity(record)
    return {
        "id": str(record.get("identifier") or record.get("alert_id_sdma_autoinc") or "")[:100] or None,
        "type": str(record.get("disaster_type") or "")[:120],
        "message": str(record.get("warning_message") or "")[:700],
        "area": _alert_area_text(record)[:500],
        "severity": severity,
        "severity_label": severity_label[:100],
        "severity_color": str(record.get("severity_color") or "")[:30],
        "issued_at": str(record.get("issued_at") or record.get("issue_time") or record.get("alert_issued_time") or "")[:100] or None,
        "effective_start": str(record.get("effective_start_time") or "")[:100] or None,
        "effective_end": str(record.get("effective_end_time") or "")[:100] or None,
        "source": str(record.get("alert_source") or "SACHET / NDMA")[:120],
        "source_url": "https://sachet.ndma.gov.in/",
        "match_type": match_type,
        "distance_km": round(distance_km, 2) if distance_km is not None else None,
        "distance_basis": "SACHET alert centroid" if distance_km is not None and isinstance(record.get("centroid"), str) else "feed coordinates" if distance_km is not None else None,
    }


def match_sachet_alerts(
    records: list[dict[str, Any]],
    location: dict[str, Any],
    latitude: float,
    longitude: float,
    radius_km: float = 10.0,
) -> dict[str, Any]:
    """Match text conservatively and use distance only when the alert has coordinates."""
    names = _location_names(location)
    exact: list[dict[str, Any]] = []
    same_area: list[dict[str, Any]] = []
    nearby: list[dict[str, Any]] = []
    seen: set[str] = set()
    records_without_coordinates = 0
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        identifier = str(record.get("identifier") or record.get("alert_id_sdma_autoinc") or "")
        dedupe = identifier or "|".join(
            str(record.get(key, "")) for key in ("disaster_type", "area_description", "effective_start_time")
        ) or str(index)
        if dedupe in seen:
            continue
        seen.add(dedupe)
        alert_text = _alert_area_text(record)
        matched_kind: str | None = None
        matched_name: str | None = None
        for kind, name in names:
            if _contains_phrase(alert_text, name):
                matched_kind = kind
                matched_name = name
                break
        alert_position = _alert_coordinates(record)
        if alert_position is None:
            records_without_coordinates += 1
        distance = (
            haversine_km(latitude, longitude, alert_position[0], alert_position[1])
            if alert_position is not None
            else None
        )
        if matched_kind == "local" and distance is not None and distance > radius_km:
            # A far centroid alone cannot confirm a same-named locality. Retain
            # the name match only when the feed also names the selected district/state.
            administrative_confirmation = any(
                kind in {"district", "state"}
                and _normalize_place(name) != _normalize_place(matched_name)
                and _contains_admin_area(alert_text, name)
                for kind, name in names
            )
            if not administrative_confirmation:
                matched_kind = None
        if matched_kind:
            destination = exact if matched_kind == "local" else same_area
            destination.append(_compact_alert(record, "exact" if matched_kind == "local" else "same_area", distance))
        elif distance is not None and distance <= radius_km:
            nearby.append(_compact_alert(record, "nearby", distance))
    for group in (exact, same_area, nearby):
        group.sort(key=lambda alert: (alert["distance_km"] is None, alert["distance_km"] or 0))
    return {
        "exact_matches": exact,
        "same_area_matches": same_area,
        "nearby_matches": nearby,
        "radius_km": radius_km,
        "no_match_message": (
            None if exact or same_area or nearby
            else "No matching Sachet alert found for this location in the available feed."
        ),
        "distance_matching_note": (
            f"{records_without_coordinates} SACHET record(s) did not include usable coordinates; distance matching could not be checked for those records."
            if records_without_coordinates
            else None
        ),
    }


def forecast_features(weather: dict[str, Any]) -> dict[str, Any]:
    hourly = weather.get("hourly") if isinstance(weather.get("hourly"), dict) else {}
    daily = weather.get("daily") if isinstance(weather.get("daily"), dict) else {}
    times = hourly.get("time", [])
    rain = hourly.get("precipitation", [])
    probability = hourly.get("precipitation_probability", [])
    current = weather.get("current") if isinstance(weather.get("current"), dict) else {}
    current_time = str(current.get("time") or "")
    current_hour = current_time[:13] + ":00" if len(current_time) >= 13 else ""
    start = next((i for i, value in enumerate(times) if isinstance(value, str) and value >= current_hour), 0)
    observations: list[tuple[str, float | None, float | None]] = []
    for index in range(start, min(start + 24, len(times))):
        value = rain[index] if index < len(rain) else None
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = math.nan
        amount = number if math.isfinite(number) and number >= 0 else None
        chance_value = probability[index] if isinstance(probability, list) and index < len(probability) else None
        try:
            chance = float(chance_value)
        except (TypeError, ValueError):
            chance = math.nan
        observations.append((str(times[index]), amount, chance if math.isfinite(chance) and 0 <= chance <= 100 else None))
    valid_hours = 0
    previous: datetime | None = None
    for timestamp, amount, _ in observations:
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            break
        if amount is None or (previous is not None and (parsed - previous).total_seconds() != 3600):
            break
        valid_hours += 1
        previous = parsed
    totals: dict[str, float | None] = {}
    for hours in (3, 6, 24):
        totals[f"forecast_{hours}h_mm"] = (
            round(sum(observations[index][1] for index in range(hours)), 2)
            if valid_hours >= hours else None
        )
    daily_time = daily.get("time", [])
    daily_rain = daily.get("precipitation_sum", [])
    daily_values: list[float] = []
    daily_labels: list[dict[str, Any]] = []
    current_date = current_time[:10] if len(current_time) >= 10 else ""
    for index, day in enumerate(daily_time if isinstance(daily_time, list) else []):
        if isinstance(day, str) and current_date and day[:10] < current_date:
            continue
        if len(daily_labels) >= 7:
            break
        value = daily_rain[index] if index < len(daily_rain) else None
        try:
            amount = float(value)
        except (TypeError, ValueError):
            amount = math.nan
        valid = math.isfinite(amount) and amount >= 0
        daily_labels.append({"date": day, "precipitation_mm": round(amount, 2) if valid else None})
        if valid:
            daily_values.append(amount)
    return {
        **totals,
        "valid_hours": valid_hours,
        "precipitation_probability_max": max(
            (item[2] for item in observations[:valid_hours] if item[2] is not None), default=None
        ),
        "forecast_7d_mm": round(sum(daily_values), 2) if len(daily_labels) == 7 and len(daily_values) == 7 else None,
        "daily": daily_labels,
        "hourly_next_24": [
            {"time": timestamp, "precipitation_mm": amount, "precipitation_probability": chance}
            for timestamp, amount, chance in observations
        ],
    }


def rainfall_category(
    features: dict[str, Any],
    station: dict[str, Any] | None,
    thresholds: dict[str, float],
    forecast_window: str = "24h",
) -> dict[str, Any]:
    """Rule-based rainfall indicator; thresholds are configurable examples, not flood probabilities."""
    if forecast_window not in {"24h", "7d"}:
        raise ValueError("forecast_window must be '24h' or '7d'.")
    if forecast_window == "24h" and features.get("valid_hours", 0) < 24:
        return {
            "category": "Insufficient Data",
            "forecast_window": "Next 24 hours",
            "method": "Transparent rainfall-threshold baseline",
            "main_factors": [],
            "data_quality_limitations": ["A complete, valid 24-hour Open-Meteo hourly precipitation window is unavailable."],
            "precautions": ["Check the latest guidance from local authorities and NDMA Sachet."],
            "probability": None,
        }
    if forecast_window == "7d" and features.get("forecast_7d_mm") is None:
        return {
            "category": "Insufficient Data",
            "forecast_window": "Next 7 days",
            "method": "Transparent rainfall-threshold baseline",
            "main_factors": [],
            "data_quality_limitations": ["A complete seven-day daily precipitation forecast is unavailable."],
            "precautions": ["Check the latest guidance from local authorities and NDMA Sachet."],
            "probability": None,
        }

    applicable: list[tuple[str, float, float]] = []
    if forecast_window == "24h":
        for key, title in (("forecast_3h_mm", "3-hour forecast rainfall"), ("forecast_6h_mm", "6-hour forecast rainfall"), ("forecast_24h_mm", "24-hour forecast rainfall")):
            amount = features.get(key)
            if amount is not None:
                applicable.append((title, float(amount), thresholds[key]))
    else:
        applicable.append(("7-day forecast rainfall", float(features["forecast_7d_mm"]), thresholds["forecast_7d_mm"]))
        day_values = [day["precipitation_mm"] for day in features.get("daily", []) if day.get("precipitation_mm") is not None]
        if day_values:
            applicable.append(("Highest daily rainfall forecast", max(day_values), thresholds["forecast_24h_mm"]))

    observed_station_used = False
    station_age_hours: float | None = None
    if station:
        try:
            observed = float(station.get("rain_3h_mm"))
            observed_at = datetime.fromisoformat(str(station.get("last_observed_at_utc", "")).replace("Z", "+00:00"))
            station_age_hours = (datetime.now(timezone.utc) - observed_at.astimezone(timezone.utc)).total_seconds() / 3600
            if math.isfinite(observed) and observed >= 0 and 0 <= station_age_hours <= 72 and forecast_window == "24h":
                applicable.append(("Recent CWC station 3-hour rainfall", observed, thresholds["observed_3h_mm"]))
                observed_station_used = True
        except (TypeError, ValueError, OverflowError):
            pass

    ratios = [(name, amount, threshold, amount / threshold) for name, amount, threshold in applicable if threshold > 0]
    if not ratios:
        return {
            "category": "Insufficient Data",
            "forecast_window": "Next 24 hours" if forecast_window == "24h" else "Next 7 days",
            "method": "Transparent rainfall-threshold baseline",
            "main_factors": [],
            "data_quality_limitations": ["No usable rainfall indicators are available for the selected forecast window."],
            "precautions": ["Check the latest guidance from local authorities and NDMA Sachet."],
            "probability": None,
        }
    name, amount, threshold, ratio = max(ratios, key=lambda item: item[3])
    if ratio >= 1.5:
        category = "Very High"
    elif ratio >= 1:
        category = "High"
    elif ratio >= 0.5:
        category = "Moderate"
    else:
        category = "Low"
    factors = [f"{name}: {amount:g} mm against the configured illustrative {threshold:g} mm indicator threshold."]
    limitations = [
        "This category is a transparent rainfall indicator, not a calibrated flood probability or a validated flood prediction.",
        "Configured rainfall thresholds are illustrative project settings, not official warning thresholds or location-specific drainage limits.",
        "The weather forecast response is not a verified local warning feed; check NDMA Sachet and local authority alerts separately.",
        "The assessment does not include verified flood reports, drainage capacity, terrain, river levels, or street-level observations.",
    ]
    if not station:
        limitations.append("No CWC station observation was available within the configured station search distance.")
    elif forecast_window == "7d":
        limitations.append("The nearby CWC station record is shown as historical context and is not included in the seven-day forecast category.")
    elif not observed_station_used:
        if station_age_hours is None:
            detail = "missing or invalid"
        elif station_age_hours < 0:
            detail = "timestamped in the future"
        else:
            detail = f"{station_age_hours:.1f} hours old"
        limitations.append(f"The nearest CWC station's 3-hour observation is {detail} or incomplete, so it is not treated as recent rainfall (freshness limit: 72 hours).")
    return {
        "category": category,
        "forecast_window": "Next 24 hours" if forecast_window == "24h" else "Next 7 days",
        "method": "Transparent rainfall-threshold baseline; no trained flood model is available.",
        "main_factors": factors,
        "data_quality_limitations": limitations,
        "precautions": [
            "Follow official NDMA Sachet and local authority instructions.",
            "Avoid walking or driving through floodwater; move away from underpasses and low-lying roads during heavy rain.",
            "Keep essential medicines, documents, and a charged phone accessible if local conditions deteriorate.",
        ],
        "probability": None,
    }


def gemini_analysis(
    summary: dict[str, Any],
    *,
    api_key: str,
    model: str,
    timeout: float = 12,
) -> dict[str, Any]:
    """Ask Gemini for a short explanation of supplied evidence using JSON output."""
    if not api_key.strip():
        return {"available": False, "status": "not_configured", "message": "Gemini is not configured; the local rainfall assessment is still available."}
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", model):
        return {"available": False, "status": "invalid_model", "message": "The configured Gemini model name is invalid."}
    schema = {
        "type": "OBJECT",
        "properties": {
            "risk_category": {"type": "STRING", "enum": ["Low", "Moderate", "High", "Very High", "Insufficient Data"]},
            "summary": {"type": "STRING"},
            "main_factors": {"type": "ARRAY", "items": {"type": "STRING"}},
            "data_quality_limitations": {"type": "ARRAY", "items": {"type": "STRING"}},
            "precautions": {"type": "ARRAY", "items": {"type": "STRING"}},
            "forecast_window": {"type": "STRING"},
        },
        "required": ["risk_category", "summary", "main_factors", "data_quality_limitations", "precautions", "forecast_window"],
    }
    prompt = (
        "Explain this urban rainfall assessment using only the supplied facts. "
        "Do not invent rainfall, alerts, flood history, certainty, or probabilities. "
        "Keep the supplied risk_category and forecast_window unchanged. Official alerts, if present, "
        "are a separate source and are not interchangeable with the rainfall category. "
        "Return concise JSON matching the schema. Keep each list to at most 3 short items.\n"
        + json.dumps(summary, ensure_ascii=False, separators=(",", ":"))
    )
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(model, safe="")
        + ":generateContent?"
        + urllib.parse.urlencode({"key": api_key})
    )
    request = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0,
                    "maxOutputTokens": 350,
                    "responseMimeType": "application/json",
                    "responseSchema": schema,
                },
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(128 * 1024 + 1)
            if len(body) > 128 * 1024:
                raise IntegrationError("Gemini response exceeded the configured size limit.")
            data = json.loads(body)
    except urllib.error.HTTPError as error:
        if error.code == 429:
            return {"available": False, "status": "quota_exhausted", "message": "Gemini quota or rate limit was reached; the local assessment remains available."}
        if error.code in (401, 403):
            return {"available": False, "status": "authentication_error", "message": "Gemini rejected the configured API key or model access."}
        if error.code == 404:
            return {"available": False, "status": "model_unavailable", "message": "The configured Gemini model is unavailable to this API key."}
        return {"available": False, "status": "service_error", "message": f"Gemini returned HTTP {error.code}; the local assessment remains available."}
    except (urllib.error.URLError, socket.timeout, TimeoutError):
        return {"available": False, "status": "timeout", "message": "Gemini did not respond in time; the local assessment remains available."}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, IntegrationError):
        return {"available": False, "status": "invalid_response", "message": "Gemini returned an unreadable response; the local assessment remains available."}
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(str(part.get("text", "")) for part in parts if isinstance(part, dict))
        explanation = json.loads(text)
        if not isinstance(explanation, dict):
            raise ValueError("expected a JSON object")
        allowed_categories = {"Low", "Moderate", "High", "Very High", "Insufficient Data"}
        expected_category = summary.get("risk_category")
        if explanation.get("risk_category") not in allowed_categories:
            raise ValueError("unknown risk category")
        if explanation.get("risk_category") != expected_category:
            # The deterministic backend owns the category; the model may explain but not override it.
            explanation["risk_category"] = expected_category
        output: dict[str, Any] = {
            "available": True,
            "status": "ok",
            "model": model,
            "risk_category": expected_category,
            "summary": str(explanation.get("summary", ""))[:500],
            "forecast_window": str(summary.get("forecast_window", ""))[:40],
        }
        for key in ("main_factors", "data_quality_limitations", "precautions"):
            value = explanation.get(key)
            output[key] = [str(item)[:220] for item in value[:3] if isinstance(item, str)][:3] if isinstance(value, list) else []
        if not output["summary"]:
            raise ValueError("empty summary")
        return output
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        return {"available": False, "status": "invalid_response", "message": "Gemini response did not match the expected concise JSON schema; the local assessment remains available."}

