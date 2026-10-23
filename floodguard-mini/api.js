(function (root) {
  "use strict";

  const API_PATH = "/api/alerts";
  const REQUEST_TIMEOUT_MS = 18000;
  const FLOOD_TERMS = /\b(?:flood(?:ing)?|inundation|waterlogging)\b/i;
  const MONTHS = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };

  class AlertRequestError extends Error {
    constructor(message, kind) {
      super(message);
      this.name = "AlertRequestError";
      this.kind = kind;
    }
  }

  function parseDate(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const source = value.trim();
    const sachetDate = source.match(/^(?:\w{3}\s+)?(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+IST\s+(\d{4})$/i);
    const normalized = sachetDate && MONTHS[sachetDate[1][0].toUpperCase() + sachetDate[1].slice(1, 3).toLowerCase()]
      ? `${sachetDate[6]}-${MONTHS[sachetDate[1][0].toUpperCase() + sachetDate[1].slice(1, 3).toLowerCase()]}-${sachetDate[2].padStart(2, "0")}T${sachetDate[3]}:${sachetDate[4]}:${sachetDate[5]}+05:30`
      : source;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function asText(value) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
  }

  function severityFor(record) {
    const color = asText(record.severity_color).toLowerCase();
    const raw = [record.severity, record.severity_level].map(asText).join(" ").toLowerCase();
    if (color === "red" || /\b(?:severe|extreme|critical|very severe)\b/.test(raw)) return "severe";
    if (color === "orange" || /\b(?:warning|alert)\b/.test(raw)) return "warning";
    if (color === "yellow" || /\b(?:watch|advisory)\b/.test(raw)) return "watch";
    return "unknown";
  }

  function statusFor(alert, now) {
    if (alert.startsAt === null || alert.endsAt === null) return "unknown";
    if (alert.startsAt > now) return "upcoming";
    if (alert.endsAt < now) return "expired";
    return "active";
  }

  function isFloodRelated(alert) {
    return FLOOD_TERMS.test(`${alert.type} ${alert.title}`);
  }

  function stableKey(record, index) {
    const identifier = asText(record.identifier) || asText(record.alert_id_sdma_autoinc);
    if (identifier) return `id:${identifier}`;
    const parts = [
      asText(record.alert_source),
      asText(record.disaster_type),
      asText(record.area_description),
      asText(record.effective_start_time),
      asText(record.effective_end_time)
    ];
    if (parts.some(Boolean)) return `fields:${parts.join("|")}`;
    return `unidentified-record:${index}`;
  }

  function normalizeAlerts(records, now) {
    if (!Array.isArray(records)) {
      throw new AlertRequestError("The SACHET response must be a JSON array of alert records.", "invalid");
    }
    const seen = new Set();
    const alerts = [];
    records.forEach((record, index) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new AlertRequestError(`Alert record ${index + 1} is not a JSON object.`, "invalid");
      }
      const key = stableKey(record, index);
      if (seen.has(key)) return;
      seen.add(key);
      const type = asText(record.disaster_type);
      const message = asText(record.warning_message);
      const start = asText(record.effective_start_time);
      const end = asText(record.effective_end_time);
      const alert = {
        id: asText(record.identifier) || asText(record.alert_id_sdma_autoinc) || null,
        title: type,
        type,
        severity: severityFor(record),
        severityLabel: asText(record.severity_level) || asText(record.severity) || "Unspecified",
        area: asText(record.area_description),
        issuedAt: null,
        startsAt: parseDate(start),
        startsAtLabel: start,
        endsAt: parseDate(end),
        endsAtLabel: end,
        source: asText(record.alert_source),
        message,
        language: asText(record.actual_lang),
        status: "unknown",
        floodRelated: false,
        original: record
      };
      alert.status = statusFor(alert, now);
      alert.floodRelated = isFloodRelated(alert);
      alerts.push(alert);
    });
    return alerts;
  }

  async function readResponse(response) {
    if (!response.ok) {
      throw new AlertRequestError(`The alert service returned HTTP ${response.status}.`, "http");
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json") && !contentType.includes("+json")) {
      throw new AlertRequestError(
        `The alert service returned an unsupported content type (${contentType || "not provided"}); JSON was expected.`,
        "invalid"
      );
    }
    let records;
    try {
      records = await response.json();
    } catch (error) {
      throw new AlertRequestError(`The alert service returned malformed JSON: ${error.message}`, "invalid");
    }
    return normalizeAlerts(records, Date.now());
  }

  async function fetchAlerts() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetch(API_PATH, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal
        });
      } catch (error) {
        if (error.name === "AbortError") {
          throw new AlertRequestError("The alert request timed out. Please retry.", "timeout");
        }
        throw new AlertRequestError(
          "Could not reach the local alert proxy. Start it with `python proxy/app.py` and try again.",
          "network"
        );
      }
      return await readResponse(response);
    } finally {
      clearTimeout(timer);
    }
  }

  function filterAndSort(alerts, filters, now) {
    const query = filters.query.trim().toLocaleLowerCase();
    return alerts
      .map((alert) => Object.assign({}, alert, { status: statusFor(alert, now) }))
      .filter((alert) => {
        if (filters.severity !== "all" && alert.severity !== filters.severity) return false;
        if (filters.type !== "all" && alert.type !== filters.type) return false;
        if (filters.validity !== "all" && alert.status !== filters.validity) return false;
        if (query && !`${alert.title} ${alert.type} ${alert.area} ${alert.source} ${alert.message}`.toLocaleLowerCase().includes(query)) return false;
        return true;
      })
      .sort((left, right) => {
        if (left.startsAt === null && right.startsAt === null) return 0;
        if (left.startsAt === null) return 1;
        if (right.startsAt === null) return -1;
        return right.startsAt - left.startsAt;
      });
  }

  const api = { AlertRequestError, fetchAlerts, filterAndSort, isFloodRelated, normalizeAlerts, parseDate, readResponse };
  root.FloodGuardApi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
