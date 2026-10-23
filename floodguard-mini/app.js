(function () {
  "use strict";

  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const api = window.FloodGuardApi;
  const elements = {
    activeCount: document.getElementById("active-count"),
    alertList: document.getElementById("alert-list"),
    clearFilters: document.getElementById("clear-filters"),
    emptyMessage: document.getElementById("empty-message"),
    emptyState: document.getElementById("empty-state"),
    emptyTitle: document.getElementById("empty-title"),
    feedRefreshState: document.getElementById("feed-refresh-state"),
    floodCount: document.getElementById("flood-count"),
    lastUpdated: document.getElementById("last-updated"),
    loadingState: document.getElementById("loading-state"),
    refreshButton: document.getElementById("refresh-button"),
    resultCount: document.getElementById("result-count"),
    retryButton: document.getElementById("retry-button"),
    searchInput: document.getElementById("search-input"),
    severityCount: document.getElementById("severe-count"),
    severityFilter: document.getElementById("severity-filter"),
    statusBanner: document.getElementById("status-banner"),
    statusMessage: document.getElementById("status-message"),
    statusTitle: document.getElementById("status-title"),
    totalCount: document.getElementById("total-count"),
    typeFilter: document.getElementById("type-filter"),
    validityFilter: document.getElementById("validity-filter")
  };

  let alerts = [];
  let hasSuccessfulResponse = false;
  let isLoading = false;
  let updateTime = null;
  let searchTimer = null;

  function currentFilters() {
    return {
      query: elements.searchInput.value,
      severity: elements.severityFilter.value,
      type: elements.typeFilter.value,
      validity: elements.validityFilter.value
    };
  }

  function setBanner(title, message, visible) {
    elements.statusTitle.textContent = title;
    elements.statusMessage.textContent = message;
    elements.statusBanner.hidden = !visible;
  }

  function updateMetrics() {
    if (!hasSuccessfulResponse) {
      elements.totalCount.textContent = "—";
      elements.severityCount.textContent = "—";
      elements.activeCount.textContent = "—";
      elements.floodCount.textContent = "—";
      return;
    }
    const currentAlerts = api.filterAndSort(alerts, {
      query: "",
      severity: "all",
      type: "all",
      validity: "all"
    }, Date.now());
    elements.totalCount.textContent = String(currentAlerts.length);
    elements.severityCount.textContent = String(currentAlerts.filter((alert) => alert.severity === "severe").length);
    elements.activeCount.textContent = String(currentAlerts.filter((alert) => alert.status === "active").length);
    elements.floodCount.textContent = String(currentAlerts.filter((alert) => alert.floodRelated).length);
  }

  function populateTypeFilter() {
    const selected = elements.typeFilter.value;
    const types = Array.from(new Set(alerts.map((alert) => alert.type).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right));
    elements.typeFilter.replaceChildren(new Option("All disaster types", "all"));
    types.forEach((type) => elements.typeFilter.add(new Option(type, type)));
    elements.typeFilter.value = types.includes(selected) ? selected : "all";
  }

  function makeText(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function displayTime(timestamp, original) {
    if (timestamp === null) return original || "Not provided";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(timestamp);
  }

  function detail(label, value, className) {
    const item = document.createElement("div");
    item.className = `detail-item${className ? ` ${className}` : ""}`;
    item.append(makeText("span", "", `${label}:`), makeText("strong", "", value || "Not provided"));
    return item;
  }

  function renderAlert(alert) {
    const card = document.createElement("article");
    card.className = `alert-card severity-${alert.severity}${alert.severity === "severe" && alert.floodRelated ? " is-severe" : ""}`;
    const accent = document.createElement("div");
    accent.className = "alert-accent";
    accent.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "alert-body";

    const topline = document.createElement("div");
    topline.className = "alert-topline";
    topline.append(
      makeText("span", `severity-pill ${alert.severity}`, alert.severityLabel),
      makeText("span", `validity-pill ${alert.status}`, alert.status),
      makeText("span", "type-tag", alert.type || "Type not provided")
    );
    body.append(topline, makeText("h3", "alert-title", alert.title || "Alert title not provided"));

    if (alert.area) {
      const area = document.createElement("p");
      area.className = "alert-area";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8Z M8 8.2a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.2");
      icon.append(path);
      area.append(icon, document.createTextNode(alert.area));
      body.append(area);
    }
    if (alert.message) body.append(makeText("p", "alert-message", alert.message));

    const details = document.createElement("div");
    details.className = "alert-details";
    details.append(
      detail("Effective from", displayTime(alert.startsAt, alert.startsAtLabel)),
      detail("Valid until", displayTime(alert.endsAt, alert.endsAtLabel)),
      detail("Issued", "Not provided by SACHET"),
      detail("Source", alert.source, "source-detail")
    );
    body.append(details);
    card.append(accent, body);
    return card;
  }

  function render() {
    updateMetrics();
    const now = Date.now();
    const matching = api.filterAndSort(alerts, currentFilters(), now);
    elements.alertList.replaceChildren(...matching.map(renderAlert));
    elements.resultCount.textContent = hasSuccessfulResponse
      ? `${matching.length} of ${alerts.length} alerts`
      : "";

    const noMatches = hasSuccessfulResponse && matching.length === 0;
    elements.emptyState.hidden = !noMatches;
    if (noMatches && alerts.length === 0) {
      elements.emptyTitle.textContent = "No alerts returned";
      elements.emptyMessage.textContent = "SACHET returned a valid, empty response at the last successful update. This is different from an unavailable API.";
      elements.clearFilters.hidden = true;
    } else if (noMatches) {
      elements.emptyTitle.textContent = "No matching alerts";
      elements.emptyMessage.textContent = "Try adjusting your search or filters.";
      elements.clearFilters.hidden = false;
    }
  }

  function updateLastSuccess() {
    if (!updateTime) {
      elements.lastUpdated.textContent = "Waiting for live data";
      return;
    }
    elements.lastUpdated.textContent = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(updateTime);
  }

  async function refresh() {
    if (isLoading) return;
    isLoading = true;
    elements.refreshButton.disabled = true;
    elements.refreshButton.setAttribute("aria-busy", "true");
    elements.loadingState.hidden = hasSuccessfulResponse;
    elements.feedRefreshState.textContent = "Contacting SACHET…";
    if (!hasSuccessfulResponse) {
      elements.alertList.replaceChildren();
      elements.emptyState.hidden = true;
    }
    try {
      const nextAlerts = await api.fetchAlerts();
      alerts = nextAlerts;
      hasSuccessfulResponse = true;
      updateTime = Date.now();
      updateLastSuccess();
      populateTypeFilter();
      setBanner("", "", false);
      render();
      elements.feedRefreshState.textContent = "Auto-refresh every 5 minutes";
    } catch (error) {
      const kind = error instanceof api.AlertRequestError ? error.kind : "network";
      const title = kind === "invalid" ? "Invalid alert response" : "Live alert data unavailable";
      const message = kind === "invalid"
        ? `${error.message} No new alerts were displayed.`
        : `${error.message} Live alert data could not be retrieved.${hasSuccessfulResponse ? " Showing the last successful response; it may be out of date." : " Alert totals are unavailable, not zero."}`;
      setBanner(title, message, true);
      elements.feedRefreshState.textContent = "Live update failed";
      if (!hasSuccessfulResponse) {
        elements.emptyState.hidden = true;
        elements.resultCount.textContent = "";
      }
    } finally {
      isLoading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.removeAttribute("aria-busy");
      elements.loadingState.hidden = true;
    }
  }

  function clearFilters() {
    elements.searchInput.value = "";
    elements.severityFilter.value = "all";
    elements.typeFilter.value = "all";
    elements.validityFilter.value = "active";
    render();
  }

  document.getElementById("filter-form").addEventListener("submit", (event) => event.preventDefault());
  elements.refreshButton.addEventListener("click", refresh);
  elements.retryButton.addEventListener("click", refresh);
  elements.clearFilters.addEventListener("click", clearFilters);
  elements.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
  });
  [elements.severityFilter, elements.typeFilter, elements.validityFilter].forEach((filter) => {
    filter.addEventListener("change", render);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      elements.searchInput.focus();
    }
  });

  updateLastSuccess();
  refresh();
  window.setInterval(() => {
    if (!document.hidden) refresh();
  }, AUTO_REFRESH_MS);
})();
