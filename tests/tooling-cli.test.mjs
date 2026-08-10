import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories = [];
const liveMirrorReportPaths = ["", ".br", ".gz"].map((extension) => (
  path.join(projectRoot, "site", `mirror-report.json${extension}`)
));

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function runNode(argumentsList) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("exit", (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8")
    }));
  });
}

async function writeValidSite(root) {
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "assets", "hero.1234abcd.webp"), "hero");
  await writeFile(path.join(root, "index.html"), `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width"><title>Fixture</title>
  </head><body><img src="/assets/hero.1234abcd.webp" width="800" height="600" alt="Hero"></body></html>`);
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function snapshotLiveMirrorReport() {
  return Promise.all(liveMirrorReportPaths.map(readOptional));
}

async function writePerfFixtureSite(directory) {
  const site = path.join(directory, "site");
  await writeValidSite(site);
  await writeFile(path.join(site, "mirror-report.json"), `${JSON.stringify({ fixture: true }, null, 2)}\n`);
  return site;
}

function lighthouseReport({ performance = 0.99 } = {}) {
  return {
    audits: {
      "cumulative-layout-shift": { numericValue: 0.01 },
      "largest-contentful-paint": { numericValue: 1_000 },
      "network-requests": { numericValue: 20 },
      "total-blocking-time": { numericValue: 30 },
      "total-byte-weight": { numericValue: 500_000 }
    },
    categories: { performance: { score: performance } }
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

test("verify static-only mode writes a passing machine-readable report", async () => {
  const directory = await temporaryDirectory("cloner-verify-cli-");
  const site = path.join(directory, "site");
  const report = path.join(directory, "report.json");
  await writeValidSite(site);

  const result = await runNode(["scripts/verify.mjs", "--root", site, "--output", report, "--static-only"]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(await readFile(report, "utf8"));
  assert.equal(parsed.passed, true);
  assert.deepEqual(parsed.static.errors, []);
});

test("verify returns exit code one when a static invariant fails", async () => {
  const directory = await temporaryDirectory("cloner-verify-cli-fail-");
  const site = path.join(directory, "site");
  await mkdir(site);
  await writeFile(path.join(site, "index.html"), "<html><body><script src=\"https://cdn.example.com/x.js\"></script></body></html>");

  const result = await runNode(["scripts/verify.mjs", "--root", site, "--output", path.join(directory, "report.json"), "--static-only"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /remote-resource/);
});

test("perf evaluates saved mobile and desktop reports without launching Chrome", async () => {
  const directory = await temporaryDirectory("cloner-perf-cli-");
  const site = await writePerfFixtureSite(directory);
  const mobile = path.join(directory, "mobile.json");
  const desktop = path.join(directory, "desktop.json");
  const output = path.join(directory, "summary.json");
  const liveReportBefore = await snapshotLiveMirrorReport();
  await writeFile(mobile, JSON.stringify(lighthouseReport({ performance: 0.9 })));
  await writeFile(desktop, JSON.stringify(lighthouseReport({ performance: 0.97 })));

  const result = await runNode([
    "scripts/perf.mjs",
    "--root", site,
    "--mobile-report", mobile,
    "--desktop-report", desktop,
    "--output", output
  ]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, "utf8"));
  assert.equal(summary.passed, true);
  assert.equal(summary.profiles.length, 2);
  const fixtureReport = JSON.parse(await readFile(path.join(site, "mirror-report.json"), "utf8"));
  assert.equal(fixtureReport.performanceBudgetResults.passed, true);
  assert.deepEqual(await snapshotLiveMirrorReport(), liveReportBefore);
});

test("perf returns exit code one and reports the exact failed profile budget", async () => {
  const directory = await temporaryDirectory("cloner-perf-cli-fail-");
  const site = await writePerfFixtureSite(directory);
  const mobile = path.join(directory, "mobile.json");
  const desktop = path.join(directory, "desktop.json");
  const liveReportBefore = await snapshotLiveMirrorReport();
  await writeFile(mobile, JSON.stringify(lighthouseReport({ performance: 0.84 })));
  await writeFile(desktop, JSON.stringify(lighthouseReport({ performance: 0.99 })));

  const result = await runNode([
    "scripts/perf.mjs",
    "--root", site,
    "--mobile-report", mobile,
    "--desktop-report", desktop,
    "--output", path.join(directory, "summary.json")
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /mobile performance.*84.*85/i);
  const fixtureReport = JSON.parse(await readFile(path.join(site, "mirror-report.json"), "utf8"));
  assert.equal(fixtureReport.performanceBudgetResults.passed, false);
  assert.deepEqual(await snapshotLiveMirrorReport(), liveReportBefore);
});
