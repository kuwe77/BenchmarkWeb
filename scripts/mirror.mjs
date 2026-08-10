import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSiteRoot,
  mirrorCacheRoot,
  optimizeSite,
  rawMirrorRoot,
  validateOptimizedSite
} from "./optimize.mjs";

const source = new URL("https://onemilligram.com/");
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let outputRoot;
const pending = [];
const queued = new Set();
const completed = new Set();
const failures = [];
const skipped = [];
const publicPaths = new Map();

const assetPattern = /\.(?:avif|css|eot|gif|ico|jpe?g|js|json|mp4|png|svg|webm|webp|woff2?|ttf)(?:$|\?)/i;
const firstPartyPathPattern = /^\/(?:wp-content|wp-includes)\//;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function runGate(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, "scripts", script), ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}; the existing clone was not replaced.`));
    });
  });
}

async function promoteRefresh(nextRawRoot, nextSiteRoot) {
  const token = `${process.pid}-${Date.now()}`;
  const entries = [
    { backup: `${defaultSiteRoot}.previous-${token}`, next: nextSiteRoot, target: defaultSiteRoot },
    { backup: `${rawMirrorRoot}.previous-${token}`, next: nextRawRoot, target: rawMirrorRoot }
  ];
  const backedUp = [];
  const promoted = [];

  try {
    for (const entry of entries) {
      if (!(await exists(entry.target))) continue;
      await rename(entry.target, entry.backup);
      backedUp.push(entry);
    }
    for (const entry of entries) {
      await rename(entry.next, entry.target);
      promoted.push(entry);
    }
  } catch (error) {
    for (const entry of promoted.reverse()) {
      if (await exists(entry.target)) await rm(entry.target, { force: true, recursive: true });
    }
    for (const entry of backedUp.reverse()) {
      if (await exists(entry.backup)) await rename(entry.backup, entry.target);
    }
    throw error;
  }

  for (const entry of backedUp) {
    try {
      await rm(entry.backup, { force: true, recursive: true });
    } catch (error) {
      console.warn(`Promoted successfully, but could not remove backup ${entry.backup}: ${error.message}`);
    }
  }
}

function decodeEntities(value) {
  return value.replaceAll("&#038;", "&").replaceAll("&amp;", "&");
}

function isMirrorAsset(url) {
  if (url.origin === source.origin) {
    return firstPartyPathPattern.test(url.pathname) && assetPattern.test(url.pathname);
  }

  if (url.hostname === "fonts.googleapis.com") return url.pathname.startsWith("/css");
  if (url.hostname === "fonts.gstatic.com") return assetPattern.test(url.pathname);
  if (url.hostname === "s.w.org") return url.pathname.startsWith("/images/core/emoji/") && assetPattern.test(url.pathname);
  return false;
}

function localPathFor(url) {
  if (url.origin !== source.origin) {
    if (url.hostname === "s.w.org") {
      return join(outputRoot, "external", url.hostname, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    }

    const extension = extname(url.pathname) || (url.hostname === "fonts.googleapis.com" ? ".css" : "");
    const stem = (url.pathname.split("/").filter(Boolean).pop() || "asset").replace(/\.[^.]+$/, "");
    const digest = createHash("sha1").update(url.href).digest("hex").slice(0, 10);
    return join(outputRoot, "external", url.hostname, `${stem}-${digest}${extension}`);
  }

  const clean = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  return join(outputRoot, clean || "index.html");
}

function publicPathFor(url) {
  if (url.origin === source.origin) return url.pathname || "/";
  return `/${localPathFor(url).slice(outputRoot.length + 1).split("\\").join("/")}`;
}

function queueAsset(raw, base = source) {
  if (!raw || /^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(raw)) return;

  try {
    const url = new URL(decodeEntities(raw.trim()), base);
    if (!isMirrorAsset(url)) return;
    url.hash = "";
    const key = url.href;
    publicPaths.set(key, publicPathFor(url));
    if (queued.has(key)) return;
    queued.add(key);
    pending.push(url);
  } catch {
    // Ignore malformed values from third-party widgets.
  }
}

function collectHtmlAssets(html, base) {
  html = html.replaceAll("\\/", "/");
  const singleValue = /\b(?:src|href|poster|data-src|data-lazy-src|data-bg|data-background)\s*=\s*["']([^"']+)["']/gi;
  const sourceSets = /\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;
  const absoluteFirstParty = /https:\/\/onemilligram\.com\/[A-Za-z0-9_~!$&'()*+,;=:@%./?#[\]-]+/gi;
  const mirroredExternal = /https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|s\.w\.org)\/[A-Za-z0-9_~!$&'()*+,;=:@%./?#[\]-]+/gi;

  for (const match of html.matchAll(singleValue)) queueAsset(match[1], base);
  for (const match of html.matchAll(sourceSets)) {
    for (const candidate of match[1].split(",")) queueAsset(candidate.trim().split(/\s+/)[0], base);
  }
  for (const match of html.matchAll(absoluteFirstParty)) queueAsset(match[0], base);
  for (const match of html.matchAll(mirroredExternal)) queueAsset(match[0], base);
}

function collectCssAssets(css, base) {
  const urls = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  const imports = /@import\s+(?:url\()?\s*["']([^"']+)["']/gi;
  for (const match of css.matchAll(urls)) queueAsset(match[1], base);
  for (const match of css.matchAll(imports)) queueAsset(match[1], base);
}

function collectScriptAssets(script, base) {
  script = script.replaceAll("\\/", "/");
  const urls = /https:\/\/onemilligram\.com\/[A-Za-z0-9_~!$&'()*+,;=:@%./?#[\]-]+/gi;
  const relativeScripts = /["']([A-Za-z0-9][A-Za-z0-9._-]*\.js(?:\?[A-Za-z0-9._=&-]*)?)["']/gi;
  for (const match of script.matchAll(urls)) queueAsset(match[0], base);
  for (const match of script.matchAll(relativeScripts)) queueAsset(match[1], base);
}

function localizeFirstPartyAssets(text) {
  return text
    .replaceAll("https:\\/\\/s.w.org\\/", "\\/external\\/s.w.org\\/")
    .replaceAll("https://s.w.org/", "/external/s.w.org/")
    .replaceAll("https:\\/\\/www.onemilligram.com\\/wp-content\\/", "\\/wp-content\\/")
    .replaceAll("https:\\/\\/www.onemilligram.com\\/wp-includes\\/", "\\/wp-includes\\/")
    .replaceAll("https:\\/\\/onemilligram.com\\/wp-content\\/", "\\/wp-content\\/")
    .replaceAll("https:\\/\\/onemilligram.com\\/wp-includes\\/", "\\/wp-includes\\/")
    .replaceAll("https:\\/\\/onemilligram.com\\/wp-admin\\/", "\\/wp-admin\\/")
    .replaceAll("https:\\/\\/onemilligram.com\\/wp-json\\/", "\\/wp-json\\/")
    .replaceAll("https://www.onemilligram.com/wp-content/", "/wp-content/")
    .replaceAll("https://www.onemilligram.com/wp-includes/", "/wp-includes/")
    .replaceAll("https://onemilligram.com/wp-content/", "/wp-content/")
    .replaceAll("https://onemilligram.com/wp-includes/", "/wp-includes/")
    .replaceAll("//onemilligram.com/wp-content/", "/wp-content/")
    .replaceAll("//onemilligram.com/wp-includes/", "/wp-includes/");
}

function localizeQueuedAssets(text) {
  for (const [remote, local] of publicPaths) {
    text = text
      .replaceAll(remote, local)
      .replaceAll(remote.replaceAll("&", "&#038;"), local)
      .replaceAll(remote.replaceAll("&", "&amp;"), local)
      .replaceAll(remote.replaceAll("/", "\\/"), local.replaceAll("/", "\\/"));
  }
  return text;
}

function stripTelemetry(html) {
  return html
    .replace(/<!-- Google tag[\s\S]*?<!-- End Google Tag Manager[^>]*-->/gi, "")
    .replace(/<script[^>]+src=["']https:\/\/www\.googletagmanager\.com\/[^"']+["'][^>]*><\/script>/gi, "")
    .replace(/<script[^>]+id=["']google_gtagjs-js-after["'][^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]+id=["'][^"']*googlesitekit[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]+src=["'][^"']*\/google-site-kit\/[^"']+["'][^>]*><\/script>/gi, "")
    .replace(/<script[^>]+src=["'][^"']*\/contact-form-7\/includes\/(?:swv\/js\/index|js\/index)\.js[^"']*["'][^>]*><\/script>/gi, "")
    .replace(/<script[^>]+src=["'][^"']*\/cookieadmin-pro\/assets\/js\/consent\.js[^"']*["'][^>]*><\/script>/gi, "");
}

async function fetchBuffer(url) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "*/*",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36"
        },
        redirect: "follow"
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || ""
      };
    } catch (error) {
      lastError = error;
      if (String(error.message || error).startsWith("404 ")) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }

  throw lastError;
}

async function downloadAsset(url) {
  const key = url.href;
  if (completed.has(key)) return;

  try {
    const { buffer, contentType } = await fetchBuffer(url);
    let output = buffer;
    const extension = extname(url.pathname).toLowerCase();
    const isCss = contentType.includes("text/css") || extension === ".css";
    const isJs = contentType.includes("javascript") || extension === ".js";

    if (isCss || isJs) {
      let text = buffer.toString("utf8");
      if (isCss) collectCssAssets(text, url);
      if (isJs) collectScriptAssets(text, url);
      text = localizeQueuedAssets(localizeFirstPartyAssets(text));
      output = Buffer.from(text);
    }

    const path = localPathFor(url);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
    completed.add(key);
  } catch (error) {
    const message = String(error.message || error);
    if (message.startsWith("404 ")) skipped.push({ url: key, reason: message });
    else failures.push({ url: key, error: message });
  }
}

async function drainQueue() {
  while (pending.length) {
    const batch = pending.splice(0, 12);
    await Promise.all(batch.map(downloadAsset));
  }
}

async function main() {
  await mkdir(mirrorCacheRoot, { recursive: true });
  const workRoot = await mkdtemp(join(mirrorCacheRoot, "refresh-"));
  const nextRawRoot = join(workRoot, "raw");
  const nextSiteRoot = join(workRoot, "site");
  outputRoot = nextRawRoot;

  try {
    await mkdir(outputRoot, { recursive: true });
    const { buffer } = await fetchBuffer(source);
    let html = buffer.toString("utf8");

    collectHtmlAssets(html, source);
    queueAsset("https://s.w.org/images/core/emoji/17.0.2/svg/260e.svg", source);
    await drainQueue();

    html = localizeQueuedAssets(localizeFirstPartyAssets(stripTelemetry(html)));
    html = html.replace(/href=["']https:\/\/onemilligram\.com\/["']/gi, 'href="/"');
    await writeFile(join(outputRoot, "index.html"), html);

    const report = {
      source: source.href,
      mirroredAt: new Date().toISOString(),
      downloaded: completed.size,
      skipped,
      failed: failures
    };
    await writeFile(join(outputRoot, "mirror-report.json"), JSON.stringify(report, null, 2));

    if (failures.length) {
      throw new Error(`${failures.length} assets failed; the existing site was not replaced.`);
    }

    let optimizedReport = await optimizeSite({
      inputRoot: nextRawRoot,
      outputRoot: nextSiteRoot,
      sourceReport: report
    });

    const gateArtifacts = join(projectRoot, "artifacts", "mirror-refresh");
    await rm(gateArtifacts, { force: true, recursive: true });
    await mkdir(gateArtifacts, { recursive: true });
    await runGate("verify.mjs", [
      "--root", nextSiteRoot,
      "--reference-root", nextRawRoot,
      "--output", join(gateArtifacts, "verify-report.json"),
      "--artifacts", join(gateArtifacts, "verify")
    ]);
    await runGate("perf.mjs", [
      "--root", nextSiteRoot,
      "--output", join(gateArtifacts, "performance-summary.json"),
      "--artifacts", join(gateArtifacts, "performance")
    ]);
    await validateOptimizedSite(nextSiteRoot);
    optimizedReport = JSON.parse(await readFile(join(nextSiteRoot, "mirror-report.json"), "utf8"));

    // Promote the raw reference and optimized output as one transaction. If
    // either rename fails, both previous directories are restored.
    await promoteRefresh(nextRawRoot, nextSiteRoot);

    console.log(`Mirrored ${completed.size} assets into .cache/mirror/raw.`);
    if (skipped.length) console.log(`Skipped ${skipped.length} unavailable fallback assets.`);
    console.log(`Optimized site promoted atomically (${optimizedReport.optimization.savings.percent}% smaller).`);
  } finally {
    await rm(workRoot, { force: true, recursive: true });
  }
}

await main();
