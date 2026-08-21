import { AsyncLocalStorage } from "node:async_hooks";

interface StoreContext {
  queries: { sql: string; durationInMs: number }[];
}

const als = new AsyncLocalStorage<StoreContext>();
const getCtx = (): StoreContext | undefined => als.getStore();

export { als, getCtx };
