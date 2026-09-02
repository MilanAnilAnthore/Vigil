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

instrumentPg();
app.use(apm);

app.get("/", async (req, res, next) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const text =
    "INSERT INTO requests(method, route, status, duration_ms ) VALUES($1, $2, $3, $4)";
  const values = ["TEsT", "/test", 333, 20000];
  await pool.query(text, values);
  await pool.query(text, values);
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

main();
