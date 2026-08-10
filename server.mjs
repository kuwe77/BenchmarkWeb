import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("./site/", import.meta.url));

const contentTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8"
};

function isInsideRoot(root, candidate) {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function parseAcceptEncoding(header = "") {
  const quality = new Map();

  for (const item of header.split(",")) {
    const [rawName, ...parameters] = item.trim().toLowerCase().split(";");
    if (!rawName) continue;
    let q = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter);
      if (match) q = Number(match[1]);
    }
    quality.set(rawName === "x-gzip" ? "gzip" : rawName, q);
  }

  return {
    quality(name) {
      if (quality.has(name)) return quality.get(name);
      if (quality.has("*")) return quality.get("*");
      return name === "identity" ? 1 : 0;
    }
  };
}

function createEtag(info, encoding) {
  const size = info.size.toString(16);
  const modified = Math.floor(info.mtimeMs).toString(16);
  return `W/"${size}-${modified}-${encoding}"`;
}

function cacheControlFor(pathname) {
  if (extname(pathname).toLowerCase() === ".html") return "no-cache";
  if (/(?:^|[._-])[a-f0-9]{8,64}(?=[._-]|$)/i.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function validatorMatches(header, etag) {
  if (!header) return false;
  return header.split(",").some((value) => value.trim() === "*" || value.trim() === etag);
}

function sendText(response, status, body, headers = {}) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    "Content-Length": payload.length,
    "Content-Type": "text/plain; charset=utf-8",
    ...headers
  });
  response.end(payload);
}

async function resolveFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }

  if (decoded.includes("\0")) return { error: 400 };

  const candidate = resolve(root, decoded.replace(/^\/+/, ""));
  if (!isInsideRoot(root, candidate)) return { error: 404 };

  try {
    let actualPath = await realpath(candidate);
    if (!isInsideRoot(root, actualPath)) return { error: 404 };

    let info = await stat(actualPath);
    if (info.isDirectory()) {
      actualPath = await realpath(join(actualPath, "index.html"));
      if (!isInsideRoot(root, actualPath)) return { error: 404 };
      info = await stat(actualPath);
    }

    if (!info.isFile()) return { error: 404 };
    return { info, path: actualPath };
  } catch {
    return { error: 404 };
  }
}

async function availableRepresentation(root, original, acceptEncoding) {
  const accepted = parseAcceptEncoding(acceptEncoding);
  const candidates = [
    { encoding: "br", path: `${original.path}.br`, q: accepted.quality("br"), rank: 2 },
    { encoding: "gzip", path: `${original.path}.gz`, q: accepted.quality("gzip"), rank: 1 }
  ].filter(({ q }) => q > 0);

  const available = [];
  for (const candidate of candidates) {
    try {
      const actualPath = await realpath(candidate.path);
      if (!isInsideRoot(root, actualPath)) continue;
      const info = await stat(actualPath);
      if (info.isFile()) available.push({ ...candidate, info, path: actualPath });
    } catch {
      // Missing precompressed siblings are expected.
    }
  }

  available.sort((left, right) => right.q - left.q || right.rank - left.rank);
  if (available.length > 0) return available[0];
  if (accepted.quality("identity") <= 0) return null;
  return { encoding: "identity", info: original.info, path: original.path };
}

export function createStaticServer({ rootDirectory = defaultRoot } = {}) {
  const configuredRoot = resolve(rootDirectory);
  const canonicalRoot = realpath(configuredRoot);

  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
        return;
      }

      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname.startsWith("/wp-json/") || url.pathname.startsWith("/wp-admin/")) {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }

      const root = await canonicalRoot;
      const original = await resolveFile(root, url.pathname);
      if (original.error) {
        sendText(response, original.error, original.error === 400 ? "Bad request" : "Not found");
        return;
      }

      const selected = await availableRepresentation(root, original, request.headers["accept-encoding"]);
      if (!selected) {
        sendText(response, 406, "No acceptable representation", { Vary: "Accept-Encoding" });
        return;
      }

      const etag = createEtag(selected.info, selected.encoding);
      const headers = {
        "Cache-Control": cacheControlFor(original.path),
        "Content-Type": contentTypes[extname(original.path).toLowerCase()] || "application/octet-stream",
        ETag: etag,
        "Last-Modified": selected.info.mtime.toUTCString(),
        Vary: "Accept-Encoding"
      };
      if (selected.encoding !== "identity") headers["Content-Encoding"] = selected.encoding;

      if (validatorMatches(request.headers["if-none-match"], etag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }

      headers["Content-Length"] = selected.info.size;
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const stream = createReadStream(selected.path);
      stream.once("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      if (!response.headersSent) sendText(response, 500, "Internal server error");
      else response.destroy(error);
    }
  });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  const rootDirectory = process.env.SITE_ROOT || process.env.STATIC_ROOT || defaultRoot;
  const server = createStaticServer({ rootDirectory });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`OneMilligram clone: http://${host}:${actualPort}`);
  });
}
