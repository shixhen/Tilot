import type { Client, ContentBlock } from "@modelcontextprotocol/client";
import type { ImageRef } from "@tilot/protocol";
import type { ToolHost } from "./tool.ts";
import { importImage } from "./view-image.ts";

/** 图片失败只影响该内容项；原 MCP 工具的实际结果与其他内容仍保留，不重新调用工具。 */
export async function mcpImageContent(client: Client, content: ContentBlock[], host: ToolHost,
  timeoutMs: number, signal: AbortSignal | undefined, describeError: (error: unknown) => string) {
  const parts: string[] = [];
  const images: ImageRef[] = [];
  const save = async (data: string, name: string) => {
    if (!host.images) throw new Error("宿主未配置图片存储。");
    images.push(await host.images.importBase64(data, name, signal));
  };
  for (const block of content) {
    if (block.type === "text") { parts.push(block.text); continue; }
    try {
      if (block.type === "image") await save(block.data, `MCP 图片 ${images.length + 1}`);
      else if (block.type === "resource" && pictureResource(block.resource.mimeType, block.resource.uri) && "blob" in block.resource) {
        await save(block.resource.blob, block.resource.uri);
      } else if (block.type === "resource_link" && pictureResource(block.mimeType, block.uri)) {
        signal?.throwIfAborted();
        if (client.getServerCapabilities()?.resources) {
          const result = await client.readResource({ uri: block.uri }, { ...(signal ? { signal } : {}), timeout: timeoutMs, maxTotalTimeout: timeoutMs });
          let found = false;
          for (const resource of result.contents) {
            if ("blob" in resource) { await save(resource.blob, block.name); found = true; }
          }
          if (!found) throw new Error("图片资源未返回二进制图片内容。");
        } else if (/^https?:\/\//i.test(block.uri)) images.push(await importImage(host, { url: block.uri }, signal));
        else throw new Error("MCP 服务没有提供资源读取能力。");
      } else parts.push(`[暂不支持 MCP 返回的 ${block.type} 内容]`);
    } catch (error) { parts.push(`[图片读取失败：${describeError(error)}；原工具已返回，不要为重新取图重跑有副作用的工具。]`); }
  }
  return { parts, images };
}

function pictureResource(mime: string | undefined, uri: string): boolean {
  return mime?.startsWith("image/") === true || /\.(?:png|jpe?g|webp)(?:$|[?#])/i.test(uri);
}
