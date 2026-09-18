/** 轮次的结束状态；interrupted 表示执行进程已退出，区别于用户主动取消。 */
export type TurnFinalStatus = "completed" | "failed" | "cancelled" | "interrupted";

/** 一次用户发起的执行轮次；sequence 是任务内的顺序，时间均为 Unix 毫秒。 */
export interface Turn {
  id: string;
  threadId: string;
  sequence: number;
  status: "running" | TurnFinalStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}

/** 轮次中的用户输入；首条请求与后续补充均原文保存，id 用于顺序读取和分页。 */
export interface TurnInput {
  id: number;
  turnId: string;
  content: string;
  createdAt: number;
}
