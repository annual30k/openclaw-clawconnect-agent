import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
// 整个测试进程使用临时主目录：os.homedir() 在 POSIX 读 HOME、在 Windows 读 USERPROFILE，
// 任何测试即使漏了隔离，也不能读写开发者真实的 ~/.clawconnect 配对配置。
const isolatedHome = await mkdtemp(join(tmpdir(), "clawconnect-test-home-"));
const result = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=1",
  "--import",
  "tsx",
  ...testFiles,
], {
  cwd: repositoryRoot,
  env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
  stdio: "inherit",
  shell: false,
});
await rm(isolatedHome, { recursive: true, force: true });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
