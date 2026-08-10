import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";

const projectRoot = path.resolve(import.meta.dirname, "..");

let fixtureParent;
let fixtureRoot;
let serverProcess;
let origin;

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function request(pathname, { headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${pathname}`, { headers, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request("/");
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error("Static server did not become ready");
}

before(async () => {
  fixtureParent = await mkdtemp(path.join(os.tmpdir(), "cloner-server-"));
  fixtureRoot = path.join(fixtureParent, "site");
  await mkdir(path.join(fixtureRoot, "assets"), { recursive: true });

  const script = Buffer.from("console.log('compressed asset');\n");
  await writeFile(path.join(fixtureRoot, "index.html"), "<!doctype html><title>Fixture</title>");
  await writeFile(path.join(fixtureRoot, "plain.css"), "body { color: black; }\n");
  await writeFile(path.join(fixtureRoot, "assets", "app.abcdef12.js"), script);
  await writeFile(path.join(fixtureRoot, "assets", "app.abcdef12.js.br"), brotliCompressSync(script));
  await writeFile(path.join(fixtureRoot, "assets", "app.abcdef12.js.gz"), gzipSync(script));
  await writeFile(path.join(fixtureParent, "secret.txt"), "outside root");
  await symlink(path.join(fixtureParent, "secret.txt"), path.join(fixtureRoot, "escape.txt"));

  const port = await reservePort();
  origin = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      STATIC_ROOT: fixtureRoot
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitUntilReady();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  if (fixtureParent) await rm(fixtureParent, { force: true, recursive: true });
});

test("serves Brotli when it is the preferred available representation", async () => {
  const response = await request("/assets/app.abcdef12.js", {
    headers: { "Accept-Encoding": "gzip;q=0.5, br;q=1" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "br");
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(response.headers.vary, /Accept-Encoding/i);
  assert.deepEqual(response.body, brotliCompressSync(Buffer.from("console.log('compressed asset');\n")));
});

test("honors encoding quality values instead of always choosing Brotli", async () => {
  const response = await request("/assets/app.abcdef12.js", {
    headers: { "Accept-Encoding": "br;q=0.4, gzip;q=0.9" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
});

test("returns an encoding-specific ETag and answers a matching validator with 304", async () => {
  const first = await request("/assets/app.abcdef12.js", {
    headers: { "Accept-Encoding": "br" }
  });
  assert.ok(first.headers.etag);

  const cached = await request("/assets/app.abcdef12.js", {
    headers: {
      "Accept-Encoding": "br",
      "If-None-Match": first.headers.etag
    }
  });

  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);
  assert.equal(cached.headers["content-encoding"], "br");
});

test("uses immutable caching only for fingerprinted assets", async () => {
  const asset = await request("/assets/app.abcdef12.js");
  const html = await request("/");
  const plain = await request("/plain.css");

  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(html.headers["cache-control"], "no-cache");
  assert.equal(plain.headers["cache-control"], "public, max-age=3600");
});

test("HEAD sends GET metadata without a response body", async () => {
  const get = await request("/assets/app.abcdef12.js", {
    headers: { "Accept-Encoding": "gzip" }
  });
  const head = await request("/assets/app.abcdef12.js", {
    headers: { "Accept-Encoding": "gzip" },
    method: "HEAD"
  });

  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], get.headers["content-length"]);
  assert.equal(head.headers.etag, get.headers.etag);
  assert.equal(head.headers["content-encoding"], "gzip");
});

test("rejects unsupported methods with an Allow header", async () => {
  const response = await request("/", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET, HEAD");
});

test("does not serve a symlink whose target is outside the static root", async () => {
  const response = await request("/escape.txt");
  assert.equal(response.status, 404);
});

test("handles malformed URL encoding as a client error", async () => {
  const response = await request("/%E0%A4%A");
  assert.equal(response.status, 400);
});

test("recognizes AVIF media", async () => {
  await writeFile(path.join(fixtureRoot, "sample.avif"), "avif fixture");
  const response = await request("/sample.avif");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "image/avif");
});
