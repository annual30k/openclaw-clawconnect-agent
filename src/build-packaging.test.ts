import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("production build excludes tests and test-support helpers from the published dist", () => {
  const buildConfig = JSON.parse(readFileSync(join(packageRoot, "tsconfig.build.json"), "utf8")) as { exclude: string[] };

  assert.ok(buildConfig.exclude.includes("**/*.test.ts"));
  assert.ok(buildConfig.exclude.includes("src/test-support/**"));
  assert.ok(buildConfig.exclude.includes("**/*-test-support.ts"));
});
