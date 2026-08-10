import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, before, test } from "node:test";

import { PNG } from "pngjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories = [];

let compareImages;

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\n\nasync function ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name} from verifier`);
  return eval(`(${source.slice(start, end)})`);
}

function makeFixture(blockTop, { height = 12, width = 12 } = {}) {
  const image = new PNG({ height, width });
  image.data.fill(255);
  for (let y = blockTop; y < blockTop + 4; y += 1) {
    for (let x = 2; x < 10; x += 1) {
      const offset = (y * width + x) * 4;
      image.data[offset] = 0;
      image.data[offset + 1] = 0;
      image.data[offset + 2] = 0;
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

async function makePaths() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloner-verify-registration-"));
  temporaryDirectories.push(directory);
  const diff = path.join(directory, "diff", "result.png");
  const current = path.join(directory, "current.png");
  const reference = path.join(directory, "reference.png");
  await writeFile(reference, makeFixture(3));
  await writeFile(current, makeFixture(4));
  return { current, diff, reference };
}

before(async () => {
  const source = await readFile(path.join(projectRoot, "scripts", "verify.mjs"), "utf8");
  compareImages = extractFunction(source, "compareImages", "cropImage");
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

test("section registration accepts a one-pixel capture displacement and reports its offset", async () => {
  const paths = await makePaths();

  const result = await compareImages(
    paths.reference,
    paths.current,
    paths.diff,
    0,
    { registrationRadius: 1 }
  );

  assert.equal(result.passed, true);
  assert.equal(result.changedPixels, 0);
  assert.deepEqual(result.alignment, { x: 0, y: -1 });
});

test("unregistered comparisons remain pixel-strict", async () => {
  const paths = await makePaths();

  const result = await compareImages(paths.reference, paths.current, paths.diff, 0);

  assert.equal(result.passed, false);
  assert.deepEqual(result.alignment, { x: 0, y: 0 });
});
