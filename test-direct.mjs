/**
 * Direct test: connect to OpenClaw Gateway and send chat.send
 * Uses same logic as gateway-client.ts
 */
import { WebSocket } from "ws";
import { randomUUID, generateKeyPairSync, createPrivateKey, sign, createPublicKey, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IDENTITY_PATH = join(homedir(), ".clawai", "device-identity.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function rawPublicKeyBytes(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

const stored = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
const identity = { deviceId: stored.deviceId, publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };

const openclawCfg = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
const authToken = openclawCfg?.gateway?.auth?.token;
const port = openclawCfg?.gateway?.port ?? 18789;

console.log("Device ID:", identity.deviceId);
console.log("Auth token:", authToken ? authToken.slice(0, 8) + "..." : "(none)");
console.log("Connecting to ws://localhost:" + port);

const ws = new WebSocket("ws://localhost:" + port, { maxPayload: 25 * 1024 * 1024 });
const pending = new Map();
let connectNonce = null;
let connectSent = false;
let connected = false;

function sendFrame(obj) {
  ws.send(JSON.stringify(obj));
}

function request(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendFrame({ type: "req", id, method, params });
    console.log(`→ req [${id.slice(0, 8)}] ${method}`);
  });
}

function sendConnect(nonce) {
  if (connectSent) return;
  connectSent = true;
  const role = "operator";
  const scopes = ["operator.admin"];
  const clientId = "gateway-client";
  const clientMode = "backend";
  const signedAtMs = Date.now();

  const version = nonce ? "v2" : "v1";
  const payload = [version, identity.deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), authToken ?? "", ...(nonce ? [nonce] : [])].join("|");
  const key = createPrivateKey(identity.privateKeyPem);
  const signature = base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), key));
  const device = {
    id: identity.deviceId,
    publicKey: base64UrlEncode(rawPublicKeyBytes(identity.publicKeyPem)),
    signature,
    signedAt: signedAtMs,
    nonce,
  };

  const params = {
    minProtocol: 3, maxProtocol: 3,
    role, scopes, caps: [], commands: [],
    client: { id: clientId, displayName: "ClawAI Direct Test", version: "1.0.0", platform: process.platform, mode: clientMode },
    device,
    auth: authToken ? { token: authToken } : undefined,
  };

  request("connect", params)
    .then((res) => {
      console.log("✓ connect OK:", JSON.stringify(res).slice(0, 100));
      connected = true;
      runTest();
    })
    .catch((err) => {
      console.error("✗ connect FAILED:", err.message);
      process.exit(1);
    });
}

async function runTest() {
  console.log("\n--- Running test ---");
  try {
    const r1 = await request("sessions.reset", { key: "main" });
    console.log("✓ sessions.reset:", JSON.stringify(r1));

    const r2 = await request("chat.send", {
      sessionKey: "main",
      message: "hello, please reply with just one short sentence",
      idempotencyKey: randomUUID(),
    });
    console.log("✓ chat.send:", JSON.stringify(r2));
    console.log("\nWaiting for chat events...");
  } catch (err) {
    console.error("✗ command failed:", err.message);
    process.exit(1);
  }
}

ws.on("open", () => {
  console.log("WebSocket open, waiting for challenge...");
  setTimeout(() => { if (!connectSent) { console.log("(no challenge, sending connect now)"); sendConnect(null); } }, 1000);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "event") {
    if (msg.event === "connect.challenge") {
      const nonce = msg.payload?.nonce;
      console.log("← challenge nonce:", nonce);
      sendConnect(nonce ?? null);
      return;
    }
    if (msg.event === "chat") {
      const p = msg.payload;
      if (p.state === "delta") {
        process.stdout.write("\r[delta] " + (p.message?.content?.[0]?.text ?? "").slice(-80).padEnd(80));
      } else if (p.state === "final") {
        console.log("\n\n[FINAL] " + (p.message?.content?.[0]?.text ?? "(no text)"));
        ws.close();
        process.exit(0);
      } else if (p.state === "error") {
        console.log("\n[ERROR]", p.errorMessage);
        ws.close();
        process.exit(1);
      }
    } else if (msg.event !== "health" && msg.event !== "presence" && msg.event !== "tick") {
      console.log("\n← event:", msg.event, JSON.stringify(msg.payload ?? {}).slice(0, 80));
    }
    return;
  }
  if (msg.type === "res") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      console.log(`← res [${msg.id.slice(0, 8)}] ok=${msg.ok}` + (msg.error ? " error=" + msg.error.message : ""));
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error?.message ?? "gateway error"));
    }
  }
});

ws.on("close", (code, reason) => {
  console.log("\n← close", code, reason.toString() || "(no reason)");
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (err) => console.error("WS error:", err.message));

setTimeout(() => {
  console.log("\n[timeout 60s]");
  ws.close();
  process.exit(1);
}, 60000);
