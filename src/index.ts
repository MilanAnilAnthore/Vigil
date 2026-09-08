import express from "express";
import { pool, verifyConnection } from "./config/database";
import apm from "./middlewares/apm";
import { instrumentPg } from "./instrumentation/pg";
const app = express();
const port = 3000;

async function main() {
  await verifyConnection();
  app.listen(port, () => console.log(`listening to port ${port}`));
}

// patch the driver before anything opens a connection, then mount the
// middleware above every route so it wraps all of them
instrumentPg();
app.use(apm);

// The routes below are the app being monitored. They exist to produce a spread
// of durations, statuses and query counts for Vigil to record - nothing here
// knows Vigil exists.

// fast: primary key lookup, no artificial delay. This is the p50 floor -
// the number every other route gets compared against.
app.get("/fast", async (_req, res) => {
  await pool.query(
    "SELECT order_id, amount FROM orders WHERE order_id = $1",
    [1],
  );
  res.send("fast");
});

// slow: jittered delay plus two queries on the deliberately un-indexed
// user_id column. The jitter spreads the durations so p50/p95/p99 differ;
// the second query is what makes this row worth drilling into.
app.get("/slow", async (_req, res) => {
  const userId = Math.floor(Math.random() * 50) + 1;
  await new Promise((resolve) =>
    setTimeout(resolve, 200 + Math.random() * 400),
  );
  await pool.query("SELECT count(*) FROM orders WHERE user_id = $1", [userId]);
  await pool.query(
    "SELECT order_id, amount FROM orders WHERE user_id = $1 ORDER BY amount DESC LIMIT 5",
    [userId],
  );
  res.send("slow");
});

// boom: runs a query and then throws. Express 5 forwards the rejection to the
// default error handler, so this answers 500 - which is what gives the Phase 5
// error count something to count. The query still gets correlated.
app.get("/boom", async () => {
  await pool.query("SELECT count(*) FROM orders WHERE amount > $1", [400]);
  throw new Error("simulated failure inside /boom");
});

// orders/:id: the route pattern check. Every id hits the same handler, so all
// of them must record as "/orders/:id" rather than one route per id.
app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).send("id must be a positive integer");
    return;
  }

  const result = await pool.query(
    "SELECT order_id, user_id, amount FROM orders WHERE order_id = $1",
    [id],
  );

  // noUncheckedIndexedAccess makes rows[0] possibly undefined, so this is a
  // real check rather than a formality
  const order = result.rows[0];
  if (!order) {
    res.status(404).send("no such order");
    return;
  }
  res.json(order);
});

main().catch((err) => console.log(`main thrown error ${err}`));
