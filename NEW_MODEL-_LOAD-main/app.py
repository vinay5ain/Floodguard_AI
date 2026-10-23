from __future__ import annotations

import json
import hashlib
import os
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

from floodguard.data_processing import (
    DATA_DIR,
    MODEL_READINESS_PATH,
    PROCESSED_DIR,
    QUALITY_PATH,
    STATIONS_PATH,
    DataProcessingError,
    process_cwc_data,
    processed_data_available,
)
from floodguard.risk_engine import assess_rainfall_risk, nearby_stations
from floodguard.integrations import (
    GeocodingService,
    IntegrationError,
    TTLCache,
    WeatherService,
    forecast_features,
    gemini_analysis,
    match_sachet_alerts,
    rainfall_category,
)

PROJECT_ROOT = Path(__file__).resolve().parent
APP_ROOT = PROJECT_ROOT.parent
load_dotenv(APP_ROOT / ".env")
load_dotenv(PROJECT_ROOT / ".env")
FRONTEND_DIST = APP_ROOT / "frontend" / "dist"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
PROCESS_LOCK = threading.Lock()
weather_service = WeatherService()
geocoding_service = GeocodingService()
_ALERT_LOCK = threading.Lock()
_ALERT_FETCH_LOCK = threading.Lock()
_ALERT_CACHE: dict[str, Any] = {"records": None, "last_successful_update": None, "fetched_monotonic": 0.0}
_GEMINI_CACHE = TTLCache(256)
_GEMINI_LOCK = threading.Lock()
_GEMINI_INFLIGHT: dict[str, threading.Event] = {}


def _fetch_sachet(force: bool = False) -> dict[str, Any]:
    now = time.monotonic()
    with _ALERT_LOCK:
        cached_records = _ALERT_CACHE["records"]
        cached_time = _ALERT_CACHE["last_successful_update"]
        cached_age = now - _ALERT_CACHE["fetched_monotonic"]
        if cached_records is not None and cached_age < 300 and not force:
            return {"status": "available", "records": cached_records, "last_successful_update": cached_time}
    # Serialize refreshes and re-check after waiting so simultaneous page requests
    # reuse one upstream call.
    with _ALERT_FETCH_LOCK:
        now = time.monotonic()
        with _ALERT_LOCK:
            cached_records = _ALERT_CACHE["records"]
            cached_time = _ALERT_CACHE["last_successful_update"]
            cached_age = now - _ALERT_CACHE["fetched_monotonic"]
            if cached_records is not None and cached_age < 300 and not force:
                return {"status": "available", "records": cached_records, "last_successful_update": cached_time}
        endpoint = os.environ.get(
            "SACHET_ENDPOINT",
            "https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails",
        )
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            error = "SACHET_ENDPOINT must be a valid HTTPS URL."
            failure_code = 500
        else:
            try:
                from floodguard.integrations import _json_request

                records = _json_request(
                    endpoint,
                    timeout=12,
                    headers={"User-Agent": "FloodGuardAI/1.0"},
                    max_bytes=2 * 1024 * 1024,
                )
                if not isinstance(records, list) or any(not isinstance(row, dict) for row in records):
                    raise IntegrationError("SACHET must return a JSON array containing only alert objects.")
                successful_at = pd.Timestamp.now(tz="UTC").isoformat()
                with _ALERT_LOCK:
                    _ALERT_CACHE.update(
                        records=records,
                        last_successful_update=successful_at,
                        fetched_monotonic=time.monotonic(),
                    )
                return {"status": "available", "records": records, "last_successful_update": successful_at}
            except IntegrationError as exc:
                error = str(exc)
                failure_code = exc.status_code
        with _ALERT_LOCK:
            cached_records = _ALERT_CACHE["records"]
            cached_time = _ALERT_CACHE["last_successful_update"]
        if cached_records is not None:
            return {
                "status": "stale",
                "records": cached_records,
                "last_successful_update": cached_time,
                "error": error,
            }
        return {"status": "unavailable", "records": [], "last_successful_update": None, "error": error, "status_code": failure_code}


def _ensure_processed() -> None:
    if processed_data_available(PROCESSED_DIR):
        return
    with PROCESS_LOCK:
        if not processed_data_available(PROCESSED_DIR):
            process_cwc_data(DATA_DIR, PROCESSED_DIR)


def _json_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def _coordinates(body: dict[str, Any]) -> tuple[float, float]:
    latitude = _json_number(body.get("latitude"))
    longitude = _json_number(body.get("longitude"))
    if (
        latitude is None
        or longitude is None
        or not (-90 <= latitude <= 90)
        or not (-180 <= longitude <= 180)
    ):
        raise ValueError("Latitude must be between -90 and 90 and longitude between -180 and 180.")
    return latitude, longitude


def _load_stations() -> list[dict[str, Any]]:
    if not STATIONS_PATH.is_file():
        return []
    return pd.read_csv(STATIONS_PATH).replace({np.nan: None}).to_dict(orient="records")


def _forecast_summary(body: dict[str, Any]) -> dict[str, Any]:
    hourly = body.get("hourly")
    if not isinstance(hourly, dict):
        raise ValueError("A forecast hourly object is required.")
    times = hourly.get("time")
    precipitation = hourly.get("precipitation")
    probability = hourly.get("precipitation_probability", [])
    if (
        not isinstance(times, list)
        or not isinstance(precipitation, list)
        or (probability is not None and not isinstance(probability, list))
        or len(times) != len(precipitation)
        or len(times) > 200
        or (probability and len(probability) != len(times))
    ):
        raise ValueError("Forecast hourly time, precipitation, and probability arrays are malformed.")
    observations: list[tuple[str, float | None, float | None]] = []
    for index, (timestamp, amount) in enumerate(zip(times, precipitation)):
        amount_number = _json_number(amount)
        chance = _json_number(probability[index]) if probability else None
        if chance is not None and not 0 <= chance <= 100:
            chance = None
        if isinstance(timestamp, str):
            observations.append(
                (
                    timestamp,
                    amount_number if amount_number is not None and amount_number >= 0 else None,
                    chance,
                )
            )
    observations.sort(key=lambda item: item[0])
    selected = observations[:24]
    valid_hours = 0
    previous_time = None
    for timestamp, amount, _ in selected:
        try:
            parsed_time = pd.Timestamp(timestamp)
        except (TypeError, ValueError):
            break
        if (
            amount is None
            or (
                previous_time is not None
                and parsed_time - previous_time != pd.Timedelta(hours=1)
            )
        ):
            break
        valid_hours += 1
        previous_time = parsed_time
    totals: dict[str, float | None] = {}
    for hours in (3, 6, 24):
        items = selected[:hours]
        totals[f"forecast_{hours}h_mm"] = (
            round(sum(item[1] for item in items), 2) if valid_hours >= hours else None
        )
    return {
        **totals,
        "valid_hours": valid_hours,
        "precipitation_probability_max": (
            max((item[2] for item in selected[:valid_hours] if item[2] is not None), default=None)
        ),
    }


@app.get("/")
def index():
    if (FRONTEND_DIST / "index.html").is_file():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return jsonify({"error": "The React frontend has not been built yet. Start the Vite development server or run npm run build."}), 404


@app.get("/assets/<path:asset>")
def frontend_asset(asset: str):
    if not FRONTEND_DIST.is_dir():
        return jsonify({"error": "The React frontend has not been built yet."}), 404
    return send_from_directory(FRONTEND_DIST / "assets", asset)


@app.get("/api/geocode")
def geocode():
    query = request.args.get("q", "")
    try:
        return jsonify({"results": geocoding_service.search(query), "attribution": "© OpenStreetMap contributors"})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except IntegrationError as error:
        return jsonify({"error": str(error), "source": "OpenStreetMap Nominatim"}), error.status_code


@app.get("/api/reverse-geocode")
def reverse_geocode():
    try:
        latitude, longitude = _coordinates(
            {"latitude": request.args.get("latitude"), "longitude": request.args.get("longitude")}
        )
        result = geocoding_service.reverse(latitude, longitude)
        return jsonify({"result": result, "attribution": "© OpenStreetMap contributors"})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except IntegrationError as error:
        return jsonify({"error": str(error), "source": "OpenStreetMap Nominatim"}), error.status_code


@app.get("/api/weather")
def weather():
    try:
        body = {"latitude": request.args.get("latitude"), "longitude": request.args.get("longitude")}
        latitude, longitude = _coordinates(body)
        payload = weather_service.fetch(latitude, longitude)
        return jsonify(payload)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except IntegrationError as error:
        return jsonify({"error": str(error), "source": "Open-Meteo"}), error.status_code


@app.get("/api/alerts")
def sachet_alerts():
    feed = _fetch_sachet(force=request.args.get("refresh") == "1")
    if feed["status"] == "unavailable":
        return jsonify({"error": feed["error"], "last_successful_update": None}), feed.get("status_code", 502)
    response = jsonify(feed["records"])
    response.headers["X-Feed-Status"] = feed["status"]
    response.headers["X-Last-Successful-Update"] = feed["last_successful_update"] or ""
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/alerts/match")
def sachet_alert_matches():
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise ValueError("Request body must be a JSON object.")
        latitude, longitude = _coordinates(body)
        location = body.get("location", {})
        if not isinstance(location, dict):
            raise ValueError("location must be a JSON object.")
        radius = _threshold("SACHET_PROXIMITY_KM", 10)
        if radius > 100:
            raise ValueError("SACHET_PROXIMITY_KM must not exceed 100 km.")
        feed = _fetch_sachet(force=body.get("refresh") is True)
        if feed["status"] == "unavailable":
            return jsonify(
                {
                    "status": "unavailable",
                    "available": False,
                    "message": "The official Sachet alert feed could not be verified. No conclusion about active warnings is available.",
                    "last_successful_update": feed.get("last_successful_update"),
                    "source": "NDMA Sachet",
                    "source_url": "https://sachet.ndma.gov.in/",
                    "error": feed["error"],
                    "exact_matches": [],
                    "same_area_matches": [],
                    "nearby_matches": [],
                    "no_match_message": None,
                }
            ), feed.get("status_code", 502)
        matches = match_sachet_alerts(feed["records"], location, latitude, longitude, radius)
        if feed["status"] == "stale":
            matches["no_match_message"] = None
        return jsonify(
            {
                **matches,
                "status": feed["status"],
                "available": feed["status"] == "available",
                "message": (
                    "SACHET feed refreshed successfully."
                    if feed["status"] == "available"
                    else "The SACHET feed could not be refreshed; the displayed records are from its last successful update and may be stale."
                ),
                "last_successful_update": feed["last_successful_update"],
                "source": "NDMA Sachet",
                "source_url": "https://sachet.ndma.gov.in/",
                "record_count": len(feed["records"]),
                "error": feed.get("error"),
            }
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


def _forecast_thresholds() -> dict[str, float]:
    return {
        "forecast_3h_mm": _threshold("FLOODGUARD_FORECAST_3H_MM", 30),
        "forecast_6h_mm": _threshold("FLOODGUARD_FORECAST_6H_MM", 50),
        "forecast_24h_mm": _threshold("FLOODGUARD_FORECAST_24H_MM", 100),
        "forecast_7d_mm": _threshold("FLOODGUARD_FORECAST_7D_MM", 200),
        "observed_3h_mm": _threshold("FLOODGUARD_OBSERVED_3H_MM", 30),
    }


def _get_gemini_cached(cache_key: str, summary: dict[str, Any]) -> dict[str, Any]:
    cached = _GEMINI_CACHE.get(cache_key)
    if cached is not None:
        return cached
    with _GEMINI_LOCK:
        event = _GEMINI_INFLIGHT.get(cache_key)
        leader = event is None
        if leader:
            event = threading.Event()
            _GEMINI_INFLIGHT[cache_key] = event
    if not leader:
        event.wait(timeout=14)
        cached = _GEMINI_CACHE.get(cache_key)
        if cached is not None:
            return cached
        return {"available": False, "status": "in_progress", "message": "A matching Gemini explanation is still being prepared; the local assessment is available."}
    try:
        try:
            result = gemini_analysis(
                summary,
                api_key=os.environ.get("GEMINI_API_KEY", ""),
                model=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            )
        except Exception:
            app.logger.warning("Gemini explanation failed; returning the local rainfall assessment.")
            result = {"available": False, "status": "service_error", "message": "Gemini is temporarily unavailable; the local assessment remains available."}
        _GEMINI_CACHE.set(cache_key, result, 60 * 60 if result.get("available") else 10 * 60)
        return result
    finally:
        with _GEMINI_LOCK:
            _GEMINI_INFLIGHT.pop(cache_key, None)
            event.set()


@app.post("/api/urban-risk")
def urban_risk():
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise ValueError("Request body must be a JSON object.")
        latitude, longitude = _coordinates(body)
        forecast_window = body.get("forecast_window", "24h")
        if forecast_window not in {"24h", "7d"}:
            raise ValueError("forecast_window must be '24h' or '7d'.")
        location = body.get("location", {})
        if not isinstance(location, dict):
            raise ValueError("location must be a JSON object.")
        location_name = str(location.get("display_name") or location.get("name") or "Selected location")[:120]

        weather_data = weather_service.fetch(latitude, longitude)
        features = forecast_features(weather_data)
        thresholds = _forecast_thresholds()
        station_match: dict[str, Any] = {"matched_station": None, "nearby_stations": [], "max_matching_distance_km": None}
        csv_summary: dict[str, Any] = {"available": False, "message": "CWC CSV data has not been processed."}
        try:
            _ensure_processed()
            max_distance = _threshold("FLOODGUARD_MAX_STATION_DISTANCE_KM", 50)
            if max_distance > 500:
                raise ValueError("FLOODGUARD_MAX_STATION_DISTANCE_KM must not exceed 500 km.")
            station_match = nearby_stations(latitude, longitude, _load_stations(), max_distance_km=max_distance)
            station = station_match["matched_station"]
            if station:
                station_age_hours = None
                try:
                    observed_at = pd.Timestamp(station.get("last_observed_at_utc"))
                    if pd.isna(observed_at):
                        raise ValueError("Observation timestamp is missing.")
                    if observed_at.tzinfo is None:
                        observed_at = observed_at.tz_localize("UTC")
                    age = (pd.Timestamp.now(tz="UTC") - observed_at.tz_convert("UTC")).total_seconds() / 3600
                    station_age_hours = age if age >= 0 else None
                except (TypeError, ValueError):
                    pass
                csv_summary = {
                    "available": True,
                    "source": "Supplied CWC station rainfall CSVs",
                    "station": station.get("station"),
                    "district": station.get("district"),
                    "state": station.get("state"),
                    "distance_km": station.get("distance_km"),
                    "last_observed_at_utc": station.get("last_observed_at_utc"),
                    "observation_age_hours": round(station_age_hours, 1) if station_age_hours is not None else None,
                    "observation_freshness": "recent" if station_age_hours is not None and station_age_hours <= 72 else "stale or unknown",
                    "last_rainfall_mm": station.get("last_rainfall_mm"),
                    "rain_1h_mm": station.get("rain_1h_mm"),
                    "rain_3h_mm": station.get("rain_3h_mm"),
                    "rain_6h_mm": station.get("rain_6h_mm"),
                    "rain_24h_mm": station.get("rain_24h_mm"),
                    "observation_count": station.get("observation_count"),
                }
            else:
                csv_summary = {
                    "available": False,
                    "source": "Supplied CWC station rainfall CSVs",
                    "message": f"No valid CWC station is within {max_distance:g} km of this location.",
                }
        except DataProcessingError as error:
            csv_summary = {"available": False, "source": "Supplied CWC station rainfall CSVs", "message": str(error)}
        except OSError:
            app.logger.exception("Unable to read CWC rainfall data")
            csv_summary = {"available": False, "source": "Supplied CWC station rainfall CSVs", "message": "The processed CWC station data could not be read."}

        risk = rainfall_category(features, station_match.get("matched_station"), thresholds, forecast_window)
        alert_context = body.get("official_alert_context", {})
        if not isinstance(alert_context, dict):
            alert_context = {}
        alert_status = str(alert_context.get("status", "not_requested"))[:20]
        alert_last_success = str(alert_context.get("last_successful_update") or "")[:40] or None
        compact_alerts: list[dict[str, Any]] = []
        for alert in (alert_context.get("exact_matches", []) + alert_context.get("same_area_matches", []) + alert_context.get("nearby_matches", []))[:3] if all(isinstance(alert_context.get(key, []), list) for key in ("exact_matches", "same_area_matches", "nearby_matches")) else []:
            if isinstance(alert, dict):
                compact_alerts.append({
                    "type": str(alert.get("type", ""))[:80],
                    "area": str(alert.get("area", ""))[:160],
                    "severity": str(alert.get("severity_label", alert.get("severity", "Unspecified")))[:60],
                    "effective_start": str(alert.get("effective_start", ""))[:80],
                    "effective_end": str(alert.get("effective_end", ""))[:80],
                    "match_type": str(alert.get("match_type", ""))[:20],
                    "source": "NDMA Sachet",
                })
        if risk["category"] == "Insufficient Data":
            gemini = {"available": False, "status": "insufficient_data", "message": "Gemini explanation was skipped because the selected forecast window lacks complete rainfall data."}
        else:
            gemini_csv_summary = {
                key: csv_summary.get(key)
                for key in (
                    "available", "source", "station", "district", "state", "distance_km",
                    "last_observed_at_utc", "observation_freshness", "last_rainfall_mm",
                    "rain_1h_mm", "rain_3h_mm", "rain_6h_mm", "rain_24h_mm", "observation_count",
                )
                if key in csv_summary
            }
            if not csv_summary.get("available"):
                gemini_csv_summary = {
                    "available": False,
                    "source": "Supplied CWC station rainfall CSVs",
                    "message": "No eligible nearby CWC station summary is available.",
                }
            compact_summary = {
                "location": location_name,
                "risk_category": risk["category"],
                "forecast_window": risk["forecast_window"],
                "weather_rainfall_mm": {
                    "forecast_3h": features.get("forecast_3h_mm"),
                    "forecast_6h": features.get("forecast_6h_mm"),
                    "forecast_24h": features.get("forecast_24h_mm"),
                    "forecast_7d": features.get("forecast_7d_mm"),
                },
                "cwc_station_summary": gemini_csv_summary,
                "baseline_factors": risk["main_factors"][:3],
                "official_alert_feed_status": alert_status,
                "relevant_official_alert_metadata": compact_alerts,
            }
            cache_material = json.dumps(
                {
                    "model": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite"),
                    "summary": compact_summary,
                    "coordinates_rounded": [round(latitude, 4), round(longitude, 4)],
                    "weather_freshness_hour": str(weather_data.get("retrieved_at_utc", ""))[:13],
                },
                sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            )
            cache_key = hashlib.sha256(cache_material.encode("utf-8")).hexdigest()
            gemini = _get_gemini_cached(cache_key, compact_summary)
        return jsonify(
            {
                "location": {"name": location_name, "latitude": latitude, "longitude": longitude},
                "weather": weather_data,
                "forecast_features": features,
                "station_match": station_match,
                "csv_summary": csv_summary,
                "risk": risk,
                "gemini": gemini,
                "official_alert_context": {"status": alert_status, "last_successful_update": alert_last_success, "relevant_alert_count": len(compact_alerts)},
                "data_sources": {
                    "weather": "Open-Meteo Forecast API",
                    "historical_rainfall": "Supplied CWC station rainfall CSVs",
                    "official_alerts": "NDMA Sachet (separate official alert feed)",
                    "validated_flood_prediction_model": False,
                    "numerical_probability_available": False,
                },
                "thresholds": thresholds,
            }
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except IntegrationError as error:
        return jsonify({"error": str(error), "source": "Open-Meteo"}), error.status_code


@app.get("/api/status")
def status():
    return jsonify(
        {
            "status": "ok",
            "data_available": processed_data_available(PROCESSED_DIR),
            "source_directory": "NEW_MODEL-_LOAD-main/DATA",
            "risk_mode": "indicative_rainfall_only",
            "react_build_available": (FRONTEND_DIST / "index.html").is_file(),
            "integrations": {
                "weather": "Open-Meteo Forecast API",
                "official_alerts": "NDMA Sachet",
                "geocoding": "OpenStreetMap Nominatim",
                "gemini_configured": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
                "validated_flood_model": False,
            },
        }
    )


@app.get("/api/quality")
def quality():
    if not QUALITY_PATH.is_file():
        return jsonify({"available": False, "message": "Historical data has not been processed yet."})
    return jsonify(json.loads(QUALITY_PATH.read_text(encoding="utf-8")))


@app.get("/api/model-readiness")
def model_readiness():
    if not MODEL_READINESS_PATH.is_file():
        return jsonify(
            {
                "verified_flood_event_labels_found": False,
                "validated_flood_prediction_model_trained": False,
                "status": "not_trainable_without_verified_labels",
                "reason": "No verified flood-event labels are included in the supplied project files.",
            }
        )
    return jsonify(json.loads(MODEL_READINESS_PATH.read_text(encoding="utf-8")))


@app.post("/api/stations")
def stations():
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise ValueError("Request body must be a JSON object.")
        latitude, longitude = _coordinates(body)
        _ensure_processed()
        max_distance = float(os.environ.get("FLOODGUARD_MAX_STATION_DISTANCE_KM", "50"))
        if not np.isfinite(max_distance) or not 0 < max_distance <= 500:
            raise ValueError("FLOODGUARD_MAX_STATION_DISTANCE_KM must be in (0, 500].")
        return jsonify(
            nearby_stations(
                latitude, longitude, _load_stations(), max_distance_km=max_distance
            )
        )
    except DataProcessingError as error:
        return jsonify({"error": str(error)}), 503
    except (ValueError, TypeError) as error:
        return jsonify({"error": str(error)}), 400
    except OSError as error:
        app.logger.exception("Unable to read processed rainfall data")
        return jsonify({"error": f"Unable to read processed rainfall data: {error}"}), 500


@app.post("/api/assess")
def assess():
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise ValueError("Request body must be a JSON object.")
        latitude, longitude = _coordinates(body)
        forecast = _forecast_summary(body)
        _ensure_processed()
        max_distance = float(os.environ.get("FLOODGUARD_MAX_STATION_DISTANCE_KM", "50"))
        if not np.isfinite(max_distance) or not 0 < max_distance <= 500:
            raise ValueError("FLOODGUARD_MAX_STATION_DISTANCE_KM must be in (0, 500].")
        match = nearby_stations(
            latitude, longitude, _load_stations(), max_distance_km=max_distance
        )
        station = match["matched_station"]
        thresholds = {
            "forecast_3h_mm": _threshold("FLOODGUARD_FORECAST_3H_MM", 30),
            "forecast_6h_mm": _threshold("FLOODGUARD_FORECAST_6H_MM", 50),
            "forecast_24h_mm": _threshold("FLOODGUARD_FORECAST_24H_MM", 100),
            "observed_3h_mm": _threshold("FLOODGUARD_OBSERVED_3H_MM", 30),
        }
        risk = assess_rainfall_risk(station, forecast, thresholds)
        return jsonify(
            {
                "location": {"latitude": latitude, "longitude": longitude},
                "station_match": match,
                "forecast": forecast,
                "risk": risk,
                "data_sources": {
                    "historical": "CWC station observations",
                    "forecast": "Open-Meteo gridded forecast",
                    "verified_flood_event_labels_found": False,
                },
            }
        )
    except DataProcessingError as error:
        return jsonify({"error": str(error)}), 503
    except (ValueError, TypeError) as error:
        return jsonify({"error": str(error)}), 400
    except OSError as error:
        app.logger.exception("Unable to assess rainfall risk")
        return jsonify({"error": f"Unable to assess rainfall risk: {error}"}), 500


def _threshold(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f"{name} must be a positive number.") from error
    if not np.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive number.")
    return value


@app.get("/<path:frontend_route>")
def frontend_route(frontend_route: str):
    if frontend_route.startswith("api/"):
        return jsonify({"error": "Not found."}), 404
    index_path = FRONTEND_DIST / "index.html"
    if index_path.is_file():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return jsonify({"error": "The React frontend has not been built yet. Start the Vite development server or run npm run build."}), 404


@app.errorhandler(Exception)
def unexpected_error(error: Exception):
    app.logger.exception("Unhandled FloodGuard request error")
    if request.path.startswith("/api/"):
        return jsonify({"error": "The request could not be completed due to an internal service error."}), 500
    return "The request could not be completed.", 500


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5000")), debug=False)
