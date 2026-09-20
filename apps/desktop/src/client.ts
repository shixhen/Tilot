import type { AppConfig, AttemptView, RpcRequest, Thread, Turn, TurnInput } from "@tilot/protocol";
import type { BackendConnection } from "./backend";

/** 已有 RPC 方法与返回值的对应关系，让界面调用保留具体类型。 */
interface Results {
  "thread.create": Thread; "thread.read": Thread | null; "thread.list": Thread[]; "thread.rename": Thread;
  "turn.start": Turn; "turn.interrupt": { interrupted: boolean }; "turn.read": Turn | null;
  "turn.list": Turn[]; "turn.inputs": TurnInput[]; "turn.attempts": AttemptView[];
  "config.get": AppConfig; "config.set": AppConfig;
  "credentials.status": { configured: boolean }; "credentials.set": null; "credentials.delete": null;
}

/** 限定方法和参数同时匹配的调用签名，传输层继续负责关联应答。 */
export type Request = <M extends RpcRequest["method"]>(method: M, params: Params[M]) => Promise<Results[M]>;

/** 从共享协议提取参数，不在前端重新声明业务字段。 */
type Params = { [R in RpcRequest as R["method"]]: R["params"] };

/** 为同仓库共享协议提供有类型的调用入口，统一生成唯一请求 id。 */
export function createClient(connection: BackendConnection): Request {
  return async (method, params) => connection.request({ id: crypto.randomUUID(), method, params } as RpcRequest) as Promise<Results[typeof method]>;
}
