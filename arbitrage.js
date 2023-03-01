const { log, error } = console;
const got = require("got");
const events = require("events");
const Websocket = require("ws");
const { sort } = require("fast-sort");
const { promisify } = require("util");
const delay = promisify(setTimeout);

let pairs = [],
  symValJ = {};

const eventEmitter = new events();

const getPairs = async () => {
  const resp = await got("https://api.bybit.com/spot/v3/public/symbols");
  const eInfo = JSON.parse(resp.body);
  const symbols = [
    ...new Set(eInfo.result.list.map((d) => [d.baseCoin, d.quoteCoin]).flat()),
  ];
  const validPairs = eInfo.result.list.map((d) => d.name);
  validPairs.forEach((symbol) => {
    symValJ[symbol] = { bidPrice: 0, askPrice: 0 };
  });

  let s1 = symbols,
    s2 = symbols,
    s3 = symbols;
  s1.forEach((d1) => {
    s2.forEach((d2) => {
      s3.forEach((d3) => {
        if (!(d1 == d2 || d2 == d3 || d3 == d1)) {
          let lv1 = [],
            lv2 = [],
            lv3 = [],
            l1 = "",
            l2 = "",
            l3 = "";
          if (symValJ[d1 + d2]) {
            lv1.push(d1 + d2);
            l1 = "num";
          }
          if (symValJ[d2 + d1]) {
            lv1.push(d2 + d1);
            l1 = "den";
          }

          if (symValJ[d2 + d3]) {
            lv2.push(d2 + d3);
            l2 = "num";
          }
          if (symValJ[d3 + d2]) {
            lv2.push(d3 + d2);
            l2 = "den";
          }

          if (symValJ[d3 + d1]) {
            lv3.push(d3 + d1);
            l3 = "num";
          }
          if (symValJ[d1 + d3]) {
            lv3.push(d1 + d3);
            l3 = "den";
          }

          if (lv1.length && lv2.length && lv3.length) {
            pairs.push({
              l1: l1,
              l2: l2,
              l3: l3,
              d1: d1,
              d2: d2,
              d3: d3,
              lv1: lv1[0],
              lv2: lv2[0],
              lv3: lv3[0],
              value: -100,
              tpath: "",
            });
          }
        }
      });
    });
  });
  log(
    `Finished identifying all the paths. Total symbols = ${symbols.length}. Total paths = ${pairs.length}`
  );
};

const processData = (pl) => {
  try {
    pl = JSON.parse(pl);
    // if (pl?.op === "subscribe") {
    //   console.log(pl);
    // }
    const symbol = pl?.topic?.slice(11);
    const { data } = pl;
    if (!data) return;
    const { bp: bidPrice, ap: askPrice } = data;
    if (!bidPrice && !askPrice) return;

    if (bidPrice) symValJ[symbol].bidPrice = bidPrice * 1;
    if (askPrice) symValJ[symbol].askPrice = askPrice * 1;

    //Perform calculation and send alerts
    pairs
      .filter((d) => {
        return (d.lv1 + d.lv2 + d.lv3).includes(symbol);
      })
      .forEach((d) => {
        //continue if price is not updated for any symbol
        if (
          symValJ[d.lv1]["bidPrice"] &&
          symValJ[d.lv2]["bidPrice"] &&
          symValJ[d.lv3]["bidPrice"]
        ) {
          //Level 1 calculation
          let lv_calc, lv_str;
          if (d.l1 === "num") {
            lv_calc = symValJ[d.lv1]["bidPrice"];
            lv_str =
              d.d1 +
              "->" +
              d.lv1 +
              "['bidP']['" +
              symValJ[d.lv1]["bidPrice"] +
              "']" +
              "->" +
              d.d2 +
              "<br/>";
          } else {
            lv_calc = 1 / symValJ[d.lv1]["askPrice"];
            lv_str =
              d.d1 +
              "->" +
              d.lv1 +
              "['askP']['" +
              symValJ[d.lv1]["askPrice"] +
              "']" +
              "->" +
              d.d2 +
              "<br/>";
          }

          //Level 2 calculation
          if (d.l2 === "num") {
            lv_calc *= symValJ[d.lv2]["bidPrice"];
            lv_str +=
              d.d2 +
              "->" +
              d.lv2 +
              "['bidP']['" +
              symValJ[d.lv2]["bidPrice"] +
              "']" +
              "->" +
              d.d3 +
              "<br/>";
          } else {
            lv_calc *= 1 / symValJ[d.lv2]["askPrice"];
            lv_str +=
              d.d2 +
              "->" +
              d.lv2 +
              "['askP']['" +
              symValJ[d.lv2]["askPrice"] +
              "']" +
              "->" +
              d.d3 +
              "<br/>";
          }

          //Level 3 calculation
          if (d.l3 === "num") {
            lv_calc *= symValJ[d.lv3]["bidPrice"];
            lv_str +=
              d.d3 +
              "->" +
              d.lv3 +
              "['bidP']['" +
              symValJ[d.lv3]["bidPrice"] +
              "']" +
              "->" +
              d.d1;
          } else {
            lv_calc *= 1 / symValJ[d.lv3]["askPrice"];
            lv_str +=
              d.d3 +
              "->" +
              d.lv3 +
              "['askP']['" +
              symValJ[d.lv3]["askPrice"] +
              "']" +
              "->" +
              d.d1;
          }

          d.tpath = lv_str;
          d.value = parseFloat(parseFloat((lv_calc - 1) * 100).toFixed(3));
        }
      });

    //Send Socket
    eventEmitter.emit(
      "ARBITRAGE",
      sort(pairs.filter((d) => d.value > 0)).desc((u) => u.value)
    );
  } catch (err) {
    error(err);
  }
};

let ws = "";
let subs = [];
const wsconnect = () => {
  ws = new Websocket(`wss://stream.bybit.com/spot/public/v3`);

  subs = Object.keys(symValJ).map((d) => `bookticker.${d}`);
  ws.on("open", async () => {
    console.log("Establishing all the required websocket connections.");
    const chunkSize = 10;
    const argChunks = subs
      .map((d, i, arr) => (i % chunkSize ? "" : arr.slice(i, i + chunkSize)))
      .filter((d) => d);
    let ci = -1;
    do {
      ci++;
      const args = argChunks[ci];
      if (!args) break;
      await delay(1000);
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args,
        })
      );
      const clen = subs.length - Math.min(subs.length, ci * chunkSize);
      console.log(`${clen} more connections to go...`);
    } while (true);
    console.log("all connections established.");
    console.log(
      "Open http://127.0.0.1:3000/ in the browser to access the tool."
    );
  });
  ws.on("error", log);
  ws.on("message", processData);

  setInterval(() => {
    if (!(ws.readyState === Websocket.OPEN)) return;
    ws.ping();
  }, 20 * 1000);
};

module.exports = { getPairs, wsconnect, eventEmitter };
