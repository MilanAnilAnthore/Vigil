import { Client } from "pg";
import { getCtx, StoreContext } from "../lib/als";

// A function measure the end of a sql querie and push to the request store
function finalMeasure(
  args: any[],
  start: bigint,
  ctx: StoreContext | undefined,
): void {
  const end: bigint = process.hrtime.bigint();
  const durationInMs: number = Number(end - start) / 1e6;
  const first = args[0];
  const sql: string = typeof first === "string" ? first : first?.text;
  ctx?.queries.push({ sql, durationInMs });
}

// Setup a boolean value to prevent double patch
let installed = false;
// monkey-patching the pg query to calculate the time a db takes to execute an operation
// and stores it into the context of that certain req-res cycle
export function instrumentPg(): void {
  if (installed) return;
  installed = true;

  const original = Client.prototype.query;
  Client.prototype.query = function (this: Client, ...args: any[]): any {
    const start = process.hrtime.bigint();
    // capturing the store of a request early and passing to the connection since the connection lives outside storeContext
    const ctx = getCtx();
    //Check if the last argument is a callback
    const lastArgIndex = args.length - 1;
    const lastArg = args[lastArgIndex];

    if (typeof lastArg === "function") {
      // Replace the original callback with a custom wrapper function
      args[lastArgIndex] = function (...cbArgs: any[]) {
        // Stop the timer ONLY when the database calls this callback
        finalMeasure(args, start, ctx);
        // Pass the results back to the user's original callback
        return lastArg.apply(this, cbArgs);
      };
    }

    // Execute the original query method with modified args
    const result = (original as any).apply(this, args);

    // Handle Promise-based executions
    if (typeof result?.then === "function") {
      try {
        result.finally(() => {
          finalMeasure(args, start, ctx);
        });
      } catch (err) {
        console.log(`An error occured inside patch ${err}`);
      }
    }

    return result;
  };
}
