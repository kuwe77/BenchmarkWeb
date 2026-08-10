import assert from "node:assert/strict";
import test from "node:test";
import {
  collectCssContentGlyphs,
  hoistElementByClass,
  materializeLocalEmoji,
  materializeCookiePolicy,
  preSplitHeroTitle
} from "../scripts/optimize.mjs";

test("collects, decodes, sorts, and deduplicates private-use content glyphs", () => {
  const css = String.raw`
    .solid::before { content: "\f005"; }
    .brand::before { content: '\f39e'; }
    .duplicate::after { content: "\f005"; }
    .literal::before { content: ""; }
    .supplementary::before { content: "\f0000 "; }
    .ordinary::before { content: "not an icon"; }
  `;

  const result = collectCssContentGlyphs(css);

  assert.deepEqual(result.codePoints, [0xe07b, 0xf005, 0xf39e, 0xf0000]);
  assert.equal([...result.characters].length, 4);
});

test("returns an empty glyph set when CSS content has no private-use characters", () => {
  assert.deepEqual(
    collectCssContentGlyphs('.quote::before{content:"\\\""}.label::after{content:"Hello"}'),
    { characters: "", codePoints: [] }
  );
});

test("pre-splits the LCP hero title without changing its element or line break", () => {
  const source = '<h2 class="tx-title hero-title wa_title_spilt_1">Empty Clinics? <br> No more</h2>';
  const result = preSplitHeroTitle(source);

  assert.match(result, /^<h2 class="tx-title hero-title wa_title_spilt_1"/);
  assert.match(result, /data-omg-split="true"/);
  assert.match(result, /aria-label="Empty Clinics\? No more"/);
  assert.match(result, /<br>/);
  assert.match(result, /<span class="omg-char">E<\/span>/);
  assert.equal(preSplitHeroTitle(result), result);
});

test("hoists a complete nested fixed element directly after body", () => {
  const source = '<html><body><main>Hero</main><div class="other cookieadmin_law_container pending"><div><p>Notice</p></div></div><footer>End</footer></body></html>';
  const result = hoistElementByClass(source, "cookieadmin_law_container");

  assert.ok(result.indexOf("cookieadmin_law_container") < result.indexOf("<main>"));
  assert.equal((result.match(/cookieadmin_law_container/g) || []).length, 1);
  assert.match(result, /<div class="other cookieadmin_law_container pending"><div><p>Notice<\/p><\/div><\/div>/);
});

test("preserves the cookie widgets' inherited strong weight after hoisting", () => {
  const policy = {
    cookieadmin_layout: "box",
    cookieadmin_modal: "center",
    cookieadmin_position: "bottom_left"
  };
  const source = [
    "<html><body>",
    '<div class="cookieadmin_law_container"><p id="cookieadmin_notice_title"></p><p id="cookieadmin_notice"></p></div>',
    '<div class="cookieadmin_cookie_modal"></div>',
    `<script>var cookieadmin_policy = ${JSON.stringify(policy)};</script>`,
    "</body></html>"
  ].join("");

  const result = materializeCookiePolicy(source).html;

  assert.match(result, /class="cookieadmin_law_container[^"]*"[^>]*style="[^"]*font-weight:700;/);
  assert.match(result, /class="cookieadmin_cookie_modal[^"]*"[^>]*style="[^"]*font-weight:700;/);
});

test("materializes the WordPress phone emoji as its local deterministic image", () => {
  const result = materializeLocalEmoji("<h3>☎️ Call your manager</h3>");

  assert.equal(
    result,
    '<h3><img draggable="false" role="img" class="emoji" alt="☎️" src="/external/s.w.org/images/core/emoji/17.0.2/svg/260e.svg"> Call your manager</h3>'
  );
});
