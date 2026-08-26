import { readFile } from "node:fs/promises";
import sharp from "sharp";

const source = await readFile("companion-gui/assets/segma-mark.svg", "utf8");
const cropped = source.replace(
  'width="32" height="32" viewBox="0 0 32 32"',
  'width="1080" height="1080" viewBox="5.5 5.5 21 21"',
);
const output = "C:/Users/coseung2/Downloads/Segma Player Store Assets/KO/segma-icon-store-1080-fullbleed.png";

await sharp(Buffer.from(cropped)).resize(1080, 1080, { fit: "fill" }).png().toFile(output);
const meta = await sharp(output).metadata();
console.log(JSON.stringify({ output, width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha }));
