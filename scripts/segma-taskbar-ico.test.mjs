import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";

import { desktopIconSource, writeSegmaIco } from "../assets/microsoft-store/segma-icon-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("taskbar ICO keeps an AND mask on small Windows sizes", async () => {
  const output = path.join(root, "artifacts", "segma-player-taskbar-test.ico");
  await writeSegmaIco(output);
  const data = await readFile(output);
  const count = data.readUInt16LE(4);
  assert.equal(count, 4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = data[entry] === 0 ? 256 : data[entry];
    const bytes = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    const blob = data.subarray(offset, offset + bytes);
    sizes.push(width);
    if (width >= 256) {
      assert.equal(blob[0], 0x89);
      continue;
    }
    assert.equal(blob.readUInt32LE(0), 40);
    assert.equal(blob.readInt32LE(4), width);
    assert.equal(blob.readInt32LE(8), width * 2);
    assert.equal(blob.readUInt16LE(14), 32);
  }
  assert.deepEqual(sizes, [256, 48, 32, 16]);
  const source = await sharp(desktopIconSource).metadata();
  assert.equal(source.width, 1080);
  assert.equal(source.height, 1080);
});
