import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "src");

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(repositoryRoot, absolutePath));
    }
  }
  return files;
}

const testFiles = (await collectTestFiles(sourceRoot)).sort();
const result = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=1",
  "--import",
  "tsx",
  ...testFiles,
], {
  cwd: repositoryRoot,
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
