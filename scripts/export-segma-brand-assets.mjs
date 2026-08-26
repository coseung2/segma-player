import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  desktopIconPng,
  renderSegmaIcon,
  verifyFigmaSource,
  writeSegmaIco,
} from "../assets/microsoft-store/segma-icon-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await verifyFigmaSource();
await Promise.all([
  renderSegmaIcon(path.join(root, "companion-gui/assets/segma-mark.png"), 1024),
  desktopIconPng(32).then((png) => writeFile(path.join(root, "companion-gui/assets/segma-mark-32.png"), png)),
  desktopIconPng(256).then((png) => writeFile(path.join(root, "companion-gui/assets/segma-mark-256.png"), png)),
  writeSegmaIco(path.join(root, "companion-gui/assets/segma-player.ico")),
  writeSegmaIco(path.join(root, "assets/microsoft-store/source/segma-player.ico")),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/listing/logo-mark-1024x1024.png"), 1024),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/listing/app-tile-300x300.png"), 300),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/listing/store-logo-50x50.png"), 50),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/package/Square44x44Logo.png"), 44),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/package/Square71x71Logo.png"), 71),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/package/Square150x150Logo.png"), 150),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/package/Square310x310Logo.png"), 310),
  renderSegmaIcon(path.join(root, "assets/microsoft-store/package/StoreLogo50x50.png"), 50),
]);

console.log("SEGMA_BRAND_ASSETS_OK");
