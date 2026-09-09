import { Client, Pool } from "pg";
import { AsyncResource } from "node:async_hooks";
import { getCtx, StoreContext } from "../lib/als";

const POOL_PATCHED = Symbol.for("vigil.pg.pool.patched");
const POOL_ORIGINAL = Symbol.for("vigil.pg.pool.original");

// pool.connect() may park the callback in a waiting list and run it later if the limit of connections exceeds,
// on whichever request happens to release a connection. Bind it so it always
// resumes in the context of the request that actually asked for it.
function instrumentPgPool(): void {
  const original = Pool.prototype.connect;
  if ((original as any)[POOL_PATCHED]) return;

  const patched = function (this: Pool, cb?: any): any {
    return typeof cb === "function"
      ? (original as any).call(this, AsyncResource.bind(cb))
      : (original as any).call(this, cb);
  };

  (patched as any)[POOL_PATCHED] = true;
  (patched as any)[POOL_ORIGINAL] = original;
  Pool.prototype.connect = patched as any;
}

// pg takes the query as a plain string, as an object with text, or for a
// prepared statement as an object with only a name and no text. That last one
// was pushing undefined which saves as NULL, and NULL doesnt group and doesnt
// match a WHERE, so the query is counted but you cant find it. So always hand
// back a string, same idea as (unmatched) in routePattern
function extractSql(first: unknown): string {
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const config = first as { text?: unknown; name?: unknown };
    if (typeof config.text === "string") return config.text;
    if (typeof config.name === "string") return `(prepared: ${config.name})`;
  }
  return "(unknown)";
}

// A function measure the end of a sql querie and push to the request store
function finalMeasure(
  args: any[],
  start: bigint,
  ctx: StoreContext | undefined,
): void {
  const end: bigint = process.hrtime.bigint();
  const durationInMs: number = Number(end - start) / 1e6;
  const sql: string = extractSql(args[0]);
  ctx?.queries.push({ sql, durationInMs });
}

// Create global, shared symbols for our tags
const PATCHED = Symbol.for("vigil.pg.patched");
const ORIGINAL = Symbol.for("vigil.pg.original");

// monkey-patching the pg query to calculate the time a db takes to execute an operation
// and stores it into the context of that certain req-res cycle
export function instrumentPg(): void {
  instrumentPgPool();
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
function uninstrumentPgPool(): void {
  const current = Pool.prototype.connect as any;
  if (!current?.[POOL_PATCHED]) return;
  const original = current[POOL_ORIGINAL];
  delete (Pool.prototype as any).connect; // reveals the inherited original
  if (Pool.prototype.connect !== original) {
    // belt-and-braces
    Pool.prototype.connect = original;
  }
}

// a way to undo the patch
export function uninstrumentPg(): void {
  const current = Client.prototype.query as any;
  uninstrumentPgPool();
  if (!current?.[PATCHED]) return;
  // Restore the original function saved earlier
  Client.prototype.query = current[ORIGINAL];
}
