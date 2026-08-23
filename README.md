/**
 *  🌍 Blaitech Data Refinery — Multi-Service Data Proxy (api/index.js)
 *  Gates routes behind the x402 v2 protocol (HTTP 402 + facilitator verify/settle)
 *  Provides /api/weather, /api/exchange-rate, and /llms.txt
 *  Optimized to run as a free Vercel Hobby-tier serverless function
 */

const express = require("express");
const axios = require("axios");
const app = express();

// ---------------------------------------------------------------------------
// Configuration (Overridable via Vercel Environment Variables)
// ---------------------------------------------------------------------------
const CONFIG = {
  // Free production facilitator provided by Coinbase CDP (Base Mainnet)
  FACILITATOR_URL: process.env.FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402",
  // CAIP-2 network id. eip155:8453 = Base mainnet (Real USDC)
  NETWORK: process.env.NETWORK || "eip155:8453",
  // Official USDC contract address on Base Mainnet
  USDC_ASSET: process.env.USDC_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // Your receiving wallet address (MUST be set in Vercel Environment Variables)
  PAY_TO_ADDRESS: process.env.PAY_TO_ADDRESS || "",
  // Price in atomic units. USDC has 6 decimals, so 1000 atomic units == $0.001 (1/10 of a cent)
  PRICE_ATOMIC: process.env.PRICE_ATOMIC || "1000",
  MAX_TIMEOUT_SECONDS: 60,
};

// ---------------------------------------------------------------------------
// Resource Registry (Services for Sale)
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
// x402 Middleware Factory (Two-step v2 /verify + /settle flow)
// ---------------------------------------------------------------------------
function requirePayment({ path: resourcePath, description, mimeType, inputSchema }) {
  return async function (req, res, next) {
    if (!CONFIG.PAY_TO_ADDRESS) {
      return res.status(500).json({
        error: "Server misconfigured: PAY_TO_ADDRESS environment variable is not set.",
      });
    }

    // Protocol v2 uses PAYMENT-SIGNATURE header containing off-chain signed EIP-3009
    const paymentSignature = req.headers["payment-signature"];

    if (!paymentSignature) {
      // Return HTTP 402 with exact payment challenge instructions
      return res.status(402).json({
        accepts: [
          {
            scheme: "exact",
            network: CONFIG.NETWORK,
            token: CONFIG.USDC_ASSET,
            amount: CONFIG.PRICE_ATOMIC,
            recipient: CONFIG.PAY_TO_ADDRESS,
            facilitator: CONFIG.FACILITATOR_URL,
          },
        ],
      });
    }

    try {
      // Step 1: Verify the off-chain signature with the facilitator (Free, no gas)
      const verifyRes = await axios.post(`${CONFIG.FACILITATOR_URL}/verify`, {
        paymentPayload: paymentSignature,
        paymentRequirements: {
          network: CONFIG.NETWORK,
          token: CONFIG.USDC_ASSET,
          amount: CONFIG.PRICE_ATOMIC,
          recipient: CONFIG.PAY_TO_ADDRESS,
        },
      });

      if (!verifyRes.data || !verifyRes.data.isValid) {
        return res.status(402).json({ error: "Payment verification failed. Invalid signature." });
      }

      // Step 2: Settle the transaction (facilitator broadcasts on-chain)
      const settleRes = await axios.post(`${CONFIG.FACILITATOR_URL}/settle`, {
        paymentPayload: paymentSignature,
      });

      if (!settleRes.data || !settleRes.data.success) {
        return res.status(402).json({ error: "Payment settlement failed." });
      }

      req.payerAddress = verifyRes.data.payer;
      next(); // Payment verified and settled successfully! Proceed to API!
    } catch (error) {
      console.error("❌ x402 Error:", error.message);
      return res.status(500).json({ error: "Internal payment processing error." });
    }
  };
}

// ---------------------------------------------------------------------------
// Route: GET /api/weather
// Upstream: Open-Meteo (Free public API, no keys)
// ---------------------------------------------------------------------------
app.get("/api/weather", requirePayment(RESOURCES), async (req, res) => {
  const latitude = parseFloat(req.query.latitude) || 36.47; // default: Blida, DZ
  const longitude = parseFloat(req.query.longitude) || 2.83;

  try {
    const upstreamUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
    const response = await axios.get(upstreamUrl);
    const weather = response.data.current_weather;

    // Reformat into clean Markdown optimized for LLM/Agent consumption
    const markdownOutput = `
# 🌤️ Real-Time Weather Report
*Refined for AI Agents & LLM consumption*

- **Location**: Latitude ${latitude}, Longitude ${longitude}
- **Current Temperature**: ${weather.temperature}°C
- **Wind Speed**: ${weather.windspeed} km/h
- **Wind Direction**: ${weather.winddirection}°
- **Observation Time**: ${weather.time}

*Thank you for your payment of ${CONFIG.PRICE_ATOMIC} atomic units on network ${CONFIG.NETWORK}!*
    `.trim();

    res.set("Content-Type", "text/markdown");
    res.status(200).send(markdownOutput);
  } catch (error) {
    res.status(500).send("Error retrieving meteorological data.");
  }
});

// ---------------------------------------------------------------------------
// Route: GET /api/exchange-rate
// Upstream: Frankfurter (Free ECB rates, no keys)
// ---------------------------------------------------------------------------
app.get("/api/exchange-rate", requirePayment(RESOURCES[1]), async (req, res) => {
  const from = (req.query.from || "USD").toUpperCase();
  const to = (req.query.to || "EUR").toUpperCase();

  try {
    const upstreamUrl = `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`;
    const response = await axios.get(upstreamUrl);
    const rate = response.data.rates[to];

    // Reformat into clean Markdown optimized for LLM/Agent consumption
    const markdownOutput = `
# 💱 Real-Time Foreign Exchange Rate
*Refined for AI Agents & LLM consumption*

- **Base Currency**: ${from}
- **Target Currency**: ${to}
- **Exchange Rate**: 1 ${from} = ${rate} ${to}
- **As of**: ${response.data.date}

*Thank you for your payment of ${CONFIG.PRICE_ATOMIC} atomic units on network ${CONFIG.NETWORK}!*
    `.trim();

    res.set("Content-Type", "text/markdown");
    res.status(200).send(markdownOutput);
  } catch (error) {
    res.status(500).send("Error retrieving exchange rate data.");
  }
});

// ---------------------------------------------------------------------------
// Free / Unpaid Route: Health check
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Free / Unpaid Route: llms.txt (Machine-readable service manual)
// ---------------------------------------------------------------------------
app.get("/llms.txt", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const lines = [
    "# Blaitech Data Refinery",
    "",
    `> x402-gated data endpoints for AI agents. Pay-per-call in USDC on network ${CONFIG.NETWORK}. No account, no API key.`,
    "",
    "## Endpoints",
    "",
    ...RESOURCES.map(
      (r) => `- **${base}${r.path}** — ${r.description} Price: ${CONFIG.PRICE_ATOMIC} atomic units of USDC per call (x402 "exact" scheme). Params: ${Object.keys(r.inputSchema.properties).join(", ")}.`
    ),
    "",
    "## Payment",
    "",
    `Protocol: x402 v2. On first request without a \`PAYMENT-SIGNATURE\` header, each endpoint above returns HTTP 402 with full payment requirements in the response body and the \`PAYMENT-REQUIRED\` header.`,
  ];
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send(lines.join("\n"));
});

// Local Development Entrypoint
if (require.main === module) {
  const port = process.env.PORT || 4021;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = app;
