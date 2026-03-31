import assert from "assert/strict";
import test from "node:test";
import { join } from "path";
import {
  buildAttachmentStagingPath,
  extensionForMimeType,
  resolveAttachmentFileName,
  resolveAttachmentMimeType,
} from "./attachment-staging.js";

test("attachment staging preserves non-image file names and extensions", () => {
  const stagedPath = buildAttachmentStagingPath(
    {
      fileName: "../Project Plan.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    "/tmp/outbound",
    "fixed-id",
  );

  assert.equal(stagedPath, join("/tmp/outbound", "fixed-id", "Project Plan.docx"));
  assert.equal(
    resolveAttachmentFileName({
      fileName: "../Project Plan.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "Project Plan.docx",
  );
  assert.equal(
    resolveAttachmentMimeType({
      fileName: "../Project Plan.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("attachment staging infers names from mime type when file name is missing", () => {
  const stagedPath = buildAttachmentStagingPath(
    {
      mimeType: "audio/mpeg",
    },
    "/tmp/outbound",
    "fixed-id",
  );

  assert.equal(stagedPath, join("/tmp/outbound", "fixed-id", "attachment.mp3"));
  assert.equal(resolveAttachmentFileName({ mimeType: "audio/mpeg" }), "attachment.mp3");
  assert.equal(extensionForMimeType("audio/mpeg"), ".mp3");
  assert.equal(extensionForMimeType("application/octet-stream"), ".bin");
});
