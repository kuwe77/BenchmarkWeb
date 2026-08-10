import { createHash } from "node:crypto";
import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import subsetFont from "subset-font";
import { PurgeCSS } from "purgecss";
import { transform as transformCss } from "lightningcss";

const brotli = promisify(brotliCompress);
const gzipBuffer = promisify(gzip);

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const mirrorCacheRoot = join(projectRoot, ".cache", "mirror");
export const rawMirrorRoot = join(mirrorCacheRoot, "raw");
export const defaultSiteRoot = join(projectRoot, "site");

const STYLE_IDS_TO_REMOVE = new Set([
  "woocommerce-layout-css",
  "woocommerce-smallscreen-css",
  "woocommerce-general-css",
  "woocommerce-style-css",
  "wc-blocks-style-css",
  "elementor-icons-css",
  "elementor-gf-roboto-css",
  "elementor-gf-robotoslab-css",
  "magnific-popup-css",
  "swiper-min-css",
  "odometer-min.css-css",
  "animate-min-css"
]);

const INLINE_STYLE_IDS_TO_REMOVE = new Set([
  "classic-theme-styles-inline-css",
  "global-styles-inline-css",
  "wp-emoji-styles-inline-css",
  "wp-img-auto-sizes-contain-inline-css",
  "woocommerce-inline-inline-css"
]);

const SCRIPT_IDS_TO_REMOVE = new Set([
  "jquery-core-js",
  "jquery-migrate-js",
  "wc-jquery-blockui-js",
  "wc-add-to-cart-js-extra",
  "wc-add-to-cart-js",
  "wc-js-cookie-js",
  "wp-hooks-js",
  "wp-i18n-js",
  "wp-i18n-js-after",
  "contact-form-7-js-before",
  "woocommerce-js-extra",
  "woocommerce-js",
  "cookieadmin_js-js-extra",
  "cookieadmin_js-js",
  "bootstrap-min-js",
  "swiper-min-js",
  "wow-min-js",
  "odometer-min-js",
  "nice-select-min-js",
  "jquery-marquee-min-js",
  "magnific-popup-min-js",
  "SplitText-min-js",
  "customEase-min-js",
  "appear-js",
  "pixi-min-js",
  "cursor-js",
  "touchspin-js",
  "avista-custom-js",
  "avista-core-js",
  "sourcebuster-js-js",
  "wc-order-attribution-js-extra",
  "wc-order-attribution-js",
  "cookieadmin_pro_js-js-extra",
  "elementor-webpack-runtime-js",
  "elementor-frontend-modules-js",
  "jquery-ui-core-js",
  "elementor-frontend-js-before",
  "elementor-frontend-js",
  "elh-element-helper-js",
  "wp-emoji-settings"
]);

const SCRIPT_IDS_TO_KEEP = new Set([
  "lenis-min-js",
  "gsap-min-js",
  "scrollTrigger-min-js"
]);

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
  ".txt",
  ".xml"
]);

const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg", ".xml"]);
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const HASHED_ASSET_PATTERN = /\.[a-f0-9]{12}\.[a-z0-9]+$/i;
const DYNAMIC_CLASS_SAFELIST = [
  /^(?:active|show|shown|open|opened|loaded|loading|animated|is_active|is-active|current|sticky|visible|playing|collapsed|disabled|selected|focus|dwn)$/,
  /^(?:omg-|lenis)/,
  /^-(?:visible|active|pointer|normal|inverse|text|opaque|lg|hidden)$/
];

function sha256(value, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  if (await exists(root)) await visit(root);
  return files.sort();
}

async function directoryStats(root, { includeCompressed = false } = {}) {
  let bytes = 0;
  let files = 0;

  for (const path of await listFiles(root)) {
    if (!includeCompressed && /\.(?:br|gz)$/i.test(path)) continue;
    if (/\/(?:asset-manifest|mirror-report)\.json$/i.test(path)) continue;
    const info = await stat(path);
    bytes += info.size;
    files += 1;
  }

  return { bytes, files };
}

function publicPathToFile(root, publicPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(publicPath, "https://clone.invalid").pathname);
  } catch {
    return null;
  }

  const path = resolve(root, `.${pathname}`);
  const safeRoot = `${resolve(root)}${sep}`;
  return path.startsWith(safeRoot) ? path : null;
}

function fileToPublicPath(root, path) {
  return `/${relative(root, path).split(sep).join("/")}`;
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : null;
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function setAttribute(tag, name, value) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\s${escaped}(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?`, "i");
  const attribute = ` ${name}=\"${escapeAttribute(value)}\"`;
  if (pattern.test(tag)) return tag.replace(pattern, attribute);
  return tag.replace(/\s*\/?>(?=$)/, (ending) => `${attribute}${ending}`);
}

function applyInlineStyle(html, { attribute, property, target, value }) {
  if (!value) return html;
  return html.replace(/<[a-z][^>]*>/gi, (tag) => {
    const current = getAttribute(tag, attribute);
    const matches = attribute === "class"
      ? (current || "").split(/\s+/).includes(target)
      : current === target;
    if (!matches) return tag;
    const style = (getAttribute(tag, "style") || "").trim();
    const separator = style && !style.endsWith(";") ? ";" : "";
    return setAttribute(tag, "style", `${style}${separator}${property}:${value};`);
  });
}

function removeElementById(html, tagName, ids) {
  const expression = new RegExp(`<${tagName}\\b(?=[^>]*\\bid=[\"']([^\"']+)[\"'])[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  return html.replace(expression, (tag, id) => (ids.has(id) ? "" : tag));
}

function stripQuery(value) {
  return value.split("#")[0].split("?")[0];
}

function normalizeCssUrl(raw, stylesheetHref) {
  const value = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!value || /^(?:data:|blob:|#|https?:|\/\/)/i.test(value)) return value;
  const base = new URL(stripQuery(stylesheetHref), "https://clone.invalid");
  return new URL(value, base).pathname;
}

function rewriteCssUrls(css, stylesheetHref) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, _quote, value) => {
      const normalized = normalizeCssUrl(value, stylesheetHref);
      return `url(\"${normalized}\")`;
    })
    .replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//gi, "")
    .replace(/\/\/#\s*sourceMappingURL=.*$/gim, "");
}

function preferWoff2FontSources(css) {
  return css.replace(/@font-face\s*\{([\s\S]*?)\}/gi, (face, body) => {
    const woff2 = [...body.matchAll(/url\(\s*["']?([^"')]+\.woff2(?:\?[^"')]+)?)["']?\s*\)(?:\s*format\(\s*["']?woff2["']?\s*\))?/gi)].at(-1);
    if (!woff2) return face;
    const withoutSources = body.replace(/\bsrc\s*:[^;}]+(?:;|$)/gi, "");
    const separator = withoutSources.trimEnd().endsWith(";") ? "" : ";";
    return `@font-face{${withoutSources}${separator}src:url(\"${woff2[1]}\") format(\"woff2\");}`;
  });
}

function stripUnavailableCssUrls(css, unavailablePaths) {
  let output = css;
  for (const publicPath of unavailablePaths) {
    const escaped = publicPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(
      new RegExp(`[a-z-]+\\s*:[^;{}]*url\\(\\s*[\"']?${escaped}(?:\\?[^\"')]+)?[\"']?\\s*\\)[^;{}]*;?`, "gi"),
      ""
    );
  }
  return output;
}

export function materializeCookiePolicy(html) {
  const match = html.match(/var\s+cookieadmin_policy\s*=\s*(\{[\s\S]*?\});\s*(?:\/\/# sourceURL[^<]*)?<\/script>/i);
  if (!match) return { html, policy: null };

  let policy;
  try {
    const source = JSON.parse(match[1]);
    policy = {
      acceptLabel: source.cookieadmin_accept_btn,
      customizeLabel: source.cookieadmin_customize_btn,
      language: source.lang,
      layout: source.cookieadmin_layout || "box",
      modal: source.cookieadmin_modal || "center",
      notice: source.cookieadmin_notice,
      noticeTitle: source.cookieadmin_notice_title,
      position: source.cookieadmin_position || "bottom_left",
      preference: source.cookieadmin_preference,
      preferenceTitle: source.cookieadmin_preference_title,
      rejectLabel: source.cookieadmin_reject_btn,
      saveLabel: source.cookieadmin_save_btn,
      styles: {
        acceptBackground: source.cookieadmin_accept_btn_bg_color,
        acceptColor: source.cookieadmin_accept_btn_color,
        consentBackground: source.cookieadmin_consent_inside_bg_color,
        consentBorder: source.cookieadmin_consent_inside_border_color,
        customizeBackground: source.cookieadmin_customize_btn_bg_color,
        customizeColor: source.cookieadmin_customize_btn_color,
        detailsColor: source.cookieadmin_details_wrapper_color,
        modalBackground: source.cookieadmin_cookie_modal_bg_color,
        modalBorder: source.cookieadmin_cookie_modal_border_color,
        noticeColor: source.cookieadmin_notice_color,
        noticeTitleColor: source.cookieadmin_notice_title_color,
        preferenceTitleColor: source.cookieadmin_preference_title_color,
        rejectBackground: source.cookieadmin_reject_btn_bg_color,
        rejectColor: source.cookieadmin_reject_btn_color,
        saveBackground: source.cookieadmin_save_btn_bg_color,
        saveColor: source.cookieadmin_save_btn_color,
        sliderOffBackground: source.cookieadmin_slider_off_bg_color,
        sliderOnBackground: source.cookieadmin_slider_on_bg_color,
        linksColor: source.cookieadmin_links_color
      }
    };
  } catch {
    return { html, policy: null };
  }

  html = html
    .replace(/(<p\b[^>]*id=["']cookieadmin_notice_title["'][^>]*>)[\s\S]*?(<\/p>)/i, `$1${policy.noticeTitle || ""}$2`)
    .replace(/(<p\b[^>]*id=["']cookieadmin_notice["'][^>]*>)[\s\S]*?(<\/p>)/i, `$1${policy.notice || ""}$2`);
  html = html.replace(/<div\b[^>]*class=["'][^"']*\bcookieadmin_law_container\b[^"']*["'][^>]*>/i, (tag) => {
    const classes = new Set((getAttribute(tag, "class") || "").split(/\s+/).filter(Boolean));
    classes.add(`cookieadmin_${policy.layout}`);
    for (const value of policy.position.split("_").filter(Boolean)) classes.add(`cookieadmin_${value}`);
    classes.add("omg-cookie-pending");
    return setAttribute(tag, "class", [...classes].join(" "));
  });
  html = html.replace(/<div\b[^>]*class=["'][^"']*\bcookieadmin_cookie_modal\b[^"']*["'][^>]*>/i, (tag) => {
    const classes = new Set((getAttribute(tag, "class") || "").split(/\s+/).filter(Boolean));
    classes.add(`cookieadmin_${policy.modal}`);
    return setAttribute(tag, "class", [...classes].join(" "));
  });
  const styleRules = [
    // The upstream cookie markup is nested in a <strong>. The optimized page
    // hoists fixed overlays to <body>, so retain the inherited visual weight.
    ["class", "cookieadmin_law_container", "font-weight", "700"],
    ["class", "cookieadmin_cookie_modal", "font-weight", "700"],
    ["id", "cookieadmin_notice_title", "color", policy.styles.noticeTitleColor],
    ["id", "cookieadmin_notice", "color", policy.styles.noticeColor],
    ["class", "cookieadmin_consent_inside", "background-color", policy.styles.consentBackground],
    ["class", "cookieadmin_consent_inside", "border-color", policy.styles.consentBorder],
    ["id", "cookieadmin_preference_title", "color", policy.styles.preferenceTitleColor],
    ["class", "cookieadmin_details_wrapper", "color", policy.styles.detailsColor],
    ["class", "cookieadmin_cookie_modal", "background-color", policy.styles.modalBackground],
    ["class", "cookieadmin_cookie_modal", "border-color", policy.styles.modalBorder],
    ["class", "cookieadmin_customize_btn", "color", policy.styles.customizeColor],
    ["class", "cookieadmin_customize_btn", "background-color", policy.styles.customizeBackground],
    ["class", "cookieadmin_reject_btn", "color", policy.styles.rejectColor],
    ["class", "cookieadmin_reject_btn", "background-color", policy.styles.rejectBackground],
    ["class", "cookieadmin_accept_btn", "color", policy.styles.acceptColor],
    ["class", "cookieadmin_accept_btn", "background-color", policy.styles.acceptBackground],
    ["class", "cookieadmin_save_btn", "color", policy.styles.saveColor],
    ["class", "cookieadmin_save_btn", "background-color", policy.styles.saveBackground],
    ["class", "cookieadmin_slider", "background-color", policy.styles.sliderOffBackground],
    ["class", "cookieadmin_remark", "color", policy.styles.linksColor],
    ["class", "cookieadmin_showmore", "color", policy.styles.linksColor]
  ];
  for (const [attribute, target, property, value] of styleRules) {
    html = applyInlineStyle(html, { attribute, property, target, value });
  }
  const data = `<script type="application/json" id="clone-cookie-policy">${JSON.stringify(policy).replaceAll("<", "\\u003c")}</script>`;
  html = html.replace(/<\/body>/i, `${data}\n</body>`);
  return { html, policy };
}

export function hoistElementByClass(html, className) {
  const openingPattern = /<div\b[^>]*>/gi;
  let opening = null;
  for (let candidate = openingPattern.exec(html); candidate; candidate = openingPattern.exec(html)) {
    const classes = (getAttribute(candidate[0], "class") || "").split(/\s+/);
    if (classes.includes(className)) {
      opening = candidate;
      break;
    }
  }
  if (!opening) return html;

  const tokenPattern = /<(\/?)div\b[^>]*>/gi;
  tokenPattern.lastIndex = opening.index;
  let depth = 0;
  let end = -1;
  for (let token = tokenPattern.exec(html); token; token = tokenPattern.exec(html)) {
    if (token[1]) depth -= 1;
    else if (!/\/\s*>$/.test(token[0])) depth += 1;
    if (depth === 0) {
      end = tokenPattern.lastIndex;
      break;
    }
  }
  if (end < 0) return html;

  const element = html.slice(opening.index, end);
  const withoutElement = `${html.slice(0, opening.index)}${html.slice(end)}`;
  return withoutElement.replace(/<body\b[^>]*>/i, (body) => `${body}\n${element}`);
}

export function preSplitHeroTitle(html) {
  return html.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (element, attributes, inner) => {
    const opening = `<h2${attributes}>`;
    const classes = (getAttribute(opening, "class") || "").split(/\s+/);
    if (!classes.includes("hero-title") || getAttribute(opening, "data-omg-split") === "true") return element;

    const label = inner
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const splitInner = inner.replace(/(^|>)([^<]+)(?=<|$)/g, (_match, prefix, text) => {
      const splitText = text.split(/(\s+)/).map((part) => {
        if (!part || /^\s+$/.test(part)) return part;
        const characters = Array.from(part, (character) => `<span class="omg-char">${character}</span>`).join("");
        return `<span class="omg-word" aria-hidden="true">${characters}</span>`;
      }).join("");
      return `${prefix}${splitText}`;
    });

    let nextOpening = setAttribute(opening, "data-omg-split", "true");
    if (label && !getAttribute(nextOpening, "aria-label")) nextOpening = setAttribute(nextOpening, "aria-label", label);
    return `${nextOpening}${splitInner}</h2>`;
  });
}

export function materializeLocalEmoji(html) {
  const phone = '<img draggable="false" role="img" class="emoji" alt="☎️" src="/external/s.w.org/images/core/emoji/17.0.2/svg/260e.svg">';
  return html.replaceAll("☎️", phone);
}

function stripRemoteResourceHints(html) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (getAttribute(tag, "rel") || "").toLowerCase().split(/\s+/);
    const href = getAttribute(tag, "href") || "";
    const isRemoteHint = rel.some((value) => value === "dns-prefetch" || value === "preconnect")
      && /^(?:https?:)?\/\//i.test(href);
    return isRemoteHint ? "" : tag;
  });
}

function extractVisibleText(html) {
  const attributes = [...html.matchAll(/\b(?:alt|aria-label|placeholder|title|value)=["']([^"']*)["']/gi)]
    .map((match) => match[1])
    .join(" ");
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x?[a-f0-9]+);/gi, (_match, code) => {
      const radix = code[0].toLowerCase() === "x" ? 16 : 10;
      const value = Number.parseInt(radix === 16 ? code.slice(1) : code, radix);
      return Number.isFinite(value) ? String.fromCodePoint(value) : " ";
    })
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (_match, entity) => ({
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"'
    })[entity.toLowerCase()] ?? " ");

  return `${text} ${attributes} Thanks. This local clone keeps submissions on your device. Accept All Reject All Customize 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz !\"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;
}

function parseFontFaceBody(body) {
  const read = (property) => body.match(new RegExp(`${property}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim() ?? "";
  const family = read("font-family").replace(/^['"]|['"]$/g, "");
  const source = read("src").match(/url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1] ?? "";
  return {
    body,
    display: read("font-display") || "swap",
    family,
    source,
    stretch: read("font-stretch"),
    style: read("font-style") || "normal",
    unicodeRange: read("unicode-range"),
    weight: read("font-weight") || "normal"
  };
}

function parseFontFaces(css) {
  return [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)].map((match) => parseFontFaceBody(match[1]));
}

function decodeCssString(value) {
  return value
    .replace(/\\([a-f0-9]{1,6})\s?/gi, (_match, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/\\(?:\r\n|\r|\n)/g, "")
    .replace(/\\(.)/gs, "$1");
}

function isPrivateUseCodePoint(codePoint) {
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd);
}

export function collectCssContentGlyphs(css) {
  const codePoints = new Set();
  for (const match of css.matchAll(/\bcontent\s*:\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/gi)) {
    for (const character of decodeCssString(match[2])) {
      const codePoint = character.codePointAt(0);
      if (isPrivateUseCodePoint(codePoint)) codePoints.add(codePoint);
    }
  }

  const sorted = [...codePoints].sort((left, right) => left - right);
  return {
    characters: String.fromCodePoint(...sorted),
    codePoints: sorted
  };
}

async function subsetTextFonts(css, outputRoot, html) {
  const glyphs = extractVisibleText(html);
  const selected = new Map();
  let criticalCss = "";
  let heroInlineBytes = 0;

  for (const face of parseFontFaces(css)) {
    if (!new Set(["Inter", "Geist Mono"]).has(face.family)) continue;
    if (!/U\+0000-00FF/i.test(face.unicodeRange)) continue;
    selected.set(`${face.family}:${face.style}`, face);
  }

  const cssFaces = [];
  const preloads = [];
  const details = [];

  for (const face of [...selected.values()].sort((a, b) => `${a.family}:${a.style}`.localeCompare(`${b.family}:${b.style}`))) {
    const sourcePath = publicPathToFile(outputRoot, face.source);
    if (!sourcePath || !(await exists(sourcePath))) {
      throw new Error(`Cannot subset missing font ${face.source}`);
    }

    const input = await readFile(sourcePath);
    const output = Buffer.from(await subsetFont(input, glyphs, { targetFormat: "woff2" }));
    const stem = `${face.family}-${face.style}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const publicPath = `/assets/fonts/${stem}.${sha256(output)}.woff2`;
    const outputPath = publicPathToFile(outputRoot, publicPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);

    const optionalStretch = face.stretch ? `font-stretch:${face.stretch};` : "";
    cssFaces.push(`@font-face{font-family:\"${face.family}\";font-style:${face.style};font-weight:${face.weight};${optionalStretch}font-display:swap;src:url(\"${publicPath}\") format(\"woff2\");}`);
    if (face.family === "Inter" && face.style === "normal") {
      const criticalGlyphs = "Empty Clinics? No more We respect your privacy Cookies help us improve your experience, deliver personalized content, and analyze traffic. You can choose which cookies to allow by clicking Customize. Click Accept All to consent or Reject All to decline non-essential cookies. Powered by CookieAdmin";
      const heroFont = Buffer.from(await subsetFont(input, criticalGlyphs, { targetFormat: "woff2" }));
      heroInlineBytes = heroFont.length;
      criticalCss = `@font-face{font-family:\"Inter Critical\";font-style:normal;font-weight:100 900;font-display:block;src:url(\"data:font/woff2;base64,${heroFont.toString("base64")}\") format(\"woff2\")} .hero-title,.cookieadmin_law_container,.cookieadmin_law_container *{font-family:\"Inter Critical\",\"Inter\",sans-serif!important}`;
    }
    details.push({
      family: face.family,
      inputBytes: input.length,
      outputBytes: output.length,
      path: publicPath,
      style: face.style,
      weight: face.weight
    });
  }

  if (!cssFaces.length) throw new Error("No local Inter or Geist Mono Latin font faces were found.");
  return { criticalCss, css: cssFaces.join(""), details, heroInlineBytes, preloads };
}

async function subsetIconFonts(css, outputRoot) {
  const glyphs = collectCssContentGlyphs(css);
  const sourceCache = new Map();
  const outputByDigest = new Map();
  const details = [];
  const preloads = new Set();
  const uniqueInputs = new Map();
  const uniqueOutputs = new Map();
  const matches = [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)];
  let cursor = 0;
  let rewritten = "";

  for (const match of matches) {
    rewritten += css.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const face = parseFontFaceBody(match[1]);
    const isTextFace = face.family === "Inter" || face.family === "Geist Mono";
    const isLocalWoff2 = face.source.startsWith("/") && extname(stripQuery(face.source)).toLowerCase() === ".woff2";
    if (isTextFace || !isLocalWoff2 || !glyphs.characters) {
      rewritten += match[0];
      continue;
    }

    const sourcePath = publicPathToFile(outputRoot, face.source);
    if (!sourcePath || !(await exists(sourcePath))) throw new Error(`Cannot subset missing icon font ${face.source}`);
    const sourceKey = `${sourcePath}\0${glyphs.characters}`;
    let subset = sourceCache.get(sourceKey);

    if (!subset) {
      const input = await readFile(sourcePath);
      const output = Buffer.from(await subsetFont(input, glyphs.characters, { targetFormat: "woff2" }));
      const digest = sha256(output);
      let publicPath = outputByDigest.get(digest);
      if (!publicPath) {
        const stem = basename(stripQuery(face.source), ".woff2").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
        publicPath = `/assets/fonts/${stem}-icons.${digest}.woff2`;
        const outputPath = publicPathToFile(outputRoot, publicPath);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, output);
        outputByDigest.set(digest, publicPath);
        uniqueOutputs.set(digest, output.length);
      }
      subset = { inputBytes: input.length, outputBytes: output.length, path: publicPath };
      sourceCache.set(sourceKey, subset);
      uniqueInputs.set(sourcePath, input.length);
    }

    const replacementSource = `src:url(\"${subset.path}\") format(\"woff2\")`;
    const body = match[1].replace(/\bsrc\s*:[^;}]+(?=;|$)/i, replacementSource);
    if (body === match[1]) throw new Error(`Could not rewrite icon font source for ${face.family}.`);
    rewritten += `@font-face{${body}}`;
    details.push({
      family: face.family,
      inputBytes: subset.inputBytes,
      outputBytes: subset.outputBytes,
      path: subset.path,
      source: face.source,
      style: face.style,
      weight: face.weight
    });
  }

  rewritten += css.slice(cursor);
  const inputBytes = [...uniqueInputs.values()].reduce((sum, bytes) => sum + bytes, 0);
  const outputBytes = [...uniqueOutputs.values()].reduce((sum, bytes) => sum + bytes, 0);
  return {
    css: rewritten,
    preloads: [...preloads].filter((path) => {
      const detail = details.find((item) => item.path === path);
      return detail && detail.outputBytes <= 32 * 1024;
    }),
    report: {
      details,
      glyphCodePoints: glyphs.codePoints.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`),
      glyphCount: glyphs.codePoints.length,
      inputBytes,
      outputBytes,
      savingsBytes: inputBytes - outputBytes,
      uniqueInputFonts: uniqueInputs.size,
      uniqueOutputFonts: uniqueOutputs.size
    }
  };
}

function stylesheetTags(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => ({ index: match.index, tag: match[0] }))
    .filter(({ tag }) => (getAttribute(tag, "rel") || "").toLowerCase().split(/\s+/).includes("stylesheet"));
}

async function purgeAndMinifyCss(css, content, { critical = false, rejected = false } = {}) {
  const safelist = critical
    ? [
        /^(?:active|show|shown|open|opened|loaded|loading|animated|is_active|is-active|current|sticky|visible|playing)$/,
        /^(?:lenis|cursor|split|char|word)/
      ]
    : DYNAMIC_CLASS_SAFELIST;
  const [result] = await new PurgeCSS().purge({
    content: [{ extension: "html", raw: content }],
    css: [{ raw: css }],
    defaultExtractor: (value) => value.match(/[A-Za-z0-9_-]+/g) || [],
    fontFace: true,
    keyframes: true,
    rejected,
    safelist: {
      deep: safelist,
      greedy: safelist,
      standard: ["html", "body", "no-js"]
    },
    variables: true
  });

  const transformed = transformCss({
    code: Buffer.from(result.css),
    minify: true,
    sourceMap: false
  });
  return { css: Buffer.from(transformed.code).toString("utf8"), rejected: result.rejected ?? [] };
}

function heroContentForPurge(html) {
  const body = html.indexOf("<body");
  const hero = html.indexOf("as-hero-1-area", Math.max(0, body));
  const sectionEnd = hero >= 0 ? html.indexOf("</section>", hero) : -1;
  return sectionEnd >= 0 ? html.slice(Math.max(0, body), sectionEnd + 10) : html.slice(0, Math.min(html.length, 60000));
}

function criticalContentForPurge(html) {
  const hero = heroContentForPurge(html);
  const cookieStart = html.search(/<div\b[^>]*class=["'][^"']*\bcookieadmin_law_container\b/i);
  if (cookieStart < 0) return hero;
  const scriptAfterCookie = html.indexOf("<script", cookieStart);
  const cookieEnd = scriptAfterCookie >= 0 ? scriptAfterCookie : Math.min(html.length, cookieStart + 60000);
  return `${hero}\n${html.slice(cookieStart, cookieEnd)}`;
}

async function bundleStyles(html, outputRoot, runtimeContent, runtimeCssContent, motionManifestContent, unavailablePaths) {
  const tags = stylesheetTags(html);
  const removed = [];
  const duplicate = [];
  const retained = [];
  const hrefs = new Set();
  let sourceBytes = 0;
  let textFontResult = { criticalCss: "", css: "", details: [], heroInlineBytes: 0, preloads: [] };

  for (const { tag } of tags) {
    const id = getAttribute(tag, "id") || "";
    const href = getAttribute(tag, "href") || "";
    const normalizedHref = stripQuery(href);
    if (STYLE_IDS_TO_REMOVE.has(id)) {
      removed.push({ href, id, reason: "proven-unused" });
      continue;
    }
    if (hrefs.has(normalizedHref)) {
      duplicate.push({ href, id, reason: "duplicate-href" });
      continue;
    }
    hrefs.add(normalizedHref);

    const path = publicPathToFile(outputRoot, href);
    if (!path || !(await exists(path))) throw new Error(`Stylesheet is missing: ${href}`);
    const raw = await readFile(path, "utf8");
    sourceBytes += Buffer.byteLength(raw);
    let css;
    if (id === "avista-fonts-css") {
      textFontResult = await subsetTextFonts(raw, outputRoot, html);
      css = textFontResult.css;
    } else {
      css = rewriteCssUrls(raw, href);
    }
    const media = getAttribute(tag, "media");
    retained.push(media && media !== "all" ? `@media ${media}{${css}}` : css);
  }

  if (runtimeCssContent.trim()) {
    retained.push(rewriteCssUrls(runtimeCssContent, "/clone-runtime.css"));
    sourceBytes += Buffer.byteLength(runtimeCssContent);
  }

  html = removeElementById(html, "style", INLINE_STYLE_IDS_TO_REMOVE);
  // Intrinsic dimensions are injected after CSS bundling. Seed that future
  // marker so PurgeCSS retains the narrow height reset it will require.
  const purgeContent = `${html}\n<img data-clone-dimensions="true"><div id="wa_liquid_img"><picture><img class="hero-main-img"></picture></div>\n${runtimeContent}\n${motionManifestContent}`;
  const combined = stripUnavailableCssUrls(preferWoff2FontSources(retained.join("\n")), unavailablePaths);
  const purged = await purgeAndMinifyCss(combined, purgeContent, { rejected: true });
  let finalCss = purged.css;

  const retainedTextFaceKeys = new Set(
    parseFontFaces(finalCss).map((face) => `${face.family}\0${face.style}\0${face.weight}\0${face.stretch}`)
  );
  for (const face of textFontResult.css.matchAll(/@font-face\{[^}]+\}/g)) {
    const descriptor = parseFontFaceBody(face[0].slice(face[0].indexOf("{") + 1, -1));
    const key = `${descriptor.family}\0${descriptor.style}\0${descriptor.weight}\0${descriptor.stretch}`;
    if (!retainedTextFaceKeys.has(key)) {
      finalCss = `${face[0]}${finalCss}`;
      retainedTextFaceKeys.add(key);
    }
  }

  const iconFontResult = await subsetIconFonts(finalCss, outputRoot);
  finalCss = iconFontResult.css;

  const cssBuffer = Buffer.from(finalCss);
  const cssPublicPath = `/assets/styles/site.${sha256(cssBuffer)}.css`;
  const cssPath = publicPathToFile(outputRoot, cssPublicPath);
  await mkdir(dirname(cssPath), { recursive: true });
  await writeFile(cssPath, cssBuffer);

  const critical = await purgeAndMinifyCss(finalCss, `${criticalContentForPurge(html)}\n${runtimeContent}`, { critical: true });
  const criticalWithoutDeferredFonts = critical.css.replace(/@font-face\s*\{[^}]*\}/gi, "");
  const criticalCss = `${textFontResult.criticalCss}${criticalWithoutDeferredFonts}`;
  const styleMarkup = [
    `<style id="clone-critical-css">${criticalCss}</style>`,
    `<link rel="stylesheet" id="clone-site-css" href="${cssPublicPath}" media="print">`,
    `<noscript><link rel="stylesheet" href="${cssPublicPath}"></noscript>`
  ].join("\n");

  let inserted = false;
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const isStylesheet = (getAttribute(tag, "rel") || "").toLowerCase().split(/\s+/).includes("stylesheet");
    if (!isStylesheet) return tag;
    if (!inserted) {
      inserted = true;
      return styleMarkup;
    }
    return "";
  });
  if (!inserted) html = html.replace(/<\/head>/i, `${styleMarkup}\n</head>`);

  return {
    html,
    preloads: [...textFontResult.preloads, ...iconFontResult.preloads],
    report: {
      bundledBytes: cssBuffer.length,
      criticalBytes: Buffer.byteLength(criticalCss),
      duplicates: duplicate,
      inputBytes: sourceBytes,
      iconFonts: iconFontResult.report,
      heroInlineFontBytes: textFontResult.heroInlineBytes,
      rejectedSelectors: purged.rejected.length,
      removed,
      retainedStylesheets: retained.length,
      unavailableAssetDeclarationsRemoved: unavailablePaths,
      textFonts: textFontResult.details
    }
  };
}

function imageSizes(tag, width, isHero) {
  const explicit = getAttribute(tag, "sizes");
  if (explicit) return explicit;
  if (isHero) return "(max-width: 767px) 92vw, (max-width: 1199px) 55vw, (max-width: 1599px) 800px, 46vw";
  return `(max-width: 767px) 100vw, ${Math.min(width, 1200)}px`;
}

async function createImageVariants(sourcePath, outputRoot, metadata) {
  const source = await readFile(sourcePath);
  const originalWidth = metadata.autoOrient?.width ?? metadata.width;
  const desired = [320, 480, 768, 1024, 1440, originalWidth]
    .filter((width) => Number.isFinite(width) && width <= originalWidth)
    .map(Math.round);
  const widths = [...new Set(desired)].sort((a, b) => a - b);
  const stem = basename(sourcePath, extname(sourcePath)).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const variants = { avif: [], webp: [] };
  let outputBytes = 0;

  for (const width of widths) {
    const base = sharp(source, { failOn: "warning" }).rotate().resize({
      fit: "inside",
      height: undefined,
      kernel: sharp.kernel.lanczos3,
      width,
      withoutEnlargement: true
    });
    const outputs = [
      ["avif", await base.clone().avif({ chromaSubsampling: "4:4:4", effort: 5, quality: 55 }).toBuffer()],
      ["webp", await base.clone().webp({ effort: 5, quality: 82, smartSubsample: true }).toBuffer()]
    ];

    for (const [format, buffer] of outputs) {
      const publicPath = `/assets/images/${stem}-${width}.${sha256(buffer)}.${format}`;
      const path = publicPathToFile(outputRoot, publicPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
      variants[format].push({ bytes: buffer.length, path: publicPath, width });
      outputBytes += buffer.length;
    }
  }

  return { inputBytes: source.length, outputBytes, variants };
}

function sourceMarkup(format, variants, sizes) {
  const srcset = variants.map(({ path, width }) => `${path} ${width}w`).join(", ");
  return `<source type="image/${format}" srcset="${srcset}" sizes="${escapeAttribute(sizes)}">`;
}

async function optimizeImages(html, outputRoot) {
  const matches = [...html.matchAll(/<img\b[^>]*>/gi)];
  const cache = new Map();
  const details = [];
  let cursor = 0;
  let output = "";
  let heroPreload = null;
  let pictureCount = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    output += html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    let tag = match[0];
    const src = getAttribute(tag, "src");
    const sourcePath = src ? publicPathToFile(outputRoot, src) : null;
    if (!sourcePath || !(await exists(sourcePath)) || !IMAGE_EXTENSIONS.has(extname(stripQuery(src)).toLowerCase())) {
      output += tag;
      continue;
    }

    let metadata;
    try {
      metadata = await sharp(sourcePath, { animated: true }).metadata();
    } catch {
      output += tag;
      continue;
    }

    const displayedWidth = metadata.autoOrient?.width ?? metadata.width;
    const displayedHeight = metadata.autoOrient?.height ?? metadata.height;
    if (displayedWidth && displayedHeight) {
      tag = setAttribute(tag, "width", displayedWidth);
      tag = setAttribute(tag, "height", displayedHeight);
      tag = setAttribute(tag, "data-clone-dimensions", "true");
    }
    tag = setAttribute(tag, "decoding", "async");

    const isHero = /\bhero-main-img\b/i.test(getAttribute(tag, "class") || "") || /header-image\.png/i.test(src);
    const isAboveFold = index <= 4 || isHero;
    tag = setAttribute(tag, "loading", isAboveFold ? "eager" : "lazy");
    tag = setAttribute(tag, "fetchpriority", isHero ? "high" : "auto");

    const info = await stat(sourcePath);
    const extension = extname(stripQuery(src)).toLowerCase();
    const shouldOptimize = new Set([".jpeg", ".jpg", ".png"]).has(extension)
      && info.size >= 80 * 1024
      && displayedWidth >= 480;
    if (!shouldOptimize) {
      output += tag;
      continue;
    }

    const key = sourcePath;
    if (!cache.has(key)) cache.set(key, await createImageVariants(sourcePath, outputRoot, metadata));
    const optimized = cache.get(key);
    const sizes = imageSizes(tag, displayedWidth, isHero);
    const picture = [
      '<picture data-clone-optimized="true">',
      sourceMarkup("avif", optimized.variants.avif, sizes),
      sourceMarkup("webp", optimized.variants.webp, sizes),
      tag,
      "</picture>"
    ].join("");
    output += picture;
    pictureCount += 1;

    const normalizedSource = stripQuery(src);
    const existingDetail = details.find((item) => item.source === normalizedSource);
    if (existingDetail) {
      existingDetail.usageCount += 1;
    } else {
      details.push({
        height: displayedHeight,
        inputBytes: optimized.inputBytes,
        outputBytes: optimized.outputBytes,
        source: normalizedSource,
        usageCount: 1,
        variants: optimized.variants,
        width: displayedWidth
      });
    }
    if (isHero) {
      const variants = optimized.variants.avif;
      heroPreload = {
        href: variants.at(-1).path,
        imagesizes: sizes,
        imagesrcset: variants.map(({ path, width }) => `${path} ${width}w`).join(", ")
      };
    }
  }

  output += html.slice(cursor);
  if (heroPreload) {
    const preload = `<link rel="preload" as="image" type="image/avif" href="${heroPreload.href}" imagesrcset="${heroPreload.imagesrcset}" imagesizes="${escapeAttribute(heroPreload.imagesizes)}" fetchpriority="high">`;
    output = output.replace(/<\/head>/i, `${preload}\n</head>`);
  }

  return {
    html: output,
    report: {
      backend: `sharp ${sharp.versions.sharp}`,
      generatedBytes: details.reduce((sum, item) => sum + item.outputBytes, 0),
      optimizedOriginalBytes: details.reduce((sum, item) => sum + item.inputBytes, 0),
      pictureCount,
      uniqueSourceCount: details.length,
      sources: details
    }
  };
}

async function fingerprintScript(outputRoot, source) {
  const path = publicPathToFile(outputRoot, source);
  if (!path || !(await exists(path))) throw new Error(`Script is missing: ${source}`);
  const buffer = await readFile(path);
  const stem = basename(stripQuery(source), extname(stripQuery(source))).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const publicPath = `/assets/scripts/${stem}.${sha256(buffer)}.js`;
  const outputPath = publicPathToFile(outputRoot, publicPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  return { bytes: buffer.length, path: publicPath };
}

async function optimizeScripts(html, outputRoot) {
  const matches = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)];
  const removed = [];
  const retained = [];
  const dependencyOrder = [...SCRIPT_IDS_TO_KEEP];
  let cursor = 0;
  let output = "";

  for (const match of matches) {
    output += html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const tag = match[0];
    const opening = tag.slice(0, tag.indexOf(">") + 1);
    const id = getAttribute(opening, "id") || "";
    const src = getAttribute(opening, "src");
    const type = (getAttribute(opening, "type") || "").toLowerCase();

    if (type === "application/ld+json" || (type === "application/json" && id === "clone-cookie-policy")) {
      output += tag;
      continue;
    }

    if (!src) {
      removed.push({ id, reason: id ? "legacy-inline-initializer" : "anonymous-inline-initializer" });
      continue;
    }

    if (/\/clone-runtime(?:\.[a-f0-9]{12})?\.js(?:[?#]|$)/i.test(src)) continue;

    const keep = SCRIPT_IDS_TO_KEEP.has(id);
    if (!keep || SCRIPT_IDS_TO_REMOVE.has(id)) {
      removed.push({ id, reason: "replaced-by-clone-runtime", src });
      continue;
    }

    if (retained.some((script) => script.id === id)) {
      removed.push({ id, reason: "duplicate-retained-script", src });
      continue;
    }

    const fingerprinted = await fingerprintScript(outputRoot, src);
    retained.push({ bytes: fingerprinted.bytes, id: id || "clone-runtime", path: fingerprinted.path });
  }

  retained.sort((left, right) => dependencyOrder.indexOf(left.id) - dependencyOrder.indexOf(right.id));
  const runtime = await fingerprintScript(outputRoot, "/clone-runtime.js");
  retained.push({ bytes: runtime.bytes, id: "clone-runtime", path: runtime.path });

  output += html.slice(cursor);
  if (retained.length) {
    const sources = JSON.stringify(retained.map(({ id, path }) => ({ id, path }))).replaceAll("<", "\\u003c");
    const loader = `<script id="clone-motion-loader">(()=>{const e=${sources};let o=!1,t=null;const n=()=>{if(o)return;o=!0,t&&t.disconnect(),requestAnimationFrame(()=>requestAnimationFrame(()=>{const o=document.getElementById("clone-site-css");o&&(o.media="all",o.dispatchEvent(new Event("clonecssready")));for(const{path:o,id:t}of e){const e=document.createElement("script");e.src=o,e.async=!1,t&&(e.id=t),document.head.append(e)}}))};try{t=new PerformanceObserver(e=>{e.getEntries().length&&n()}),t.observe({type:"largest-contentful-paint",buffered:!0})}catch{}const i=()=>setTimeout(n,1e3);document.readyState==="complete"?i():addEventListener("load",i,{once:!0})})()</script>`;
    output = output.replace(/<\/body>/i, `${loader}\n</body>`);
  }
  return { html: output, report: { removed, retained } };
}

function injectPreloads(html, paths) {
  const tags = [...new Set(paths)].map((path) => `<link rel="preload" href="${path}" as="font" type="font/woff2" crossorigin>`).join("\n");
  return tags ? html.replace(/<\/head>/i, `${tags}\n</head>`) : html;
}

function referencedPublicPaths(text) {
  const references = new Set();
  const expression = /\/(?:assets|external|wp-content|wp-includes)\/[A-Za-z0-9_~!$&'+,.@%/\[\]-]+/g;
  for (const match of text.replaceAll("\\/", "/").matchAll(expression)) {
    references.add(stripQuery(match[0]).replace(/[),;]+$/, ""));
  }
  return references;
}

async function collectReachableFiles(outputRoot) {
  const queue = [join(outputRoot, "index.html")];
  const reachable = new Set();
  const missing = [];

  while (queue.length) {
    const path = queue.shift();
    if (reachable.has(path)) continue;
    reachable.add(path);
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const text = await readFile(path, "utf8");
    for (const publicPath of referencedPublicPaths(text)) {
      const candidate = publicPathToFile(outputRoot, publicPath);
      if (!candidate) continue;
      if (!(await exists(candidate))) {
        missing.push(publicPath);
        continue;
      }
      if (!reachable.has(candidate)) queue.push(candidate);
    }
  }

  return { missing: [...new Set(missing)].sort(), reachable };
}

async function pruneUnreachableFiles(outputRoot) {
  const { missing, reachable } = await collectReachableFiles(outputRoot);
  const alwaysKeep = new Set([
    join(outputRoot, "index.html"),
    join(outputRoot, "motion-manifest.json")
  ]);
  const removed = [];

  for (const path of await listFiles(outputRoot)) {
    if (alwaysKeep.has(path) || reachable.has(path)) continue;
    if (/\/(?:asset-manifest|mirror-report)\.json$/i.test(path)) continue;
    const info = await stat(path);
    removed.push({ bytes: info.size, path: fileToPublicPath(outputRoot, path) });
    await rm(path);
  }

  return { missing, removed };
}

async function compressAssets(outputRoot) {
  const assets = {};
  let brotliFiles = 0;
  let gzipFiles = 0;

  for (const path of await listFiles(outputRoot)) {
    if (/\.(?:br|gz)$/i.test(path)) continue;
    if (/\/(?:asset-manifest|mirror-report)\.json$/i.test(path)) continue;
    const publicPath = fileToPublicPath(outputRoot, path);
    const buffer = await readFile(path);
    const record = {
      bytes: buffer.length,
      immutable: HASHED_ASSET_PATTERN.test(basename(path)),
      sha256: sha256(buffer, 64)
    };

    if (COMPRESSIBLE_EXTENSIONS.has(extname(path).toLowerCase()) && buffer.length >= 1024) {
      const [br, gz] = await Promise.all([
        brotli(buffer, {
          params: {
            [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11
          }
        }),
        gzipBuffer(buffer, { level: 9, mtime: 0 })
      ]);
      if (br.length < buffer.length) {
        await writeFile(`${path}.br`, br);
        record.br = { bytes: br.length, path: `${publicPath}.br` };
        brotliFiles += 1;
      }
      if (gz.length < buffer.length) {
        await writeFile(`${path}.gz`, gz);
        record.gzip = { bytes: gz.length, path: `${publicPath}.gz` };
        gzipFiles += 1;
      }
    }

    assets[publicPath] = record;
  }

  const manifest = { assets, version: 1 };
  await writeFile(join(outputRoot, "asset-manifest.json"), JSON.stringify(manifest, null, 2));
  return { brotliFiles, gzipFiles, manifest };
}

export async function validateOptimizedSite(outputRoot) {
  const indexPath = join(outputRoot, "index.html");
  if (!(await exists(indexPath))) throw new Error("Optimized site has no index.html.");
  const html = await readFile(indexPath, "utf8");
  if (!/<\/html>/i.test(html) || !/<\/body>/i.test(html)) throw new Error("Optimized HTML is incomplete.");

  const motionLoaders = [...html.matchAll(/<script\b(?=[^>]*\bid=["']clone-motion-loader["'])[^>]*>[\s\S]*?<\/script>/gi)];
  const runtimePattern = /\/assets\/scripts\/clone-runtime\.[a-f0-9]{12}\.js\b/gi;
  const runtimeReferences = html.match(runtimePattern) ?? [];
  const loaderRuntimeReferences = motionLoaders.length === 1 ? (motionLoaders[0][0].match(runtimePattern) ?? []) : [];
  if (motionLoaders.length !== 1 || runtimeReferences.length !== 1 || loaderRuntimeReferences.length !== 1) {
    throw new Error("Optimized HTML must include clone-motion-loader with exactly one hashed clone-runtime reference.");
  }

  const scriptCount = (html.match(/<script\b[^>]*\bsrc=/gi) || []).length;
  const stylesheetCount = (html.match(/<link\b[^>]*\brel=["']stylesheet["']/gi) || []).length;
  if (scriptCount > 4) throw new Error(`Expected at most four scripts, found ${scriptCount}.`);
  if (stylesheetCount > 2) throw new Error(`Expected one deferred stylesheet plus noscript fallback, found ${stylesheetCount}.`);

  const forbiddenIds = [...STYLE_IDS_TO_REMOVE, ...SCRIPT_IDS_TO_REMOVE].filter((id) => html.includes(`id=\"${id}\"`) || html.includes(`id='${id}'`));
  if (forbiddenIds.length) throw new Error(`Legacy dependencies remain: ${forbiddenIds.join(", ")}`);

  const { missing } = await collectReachableFiles(outputRoot);
  if (missing.length) throw new Error(`Optimized output has missing local assets: ${missing.slice(0, 10).join(", ")}`);

  return { missingAssets: missing, scriptCount, stylesheetCount };
}

export async function optimizeSite({ inputRoot, outputRoot, sourceReport = {} }) {
  if (resolve(inputRoot) === resolve(outputRoot)) throw new Error("Optimization input and output directories must differ.");
  if (!(await exists(join(inputRoot, "index.html")))) throw new Error(`Raw mirror is missing index.html: ${inputRoot}`);

  const rawStats = await directoryStats(inputRoot);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(dirname(outputRoot), { recursive: true });
  await cp(inputRoot, outputRoot, { recursive: true });

  let html = stripRemoteResourceHints(await readFile(join(outputRoot, "index.html"), "utf8"));
  const cookiePolicy = materializeCookiePolicy(html);
  html = materializeLocalEmoji(
    preSplitHeroTitle(hoistElementByClass(cookiePolicy.html, "cookieadmin_law_container"))
  );
  const runtimePath = join(outputRoot, "clone-runtime.js");
  const currentRuntimePath = join(projectRoot, "src", "clone-runtime.js");
  if (await exists(currentRuntimePath)) await copyFile(currentRuntimePath, runtimePath);
  const runtimeContent = (await exists(runtimePath)) ? await readFile(runtimePath, "utf8") : "";
  const runtimeCssPath = join(outputRoot, "clone-runtime.css");
  const currentRuntimeCssPath = join(projectRoot, "src", "clone-runtime.css");
  if (await exists(currentRuntimeCssPath)) await copyFile(currentRuntimeCssPath, runtimeCssPath);
  const runtimeCssContent = (await exists(runtimeCssPath)) ? await readFile(runtimeCssPath, "utf8") : "";
  const motionManifestPath = join(projectRoot, "src", "motion-manifest.json");
  const motionManifestContent = (await exists(motionManifestPath)) ? await readFile(motionManifestPath, "utf8") : "";
  if (motionManifestContent) await writeFile(join(outputRoot, "motion-manifest.json"), motionManifestContent);
  const unavailablePaths = (sourceReport.skipped ?? []).flatMap((item) => {
    try {
      return [new URL(item.url).pathname];
    } catch {
      return [];
    }
  });

  const styles = await bundleStyles(html, outputRoot, runtimeContent, runtimeCssContent, motionManifestContent, unavailablePaths);
  html = styles.html;
  const images = await optimizeImages(html, outputRoot);
  html = images.html;
  const scripts = await optimizeScripts(html, outputRoot);
  html = injectPreloads(scripts.html, styles.preloads);
  await writeFile(join(outputRoot, "index.html"), html);

  const reachability = await pruneUnreachableFiles(outputRoot);
  if (reachability.missing.length) {
    throw new Error(`Local assets are missing before promotion: ${reachability.missing.slice(0, 10).join(", ")}`);
  }

  const optimizedStats = await directoryStats(outputRoot);
  const preliminaryValidation = await validateOptimizedSite(outputRoot);
  const report = {
    ...sourceReport,
    optimizedAt: new Date().toISOString(),
    optimization: {
      assetsRemoved: {
        bytes: reachability.removed.reduce((sum, item) => sum + item.bytes, 0),
        files: reachability.removed.length
      },
      css: styles.report,
      images: images.report,
      raw: rawStats,
      optimized: optimizedStats,
      savings: {
        bytes: rawStats.bytes - optimizedStats.bytes,
        percent: rawStats.bytes ? Number((((rawStats.bytes - optimizedStats.bytes) / rawStats.bytes) * 100).toFixed(2)) : 0
      },
      scripts: scripts.report
    },
    removedDependencies: [
      ...styles.report.removed.map((item) => item.id || item.href),
      ...styles.report.duplicates.map((item) => item.id || item.href),
      ...scripts.report.removed.map((item) => item.id || item.src || item.reason)
    ].filter(Boolean),
    missingAssets: {
      optimized: [],
      sourceSkipped: sourceReport.skipped ?? []
    },
    performanceBudgetResults: {
      command: "npm run perf",
      status: "not-run"
    },
    motionManifest: motionManifestContent ? "/motion-manifest.json" : null,
    preservedCookiePolicy: Boolean(cookiePolicy.policy),
    validation: preliminaryValidation
  };
  await writeFile(join(outputRoot, "mirror-report.json"), JSON.stringify(report, null, 2));

  const compression = await compressAssets(outputRoot);
  report.optimization.compression = {
    brotliFiles: compression.brotliFiles,
    gzipFiles: compression.gzipFiles
  };
  report.optimization.assetManifest = "/asset-manifest.json";
  report.validation = await validateOptimizedSite(outputRoot);
  await writeFile(join(outputRoot, "mirror-report.json"), JSON.stringify(report, null, 2));
  const reportBuffer = await readFile(join(outputRoot, "mirror-report.json"));
  await Promise.all([
    brotli(reportBuffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).then((value) => writeFile(join(outputRoot, "mirror-report.json.br"), value)),
    gzipBuffer(reportBuffer, { level: 9, mtime: 0 }).then((value) => writeFile(join(outputRoot, "mirror-report.json.gz"), value))
  ]);

  return report;
}

export async function promoteDirectory(nextPath, targetPath) {
  const resolvedNext = resolve(nextPath);
  const resolvedTarget = resolve(targetPath);
  if (resolvedNext === resolvedTarget) throw new Error("Promotion source and target must differ.");
  const backupPath = `${resolvedTarget}.previous-${process.pid}`;
  await rm(backupPath, { force: true, recursive: true });
  const hadTarget = await exists(resolvedTarget);
  if (hadTarget) await rename(resolvedTarget, backupPath);

  try {
    await mkdir(dirname(resolvedTarget), { recursive: true });
    await rename(resolvedNext, resolvedTarget);
  } catch (error) {
    if (hadTarget && (await exists(backupPath))) await rename(backupPath, resolvedTarget);
    throw error;
  }

  await rm(backupPath, { force: true, recursive: true });
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") result.input = argv[++index];
    else if (argument === "--output") result.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if ((result.input && !result.output) || (!result.input && result.output)) {
    throw new Error("Use --input and --output together.");
  }
  return result;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.input) {
    const inputRoot = resolve(projectRoot, options.input);
    const sourceReportPath = join(inputRoot, "mirror-report.json");
    const sourceReport = (await exists(sourceReportPath)) ? JSON.parse(await readFile(sourceReportPath, "utf8")) : {};
    const report = await optimizeSite({
      inputRoot,
      outputRoot: resolve(projectRoot, options.output),
      sourceReport
    });
    console.log(`Optimized ${report.optimization.raw.files} raw files to ${report.optimization.optimized.files} reachable files.`);
    return;
  }

  if (!(await exists(join(rawMirrorRoot, "index.html")))) {
    throw new Error(`No raw mirror cache exists at ${rawMirrorRoot}. Run npm run mirror first.`);
  }
  await mkdir(mirrorCacheRoot, { recursive: true });
  const workRoot = await mkdtemp(join(mirrorCacheRoot, "optimize-"));
  const nextSite = join(workRoot, "site");
  try {
    const sourceReportPath = join(rawMirrorRoot, "mirror-report.json");
    const sourceReport = (await exists(sourceReportPath)) ? JSON.parse(await readFile(sourceReportPath, "utf8")) : {};
    const report = await optimizeSite({ inputRoot: rawMirrorRoot, outputRoot: nextSite, sourceReport });
    await promoteDirectory(nextSite, defaultSiteRoot);
    console.log(`Optimized site promoted atomically (${report.optimization.savings.percent}% smaller).`);
  } finally {
    await rm(workRoot, { force: true, recursive: true });
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) await runCli();
