const FLOOD_TERMS = /\b(?:flood(?:ing)?|inundation|waterlogging)\b/i;
const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function asText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function parseAlertDate(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const source = value.trim();
  const match = source.match(/^(?:\w{3}\s+)?(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+IST\s+(\d{4})$/i);
  const monthName = match ? `${match[1][0].toUpperCase()}${match[1].slice(1, 3).toLowerCase()}` : "";
  const normalized = match && MONTHS[monthName]
    ? `${match[6]}-${MONTHS[monthName]}-${match[2].padStart(2, "0")}T${match[3]}:${match[4]}:${match[5]}+05:30`
    : source;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function severityFor(record) {
  const color = asText(record.severity_color).toLowerCase();
  const raw = [record.severity, record.severity_level].map(asText).join(" ").toLowerCase();
  if (color === "red" || /\b(?:severe|extreme|critical|very severe)\b/.test(raw)) return "severe";
  if (color === "orange" || /\b(?:warning|alert)\b/.test(raw)) return "warning";
  if (color === "yellow" || /\b(?:watch|advisory)\b/.test(raw)) return "watch";
  return "unknown";
}

function validityFor(alert, now) {
  if (alert.startsAt === null || alert.endsAt === null) return "unknown";
  if (alert.startsAt > now) return "upcoming";
  if (alert.endsAt < now) return "expired";
  return "active";
}

export function isFloodRelated(alert) {
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
    asText(record.effective_end_time),
  ];
  if (parts.some(Boolean)) return `fields:${parts.join("|")}`;
  return `unidentified-record:${index}`;
}

export function normalizeAlerts(records, now = Date.now()) {
  if (!Array.isArray(records)) throw new Error("The SACHET response must be a JSON array of alert records.");
  const seen = new Set();
  const alerts = [];
  records.forEach((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Alert record ${index + 1} is not a JSON object.`);
    }
    const key = stableKey(record, index);
    if (seen.has(key)) return;
    seen.add(key);
    const type = asText(record.disaster_type);
    const alert = {
      id: asText(record.identifier) || asText(record.alert_id_sdma_autoinc) || null,
      title: type,
      type,
      severity: severityFor(record),
      severityLabel: asText(record.severity_level) || asText(record.severity) || "Unspecified",
      area: asText(record.area_description),
      startsAt: parseAlertDate(asText(record.effective_start_time)),
      startsAtLabel: asText(record.effective_start_time),
      endsAt: parseAlertDate(asText(record.effective_end_time)),
      endsAtLabel: asText(record.effective_end_time),
      source: asText(record.alert_source),
      message: asText(record.warning_message),
      original: record,
    };
    alert.status = validityFor(alert, now);
    alerts.push(alert);
  });
  return alerts;
}

export function filterAndSort(alerts, filters, now = Date.now()) {
  const query = filters.query.trim().toLocaleLowerCase();
  return alerts
    .map((alert) => ({ ...alert, status: validityFor(alert, now) }))
    .filter((alert) => {
      if (filters.severity !== "all" && alert.severity !== filters.severity) return false;
      if (filters.type !== "all" && alert.type !== filters.type) return false;
      if (filters.validity !== "all" && alert.status !== filters.validity) return false;
      const searchable = `${alert.title} ${alert.type} ${alert.area} ${alert.source} ${alert.message}`.toLocaleLowerCase();
      return !query || searchable.includes(query);
    })
    .sort((left, right) => {
      if (left.startsAt === null && right.startsAt === null) return 0;
      if (left.startsAt === null) return 1;
      if (right.startsAt === null) return -1;
      return right.startsAt - left.startsAt;
    });
}
