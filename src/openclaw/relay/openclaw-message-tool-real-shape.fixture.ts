/**
 * Sanitized fixture captured from the installed OpenClaw transcript_events
 * shape (toolResult.details.sourceReply), with local paths and run IDs replaced
 * by test values. The installed AssistantMessage.openclawDelivery type does
 * not contain the identity fields; those live on this structured tool result.
 */
export function realOpenClawMessageToolResultFixture(params: {
  runId: string;
  toolCallId: string;
  idempotencyKey: string;
  mediaUrls: string[];
}): Record<string, unknown> {
  const firstUrl = params.mediaUrls[0] ?? "";
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: "message",
    content: [{ type: "text", text: "Sent visible reply to the current source conversation via internal-ui." }],
    details: {
      status: "ok",
      deliveryStatus: "sent",
      channel: "webchat",
      target: "current-run",
      sourceReplyDeliveryMode: "message_tool_only",
      idempotencyKey: params.idempotencyKey,
      sourceReplyTranscriptOwner: true,
      sourceReplySink: "internal-ui",
      sourceReply: {
        text: "",
        mediaUrl: firstUrl,
        mediaUrls: params.mediaUrls,
        attachments: params.mediaUrls.map((url, index) => ({
          name: `image-${index + 1}.png`,
          mimeType: "image/png",
          trustedLocalMedia: true,
          url,
        })),
        trustedLocalMedia: true,
      },
      mediaUrl: firstUrl,
      mediaUrls: params.mediaUrls,
      dryRun: false,
      messageDelivery: {
        status: "settled",
        partialDelivery: false,
        createdThreadIds: [],
      },
    },
    isError: false,
    __openclaw: { runId: params.runId },
  };
}
