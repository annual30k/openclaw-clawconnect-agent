import assert from "node:assert/strict";
import test from "node:test";

import { canonicalProjectionMessageId, createProjectionMetadata } from "./timeline-projection-v3.js";

const validProjection = {
  gatewayType: "openclaw" as const,
  gatewayId: "gw-test",
  producerId: "main",
  sourceSessionId: "session-test",
  sourceMessageId: "message-test",
  sourceOrderScope: "openclaw:main:session-test",
  sourceOrderSeq: 1,
  sourceRole: "assistant" as const,
};

test("projection v3 requires every source identity component", () => {
  assert.throws(
    () => createProjectionMetadata({ ...validProjection, sourceMessageId: "" }),
    /sourceMessageId/,
  );
  assert.throws(
    () => createProjectionMetadata({ ...validProjection, sourceSessionId: "" }),
    /sourceSessionId/,
  );
  assert.throws(
    () => createProjectionMetadata({ ...validProjection, gatewayId: "" }),
    /gatewayId/,
  );
});

test("projection v3 source order sequence is a positive integer", () => {
  assert.throws(
    () => createProjectionMetadata({ ...validProjection, sourceOrderSeq: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => createProjectionMetadata({ ...validProjection, sourceOrderSeq: 1.5 }),
    /positive integer/,
  );
});

test("projection v3 keeps database identity bounded without dropping source identity fields", () => {
  const longIdentity = {
    ...validProjection,
    gatewayId: "gateway-".concat("g".repeat(400)),
    producerId: "producer-".concat("p".repeat(400)),
    sourceSessionId: "session-".concat("s".repeat(400)),
    sourceMessageId: "message-".concat("m".repeat(400)),
  };
  const projection = createProjectionMetadata(longIdentity);
  const sameSource = createProjectionMetadata(longIdentity);
  const differentMessage = createProjectionMetadata({
    ...longIdentity,
    sourceMessageId: `${longIdentity.sourceMessageId}-different`,
  });

  assert.equal(projection.canonicalMessageId, sameSource.canonicalMessageId);
  assert.notEqual(projection.canonicalMessageId, differentMessage.canonicalMessageId);
  assert.equal(projection.canonicalMessageId, canonicalProjectionMessageId(longIdentity));
  assert.match(projection.canonicalMessageId, /^timeline:v3:openclaw:[0-9a-f]{64}$/);
  assert.ok(projection.canonicalMessageId.length <= 191);
  assert.deepEqual(
    [projection.gatewayType, projection.producerId, projection.sourceSessionId, projection.sourceMessageId],
    ["openclaw", longIdentity.producerId, longIdentity.sourceSessionId, longIdentity.sourceMessageId],
  );
});
