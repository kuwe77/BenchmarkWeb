import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser;
let waitForRuntime;

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\n\nasync function ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name} from verifier`);
  return (0, eval)(`(${source.slice(start, end)})`);
}

before(async () => {
  if (!existsSync(chromePath)) return;
  const [{ default: puppeteer }, source] = await Promise.all([
    import("puppeteer-core"),
    readFile(path.join(projectRoot, "scripts", "verify.mjs"), "utf8")
  ]);
  waitForRuntime = extractFunction(source, "waitForRuntime", "waitForImages");
  browser = await puppeteer.launch({
    args: ["--disable-background-networking", "--disable-extensions", "--no-first-run"],
    executablePath: chromePath,
    headless: true
  });
});

after(async () => {
  await browser?.close();
});

test("optimized-page readiness requires the clone runtime ready marker", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html data-omg-runtime="booting"><body>
      <script>setTimeout(() => { document.documentElement.dataset.omgRuntime = "ready"; }, 25);</script>
    </body></html>`);

    const state = await waitForRuntime(page, { required: true, timeout: 1_000 });

    assert.deepEqual(state, { marker: "ready", ready: true });
  } finally {
    await page.close();
  }
});

test("missing optimized runtime returns a reportable readiness error", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body>Missing runtime</body></html>");

    const state = await waitForRuntime(page, { required: true, timeout: 50 });

    assert.equal(state.ready, false);
    assert.equal(state.marker, null);
    assert.match(state.error, /optimized runtime did not become ready/i);
    assert.match(state.error, /marker is missing/i);
  } finally {
    await page.close();
  }
});

test("raw-reference readiness accepts a complete document without a runtime marker", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body>Raw reference</body></html>");

    const state = await waitForRuntime(page, { required: false, timeout: 1_000 });

    assert.deepEqual(state, { marker: null, ready: true });
  } finally {
    await page.close();
  }
});
