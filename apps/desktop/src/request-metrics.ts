import type { AttemptView, ResponseMetrics } from "@tilot/protocol";
import type { TurnRecord } from "./conversation";

/** 请求集合的累计；用量缺失时对应合计保持未知，不以部分数据冒充完整用量。 */
export interface RequestMetrics extends Omit<ResponseMetrics, "durationMs" | "firstTokenMs"> {
  tokensPerSecond: number | null;
  requestCount: number;
  finishedRequestCount: number;
  missingUsageCount: number;
}

export interface TurnMetrics extends RequestMetrics { firstTokenMs: number | null }

/** 上下文按最近一次返回的输入与输出估算；请求间的历史重复输入不累加。 */
export function getContextTokens(records: TurnRecord[]): number | null {
  for (let index = records.length - 1; index >= 0; index--) {
    const attempts = records[index]!.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex--) {
      const metrics = attempts[attemptIndex]!.metrics;
      if (metrics?.inputTokens != null && metrics.outputTokens != null) return metrics.inputTokens + metrics.outputTokens;
    }
  }
  return null;
}

/** 每个请求只计一次，包含已结束的失败/取消请求；运行中的请求等最终用量返回后再计入。 */
export function getRequestMetrics(attempts: AttemptView[]): RequestMetrics {
  const finished = attempts.filter((attempt) => attempt.status !== "running");
  const sumTokens = (field: "inputTokens" | "cachedTokens" | "outputTokens") => {
    let total = 0;
    if (finished.length === 0) return null;
    for (const attempt of finished) {
      const value = attempt.metrics?.[field];
      if (value == null) return null;
      total += value;
    }
    return total;
  };
  const outputTokens = sumTokens("outputTokens");
  let generationMs = 0;
  let timingComplete = true;
  for (const attempt of finished) {
    const metrics = attempt.metrics;
    if (metrics?.outputTokens === 0 && metrics.firstTokenMs === null) continue;
    if (metrics?.firstTokenMs == null || metrics.durationMs == null || metrics.durationMs <= metrics.firstTokenMs) {
      timingComplete = false;
      break;
    }
    generationMs += metrics.durationMs - metrics.firstTokenMs;
  }
  return {
    requestCount: attempts.length,
    finishedRequestCount: finished.length,
    missingUsageCount: finished.filter((attempt) => !attempt.metrics ||
      attempt.metrics.inputTokens == null || attempt.metrics.cachedTokens == null || attempt.metrics.outputTokens == null).length,
    tokensPerSecond: outputTokens !== null && timingComplete && generationMs > 0 ? outputTokens / (generationMs / 1000) : null,
    inputTokens: sumTokens("inputTokens"),
    cachedTokens: sumTokens("cachedTokens"),
    outputTokens,
  };
}

/** 轮次只负责首次输出的时间边界；用量汇总可复用于其他范围的原始请求集合。 */
export function getTurnMetrics(record: TurnRecord): TurnMetrics {
  let firstTokenMs: number | null = null;
  for (const attempt of record.attempts) {
    if (attempt.metrics?.firstTokenMs != null) {
      firstTokenMs = Math.max(0, attempt.createdAt - record.turn.createdAt + attempt.metrics.firstTokenMs);
      break;
    }
    // 没有输出的请求可跳过；旧记录缺少计时但可能有输出时，不能改用后一次请求的时间。
    if (attempt.metrics?.outputTokens !== 0) break;
  }
  return { ...getRequestMetrics(record.attempts), firstTokenMs };
}
