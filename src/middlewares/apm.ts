import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { als, StoreContext } from "../lib/als";
import routePattern from "../lib/routePattern";

// The monitoring middleware that stands between a req-res cycle
export default function apm(req: Request, res: Response, next: NextFunction) {
  // record start time when the middleware runs
  const start: bigint = process.hrtime.bigint();

  const store: StoreContext = { queries: [] };

  // a context store that wraps a full request response cycle
  als.run(store, () => {
    // This executes after a response is finished
    res.on("close", () => {
      const end: bigint = process.hrtime.bigint();
      const durationInMs: number = Number(end - start) / 1e6;
      const status = res.writableFinished ? res.statusCode : 499;

      // wrapping the insert operation of apm inside als.exit
      // the context is not available/undefined in here
      // so that the contextStore gets undefined and does not pollute the store storage
      als.exit(async () => {
        try {
          const requestText: string =
            "INSERT INTO requests(method, route, status, duration_ms ) VALUES($1, $2, $3, $4) RETURNING request_id";
          const requestValues: Array<string | number> = [
            req.method,
            routePattern(req),
            status,
            durationInMs,
          ];
          const ctxQueries = [...store.queries];
          const reqDbResponse = await pool.query(requestText, requestValues);
          const requestId = reqDbResponse.rows[0]["request_id"];
          const queryText = `
      INSERT INTO queries (request_id, query_text, duration_ms)
      SELECT $1, sql, duration_ms
      FROM unnest($2::text[], $3::float8[]) AS t(sql, duration_ms)
    `;
          await pool.query(queryText, [
            requestId,
            ctxQueries.map((q) => q.sql),
            ctxQueries.map((q) => q.durationInMs),
          ]);
        } catch (err) {
          console.log(`Unexpected apm error ${err}`);
        }
      });
    });
    next();
  });
}
