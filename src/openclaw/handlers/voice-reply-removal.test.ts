import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHomeDirectory } from "../../test-support/isolated-home.js";

const tempHome = await mkdtemp(join(tmpdir(), "clawconnect-no-voice-reply-"));
const restoreHome = isolateHomeDirectory(tempHome);

const { handleLocalCommand } = await import(`./local-handlers.js?voice-reply-removal=${encodeURIComponent(tempHome)}`);

test.after(async () => {
  restoreHome();
  await rm(tempHome, { recursive: true, force: true });
});

test("removed voice reply config commands are no longer handled locally", () => {
  assert.equal(
    handleLocalCommand("clawconnect.voiceReply.setConfig", {
      voiceReplyVoiceIdentifier: "zh-CN-XiaoxiaoNeural",
      voiceReplyRatePercent: 15,
    }),
    null,
  );
});
