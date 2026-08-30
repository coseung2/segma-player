import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStoreRuntimeFiles, validateRuntimeGraph } from "./runtime-graph.mjs";

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

async function main() {
  const stageDirectory = option("stage");
  if (!stageDirectory) throw new Error("Usage: node scripts/validate-runtime-graph.mjs --stage=PATH");
  const runtimeFiles = await readStoreRuntimeFiles();
  const result = await validateRuntimeGraph({ stageDirectory, runtimeFiles });
  process.stdout.write(`RUNTIME_GRAPH_OK\nFILES=${result.files}\nSTAGE=${path.resolve(stageDirectory)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
