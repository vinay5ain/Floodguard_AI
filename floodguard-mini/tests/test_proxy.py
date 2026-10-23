import io
import json
import socket
import unittest
import urllib.error
from unittest.mock import patch

from proxy import app as proxy_module


class UpstreamResponse:
    def __init__(self, body, content_type="application/json;charset=UTF-8", status=200):
        self.body = body
        self.status = status
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, size=-1):
        return self.body[:size]


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = proxy_module.app.test_client()

    @patch("proxy.app.urllib.request.urlopen")
    def test_returns_valid_live_shape_and_accepts_empty_array(self, urlopen):
        urlopen.return_value = UpstreamResponse(b'[{"identifier":1}]')
        response = self.client.get("/api/alerts")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [{"identifier": 1}])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

        urlopen.return_value = UpstreamResponse(b"[]")
        self.assertEqual(self.client.get("/api/alerts").get_json(), [])

    @patch("proxy.app.urllib.request.urlopen")
    def test_rejects_http_network_timeout_and_unreadable_upstream(self, urlopen):
        urlopen.side_effect = urllib.error.HTTPError(
            "https://sachet.example", 503, "Unavailable", {}, io.BytesIO()
        )
        self.assertEqual(self.client.get("/api/alerts").status_code, 502)

        urlopen.side_effect = urllib.error.URLError("offline")
        self.assertEqual(self.client.get("/api/alerts").status_code, 502)

        urlopen.side_effect = socket.timeout()
        self.assertEqual(self.client.get("/api/alerts").status_code, 504)

    @patch("proxy.app.urllib.request.urlopen")
    def test_rejects_invalid_content_json_and_record_shapes(self, urlopen):
        urlopen.return_value = UpstreamResponse(b"<alerts/>", "application/xml")
        self.assertEqual(self.client.get("/api/alerts").status_code, 502)

        urlopen.return_value = UpstreamResponse(b"{bad json")
        self.assertEqual(self.client.get("/api/alerts").status_code, 502)

        urlopen.return_value = UpstreamResponse(b'{"alerts":[]}')
        self.assertEqual(self.client.get("/api/alerts").status_code, 502)

        urlopen.return_value = UpstreamResponse(b'[{"ok":true}, null]')
        self.assertEqual(self.client.get("/api/alerts").status_code, 502)


if __name__ == "__main__":
    unittest.main()
