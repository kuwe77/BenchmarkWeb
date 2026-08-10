import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const REMOTE_SCHEMES = /^(?:https?:)?\/\//i;
const IGNORED_SCHEMES = /^(?:about:|blob:|data:|javascript:|mailto:|tel:)/i;
const LEGACY_RUNTIME = /(?:^|[\/_\-.])(?:avista-core|bootstrap(?:\.min)?|elementor(?:-frontend)?|jquery-migrate|odometer(?:\.min)?|pixi(?:\.min)?|splittext|swiper(?:\.min)?|woocommerce|wow(?:\.min)?)(?=[\/_\-.]|$)/i;

async function walkFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }

  await visit(root);
  return files;
}

function attributesFrom(source) {
  const attributes = new Map();
  const pattern = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = pattern.exec(source))) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function splitSrcset(value) {
  return value.split(",").map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

function cssReferences(source) {
  const references = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)/gi;
  let match;
  while ((match = pattern.exec(source))) references.push(match[1] ?? match[2] ?? match[3]);

  const imports = /@import\s+(?!url\()["']([^"']+)["']/gi;
  while ((match = imports.exec(source))) references.push(match[1]);
  return references;
}

function htmlResources(source) {
  const resources = [];
  const images = [];
  const tagPattern = /<([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
  let match;

  while ((match = tagPattern.exec(source))) {
    const tag = match[1].toLowerCase();
    const attributes = attributesFrom(match[2]);
    const add = (attribute, type = `${tag}[${attribute}]`) => {
      const value = attributes.get(attribute);
      if (value) resources.push({ type, value });
    };
    const addSrcset = (attribute = "srcset") => {
      const value = attributes.get(attribute);
      if (value) {
        for (const candidate of splitSrcset(value)) resources.push({ type: `${tag}[${attribute}]`, value: candidate });
      }
    };

    if (tag === "script") add("src");
    if (tag === "img") {
      add("src");
      addSrcset();
      images.push(attributes);
    }
    if (tag === "source") {
      add("src");
      addSrcset();
    }
    if (tag === "video") {
      add("src");
      add("poster");
    }
    if (["audio", "embed", "iframe", "track"].includes(tag)) add("src");
    if (tag === "object") add("data");
    if (tag === "input" && attributes.get("type")?.toLowerCase() === "image") add("src");
    if (tag === "form") {
      const action = attributes.get("action");
      if (action && REMOTE_SCHEMES.test(action)) resources.push({ remoteOnly: true, type: "form[action]", value: action });
    }
    if (tag === "link") {
      const rel = (attributes.get("rel") || "").toLowerCase().split(/\s+/);
      if (rel.some((value) => [
        "apple-touch-icon", "dns-prefetch", "icon", "manifest", "modulepreload", "preconnect", "prefetch", "preload", "stylesheet"
      ].includes(value))) add("href", rel.includes("stylesheet") ? "link[stylesheet]" : "link[href]");
    }

    for (const attribute of ["data-bg", "data-background", "data-lazy-src", "data-src", "data-srcset"]) {
      if (attribute.endsWith("srcset")) addSrcset(attribute);
      else add(attribute);
    }

    const inlineStyle = attributes.get("style");
    if (inlineStyle) {
      for (const value of cssReferences(inlineStyle)) resources.push({ type: `${tag}[style]`, value });
    }
  }

  return { images, resources };
}

function classifyReference(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || IGNORED_SCHEMES.test(trimmed)) return "ignored";
  if (REMOTE_SCHEMES.test(trimmed)) return "remote";
  return "local";
}

function resolveLocalReference(root, sourceFile, value) {
  let decoded;
  try {
    const withoutQuery = value.split(/[?#]/, 1)[0];
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }

  const destination = decoded.startsWith("/")
    ? path.resolve(root, decoded.replace(/^\/+/, ""))
    : path.resolve(path.dirname(sourceFile), decoded);
  const offset = path.relative(root, destination);
  if (offset.startsWith("..") || path.isAbsolute(offset)) return null;
  return destination;
}

function issue(code, source, message) {
  return { code, detail: `${source}: ${message}` };
}

export async function inspectStaticSite(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const files = await walkFiles(root);
  const errors = [];
  let htmlFiles = 0;
  let localReferences = 0;
  let remoteReferences = 0;

  async function inspectReference(sourceFile, sourceName, reference) {
    const classification = classifyReference(reference.value);
    if (classification === "ignored") return;

    if (classification === "remote") {
      remoteReferences += 1;
      errors.push(issue("remote-resource", sourceName, `${reference.type} loads ${reference.value}`));
      return;
    }

    if (reference.remoteOnly) return;
    localReferences += 1;
    const loadsExecutableRuntime = reference.type === "script[src]" || reference.type === "link[stylesheet]";
    if (loadsExecutableRuntime && LEGACY_RUNTIME.test(reference.value)) {
      errors.push(issue("legacy-runtime", sourceName, `${reference.type} loads forbidden dependency ${reference.value}`));
    }

    const destination = resolveLocalReference(root, sourceFile, reference.value);
    if (!destination) {
      errors.push(issue("unsafe-local-reference", sourceName, `${reference.type} points outside the site root: ${reference.value}`));
      return;
    }

    try {
      const info = await stat(destination);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      errors.push(issue("missing-local-asset", sourceName, `${reference.type} cannot resolve ${reference.value}`));
    }
  }

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (extension !== ".html" && extension !== ".css") continue;
    const sourceName = path.relative(root, file) || path.basename(file);
    const source = await readFile(file, "utf8");

    if (extension === ".css") {
      for (const value of cssReferences(source)) {
        await inspectReference(file, sourceName, { type: "css url", value });
      }
      continue;
    }

    htmlFiles += 1;
    if (!/^\s*<!doctype\s+html>/i.test(source)) errors.push(issue("html-doctype", sourceName, "missing HTML doctype"));
    if (!/<html\b/i.test(source) || !/<head\b/i.test(source) || !/<body\b/i.test(source)) {
      errors.push(issue("html-structure", sourceName, "must contain html, head, and body elements"));
    }
    if (!/<title\b[^>]*>[^<]+<\/title>/i.test(source)) errors.push(issue("html-title", sourceName, "missing a non-empty title"));
    if (!/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.test(source)) {
      errors.push(issue("html-viewport", sourceName, "missing the viewport meta element"));
    }

    const { images, resources } = htmlResources(source);
    for (const attributes of images) {
      const width = attributes.get("width");
      const height = attributes.get("height");
      if (!/^\d+$/.test(width || "") || !/^\d+$/.test(height || "")) {
        errors.push(issue("image-dimensions", sourceName, `img ${attributes.get("src") || "(inline)"} needs numeric width and height`));
      }
    }
    for (const reference of resources) await inspectReference(file, sourceName, reference);
  }

  if (htmlFiles === 0) errors.push(issue("html-missing", path.basename(root), "no HTML documents found"));

  return {
    errors,
    files: files.length,
    htmlFiles,
    localReferences,
    remoteReferences
  };
}
