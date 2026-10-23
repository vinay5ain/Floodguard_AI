# FloodGuard AI — Mini Disaster Alert Dashboard

FloodGuard AI is a responsive, plain HTML/CSS/JavaScript dashboard for viewing official disaster alerts published through SACHET, the NDMA alert portal. Its slogan is **“Predict Before It Floods.”** It is an alert monitor, not a forecasting or emergency-services system.

## Data and interpretation

The dashboard requests `https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails` through the local proxy. The endpoint was tested during implementation and returned HTTP 200 with `application/json;charset=UTF-8`, a JSON array (33 records at that time), and fields including `identifier`, `effective_start_time`, `effective_end_time`, `disaster_type`, `area_description`, `severity_level`, `warning_message`, `severity_color`, and `alert_source`. The live response can change; the code preserves each original record on the normalized object for debugging.

The API response did not include an issued-at timestamp or a per-alert official URL. Accordingly, the UI says when an alert becomes effective, identifies the issue time as not provided, and does not invent a record link. The SACHET portal itself is linked as the official source.

Severity is derived only from reported `severity_color`, `severity`, and `severity_level`: red or explicit severe/extreme/critical terms map to severe; orange or an explicit alert/warning maps to warning; yellow or watch/advisory maps to watch. Anything else remains **unspecified**; it is never presented as low risk. Validity is computed only when both effective time fields parse. The default view shows records whose reported time range includes the current time; expired, upcoming, all, and unknown-validity views are also available. Flood-related counts use a transparent match against reported type/title text for `flood`, `flooding`, `inundation`, or `waterlogging`.

**A successful empty response is not an API failure.** It is shown as zero returned records, with a specific empty-data message. If the proxy or upstream is unavailable, totals remain unavailable (shown as dashes), an error banner explains that live data could not be retrieved, and any previous successful response is retained as potentially stale.

## Run locally (Windows)

You need Python 3.9 or newer and an internet connection to retrieve live SACHET alerts. No Node.js installation is needed to run the dashboard.

1. Open PowerShell or the VS Code terminal.
2. Change to the project directory:

   ```powershell
   cd "D:\VINAY\Projects\FLOODGUARDAI3rd\floodguard-mini"
   ```

   If you placed the project somewhere else, use that folder's path instead.

3. Create a Python virtual environment and install Flask:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r proxy\requirements.txt
   ```

   If the `py` command is not available, replace it with `python`.

4. Start the dashboard and proxy:

   ```powershell
   .\.venv\Scripts\python.exe proxy\app.py
   ```

5. Open <http://127.0.0.1:5000/> in your browser. Keep the terminal window open while using the dashboard. Press **Ctrl+C** in that terminal to stop the server.

The proxy serves the static dashboard and the same-origin `/api/alerts` route, so the browser does not need cross-origin access to SACHET. The interface refreshes every five minutes; use **Refresh** or **Retry** to request an update sooner. The interval and request timeout are configured in `app.js` and `api.js`.

### Optional: activate the virtual environment

Instead of entering the `.venv\Scripts\python.exe` path for every command, you can activate the environment first:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r proxy\requirements.txt
python proxy\app.py
```

If PowerShell blocks activation scripts, use the direct `.venv\Scripts\python.exe` commands above; changing the machine's script execution policy is not required.

### Troubleshooting

- **`py` or `python` is not recognized:** Install Python 3.9 or newer, then reopen the terminal.
- **The page does not open:** Confirm the server is still running and visit <http://127.0.0.1:5000/>.
- **The page opens but live alerts are unavailable:** Check your internet connection and try **Retry**. The dashboard will show an error rather than treating an API failure as zero alerts.
- **Port 5000 is already in use:** Start the app on another port with `$env:PORT = "5001"; .\.venv\Scripts\python.exe proxy\app.py`, then open <http://127.0.0.1:5001/>.

To change the upstream endpoint for local testing or if SACHET publishes a replacement, set `SACHET_ENDPOINT` before starting the proxy. The proxy has a 12-second upstream timeout, caps response size at 2 MiB, requires a successful HTTP response and JSON content type, and rejects malformed JSON or a response that is not an array of objects. It returns explicit 502/504 errors rather than fake alert data.

```powershell
$env:SACHET_ENDPOINT = "https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails"
py proxy\app.py
```

## CORS and endpoint changes

The tested SACHET endpoint did not return an `Access-Control-Allow-Origin` header. Browsers therefore cannot be relied on to fetch it directly. This project uses a small local Flask proxy; it does not use `mode: "no-cors"`. If the upstream later enables appropriate CORS, the proxy is still the configured access path; update `API_PATH` in `api.js` and the serving arrangement deliberately if you choose to remove it.

If the endpoint changes or becomes unavailable, first inspect its current status, content type, and actual response structure. Update the proxy validation and the explicit field mappings in `api.js` to match verified data; do not infer missing values. The UI distinguishes invalid responses, unavailable requests, and valid empty responses. Follow SACHET and local authorities for official guidance.

## Tests

The automated tests use clearly separated in-memory fixtures; they do not replace production API data. Run them with Node.js 18 or newer:

```powershell
node --test tests\api.test.cjs
```

The tests cover actual field normalization, missing and unexpected fields, de-duplication, empty and invalid shapes, observed IST timestamps, search/filter/sort behavior, and unknown severity/validity. To smoke-test the live integration, start the proxy and open the dashboard; it displays errors explicitly if the upstream becomes unavailable.
