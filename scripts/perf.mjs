import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

import { createStaticServer } from "../server.mjs";
import { DEFAULT_BUDGETS, evaluateLighthouseReport } from "./performance-core.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const brotli = promisify(brotliCompress);
const gzipBuffer = promisify(gzip);

function parseArguments(argv) {
  const options = {
    artifacts: path.join(projectRoot, "artifacts", "performance"),
    chromePath: process.env.CHROME_PATH || defaultChrome,
    output: path.join(projectRoot, "artifacts", "performance", "summary.json"),
    root: path.join(projectRoot, "site")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--artifacts") options.artifacts = path.resolve(value());
    else if (argument === "--chrome-path") options.chromePath = path.resolve(value());
    else if (argument === "--desktop-report") options.desktopReport = path.resolve(value());
    else if (argument === "--mobile-report") options.mobileReport = path.resolve(value());
    else if (argument === "--output") options.output = path.resolve(value());
    else if (argument === "--root") options.root = path.resolve(value());
    else if (argument === "--url") options.url = value();
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (Boolean(options.mobileReport) !== Boolean(options.desktopReport)) {
    throw new Error("--mobile-report and --desktop-report must be supplied together");
  }
  return options;
}

function helpText() {
  return `Usage: node scripts/perf.mjs [options]

Runs deterministic mobile and desktop Lighthouse profiles, then enforces:
  mobile performance >= 85; desktop performance >= 95
  LCP <= 2500 ms; TBT <= 200 ms; CLS <= 0.1
  transfer <= 2.5 MiB; requests <= 60

Options:
  --root <directory>           Static root (default: site)
  --url <url>                  Audit an already-running URL
  --chrome-path <file>         Chrome executable
  --output <file>              Budget summary destination
  --artifacts <directory>      Raw Lighthouse report destination
  --mobile-report <file>       Evaluate an existing mobile report
  --desktop-report <file>      Evaluate an existing desktop report
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
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, server };
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runLighthouse(url, profile, chromePath) {
  const [{ default: lighthouse }, { default: puppeteer }] = await Promise.all([
    import("lighthouse"),
    import("puppeteer-core")
  ]);
  const config = profile === "desktop"
    ? (await import("lighthouse/core/config/desktop-config.js")).default
    : undefined;
  const browser = await puppeteer.launch({
    args: [
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run"
    ],
    executablePath: chromePath,
    headless: true
  });

  try {
    const port = Number(new URL(browser.wsEndpoint()).port);
    const result = await lighthouse(url, {
      disableStorageReset: false,
      logLevel: "error",
      maxWaitForLoad: 45_000,
      onlyCategories: ["performance"],
      output: "json",
      port
    }, config);
    if (!result?.lhr) throw new Error(`Lighthouse did not return an ${profile} report`);
    return result.lhr;
  } finally {
    await browser.close();
  }
}

function formatFailure(profile, failure) {
  if ("minimum" in failure) return `${profile} ${failure.metric}: ${failure.actual} < minimum ${failure.minimum}`;
  return `${profile} ${failure.metric}: ${failure.actual} > maximum ${failure.maximum}`;
}

async function writeJson(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function updateMirrorReport(root, summary) {
  const destination = path.join(root, "mirror-report.json");
  if (!(await exists(destination))) return;

  let report;
  try {
    report = JSON.parse(await readFile(destination, "utf8"));
  } catch {
    return;
  }

  report.performanceBudgetResults = {
    budgets: summary.budgets,
    checkedAt: summary.generatedAt,
    passed: summary.passed,
    profiles: summary.profiles
  };
  const payload = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await Promise.all([
    writeFile(destination, payload),
    brotli(payload, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11
      }
    }).then((value) => writeFile(`${destination}.br`, value)),
    gzipBuffer(payload, { level: 9, mtime: 0 }).then((value) => writeFile(`${destination}.gz`, value))
  ]);
}

async function main() {
  let localServer;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(helpText());
      return;
    }

    let reports;
    if (options.mobileReport) {
      reports = {
        desktop: JSON.parse(await readFile(options.desktopReport, "utf8")),
        mobile: JSON.parse(await readFile(options.mobileReport, "utf8"))
      };
    } else {
      if (!(await exists(options.chromePath))) throw new Error(`Chrome executable not found: ${options.chromePath}`);
      let url = options.url;
      if (!url) {
        const rootInfo = await stat(options.root);
        if (!rootInfo.isDirectory()) throw new Error(`Static root is not a directory: ${options.root}`);
        localServer = await listen(options.root);
        url = `${localServer.origin}/`;
      }
      await mkdir(options.artifacts, { recursive: true });
      reports = {};
      for (const profile of ["mobile", "desktop"]) {
        console.log(`Running Lighthouse ${profile} profile…`);
        reports[profile] = await runLighthouse(url, profile, options.chromePath);
        await writeJson(path.join(options.artifacts, `lighthouse-${profile}.json`), reports[profile]);
      }
    }

    const profiles = ["mobile", "desktop"].map((profile) => (
      evaluateLighthouseReport(reports[profile], profile, DEFAULT_BUDGETS)
    ));
    const summary = {
      budgets: DEFAULT_BUDGETS,
      generatedAt: new Date().toISOString(),
      passed: profiles.every((profile) => profile.passed),
      profiles
    };
    await writeJson(options.output, summary);
    await updateMirrorReport(options.root, summary);

    for (const profile of profiles) {
      const metrics = profile.metrics;
      console.log(
        `${profile.profile}: score ${metrics.performance.toFixed(0)}, LCP ${metrics.lcp.toFixed(0)} ms, ` +
        `TBT ${metrics.tbt.toFixed(0)} ms, CLS ${metrics.cls.toFixed(3)}, ` +
        `${(metrics.bytes / 1024 / 1024).toFixed(2)} MiB, ${metrics.requests} requests`
      );
      for (const failure of profile.failures) console.error(formatFailure(profile.profile, failure));
    }
    console.log(`Performance report: ${options.output}`);
    if (!summary.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Performance audit could not run: ${error.message}`);
    process.exitCode = 2;
  } finally {
    await close(localServer?.server);
  }
}

await main();
