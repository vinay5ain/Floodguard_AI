import { useCallback, useEffect, useMemo, useState } from "react";
import { filterAndSort, isFloodRelated, normalizeAlerts } from "./sachetAlerts.js";

const NAV_ITEMS = [
  ["home", "Home"],
  ["alerts", "Alerts"],
  ["about", "About Us"],
  ["contact", "Contact Us"],
  ["urban", "Urban Flooding"],
];

function readPage() {
  const path = window.location.pathname.replace(/\/$/, "");
  if (path === "/alerts") return "alerts";
  if (path === "/about") return "about";
  if (path === "/contact") return "contact";
  if (path === "/urban-flooding") return "urban";
  return "home";
}

async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The service returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(body.error || `The service returned HTTP ${response.status}.`);
  return body;
}

function Icon({ name, size = 20 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  const paths = {
    mark: <><path d="M12 3.2 19 6v5.2c0 4.6-2.8 7.9-7 9.6-4.2-1.7-7-5-7-9.6V6l7-2.8Z" /><path d="M8.3 12.3c1.1-.8 2-.8 3.1 0s2 .8 3.1 0" /><path d="M12 9.1v6.5" /></>,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.2" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4.9 9a7.5 7.5 0 0 1 12.7-2L20 12" /><path d="M4 17v-5h5" /><path d="M19.1 15a7.5 7.5 0 0 1-12.7 2L4 12" /></>,
    rain: <><path d="M7 15.5a4.5 4.5 0 1 1 .5-9A5.5 5.5 0 0 1 18 8a3.8 3.8 0 0 1-.3 7.5H7Z" /><path d="m9 18-1 2M14 18l-1 2M19 18l-1 2" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  };
  return <svg {...common}>{paths[name] || paths.mark}</svg>;
}

function Header({ page, navigate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const go = (target) => {
    setMenuOpen(false);
    navigate(target);
  };
  return (
    <header className="site-header">
      <div className="header-inner">
        <button className="brand" type="button" onClick={() => go("home")} aria-label="FloodGuard AI home">
          <span className="brand-mark"><Icon name="mark" size={26} /></span>
          <span><strong>FloodGuard <span>AI</span></strong><small>Local awareness. Better prepared.</small></span>
        </button>
        <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name={menuOpen ? "close" : "menu"} />
        </button>
        <nav className={menuOpen ? "main-nav open" : "main-nav"} aria-label="Main navigation">
          {NAV_ITEMS.map(([key, label]) => (
            <button key={key} type="button" className={page === key ? "nav-link active" : "nav-link"} aria-current={page === key ? "page" : undefined} onClick={() => go(key)}>{label}</button>
          ))}
        </nav>
      </div>
    </header>
  );
}

function LocationPicker({ location, onChoose, compact = false }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [showCoordinates, setShowCoordinates] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  async function search(event) {
    event.preventDefault();
    if (!query.trim()) {
      setMessage("Enter a city, district, or locality in India.");
      return;
    }
    setSearching(true);
    setMessage("");
    setResults([]);
    try {
      const params = new URLSearchParams({ q: query.trim() });
      const data = await readJson(await fetch(`/api/geocode?${params}`));
      if (!data.results.length) setMessage("No locations were found. Try a nearby city or district name.");
      else setResults(data.results);
    } catch (error) {
      setMessage(`${error.message} You can also use device location or enter coordinates.`);
    } finally {
      setSearching(false);
    }
  }

  async function useDeviceLocation() {
    setMessage("");
    if (!navigator.geolocation) {
      setMessage("This browser does not provide location access. Search for a place or enter coordinates.");
      return;
    }
    setSearching(true);
    navigator.geolocation.getCurrentPosition(async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      try {
        const params = new URLSearchParams({ latitude: String(lat), longitude: String(lon) });
        const data = await readJson(await fetch(`/api/reverse-geocode?${params}`));
        await onChoose(data.result);
        setMessage("Device location selected. Coordinates were sent to Open-Meteo for the forecast.");
      } catch (error) {
        await onChoose({ latitude: lat, longitude: lon, display_name: `Device location (${lat.toFixed(4)}, ${lon.toFixed(4)})`, address: {} });
        setMessage(`Location selected, but its place name could not be resolved: ${error.message}`);
      } finally {
        setSearching(false);
      }
    }, (error) => {
      const reason = error.code === 1 ? "Location permission was denied." : error.code === 2 ? "The device could not determine its location." : "The location request timed out.";
      setMessage(`${reason} Search for a place or enter coordinates.`);
      setSearching(false);
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  }

  async function useCoordinates(event) {
    event.preventDefault();
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setMessage("Enter a latitude from −90 to 90 and longitude from −180 to 180.");
      return;
    }
    await onChoose({ latitude: lat, longitude: lon, display_name: `Coordinates ${lat.toFixed(4)}, ${lon.toFixed(4)}`, address: {} });
    setMessage("Coordinates selected. Place-name matching may be limited without an administrative area.");
  }

  async function choose(result) {
    setResults([]);
    setQuery(result.display_name.split(",").slice(0, 2).join(","));
    setMessage("Location selected. Loading current conditions and forecast…");
    await onChoose(result);
  }

  return (
    <section className={compact ? "location-picker compact" : "location-picker"} aria-labelledby={compact ? "location-title-compact" : "location-title"}>
      <div className="picker-heading">
        <div className="section-eyebrow"><Icon name="pin" size={16} /> Location</div>
        <h2 id={compact ? "location-title-compact" : "location-title"}>{location ? "Change selected location" : "Choose a location"}</h2>
        <p>Search a place in India, use your device location, or enter coordinates.</p>
      </div>
      <form className="location-form" onSubmit={search}>
        <label className="sr-only" htmlFor={compact ? "place-query-compact" : "place-query"}>Search a city, district, or locality</label>
        <div className="search-control"><Icon name="search" size={19} /><input id={compact ? "place-query-compact" : "place-query"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. Connaught Place, New Delhi" autoComplete="off" /></div>
        <button className="button button-primary" type="submit" disabled={searching}>{searching ? "Searching…" : "Search places"}</button>
        <button className="button button-outline" type="button" onClick={useDeviceLocation} disabled={searching}><Icon name="pin" size={17} /> Use my location</button>
      </form>
      {results.length > 0 && (
        <div className="geocode-results" role="listbox" aria-label="Location search results">
          <p className="result-caption">Choose the matching place</p>
          {results.map((result) => <button className="result-option" key={`${result.osm_type}-${result.osm_id}-${result.latitude}`} type="button" role="option" aria-selected="false" onClick={() => choose(result)}>
            <span>{result.display_name}</span><small>{result.latitude.toFixed(4)}, {result.longitude.toFixed(4)}</small>
          </button>)}
          <p className="attribution">Search by OpenStreetMap · © OpenStreetMap contributors</p>
        </div>
      )}
      <details className="coordinate-entry" open={showCoordinates} onToggle={(event) => setShowCoordinates(event.currentTarget.open)}>
        <summary>Enter coordinates manually</summary>
        <form className="coordinates-form" onSubmit={useCoordinates}>
          <label>Latitude<input type="number" min="-90" max="90" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="28.6139" required /></label>
          <label>Longitude<input type="number" min="-180" max="180" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="77.2090" required /></label>
          <button className="button button-outline" type="submit">Use coordinates</button>
        </form>
      </details>
      {message && <p className="picker-message" role="status" aria-live="polite">{message}</p>}
      {location && <div className="selected-location"><span className="status-dot" /> <span><small>Selected location</small><strong>{location.display_name}</strong><small>{Number(location.latitude).toFixed(4)}, {Number(location.longitude).toFixed(4)}</small></span></div>}
    </section>
  );
}

function weatherLabel(code) {
  if (code == null || !Number.isFinite(Number(code))) return "Conditions unavailable";
  const labels = { 0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Heavy showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail" };
  return labels[Number(code)] || "Conditions unavailable";
}

function currentHourRows(weather, limit = 24) {
  if (!weather?.hourly?.time || !weather?.hourly?.precipitation) return [];
  const times = weather.hourly.time;
  const currentTime = String(weather.current?.time || "");
  const threshold = currentTime.length >= 13 ? `${currentTime.slice(0, 13)}:00` : "";
  let start = times.findIndex((time) => typeof time === "string" && time >= threshold);
  if (start < 0) start = 0;
  const chances = weather.hourly.precipitation_probability || [];
  return times.slice(start, start + limit).map((time, offset) => ({ time, rain: weather.hourly.precipitation[start + offset], chance: chances[start + offset] }));
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value.length === 16 ? `${value}:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("en-IN", { hour: "numeric", hour12: true });
}

function formatDate(value, options = { weekday: "short", day: "numeric", month: "short" }) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-IN", { ...options, timeZone: "UTC" });
}

function RainChart({ weather, compact = false }) {
  const rows = currentHourRows(weather, 24);
  if (!rows.length) return <div className="chart-empty">Hourly rainfall forecast will appear when weather data is available.</div>;
  const values = rows.map((row) => Number(row.rain)).filter(Number.isFinite);
  const max = Math.max(1, ...values);
  return <div className={compact ? "rain-chart compact" : "rain-chart"} role="img" aria-label={`Hourly precipitation forecast for the next ${rows.length} hours, in millimetres`}>
    {rows.map((row, index) => {
      const amount = row.rain == null ? Number.NaN : Number(row.rain);
      const height = Number.isFinite(amount) ? Math.max(amount > 0 ? 7 : 2, Math.round((amount / max) * 100)) : 2;
      return <div className="chart-column" key={`${row.time}-${index}`} title={`${formatTime(row.time)} · ${Number.isFinite(amount) ? amount.toFixed(1) : "—"} mm`}>
        <span className="chart-amount">{Number.isFinite(amount) ? amount.toFixed(amount < 10 ? 1 : 0) : "—"}</span>
        <span className="chart-bar-track"><span className="chart-bar" style={{ height: `${height}%` }} /></span>
        <span className="chart-time">{index % (compact ? 6 : 3) === 0 ? formatTime(row.time) : ""}</span>
      </div>;
    })}
  </div>;
}

function WeatherPanel({ weather, loading, error, location }) {
  if (!location) return <div className="empty-panel"><Icon name="pin" size={22} /><div><strong>Weather for your area</strong><p>Select a location to see current conditions and the forecast.</p></div></div>;
  if (loading) return <div className="empty-panel" role="status"><span className="loader" /> <div><strong>Loading local forecast</strong><p>Requesting current conditions from Open-Meteo…</p></div></div>;
  if (error) return <div className="notice notice-error" role="alert"><strong>Weather data unavailable</strong><p>{error}</p><p>No weather values have been substituted.</p></div>;
  if (!weather) return <div className="empty-panel"><div><strong>Forecast not loaded</strong><p>Choose a location or try again.</p></div></div>;
  const current = weather.current || {};
  const units = weather.current_units || {};
  const currentDate = String(weather.current?.time || "").slice(0, 10);
  const days = (weather.daily?.time || []).map((date, index) => ({ date, index }))
    .filter(({ date }) => typeof date === "string" && (!currentDate || date.slice(0, 10) >= currentDate)).slice(0, 5);
  const daily = weather.daily || {};
  const dailyRain = daily.precipitation_sum || [];
  return <div className="weather-wrap">
    <div className="weather-current">
      <div className="weather-condition"><span className="weather-symbol" aria-hidden="true">{current.weather_code == null ? "·" : Number(current.weather_code) >= 61 ? "☂" : Number(current.weather_code) === 0 ? "☀" : "☁"}</span><div><span className="section-eyebrow">Current conditions · {weather.timezone || "local time"}</span><h3>{weatherLabel(current.weather_code)}</h3><small>Open-Meteo · {weather.retrieved_at_utc ? `retrieved ${new Date(weather.retrieved_at_utc).toLocaleTimeString("en-IN")}` : "time unavailable"}</small></div></div>
      <div className="temperature">{current.temperature_2m != null && Number.isFinite(Number(current.temperature_2m)) ? `${Math.round(Number(current.temperature_2m))}°` : "—"}<small>{units.temperature_2m || "°C"}</small></div>
      <div className="weather-facts">
        <Metric label="Rain now" value={`${current.precipitation ?? "—"} ${units.precipitation || "mm"}`} />
        <Metric label="Humidity" value={`${current.relative_humidity_2m ?? "—"}${units.relative_humidity_2m || "%"}`} />
        <Metric label="Wind" value={`${current.wind_speed_10m ?? "—"} ${units.wind_speed_10m || "km/h"}`} />
      </div>
    </div>
    <div className="weather-section-head"><div><span className="section-eyebrow">Actual API forecast</span><h3>Rainfall · next 24 hours</h3></div><span className="unit-note">mm per hour</span></div>
    <RainChart weather={weather} compact />
    <div className="daily-strip" aria-label="Seven-day weather forecast">
      {days.map(({ date, index }) => <div className="daily-cell" key={date}><span>{formatDate(date)}</span><strong>{dailyRain[index] != null && Number.isFinite(Number(dailyRain[index])) ? `${Number(dailyRain[index]).toFixed(1)} mm` : "—"}</strong><small>{weatherLabel(daily.weather_code?.[index])}</small></div>)}
    </div>
  </div>;
}

function Metric({ label, value }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function HomePage({ location, weather, weatherLoading, weatherError, onChoose, navigate, retryWeather }) {
  return <main>
    <section className="hero page-width">
      <div className="hero-copy"><div className="hero-kicker"><span className="live-indicator" /> WEATHER &amp; OFFICIAL ALERT AWARENESS</div>
        <h1>Know what is happening.<br /><em>Be ready for what comes next.</em></h1>
        <p>FloodGuard brings local weather, rainfall records and NDMA Sachet alerts together to help people understand changing conditions in Indian cities.</p>
        <div className="hero-actions"><button className="button button-primary button-large" type="button" onClick={() => navigate("urban")}>Explore urban flood risk <Icon name="arrow" /></button><span className="hero-note">Evidence-led information, with limits clearly shown.</span></div>
      </div>
      <div className="hero-note-card"><div className="note-card-mark"><Icon name="rain" size={24} /></div><p>Weather can change quickly. Rainfall indicators are not flood guarantees, and official instructions always take priority.</p><a href="https://sachet.ndma.gov.in/" target="_blank" rel="noreferrer">Visit NDMA Sachet <Icon name="arrow" size={15} /></a></div>
    </section>

    <section className="page-width home-grid" aria-label="Location and local weather">
      <LocationPicker location={location} onChoose={onChoose} />
      <div className="weather-panel panel"><div className="panel-heading"><div><span className="section-eyebrow">Local conditions</span><h2>Weather outlook</h2>{location && <p className="location-caption">{location.display_name}</p>}</div>
        {location && !weatherLoading && <button type="button" className="icon-button" aria-label="Refresh weather" title="Refresh weather" onClick={retryWeather}><Icon name="refresh" /></button>}
      </div><WeatherPanel weather={weather} loading={weatherLoading} error={weatherError} location={location} /></div>
    </section>

    <section className="page-width explainer-section"><div className="section-intro"><span className="section-eyebrow">A clearer local picture</span><h2>Three kinds of evidence.<br /><em>One place to understand them.</em></h2></div>
      <div className="evidence-grid">
        <article className="evidence-item"><span className="evidence-number">01</span><h3>Official alerts</h3><p>See Sachet alerts that name your area, plus nearby alerts only where the feed provides coordinates for distance checks.</p><a href="https://sachet.ndma.gov.in/" target="_blank" rel="noreferrer">Source: NDMA Sachet <Icon name="arrow" size={15} /></a></article>
        <article className="evidence-item"><span className="evidence-number">02</span><h3>Weather and rainfall</h3><p>Review Open-Meteo forecast rainfall alongside historical measurements from supplied Central Water Commission station files.</p><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Source: Open-Meteo <Icon name="arrow" size={15} /></a></article>
        <article className="evidence-item"><span className="evidence-number">03</span><h3>Risk, explained</h3><p>A transparent rainfall indicator sets context. Gemini may summarize the evidence; it does not create a warning or flood probability.</p><button type="button" className="text-link" onClick={() => navigate("urban")}>See the assessment <Icon name="arrow" size={15} /></button></article>
      </div>
    </section>

    <section className="how-section"><div className="page-width how-inner"><div><span className="section-eyebrow light">How FloodGuard works</span><h2>Useful context.<br /><em>Without false certainty.</em></h2><p>Choose a location, check the source data, and read what is known—along with what is missing. FloodGuard is an awareness tool, not an emergency service.</p></div>
      <ol className="steps-list"><li><span>1</span><div><strong>Select a place</strong><p>Search an Indian locality or allow device location.</p></div></li><li><span>2</span><div><strong>Review the sources</strong><p>Weather, CWC station data and official alerts stay identified as separate sources.</p></div></li><li><span>3</span><div><strong>Use local guidance</strong><p>Follow verified warnings and instructions from public authorities.</p></div></li></ol>
    </div></section>
    <div className="page-width home-cta"><p>Ready to review the local evidence?</p><button type="button" className="button button-primary" onClick={() => navigate("urban")}>Open Urban Flooding <Icon name="arrow" size={17} /></button></div>
  </main>;
}

function AlertCard({ alert }) {
  const severityClass = ["severe", "warning", "watch"].includes(alert.severity) ? alert.severity : "unknown";
  const matchLabel = alert.match_type === "nearby" ? `Nearby · ${alert.distance_km} km away` : alert.match_type === "same_area" ? "Same administrative area" : "Exact or named area";
  return <article className="alert-card">
    <div className="alert-card-top"><span className={`severity-tag ${severityClass}`}><i />{alert.severity_label || "Severity unspecified"}</span><span className="match-tag">{matchLabel}</span></div>
    <h4>{alert.type || "Official alert"}</h4>
    <p className="alert-area">{alert.area || "Affected area not provided"}</p>
    {alert.message && <p className="alert-message">{alert.message}</p>}
    <dl className="alert-meta"><div><dt>Effective from</dt><dd>{alert.effective_start || "Not provided"}</dd></div><div><dt>Valid until</dt><dd>{alert.effective_end || "Not provided"}</dd></div><div><dt>Issued at</dt><dd>{alert.issued_at || "Not provided by feed"}</dd></div><div><dt>Source</dt><dd>{alert.source || "NDMA Sachet"}</dd></div></dl>
    {alert.distance_km != null && <p className="distance-note">Estimated distance from {alert.distance_basis === "SACHET alert centroid" ? "the SACHET alert centroid" : "feed coordinates"}: {alert.distance_km} km</p>}
  </article>;
}

function AlertGroup({ title, alerts, note }) {
  if (!alerts?.length) return null;
  return <div className="alert-group"><div className="subsection-heading"><h4>{title} <span>{alerts.length}</span></h4>{note && <p>{note}</p>}</div><div className="alert-list">{alerts.map((alert, index) => <AlertCard key={alert.id || `${alert.area}-${index}`} alert={alert} />)}</div></div>;
}

function SachetPanel({ data, loading, error, onRefresh }) {
  return <section className="dashboard-section" id="sachet-alerts" aria-labelledby="alerts-title">
    <div className="dashboard-section-heading"><div><div className="section-eyebrow"><span className="official-indicator" /> Official source</div><h2 id="alerts-title">Sachet location alerts</h2><p>Matches are based on the locations and coordinates present in the available NDMA Sachet feed.</p></div>
      <button type="button" className="button button-outline" onClick={onRefresh} disabled={loading}><Icon name="refresh" size={16} /> {loading ? "Refreshing…" : "Refresh feed"}</button></div>
    {loading && <div className="empty-panel" role="status"><span className="loader" /><div><strong>Checking NDMA Sachet</strong><p>Requesting the current public alert feed…</p></div></div>}
    {!loading && error && <div className="notice notice-error" role="alert"><strong>Official alert feed could not be verified</strong><p>{error}</p><p>No matching alert result can be concluded from an unavailable feed.</p></div>}
    {!loading && data?.status === "unavailable" && <div className="notice notice-error" role="alert"><strong>Official alert feed could not be verified</strong><p>{data.message} {data.error || ""}</p><p>Last successful update: {data.last_successful_update || "not available"}</p></div>}
    {!loading && data && data.status !== "unavailable" && <>
      {data.status === "stale" ? <div className="notice notice-warning" role="status"><strong>Feed update could not be verified</strong><p>{data.message}</p><p>Last successful update: {data.last_successful_update || "not available"} · {data.error}</p></div> : <div className="feed-meta"><span className="status-dot" /> <span>Feed refreshed successfully</span><span>Last successful update: {data.last_successful_update || "not provided"}</span><a href={data.source_url} target="_blank" rel="noreferrer">Official source <Icon name="arrow" size={14} /></a></div>}
      {data.exact_matches?.length > 0 && <AlertGroup title="Exact or named location matches" alerts={data.exact_matches} />}
      {data.same_area_matches?.length > 0 && <AlertGroup title="Same administrative area" alerts={data.same_area_matches} />}
      {data.nearby_matches?.length > 0 && <AlertGroup title={`Nearby alerts · within ${data.radius_km} km`} alerts={data.nearby_matches} />}
      {data.no_match_message && data.status === "available" && <div className="notice notice-neutral"><strong>{data.no_match_message}</strong><p>No alert found in this feed does not mean the area is safe. Check local authority updates.</p></div>}
      {data.distance_matching_note && <p className="data-note">{data.distance_matching_note}</p>}
      <p className="source-footnote">Alert wording, severity and effective times are shown only when the feed supplies them. The feed does not provide a separate issue time for every record.</p>
    </>}
    {!loading && !error && !data && <div className="empty-panel"><div><strong>Choose a location to check alerts</strong><p>The latest verified feed result will appear here.</p></div></div>}
  </section>;
}

function RiskPanel({ assessment, loading, error, forecastWindow, onWindowChange, onRetry }) {
  if (loading) return <section className="dashboard-section"><div className="empty-panel" role="status"><span className="loader" /><div><strong>Preparing the rainfall assessment</strong><p>Loading the forecast and checking available CWC station records…</p></div></div></section>;
  if (error) return <section className="dashboard-section"><div className="notice notice-error" role="alert"><strong>Risk assessment unavailable</strong><p>{error}</p><button className="button button-outline" type="button" onClick={onRetry}>Try again</button></div></section>;
  if (!assessment) return <section className="dashboard-section"><div className="empty-panel"><div><strong>Select a location first</strong><p>The weather-based assessment uses the same location selected for Sachet alerts.</p></div></div></section>;
  const risk = assessment.risk;
  const categoryClass = risk.category.toLowerCase().replaceAll(" ", "-");
  const weather = assessment.weather;
  const station = assessment.csv_summary;
  const gemini = assessment.gemini;
  return <section className="dashboard-section" id="flood-risk" aria-labelledby="risk-title">
    <div className="dashboard-section-heading"><div><div className="section-eyebrow">Weather-based indicator · not an official warning</div><h2 id="risk-title">Chances of urban flooding</h2><p>Rainfall evidence is used for an indicative category. No validated flood prediction model or calibrated probability is available.</p></div>
      <label className="window-select">Forecast window<select value={forecastWindow} onChange={(event) => onWindowChange(event.target.value)}><option value="24h">Next 24 hours</option><option value="7d">Next 7 days</option></select></label></div>
    <div className="risk-summary panel">
      <div className={`risk-category ${categoryClass}`}><span className="risk-category-label">Indicative rainfall category</span><strong>{risk.category}</strong><span>{risk.forecast_window}</span></div>
      <div className="risk-explanation"><p className="method-label">{risk.method}</p><ul className="factor-list">{(risk.main_factors || []).map((factor, index) => <li key={`${factor}-${index}`}>{factor}</li>)}</ul>{(!risk.main_factors || risk.main_factors.length === 0) && <p>There is not enough complete forecast evidence to assign a rainfall category.</p>}
        <div className="data-freshness"><span>Forecast retrieved: {weather?.retrieved_at_utc ? new Date(weather.retrieved_at_utc).toLocaleString("en-IN") : "not available"}</span><span>Weather source: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></span></div>
      </div>
    </div>
    <div className="risk-evidence-grid">
      <div className="panel evidence-panel"><div className="panel-heading"><div><span className="section-eyebrow">Weather evidence</span><h3>Rainfall forecast</h3></div><Icon name="rain" /></div>
        <div className="rain-stats"><Metric label="Next 3 hours" value={assessment.forecast_features.forecast_3h_mm == null ? "—" : `${assessment.forecast_features.forecast_3h_mm} mm`} /><Metric label="Next 6 hours" value={assessment.forecast_features.forecast_6h_mm == null ? "—" : `${assessment.forecast_features.forecast_6h_mm} mm`} /><Metric label="Next 24 hours" value={assessment.forecast_features.forecast_24h_mm == null ? "—" : `${assessment.forecast_features.forecast_24h_mm} mm`} /><Metric label="Next 7 days" value={assessment.forecast_features.forecast_7d_mm == null ? "—" : `${assessment.forecast_features.forecast_7d_mm} mm`} /></div>
        <RainChart weather={weather} />
      </div>
      <div className="panel evidence-panel"><div className="panel-heading"><div><span className="section-eyebrow">Historical context</span><h3>CWC station record</h3></div></div>
        {station?.available ? <><div className="station-name">{station.station || "CWC rainfall station"}</div><p className="station-place">{[station.district, station.state].filter(Boolean).join(", ") || "Administrative area unavailable"} · {station.distance_km} km away</p><div className="rain-stats two"><Metric label="Latest rainfall" value={station.last_rainfall_mm == null ? "—" : `${station.last_rainfall_mm} mm`} /><Metric label="3-hour sum" value={station.rain_3h_mm == null ? "—" : `${station.rain_3h_mm} mm`} /></div><p className="data-note">Last observation: {station.last_observed_at_utc || "timestamp unavailable"} · {station.observation_freshness || "freshness unknown"}{station.observation_age_hours != null ? ` (${station.observation_age_hours} hours old)` : ""}. Station measurements may not represent current street conditions.</p></> : <div className="empty-evidence"><strong>Station measurements unavailable for this match</strong><p>{station?.message || "No valid CWC station is available within the configured distance."}</p></div>}
      </div>
    </div>
    <div className="risk-details-grid">
      <div className="details-block"><h3>Data quality and limitations</h3><ul>{(risk.data_quality_limitations || []).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}{!station?.available && station?.message && <li>{station.message}</li>}</ul></div>
      <div className="details-block precautions"><h3>Practical precautions</h3><ul>{(gemini?.available && gemini.precautions?.length ? gemini.precautions : risk.precautions || []).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>
    </div>
    <div className="gemini-note"><div><span className="section-eyebrow">AI-assisted explanation</span><h3>{gemini?.available ? "Evidence summary" : "Local assessment remains available"}</h3></div>
      {gemini?.available ? <p>{gemini.summary}</p> : <p>{gemini?.message || "Gemini explanation is unavailable; the deterministic rainfall assessment and its limitations are shown above."}</p>}
      {gemini?.available && <small>Generated by {gemini.model}. The category is calculated by the local rainfall rules.</small>}
    </div>
    <p className="safety-line">FloodGuard does not guarantee that a location will or will not flood. Follow NDMA Sachet and local authority instructions.</p>
  </section>;
}

function UrbanPage({ location, onChoose }) {
  const [forecastWindow, setForecastWindow] = useState("24h");
  const [alerts, setAlerts] = useState(null);
  const [alertError, setAlertError] = useState("");
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [assessment, setAssessment] = useState(null);
  const [riskError, setRiskError] = useState("");
  const [riskLoading, setRiskLoading] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const locationKey = location ? `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}` : "";
  const alertCache = useMemo(() => new Map(), []);
  const loadDashboard = useCallback(async (force = false) => {
    if (!location) return;
    const key = `${locationKey}:${forecastWindow}`;
    if (!force && alertCache.has(`${locationKey}:data`)) {
      setAlerts(alertCache.get(`${locationKey}:data`));
      setAlertsLoading(false);
    } else {
      setAlertsLoading(true);
      setAlertError("");
      try {
        const response = await fetch("/api/alerts/match", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ latitude: location.latitude, longitude: location.longitude, location, refresh: force }),
        });
        const payload = await response.json();
        if (!response.ok && !payload.status) throw new Error(payload.error || `SACHET returned HTTP ${response.status}.`);
        alertCache.set(`${locationKey}:data`, payload);
        setAlerts(payload);
      } catch (error) {
        setAlertError(error.message);
        setAlerts(null);
      } finally {
        setAlertsLoading(false);
      }
    }
    setRiskLoading(true);
    setRiskError("");
    try {
      const currentAlerts = force ? alertCache.get(`${locationKey}:data`) : alertCache.get(`${locationKey}:data`) || alerts;
      const response = await fetch("/api/urban-risk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: location.latitude, longitude: location.longitude, location, forecast_window: forecastWindow, official_alert_context: currentAlerts ? {
          status: currentAlerts.status,
          last_successful_update: currentAlerts.last_successful_update,
          exact_matches: currentAlerts.exact_matches || [],
          same_area_matches: currentAlerts.same_area_matches || [],
          nearby_matches: currentAlerts.nearby_matches || [],
        } : { status: "unavailable" } }),
      });
      setAssessment(await readJson(response));
      setAnnouncement("The location alert and rainfall assessment have been updated.");
    } catch (error) {
      setRiskError(error.message);
      setAssessment(null);
    } finally {
      setRiskLoading(false);
    }
  }, [location, locationKey, forecastWindow, alertCache, alerts]);

  useEffect(() => {
    if (!location) {
      setAlerts(null); setAssessment(null); setAlertError(""); setRiskError("");
      return;
    }
    loadDashboard(false);
  }, [locationKey, forecastWindow, refreshCount]); // loadDashboard captures the selected location/window.

  const refresh = () => {
    alertCache.delete(`${locationKey}:data`);
    setRefreshCount((count) => count + 1);
  };

  return <main className="page-width urban-page">
    <div className="page-heading"><div><span className="section-eyebrow">Location dashboard</span><h1>Urban flooding</h1><p>Review official alerts and rainfall evidence for one selected place.</p></div><span className="dashboard-date">India · local forecast times</span></div>
    <LocationPicker location={location} onChoose={onChoose} compact />
    {!location && <div className="dashboard-choice-grid"><article><span className="choice-number">01</span><h2>Sachet location alerts</h2><p>Check exact, same-area and coordinate-based nearby matches from the official feed.</p></article><article><span className="choice-number">02</span><h2>Chances of urban flooding</h2><p>Read forecast rainfall and relevant nearby CWC station history as an indicative category.</p></article></div>}
    {location && <>
      <div className="dashboard-choice-grid"><a className="dashboard-choice" href="#sachet-alerts"><span className="choice-number">01</span><span><strong>Sachet location alerts</strong><small>Official feed · exact and nearby matches</small></span><Icon name="arrow" /></a><a className="dashboard-choice" href="#flood-risk"><span className="choice-number">02</span><span><strong>Chances of urban flooding</strong><small>Weather data · rainfall category</small></span><Icon name="arrow" /></a></div>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <SachetPanel data={alerts} loading={alertsLoading} error={alertError} onRefresh={refresh} />
      <RiskPanel assessment={assessment} loading={riskLoading} error={riskError} forecastWindow={forecastWindow} onWindowChange={setForecastWindow} onRetry={() => loadDashboard(true)} />
    </>}
  </main>;
}

function AlertFeedPage() {
  const [records, setRecords] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const [feedStatus, setFeedStatus] = useState("");
  const [now, setNow] = useState(Date.now());
  const [filters, setFilters] = useState({ query: "", severity: "all", type: "all", validity: "active" });

  const refreshFeed = useCallback(async (force = false) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 18000);
    setLoading(true);
    try {
      const response = await fetch(`/api/alerts${force ? "?refresh=1" : ""}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `The alert service returned HTTP ${response.status}.`);
      }
      const alerts = normalizeAlerts(payload, Date.now());
      const status = response.headers.get("X-Feed-Status") || "available";
      setRecords(alerts);
      setFeedStatus(status);
      setLastUpdated(response.headers.get("X-Last-Successful-Update") || "");
      setError(status === "stale" ? "The feed could not be refreshed. Showing records from its last successful update." : "");
    } catch (requestError) {
      setError(requestError.name === "AbortError"
        ? "The alert request timed out. Please retry."
        : requestError instanceof Error ? requestError.message : "The official alert feed could not be loaded.");
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshFeed();
    const refreshTimer = window.setInterval(() => {
      if (!document.hidden) refreshFeed();
    }, 5 * 60 * 1000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refreshFeed]);

  const filteredAlerts = useMemo(
    () => records === null ? [] : filterAndSort(records, filters, now),
    [records, filters, now],
  );
  const alertTypes = useMemo(
    () => records === null ? [] : [...new Set(records.map((alert) => alert.type).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [records],
  );
  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  return <main className="page-width alerts-page">
    <div className="page-heading">
      <div><span className="section-eyebrow">Official national feed</span><h1>Disaster alerts</h1><p>Browse the alert records published by NDMA Sachet. Severity and validity are shown only when supported by the feed.</p></div>
      <button className="button button-outline" type="button" onClick={() => refreshFeed(true)} disabled={loading}><Icon name="refresh" size={17} />{loading ? "Refreshing…" : "Refresh feed"}</button>
    </div>

    {error && <div className={records === null ? "notice notice-error alert-feed-notice" : "notice notice-warning alert-feed-notice"} role={records === null ? "alert" : "status"}>
      <strong>{records === null ? "Official alert feed could not be verified" : "Feed update issue"}</strong><p>{error}</p>
      {records === null && <button className="button button-outline" type="button" onClick={() => refreshFeed(true)} disabled={loading}>Try again</button>}
    </div>}

    <section className="alert-summary" aria-label="Alert summary">
      <article><span>Total records</span><strong>{records === null ? "—" : records.length}</strong><small>Unique records returned by Sachet</small></article>
      <article><span>Severe</span><strong>{records === null ? "—" : records.filter((alert) => alert.severity === "severe").length}</strong><small>Explicit severe classifications</small></article>
      <article><span>Active now</span><strong>{records === null ? "—" : records.filter((alert) => alert.startsAt !== null && alert.endsAt !== null && alert.startsAt <= now && alert.endsAt >= now).length}</strong><small>Within reported effective times</small></article>
      <article><span>Flood-related</span><strong>{records === null ? "—" : records.filter(isFloodRelated).length}</strong><small>Matched from reported alert type or title</small></article>
    </section>

    <section className="alert-feed-section" aria-labelledby="alert-feed-title">
      <div className="alert-feed-heading"><div><span className="section-eyebrow">SACHET alert feed</span><h2 id="alert-feed-title">All published alerts</h2></div>
        <div className="alert-feed-freshness" role="status">
          <span className={feedStatus === "stale" ? "feed-state stale" : "feed-state"} />
          <span>{loading && records === null ? "Retrieving alerts…" : feedStatus === "stale" ? "Last successful data · may be stale" : records === null ? "Waiting for feed" : "Feed data loaded"}</span>
          {lastUpdated && <time dateTime={lastUpdated}>Updated {new Date(lastUpdated).toLocaleString("en-IN")}</time>}
        </div>
      </div>

      <form className="alert-filters" role="search" onSubmit={(event) => event.preventDefault()}>
        <label className="alert-search"><span className="sr-only">Search alerts by location, type, source or message</span><Icon name="search" size={18} /><input type="search" placeholder="Search state, district, location or alert…" value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} /></label>
        <label><span className="sr-only">Filter by severity</span><select value={filters.severity} onChange={(event) => updateFilter("severity", event.target.value)}><option value="all">All severities</option><option value="severe">Severe</option><option value="warning">Warning</option><option value="watch">Watch</option><option value="unknown">Unspecified severity</option></select></label>
        <label><span className="sr-only">Filter by disaster type</span><select value={filters.type} onChange={(event) => updateFilter("type", event.target.value)}><option value="all">All disaster types</option>{alertTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label><span className="sr-only">Filter by validity</span><select value={filters.validity} onChange={(event) => updateFilter("validity", event.target.value)}><option value="active">Active only</option><option value="all">All validity states</option><option value="expired">Expired</option><option value="upcoming">Upcoming</option><option value="unknown">Unknown validity</option></select></label>
      </form>

      <div className="alert-results-count" aria-live="polite">{records === null ? "" : `${filteredAlerts.length} ${filteredAlerts.length === 1 ? "alert" : "alerts"} shown`}</div>
      {loading && records === null && <div className="alert-empty" role="status"><span className="loader" /><p>Retrieving official alerts…</p></div>}
      {records !== null && records.length === 0 && <div className="alert-empty"><strong>No alert records were returned</strong><p>The feed request succeeded and returned an empty list.</p></div>}
      {records !== null && records.length > 0 && filteredAlerts.length === 0 && <div className="alert-empty"><strong>No matching alerts</strong><p>Try changing the search or filters.</p><button className="button button-outline" type="button" onClick={() => setFilters({ query: "", severity: "all", type: "all", validity: "all" })}>Clear filters</button></div>}
      {filteredAlerts.length > 0 && <div className="national-alert-list">{filteredAlerts.map((alert, index) => {
        const severity = ["severe", "warning", "watch"].includes(alert.severity) ? alert.severity : "unknown";
        return <article className="national-alert-card" key={alert.id || `${alert.area}-${alert.startsAtLabel}-${index}`}>
          <div className="national-alert-top"><span className={`severity-tag ${severity}`}><i />{alert.severityLabel}</span><span className={`validity-tag ${alert.status}`}>{alert.status === "unknown" ? "Validity unknown" : alert.status}</span></div>
          <h3>{alert.type || "Official alert"}</h3>
          <p className="national-alert-area">{alert.area || "Affected area not provided"}</p>
          {alert.message && <p className="national-alert-message">{alert.message}</p>}
          <dl><div><dt>Effective from</dt><dd>{alert.startsAtLabel || "Not provided"}</dd></div><div><dt>Valid until</dt><dd>{alert.endsAtLabel || "Not provided"}</dd></div><div><dt>Issued at</dt><dd>Not provided by feed</dd></div><div><dt>Source</dt><dd>{alert.source || "NDMA Sachet"}</dd></div></dl>
        </article>;
      })}</div>}
      <p className="alert-source-note">Official alert records are provided by <a href="https://sachet.ndma.gov.in/" target="_blank" rel="noreferrer">NDMA Sachet</a>. Unspecified severity is not interpreted as low risk. Follow official instructions and local authorities.</p>
    </section>
  </main>;
}

function AboutPage() {
  const team = ["Vinay Kumar Sain", "Vidit Jain", "Sonalii", "Simran", "Sneha"];
  return <main className="page-width content-page">
    <div className="page-heading"><div><span className="section-eyebrow">About the project</span><h1>Better local context<br /><em>for a changing climate.</em></h1><p>FloodGuard AI is a location-aware urban flood monitoring and rainfall awareness project for India.</p></div></div>
    <div className="about-layout"><div className="about-copy">
      <section><h2>The problem</h2><p>Heavy rain can overwhelm streets and drainage systems, while the information people need is spread across weather forecasts, station records and official warnings. Conditions can vary within short distances and change quickly.</p></section>
      <section><h2>What FloodGuard does</h2><p>The application brings a selected location together with Open-Meteo weather forecasts and supplied Central Water Commission rainfall CSVs. It also checks the NDMA Sachet public alert feed for location names and, when the feed includes coordinates, nearby alerts within a configurable radius.</p></section>
      <section><h2>Where AI assists</h2><p>A deterministic backend calculates a transparent rainfall category from configured thresholds. Gemini can provide a concise explanation of the supplied evidence. It does not calculate the category, create official warnings, or produce a flood probability.</p></section>
      <section><h2>Limitations</h2><p>Rainfall alone cannot establish whether a street will flood. The included station records are historical measurements, are not necessarily current, and are not labelled with verified flood events. Feed fields and weather forecasts may be incomplete or unavailable. Always follow current official warnings and local authority instructions.</p></section>
    </div><aside className="team-panel"><span className="section-eyebrow">Project team</span><h2>FloodGuard AI</h2><ul>{team.map((member) => <li key={member}>{member}</li>)}</ul><div className="team-rule" /><p>Project contact</p><a href="tel:9310699618">9310699618</a></aside></div>
  </main>;
}

function ContactPage() {
  return <main className="page-width content-page contact-page"><div className="page-heading"><div><span className="section-eyebrow">Contact us</span><h1>Get in touch.</h1><p>For project-related enquiries, call the contact number below.</p></div></div><section className="contact-card"><span className="section-eyebrow">Project contact</span><a href="tel:9310699618" className="contact-number">9310699618</a><p>Tap to call from a phone-enabled device.</p><a className="button button-primary" href="tel:9310699618">Call FloodGuard AI</a></section></main>;
}

function Footer({ navigate }) {
  return <footer className="site-footer"><div className="page-width footer-main"><div className="footer-brand"><span className="brand-mark"><Icon name="mark" size={25} /></span><div><strong>FloodGuard AI</strong><p>Local awareness. Better prepared.</p></div></div><p className="footer-disclaimer">An information and awareness project. Not an emergency service or a validated flood prediction system.</p><div className="footer-nav">{NAV_ITEMS.map(([key, label]) => <button key={key} type="button" onClick={() => navigate(key)}>{label}</button>)}</div></div><div className="page-width footer-bottom"><span>Project contact <a href="tel:9310699618">9310699618</a></span><span>Geocoding © OpenStreetMap contributors</span><span>Weather by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></span></div></footer>;
}

export default function App() {
  const [page, setPage] = useState(readPage);
  const [location, setLocation] = useState(null);
  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState("");
  const [weatherKey, setWeatherKey] = useState("");

  const navigate = useCallback((target) => {
    const paths = { home: "/", alerts: "/alerts", about: "/about", contact: "/contact", urban: "/urban-flooding" };
    if (paths[target] && window.location.pathname !== paths[target]) window.history.pushState({ page: target }, "", paths[target]);
    setPage(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const handlePopState = () => setPage(readPage());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const loadWeather = useCallback(async (selectedLocation, force = false) => {
    const key = `${selectedLocation.latitude.toFixed(4)},${selectedLocation.longitude.toFixed(4)}`;
    if (!force && weatherKey === key && weather) return;
    setWeatherLoading(true);
    setWeatherError("");
    setWeather(null);
    try {
      const params = new URLSearchParams({ latitude: String(selectedLocation.latitude), longitude: String(selectedLocation.longitude) });
      const result = await readJson(await fetch(`/api/weather?${params}`));
      setWeather(result);
      setWeatherKey(key);
    } catch (error) {
      setWeatherError(error.message);
      setWeatherKey(key);
    } finally {
      setWeatherLoading(false);
    }
  }, [weather, weatherKey]);

  const chooseLocation = useCallback(async (selectedLocation) => {
    const normalized = { ...selectedLocation, latitude: Number(selectedLocation.latitude), longitude: Number(selectedLocation.longitude) };
    setLocation(normalized);
    setWeather(null);
    setWeatherKey("");
    await loadWeather(normalized, true);
  }, [loadWeather]);

  const retryWeather = () => location && loadWeather(location, true);
  return <><Header page={page} navigate={navigate} />
    {page === "home" && <HomePage location={location} weather={weather} weatherLoading={weatherLoading} weatherError={weatherError} onChoose={chooseLocation} navigate={navigate} retryWeather={retryWeather} />}
    {page === "alerts" && <AlertFeedPage key="alerts" />}
    {page === "urban" && <UrbanPage key="urban" location={location} onChoose={chooseLocation} />}
    {page === "about" && <AboutPage />}
    {page === "contact" && <ContactPage />}
    <Footer navigate={navigate} />
  </>;
}
