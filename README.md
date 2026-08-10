# OneMilligram homepage clone

This project is a fully local, static clone of the public OneMilligram homepage. It preserves the page's visible layout, responsive states, navigation, consent UI, forms, marquees, counters, sliders, cursor effects, FAQ interactions, and scroll animation sequence without running WordPress, Elementor, WooCommerce, or their legacy JavaScript stack.

## Run locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

`npm start` serves the same production output.

## Refresh and optimize

```bash
npm run mirror
```

`mirror` downloads the public page into an isolated staging directory, optimizes and validates it, then atomically promotes both the raw cache and `site/`. If any download, optimization, or validation gate fails, the last working clone remains untouched.

To rebuild `site/` from the latest successful raw cache without downloading again:

```bash
npm run optimize
```

## Quality gates

```bash
npm test
npm run verify
npm run perf
```

- `verify` runs local-asset, console, external-request, interaction, scroll, resize, reverse-scroll, and four-viewport visual regression checks against `.cache/mirror/raw`.
- `perf` runs the mobile and desktop Lighthouse budgets and records the result in both `artifacts/performance/summary.json` and `site/mirror-report.json`.
- Generated static assets are fingerprinted, precompressed with Brotli/Gzip, and served with encoding-specific ETags and immutable caching. HTML remains refreshable.

Analytics and live WordPress submission are disabled. Contact-form responses and cookie preferences remain local to the device; public CTA links continue to their original destinations.
