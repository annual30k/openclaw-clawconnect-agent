import { createHash } from "node:crypto";
import { sourceCommitScope, type SourceCommit } from "../../core/relay/source-commit.js";
import type { HistoryResponse } from "./chat-history.js";

export type SourceSnapshotMessage = NonNullable<HistoryResponse["timelineSnapshot"]>["messages"][number];

/**
 * 源行原始内容指纹：对未经媒体处理的投影行整体做 SHA-256。投影是确定的，
 * 同一源行内容不变时指纹不变；宿主原地补写（如追加托管图片）后指纹变化。
 */
export function sourceRowFingerprint(message: SourceSnapshotMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 32);
}

/**
 * 记录本进程已投影过的源行指纹（按源作用域分组，源 seq → 指纹）。
 *
 * 只覆盖本进程投影过的范围：进程启动前投影的行没有指纹，不参与原地改写比较，
 * 那部分由手机 history 刷新兜底。会话切换到新的源作用域时丢弃旧作用域，内存只随
 * 当前会话增长。
 */
export class SourceRowFingerprints {
  private readonly byScope = new Map<string, Map<number, string>>();

  record(commit: SourceCommit, messages: readonly SourceSnapshotMessage[]): void {
    const scope = sourceCommitScope(commit);
    let rows = this.byScope.get(scope);
    if (!rows) {
      this.byScope.clear();
      rows = new Map();
      this.byScope.set(scope, rows);
    }
    for (const message of messages) {
      const seq = message.sourceOrderSeq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq)) continue;
      rows.set(seq, sourceRowFingerprint(message));
    }
  }

  matches(commit: SourceCommit, sourceSeq: number, fingerprint: string): boolean {
    return this.byScope.get(sourceCommitScope(commit))?.get(sourceSeq) === fingerprint;
  }

  /** 本进程在该作用域记录过指纹的最小源 seq；没有记录时返回 undefined。 */
  trackedFromSeq(commit: SourceCommit): number | undefined {
    const rows = this.byScope.get(sourceCommitScope(commit));
    if (!rows || rows.size === 0) return undefined;
    let minimum: number | undefined;
    for (const seq of rows.keys()) minimum = minimum === undefined ? seq : Math.min(minimum, seq);
    return minimum;
  }
}
