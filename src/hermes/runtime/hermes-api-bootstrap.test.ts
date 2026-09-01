import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureHermesApiServer, writeHermesEnvValues } from "./hermes-api-bootstrap.js";

test("Hermes env writer updates the authoritative file atomically and preserves unrelated settings", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-env-"));
  try {
    writeFileSync(join(hermesHome, ".env"), [
      "# existing Hermes settings",
      "MODEL_PROVIDER=openrouter",
      "API_SERVER_ENABLED=false",
      "API_SERVER_ENABLED=false",
      "",
    ].join("\n"));
    writeHermesEnvValues({
      API_SERVER_ENABLED: "true",
      API_SERVER_KEY: "generated-secret",
    }, { env: {}, hermesHome });
    const output = readFileSync(join(hermesHome, ".env"), "utf8");
    assert.match(output, /# existing Hermes settings/);
    assert.match(output, /MODEL_PROVIDER=openrouter/);
    assert.equal((output.match(/API_SERVER_ENABLED=true/g) ?? []).length, 1);
    assert.match(output, /API_SERVER_KEY=generated-secret/);
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test("Hermes API bootstrap reads back the authoritative env before reporting success", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-bootstrap-real-env-"));
  const calls: string[][] = [];
  try {
    const result = ensureHermesApiServer({
      env: {},
      hermesHome,
      generateApiKey: () => "generated-secret",
      runHermesCommand: (args) => {
        calls.push(args);
        return "";
      },
    });
    assert.equal(result, "configured");
    assert.deepEqual(calls, [["gateway", "restart"]]);
    const output = readFileSync(join(hermesHome, ".env"), "utf8");
    assert.match(output, /API_SERVER_ENABLED=true/);
    assert.match(output, /API_SERVER_KEY=generated-secret/);
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test("Hermes API bootstrap enables API Server, generates a key, and restarts the gateway", () => {
  const calls: string[][] = [];
  const writes: Array<Record<string, string>> = [];
  const result = ensureHermesApiServer({
    env: {},
    hermesHome: "/nonexistent-hermes-bootstrap-test",
    fileEnv: {},
    generateApiKey: () => "generated-secret",
    writeEnvValues: (values) => writes.push(values),
    runHermesCommand: (args) => {
      calls.push(args);
      return "";
    },
  });

  assert.equal(result, "configured");
  assert.deepEqual(writes, [{ API_SERVER_ENABLED: "true", API_SERVER_KEY: "generated-secret" }]);
  assert.deepEqual(calls, [["gateway", "restart"]]);
});

test("Hermes API bootstrap preserves an existing key", () => {
  const calls: string[][] = [];
  const writes: Array<Record<string, string>> = [];
  const result = ensureHermesApiServer({
    env: {},
    hermesHome: "/nonexistent-hermes-bootstrap-test",
    fileEnv: { API_SERVER_KEY: "existing-secret", API_SERVER_PORT: "8642" },
    writeEnvValues: (values) => writes.push(values),
    runHermesCommand: (args) => {
      calls.push(args);
      return "";
    },
  });

  assert.equal(result, "configured");
  assert.deepEqual(writes, [{ API_SERVER_ENABLED: "true" }]);
  assert.deepEqual(calls, [["gateway", "restart"]]);
});

test("Hermes API bootstrap is idempotent when the local API is ready", () => {
  const result = ensureHermesApiServer({
    env: {},
    hermesHome: "/nonexistent-hermes-bootstrap-test",
    fileEnv: { API_SERVER_ENABLED: "true", API_SERVER_KEY: "existing-secret" },
    runHermesCommand: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(result, "already-ready");
});

test("Hermes API bootstrap respects explicit local mode", () => {
  const result = ensureHermesApiServer({
    env: { CLAWCONNECT_HERMES_RUNTIME_MODE: "local" },
    hermesHome: "/nonexistent-hermes-bootstrap-test",
    fileEnv: {},
    runHermesCommand: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(result, "explicit-local");
});

test("Hermes API bootstrap leaves a complete external API override untouched", () => {
  const result = ensureHermesApiServer({
    env: {
      CLAWCONNECT_HERMES_API_URL: "https://hermes.example.test",
      CLAWCONNECT_HERMES_API_KEY: "external-secret",
    },
    hermesHome: "/nonexistent-hermes-bootstrap-test",
    fileEnv: {},
    runHermesCommand: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(result, "external-api");
});

test("Hermes API bootstrap errors never expose the generated key", () => {
  assert.throws(
    () => ensureHermesApiServer({
      env: {},
      hermesHome: "/nonexistent-hermes-bootstrap-test",
      fileEnv: {},
      generateApiKey: () => "do-not-leak-this-secret",
      writeEnvValues: () => {
        throw new Error("write included do-not-leak-this-secret");
      },
      runHermesCommand: () => {
        throw new Error("command included do-not-leak-this-secret");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /do-not-leak-this-secret/);
      assert.match(error.message, /Failed to enable and verify the Hermes API Server/);
      return true;
    },
  );
});
