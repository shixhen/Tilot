/** 检查列表页大小和起始位置；位置可表示偏移量或递增记录游标。 */
export function validatePagination(limit: number, position: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(position) || position < 0) {
    throw new Error("每页需为 1 至 100 条，起始位置需为非负整数。");
  }
}
