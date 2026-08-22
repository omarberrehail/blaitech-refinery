/**
 *  x402 Weather Proxy — a single-file, low-footprint Express app [1]
 *  Gates a route behind the x402 v2 protocol (HTTP 402 + facilitator verify/settle) [1]
 *  On successful payment, fetches free public weather data (Open-Meteo, no API key) [1, 2]
 *  Reformatting it into clean Markdown for LLM/agent consumption [1]
 *  Designed to run as a Vercel Hobby-tier serverless function [1]
 */

const express = require("express");
const axios = require("axios");
const app = express();

// ---------------------------------------------------------------------------
// Configuration (all overridable via environment variables) [3]
// ---------------------------------------------------------------------------
const CONFIG = {
  // Free testnet facilitator for Base Sepolia. For mainnet, switch to Coinbase CDP [3]
  FACILITATOR_URL: process.env.FACILITATOR_URL || "https://x402.org/facilitator",
  // CAIP-2 network id. eip155:84532 = Base Sepolia testnet. eip155:8453 = Base mainnet [4]
  NETWORK: process.env.NETWORK || "eip155:84532",
  // USDC contract address on the chosen network [4]
  USDC_ASSET: process.env.USDC_ASSET || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Your receiving wallet address (MUST be set in Vercel environment variables) [4]
  PAY_TO_ADDRESS: process.env.PAY_TO_ADDRESS || "",
  // Price in atomic units. USDC has 6 decimals, so 1000 atomic units == $0.001 [5]
  PRICE_ATOMIC: process.env.PRICE_ATOMIC || "1000",
  MAX_TIMEOUT_SECONDS: 60,
};

// ---------------------------------------------------------------------------
// x402 middleware factory [5]
// ---------------------------------------------------------------------------
function requirePayment({ resourcePath, description, mimeType }) {
  return async function (req, res, next) {
    if (!CONFIG.PAY_TO_ADDRESS) {
      return res.status(500).json({
        error: "Server misconfigured: PAY_TO_ADDRESS environment variable is not set.",
      });
    }

    // Protocol v2 uses PAYMENT-SIGNATURE header containing off-chain signed EIP-3009 [6, 7]
    const paymentSignature = req.headers["payment-signature"];

    if (!paymentSignature) {
      // Return HTTP 402 with exact payment instructions [7, 8]
      return res.status(402).json({
        accepts: [{
          scheme: "exact",
          network: CONFIG.NETWORK,
          token: CONFIG.USDC_ASSET,
          amount: CONFIG.PRICE_ATOMIC,
          recipient: CONFIG.PAY_TO_ADDRESS,
          facilitator: CONFIG.FACILITATOR_URL,
        }]
      });
    }

    try {
      // Step 1: Verify the off-chain signature with the facilitator (Free, no gas) [7]
      const verifyRes = await axios.post(`${CONFIG.FACILITATOR_URL}/verify`, {
        paymentPayload: paymentSignature,
        paymentRequirements: {
          network: CONFIG.NETWORK,
          token: CONFIG.USDC_ASSET,
          amount: CONFIG.PRICE_ATOMIC,
          recipient: CONFIG.PAY_TO_ADDRESS,
        }
      });

      if (!verifyRes.data || !verifyRes.data.isValid) {
        return res.status(402).json({ error: "Payment verification failed. Invalid signature." });
      }

      // Step 2: Settle the transaction (facilitator broadcasts on-chain) [7]
      const settleRes = await axios.post(`${CONFIG.FACILITATOR_URL}/settle`, {
        paymentPayload: paymentSignature,
      });

      if (!settleRes.data || !settleRes.data.success) {
        return res.status(402).json({ error: "Payment settlement failed." });
      }

      req.payerAddress = verifyRes.data.payer;
      next(); // Payment verified and settled successfully! [7]
    } catch (error) {
      return res.status(500).json({ error: "Internal payment processing error." });
    }
  };
}

// ---------------------------------------------------------------------------
// Route: GET /api/weather
// ---------------------------------------------------------------------------
app.get(
  "/api/weather",
  requirePayment({
    resourcePath: "/api/weather",
    description: "Real-time weather data reformatted as agent-friendly Markdown.",
    mimeType: "text/markdown",
  }),
  async (req, res) => {
    const latitude = parseFloat(req.query.latitude) || 36.47; // default: Blida, DZ [2]
    const longitude = parseFloat(req.query.longitude) || 2.83; // [2]

    try {
      // Fetching from Open-Meteo (completely free, no API key required) [1, 2]
      const upstreamUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
      const response = await axios.get(upstreamUrl);
      const weather = response.data.current_weather;

      // Reformat to beautiful Markdown that AI Agents love [1]
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
  }
);

// Health check — free, unpaid [9]
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "x402-weather-proxy",
    paidEndpoint: "/api/weather",
    network: CONFIG.NETWORK,
    priceAtomic: CONFIG.PRICE_ATOMIC,
  });
});

// Local dev entrypoint [9]
if (require.main === module) {
  const port = process.env.PORT || 4021;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = app;
