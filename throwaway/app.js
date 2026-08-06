const express = require("express");
const app = express();
const port = 3000;

app.get("/", (req, res, next) => {
  console.log("handler 1 BODY running");
  res.on("finish", () => console.log("handler 1 FINISH"));
  next();
});

app.get("/", (req, res, next) => {
  console.log("handler 2 BODY running");
  res.on("finish", () => {
    setTimeout(() => {
      console.log("handler 2 FINISH (delayed)");
    }, 3000);
  });
  next();
});

app.get("/", (req, res, next) => {
  console.log("handler 3 BODY running");
  res.on("finish", () => console.log("handler 3 FINISH"));
  // throw is commented out on purpose — clean run first, crash experiment later
  res.send(console.log("Finished"));
});

app.listen(port, () => console.log(`listening to port ${port}`));
