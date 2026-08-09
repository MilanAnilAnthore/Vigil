const express = require("express");
const app = express();

const port = 3000;

function apm(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path;
    const end = process.hrtime.bigint();
    const durationInMs = Number(end - start) / 1e6;
    console.log({
      duration: durationInMs,
      method: req.method,
      route,
      status: res.statusCode,
    });
  });
  next();
}

app.use(apm);

app.get("/", async (req, res, next) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  res.send("main route");
});

app.get("/demo/:id", async (req, res, next) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  res.send("id route");
});

app.get("/demo/:id/comment/:commentid", async (req, res, next) => {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  res.send("id route");
});

app.listen(port, () => {
  console.log(`listening to port ${port}`);
});
