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

const formatPair = (b, q) => b + "-" + q;

const getPairs = async () => {
  const resp = await got("https://api.kucoin.com/api/v2/symbols");
  const eInfo = JSON.parse(resp.body);
  const symbols = [
    ...new Set(
      eInfo.data
        .filter((d) => d.enableTrading)
        .map((d) => [d.baseCurrency, d.quoteCurrency])
        .flat()
    ),
  ];
  const validPairs = eInfo.data
    .filter((d) => d.enableTrading)
    .map((d) => d.symbol);
  validPairs.forEach((symbol) => {
    symValJ[symbol] = { bidPrice: 0, askPrice: 0 };
  });

  validPairs.forEach((p) => {
    symbols.forEach((d3) => {
      const [d1, d2] = p.split("-");
      if (!(d1 == d2 || d2 == d3 || d3 == d1)) {
        let lv1 = [],
          lv2 = [],
          lv3 = [],
          l1 = "",
          l2 = "",
          l3 = "";

        const p12 = formatPair(d1, d2);
        const p21 = formatPair(d2, d1);

        const p23 = formatPair(d2, d3);
        const p32 = formatPair(d3, d2);

        const p31 = formatPair(d3, d1);
        const p13 = formatPair(d1, d3);

        if (symValJ[p12]) {
          lv1.push(p12);
          l1 = "num";
        }
        if (symValJ[p21]) {
          lv1.push(p21);
          l1 = "den";
        }

        if (symValJ[p23]) {
          lv2.push(p23);
          l2 = "num";
        }
        if (symValJ[p32]) {
          lv2.push(p32);
          l2 = "den";
        }

        if (symValJ[p31]) {
          lv3.push(p31);
          l3 = "num";
        }
        if (symValJ[p13]) {
          lv3.push(p13);
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

  log(
    `Finished identifying all the paths. Total symbols = ${symbols.length}.Total Pairs = ${validPairs.length}. Total paths = ${pairs.length}`
  );
};

const processData = (pl) => {
  try {
    pl = JSON.parse(pl);
    const symbol = pl?.subject;
    const { data } = pl;
    if (!data) return;
    const { bestBid: bidPrice, bestAsk: askPrice } = data;
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
let wspingTrigger = "";
let wsreconnectTrigger = "";
let wsClientID;

const wsconnect = async () => {
  try {
    console.log(
      "Establishing all the required websocket connections.Please wait..."
    );
    // CLEAR OLD DATA
    if (ws) ws.terminate();
    clearInterval(wspingTrigger);
    clearTimeout(wsreconnectTrigger);

    // GET SOCKET METADATA
    const resp = await got.post("https://api.kucoin.com/api/v1/bullet-public");
    const wsmeta = JSON.parse(resp.body);

    //EXTRACT DATA
    const wsToken = wsmeta?.data?.token;
    const wsURLx = wsmeta?.data?.instanceServers?.[0]?.endpoint;
    const wspingInterval = wsmeta?.data?.instanceServers?.[0]?.pingInterval;
    const wspingTimeout =
      wsmeta?.data?.instanceServers?.[0]?.pingTimeout + wspingInterval;
    wsClientID = Math.floor(Math.random() * 10 ** 10);

    //ESTABLISH CONNECTION
    ws = new Websocket(`${wsURLx}?token=${wsToken}&[connectId=${wsClientID}]`);
    ws.on("open", () => {
      //subscribe
      ws.send(
        JSON.stringify({
          id: wsClientID,
          type: "subscribe",
          topic: "/market/ticker:all",
          privateChannel: false,
          response: true,
        })
      );

      console.log("all connections established.");
      console.log(
        "Open http://127.0.0.1:3000/ in the browser to access the tool."
      );
    });
    ws.on("error", log);
    ws.on("message", processData);
    ws.on("pong", () => {
      // log("PONG RECEIVED");
      clearTimeout(wsreconnectTrigger);
      wsreconnectTrigger = setTimeout(() => {
        wsconnect();
      }, wspingTimeout);
    });

    wspingTrigger = setInterval(() => {
      ws.ping();
    }, wspingInterval);
  } catch (err) {
    console.error(err);
  }
};

module.exports = { getPairs, wsconnect, eventEmitter };
