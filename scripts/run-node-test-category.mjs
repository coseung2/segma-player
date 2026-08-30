import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { categorizedNodeTests } from "./node-suite-config.mjs";

const category = process.argv[2];
if (category !== "shipped" && category !== "legacy") {
  throw new Error("Usage: node scripts/run-node-test-category.mjs <shipped|legacy>");
}

const suites = await categorizedNodeTests();
const files = suites[category];
if (!files.length) throw new Error(`Node test category is empty: ${category}`);

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
