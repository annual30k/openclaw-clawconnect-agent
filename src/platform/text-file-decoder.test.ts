import assert from "node:assert/strict";
import test from "node:test";
import { decodeTextBuffer } from "./text-file-decoder.js";

test("decodeTextBuffer reads Windows UTF-16LE logs with and without BOM", () => {
  const text = "启动 ClawConnect\r\n网关已连接";
  const body = Buffer.from(text, "utf16le");
  assert.deepEqual(decodeTextBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), body])), {
    text,
    encoding: "utf16le",
  });
  assert.deepEqual(decodeTextBuffer(body), { text, encoding: "utf16le" });
});

test("decodeTextBuffer keeps UTF-8 Chinese logs intact", () => {
  assert.deepEqual(decodeTextBuffer(Buffer.from("连接成功 ✓", "utf8")), {
    text: "连接成功 ✓",
    encoding: "utf8",
  });
});
