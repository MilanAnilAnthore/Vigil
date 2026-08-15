const express = require("express");
const app = express();
const { Pool } = require("pg");
const connectionString = process.env.DATABASE_URL;
const { als, getCtx } = require("./lib/als");

const port = 3000;
const pool = new Pool({
  connectionString: connectionString,
  min: 5,
  max: 20,
  idleTimeoutMillis: 30000,
  query_timeout: 3000,
});

function apm(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", async () => {
    const end = process.hrtime.bigint();
    const durationInMs = Number(end - start) / 1e6;
    const text =
      "INSERT INTO requests(method, route, status, duration_ms ) VALUES($1, $2, $3, $4)";
    const values = [req.method, req.route?.path, res.statusCode, durationInMs];

    console.log(getCtx()?.queries?.[0]?.id);

    try {
      await pool.query(text, values);
    } catch (err) {
      console.log(err);
    }
  });
  als.run({ queries: [] }, () => {
    next();
  });
}

app.use(apm);
let contextId = 0;
app.get("/", async (req, res, next) => {
  contextId++;
  getCtx().queries.push({ id: contextId });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  res.send("main route");
});

// app.get("/demo/:id", async (req, res, next) => {
//   await new Promise((resolve) => setTimeout(resolve, 2000));
//   res.send("id route");
// });

// app.get("/demo/:id/comment/:commentid", async (req, res, next) => {
//   await new Promise((resolve) => setTimeout(resolve, 5000));
//   res.send("id route");
// });

app.listen(port, () => {
  console.log(`listening to port ${port}`);
});
