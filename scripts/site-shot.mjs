import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const outputDir = process.argv[2] || path.resolve(siteRoot, "..", "artifacts", "site-qa");
mkdirSync(outputDir, { recursive: true });

const targets = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, fullPage: false },
  { name: "desktop-full", viewport: { width: 1440, height: 900 }, fullPage: true },
  { name: "mobile", viewport: { width: 390, height: 844 }, fullPage: false },
  { name: "mobile-full", viewport: { width: 390, height: 844 }, fullPage: true },
];

const pageUrl = `file:///${siteRoot.replaceAll("\\", "/")}/index.html`;

let browser = null;
for (const channel of ["chrome", "msedge"]) {
  try {
    browser = await chromium.launch({ channel, headless: true });
    break;
  } catch {
    // Try the next channel, then the bundled headless shell.
  }
}
if (!browser) browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ locale: "ko-KR" });
  for (const target of targets) {
    await page.setViewportSize(target.viewport);
    await page.goto(pageUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const out = path.join(outputDir, `${target.name}.png`);
    await page.screenshot({ path: out, fullPage: target.fullPage });
    console.log(out);
  }
} finally {
  await browser.close();
}
