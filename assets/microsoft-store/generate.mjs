import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderSegmaIcon } from "./segma-icon-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(root, "../..");
const listingDir = path.join(root, "listing");
const packageDir = path.join(root, "package");
const sourceDir = path.join(root, "source");

const palette = {
  ink: "#0E1420",
  ink2: "#18243A",
  surface: "#FFFFFF",
  canvas: "#F0ECE7",
  border: "#D2D5DB",
  text: "#F7FBFF",
  muted: "#AAB6C8",
  blue: "#63A8FF",
  cyan: "#75E6DA",
  violet: "#8B7CFF",
};

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function defs(id) {
  return `
  <defs>
    <linearGradient id="surface-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1C2A42"/>
      <stop offset="1" stop-color="#0E1420"/>
    </linearGradient>
    <linearGradient id="accent-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.cyan}"/>
      <stop offset="0.52" stop-color="${palette.blue}"/>
      <stop offset="1" stop-color="${palette.violet}"/>
    </linearGradient>
    <radialGradient id="glow-${id}" cx="50%" cy="34%" r="62%">
      <stop offset="0" stop-color="#63A8FF" stop-opacity="0.34"/>
      <stop offset="0.62" stop-color="#63A8FF" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#63A8FF" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function logoMark(size = 1024, { background = true, compact = false } = {}) {
  const stroke = compact ? 76 : 58;
  const arrowStroke = compact ? 78 : 62;
  const frame = compact
    ? { x: 212, y: 302, w: 600, h: 406, r: 116 }
    : { x: 220, y: 288, w: 584, h: 400, r: 110 };
  const play = compact
    ? "M456 392 L614 505 L456 618 Z"
    : "M450 378 L610 488 L450 598 Z";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  ${defs(`logo-${size}-${compact ? "c" : "f"}`)}
  ${background ? `<rect width="1024" height="1024" rx="220" fill="url(#surface-logo-${size}-${compact ? "c" : "f"})"/>` : ""}
  <circle cx="512" cy="512" r="426" fill="url(#glow-logo-${size}-${compact ? "c" : "f"})"/>
  <path d="M512 120v126" fill="none" stroke="url(#accent-logo-${size}-${compact ? "c" : "f"})" stroke-width="${arrowStroke}" stroke-linecap="round"/>
  <path d="M430 166l82 92 82-92" fill="none" stroke="url(#accent-logo-${size}-${compact ? "c" : "f"})" stroke-width="${arrowStroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="${frame.r}" fill="#101827" fill-opacity="0.58" stroke="url(#accent-logo-${size}-${compact ? "c" : "f"})" stroke-width="${stroke}"/>
  <path d="${play}" fill="#F7FBFF"/>
  <path d="M332 812h360" fill="none" stroke="#F7FBFF" stroke-width="${compact ? 58 : 48}" stroke-linecap="round" opacity="0.92"/>
</svg>`;
}

function wideTileSvg(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs("wide")}
  <rect width="${width}" height="${height}" fill="url(#surface-wide)"/>
  <circle cx="${Math.round(height * 0.62)}" cy="${Math.round(height / 2)}" r="${Math.round(height * 0.72)}" fill="url(#glow-wide)"/>
  <g transform="translate(${Math.round(height * 0.12)} ${Math.round(height * 0.12)}) scale(${height * 0.76 / 1024})">
    ${logoMark(1024, { background: false, compact: true }).replace(/^<svg[^>]*>|<\/svg>$/g, "")}
  </g>
</svg>`;
}

function windowMockSvg({ width, height, x, y, scale = 1, dark = false }) {
  const w = 760 * scale;
  const h = 500 * scale;
  const bg = dark ? "#101827" : "#FFFFFF";
  const panel = dark ? "#18243A" : "#F0F1F3";
  const text = dark ? "#F7FBFF" : "#17191D";
  const muted = dark ? "#AAB6C8" : "#787D86";
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <rect width="760" height="500" rx="28" fill="${bg}" stroke="${dark ? "#2B3852" : palette.border}" stroke-width="2"/>
    <rect width="760" height="58" rx="28" fill="${panel}"/>
    <circle cx="34" cy="29" r="8" fill="#FF6B61"/>
    <circle cx="60" cy="29" r="8" fill="#F7BD4F"/>
    <circle cx="86" cy="29" r="8" fill="#38C172"/>
    <rect x="128" y="18" width="250" height="22" rx="11" fill="${dark ? "#26324B" : "#E4E6EA"}"/>
    <rect x="42" y="96" width="164" height="340" rx="20" fill="${panel}"/>
    <rect x="70" y="126" width="84" height="18" rx="9" fill="${muted}" opacity="0.55"/>
    <rect x="70" y="174" width="108" height="16" rx="8" fill="${muted}" opacity="0.28"/>
    <rect x="70" y="218" width="92" height="16" rx="8" fill="${muted}" opacity="0.28"/>
    <rect x="70" y="262" width="114" height="16" rx="8" fill="${muted}" opacity="0.28"/>
    <rect x="238" y="96" width="480" height="258" rx="24" fill="${dark ? "#0B111D" : "#17191D"}"/>
    <path d="M452 166l118 84-118 84z" fill="${palette.blue}"/>
    <rect x="238" y="382" width="480" height="54" rx="16" fill="${panel}"/>
    <circle cx="268" cy="409" r="14" fill="${palette.blue}"/>
    <rect x="300" y="403" width="238" height="12" rx="6" fill="${muted}" opacity="0.32"/>
    <rect x="300" y="403" width="126" height="12" rx="6" fill="${palette.blue}"/>
    <rect x="610" y="398" width="78" height="22" rx="11" fill="${text}" opacity="0.9"/>
  </g>`;
}

function heroSvg() {
  const title = "Save videos.";
  const subtitle = "Play them your way.";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  ${defs("hero")}
  <rect width="1920" height="1080" fill="url(#surface-hero)"/>
  <circle cx="1580" cy="230" r="520" fill="url(#glow-hero)"/>
  <g transform="translate(128 132) scale(0.26)">${logoMark(1024, { background: true, compact: true }).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g>
  <text x="128" y="500" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="92" font-weight="700" letter-spacing="-2">${xml(title)}</text>
  <text x="128" y="610" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="92" font-weight="700" letter-spacing="-2">${xml(subtitle)}</text>
  <text x="132" y="690" fill="${palette.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="32" font-weight="400">Download, organize, and watch local video in one focused desktop tool.</text>
  <g transform="translate(128 796)">
    <rect width="238" height="58" rx="29" fill="${palette.blue}"/>
    <text x="34" y="39" fill="#07111F" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700">Built for Windows</text>
  </g>
  ${windowMockSvg({ x: 900, y: 278, scale: 1.12, dark: true })}
</svg>`;
}

function posterSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1080" viewBox="0 0 720 1080">
  ${defs("poster")}
  <rect width="720" height="1080" fill="url(#surface-poster)"/>
  <circle cx="360" cy="230" r="360" fill="url(#glow-poster)"/>
  <g transform="translate(220 72) scale(0.273)">${logoMark(1024, { background: true, compact: true }).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g>
  <text x="360" y="448" text-anchor="middle" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="700" letter-spacing="-1.5">Save videos.</text>
  <text x="360" y="528" text-anchor="middle" fill="${palette.text}" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="700" letter-spacing="-1.5">Play them your way.</text>
  <text x="360" y="594" text-anchor="middle" fill="${palette.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="24">Download, organize, and watch.</text>
  ${windowMockSvg({ x: 72, y: 678, scale: 0.76, dark: true })}
</svg>`;
}

function screenshotChrome(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${palette.canvas}"/>
    <rect x="196.5" y="31.5" width="973" height="705" rx="18" fill="#FFFFFF" stroke="${palette.border}" stroke-width="1"/>
  </svg>`;
}

async function writeText(file, text) {
  await writeFile(file, text, "utf8");
}

async function renderSvg(name, svg, width, height, directory = listingDir) {
  const svgPath = path.join(sourceDir, `${name}.svg`);
  const pngPath = path.join(directory, `${name}.png`);
  await writeText(svgPath, svg);
  await sharp(Buffer.from(svg), { density: 96 })
    .resize(width, height, { fit: "fill" })
    .png()
    .toFile(pngPath);
  return { name, width, height, pngPath, svgPath };
}

async function renderFigmaIcon(name, width, height, directory = listingDir) {
  const pngPath = path.join(directory, `${name}.png`);
  await renderSegmaIcon(pngPath, width, height);
  return { name, width, height, pngPath };
}

async function renderScreenshot(fileName, sourceName) {
  const width = 1366;
  const height = 768;
  const sourcePath = path.join(repoRoot, "design-system", "screens", sourceName);
  const resized = await sharp(sourcePath)
    .resize({ height: 704, kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const x = Math.round((width - meta.width) / 2);
  const y = 32;
  const border = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="${x - 0.5}" y="${y - 0.5}" width="${meta.width + 1}" height="${meta.height + 1}" rx="16" fill="none" stroke="${palette.border}" stroke-width="1"/>
  </svg>`);
  const pngPath = path.join(listingDir, fileName);
  await sharp(Buffer.from(screenshotChrome(width, height)))
    .composite([
      { input: resized, left: x, top: y },
      { input: border, left: 0, top: 0 },
    ])
    .png()
    .toFile(pngPath);
  return { name: fileName, width, height, pngPath, sourcePath };
}

async function main() {
  await Promise.all([mkdir(listingDir, { recursive: true }), mkdir(packageDir, { recursive: true }), mkdir(sourceDir, { recursive: true })]);

  const outputs = [];
  outputs.push(await renderFigmaIcon("app-tile-300x300", 300, 300));
  outputs.push(await renderFigmaIcon("store-logo-50x50", 50, 50));
  outputs.push(await renderFigmaIcon("logo-mark-1024x1024", 1024, 1024));
  outputs.push(await renderSvg("poster-720x1080", posterSvg(), 720, 1080));
  outputs.push(await renderSvg("hero-1920x1080", heroSvg(), 1920, 1080));

  const packageAssets = [
    ["Square44x44Logo", 44, 44, null],
    ["Square71x71Logo", 71, 71, null],
    ["Square150x150Logo", 150, 150, null],
    ["Square310x310Logo", 310, 310, null],
    ["StoreLogo50x50", 50, 50, null],
    ["Wide310x150Logo", 310, 150, wideTileSvg(310, 150)],
    ["SplashScreen620x300", 620, 300, wideTileSvg(620, 300)],
  ];
  for (const [name, width, height, svg] of packageAssets) {
    outputs.push(svg
      ? await renderSvg(name, svg, width, height, packageDir)
      : await renderFigmaIcon(name, width, height, packageDir));
  }

  const screenshots = [
    ["screenshot-01-downloads-1366x768.png", "queue.png"],
    ["screenshot-02-library-1366x768.png", "library.png"],
    ["screenshot-03-player-1366x768.png", "player.png"],
    ["screenshot-04-subtitles-1366x768.png", "subtitles.png"],
    ["screenshot-05-settings-1366x768.png", "settings.png"],
  ];
  for (const [fileName, sourceName] of screenshots) {
    outputs.push(await renderScreenshot(fileName, sourceName));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    note: "Neutral working assets; no product name is embedded in the artwork.",
    listing: {
      appTile: "listing/app-tile-300x300.png",
      storeLogo: "listing/store-logo-50x50.png",
      poster: "listing/poster-720x1080.png",
      hero: "listing/hero-1920x1080.png",
      screenshots: screenshots.map(([fileName]) => `listing/${fileName}`),
    },
    package: packageAssets.map(([name]) => `package/${name}.png`),
    outputs: outputs.map(({ name, width, height }) => ({ name, width, height })),
  };
  await writeText(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeText(
    path.join(root, "README.md"),
    [
      "# Microsoft Store visual assets",
      "",
      "Neutral working artwork for the video download and playback desktop app. No final app name is embedded in the images.",
      "",
      "## Store listing",
      "",
      "| Use | File | Size |",
      "| --- | --- | --- |",
      "| App tile icon | `listing/app-tile-300x300.png` | 300×300 |",
      "| Store logo | `listing/store-logo-50x50.png` | 50×50 |",
      "| Poster image | `listing/poster-720x1080.png` | 720×1080 |",
      "| Super hero art | `listing/hero-1920x1080.png` | 1920×1080 |",
      "| Desktop screenshots | `listing/screenshot-*.png` | 1366×768 |",
      "",
      "## Optional package artwork",
      "",
      "MSIX-style working assets are under `package/`: 44×44, 50×50, 71×71, 150×150, 310×310, 310×150, and 620×300.",
      "",
      "Editable SVG render sources are under `source/`. The Figma file is the editable design review surface; these files are deterministic upload outputs.",
      "",
    ].join("\n"),
  );

  for (const output of outputs) {
    const file = output.pngPath;
    const meta = await sharp(file).metadata();
    if (meta.width !== output.width || meta.height !== output.height) {
      throw new Error(`${output.name} rendered at ${meta.width}x${meta.height}, expected ${output.width}x${output.height}`);
    }
  }
  console.log(JSON.stringify({ ok: true, count: outputs.length, root }, null, 2));
}

await main();
