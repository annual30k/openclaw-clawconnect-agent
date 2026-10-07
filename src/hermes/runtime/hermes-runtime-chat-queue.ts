// Hermes 对话按 sessionKey 串行执行；队列状态只保存在本模块，保证同一会话的轮次严格按提交顺序处理。
const hermesChatQueues = new Map<string, Promise<void>>();

export async function runSerializedHermesChat<T>(
  sessionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = sessionKey.trim() || "main";
  const previous = hermesChatQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const stored = current.then(() => undefined, () => undefined);
  hermesChatQueues.set(queueKey, stored);
  try {
    return await current;
  } finally {
    if (hermesChatQueues.get(queueKey) === stored) {
      hermesChatQueues.delete(queueKey);
    }
  }
}
