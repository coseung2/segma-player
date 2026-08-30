import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStoreRuntimeFiles, validateRuntimeGraph } from "./scripts/runtime-graph.mjs";
import { COMPATIBILITY_DIRECTORY } from "./scripts/node-suite-config.mjs";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

async function copiedRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "segma-runtime-graph-"));
  const runtimeFiles = await readStoreRuntimeFiles();
  for (const relativePath of runtimeFiles) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relativePath), destination, { recursive: false });
  }
  return { root, runtimeFiles };
}

test("the declared store runtime is the complete manifest import closure", async () => {
  const runtimeFiles = await readStoreRuntimeFiles();
  const result = await validateRuntimeGraph({ stageDirectory: repositoryRoot, runtimeFiles });
  assert.equal(result.files, runtimeFiles.length);
  assert.deepEqual(result.reachable, [...runtimeFiles]);
  assert.equal(runtimeFiles.includes("options.html"), false);
  assert.equal(runtimeFiles.includes("player.html"), false);
  assert.equal(runtimeFiles.includes("download-worker.js"), false);
  assert.equal(runtimeFiles.includes("native-file-writer.js"), false);
});

test("runtime graph validation rejects missing imports and unreachable additions", async (context) => {
  const { root, runtimeFiles } = await copiedRuntime();
  context.after(() => rm(root, { recursive: true, force: true }));
  const backgroundPath = path.join(root, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  await writeFile(backgroundPath, `import "./retired-player.js";\n${background}`, "utf8");
  await assert.rejects(
    validateRuntimeGraph({ stageDirectory: root, runtimeFiles }),
    /Runtime entry\/import is not declared: retired-player\.js/,
  );
  await writeFile(backgroundPath, background, "utf8");
  await assert.rejects(
    validateRuntimeGraph({ stageDirectory: root, runtimeFiles: [...runtimeFiles, "options.js"] }),
    /Declared runtime files are unreachable from the manifest: options\.js/,
  );
});

test("runtime graph validation rejects imports into extension-primary compatibility", async (context) => {
  const { root, runtimeFiles } = await copiedRuntime();
  context.after(() => rm(root, { recursive: true, force: true }));
  const backgroundPath = path.join(root, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  await writeFile(
    backgroundPath,
    `import "./${COMPATIBILITY_DIRECTORY}/player.js";\n${background}`,
    "utf8",
  );
  await assert.rejects(
    validateRuntimeGraph({ stageDirectory: root, runtimeFiles }),
    /Runtime entry\/import is not declared: compatibility\/extension-primary\/player\.js/,
  );
});
