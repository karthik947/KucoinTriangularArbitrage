const { log, error } = console;
const socket = require("socket.io");
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const server = app.listen(3000, () =>
  log(
    "Bybit spot triangular arbitrage finder has started. Please wait while the bot identifies possible paths....."
  )
);

app.use(cors());
app.use("/JS", express.static(path.join(__dirname, "./Pages/JS")));
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "./Pages/index.html"));
});

const io = socket(server);

const arbitrage = require("./arbitrage");

const initialize = async () => {
  await arbitrage.getPairs();
  arbitrage.wsconnect();
};

arbitrage.eventEmitter.on("ARBITRAGE", (pl) => {
  io.sockets.emit("ARBITRAGE", pl);
});

initialize();
