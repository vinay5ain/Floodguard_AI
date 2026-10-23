import json
import os
import socket
import urllib.error
import urllib.request

from flask import Flask, jsonify, send_from_directory


SACHET_ENDPOINT = os.environ.get(
    "SACHET_ENDPOINT",
    "https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails",
)
UPSTREAM_TIMEOUT_SECONDS = 12
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
PROJECT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

app = Flask(__name__)


def error_response(message, status):
    response = jsonify({"error": message})
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index():
    return send_from_directory(PROJECT_DIR, "index.html")


@app.get("/<path:asset>")
def static_asset(asset):
    if asset not in {"styles.css", "api.js", "app.js"}:
        return error_response("Not found.", 404)
    return send_from_directory(PROJECT_DIR, asset)


@app.get("/api/alerts")
def alerts():
    request = urllib.request.Request(
        SACHET_ENDPOINT,
        headers={"Accept": "application/json", "User-Agent": "FloodGuardAI/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as upstream:
            if not 200 <= upstream.status < 300:
                return error_response(
                    f"SACHET returned HTTP {upstream.status}.", 502
                )
            content_type = upstream.headers.get("Content-Type", "").lower()
            if "application/json" not in content_type and "+json" not in content_type:
                return error_response(
                    "SACHET returned an unsupported content type; JSON was expected.",
                    502,
                )
            body = upstream.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        return error_response(f"SACHET returned HTTP {error.code}.", 502)
    except (urllib.error.URLError, socket.timeout, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return error_response("The SACHET request timed out.", 504)
        return error_response("Could not connect to SACHET.", 502)
    except OSError:
        return error_response("Could not read the SACHET response.", 502)

    if len(body) > MAX_RESPONSE_BYTES:
        return error_response("The SACHET response exceeded the 2 MiB limit.", 502)
    try:
        records = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return error_response("SACHET returned malformed JSON.", 502)
    if not isinstance(records, list) or any(
        not isinstance(record, dict) for record in records
    ):
        return error_response(
            "SACHET must return a JSON array containing only alert objects.", 502
        )

    response = jsonify(records)
    response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
