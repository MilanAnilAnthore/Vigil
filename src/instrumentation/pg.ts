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

// Create global, shared symbols for our tags
const PATCHED = Symbol.for("vigil.pg.patched");
const ORIGINAL = Symbol.for("vigil.pg.original");

// monkey-patching the pg query to calculate the time a db takes to execute an operation
// and stores it into the context of that certain req-res cycle
export function instrumentPg(): void {
  const original = Client.prototype.query;

  // Bail out if the function already has global patched stamp
  if ((original as any)[PATCHED]) return;

  // Creating the patched wrapper
  const patched = function (this: Client, ...args: any[]): any {
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
      result.finally(() => finalMeasure(args, start, ctx)).catch(() => {});
    }

    return result;
  };

  // Attaching stamps to the wrapper that i just created
  (patched as any)[PATCHED] = true;
  (patched as any)[ORIGINAL] = original; // Saving the original for un-instrumenting later

  // Replacing the query method
  Client.prototype.query = patched;
}

// a way to undo the patch
export function uninstrumentPg(): void {
  const current = Client.prototype.query as any;
  if (!current?.[PATCHED]) return;
  // Restore the original function saved earlier
  Client.prototype.query = current[ORIGINAL];
}
