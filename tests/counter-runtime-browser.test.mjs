import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import puppeteer from "puppeteer-core";

import { createStaticServer } from "../server.mjs";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const projectRoot = path.resolve(import.meta.dirname, "..");

test("local counter runtime preserves the original rolling digit geometry", {
  skip: !existsSync(chromePath),
  timeout: 30_000
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cloner-counter-runtime-"));
  const server = createStaticServer({ rootDirectory: root });
  let browser;
  context.after(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { force: true, recursive: true });
  });

  await Promise.all([
    copyFile(path.join(projectRoot, "src", "clone-runtime.css"), path.join(root, "clone-runtime.css")),
    copyFile(path.join(projectRoot, "src", "clone-runtime.js"), path.join(root, "clone-runtime.js")),
    writeFile(path.join(root, "index.html"), `<!doctype html>
      <html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/clone-runtime.css">
        <style>
          .counter { font-size: 50px; line-height: 1; }
          .as-blog-1-left .title { color: rgb(0, 0, 0); }
          .as-blog-1-left .title span { color: rgb(253, 63, 0); }
        </style>
      </head><body>
        <div class="counter"><span class="odometer" data-count="300">0</span></div>
        <div class="as-blog-1-left">
          <h4 class="title wa_title_spilt_1">Hospitals Market <span>You?</span></h4>
        </div>
        <div id="wa_liquid_img" style="width:700px;height:800px">
          <picture><img class="hero-main-img" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='20'/%3E"></picture>
        </div>
        <script src="/clone-runtime.js" defer></script>
      </body></html>`)
  ]);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ height: 720, width: 1280 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.documentElement.dataset.omgRuntime === "ready");

  const state = await page.evaluate(() => {
    const counter = document.querySelector(".odometer");
    const title = document.querySelector(".as-blog-1-left .title");
    const firstChar = title.querySelector(":scope > .omg-word .omg-char");
    const emphasizedChar = title.querySelector(":scope > span > .omg-word .omg-char");
    const heroPicture = document.querySelector("#wa_liquid_img picture");
    const heroImage = heroPicture.querySelector("img");
    return {
      digitCount: counter.querySelectorAll(".odometer-digit").length,
      hasInside: Boolean(counter.querySelector(".odometer-inside")),
      height: counter.getBoundingClientRect().height,
      firstTitleColor: getComputedStyle(firstChar).color,
      emphasizedTitleColor: getComputedStyle(emphasizedChar).color,
      heroPictureRect: [heroPicture.offsetWidth, heroPicture.offsetHeight],
      heroImageRect: [heroImage.offsetWidth, heroImage.offsetHeight],
      heroObjectFit: getComputedStyle(heroImage).objectFit
    };
  });

  assert.equal(state.hasInside, true);
  assert.equal(state.digitCount, 3);
  assert.ok(state.height > 60 && state.height < 65, `unexpected counter height: ${state.height}`);
  assert.equal(state.firstTitleColor, "rgb(0, 0, 0)");
  assert.equal(state.emphasizedTitleColor, "rgb(253, 63, 0)");
  assert.deepEqual(state.heroPictureRect, [700, 800]);
  assert.deepEqual(state.heroImageRect, [700, 800]);
  assert.equal(state.heroObjectFit, "cover");
});
