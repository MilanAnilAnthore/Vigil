import { Client } from "pg";
import { getCtx } from "../lib/als";

// monkey-patching the pg query to calculate the time a db takes to execute an operation
// and stores it into the context of that certain req-res cycle
let installed = false;
export function instrumentPg(): void {
  if (installed) return;
  installed = true;

  const original = Client.prototype.query;
  Client.prototype.query = function (this: Client, ...args: any[]): any {
    const start: bigint = process.hrtime.bigint();
    const result = (original as any).apply(this, args);

    if (typeof result?.then === "function") {
      try {
        result.finally(() => {
          const end: bigint = process.hrtime.bigint();
          const durationInMs: number = Number(end - start) / 1e6;
          const first = args[0];
          const sql: string = typeof first === "string" ? first : first?.text;
          getCtx()?.queries.push({ sql, durationInMs });
        });
      } catch (err) {
        console.log(`An error occured inside patch ${err}`);
      }
    }
    return result;
  };
}
