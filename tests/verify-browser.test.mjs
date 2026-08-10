import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const temporaryDirectories = [];

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

async function makeSite(markup) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloner-verify-browser-"));
  temporaryDirectories.push(directory);
  const site = path.join(directory, "site");
  await mkdir(site);
  await writeFile(path.join(site, "index.html"), markup);
  return { directory, site };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

test("browser verification fails when required controls are present but inert", {
  skip: !existsSync(chromePath),
  timeout: 45_000
}, async () => {
  const { directory, site } = await makeSite(`<!doctype html>
    <html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Broken interactions</title>
      <style>section { min-height: 900px; } .offcanvas_box_active { width: 200px; height: 200px; }</style>
    </head><body>
      <div class="as-header-1-menu-toggle-btn" tabindex="0"><span></span><span></span></div>
      <nav class="as-header-1-menu">Menu</nav>
      <button class="offcanvas_toggle">Mobile menu</button>
      <div class="offcanvas_box_active">Panel</div><div class="wa-overly">Overlay</div>
      <section class="hero"><h1>Hero</h1></section>
      <section class="faq">
        <div role="tablist">
          <button class="active" data-bs-toggle="tab" data-bs-target="#pane-a" aria-selected="true">A</button>
          <button data-bs-toggle="tab" data-bs-target="#pane-b" aria-selected="false">B</button>
        </div>
        <div class="tab-content"><div id="pane-a" class="tab-pane active show">A</div><div id="pane-b" class="tab-pane">B</div></div>
        <button class="accordion-button collapsed" data-bs-toggle="collapse" data-bs-target="#answer" aria-expanded="false">Question</button>
        <div id="answer" class="accordion-collapse collapse">Answer</div>
      </section>
      <section class="contact">Contact</section>
      <script>document.documentElement.dataset.omgRuntime = "ready"; window.__OMG_PERF__ = { ready: true };</script>
    </body></html>`);
  const output = path.join(directory, "report.json");

  const result = await runNode([
    "scripts/verify.mjs", "--root", site, "--output", output,
    "--artifacts", path.join(directory, "artifacts"), "--skip-visual"
  ]);

  assert.equal(result.code, 1, result.stdout + result.stderr);
  const report = JSON.parse(await readFile(output, "utf8"));
  const codes = new Set(report.browser.errors.map((error) => error.code));
  assert.ok(codes.has("interaction-menu"));
  assert.ok(codes.has("interaction-tab"));
  assert.ok(codes.has("interaction-accordion"));
  assert.ok(codes.has("interaction-nice-select"));
  assert.ok(codes.has("interaction-cookie"));
  assert.ok(codes.has("interaction-form"));
});

test("visual verification creates nested per-section diff artifacts", {
  skip: !existsSync(chromePath),
  timeout: 90_000
}, async () => {
  const { directory, site } = await makeSite(`<!doctype html>
    <html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Section diff fixture</title>
      <style>body { margin: 0; } section { min-height: 900px; background: #eee; }</style>
    </head><body>
      <section class="hero"><h1>Deterministic section</h1></section>
      <script>document.documentElement.dataset.omgRuntime = "ready"; window.__OMG_PERF__ = { ready: true };</script>
    </body></html>`);
  const output = path.join(directory, "report.json");
  const artifacts = path.join(directory, "artifacts");

  const result = await runNode([
    "scripts/verify.mjs", "--root", site, "--reference-root", site,
    "--output", output, "--artifacts", artifacts
  ]);

  assert.equal(result.code, 1, result.stdout + result.stderr);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.browser.viewports[0].sections[0].visual.passed, true);
  assert.equal(
    existsSync(path.join(artifacts, "diff", "sections", "desktop-1280x720", "01-hero.png")),
    true
  );
});
