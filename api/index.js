/**
 * x402 Weather Proxy — a single-file, low-footprint Express app that:
 *   1. Gates a route behind the x402 v2 protocol (HTTP 402 + facilitator verify/settle)
 *   2. On successful payment, fetches free public weather data (Open-Meteo, no API key)
 *   3. Reformats it into clean Markdown for LLM/agent consumption
 *
 * Designed to run as a Vercel Hobby-tier serverless function (Node 18+, <50MB RAM).
 * Requires: express, axios (see package.json). No database, no local state.
 */

const express = require("express");
const axios = require("axios");

const app = express();

// ---------------------------------------------------------------------------
// Configuration (all overridable via environment variables — never hardcode
// your real wallet address in source).
// ---------------------------------------------------------------------------
const CONFIG = {
  // Free testnet facilitator for Base Sepolia. For mainnet, switch to
  // https://api.cdp.coinbase.com/platform/v2/x402 (Coinbase CDP, also free to use).
  FACILITATOR_URL: process.env.FACILITATOR_URL || "https://x402.org/facilitator",

  // CAIP-2 network id. eip155:84532 = Base Sepolia testnet. eip155:8453 = Base mainnet.
  NETWORK: process.env.NETWORK || "eip155:84532",

  // USDC contract address on the chosen network. This default is the Base Sepolia
  // testnet USDC address used in the official x402 spec examples — verify against
  // https://docs.x402.org for the current mainnet USDC address before going live.
  USDC_ASSET: process.env.USDC_ASSET || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",

  // Your receiving wallet address. MUST be set — the app refuses to gate routes
  // without it, since sending payments to an undefined address is unrecoverable.
  PAY_TO_ADDRESS: process.env.PAY_TO_ADDRESS || "",

  // Price in atomic units. USDC has 6 decimals, so 1000 atomic units == $0.001.
  PRICE_ATOMIC: process.env.PRICE_ATOMIC || "1000",

  // How long (seconds) a client has to complete payment before the offer expires.
  MAX_TIMEOUT_SECONDS: 60,
};

// ---------------------------------------------------------------------------
// Resource registry — one entry per monetized endpoint. Used to (a) build each
// route's 402 response, (b) generate llms.txt, and (c) answer the health check.
// Keeping this in one place means adding a new paid data source later is just
// adding one entry here plus one app.get(...) handler below.
// ---------------------------------------------------------------------------
const RESOURCES = [
  {
    path: "/api/weather",
    description: "Real-time weather (temperature, windspeed, direction) reformatted as agent-friendly Markdown.",
    mimeType: "text/markdown",
    inputSchema: {
      properties: {
        latitude: { type: "number", description: "Latitude, decimal degrees" },
        longitude: { type: "number", description: "Longitude, decimal degrees" },
      },
    },
  },
  {
    path: "/api/exchange-rate",
    description: "Latest foreign-exchange rate between two currencies (ECB reference rates), as Markdown.",
    mimeType: "text/markdown",
    inputSchema: {
      properties: {
        from: { type: "string", description: "Base currency code, e.g. USD" },
        to: { type: "string", description: "Target currency code, e.g. EUR" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// x402 middleware factory
// ---------------------------------------------------------------------------
function requirePayment({ path: resourcePath, description, mimeType, inputSchema }) {
  return async function (req, res, next) {
    if (!CONFIG.PAY_TO_ADDRESS) {
      return res.status(500).json({
        error: "Server misconfigured: PAY_TO_ADDRESS environment variable is not set.",
      });
    }

    const paymentRequirements = {
      scheme: "exact",
      network: CONFIG.NETWORK,
      amount: CONFIG.PRICE_ATOMIC,
      asset: CONFIG.USDC_ASSET,
      payTo: CONFIG.PAY_TO_ADDRESS,
      maxTimeoutSeconds: CONFIG.MAX_TIMEOUT_SECONDS,
      extra: { name: "USDC", version: "2" },
    };

    const resourceInfo = {
      url: `${req.protocol}://${req.get("host")}${resourcePath}`,
      description,
      mimeType,
    };

    // Bazaar discovery extension — lets facilitators that crawl for the CDP
    // Bazaar / Onyx Bazaar understand what this endpoint takes as input, so
    // agents can find and call it without a human reading the docs first.
    const extensions = inputSchema
      ? {
          discovery: {
            info: { inputSchema },
            schema: {
              type: "object",
              properties: { inputSchema: { type: "object" } },
              required: ["inputSchema"],
            },
          },
        }
      : {};

    const paymentRequired = {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: resourceInfo,
      accepts: [paymentRequirements],
      extensions,
    };

    // Case 1: no payment attached yet -> tell the agent exactly how to pay.
    const signatureHeader = req.headers["payment-signature"];
    if (!signatureHeader) {
      res.set(
        "PAYMENT-REQUIRED",
        Buffer.from(JSON.stringify(paymentRequired)).toString("base64")
      );
      return res.status(402).json(paymentRequired);
    }

    // Case 2: payment attached -> decode, verify, settle.
    let paymentPayload;
    try {
      const decoded = Buffer.from(signatureHeader, "base64").toString("utf8");
      paymentPayload = JSON.parse(decoded);
    } catch (err) {
      return res.status(400).json({
        x402Version: 2,
        error: "invalid_payload",
        detail: "PAYMENT-SIGNATURE header could not be decoded as base64 JSON.",
      });
    }

    const facilitatorBody = {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    };

    try {
      // Step A: /verify — free, off-chain check. No gas, no broadcast yet.
      const verifyRes = await axios.post(
        `${CONFIG.FACILITATOR_URL}/verify`,
        facilitatorBody,
        { timeout: 10_000 }
      );

      if (!verifyRes.data || verifyRes.data.isValid !== true) {
        return res.status(402).json({
          x402Version: 2,
          error: "invalid_payment",
          invalidReason: verifyRes.data && verifyRes.data.invalidReason,
          accepts: [paymentRequirements],
        });
      }

      // Step B: /settle — actually broadcasts the transferWithAuthorization tx.
      const settleRes = await axios.post(
        `${CONFIG.FACILITATOR_URL}/settle`,
        facilitatorBody,
        { timeout: 20_000 }
      );

      if (!settleRes.data || settleRes.data.success !== true) {
        return res.status(402).json({
          x402Version: 2,
          error: "settlement_failed",
          errorReason: settleRes.data && settleRes.data.errorReason,
        });
      }

      // Attach settlement receipt for the route handler / response formatting.
      req.x402Settlement = settleRes.data;
      return next();
    } catch (err) {
      const status = err.response && err.response.status;
      const detail = err.response && err.response.data;
      console.error("x402 facilitator error:", status, detail || err.message);
      return res.status(502).json({
        error: "facilitator_unreachable_or_errored",
        detail: detail || err.message,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Route: GET /api/weather?latitude=..&longitude=..
// Upstream: Open-Meteo (https://open-meteo.com) — free, no API key required.
// ---------------------------------------------------------------------------
app.get(
  "/api/weather",
  requirePayment(RESOURCES[0]),
  async (req, res) => {
    const latitude = parseFloat(req.query.latitude) || 36.47; // default: Blida, DZ
    const longitude = parseFloat(req.query.longitude) || 2.83;

    try {
      const upstream = await axios.get("https://api.open-meteo.com/v1/forecast", {
        params: {
          latitude,
          longitude,
          current_weather: true,
          timezone: "auto",
        },
        timeout: 10_000,
      });

      const cw = upstream.data.current_weather;
      const settlement = req.x402Settlement;

      const markdown = [
        `# Weather Report`,
        ``,
        `**Location**: ${latitude}, ${longitude}`,
        `**Temperature**: ${cw.temperature}°C`,
        `**Windspeed**: ${cw.windspeed} km/h`,
        `**Wind direction**: ${cw.winddirection}°`,
        `**Observed at**: ${cw.time}`,
        ``,
        `---`,
        `**Payment confirmed** — network: \`${settlement.network}\`, tx: \`${settlement.transaction}\``,
      ].join("\n");

      res.set("Content-Type", "text/markdown; charset=utf-8");
      return res.status(200).send(markdown);
    } catch (err) {
      console.error("Upstream API error:", err.message);
      return res.status(502).json({
        error: "upstream_api_error",
        detail: "Could not fetch data from Open-Meteo.",
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Route: GET /api/exchange-rate?from=USD&to=EUR
// Upstream: Frankfurter (https://frankfurter.dev) — free, no API key, ECB rates.
// ---------------------------------------------------------------------------
app.get(
  "/api/exchange-rate",
  requirePayment(RESOURCES[1]),
  async (req, res) => {
    const from = (req.query.from || "USD").toUpperCase();
    const to = (req.query.to || "EUR").toUpperCase();

    try {
      const upstream = await axios.get("https://api.frankfurter.dev/v1/latest", {
        params: { base: from, symbols: to },
        timeout: 10_000,
      });

      const rate = upstream.data.rates[to];
      const settlement = req.x402Settlement;

      if (rate === undefined) {
        return res.status(422).json({
          error: "unsupported_currency_pair",
          detail: `No rate available for ${from} -> ${to}.`,
        });
      }

      const markdown = [
        `# Exchange Rate`,
        ``,
        `**Pair**: ${from} → ${to}`,
        `**Rate**: 1 ${from} = ${rate} ${to}`,
        `**As of**: ${upstream.data.date}`,
        ``,
        `---`,
        `**Payment confirmed** — network: \`${settlement.network}\`, tx: \`${settlement.transaction}\``,
      ].join("\n");

      res.set("Content-Type", "text/markdown; charset=utf-8");
      return res.status(200).send(markdown);
    } catch (err) {
      console.error("Upstream API error:", err.message);
      return res.status(502).json({
        error: "upstream_api_error",
        detail: "Could not fetch data from Frankfurter.",
      });
    }
  }
);

// Health check — free, unpaid, useful for uptime pings.
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "blaitech-refinery",
    network: CONFIG.NETWORK,
    priceAtomic: CONFIG.PRICE_ATOMIC,
    paidEndpoints: RESOURCES.map((r) => r.path),
    llmsTxt: "/llms.txt",
  });
});

// llms.txt — machine-readable service manifest so LLMs/agents crawling this
// domain (or reading it via a tool call) can learn what's for sale and at
// what price without a human reading the docs first.
app.get("/llms.txt", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const lines = [
    `# Blaitech Data Refinery`,
    ``,
    `> x402-gated data endpoints for AI agents. Pay-per-call in USDC on network ${CONFIG.NETWORK}. No account, no API key.`,
    ``,
    `## Endpoints`,
    ``,
    ...RESOURCES.map(
      (r) =>
        `- **${base}${r.path}** — ${r.description} Price: ${CONFIG.PRICE_ATOMIC} atomic units of USDC per call (x402 "exact" scheme). Params: ${Object.keys(
          r.inputSchema.properties
        ).join(", ")}.`
    ),
    ``,
    `## Payment`,
    ``,
    `Protocol: x402 v2. On first request without a \`PAYMENT-SIGNATURE\` header, each endpoint above returns HTTP 402 with full payment requirements in the response body and the \`PAYMENT-REQUIRED\` header.`,
  ];
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send(lines.join("\n"));
});

// Local dev entrypoint (Vercel imports `app` directly and never runs this).
if (require.main === module) {
  const port = process.env.PORT || 4021;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = app;
