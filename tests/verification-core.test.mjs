import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { inspectStaticSite } from "../scripts/verification-core.mjs";

const temporaryDirectories = [];

async function makeSite(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cloner-verify-"));
  temporaryDirectories.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

test("accepts a self-contained static document with resolvable assets", async () => {
  const root = await makeSite({
    "assets/app.1234abcd.js": "console.log('ok')",
    "assets/app.1234abcd.css": "body { background: url('./tile.1234abcd.webp'); }",
    "assets/hero.1234abcd.webp": "hero",
    "assets/tile.1234abcd.webp": "tile",
    "index.html": `<!doctype html>
      <html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Fixture</title>
        <link rel="stylesheet" href="/assets/app.1234abcd.css">
      </head><body>
        <a href="https://example.com/about">External navigation is allowed</a>
        <img src="/assets/hero.1234abcd.webp" width="1200" height="800" alt="Hero">
        <script src="/assets/app.1234abcd.js" defer></script>
      </body></html>`
  });

  const result = await inspectStaticSite(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.htmlFiles, 1);
  assert.equal(result.localReferences, 4);
});

test("reports missing local assets with their source document", async () => {
  const root = await makeSite({
    "index.html": `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width"><title>Fixture</title>
      <link rel="stylesheet" href="/missing.css">
    </head><body></body></html>`
  });

  const result = await inspectStaticSite(root);
  assert.ok(result.errors.some((error) => error.code === "missing-local-asset"));
  assert.ok(result.errors.some((error) => error.detail.includes("index.html")));
});

test("rejects remote executable resources but permits ordinary external links", async () => {
  const root = await makeSite({
    "index.html": `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width"><title>Fixture</title>
      <script src="https://cdn.example.com/runtime.js"></script>
    </head><body><a href="https://example.com/">Visit</a></body></html>`
  });

  const result = await inspectStaticSite(root);
  const remoteErrors = result.errors.filter((error) => error.code === "remote-resource");
  assert.equal(remoteErrors.length, 1);
  assert.match(remoteErrors[0].detail, /runtime\.js/);
});

test("finds remote resources referenced from CSS", async () => {
  const root = await makeSite({
    "assets/app.css": "@font-face { src: url('https://fonts.example.com/font.woff2'); }",
    "index.html": `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width"><title>Fixture</title>
      <link rel="stylesheet" href="/assets/app.css">
    </head><body></body></html>`
  });

  const result = await inspectStaticSite(root);
  assert.ok(result.errors.some((error) => error.code === "remote-resource" && /font\.woff2/.test(error.detail)));
});

test("requires intrinsic dimensions on image elements", async () => {
  const root = await makeSite({
    "hero.webp": "hero",
    "index.html": `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width"><title>Fixture</title>
    </head><body><img src="/hero.webp" alt="Hero"></body></html>`
  });

  const result = await inspectStaticSite(root);
  assert.ok(result.errors.some((error) => error.code === "image-dimensions"));
});

test("flags forbidden legacy runtime dependencies only when they are loaded", async () => {
  const root = await makeSite({
    "assets/pixi.min.js": "window.PIXI = {}",
    "index.html": `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width"><title>Elementor-compatible markup</title>
      <script src="/assets/pixi.min.js"></script>
    </head><body class="elementor-page"></body></html>`
  });

  const result = await inspectStaticSite(root);
  assert.ok(result.errors.some((error) => error.code === "legacy-runtime" && /pixi/i.test(error.detail)));
  assert.equal(result.errors.filter((error) => error.code === "legacy-runtime").length, 1);
});

test("does not mistake a legacy-named font asset for executable runtime", async () => {
  const root = await makeSite({
    "assets/app.css": "@font-face { font-family: Icons; src: url('/wp-content/plugins/avista-core/assets/fonts/icons.woff2'); }",
    "index.html": `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width"><title>Fixture</title>
      <link rel="stylesheet" href="/assets/app.css">
    </head><body></body></html>`,
    "wp-content/plugins/avista-core/assets/fonts/icons.woff2": "font"
  });

  const result = await inspectStaticSite(root);
  assert.equal(result.errors.filter((error) => error.code === "legacy-runtime").length, 0);
});
