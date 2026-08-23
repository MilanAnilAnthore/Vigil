import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";
import { als } from "../lib/als";

// The monitoring middleware that stands between a req-res cycle
export default function apm(req: Request, res: Response, next: NextFunction) {
  const start: bigint = process.hrtime.bigint();
  res.on("finish", async () => {
    const end: bigint = process.hrtime.bigint();
    const durationInMs: number = Number(end - start) / 1e6;
    const text: string =
      "INSERT INTO requests(method, route, status, duration_ms ) VALUES($1, $2, $3, $4)";
    const values: Array<string | number> = [
      req.method,
      req.route?.path ?? undefined,
      res.statusCode,
      durationInMs,
    ];
    // console.log(getCtx()?.queries);
    try {
      await pool.query(text, values);
    } catch (err) {
      console.log(`Unexpected apm error ${err}`);
    }
  });
  als.run({ queries: [] }, () => {
    next();
  });
}
