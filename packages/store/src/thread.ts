/** 持久化的任务信息；projectPath 为 null 表示未绑定项目，时间均为 Unix 毫秒。 */
export interface Thread {
  id: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
}
