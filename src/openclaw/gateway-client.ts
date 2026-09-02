import {
  GatewayClient,
  type DeviceAuthTokenRecord,
  type DeviceIdentity,
} from "@openclaw/gateway-client";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "@openclaw/gateway-protocol/client-info";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  setRestrictiveDirPermissions,
  setRestrictiveFilePermissions,
} from "../platform/service-manager-common.js";
import { CLAWCONNECT_AGENT_VERSION } from "../runtime-metadata.js";

const IDENTITY_PATH = join(homedir(), ".clawconnect", "device-identity.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_CLIENT_ID = GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
const DEFAULT_CLIENT_MODE = GATEWAY_CLIENT_MODES.WEBCHAT;
const DEFAULT_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function rawPublicKeyBytes(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function loadOrCreateDeviceIdentity(): DeviceIdentity {
  if (existsSync(IDENTITY_PATH)) {
    try {
      const stored = JSON.parse(readFileSync(IDENTITY_PATH, "utf8")) as DeviceIdentity;
      if (stored.deviceId && stored.publicKeyPem && stored.privateKeyPem) {
        return stored;
      }
    } catch {
      // Generate a replacement below when the persisted identity is unreadable.
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = createHash("sha256").update(rawPublicKeyBytes(publicKeyPem)).digest("hex");
  const identity: DeviceIdentity = { deviceId, publicKeyPem, privateKeyPem };

  const clawconnectDir = join(homedir(), ".clawconnect");
  mkdirSync(clawconnectDir, { recursive: true });
  writeFileSync(
    IDENTITY_PATH,
    `${JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2)}\n`,
    "utf8",
  );
  setRestrictiveDirPermissions(clawconnectDir);
  setRestrictiveFilePermissions(IDENTITY_PATH);
  return identity;
}

export function gatewayWebSocketOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else throw new Error(`unsupported gateway websocket protocol: ${parsed.protocol}`);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

export interface GatewayClientOptions {
  url: string | (() => string);
  token?: string;
  password?: string;
  role?: string;
  scopes?: string[];
  caps?: string[];
  clientMode?: GatewayClientMode;
  clientId?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  onConnected: () => void;
  onEvent: (eventName: string, payload: unknown) => void;
  onDisconnected: (reason: string) => void;
}

/**
 * ClawConnect's compatibility wrapper around OpenClaw's reference v4 client.
 *
 * ClawConnect is a WebChat bridge, not the bundled Control UI. Advertising the
 * WebChat identity preserves chat routing while avoiding Control UI build-ID
 * checks that third-party clients cannot satisfy.
 */
export class OpenClawGatewayClient {
  private client: GatewayClient | null = null;
  private activeUrl: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private storedDeviceAuth: DeviceAuthTokenRecord | null = null;
  private responseHookRequests = 0;
  private bufferedEvents: Array<{ event: string; payload: unknown }> = [];
  private readonly identity = loadOrCreateDeviceIdentity();

  constructor(private readonly opts: GatewayClientOptions) {}

  start(): void {
    if (this.stopped || this.client) return;
    const url = this.resolveUrl();
    this.activeUrl = url;

    const client = new GatewayClient({
      url,
      origin: gatewayWebSocketOrigin(url),
      token: this.opts.token,
      password: this.opts.password,
      role: this.opts.role ?? "operator",
      scopes: this.opts.scopes ?? DEFAULT_SCOPES,
      caps: this.opts.caps ?? ["tool-events"],
      clientName: this.opts.clientId ?? DEFAULT_CLIENT_ID,
      clientDisplayName: this.opts.clientDisplayName ?? "ClawConnect Agent",
      clientVersion: this.opts.clientVersion ?? CLAWCONNECT_AGENT_VERSION,
      platform: process.platform,
      mode: this.opts.clientMode ?? DEFAULT_CLIENT_MODE,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      deviceIdentity: this.identity,
      hostDeps: {
        signDevicePayload: (privateKeyPem, payload) => base64UrlEncode(
          sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)),
        ),
        publicKeyRawBase64UrlFromPem: (publicKeyPem) => base64UrlEncode(
          rawPublicKeyBytes(publicKeyPem),
        ),
        loadDeviceAuthToken: () => this.storedDeviceAuth,
        storeDeviceAuthToken: ({ token, scopes }) => {
          this.storedDeviceAuth = { token, scopes };
        },
        clearDeviceAuthToken: () => {
          this.storedDeviceAuth = null;
        },
        logDebug: (message) => console.debug(`[gateway-client] ${message}`),
        logError: (message) => console.error(`[gateway-client] ${message}`),
      },
      onHelloOk: () => this.opts.onConnected(),
      onConnectError: (error) => {
        console.error(`[gateway-client] connect failed: ${String(error)}`);
      },
      onEvent: (event) => {
        if (event.event === "tick") return;
        const bufferedEvent = { event: event.event, payload: event.payload ?? null };
        if (this.responseHookRequests > 0) {
          this.bufferedEvents.push(bufferedEvent);
          return;
        }
        this.opts.onEvent(bufferedEvent.event, bufferedEvent.payload);
      },
      onClose: (code, reason) => {
        const reasonText = reason || `code ${code}`;
        this.opts.onDisconnected(reasonText);
        this.recreateForChangedUrl(client);
      },
    });

    this.client = client;
    client.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client?.stop();
    this.client = null;
    this.activeUrl = null;
  }

  send(method: string, params?: unknown): void {
    void this.request(method, params).catch((error: unknown) => {
      console.error(`[gateway-client] ${method} failed: ${String(error)}`);
    });
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { onResponse?: (value: T) => void },
  ): Promise<T> {
    if (!this.client) throw new Error("gateway not connected");
    const hasResponseHook = Boolean(options?.onResponse);
    if (hasResponseHook) this.responseHookRequests += 1;
    try {
      const value = await this.client.request<T>(method, params);
      options?.onResponse?.(value);
      return value;
    } finally {
      if (hasResponseHook) {
        this.responseHookRequests -= 1;
        if (this.responseHookRequests === 0) this.flushBufferedEvents();
      }
    }
  }

  private resolveUrl(): string {
    return typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
  }

  private recreateForChangedUrl(closedClient: GatewayClient): void {
    if (this.stopped || this.client !== closedClient) return;
    const nextUrl = this.resolveUrl();
    if (nextUrl === this.activeUrl) return;

    closedClient.stop();
    this.client = null;
    this.activeUrl = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 0);
    this.reconnectTimer.unref?.();
  }

  private flushBufferedEvents(): void {
    const events = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const event of events) this.opts.onEvent(event.event, event.payload);
  }
}
