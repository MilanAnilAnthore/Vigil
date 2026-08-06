const express = require("express");
const app = express();

const port = 3000;

const mwA = (req, res, next) => {
  console.log("before A");
  next();
  console.log("after A");
};

app.get("/", mwA, async (req, res) => {
  console.log("handler start");
  await new Promise((r) => setTimeout(r, 300)); // your Phase 0 "slow route" delay
  res.status(200).send("done");
});

app.listen(port, () => {
  console.log(`listening to port ${port}`);
});
