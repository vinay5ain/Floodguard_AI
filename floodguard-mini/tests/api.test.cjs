"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AlertRequestError,
  filterAndSort,
  normalizeAlerts,
  parseDate,
  readResponse,
  fetchAlerts
} = require("../api.js");

const NOW = Date.parse("2026-10-23T12:00:00Z");

function record(overrides) {
  return Object.assign({
    identifier: 101,
    severity: "ALERT",
    severity_level: "Likely",
    effective_start_time: "Fri Oct 23 17:05:00 IST 2026",
    effective_end_time: "Fri Oct 23 20:05:00 IST 2026",
    disaster_type: "Flood",
    area_description: "Sample district",
    warning_message: "Flood warning",
    severity_color: "red",
    alert_source: "Example SDMA"
  }, overrides);
}

test("normalizes observed SACHET fields, keeps raw records, and classifies severity", () => {
  const [alert] = normalizeAlerts([record()], NOW);
  assert.equal(alert.id, "101");
  assert.equal(alert.title, "Flood");
  assert.equal(alert.severity, "severe");
  assert.equal(alert.status, "active");
  assert.equal(alert.floodRelated, true);
  assert.equal(alert.original.identifier, 101);
  assert.equal(alert.issuedAt, null);
});

test("missing fields stay unknown and unexpected values do not crash", () => {
  const [alert] = normalizeAlerts([{}], NOW);
  assert.equal(alert.id, null);
  assert.equal(alert.severity, "unknown");
  assert.equal(alert.status, "unknown");
  assert.equal(alert.area, "");
  assert.equal(alert.floodRelated, false);
  assert.equal(normalizeAlerts([{ identifier: 2, severity_color: "violet" }], NOW).length, 1);
});

test("deduplicates on source identifier and fallback source fields", () => {
  const duplicate = record({ identifier: "101" });
  const fallback = record({
    identifier: null,
    alert_id_sdma_autoinc: null,
    disaster_type: "Rain",
    area_description: "Other district"
  });
  assert.equal(normalizeAlerts([record(), duplicate, fallback, fallback], NOW).length, 2);
});

test("validates array shape instead of treating malformed input as empty", () => {
  assert.throws(() => normalizeAlerts({ alerts: [] }, NOW), AlertRequestError);
  assert.throws(() => normalizeAlerts([null], NOW), /not a JSON object/);
  assert.deepEqual(normalizeAlerts([], NOW), []);
});

test("sorts by valid effective time and filters search, severity, type, and validity", () => {
  const alerts = normalizeAlerts([
    record({ identifier: "old", effective_start_time: "Fri Oct 23 16:00:00 IST 2026" }),
    record({ identifier: "new", disaster_type: "Heavy Rain", severity_color: "orange" }),
    record({ identifier: "unknown", disaster_type: "Wind", effective_start_time: null, effective_end_time: null, severity_color: null })
  ], NOW);
  const all = filterAndSort(alerts, { query: "", severity: "all", type: "all", validity: "all" }, NOW);
  assert.deepEqual(all.map((alert) => alert.id), ["new", "old", "unknown"]);
  const searched = filterAndSort(alerts, { query: "sample district", severity: "severe", type: "Flood", validity: "active" }, NOW);
  assert.deepEqual(searched.map((alert) => alert.id), ["old"]);
  assert.equal(filterAndSort(alerts, { query: "", severity: "all", type: "all", validity: "unknown" }, NOW).length, 1);
});

test("parses observed IST offset and rejects malformed dates", () => {
  assert.equal(parseDate("Fri Oct 23 17:05:00 IST 2026"), Date.parse("2026-10-23T11:35:00Z"));
  assert.equal(parseDate("not a date"), null);
  assert.equal(parseDate(null), null);
});

test("recomputes alert validity when time passes", () => {
  const [alert] = normalizeAlerts([record()], NOW);
  const afterExpiry = parseDate("Fri Oct 23 20:06:00 IST 2026");
  const results = filterAndSort([alert], {
    query: "",
    severity: "all",
    type: "all",
    validity: "expired"
  }, afterExpiry);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "expired");
});

test("reports HTTP failures, malformed JSON, and unsupported formats", async () => {
  await assert.rejects(
    readResponse({ ok: false, status: 503 }),
    (error) => error instanceof AlertRequestError && error.kind === "http"
  );
  await assert.rejects(
    readResponse({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => { throw new SyntaxError("Unexpected token"); }
    }),
    (error) => error instanceof AlertRequestError && error.kind === "invalid" && /malformed JSON/.test(error.message)
  );
  await assert.rejects(
    readResponse({
      ok: true,
      headers: { get: () => "application/xml" },
      json: async () => []
    }),
    (error) => error instanceof AlertRequestError && error.kind === "invalid" && /unsupported content type/.test(error.message)
  );
});

test("reports network failures without turning them into empty alerts", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new TypeError("offline"); };
  try {
    await assert.rejects(
      fetchAlerts(),
      (error) => error instanceof AlertRequestError && error.kind === "network"
    );
  } finally {
    global.fetch = originalFetch;
  }
});
