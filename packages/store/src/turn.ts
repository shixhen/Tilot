export type { Turn, TurnFinalStatus } from "@tilot/protocol";

/** 轮次中的用户输入；首条请求与后续补充均原文保存，id 用于顺序读取和分页。 */
export interface TurnInput {
  id: number;
  turnId: string;
  content: string;
  createdAt: number;
}
