import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPATIBILITY_DIRECTORY = "compatibility/extension-primary";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptDirectory);
const ROOT_TEST_PATTERN = /^[^/]+\.test\.mjs$/;
const SHIPPED_TEST_DIRECTORIES = Object.freeze([
  "companion-contract",
  "companion-ui",
  "scripts",
  "sites",
]);

async function testFilesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "artifacts" || entry.name === ".git") continue;
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await testFilesUnder(path.join(directory, entry.name), relative));
    else if (entry.name.endsWith(".test.mjs")) files.push(relative);
  }
  return files.sort();
}

export async function categorizedNodeTests(root = repositoryRoot) {
  const all = await testFilesUnder(root);
  const legacy = all.filter((file) => file.startsWith(`${COMPATIBILITY_DIRECTORY}/`));
  const shipped = all.filter((file) => ROOT_TEST_PATTERN.test(file)
    || SHIPPED_TEST_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)));
  const uncategorized = all.filter((file) => !legacy.includes(file) && !shipped.includes(file));
  return Object.freeze({
    all: Object.freeze(all),
    shipped: Object.freeze(shipped),
    legacy: Object.freeze(legacy),
    uncategorized: Object.freeze(uncategorized),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && !process.env.NODE_TEST_CONTEXT) {
  const category = process.argv[2];
  if (category !== "shipped" && category !== "legacy") {
    throw new Error("Usage: node scripts/node-suite-config.mjs <shipped|legacy>");
  }
  const suites = await categorizedNodeTests();
  if (!suites[category].length) throw new Error(`Node test category is empty: ${category}`);
  process.stdout.write(suites[category].join("\n"));
}
