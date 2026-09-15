import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreEnv } from "../hermes-runtime-test-support.js";
import {
  HERMES_MOBILE_FILE_ROUTE_TTL_MS,
  clearHermesMobileFileRoute,
  readHermesMobileFileRoute,
  registerHermesMobileFileRoute,
} from "./hermes-mobile-file-route-store.js";

test("Hermes mobile file route lease is exact, expiring, and owner-cleared", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-mobile-file-route-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_MOBILE_FILE_ROUTE_STORE;
  try {
    process.env.CLAWCONNECT_HERMES_MOBILE_FILE_ROUTE_STORE = join(root, "routes.json");
    const route = await registerHermesMobileFileRoute({
      hermesSessionId: "hermes-session-1",
      gatewayId: "gw_test",
      sessionKey: "mobile-session-1",
      sourceRunId: "run-1",
      nowMs: 1_000,
    });
    assert.deepEqual(route, {
      hermesSessionId: "hermes-session-1",
      gatewayId: "gw_test",
      sessionKey: "mobile-session-1",
      sourceRunId: "run-1",
      expiresAt: new Date(1_000 + HERMES_MOBILE_FILE_ROUTE_TTL_MS).toISOString(),
    });
    assert.equal((await readHermesMobileFileRoute("hermes-session-1", 2_000))?.sourceRunId, "run-1");

    await clearHermesMobileFileRoute("hermes-session-1", "different-run");
    assert.equal((await readHermesMobileFileRoute("hermes-session-1", 2_000))?.sourceRunId, "run-1");

    assert.equal(
      await readHermesMobileFileRoute("hermes-session-1", 1_000 + HERMES_MOBILE_FILE_ROUTE_TTL_MS),
      undefined,
    );
    await clearHermesMobileFileRoute("hermes-session-1", "run-1");
    assert.equal(await readHermesMobileFileRoute("hermes-session-1", 2_000), undefined);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_MOBILE_FILE_ROUTE_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});
