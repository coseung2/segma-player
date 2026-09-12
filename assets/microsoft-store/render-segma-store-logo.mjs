import { readFile } from "node:fs/promises";
import sharp from "sharp";

const source = await readFile("assets/microsoft-store/source/logo-mark-1024x1024.svg", "utf8");
const output = "C:/Users/coseung2/Downloads/Segma Player Store Assets/KO/segma-icon-store-1080-fullbleed.png";

await sharp(Buffer.from(source)).resize(1080, 1080, { fit: "fill" }).png().toFile(output);
const meta = await sharp(output).metadata();
console.log(JSON.stringify({ output, width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha }));
