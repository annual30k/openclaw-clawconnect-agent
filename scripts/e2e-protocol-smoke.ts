import WebSocket from "ws";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { createRequire } from "module";

const relayRequire = createRequire(new URL("../../openclaw-relay-server/package.json", import.meta.url));
const mysql = relayRequire("mysql2/promise");

const PORT = 8999;
const HOST = "127.0.0.1";
const JWT_SECRET = "e5ae43d8d612089f6e7e517ca87d56eab21cc00e692504b18f0cd5c6be7a88de";
const SERVER_LISTEN_TIMEOUT_MS = 5000;
const AGENT_CONNECT_TIMEOUT_MS = 5000;
const PROTOCOL_TIMEOUT_MS = 10000;

function requireTestDatabaseUrl(): { dbUrl: string; dbName: string; url: URL } {
  const dbUrl = process.env.E2E_DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "E2E_DATABASE_URL environment variable is not set.\n" +
      "To run this E2E test, please provide a test database URL, for example:\n" +
      "  E2E_DATABASE_URL=mysql://clawlink:clawlink123@127.0.0.1:3306/clawlink_relay_test?ssl=false npm run test:e2e\n" +
      "Make sure the database name contains 'test' for safety."
    );
  }

  const url = new URL(dbUrl);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName || !dbName.includes("test")) {
    throw new Error(`Safety check failed: E2E database name "${dbName}" must contain "test" to prevent pollution of dev/production database.`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error(`Safety check failed: E2E database name "${dbName}" must contain only letters, numbers, and underscores.`);
  }

  return { dbUrl, dbName, url };
}

function serverDatabaseUrl(url: URL, username = url.username, password = url.password): string {
  const serverUrl = new URL(url.toString());
  serverUrl.username = username;
  serverUrl.password = password;
  serverUrl.pathname = "/";
  return serverUrl.toString();
}

async function assertDatabaseReachable(dbUrl: string, dbName: string): Promise<void> {
  try {
    const conn = await mysql.createConnection(dbUrl);
    await conn.query("SELECT 1");
    await conn.end();
  } catch (error) {
    throw new Error(
      `Unable to connect to E2E test database "${dbName}". ` +
      "Create it first, or rerun with E2E_PROVISION_DB=1 to explicitly allow test database provisioning.\n" +
      `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function provisionTestDatabase(url: URL, dbName: string): Promise<void> {
  const createWith = async (connectionUrl: string, grantToUser = false) => {
    const conn = await mysql.createConnection(connectionUrl);
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      if (grantToUser && url.username) {
        await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'%'`, [decodeURIComponent(url.username)]);
        await conn.query("FLUSH PRIVILEGES");
      }
    } finally {
      await conn.end();
    }
  };

  try {
    await createWith(serverDatabaseUrl(url));
    return;
  } catch (error) {
    const rootPassword = process.env.MYSQL_ROOT_PASSWORD ?? "root";
    console.log(`Test database provisioning with "${decodeURIComponent(url.username)}" failed; trying root because E2E_PROVISION_DB=1.`);
    try {
      await createWith(serverDatabaseUrl(url, "root", rootPassword), true);
    } catch {
      throw error;
    }
  }
}

async function waitForServerListening(server: import("node:http").Server): Promise<void> {
  if (server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Relay server did not start listening within ${SERVER_LISTEN_TIMEOUT_MS}ms`));
    }, SERVER_LISTEN_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function main() {
  console.log("=== Starting E2E Protocol Smoke Test ===");

  const { dbUrl, dbName, url: dbUrlObject } = requireTestDatabaseUrl();
  if (process.env.E2E_PROVISION_DB === "1") {
    console.log(`Provisioning E2E test database "${dbName}" because E2E_PROVISION_DB=1.`);
    await provisionTestDatabase(dbUrlObject, dbName);
  }
  await assertDatabaseReachable(dbUrl, dbName);

  // Create temporary directories
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-"));
  const tempHermesDir = path.join(tempDir, "hermes");
  const tempRelayDataDir = path.join(tempDir, "relay-data");
  
  fs.mkdirSync(tempHermesDir, { recursive: true });
  fs.mkdirSync(path.join(tempHermesDir, "logs"), { recursive: true });
  fs.mkdirSync(tempRelayDataDir, { recursive: true });

  const agentLogPath = path.join(tempHermesDir, "logs", "agent.log");
  fs.writeFileSync(agentLogPath, "");

  // Create mock python CLI
  const mockPythonPath = path.join(tempDir, "mock-python.js");
  const mockPythonContent = `#!/usr/bin/env node
console.log("[]");
process.exit(0);
`;
  fs.writeFileSync(mockPythonPath, mockPythonContent);
  fs.chmodSync(mockPythonPath, 0o755);

  // Create mock hermes CLI
  const mockHermesPath = path.join(tempDir, "mock-hermes.js");
  const mockHermesContent = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

if (args[0] === 'sessions' && args[1] === 'list') {
  console.log("Title               Preview             Last Active         Session ID");
  console.log("─                   ─                   ─                   ─");
  console.log("My Session          Hello E2E           Just now            20260523_154000_abcd1234");
  process.exit(0);
}

if (args[0] === 'status') {
  console.log("Model: fake-model");
  console.log("Provider: fake-provider");
  process.exit(0);
}

if (args[0] === 'sessions' && args[1] === 'export') {
  console.log(JSON.stringify({
    model: "fake-model",
    input_tokens: 120,
    context_limit: 8192
  }));
  process.exit(0);
}

if (args[0] === 'chat') {
  // Let's print out the typing marker or just print the response stream
  console.log("Hello! I am a fake Hermes agent responding to your message.");
  console.log("This is the second line of the response.");

  const hermesHome = process.env.HERMES_HOME;
  if (hermesHome) {
    const logFile = path.join(hermesHome, 'logs', 'agent.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // Write tool log events matching parseHermesToolLogLine
    fs.appendFileSync(logFile, "2026-05-23 15:40:03.123 [INFO] agent.tool_executor: tool search_web running\\n");
    fs.appendFileSync(logFile, "2026-05-23 15:40:03.456 [INFO] tools.search_web_tool: searching Google for openclaw...\\n");
    fs.appendFileSync(logFile, "2026-05-23 15:40:03.789 [INFO] agent.tool_executor: tool search_web completed\\n");
  }
  process.exit(0);
}

process.exit(0);
`;
  fs.writeFileSync(mockHermesPath, mockHermesContent);
  fs.chmodSync(mockHermesPath, 0o755);

  // Set environment variables for server startup & subprocess resolution
  process.env.NODE_ENV = "test";
  process.env.PORT = String(PORT);
  process.env.HOST = HOST;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DATABASE_URL = dbUrl;
  process.env.FILE_STORAGE_DRIVER = "disk";
  process.env.DATA_DIR = tempRelayDataDir;
  
  process.env.HERMES_BIN = mockHermesPath;
  process.env.HERMES_PYTHON = mockPythonPath;
  process.env.HERMES_HOME = tempHermesDir;
  process.env.CLAWCONNECT_HERMES_SESSION_STORE = path.join(tempHermesDir, "sessions.json");

  // Dynamically import local modules after environment variables are set
  const { startRelayApp } = await import("../../openclaw-relay-server/src/app/createRelayApp.ts");
  const { runHermesRelayManager } = await import("../src/hermes/hermes-relay-manager.ts");

  console.log("1. Starting Relay Server on port", PORT);
  const relayApp = await startRelayApp();
  await waitForServerListening(relayApp.server);
  console.log("Relay Server started and listening successfully.");

  const pool = relayApp.store.poolInstance;
  const testEmail = `e2e-${randomUUID().slice(0, 8)}@example.com`;
  const testPassword = "test-password-123";
  const deviceId = `e2e_device_${randomUUID().slice(0, 8)}`;
  
  let registeredGatewayId = "";
  let registeredRelaySecret = "";
  let accessCode = "";
  let agentAbortController: AbortController | undefined;
  let mobileWs: WebSocket | undefined;

  try {
    console.log("2. Registering Gateway via HTTP...");
    const regRes = await fetch(`http://${HOST}:${PORT}/api/relay/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "E2E Test Host",
        platform: os.platform(),
        agentVersion: "0.1.0",
        gatewayType: "hermes",
        capabilities: ["models", "chat"]
      })
    });
    
    if (!regRes.ok) {
      throw new Error(`Failed to register gateway: ${regRes.status} ${await regRes.text()}`);
    }
    
    const regData = await regRes.json() as any;
    registeredGatewayId = regData.gatewayId;
    registeredRelaySecret = regData.relaySecret;
    accessCode = regData.accessCode;
    console.log(`Gateway registered: ${registeredGatewayId}, accessCode=${accessCode}`);

    console.log("3. Registering Mobile User via HTTP...");
    const userRes = await fetch(`http://${HOST}:${PORT}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        name: "E2E User",
        deviceId,
        platform: "ios"
      })
    });

    if (!userRes.ok) {
      throw new Error(`Failed to register user: ${userRes.status} ${await userRes.text()}`);
    }

    const userData = await userRes.json() as any;
    const initialToken = userData.accessToken;
    console.log("User registered. Access token obtained.");

    console.log("4. Pairing Mobile with Gateway...");
    const pairRes = await fetch(`http://${HOST}:${PORT}/api/mobile/pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${initialToken}`
      },
      body: JSON.stringify({
        gatewayId: registeredGatewayId,
        accessCode,
        deviceId,
        platform: "ios",
        gatewayType: "hermes"
      })
    });

    if (!pairRes.ok) {
      throw new Error(`Failed to pair: ${pairRes.status} ${await pairRes.text()}`);
    }

    const pairData = await pairRes.json() as any;
    const pairedAccessToken = pairData.accessToken;
    console.log("Pairing successful. Paired Access Token obtained.");

    console.log("5. Starting ClawConnect Agent runtime manager...");
    agentAbortController = new AbortController();
    
    let resolveConnected!: () => void;
    let rejectConnected!: (err: Error) => void;
    const agentConnectedPromise = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });

    const agentTimeoutTimer = setTimeout(() => {
      rejectConnected(new Error("Timeout waiting for Agent manager to connect to relay"));
    }, AGENT_CONNECT_TIMEOUT_MS);
    agentTimeoutTimer.unref?.();

    // Spawn agent and catch early disconnection/rejection
    const agentPromise = runHermesRelayManager({
      relayServerUrl: `http://${HOST}:${PORT}`,
      gatewayId: registeredGatewayId,
      relaySecret: registeredRelaySecret,
      signal: agentAbortController.signal,
      onConnected: () => {
        console.log("Agent manager connected to relay.");
        clearTimeout(agentTimeoutTimer);
        resolveConnected();
      }
    }).then((val) => {
      clearTimeout(agentTimeoutTimer);
      rejectConnected(new Error("Agent manager exited or disconnected early from relay"));
      return val;
    }).catch((err) => {
      clearTimeout(agentTimeoutTimer);
      rejectConnected(err);
      throw err;
    });

    await agentConnectedPromise;

    console.log("6. Connecting Mobile WebSocket Client...");
    const mobileWsClient = new WebSocket(`ws://${HOST}:${PORT}/mobile/ws?accessToken=${pairedAccessToken}`);
    mobileWs = mobileWsClient;

    const wsHelloPromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Mobile WS hello timeout")), 5000);
      mobileWsClient.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "hello") {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });

    const helloMsg = await wsHelloPromise;
    console.log("Received Mobile WS hello message:", JSON.stringify(helloMsg));

    // Verify gateways list in hello payload
    const foundGateway = helloMsg.payload?.gateways?.find((g: any) => g.gatewayId === registeredGatewayId);
    if (!foundGateway) {
      throw new Error("Registered gateway not found in Mobile WS hello payload!");
    }
    console.log("Verified: Mobile client possesses access to paired gateway.");

    console.log("7. Sending chat.send command from Mobile WS client...");
    const chatCmdId = "e2e-chat-cmd-1";
    mobileWsClient.send(JSON.stringify({
      type: "cmd",
      id: chatCmdId,
      gatewayId: registeredGatewayId,
      method: "hermes.chat.send",
      params: {
        message: "Hello Hermes, run a web search for OpenClaw.",
        sessionKey: "main"
      }
    }));

    console.log("8. Listening for response and events...");
    let ackReceived = false;
    let toolStartReceived = false;
    let toolStreamReceived = false;
    let toolCompleteReceived = false;
    let assistantDeltaReceived = false;
    let finalAssistantReceived = false;
    let runtimeMetadataReceived = foundGateway.currentModel === "fake-model";

    const testFinishedPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("E2E Protocol check timeout waiting for WS messages")), PROTOCOL_TIMEOUT_MS);

      const maybeResolve = () => {
        if (
          ackReceived &&
          toolStartReceived &&
          toolStreamReceived &&
          toolCompleteReceived &&
          assistantDeltaReceived &&
          finalAssistantReceived &&
          runtimeMetadataReceived
        ) {
          clearTimeout(timeout);
          resolve();
        }
      };
      
      mobileWsClient.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        console.log("-> Mobile WS Event:", JSON.stringify(msg));

        if (msg.type === "res" && msg.id === chatCmdId) {
          if (msg.ok) {
            ackReceived = true;
            console.log("[PASS] Received Command ACK");
            maybeResolve();
          } else {
            reject(new Error(`Command failed on Relay: ${JSON.stringify(msg.error)}`));
          }
        }

        if (msg.type === "event" && msg.event === "office") {
          const payload = msg.payload ?? {};
          if (payload.currentModel === "fake-model") {
            runtimeMetadataReceived = true;
            console.log("[PASS] Runtime model metadata verified");
            maybeResolve();
          }
        }

        if (msg.type === "event" && msg.event === "chat") {
          const payload = msg.payload;
          
          // Tool streaming/executing phase
          if (payload.stream === "tool") {
            const data = payload.data;
            if (data.tool_name === "search_web") {
              if ((payload.phase === "streaming" || payload.state === "streaming") && data.text?.includes("running")) {
                toolStartReceived = true;
                console.log("[PASS] Received tool start/running event");
              } else if (payload.phase === "streaming" || payload.state === "streaming") {
                toolStreamReceived = true;
                console.log("[PASS] Received tool streaming log event");
              } else if (payload.phase === "completed" || payload.state === "completed") {
                toolCompleteReceived = true;
                console.log("[PASS] Received tool completed event");
              }
            }
          }

          for (const event of payload.timelineEvents ?? []) {
            const content = Array.isArray(event.content) ? event.content : [];
            const firstBlock = content[0] ?? {};
            if (event.eventType === "tool.invocation.updated" && String(firstBlock.name ?? "").includes("search_web")) {
              const text = String(firstBlock.text ?? "");
              if (event.toolState === "streaming_output" && text.includes("running")) {
                toolStartReceived = true;
                console.log("[PASS] Received canonical tool start/running event");
              } else if (event.toolState === "streaming_output") {
                toolStreamReceived = true;
                console.log("[PASS] Received canonical tool streaming log event");
              } else if (event.toolState === "success") {
                toolCompleteReceived = true;
                console.log("[PASS] Received canonical tool completed event");
              }
            }

            if (event.eventType === "message.part.delta" && event.role === "assistant") {
              assistantDeltaReceived = true;
            }

            if (event.eventType === "message.completed" && event.role === "assistant") {
              const textContent = content
                .map((block: any) => typeof block.text === "string" ? block.text : "")
                .join("\n");
              finalAssistantReceived = true;
              console.log("[PASS] Received canonical final assistant message event");
              if (textContent.includes("Hello! I am a fake Hermes agent") && textContent.includes("second line")) {
                console.log("[PASS] Canonical final assistant text content verified");
              } else {
                reject(new Error(`Incorrect canonical final assistant text content: ${textContent}`));
              }
            }
          }

          // Assistant text delta
          if (payload.role === "assistant" && payload.state === "delta" && payload.delta) {
            assistantDeltaReceived = true;
          }

          // Assistant final message
          if (payload.role === "assistant" && payload.state === "final" && !payload.delta) {
            const textContent = payload.message?.content?.[0]?.text ?? "";
            finalAssistantReceived = true;
            console.log("[PASS] Received final assistant message event");
            
            // Check if final message has the correct expected text from mock hermes
            if (textContent.includes("Hello! I am a fake Hermes agent") && textContent.includes("second line")) {
              console.log("[PASS] Final assistant text content verified");
            } else {
              reject(new Error(`Incorrect final assistant text content: ${textContent}`));
            }

            // Verify usage metadata when the legacy top-level payload includes it.
            if (payload.currentModel === "fake-model") {
              runtimeMetadataReceived = true;
              console.log("[PASS] Final assistant model metadata verified");
            }
          }
          maybeResolve();
        }
      });
    });

    // Use Promise.race to abort if the agent exits or crashes early
    await Promise.race([
      testFinishedPromise,
      agentPromise.then(() => {
        throw new Error("Agent manager exited unexpectedly before test completion");
      })
    ]);

    console.log("9. Shutting down agent client...");
    agentAbortController.abort();
    mobileWsClient.close();

    console.log("10. Asserting E2E criteria...");
    if (!ackReceived) throw new Error("Missing Command ACK");
    if (!toolStartReceived) throw new Error("Missing Tool Start Event");
    if (!toolStreamReceived) throw new Error("Missing Tool Log Streaming Event");
    if (!toolCompleteReceived) throw new Error("Missing Tool Log Completion Event");
    if (!assistantDeltaReceived) throw new Error("Missing Assistant Text Deltas");
    if (!finalAssistantReceived) throw new Error("Missing Final Assistant Response");
    if (!runtimeMetadataReceived) throw new Error("Missing Runtime Metadata");
    
    console.log("=== ALL PROTOCOL E2E CHECKS PASSED SUCCESSFULLY ===");

  } catch (error) {
    console.error("!!! E2E Test Failed !!!", error);
    process.exitCode = 1;
  } finally {
    console.log("11. E2E Teardown & Database Cleanup...");

    if (agentAbortController && !agentAbortController.signal.aborted) {
      agentAbortController.abort();
    }
    if (mobileWs && mobileWs.readyState < WebSocket.CLOSING) {
      mobileWs.close();
    }

    try {
      console.log("Stopping Relay Server...");
      await relayApp.stop();
      console.log("Relay Server stopped.");
    } catch (stopErr) {
      console.error("Failed to stop Relay Server:", stopErr);
    }
    
    try {
      if (registeredGatewayId) {
        console.log("Purging test gateway & user records...");
        await pool.query("DELETE FROM gateway_memberships WHERE gateway_id = ?", [registeredGatewayId]);
        await pool.query("DELETE FROM gateway_pairing_codes WHERE gateway_id = ?", [registeredGatewayId]);
        await pool.query("DELETE FROM gateway_runtime_state WHERE gateway_id = ?", [registeredGatewayId]);
        await pool.query("DELETE FROM gateways WHERE id = ?", [registeredGatewayId]);
      }
      
      await pool.query("DELETE FROM users WHERE email = ?", [testEmail]);
      console.log("Database cleanup finished.");
    } catch (dbErr) {
      console.error("Failed to clean up database records:", dbErr);
    }

    try {
      console.log("Deleting temporary directories:", tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log("Temporary directory cleaned up.");
    } catch (rmErr) {
      console.error("Failed to delete temp directory:", rmErr);
    }

    console.log("Exiting with status", process.exitCode || 0);
    process.exit(process.exitCode || 0);
  }
}

main().catch((err) => {
  console.error("Fatal uncaught error in main E2E execution:", err);
  process.exit(1);
});
