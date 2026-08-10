export const DEFAULT_BUDGETS = Object.freeze({
  bytes: 2.5 * 1024 * 1024,
  cls: 0.1,
  desktopPerformance: 95,
  lcp: 2_500,
  mobilePerformance: 85,
  requests: 60,
  tbt: 200
});

function requireNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Lighthouse output is missing required metric: ${name}`);
  }
  return value;
}

export function extractLighthouseMetrics(report) {
  const requestAudit = report?.audits?.["network-requests"];
  const requests = typeof requestAudit?.numericValue === "number"
    ? requestAudit.numericValue
    : requestAudit?.details?.items?.length;

  return {
    bytes: requireNumber(report?.audits?.["total-byte-weight"]?.numericValue, "total-byte-weight"),
    cls: requireNumber(report?.audits?.["cumulative-layout-shift"]?.numericValue, "cumulative-layout-shift"),
    lcp: requireNumber(report?.audits?.["largest-contentful-paint"]?.numericValue, "largest-contentful-paint"),
    performance: requireNumber(report?.categories?.performance?.score, "performance score") * 100,
    requests: requireNumber(requests, "network-requests"),
    tbt: requireNumber(report?.audits?.["total-blocking-time"]?.numericValue, "total-blocking-time")
  };
}

export function evaluateLighthouseReport(report, profile, budgets = DEFAULT_BUDGETS) {
  if (profile !== "mobile" && profile !== "desktop") throw new Error(`Unknown Lighthouse profile: ${profile}`);
  const metrics = extractLighthouseMetrics(report);
  const failures = [];
  const minimumPerformance = profile === "mobile" ? budgets.mobilePerformance : budgets.desktopPerformance;

  if (metrics.performance < minimumPerformance) {
    failures.push({ actual: metrics.performance, metric: "performance", minimum: minimumPerformance });
  }
  for (const [metric, maximum] of [
    ["lcp", budgets.lcp],
    ["tbt", budgets.tbt],
    ["cls", budgets.cls],
    ["bytes", budgets.bytes],
    ["requests", budgets.requests]
  ]) {
    if (metrics[metric] > maximum) failures.push({ actual: metrics[metric], maximum, metric });
  }

  return { failures, metrics, passed: failures.length === 0, profile };
}
