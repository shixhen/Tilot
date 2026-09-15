import { randomUUID } from "node:crypto";
import type { RuntimeServices } from "@tilot/agent-core";

export function createNodeServices(): RuntimeServices {
  return {
    newId: () => randomUUID(),
    now: () => Date.now(),
    scheduleDeadline(milliseconds, expire) {
      const timer = setTimeout(expire, milliseconds);
      return () => clearTimeout(timer);
    },
  };
}
