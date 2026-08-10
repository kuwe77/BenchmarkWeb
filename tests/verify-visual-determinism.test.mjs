import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser;
let makeVisualStateDeterministic;

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
  makeVisualStateDeterministic = extractFunction(source, "makeVisualStateDeterministic", "preparePage");
  browser = await puppeteer.launch({
    args: ["--disable-background-networking", "--disable-extensions", "--no-first-run"],
    executablePath: chromePath,
    headless: true
  });
});

after(async () => {
  await browser?.close();
});

test("visual determinism does not force children owned by a ScrollTrigger timeline", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><body>
      <div id="scroll-owned">unchanged</div>
      <script>
        const scrollTimeline = { scrollTrigger: { id: "scroll-owner" }, parent: null };
        const child = {
          parent: scrollTimeline,
          pause() { return this; },
          progress(value) {
            if (arguments.length) document.querySelector("#scroll-owned").dataset.forced = String(value);
            return this;
          },
          repeat() { return 0; }
        };
        window.gsap = { globalTimeline: { getChildren() { return [child]; } } };
        window.ScrollTrigger = { update() {} };
      </script>
    </body></html>`);

    await makeVisualStateDeterministic(page);

    assert.equal(await page.$eval("#scroll-owned", (element) => element.dataset.forced), undefined);
  } finally {
    await page.close();
  }
});

test("visual determinism resets CSS and jQuery marquee movers to one zero phase", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>
      @keyframes fixture-marquee { to { transform: translateX(-100px); } }
      .wa_marquee_left_nopause { animation: fixture-marquee 10s linear infinite; }
    </style></head><body>
      <div class="wa_marquee_left_nopause" style="transform: translate3d(-40px, 0, 0)">
        <div class="js-marquee-wrapper" style="animation: fixture-marquee 10s linear infinite; transform: translate3d(-120px, 0, 0)">Track</div>
      </div>
      <div class="wa_marquee_down_top" style="transform: translate3d(0, -80px, 0)">Vertical</div>
      <div data-omg-marquee-clone="true" style="transform: translate3d(0, -80px, 0)">Clone</div>
    </body></html>`);

    await makeVisualStateDeterministic(page);

    const states = await page.$$eval(
      ".wa_marquee_left_nopause, .js-marquee-wrapper, .wa_marquee_down_top, [data-omg-marquee-clone='true']",
      (elements) => elements.map((element) => ({
        animationName: getComputedStyle(element).animationName,
        transform: getComputedStyle(element).transform
      }))
    );
    assert.deepEqual(states, states.map(() => ({ animationName: "none", transform: "matrix(1, 0, 0, 1, 0, 0)" })));
  } finally {
    await page.close();
  }
});

test("visual determinism gives magnetic elements one stable zero compositor state", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><body>
      <h4 class="wa_magnetic_btn_1" style="translate: 18px -7px">Card title</h4>
      <a class="wa_magnetic_1_elm" style="--omg-magnetic-x: -12px; --omg-magnetic-y: 5px; translate: var(--omg-magnetic-x) var(--omg-magnetic-y)">Link</a>
    </body></html>`);

    await makeVisualStateDeterministic(page);

    const states = await page.$$eval(".wa_magnetic_btn_1, .wa_magnetic_1_elm", (elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        magneticX: style.getPropertyValue("--omg-magnetic-x").trim(),
        magneticY: style.getPropertyValue("--omg-magnetic-y").trim(),
        translate: style.translate,
        willChange: style.willChange
      };
    }));
    assert.deepEqual(states, states.map(() => ({
      magneticX: "0",
      magneticY: "0",
      translate: "0px",
      willChange: "translate"
    })));
  } finally {
    await page.close();
  }
});

test("visual determinism replaces the raw Pixi hero canvas with its source image", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  const sourcePath = "/wp-content/uploads/2026/01/header-image.png";
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/") {
      request.respond({
        body: `<!doctype html><html><body>
          <img id="preload" src="${sourcePath}" alt="">
          <div id="wa_liquid_img" style="width:700px;height:800px">
            <canvas width="700" height="800"></canvas>
          </div>
        </body></html>`,
        contentType: "text/html",
        status: 200
      });
    } else if (url.pathname === sourcePath) {
      request.respond({ body: onePixelPng, contentType: "image/png", status: 200 });
    } else request.abort();
  });

  try {
    await page.goto("http://visual-fixture.test/", { waitUntil: "networkidle0" });
    await page.$eval("#preload", (image) => image.remove());

    await makeVisualStateDeterministic(page);

    const state = await page.$eval("#wa_liquid_img", (element) => {
      const image = element.querySelector("img[data-verification-hero-source]");
      const style = image && getComputedStyle(image);
      return {
        canvasPresent: Boolean(element.querySelector("canvas")),
        height: style?.height,
        imagePresent: Boolean(image),
        objectFit: style?.objectFit,
        source: image ? new URL(image.src).pathname : null,
        width: style?.width
      };
    });
    assert.deepEqual(state, {
      canvasPresent: false,
      height: "800px",
      imagePresent: true,
      objectFit: "cover",
      source: sourcePath,
      width: "700px"
    });
  } finally {
    await page.close();
  }
});

test("visual determinism disables line clamping that disappears in full-page rasters", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>
      .wa-line-limit.has-line-2 {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
    </style></head><body>
      <a class="wa-line-limit has-line-2">A two-line title</a>
    </body></html>`);

    await makeVisualStateDeterministic(page);

    const state = await page.$eval(".wa-line-limit", (element) => {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        lineClamp: style.webkitLineClamp,
        overflow: style.overflow
      };
    });
    assert.deepEqual(state, { display: "block", lineClamp: "none", overflow: "hidden" });
  } finally {
    await page.close();
  }
});

test("visual determinism captures WOW and split text at their visible endpoints", {
  skip: !existsSync(chromePath)
}, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><body>
      <div class="wow" style="filter: blur(8px); opacity: .2; transform: translate3d(0, 80px, 0); visibility: hidden">Reveal</div>
      <h2 class="wa_title_spilt_1"><span class="char" style="opacity: .3; transform: rotateX(-70deg); visibility: hidden">A</span></h2>
      <p class="wa_title_split_2"><span class="word" style="filter: blur(5px); opacity: 0; transform: translateY(20px)">Word</span></p>
      <h3 class="wa_split_up"><span class="omg-char" style="opacity: 0; transform: translateY(50px)">B</span></h3>
    </body></html>`);

    await makeVisualStateDeterministic(page);

    const states = await page.$$eval(".wow, .char, .word, .omg-char", (elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return { filter: style.filter, opacity: style.opacity, transform: style.transform, visibility: style.visibility };
    }));
    assert.deepEqual(states, states.map(() => ({ filter: "none", opacity: "1", transform: "none", visibility: "visible" })));
  } finally {
    await page.close();
  }
});
