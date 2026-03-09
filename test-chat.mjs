import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

const token = readFileSync("/tmp/test_token.txt", "utf8").trim();
const url = `ws://localhost:3000/gw/295c6252c69746124af48ebbe7001f11?token=${token}`;

const ws = new WebSocket(url);

ws.on("open", () => {
  console.log("[ios] connected to relay server");

  ws.send(JSON.stringify({ method: "sessions.reset", params: { key: "main" } }));
  console.log("[ios] → sessions.reset { key: 'main' }");

  setTimeout(() => {
    ws.send(JSON.stringify({
      method: "chat.send",
      params: {
        sessionKey: "main",
        message: "hello, please reply with just one short sentence",
        idempotencyKey: randomUUID(),
      },
    }));
    console.log("[ios] → chat.send");
  }, 800);
});

let lastText = "";
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "connected") { console.log("[ios] ← gateway online"); return; }
  if (msg.type === "disconnected") { console.log("[gateway] ← disconnected:", msg.reason); return; }
  if (msg.type === "event" && msg.event === "chat") {
    const p = msg.payload;
    if (p.state === "delta") {
      const text = p.message?.content?.[0]?.text ?? "";
      if (text !== lastText) {
        process.stdout.write("\r[delta] " + text.slice(-80).padEnd(80));
        lastText = text;
      }
    } else if (p.state === "final") {
      const text = p.message?.content?.[0]?.text ?? "(no text)";
      console.log("\n\n[FINAL RESPONSE]\n" + text);
      ws.close();
      process.exit(0);
    } else if (p.state === "error") {
      console.log("\n[ERROR]", p.errorMessage);
      ws.close();
      process.exit(1);
    }
    return;
  }
  if (msg.event !== "health" && msg.event !== "presence") {
    console.log("[event]", JSON.stringify(msg).slice(0, 120));
  }
});

ws.on("error", (e) => console.error("[ws error]", e.message));
setTimeout(() => {
  console.log("\n[timeout after 60s]");
  ws.close();
  process.exit(1);
}, 60000);
