from __future__ import annotations

import io
import json
import os
import socket
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pandas as pd

import app as app_module
from floodguard.data_processing import DataProcessingError, process_cwc_data
from floodguard.integrations import (
    GeocodingService,
    IntegrationError,
    WeatherService,
    forecast_features,
    gemini_analysis,
    match_sachet_alerts,
    rainfall_category,
)


class IntegrationLogicTests(unittest.TestCase):
    location = {
        "display_name": "Connaught Place, New Delhi, Delhi, India",
        "address": {
            "suburb": "Connaught Place",
            "city": "New Delhi",
            "district": "New Delhi",
            "state": "Delhi",
        },
    }

    def test_exact_area_match_and_missing_feed_coordinates_are_explicit(self):
        result = match_sachet_alerts(
            [{"identifier": "a1", "area_description": "Connaught Place, New Delhi", "disaster_type": "Heavy Rain"}],
            self.location,
            28.6315,
            77.2167,
        )
        self.assertEqual(len(result["exact_matches"]), 1)
        self.assertIsNone(result["exact_matches"][0]["distance_km"])
        self.assertIn("did not include usable coordinates", result["distance_matching_note"])

    def test_nearby_match_uses_distance_and_reports_kilometres(self):
        result = match_sachet_alerts(
            [{"identifier": "near", "area_description": "A nearby affected area", "latitude": 28.64, "longitude": 77.22}],
            self.location,
            28.6315,
            77.2167,
            10,
        )
        self.assertEqual(len(result["nearby_matches"]), 1)
        self.assertGreater(result["nearby_matches"][0]["distance_km"], 0)
        self.assertLess(result["nearby_matches"][0]["distance_km"], 10)

    def test_live_sachet_centroid_order_is_validated_and_used(self):
        result = match_sachet_alerts(
            [{"identifier": "centroid", "area_description": "Affected area", "centroid": "77.2090,28.6139"}],
            self.location,
            28.6139,
            77.2090,
            10,
        )
        self.assertEqual(len(result["nearby_matches"]), 1)
        self.assertEqual(result["nearby_matches"][0]["distance_basis"], "SACHET alert centroid")
        self.assertEqual(result["nearby_matches"][0]["distance_km"], 0)

    def test_distant_same_name_is_not_a_text_match(self):
        result = match_sachet_alerts(
            [{"identifier": "far", "area_description": "New Delhi", "latitude": 19.076, "longitude": 72.8777}],
            self.location,
            28.6315,
            77.2167,
            10,
        )
        self.assertEqual(result["exact_matches"], [])
        self.assertEqual(result["nearby_matches"], [])
        self.assertEqual(
            result["no_match_message"],
            "No matching Sachet alert found for this location in the available feed.",
        )

    def test_feed_empty_has_no_false_coordinates_or_warning(self):
        result = match_sachet_alerts([], self.location, 28.6315, 77.2167)
        self.assertEqual(result["exact_matches"], [])
        self.assertEqual(result["no_match_message"], "No matching Sachet alert found for this location in the available feed.")

    def test_forecast_features_and_categories_are_not_probabilities(self):
        start = datetime(2026, 10, 23, 12)
        times = [(start + timedelta(hours=i)).isoformat(timespec="minutes") for i in range(24)]
        features = forecast_features(
            {
                "current": {"time": times[0]},
                "hourly": {"time": times + ["2026-10-24T12:00"], "precipitation": [3] * 25, "precipitation_probability": [40] * 25},
                "daily": {"time": [f"2026-10-{23+i:02d}" for i in range(7)], "precipitation_sum": [10] * 7},
            }
        )
        self.assertEqual(features["valid_hours"], 24)
        self.assertEqual(features["forecast_3h_mm"], 9)
        self.assertEqual(features["forecast_24h_mm"], 72)
        self.assertEqual(features["forecast_7d_mm"], 70)
        thresholds = {"forecast_3h_mm": 30, "forecast_6h_mm": 50, "forecast_24h_mm": 100, "forecast_7d_mm": 200, "observed_3h_mm": 30}
        risk = rainfall_category(features, None, thresholds)
        self.assertEqual(risk["category"], "Moderate")
        self.assertIsNone(risk["probability"])

    def test_incomplete_hourly_and_daily_windows_return_insufficient_data(self):
        thresholds = {"forecast_3h_mm": 30, "forecast_6h_mm": 50, "forecast_24h_mm": 100, "forecast_7d_mm": 200, "observed_3h_mm": 30}
        self.assertEqual(rainfall_category({"valid_hours": 12}, None, thresholds)["category"], "Insufficient Data")
        self.assertEqual(rainfall_category({"forecast_7d_mm": None}, None, thresholds, "7d")["category"], "Insufficient Data")

    def test_weather_and_geocoder_validate_upstream_shapes_and_cache(self):
        payload = {
            "current": {"time": "2026-10-23T12:00"},
            "hourly": {"time": ["2026-10-23T12:00"], "precipitation": [0]},
            "daily": {"time": ["2026-10-23"], "precipitation_sum": [0]},
        }
        with patch("floodguard.integrations._json_request", return_value=payload) as upstream:
            service = WeatherService()
            one = service.fetch(28.6, 77.2)
            two = service.fetch(28.6, 77.2)
        self.assertEqual(one, two)
        self.assertEqual(upstream.call_count, 1)
        with patch("floodguard.integrations._json_request", return_value=[{"lat": "28.61", "lon": "77.20", "display_name": "Delhi, India", "address": {"city": "Delhi"}}]):
            results = GeocodingService().search("Delhi")
        self.assertEqual(results[0]["address"]["city"], "Delhi")

    def test_weather_unavailable_is_a_service_error(self):
        with patch("floodguard.integrations._json_request", side_effect=IntegrationError("Upstream timed out.", 504)):
            with self.assertRaises(IntegrationError) as caught:
                WeatherService().fetch(28.6, 77.2)
        self.assertEqual(caught.exception.status_code, 504)


class GeminiTests(unittest.TestCase):
    class Response:
        def __init__(self, value):
            self.value = value

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _size=-1):
            return json.dumps(self.value).encode()

    def test_missing_key_and_quota_do_not_break_local_assessment(self):
        summary = {"risk_category": "Low", "forecast_window": "Next 24 hours"}
        self.assertEqual(gemini_analysis(summary, api_key="", model="gemini-3.5-flash-lite")["status"], "not_configured")
        error = urllib.error.HTTPError("https://example.invalid", 429, "quota", {}, io.BytesIO())
        with patch("floodguard.integrations.urllib.request.urlopen", side_effect=error):
            result = gemini_analysis(summary, api_key="test-key", model="gemini-3.5-flash-lite")
        self.assertEqual(result["status"], "quota_exhausted")

    def test_invalid_model_output_is_rejected(self):
        response = self.Response({"candidates": [{"content": {"parts": [{"text": "not json"}]}}]})
        with patch("floodguard.integrations.urllib.request.urlopen", return_value=response):
            result = gemini_analysis({"risk_category": "High"}, api_key="test-key", model="gemini-3.5-flash-lite")
        self.assertEqual(result["status"], "invalid_response")


class NewEndpointTests(unittest.TestCase):
    def setUp(self):
        app_module.app.testing = True
        self.client = app_module.app.test_client()

    def test_weather_endpoint_handles_invalid_coordinates_and_unavailable_source(self):
        self.assertEqual(self.client.get("/api/weather?latitude=100&longitude=20").status_code, 400)
        with patch.object(app_module.weather_service, "fetch", side_effect=IntegrationError("Open-Meteo timed out.", 504)):
            response = self.client.get("/api/weather?latitude=28.6&longitude=77.2")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.get_json()["source"], "Open-Meteo")

    def test_risk_endpoint_works_without_gemini_and_returns_no_probability(self):
        now = pd.Timestamp.now(tz="UTC").tz_localize(None).replace(minute=0, second=0, microsecond=0)
        times = [(now + pd.Timedelta(hours=index)).isoformat(timespec="minutes") for index in range(24)]
        weather = {
            "source": "Open-Meteo Forecast API",
            "retrieved_at_utc": "2026-10-23T12:00:00+00:00",
            "timezone": "Asia/Kolkata",
            "current": {"time": times[0]},
            "hourly": {"time": times, "precipitation": [0] * 24, "precipitation_probability": [0] * 24},
            "daily": {"time": [f"2026-10-{23 + index:02d}" for index in range(7)], "precipitation_sum": [0] * 7},
        }
        station = {
            "station": "Test CWC station", "district": "Delhi", "state": "Delhi",
            "latitude": 28.6, "longitude": 77.2,
            "last_observed_at_utc": pd.Timestamp.now(tz="UTC").isoformat(),
            "last_rainfall_mm": 0, "rain_1h_mm": 0, "rain_3h_mm": 0,
            "rain_6h_mm": 0, "rain_24h_mm": 0, "observation_count": 100,
        }
        alert_update = "2026-10-23T12:00:00+00:00"
        with patch.object(app_module.weather_service, "fetch", return_value=weather), patch.object(app_module, "_ensure_processed"), patch.object(app_module, "_load_stations", return_value=[station]), patch.object(app_module, "_get_gemini_cached", return_value={"available": False, "status": "not_configured", "message": "Gemini is not configured."}) as gemini_call, patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False):
            response = self.client.post("/api/urban-risk", json={
                "latitude": 28.6, "longitude": 77.2, "forecast_window": "24h",
                "location": {"display_name": "Delhi"},
                "official_alert_context": {"status": "available", "last_successful_update": alert_update},
            })
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["risk"]["category"], "Low")
        self.assertIsNone(body["risk"]["probability"])
        self.assertFalse(body["gemini"]["available"])
        self.assertIsNone(body["risk"].get("flood_probability"))
        gemini_summary = gemini_call.call_args.args[1]
        self.assertNotIn("official_alert_feed_last_successful_update", gemini_summary)
        self.assertNotIn("observation_age_hours", gemini_summary["cwc_station_summary"])
        self.assertEqual(gemini_summary["cwc_station_summary"]["last_observed_at_utc"], station["last_observed_at_utc"])

    def test_unavailable_alert_feed_is_not_returned_as_no_match(self):
        with patch.object(app_module, "_fetch_sachet", return_value={"status": "unavailable", "records": [], "last_successful_update": None, "error": "offline", "status_code": 502}):
            response = self.client.post("/api/alerts/match", json={"latitude": 28.6, "longitude": 77.2, "location": {}})
        self.assertEqual(response.status_code, 502)
        body = response.get_json()
        self.assertEqual(body["status"], "unavailable")
        self.assertIsNone(body["no_match_message"])


class MissingCSVTests(unittest.TestCase):
    def test_csv_without_rainfall_schema_is_reported_not_used(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "DATA"
            source.mkdir()
            (source / "not-rainfall.csv").write_text("name,value\nfoo,1\n", encoding="utf-8")
            with self.assertRaises(DataProcessingError):
                process_cwc_data(source, root / "processed")


if __name__ == "__main__":
    unittest.main()
