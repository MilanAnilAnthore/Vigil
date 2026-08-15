const { AsyncLocalStorage } = require("node:async_hooks");
const als = new AsyncLocalStorage();
const getCtx = () => als.getStore();

module.exports = {
  als,
  getCtx,
};
