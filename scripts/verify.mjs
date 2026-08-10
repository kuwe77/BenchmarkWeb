import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStaticServer } from "../server.mjs";
import { inspectStaticSite } from "./verification-core.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const viewports = [
  { height: 720, name: "desktop-1280x720", width: 1280 },
  { height: 900, name: "desktop-1440x900", width: 1440 },
  { height: 1024, name: "tablet-768x1024", width: 768 },
  { height: 844, mobile: true, name: "mobile-390x844", width: 390 }
];

function parseArguments(argv) {
  const options = {
    artifacts: path.join(projectRoot, "artifacts", "verify"),
    baselineDirectory: path.join(projectRoot, "tests", "visual-baselines"),
    chromePath: process.env.CHROME_PATH || defaultChrome,
    maxDiff: 0.01,
    output: path.join(projectRoot, "artifacts", "verify", "report.json"),
    referenceRoot: path.join(projectRoot, ".cache", "mirror", "raw"),
    root: path.join(projectRoot, "site"),
    skipVisual: false,
    staticOnly: false,
    updateBaseline: false
  };
  options.baselineDirectoryExplicit = false;
  options.referenceRootExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };

    if (argument === "--artifacts") options.artifacts = path.resolve(value());
    else if (argument === "--baseline-dir") {
      options.baselineDirectory = path.resolve(value());
      options.baselineDirectoryExplicit = true;
    }
    else if (argument === "--chrome-path") options.chromePath = path.resolve(value());
    else if (argument === "--max-diff") options.maxDiff = Number(value());
    else if (argument === "--output") options.output = path.resolve(value());
    else if (argument === "--reference-root") {
      options.referenceRoot = path.resolve(value());
      options.referenceRootExplicit = true;
    }
    else if (argument === "--root") options.root = path.resolve(value());
    else if (argument === "--skip-visual") options.skipVisual = true;
    else if (argument === "--static-only") options.staticOnly = true;
    else if (argument === "--update-baseline") options.updateBaseline = true;
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isFinite(options.maxDiff) || options.maxDiff < 0 || options.maxDiff > 1) {
    throw new Error("--max-diff must be a number between 0 and 1");
  }
  return options;
}

function helpText() {
  return `Usage: node scripts/verify.mjs [options]

Options:
  --root <directory>           Optimized static root (default: site)
  --reference-root <directory> Raw mirror root (default: .cache/mirror/raw)
  --output <file>              Machine-readable report destination
  --artifacts <directory>      Screenshot and diff destination
  --max-diff <ratio>           Maximum changed-pixel ratio (default: 0.01)
  --chrome-path <file>         Chrome executable
  --skip-visual                Run browser smoke without pixel comparison
  --static-only                Run HTML/CSS/assets checks without Chrome
  --update-baseline            Replace stored baselines with current renders
  --baseline-dir <directory>   Stored baseline directory
`;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listen(root) {
  const server = createStaticServer({ rootDirectory: root });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function normalizedUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function waitForRuntime(page, { required = true, timeout = 10_000 } = {}) {
  try {
    await page.waitForFunction((runtimeRequired) => {
      const marker = document.documentElement.dataset.omgRuntime;
      if (document.readyState !== "complete") return false;
      return runtimeRequired ? marker === "ready" : marker !== "booting";
    }, { timeout }, required);
    const marker = await page.evaluate(() => document.documentElement.dataset.omgRuntime || null);
    return { marker, ready: true };
  } catch {
    const marker = await page.evaluate(() => document.documentElement.dataset.omgRuntime || null).catch(() => null);
    const markerDescription = marker ? `marker is "${marker}"` : "marker is missing";
    return {
      error: required
        ? `Optimized runtime did not become ready; ${markerDescription} (expected data-omg-runtime="ready").`
        : `Raw reference did not settle; ${markerDescription}.`,
      marker,
      ready: false
    };
  }
}

async function waitForImages(page, { all = false, timeout = 10_000 } = {}) {
  return page.evaluate(async ({ includeAll, timeoutMs }) => {
    const visible = (image) => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.images].filter((image) => (
      visible(image) && (includeAll || image.loading !== "lazy" || image.getBoundingClientRect().top < innerHeight * 1.5)
    ));
    const pending = await Promise.all(candidates.map(async (image) => {
      if (image.complete) return null;
      const settled = await new Promise((resolve) => {
        const finish = () => resolve(true);
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
        setTimeout(() => resolve(false), timeoutMs);
      });
      return settled ? null : (image.currentSrc || image.src || "(unknown image)");
    }));
    return pending.filter(Boolean);
  }, { includeAll: all, timeoutMs: timeout });
}

async function waitForNetworkIdle(page) {
  try {
    await page.waitForNetworkIdle({ idleTime: 250, timeout: 10_000 });
  } catch {
    // Image settlement below supplies a more useful diagnostic than a generic idle timeout.
  }
}

async function warmVisualPage(page) {
  await page.evaluate(async () => {
    for (const image of document.images) image.loading = "eager";
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    let previousHeight = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let top = 0; top < documentHeight; top += step) {
        window.scrollTo({ behavior: "instant", left: 0, top });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      if (documentHeight === previousHeight) break;
      previousHeight = documentHeight;
    }
  });
  await waitForNetworkIdle(page);
  return waitForImages(page, { all: true });
}

async function makeVisualStateDeterministic(page) {
  await page.evaluate(async () => {
    window.scrollTo({ behavior: "instant", left: 0, top: 0 });
    window.ScrollTrigger?.update?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const heroCanvas = document.querySelector("#wa_liquid_img canvas");
    if (heroCanvas) {
      const heroResource = performance.getEntriesByType("resource").find((entry) => {
        try {
          return /\/header-image\.(?:avif|jpe?g|png|webp)$/i.test(new URL(entry.name).pathname);
        } catch {
          return false;
        }
      });
      if (heroResource) {
        const sourceImage = document.createElement("img");
        sourceImage.alt = "header image";
        sourceImage.className = "hero-main-img";
        sourceImage.dataset.verificationHeroSource = "true";
        sourceImage.decoding = "sync";
        sourceImage.height = heroCanvas.height;
        sourceImage.src = heroResource.name;
        sourceImage.width = heroCanvas.width;
        Object.assign(sourceImage.style, {
          display: "block",
          height: "100%",
          objectFit: "cover",
          objectPosition: "50% 50%",
          width: "100%"
        });
        try {
          await sourceImage.decode();
          heroCanvas.replaceWith(sourceImage);
        } catch {
          // Keep the already-rendered canvas if its source cannot be decoded.
        }
      }
    }

    const timeline = window.gsap?.globalTimeline;
    if (timeline?.getChildren) {
      const isScrollOwned = (animation) => {
        const visited = new Set();
        for (let owner = animation; owner && !visited.has(owner); owner = owner.parent || owner._dp) {
          if (owner.scrollTrigger) return true;
          visited.add(owner);
        }
        return false;
      };
      for (const animation of timeline.getChildren(true, true, true)) {
        if (isScrollOwned(animation)) continue;
        if (typeof animation.repeat === "function" && animation.repeat() < 0) animation.pause(0);
        else if (typeof animation.progress === "function") animation.progress(1).pause();
      }
    }
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming?.();
      animation.pause();
      animation.currentTime = Number.isFinite(timing?.endTime) ? timing.endTime : 0;
    }

    const style = document.createElement("style");
    style.dataset.verification = "true";
    style.textContent = `
      html { scroll-behavior: auto !important; }
      *, *::before, *::after { caret-color: transparent !important; transition: none !important; }
      .wa_marquee_left_nopause, .wa_marquee_right_nopause, .wa_marquee_down_top,
      [data-omg-marquee-clone="true"], .js-marquee-wrapper {
        animation: none !important;
        rotate: none !important;
        scale: none !important;
        transform: translate3d(0, 0, 0) !important;
        translate: none !important;
      }
      .wa_magnetic_btn_1, .wa_magnetic_1_elm {
        --omg-magnetic-x: 0 !important;
        --omg-magnetic-y: 0 !important;
        translate: 0 0 !important;
        will-change: translate !important;
      }
      .wa-line-limit.has-line-2 {
        display: block !important;
        overflow: hidden !important;
        -webkit-box-orient: initial !important;
        -webkit-line-clamp: unset !important;
      }
      .wow,
      .wa_title_spilt_1 .char, .wa_title_spilt_1 .omg-char,
      .wa_title_split_2 .word, .wa_title_split_2 .omg-word,
      .wa_split_up .char, .wa_split_up .omg-char {
        animation: none !important;
        filter: none !important;
        opacity: 1 !important;
        transform: none !important;
        visibility: visible !important;
      }
      .mouseCursor, [class*="mouse-cursor"], [class*="cursor-dot"], .wa-cursor,
      #wa_cursor_noise { display: none !important; }
    `;
    document.head.append(style);
    window.ScrollTrigger?.update?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function preparePage(browser, origin, viewport, { collectRuntime = true, visual = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  const requests = new Set();
  const externalRequests = new Set();
  await page.setViewport({
    deviceScaleFactor: 1,
    hasTouch: Boolean(viewport.mobile),
    height: viewport.height,
    isMobile: Boolean(viewport.mobile),
    width: viewport.width
  });
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Storage can be unavailable in hardened browser profiles.
    }
  });

  page.on("request", (request) => {
    const url = request.url();
    if (/^(?:about:|blob:|data:)/i.test(url)) {
      request.continue();
      return;
    }
    requests.add(url);
    if (normalizedUrlOrigin(url) !== origin) {
      externalRequests.add(url);
      request.abort("blockedbyclient");
      return;
    }
    request.continue();
  });
  page.on("console", (message) => {
    if (collectRuntime && message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    if (collectRuntime) errors.push(`page: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    if (collectRuntime && normalizedUrlOrigin(request.url()) === origin) {
      errors.push(`request failed: ${request.url()} (${request.failure()?.errorText || "unknown"})`);
    }
  });
  page.on("response", (response) => {
    if (collectRuntime && normalizedUrlOrigin(response.url()) === origin && response.status() >= 400) {
      errors.push(`response ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(`${origin}/`, { timeout: 45_000, waitUntil: "networkidle0" });
  const runtimeState = await waitForRuntime(page, { required: collectRuntime });
  if (collectRuntime && !runtimeState.ready) errors.push(`runtime: ${runtimeState.error}`);
  await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
  const initiallyPendingImages = await waitForImages(page);
  const initialRequests = new Set(requests);
  if (visual) {
    const pendingAfterWarm = await warmVisualPage(page);
    for (const url of new Set(pendingAfterWarm)) errors.push(`image did not settle: ${url}`);
    await makeVisualStateDeterministic(page);
  }
  for (const url of new Set(initiallyPendingImages)) errors.push(`image did not settle: ${url}`);

  return { errors, externalRequests, initialRequests, page, requests };
}

async function screenshotPage(browser, origin, viewport, destination, runtime, visual = true, capture = true) {
  const state = await preparePage(browser, origin, viewport, { collectRuntime: runtime, visual });
  const imageState = await state.page.evaluate(() => ({
    brokenImages: [...document.images]
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src),
    sections: [...document.querySelectorAll("section")]
      .filter((section) => {
        const rect = section.getBoundingClientRect();
        const style = getComputedStyle(section);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((section, index) => {
        const rect = section.getBoundingClientRect();
        const hint = section.id || [...section.classList].find((value) => /(?:area|section|hero|about|team|faq|cta|blog|portfolio|service|feature|partner|marquee)/i.test(value)) || `section-${index + 1}`;
        const slug = hint.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return {
          bounds: {
            height: Math.ceil(rect.height),
            left: 0,
            top: Math.max(0, Math.floor(rect.top + window.scrollY)),
            width: document.documentElement.clientWidth
          },
          key: `${String(index + 1).padStart(2, "0")}-${slug || `section-${index + 1}`}`,
          selector: section.id ? `#${CSS.escape(section.id)}` : `section.${[...section.classList].map((value) => CSS.escape(value)).join(".")}`
        };
      }),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    title: document.title
  }));
  if (capture) await state.page.screenshot({ fullPage: true, path: destination });
  return { ...state, imageState };
}

async function exerciseInteractions(page, viewport) {
  const result = await page.evaluate(async () => {
    const result = {};
    const pause = (duration = 30) => new Promise((resolve) => setTimeout(resolve, duration));
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const targetFrom = (control) => {
      const selector = control?.getAttribute("data-bs-target");
      if (!selector) return null;
      try { return document.querySelector(selector); } catch { return null; }
    };

    const mobileToggle = [...document.querySelectorAll(".offcanvas_toggle")].find(visible);
    const desktopToggle = [...document.querySelectorAll(".as-header-1-menu-toggle-btn")].find(visible);
    const menuToggle = mobileToggle || desktopToggle;
    if (menuToggle === mobileToggle) {
      const panel = document.querySelector(".offcanvas_box_active");
      menuToggle?.click();
      await pause();
      const opened = Boolean(panel?.classList.contains("active") && menuToggle?.getAttribute("aria-expanded") === "true");
      document.querySelector(".offcanvas_box_close, .wa-overly")?.click();
      await pause();
      result.menu = { opened, passed: opened && !panel?.classList.contains("active"), variant: "mobile" };
    } else if (menuToggle) {
      const menu = document.querySelector(".as-header-1-menu");
      menuToggle.click();
      await pause();
      const opened = menuToggle.classList.contains("active") && menu?.classList.contains("show");
      menuToggle.click();
      await pause();
      result.menu = { opened, passed: opened && !menuToggle.classList.contains("active") && !menu?.classList.contains("show"), variant: "desktop" };
    } else result.menu = { passed: false, reason: "no visible OneMilligram menu toggle" };

    const tabs = [...document.querySelectorAll('[data-bs-toggle="tab"]')].filter(visible);
    const tab = tabs.find((candidate) => !candidate.classList.contains("active"));
    if (tab) {
      const panel = targetFrom(tab);
      const previouslyActive = tabs.find((candidate) => candidate.classList.contains("active"));
      tab.click();
      await pause();
      result.tab = {
        passed: tab.classList.contains("active") && tab.getAttribute("aria-selected") === "true" && Boolean(panel?.classList.contains("active")) && !previouslyActive?.classList.contains("active")
      };
    } else result.tab = { passed: false, reason: "no inactive visible tab" };

    const accordion = [...document.querySelectorAll('[data-bs-toggle="collapse"]')].find(visible);
    if (accordion) {
      const panel = targetFrom(accordion);
      accordion.click();
      await pause(40);
      const opened = accordion.getAttribute("aria-expanded") === "true" && Boolean(panel?.classList.contains("show")) && !panel?.hidden;
      accordion.click();
      await pause(380);
      result.accordion = { opened, passed: opened && accordion.getAttribute("aria-expanded") === "false" && !panel?.classList.contains("show") && Boolean(panel?.hidden) };
    } else result.accordion = { passed: false, reason: "no visible accordion control" };

    const widget = [...document.querySelectorAll('.nice-select[data-omg-nice-select]')].find(visible);
    if (widget) {
      const select = widget.previousElementSibling;
      const before = select instanceof HTMLSelectElement ? select.value : null;
      widget.click();
      await pause();
      const option = [...widget.querySelectorAll(".option:not(.disabled)")].find((candidate) => candidate.dataset.value && candidate.dataset.value !== before);
      option?.click();
      await pause();
      result.niceSelect = { passed: Boolean(option && select instanceof HTMLSelectElement && select.value === option.dataset.value && select.value !== before) };
    } else result.niceSelect = { passed: false, reason: "no visible optimized nice-select widget" };

    const customize = document.querySelector("#cookieadmin_customize_button");
    const modal = document.querySelector(".cookieadmin_cookie_modal");
    const notice = document.querySelector(".cookieadmin_law_container");
    const reconsent = document.querySelector(".cookieadmin_re_consent");
    if (customize && modal && notice && reconsent) {
      customize.click();
      await pause();
      const customized = modal.getAttribute("aria-hidden") === "false" && getComputedStyle(modal).display !== "none";
      modal.querySelector("#cookieadmin_accept_modal_button")?.click();
      await pause();
      const accepted = getComputedStyle(notice).display === "none" && getComputedStyle(reconsent).display !== "none";
      reconsent.click();
      await pause();
      const reopened = modal.getAttribute("aria-hidden") === "false" && getComputedStyle(modal).display !== "none";
      modal.querySelector(".cookieadmin_close_pref")?.click();
      result.cookie = { accepted, customized, passed: customized && accepted && reopened, reopened };
    } else result.cookie = { passed: false, reason: "cookie controls are incomplete" };

    const form = [...document.forms].find(visible);
    if (form) {
      for (const input of form.querySelectorAll("input, textarea")) {
        if (input.disabled || input.type === "hidden" || input.type === "submit") continue;
        input.value = input.type === "email" ? "verify@example.test" : "Verification";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const intercepted = !form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const output = form.closest(".wpcf7")?.querySelector(".wpcf7-response-output");
      result.form = {
        intercepted,
        outputVisible: output?.getAttribute("aria-hidden") === "false",
        passed: intercepted,
        selector: form.id ? `#${form.id}` : form.className || "form"
      };
    } else result.form = { passed: false, reason: "no visible local form" };
    return result;
  });

  const beforeWidth = await page.evaluate(() => window.innerWidth);
  const resizedWidth = Math.max(320, viewport.width - 7);
  await page.setViewport({
    deviceScaleFactor: 1,
    hasTouch: Boolean(viewport.mobile),
    height: viewport.height,
    isMobile: Boolean(viewport.mobile),
    width: resizedWidth
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const resizeState = await page.evaluate(() => ({
    runtimeReady: !window.__OMG_PERF__ || window.__OMG_PERF__.ready === true,
    width: window.innerWidth
  }));
  result.resize = {
    from: beforeWidth,
    passed: resizeState.width === resizedWidth && resizeState.width !== beforeWidth && resizeState.runtimeReady,
    to: resizeState.width
  };
  await page.setViewport({
    deviceScaleFactor: 1,
    hasTouch: Boolean(viewport.mobile),
    height: viewport.height,
    isMobile: Boolean(viewport.mobile),
    width: viewport.width
  });
  return result;
}

async function measureScroll(page, mobile) {
  const session = await page.createCDPSession();
  try {
    await session.send("Emulation.setCPUThrottlingRate", { rate: mobile ? 4 : 1 });
    return await page.evaluate(async () => {
    window.scrollTo({ behavior: "instant", left: 0, top: 0 });
    const longTasks = [];
    const observer = typeof PerformanceObserver === "function"
      ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)))
      : null;
    try { observer?.observe({ type: "longtask", buffered: false }); } catch { /* Unsupported in this browser. */ }

    const frames = [];
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    let maximumObserved = 0;
    let forwardFrames = 0;
    let reverseFrames = 0;
    let previousTop = window.scrollY;
    const duration = 2_000;
    const started = performance.now();
    await new Promise((resolve) => {
      const frame = (time) => {
        frames.push(time);
        const progress = Math.min(1, (time - started) / duration);
        const route = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
        window.scrollTo({ behavior: "instant", left: 0, top: maximum * route });
        maximumObserved = Math.max(maximumObserved, window.scrollY);
        if (window.scrollY > previousTop) forwardFrames += 1;
        else if (window.scrollY < previousTop) reverseFrames += 1;
        previousTop = window.scrollY;
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    window.scrollTo({ behavior: "instant", left: 0, top: 0 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (observer?.takeRecords) longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
    observer?.disconnect();
    const elapsed = frames.at(-1) - frames[0];
    return {
      fps: elapsed > 0 ? ((frames.length - 1) * 1_000) / elapsed : 0,
      frames: frames.length,
      forwardAndReverse: forwardFrames > 0 && reverseFrames > 0,
      maxFrame: Math.max(0, ...frames.slice(1).map((time, index) => time - frames[index])),
      maxLongTask: Math.max(0, ...longTasks),
      reachedEnd: maximum === 0 || maximumObserved >= maximum * 0.95,
      returnedToTop: window.scrollY <= 1
    };
    });
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await session.detach().catch(() => {});
  }
}

async function compareImages(referencePath, currentPath, diffPath, maximumDifference, { registrationRadius = 0 } = {}) {
  const [{ PNG }, { default: pixelmatch }] = await Promise.all([import("pngjs"), import("pixelmatch")]);
  const reference = PNG.sync.read(await readFile(referencePath));
  const current = PNG.sync.read(await readFile(currentPath));
  if (reference.width !== current.width || reference.height !== current.height) {
    return {
      current: { height: current.height, width: current.width },
      dimensionMismatch: true,
      passed: false,
      reference: { height: reference.height, width: reference.width }
    };
  }

  const pixelmatchOptions = {
    includeAA: false,
    threshold: 0.12
  };
  const radius = Math.max(0, Math.floor(Number(registrationRadius) || 0));
  const offsets = [{ x: 0, y: 0 }];
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x !== 0 || y !== 0) offsets.push({ x, y });
    }
  }
  offsets.sort((left, right) => (
    Math.abs(left.x) + Math.abs(left.y) - Math.abs(right.x) - Math.abs(right.y)
    || left.y - right.y
    || left.x - right.x
  ));

  let best;
  for (const alignment of offsets) {
    const left = Math.max(0, alignment.x);
    const top = Math.max(0, alignment.y);
    const currentLeft = left - alignment.x;
    const currentTop = top - alignment.y;
    const width = current.width - Math.abs(alignment.x);
    const height = current.height - Math.abs(alignment.y);
    if (width <= 0 || height <= 0) continue;

    const referenceCrop = new PNG({ height, width });
    const currentCrop = new PNG({ height, width });
    const diffCrop = new PNG({ height, width });
    PNG.bitblt(reference, referenceCrop, left, top, width, height, 0, 0);
    PNG.bitblt(current, currentCrop, currentLeft, currentTop, width, height, 0, 0);
    const changedPixels = pixelmatch(
      referenceCrop.data,
      currentCrop.data,
      diffCrop.data,
      width,
      height,
      pixelmatchOptions
    );
    const ratio = changedPixels / (width * height);
    const candidate = { alignment, changedPixels, diffCrop, height, left, ratio, top, width };
    if (!best || ratio < best.ratio) best = candidate;
  }

  const diff = new PNG({ height: current.height, width: current.width });
  pixelmatch(reference.data, reference.data, diff.data, current.width, current.height, pixelmatchOptions);
  PNG.bitblt(best.diffCrop, diff, 0, 0, best.width, best.height, best.left, best.top);
  await mkdir(path.dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));
  return {
    alignment: best.alignment,
    changedPixels: best.changedPixels,
    maximumDifference,
    passed: best.ratio <= maximumDifference,
    ratio: best.ratio
  };
}

async function cropImage(sourcePath, destinationPath, bounds) {
  const { PNG } = await import("pngjs");
  const source = PNG.sync.read(await readFile(sourcePath));
  const left = Math.max(0, Math.min(source.width - 1, Math.floor(bounds.left || 0)));
  const top = Math.max(0, Math.min(source.height - 1, Math.floor(bounds.top || 0)));
  const width = Math.max(1, Math.min(source.width - left, Math.ceil(bounds.width || source.width)));
  const height = Math.max(1, Math.min(source.height - top, Math.ceil(bounds.height || 1)));
  const crop = new PNG({ height, width });
  PNG.bitblt(source, crop, left, top, width, height, 0, 0);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, PNG.sync.write(crop));
  return { height, width };
}

async function cropSections(imagePath, destinationDirectory, sections) {
  const results = [];
  for (const section of sections) {
    const destination = path.join(destinationDirectory, `${section.key}.png`);
    const dimensions = await cropImage(imagePath, destination, section.bounds);
    results.push({ ...section, dimensions, path: destination });
  }
  return results;
}

function appendPageErrors(destination, state, viewportName, phase) {
  for (const error of state.errors) {
    destination.push({ code: "browser-error", detail: `${viewportName} (${phase}): ${error}` });
  }
  for (const url of state.externalRequests) {
    destination.push({ code: "external-request", detail: `${viewportName} (${phase}): ${url}` });
  }
}

function appendInteractionErrors(destination, interactions, viewportName) {
  const checks = [
    ["menu", "interaction-menu"],
    ["tab", "interaction-tab"],
    ["accordion", "interaction-accordion"],
    ["niceSelect", "interaction-nice-select"],
    ["cookie", "interaction-cookie"],
    ["form", "interaction-form"],
    ["resize", "interaction-resize"]
  ];
  for (const [name, code] of checks) {
    if (interactions[name]?.passed) continue;
    destination.push({
      code,
      detail: `${viewportName}: ${interactions[name]?.reason || `${name} did not complete an open/change/close cycle`}`
    });
  }
}

async function runBrowserVerification(options) {
  if (!(await exists(options.chromePath))) throw new Error(`Chrome executable not found: ${options.chromePath}`);
  const { default: puppeteer } = await import("puppeteer-core");
  const optimizedServer = await listen(options.root);
  let referenceServer;
  let browser;
  const useStoredBaselines = options.baselineDirectoryExplicit && !options.referenceRootExplicit;

  try {
    if (!options.skipVisual && !options.updateBaseline && !useStoredBaselines) {
      if (!(await exists(options.referenceRoot))) {
        throw new Error(`Raw visual reference not found: ${options.referenceRoot}`);
      }
      referenceServer = await listen(options.referenceRoot);
    } else if (!options.skipVisual && !options.updateBaseline && useStoredBaselines && !(await exists(options.baselineDirectory))) {
      throw new Error(`Stored visual baseline directory not found: ${options.baselineDirectory}`);
    }

    await mkdir(path.join(options.artifacts, "current"), { recursive: true });
    await mkdir(path.join(options.artifacts, "current", "sections"), { recursive: true });
    await mkdir(path.join(options.artifacts, "reference"), { recursive: true });
    await mkdir(path.join(options.artifacts, "reference", "sections"), { recursive: true });
    await mkdir(path.join(options.artifacts, "diff"), { recursive: true });
    await mkdir(path.join(options.artifacts, "diff", "sections"), { recursive: true });
    if (options.updateBaseline) await mkdir(options.baselineDirectory, { recursive: true });

    browser = await puppeteer.launch({
      args: ["--disable-background-networking", "--disable-default-apps", "--disable-extensions", "--disable-sync", "--no-first-run"],
      executablePath: options.chromePath,
      headless: true
    });

    const runtimeErrors = [];
    const viewportReports = [];
    for (const viewport of viewports) {
      const representativeDesktop = viewport.name === "desktop-1280x720";
      const representativeMobile = viewport.name === "mobile-390x844";
      const runBehaviorChecks = representativeDesktop || representativeMobile;
      const currentPath = path.join(options.artifacts, "current", `${viewport.name}.png`);
      const captureVisual = !options.skipVisual || options.updateBaseline;
      const current = await screenshotPage(browser, optimizedServer.origin, viewport, currentPath, true, captureVisual, captureVisual);
      const currentSections = captureVisual
        ? await cropSections(
          currentPath,
          path.join(options.artifacts, "current", "sections", viewport.name),
          current.imageState.sections
        )
        : [];

      const interactionState = runBehaviorChecks
        ? await preparePage(browser, optimizedServer.origin, viewport, { collectRuntime: true })
        : null;
      const interactions = interactionState
        ? await exerciseInteractions(interactionState.page, viewport)
        : { skipped: true };
      const scrollState = runBehaviorChecks
        ? await preparePage(browser, optimizedServer.origin, viewport, { collectRuntime: true })
        : null;
      const scroll = scrollState
        ? await measureScroll(scrollState.page, Boolean(viewport.mobile))
        : { skipped: true };

      appendPageErrors(runtimeErrors, current, viewport.name, options.skipVisual ? "capture" : "visual");
      if (interactionState) appendPageErrors(runtimeErrors, interactionState, viewport.name, "interactions");
      if (scrollState) appendPageErrors(runtimeErrors, scrollState, viewport.name, "scroll");
      for (const url of current.imageState.brokenImages) runtimeErrors.push({ code: "broken-image", detail: `${viewport.name}: ${url}` });
      if (interactionState) appendInteractionErrors(runtimeErrors, interactions, viewport.name);
      if (scrollState) {
        const minimumFps = viewport.mobile ? 30 : 55;
        if (scroll.fps < minimumFps) {
          runtimeErrors.push({ code: "scroll-fps", detail: `${viewport.name}: ${scroll.fps.toFixed(1)} FPS is below ${minimumFps}` });
        }
        if (scroll.maxLongTask > 50) {
          runtimeErrors.push({ code: "scroll-long-task", detail: `${viewport.name}: ${scroll.maxLongTask.toFixed(1)} ms exceeds 50 ms` });
        }
        if (!scroll.reachedEnd || !scroll.returnedToTop || !scroll.forwardAndReverse) {
          runtimeErrors.push({ code: "scroll-route", detail: `${viewport.name}: forward and reverse scrolling did not reach both endpoints` });
        }
      }

      let visual = { passed: true, skipped: options.skipVisual };
      let sectionReports = currentSections.map((section) => ({ ...section, visual: { passed: true, skipped: options.skipVisual } }));
      if (options.updateBaseline) {
        const baselinePath = path.join(options.baselineDirectory, `${viewport.name}.png`);
        await writeFile(baselinePath, await readFile(currentPath));
        await writeFile(
          path.join(options.baselineDirectory, `${viewport.name}.sections.json`),
          `${JSON.stringify(current.imageState.sections, null, 2)}\n`
        );
        visual = { baselinePath, passed: true, updated: true };
      } else if (!options.skipVisual) {
        let referencePath;
        let referenceSections;
        if (useStoredBaselines) {
          const baselinePath = path.join(options.baselineDirectory, `${viewport.name}.png`);
          if (!(await exists(baselinePath))) throw new Error(`Stored visual baseline not found: ${baselinePath}`);
          referencePath = path.join(options.artifacts, "reference", `${viewport.name}.png`);
          await writeFile(referencePath, await readFile(baselinePath));
          const metadataPath = path.join(options.baselineDirectory, `${viewport.name}.sections.json`);
          const metadata = await exists(metadataPath)
            ? JSON.parse(await readFile(metadataPath, "utf8"))
            : current.imageState.sections;
          referenceSections = await cropSections(
            referencePath,
            path.join(options.artifacts, "reference", "sections", viewport.name),
            metadata
          );
        } else {
          referencePath = path.join(options.artifacts, "reference", `${viewport.name}.png`);
          const reference = await screenshotPage(browser, referenceServer.origin, viewport, referencePath, false);
          referenceSections = await cropSections(
            referencePath,
            path.join(options.artifacts, "reference", "sections", viewport.name),
            reference.imageState.sections
          );
          await reference.page.close();
        }
        visual = await compareImages(
          referencePath,
          currentPath,
          path.join(options.artifacts, "diff", `${viewport.name}.png`),
          options.maxDiff
        );
        if (!visual.passed) {
          runtimeErrors.push({
            code: "visual-regression",
            detail: visual.dimensionMismatch
              ? `${viewport.name}: screenshot dimensions changed`
              : `${viewport.name}: ${(visual.ratio * 100).toFixed(3)}% pixels changed (limit ${(options.maxDiff * 100).toFixed(3)}%)`
          });
        }

        const currentByKey = new Map(currentSections.map((section) => [section.key, section]));
        const referenceByKey = new Map(referenceSections.map((section) => [section.key, section]));
        const sectionKeys = new Set([...currentByKey.keys(), ...referenceByKey.keys()]);
        sectionReports = [];
        for (const key of sectionKeys) {
          const currentSection = currentByKey.get(key);
          const referenceSection = referenceByKey.get(key);
          if (!currentSection || !referenceSection) {
            const sectionVisual = { passed: false, reason: currentSection ? "missing reference section" : "missing current section" };
            sectionReports.push({ ...(currentSection || referenceSection), visual: sectionVisual });
            runtimeErrors.push({ code: "visual-regression-section", detail: `${viewport.name} ${key}: ${sectionVisual.reason}` });
            continue;
          }
          const sectionVisual = await compareImages(
            referenceSection.path,
            currentSection.path,
            path.join(options.artifacts, "diff", "sections", viewport.name, `${key}.png`),
            options.maxDiff,
            { registrationRadius: 1 }
          );
          sectionReports.push({ ...currentSection, visual: sectionVisual });
          if (!sectionVisual.passed) {
            runtimeErrors.push({
              code: "visual-regression-section",
              detail: sectionVisual.dimensionMismatch
                ? `${viewport.name} ${key}: section dimensions changed`
                : `${viewport.name} ${key}: ${(sectionVisual.ratio * 100).toFixed(3)}% pixels changed (limit ${(options.maxDiff * 100).toFixed(3)}%)`
            });
          }
        }
      }

      viewportReports.push({
        imageState: current.imageState,
        interactions,
        name: viewport.name,
        requestCount: current.initialRequests.size,
        sections: sectionReports,
        scroll,
        totalRequestCount: current.requests.size,
        visual,
        viewport: { height: viewport.height, width: viewport.width }
      });
      await interactionState?.page.close();
      await scrollState?.page.close();
      await current.page.close();
    }

    return { errors: runtimeErrors, viewports: viewportReports };
  } finally {
    if (browser) await browser.close();
    await Promise.all([close(optimizedServer.server), close(referenceServer?.server)]);
  }
}

async function writeReport(destination, report) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(helpText());
      return;
    }
    const rootInfo = await stat(options.root);
    if (!rootInfo.isDirectory()) throw new Error(`Static root is not a directory: ${options.root}`);

    const staticResult = await inspectStaticSite(options.root);
    const browserResult = options.staticOnly ? { errors: [], skipped: true, viewports: [] } : await runBrowserVerification(options);
    const errors = [...staticResult.errors, ...browserResult.errors];
    const report = {
      browser: browserResult,
      generatedAt: new Date().toISOString(),
      passed: errors.length === 0,
      referenceRoot: options.staticOnly || options.skipVisual || options.updateBaseline ? null : options.referenceRoot,
      root: options.root,
      static: staticResult
    };
    await writeReport(options.output, report);

    if (report.passed) {
      console.log(`Verification passed (${staticResult.files} files, ${browserResult.viewports.length} viewports).`);
      return;
    }
    for (const error of errors) console.error(`[${error.code}] ${error.detail}`);
    console.error(`Verification failed with ${errors.length} issue(s). Report: ${options.output}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(`Verification could not run: ${error.message}`);
    process.exitCode = 2;
  }
}

await main();
