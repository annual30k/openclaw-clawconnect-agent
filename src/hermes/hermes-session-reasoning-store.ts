import { existsSync } from "fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * Hermes 会话级思考等级覆盖的本地持久化。
 *
 * 覆盖值只保存在 ClawConnect 侧，绝不写入 Hermes 的 config.yaml，
 * 以免一个移动会话的设置影响 Hermes 的其他客户端或会话。
 * 存储的是契约词表中的等级 ID（例如 off），发送给 Hermes 前再映射为 Hermes effort。
 */

/** 未携带 gatewayId 的调用统一归入该作用域，读写两侧必须使用同一规则。 */
export const DEFAULT_HERMES_REASONING_GATEWAY_SCOPE = "default";

type StoredHermesSessionReasoning = {
  gatewayId: string;
  sessionKey: string;
  level: string;
  updatedAt: string;
};

type ReasoningStoreShape = {
  version: 1;
  sessions: Record<string, StoredHermesSessionReasoning>;
};

let reasoningStoreMutationChain: Promise<void> = Promise.resolve();

function reasoningStorePath(): string {
  return process.env.CLAWCONNECT_HERMES_REASONING_STORE
    ?? join(homedir(), ".clawconnect", "hermes", "reasoning-efforts.json");
}

/** 存储键 = gatewayId + NUL + sessionKey；NUL 不会出现在合法会话键中，保证键不冲突。 */
function reasoningStoreKey(gatewayId: string | undefined, sessionKey: string): string {
  return `${resolveHermesReasoningGatewayScope(gatewayId)}\u0000${sessionKey}`;
}

export function resolveHermesReasoningGatewayScope(gatewayId: string | undefined): string {
  return gatewayId?.trim() || DEFAULT_HERMES_REASONING_GATEWAY_SCOPE;
}

export async function readHermesSessionReasoningLevel(
  gatewayId: string | undefined,
  sessionKey: string,
): Promise<string | undefined> {
  const store = await readReasoningStore();
  return store.sessions[reasoningStoreKey(gatewayId, sessionKey)]?.level;
}

export async function rememberHermesSessionReasoningLevel(
  gatewayId: string | undefined,
  sessionKey: string,
  level: string,
): Promise<void> {
  await mutateReasoningStore((store) => {
    store.sessions[reasoningStoreKey(gatewayId, sessionKey)] = {
      gatewayId: resolveHermesReasoningGatewayScope(gatewayId),
      sessionKey,
      level,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function forgetHermesSessionReasoningLevels(
  gatewayId: string | undefined,
  sessionKeys: readonly string[],
): Promise<void> {
  const keys = sessionKeys.map((sessionKey) => reasoningStoreKey(gatewayId, sessionKey));
  if (keys.length === 0) {
    return;
  }
  await mutateReasoningStore((store) => {
    for (const key of keys) {
      delete store.sessions[key];
    }
  });
}

async function readReasoningStore(): Promise<ReasoningStoreShape> {
  const path = reasoningStorePath();
  if (!existsSync(path)) {
    return { version: 1, sessions: {} };
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReasoningStoreShape>;
    return {
      version: 1,
      sessions: parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {},
    };
  } catch {
    await quarantineCorruptReasoningStore(path);
    return { version: 1, sessions: {} };
  }
}

/** 先写临时文件再 rename，保证读者只能看到完整的旧文件或新文件。 */
async function writeReasoningStore(store: ReasoningStoreShape): Promise<void> {
  const path = reasoningStorePath();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tmpPath, path);
}

/** 所有写操作串行执行“读-改-写”，避免并发设置互相覆盖。 */
async function mutateReasoningStore(mutator: (store: ReasoningStoreShape) => void): Promise<void> {
  const run = reasoningStoreMutationChain.then(async () => {
    const store = await readReasoningStore();
    mutator(store);
    await writeReasoningStore(store);
  });
  reasoningStoreMutationChain = run.catch(() => undefined);
  await run;
}

async function quarantineCorruptReasoningStore(path: string): Promise<void> {
  try {
    const quarantinePath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, quarantinePath);
    console.warn(`[hermes] reasoning store was corrupt; quarantined to ${quarantinePath}`);
  } catch (error) {
    // 仅尽力隔离；调用方仍以空存储继续运行。
    console.warn(`[hermes] reasoning store was corrupt and could not be quarantined: ${error instanceof Error ? error.message : String(error)}`);
  }
}
