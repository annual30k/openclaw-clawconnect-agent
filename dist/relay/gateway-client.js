import { WebSocket } from "ws";
import { randomUUID, generateKeyPairSync, createPrivateKey, sign, createPublicKey, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setRestrictiveDirPermissions, setRestrictiveFilePermissions, } from "../platform/service-manager-common.js";
// ---------------------------------------------------------------------------
// Device identity (Ed25519, persisted across restarts)
// ---------------------------------------------------------------------------
const IDENTITY_PATH = join(homedir(), ".clawconnect", "device-identity.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf) {
    return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function rawPublicKeyBytes(publicKeyPem) {
    const key = createPublicKey(publicKeyPem);
    const spki = key.export({ type: "spki", format: "der" });
    if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}
function loadOrCreateDeviceIdentity() {
    if (existsSync(IDENTITY_PATH)) {
        try {
            const stored = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
            if (stored.deviceId && stored.publicKeyPem && stored.privateKeyPem) {
                return { deviceId: stored.deviceId, publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };
            }
        }
        catch { /* fall through */ }
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const deviceId = createHash("sha256").update(rawPublicKeyBytes(publicKeyPem)).digest("hex");
    const identity = { deviceId, publicKeyPem, privateKeyPem };
    const clawconnectDir = join(homedir(), ".clawconnect");
    mkdirSync(clawconnectDir, { recursive: true });
    writeFileSync(IDENTITY_PATH, JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2) + "\n", "utf8");
    setRestrictiveDirPermissions(clawconnectDir);
    setRestrictiveFilePermissions(IDENTITY_PATH);
    return identity;
}
function buildSignedDevice(identity, opts) {
    const version = opts.nonce ? "v2" : "v1";
    const payload = [
        version,
        identity.deviceId,
        opts.clientId,
        opts.clientMode,
        opts.role,
        opts.scopes.join(","),
        String(opts.signedAtMs),
        opts.token ?? "",
        ...(version === "v2" ? [opts.nonce ?? ""] : []),
    ].join("|");
    const key = createPrivateKey(identity.privateKeyPem);
    const signature = base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), key));
    return {
        id: identity.deviceId,
        publicKey: base64UrlEncode(rawPublicKeyBytes(identity.publicKeyPem)),
        signature,
        signedAt: opts.signedAtMs,
        nonce: opts.nonce,
    };
}
const PROTOCOL_VERSION = 3;
export class OpenClawGatewayClient {
    opts;
    ws = null;
    pending = new Map();
    backoffMs = 1000;
    stopped = false;
    connectNonce = null;
    connectSent = false;
    storedDeviceToken = null;
    connectTimer = null;
    tickTimer = null;
    lastTick = 0;
    tickIntervalMs = 30_000;
    identity;
    constructor(opts) {
        this.opts = opts;
        this.identity = loadOrCreateDeviceIdentity();
    }
    start() {
        if (this.stopped)
            return;
        this.ws = new WebSocket(this.resolveUrl(), { maxPayload: 25 * 1024 * 1024 });
        this.ws.on("open", () => {
            this.connectNonce = null;
            this.connectSent = false;
            // Fallback: send connect after 1 s if challenge hasn't arrived
            this.connectTimer = setTimeout(() => this.sendConnect(), 1000);
        });
        this.ws.on("message", (data) => {
            const raw = typeof data === "string" ? data : data.toString();
            this.handleMessage(raw);
        });
        this.ws.on("close", (code, reason) => {
            const reasonText = reason.toString() || `code ${code}`;
            this.teardown();
            this.flushPending(new Error(`gateway disconnected: ${reasonText}`));
            this.opts.onDisconnected(reasonText);
            this.scheduleReconnect();
        });
        this.ws.on("error", (err) => {
            console.error(`[gateway-client] ws error: ${String(err)}`);
        });
    }
    stop() {
        this.stopped = true;
        this.teardown();
        this.ws?.close();
        this.ws = null;
        this.flushPending(new Error("gateway client stopped"));
    }
    send(method, params) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("gateway not connected");
        }
        const frame = { type: "req", id: randomUUID(), method, params };
        this.ws.send(JSON.stringify(frame));
    }
    async request(method, params) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("gateway not connected");
        }
        const id = randomUUID();
        const frame = { type: "req", id, method, params };
        const p = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: (v) => resolve(v), reject });
        });
        this.ws.send(JSON.stringify(frame));
        return p;
    }
    // -------------------------------------------------------------------------
    resolveUrl() {
        return typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
    }
    sendConnect() {
        if (this.connectSent)
            return;
        this.connectSent = true;
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        const role = this.opts.role ?? "operator";
        const scopes = this.opts.scopes ?? [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
        ];
        const clientId = this.opts.clientId ?? "openclaw-macos";
        const clientMode = this.opts.clientMode ?? "ui";
        const caps = this.opts.caps ?? ["tool-events"];
        const signedAtMs = Date.now();
        const nonce = this.connectNonce ?? undefined;
        const authToken = this.storedDeviceToken ?? this.opts.token;
        const device = buildSignedDevice(this.identity, {
            clientId, clientMode, role, scopes, signedAtMs,
            token: authToken ?? undefined,
            nonce,
        });
        const params = {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            role,
            scopes,
            caps,
            client: {
                id: clientId,
                displayName: this.opts.clientDisplayName ?? "ClawConnect Agent",
                version: this.opts.clientVersion ?? "1.0.0",
                platform: process.platform,
                mode: clientMode,
            },
            device,
            auth: authToken || this.opts.password
                ? { token: authToken, password: this.opts.password }
                : undefined,
        };
        this.request("connect", params)
            .then((helloOk) => {
            const deviceToken = helloOk?.auth?.deviceToken;
            if (typeof deviceToken === "string") {
                this.storedDeviceToken = deviceToken;
            }
            if (typeof helloOk?.policy?.tickIntervalMs === "number") {
                this.tickIntervalMs = helloOk.policy.tickIntervalMs;
            }
            this.backoffMs = 1000;
            this.lastTick = Date.now();
            this.startTickWatch();
            this.opts.onConnected();
        })
            .catch((err) => {
            console.error(`[gateway-client] connect failed: ${String(err)}`);
            // Clear stale device token so the next reconnect uses the base token from config
            this.storedDeviceToken = null;
            this.ws?.close(1008, "connect failed");
        });
    }
    handleMessage(raw) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (typeof parsed?.type !== "string")
            return;
        if (parsed.type === "event") {
            const evt = parsed;
            if (evt.event === "connect.challenge") {
                const nonce = evt.payload?.nonce;
                if (typeof nonce === "string") {
                    this.connectNonce = nonce;
                    this.sendConnect();
                }
                return;
            }
            if (evt.event === "tick") {
                this.lastTick = Date.now();
                return;
            }
            this.opts.onEvent(evt.event, evt.payload ?? null);
            return;
        }
        if (parsed.type === "res") {
            const res = parsed;
            const pending = this.pending.get(res.id);
            if (!pending)
                return;
            this.pending.delete(res.id);
            if (res.ok)
                pending.resolve(res.payload);
            else
                pending.reject(new Error(res.error?.message ?? "gateway error"));
            return;
        }
        // Handle incoming req frames from OpenClaw. Ack immediately so the
        // gateway doesn't retry control-plane requests at this relay client.
        if (parsed.type === "req") {
            const id = parsed.id;
            // Ack immediately so OpenClaw doesn't retry
            if (id && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "res", id, ok: true }));
            }
            return;
        }
    }
    startTickWatch() {
        if (this.tickTimer)
            clearInterval(this.tickTimer);
        const interval = Math.max(this.tickIntervalMs, 1000);
        this.tickTimer = setInterval(() => {
            if (this.stopped || !this.lastTick)
                return;
            if (Date.now() - this.lastTick > this.tickIntervalMs * 2) {
                this.ws?.close(4000, "tick timeout");
            }
        }, interval);
    }
    scheduleReconnect() {
        if (this.stopped)
            return;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        setTimeout(() => this.start(), delay).unref();
    }
    teardown() {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }
    flushPending(err) {
        for (const p of this.pending.values())
            p.reject(err);
        this.pending.clear();
    }
}
//# sourceMappingURL=gateway-client.js.map