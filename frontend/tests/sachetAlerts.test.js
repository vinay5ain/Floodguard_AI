import assert from "node:assert/strict";
import test from "node:test";
import { filterAndSort, normalizeAlerts, parseAlertDate } from "../src/sachetAlerts.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");

function record(overrides = {}) {
  return {
    identifier: 101,
    severity: "ALERT",
    severity_level: "Likely",
    effective_start_time: "Fri Oct 23 17:05:00 IST 2026",
    effective_end_time: "Fri Oct 23 20:05:00 IST 2026",
    disaster_type: "Flood",
    area_description: "Sample district",
    warning_message: "Flood warning",
    severity_color: "red",
    alert_source: "Example SDMA",
    ...overrides,
  };
}

test("normalizes observed SACHET fields and keeps unspecified issue time absent", () => {
  const [alert] = normalizeAlerts([record()], NOW);
  assert.equal(alert.id, "101");
  assert.equal(alert.severity, "severe");
  assert.equal(alert.status, "active");
  assert.equal(alert.original.identifier, 101);
  assert.equal(alert.startsAt, Date.parse("2026-10-23T11:35:00Z"));
});

test("unknown fields remain unknown and invalid record shapes are rejected", () => {
  const [alert] = normalizeAlerts([{}], NOW);
  assert.equal(alert.severity, "unknown");
  assert.equal(alert.status, "unknown");
  assert.throws(() => normalizeAlerts({ alerts: [] }, NOW), /must be a JSON array/);
  assert.throws(() => normalizeAlerts([null], NOW), /not a JSON object/);
});

test("deduplicates records by source identifier and stable field fallback", () => {
  const fallback = record({ identifier: null, alert_id_sdma_autoinc: null });
  assert.equal(normalizeAlerts([record(), record(), fallback, fallback], NOW).length, 2);
});

test("filters by search, severity, type and validity, then sorts by effective time", () => {
  const alerts = normalizeAlerts([
    record({ identifier: "older", effective_start_time: "Fri Oct 23 16:00:00 IST 2026" }),
    record({ identifier: "newer", disaster_type: "Heavy Rain", severity_color: "orange" }),
    record({ identifier: "unknown", disaster_type: "Wind", effective_start_time: null, effective_end_time: null }),
  ], NOW);
  const all = filterAndSort(alerts, { query: "", severity: "all", type: "all", validity: "all" }, NOW);
  assert.deepEqual(all.map((alert) => alert.id), ["newer", "older", "unknown"]);
  const searched = filterAndSort(alerts, { query: "sample district", severity: "severe", type: "Flood", validity: "active" }, NOW);
  assert.deepEqual(searched.map((alert) => alert.id), ["older"]);
  assert.equal(filterAndSort(alerts, { query: "", severity: "all", type: "all", validity: "unknown" }, NOW).length, 1);
});

test("parses the observed IST timestamp and rejects invalid values", () => {
  assert.equal(parseAlertDate("Fri Oct 23 17:05:00 IST 2026"), Date.parse("2026-10-23T11:35:00Z"));
  assert.equal(parseAlertDate("not a date"), null);
  assert.equal(parseAlertDate(null), null);
});
