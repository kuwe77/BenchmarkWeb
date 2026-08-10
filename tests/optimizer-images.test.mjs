import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import sharp from "sharp";

import { optimizeSite } from "../scripts/optimize.mjs";

test("reports picture usages separately from unique optimized image sources", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "onemilligram-optimizer-images-"));
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));

  const inputRoot = join(fixtureRoot, "raw");
  const outputRoot = join(fixtureRoot, "optimized");

  const imageDirectory = join(inputRoot, "images");
  const sourcePath = join(imageDirectory, "portrait.png");
  await mkdir(imageDirectory, { recursive: true });
  await sharp({
    create: {
      background: { alpha: 1, b: 180, g: 120, r: 60 },
      channels: 4,
      height: 640,
      width: 480
    }
  }).png({ compressionLevel: 0 }).toFile(sourcePath);

  const sourceBytes = (await stat(sourcePath)).size;
  assert.ok(sourceBytes >= 80 * 1024, "fixture must exercise responsive optimization");

  const html = [
    "<html><head></head><body>",
    '<div id="wa_liquid_img"><img class="hero-main-img" src="/images/portrait.png" alt="first use"></div>',
    '<img src="/images/portrait.png" alt="second use">',
    "</body></html>"
  ].join("");
  await writeFile(join(inputRoot, "index.html"), html);
  const result = await optimizeSite({ inputRoot, outputRoot });
  const images = result.optimization.images;

  assert.equal(images.pictureCount, 2);
  assert.equal(images.uniqueSourceCount, 1);
  assert.equal(images.sources.length, 1);
  assert.equal(images.sources[0].usageCount, 2);
  assert.equal(images.optimizedOriginalBytes, sourceBytes);
  assert.equal(images.generatedBytes, images.sources[0].outputBytes);

  const optimizedHtml = await readFile(join(outputRoot, "index.html"), "utf8");
  assert.match(
    optimizedHtml,
    /sizes="\(max-width: 767px\) 92vw, \(max-width: 1199px\) 55vw, \(max-width: 1599px\) 800px, 46vw"/,
    "the desktop hero should select a source large enough for its rendered portrait slot"
  );

  const styleDirectory = join(outputRoot, "assets", "styles");
  const bundledCss = (await Promise.all(
    (await readdir(styleDirectory))
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFile(join(styleDirectory, name), "utf8"))
  )).join("\n");
  assert.match(bundledCss, /img\[data-clone-dimensions(?:=|\\=)[^\]]*\]\{height:auto\}/);
  assert.match(bundledCss, /#wa_liquid_img picture[^}]*\{[^}]*height:100%/);
});
