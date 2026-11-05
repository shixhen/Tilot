/** 本地图片副本的公开引用；不暴露宿主保存路径。 */
export interface ImageRef { id: string; name: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; bytes: number }

/** 文件选择使用本地路径；剪贴板使用 Base64；网页拖拽使用网址。 */
export type ImageImport = { path: string } | { url: string } | { base64: string; name: string };
export interface ImageData { image: ImageRef; dataUrl: string }

export function isImageRef(value: unknown): value is ImageRef {
  if (!value || typeof value !== "object") return false;
  const image = value as ImageRef;
  return typeof image.id === "string" && /^[a-f0-9]{64}$/.test(image.id) && typeof image.name === "string" &&
    ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) && Number.isSafeInteger(image.bytes) && image.bytes > 0;
}

/** 仅在本地历史中使用；模型请求发送前必须由图片存储展开。 */
export function imageContent(image: ImageRef) {
  return { type: "input_image" as const, image_url: `tilot-image:${image.id}`, detail: "auto" as const };
}
