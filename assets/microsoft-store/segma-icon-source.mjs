import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const figmaSegmaIconSource = path.join(
  root,
  "..",
  "aura-media-mark.svg",
);
export const desktopIconSource = path.join(
  root,
  "source",
  "segma-icon-store-1080-fullbleed.png",
);

export async function segmaIconPng(width, height = width) {
  return sharp(figmaSegmaIconSource)
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();
}

export async function renderSegmaIcon(outputPath, width, height = width) {
  const png = await segmaIconPng(width, height);
  await writeFile(outputPath, png);
  return outputPath;
}

export async function desktopIconPng(width, height = width) {
  return sharp(desktopIconSource)
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();
}

export async function writeSegmaIco(outputPath) {
  const sizes = [256, 48, 32, 16];
  const images = await Promise.all(
    sizes.map(async (size) => ({
      size,
      blob: await desktopIconIcoEntry(size),
    })),
  );
  const headerSize = 6 + images.length * 16;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  images.forEach((image, index) => {
    const size = image.size;
    const blob = image.blob;
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(blob.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += blob.length;
  });
  await writeFile(
    outputPath,
    Buffer.concat([header].concat(images.map((image) => image.blob))),
  );
  return outputPath;
}

async function desktopIconIcoEntry(size) {
  const rgba = await sharp(desktopIconSource)
    .resize(size, size, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (size >= 256) {
    return sharp(rgba.data, {
      raw: { width: size, height: size, channels: 4 },
    })
      .png()
      .toBuffer();
  }
  return encodeBmpIcoEntry(rgba.data, size);
}

function encodeBmpIcoEntry(rgba, size) {
  const xorStride = size * 4;
  const andStride = ((size + 31) >> 5) * 4;
  const xorSize = xorStride * size;
  const andSize = andStride * size;
  const headerSize = 40;
  const blob = Buffer.alloc(headerSize + xorSize + andSize);
  blob.writeUInt32LE(headerSize, 0);
  blob.writeInt32LE(size, 4);
  blob.writeInt32LE(size * 2, 8);
  blob.writeUInt16LE(1, 12);
  blob.writeUInt16LE(32, 14);
  blob.writeUInt32LE(0, 16);
  blob.writeUInt32LE(xorSize + andSize, 20);
  for (let y = 0; y < size; y += 1) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const src = (srcY * size + x) * 4;
      const dest = headerSize + y * xorStride + x * 4;
      const alpha = rgba[src + 3];
      if (alpha < 128) {
        blob[dest] = 0;
        blob[dest + 1] = 0;
        blob[dest + 2] = 0;
        blob[dest + 3] = 0;
        const maskIndex = headerSize + xorSize + y * andStride + (x >> 3);
        blob[maskIndex] |= 0x80 >> (x & 7);
      } else {
        blob[dest] = rgba[src + 2];
        blob[dest + 1] = rgba[src + 1];
        blob[dest + 2] = rgba[src];
        blob[dest + 3] = 255;
      }
    }
  }
  return blob;
}

export async function verifyFigmaSource() {
  const source = await readFile(figmaSegmaIconSource);
  const metadata = await sharp(source).metadata();
  if (metadata.width !== 1024 || metadata.height !== 1024) {
    throw new Error(`Figma Segma mark must render at 1024x1024, got x`);
  }
}
