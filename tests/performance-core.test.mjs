import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BUDGETS, evaluateLighthouseReport } from "../scripts/performance-core.mjs";

function lighthouseReport({
  bytes = 2_000_000,
  cls = 0.02,
  lcp = 2_100,
  performance = 0.9,
  requests = 42,
  tbt = 120
} = {}) {
  return {
    audits: {
      "cumulative-layout-shift": { numericValue: cls },
      "largest-contentful-paint": { numericValue: lcp },
      "network-requests": { details: { items: Array.from({ length: requests }, () => ({})) }, numericValue: requests },
      "total-blocking-time": { numericValue: tbt },
      "total-byte-weight": { numericValue: bytes }
    },
    categories: { performance: { score: performance } }
  };
}

test("passes a mobile report that satisfies every acceptance budget", () => {
  const result = evaluateLighthouseReport(lighthouseReport(), "mobile", DEFAULT_BUDGETS);

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.metrics.performance, 90);
  assert.equal(result.metrics.requests, 42);
});

test("uses the stricter desktop performance-score budget", () => {
  const result = evaluateLighthouseReport(lighthouseReport({ performance: 0.94 }), "desktop", DEFAULT_BUDGETS);

  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.metric === "performance" && failure.minimum === 95));
});

test("reports every failed maximum instead of stopping at the first one", () => {
  const result = evaluateLighthouseReport(lighthouseReport({
    bytes: 3_000_000,
    cls: 0.15,
    lcp: 3_000,
    performance: 0.4,
    requests: 80,
    tbt: 300
  }), "mobile", DEFAULT_BUDGETS);

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.metric).sort(),
    ["bytes", "cls", "lcp", "performance", "requests", "tbt"]
  );
});

test("rejects incomplete Lighthouse output with a useful error", () => {
  assert.throws(
    () => evaluateLighthouseReport({ audits: {}, categories: {} }, "mobile", DEFAULT_BUDGETS),
    /missing required metric/i
  );
});
