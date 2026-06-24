import { buildOfficeEventPayload } from "../../core/relay/office-payload.js";
import type { OpenClawRelayToServer } from "./relay-manager-protocol.js";

export function publishOfficeSnapshot(
  send: (message: OpenClawRelayToServer) => void,
  eventName: string,
  payload: unknown,
): void {
  const officePayload = buildOfficeEventPayload(eventName, payload, () => new Date().toISOString());
  if (!officePayload) {
    return;
  }
  send({ type: "event", event: "office", payload: officePayload });
}
