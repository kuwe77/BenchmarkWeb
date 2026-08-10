import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { optimizeSite, validateOptimizedSite } from "../scripts/optimize.mjs";

test("injects the local runtime last when pristine raw HTML has no runtime tag", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "onemilligram-optimizer-scripts-"));
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));

  const inputRoot = join(fixtureRoot, "raw");
  const outputRoot = join(fixtureRoot, "optimized");
  const scriptRoot = join(inputRoot, "scripts");
  await mkdir(scriptRoot, { recursive: true });

  const dependencies = [
    ["lenis-min-js", "lenis.js"],
    ["gsap-min-js", "gsap.js"],
    ["scrollTrigger-min-js", "scroll-trigger.js"]
  ];
  await Promise.all(dependencies.map(([, file]) => (
    writeFile(join(scriptRoot, file), `globalThis[${JSON.stringify(file)}] = true;\n`)
  )));

  const rawHtml = [
    "<html><head></head><body><main>Pristine raw fixture</main>",
    ...dependencies.map(([id, file]) => `<script id="${id}" src="/scripts/${file}"></script>`),
    "</body></html>"
  ].join("");
  assert.doesNotMatch(rawHtml, /clone-runtime/);
  await writeFile(join(inputRoot, "index.html"), rawHtml);

  const result = await optimizeSite({ inputRoot, outputRoot });
  const retained = result.optimization.scripts.retained;
  assert.deepEqual(
    retained.map(({ id }) => id),
    ["lenis-min-js", "gsap-min-js", "scrollTrigger-min-js", "clone-runtime"]
  );
  assert.equal(retained.length, 4);

  const runtime = retained.at(-1);
  assert.match(runtime.path, /^\/assets\/scripts\/clone-runtime\.[a-f0-9]{12}\.js$/);
  assert.equal(
    await readFile(join(outputRoot, runtime.path.slice(1)), "utf8"),
    await readFile(join(import.meta.dirname, "..", "src", "clone-runtime.js"), "utf8")
  );

  const optimizedHtml = await readFile(join(outputRoot, "index.html"), "utf8");
  const loader = optimizedHtml.match(/<script id="clone-motion-loader">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(loader, "optimized output must contain the deferred runtime loader");
  const loaderSources = JSON.parse(loader.match(/const e=(\[[^;]+\]);/)?.[1] ?? "null");
  assert.deepEqual(loaderSources, retained.map(({ id, path }) => ({ id, path })));
  assert.equal(loaderSources.filter(({ id }) => id === "clone-runtime").length, 1);
});

test("validation requires exactly one hashed runtime reference inside the motion loader", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "onemilligram-runtime-validation-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const runtimePath = "/assets/scripts/clone-runtime.0123456789ab.js";
  await mkdir(join(root, "assets", "scripts"), { recursive: true });
  await writeFile(join(root, runtimePath.slice(1)), "// fixture runtime\n");

  const invalidDocuments = [
    ["missing loader", `<script>const runtime=${JSON.stringify(runtimePath)}</script>`],
    ["missing runtime", '<script id="clone-motion-loader">const scripts=[]</script>'],
    ["duplicate runtime", `<script id="clone-motion-loader">const scripts=[${JSON.stringify(runtimePath)},${JSON.stringify(runtimePath)}]</script>`]
  ];

  for (const [label, script] of invalidDocuments) {
    await writeFile(join(root, "index.html"), `<html><body>${script}</body></html>`);
    await assert.rejects(
      validateOptimizedSite(root),
      /clone-motion-loader.*exactly one hashed clone-runtime/i,
      label
    );
  }
});
