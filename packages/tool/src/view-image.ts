import { isAbsolute } from "node:path";
import { ImageToolResult, validateKeys, type Tool, type ToolHost } from "./tool.ts";
import { resolveLocalPath } from "./local-path.ts";
import { fetchHttpImage, parseFetchUrl } from "./web-http.ts";
import type { Workspace } from "./workspace.ts";

export async function importImage(host: Pick<ToolHost, "images">, input: { path?: string; url?: string }, signal?: AbortSignal, workspace?: Workspace) {
  if (!host.images) throw new Error("宿主未配置图片存储。");
  if ((input.path === undefined) === (input.url === undefined)) throw new Error("path 与 url 必须恰好指定一个。");
  if (input.path !== undefined) {
    if (!workspace && !isAbsolute(input.path)) throw new Error("上传本地图片必须使用绝对路径。");
    return host.images.importFile(workspace ? await resolveLocalPath(workspace, input.path) : input.path, signal);
  }
  const url = parseFetchUrl(input.url);
  const deadline = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const bytes = await fetchHttpImage(url.href, combined);
  return host.images.save(bytes, url.pathname.split("/").at(-1) || "网络图片", combined);
}

export function createViewImageTool(workspace: Workspace, host: ToolHost): Tool {
  return {
    access: "read",
    definition: {
      type: "function", name: "view_image", strict: false,
      description: "读取本地、HTTP(S) 或当前对话保存的图片，将真实图片内容返回给模型。path、url、imageId 恰好指定一个。本地支持相对路径和绝对路径，相对路径从对话工作目录开始，可读取项目外文件。仅支持 PNG、JPEG、WebP，按实际字节识别。保留原图副本，不压缩、不缩放。历史图片因请求大小暂未发送时，可按提示用 imageId 回读副本。",
      parameters: { type: "object", additionalProperties: false, oneOf: [{ required: ["path"] }, { required: ["url"] }, { required: ["imageId"] }], properties: {
        path: { type: "string", description: "本地图片相对路径或绝对路径，与 url 互斥。" },
        url: { type: "string", description: "完整 HTTP(S) 图片网址，与 path 互斥。" },
        imageId: { type: "string", description: "当前对话中已保存的图片标识，与 path、url 互斥。" },
      } },
    },
    async execute(args, signal) {
      validateKeys(args, ["path", "url", "imageId"]);
      if (args.imageId !== undefined) {
        if (typeof args.imageId !== "string" || args.path !== undefined || args.url !== undefined) {
          throw new Error("指定 imageId 时只能提供一个图片标识。");
        }
        signal?.throwIfAborted();
        const image = host.recallImage?.(args.imageId);
        if (!image) throw new Error("找不到当前对话中可回读的图片。");
        return new ImageToolResult({}, [image]);
      }
      if ((args.path !== undefined && typeof args.path !== "string") || (args.url !== undefined && typeof args.url !== "string")) throw new Error("图片路径和网址必须是字符串。");
      const image = await importImage(host, args as { path?: string; url?: string }, signal, workspace);
      return new ImageToolResult({}, [image]);
    },
  };
}
