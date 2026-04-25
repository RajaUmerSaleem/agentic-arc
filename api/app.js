import express from "express";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
let circleClientInstance = null;
let circleClientError = null;
const CIRCLE_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CIRCLE_REQUEST_TIMEOUT_MS || "9000", 10);
let circleSdkPromise = null;
let circleSdkError = null;
function safeAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
function withTimeout(promise, timeoutMs, operation) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeoutError = new Error(`${operation} timed out after ${timeoutMs}ms`);
      timeoutError.code = "ETIMEDOUT";
      reject(timeoutError);
    }, timeoutMs);
    promise.then(resolve).catch(reject).finally(() => clearTimeout(timer));
  });
}
function isRecoverableCircleError(message) {
  const normalized = message.toLowerCase();
  return normalized.includes("malformed api key") || normalized.includes("invalid credentials") || normalized.includes("timed out") || normalized.includes("timeout") || normalized.includes("fetch failed") || normalized.includes("econnreset") || normalized.includes("enotfound") || normalized.includes("socket hang up") || normalized.includes("service unavailable");
}
async function getCircleSdk() {
  if (circleSdkPromise) return circleSdkPromise;
  circleSdkPromise = import("@circle-fin/developer-controlled-wallets").then((mod) => ({
    initiateDeveloperControlledWalletsClient: mod.initiateDeveloperControlledWalletsClient,
    registerEntitySecretCiphertext: mod.registerEntitySecretCiphertext
  })).catch((err) => {
    circleSdkError = err?.message || "Failed to load Circle SDK";
    console.error("[Circle SDK Load Error]", circleSdkError);
    return null;
  });
  return circleSdkPromise;
}
async function getCircleClient() {
  const apiKey = process.env.CIRCLE_API_KEY?.trim() || "";
  const entitySecret = process.env.ENTITY_SECRET?.trim() || "";
  const hasKey = apiKey.length > 0 && apiKey !== "MY_CIRCLE_API_KEY" && apiKey !== "YOUR_CIRCLE_API_KEY";
  const hasSecret = entitySecret.length > 0 && entitySecret !== "MY_ENTITY_SECRET" && entitySecret !== "YOUR_ENTITY_SECRET";
  if (!hasKey || !hasSecret) return null;
  if (circleClientInstance) return circleClientInstance;
  if (circleClientError) return null;
  try {
    const sdk = await getCircleSdk();
    if (!sdk) {
      circleClientError = circleSdkError || "Circle SDK unavailable";
      return null;
    }
    circleClientInstance = sdk.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
    return circleClientInstance;
  } catch (err) {
    circleClientError = err?.message || "Failed to initialize Circle client";
    console.error("[Circle SDK Init Error]", circleClientError);
    return null;
  }
}
const FINAL_SUCCESS_STATES = /* @__PURE__ */ new Set(["CONFIRMED", "COMPLETE"]);
const FINAL_FAILURE_STATES = /* @__PURE__ */ new Set(["FAILED", "DENIED", "CANCELLED"]);
function isValidEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
function isExactNanopayment(amount) {
  return Math.abs(amount - 5e-3) < 1e-9;
}
async function resolveArcUsdcTokenId(client, walletId) {
  const balanceRes = await client.getWalletTokenBalance({
    id: walletId,
    includeAll: true
  });
  const tokenBalances = balanceRes?.data?.tokenBalances || [];
  const usdcOnArc = tokenBalances.find((b) => {
    const symbol = String(b?.token?.symbol || "").toUpperCase();
    const chain = String(b?.token?.blockchain || "").toUpperCase();
    return symbol === "USDC" && chain === "ARC-TESTNET";
  });
  const tokenId = usdcOnArc?.token?.id;
  if (!tokenId) {
    throw new Error("USDC token not found for this wallet on ARC-TESTNET. Fund wallet with ARC testnet USDC first.");
  }
  return tokenId;
}
async function waitForFinalTransaction(client, txId, timeoutMs = 6e4, pollMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const txRes = await client.getTransaction({ id: txId });
    const tx = txRes?.data?.transaction;
    const state = String(tx?.state || "");
    if (FINAL_SUCCESS_STATES.has(state)) {
      return tx;
    }
    if (FINAL_FAILURE_STATES.has(state)) {
      const reason = tx?.errorReason || "Circle transfer failed";
      const details = tx?.errorDetails ? " | " + tx.errorDetails : "";
      throw new Error(reason + details);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("Timed out waiting for Circle transaction finalization.");
}
function isCircleSandboxKey(apiKey) {
  const key = (apiKey || "").trim().toUpperCase();
  return key.startsWith("TEST_API_KEY:") || key.startsWith("TEST_") || key.startsWith("Q_");
}
function getRequestBaseUrl(req) {
  const configuredRaw = (process.env.APP_URL || "").trim();
  const configured = configuredRaw.replace(/\/$/, "");
  const looksLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured);
  if (configured && !(process.env.VERCEL && looksLocalhost)) {
    return configured;
  }
  if (req) {
    const forwardedProtoHeader = req.headers["x-forwarded-proto"];
    const forwardedHostHeader = req.headers["x-forwarded-host"];
    const proto = (Array.isArray(forwardedProtoHeader) ? forwardedProtoHeader[0] : forwardedProtoHeader)?.split(",")[0]?.trim() || req.protocol || "https";
    const host = (Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader)?.split(",")[0]?.trim() || req.get("host");
    if (host) {
      return `${proto}://${host}`;
    }
  }
  return configured || "http://localhost:3000";
}
function createApiApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), appUrl: getRequestBaseUrl(req) });
  });
  app.get("/api/config", safeAsync(async (req, res) => {
    const walletId = process.env.CIRCLE_WALLET_ID || process.env.CIRCLE_WALLET_ADDRESS || "PENDING_CONFIG";
    const isAddress = walletId.startsWith("0x");
    const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY?.trim() || "";
    const environment = CIRCLE_API_KEY ? isCircleSandboxKey(CIRCLE_API_KEY) ? "sandbox" : "production" : "unconfigured";
    let balance = "0.00";
    let balanceDetails = null;
    let balanceSource = "none";
    if (walletId !== "PENDING_CONFIG" && !isAddress) {
      const client = await getCircleClient();
      try {
        if (client) {
          const sdkBalance = await client.getWalletTokenBalance({ id: walletId, includeAll: true });
          const tokenBalances = sdkBalance?.data?.tokenBalances || [];
          const usdcOnArc = tokenBalances.find((b) => {
            const symbol = String(b?.token?.symbol || "").toUpperCase();
            const chain = String(b?.token?.blockchain || "").toUpperCase();
            return symbol === "USDC" && chain === "ARC-TESTNET";
          });
          const preferred = usdcOnArc || tokenBalances[0];
          if (preferred?.amount) balance = preferred.amount;
          balanceDetails = tokenBalances;
          balanceSource = "sdk";
        } else if (CIRCLE_API_KEY) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8e3);
          try {
            const baseUrl = environment === "sandbox" ? "https://api-sandbox.circle.com" : "https://api.circle.com";
            const headers = {
              "Authorization": `Bearer ${CIRCLE_API_KEY}`,
              "Accept": "application/json",
              "Content-Type": "application/json"
            };
            const balanceRes = await fetch(`${baseUrl}/v1/w3s/wallets/${walletId}/balances`, {
              headers,
              signal: controller.signal
            });
            const text = await balanceRes.text();
            let balanceData;
            try {
              balanceData = JSON.parse(text);
            } catch {
              console.error("Circle Balance Parse Error:", text);
              throw new Error("Invalid response from Circle balance API");
            }
            const tokenBalances = balanceData?.data?.tokenBalances || [];
            const usdcOnArc = tokenBalances.find((b) => {
              const symbol = String(b?.token?.symbol || "").toUpperCase();
              const chain = String(b?.token?.blockchain || "").toUpperCase();
              return symbol === "USDC" && chain === "ARC-TESTNET";
            });
            const preferred = usdcOnArc || tokenBalances[0];
            if (preferred?.amount) balance = preferred.amount;
            balanceDetails = tokenBalances;
            balanceSource = "rest";
          } finally {
            clearTimeout(timeoutId);
          }
        }
      } catch (err) {
        console.error("Balance fetch error:", err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        balanceDetails = {
          error: errorMessage,
          code: err?.code || null,
          hint: "If this persists, verify CIRCLE_WALLET_ID belongs to the same Circle account and environment as CIRCLE_API_KEY."
        };
      }
    }
    return res.json({
      walletId,
      balance,
      balanceDetails,
      balanceSource,
      appUrl: getRequestBaseUrl(req),
      isAddressNotice: isAddress ? "WARNING: Your Wallet ID starts with 0x. Circle usually requires a UUID (e.g. 1000...) as the ID, not the address." : null,
      hasGemini: !!process.env.GEMINI_API_KEY,
      network: "Arc Layer-1 Testnet",
      status: environment === "sandbox" ? "Sandbox Mode" : environment === "production" ? "Production Mode" : "Unconfigured",
      environment
    });
  }));
  app.post("/api/pay", safeAsync(async (req, res) => {
    const { amount, recipientWallet, workerId } = req.body || {};
    const walletId = (process.env.CIRCLE_WALLET_ID || "").trim();
    const appId = (process.env.CIRCLE_APP_ID || "").trim();
    const client = await getCircleClient();
    if (!client) {
      return res.status(500).json({
        success: false,
        error: "Circle client is not initialized. Check CIRCLE_API_KEY and ENTITY_SECRET."
      });
    }
    if (!walletId) {
      return res.status(500).json({
        success: false,
        error: "CIRCLE_WALLET_ID is missing."
      });
    }
    if (typeof amount !== "number" || Number.isNaN(amount)) {
      return res.status(400).json({
        success: false,
        error: "Invalid amount type."
      });
    }
    if (!isExactNanopayment(amount)) {
      return res.status(400).json({
        success: false,
        error: "Policy violation: payment must be exactly 0.005 USDC."
      });
    }
    if (amount <= 0 || amount > 0.01) {
      return res.status(400).json({
        success: false,
        error: "Financial guardrail violation: amount must be > 0 and <= 0.01."
      });
    }
    if (!isValidEvmAddress(String(recipientWallet || ""))) {
      return res.status(400).json({
        success: false,
        error: "Invalid recipient wallet address."
      });
    }
    try {
      const usdcTokenId = await resolveArcUsdcTokenId(client, walletId);
      const createTx = await client.createTransaction({
        idempotencyKey: uuidv4(),
        walletId,
        tokenId: usdcTokenId,
        destinationAddress: recipientWallet,
        amount: [amount.toFixed(6)],
        fee: {
          type: "level",
          config: { feeLevel: "MEDIUM" }
        },
        refId: "swarm:" + String(workerId || "worker") + ":" + Date.now()
      });
      const circleTransactionId = createTx?.data?.id;
      if (!circleTransactionId) {
        throw new Error("Circle did not return a transaction id.");
      }
      const finalized = await waitForFinalTransaction(client, circleTransactionId, 6e4, 1500);
      return res.json({
        success: true,
        txHash: finalized?.txHash || circleTransactionId,
        circleTransactionId,
        status: finalized?.state || "PENDING",
        amount: amount.toFixed(6),
        appIdLoaded: Boolean(appId),
        timestamp: Date.now()
      });
    } catch (err) {
      const details = err?.response?.data || err?.data || null;
      const message = details?.message || err?.message || "Circle transfer failed";
      return res.status(502).json({
        success: false,
        error: message,
        details
      });
    }
  }));
  app.post("/api/register", safeAsync(async (req, res) => {
    const apiKey = process.env.CIRCLE_API_KEY?.trim() || "";
    const entitySecret = process.env.ENTITY_SECRET?.trim() || "";
    if (!apiKey || !entitySecret) {
      return res.status(400).json({ success: false, error: "CIRCLE_API_KEY and ENTITY_SECRET required" });
    }
    try {
      const sdk = await getCircleSdk();
      if (!sdk) {
        return res.json({ success: false, error: circleSdkError || "Circle SDK unavailable", demo: true, info: "Circle SDK could not load on this runtime. Hackathon demo mode active." });
      }
      const response = await sdk.registerEntitySecretCiphertext({ apiKey, entitySecret });
      return res.json({
        success: true,
        recoveryFile: response.data?.recoveryFile,
        message: "Engine registered successfully. Save the recovery file!"
      });
    } catch (err) {
      const msg = err?.message || "";
      if (msg.includes("malformed API key")) {
        return res.json({ success: false, error: msg, demo: true, info: "Your Circle key is in the old format. Hackathon demo mode active." });
      }
      if (msg.includes("Invalid credentials")) {
        return res.json({
          success: false,
          error: "Invalid credentials: Entity Secret may already be registered, or API key / IP allowlist mismatch.",
          demo: true,
          info: "Skip registration and try creating a wallet directly. If that also fails, the app will use demo mode for the hackathon."
        });
      }
      console.error("[REGISTER]", err);
      return res.status(500).json({ success: false, error: msg || "Registration failed" });
    }
  }));
  app.get("/api/wallets", safeAsync(async (req, res) => {
    const client = await getCircleClient();
    if (!client) {
      if (circleClientError) {
        return res.json({ success: false, error: circleClientError, demo: true, info: "Circle SDK initialization failed. Hackathon demo mode active." });
      }
      if (circleSdkError) {
        return res.json({ success: false, error: circleSdkError, demo: true, info: "Circle SDK failed to load in this runtime. Hackathon demo mode active." });
      }
      return res.json({ success: false, error: "Circle SDK not configured", demo: true, info: "Hackathon demo mode: create a wallet to see simulated addresses." });
    }
    try {
      const response = await withTimeout(client.listWallets({}), CIRCLE_REQUEST_TIMEOUT_MS, "Circle listWallets");
      return res.json({
        success: true,
        wallets: response.data?.wallets || [],
        count: response.data?.wallets?.length || 0
      });
    } catch (err) {
      const msg = err?.message || "";
      if (isRecoverableCircleError(msg)) {
        return res.json({ success: false, error: msg, demo: true, info: "Circle credentials invalid (API key format, entity secret, or IP mismatch). Hackathon demo mode active." });
      }
      console.error("[WALLETS LIST]", err);
      return res.json({
        success: false,
        error: msg || "Failed to list wallets",
        demo: true,
        info: "Circle service temporarily unavailable. Showing demo mode to keep the app usable on Vercel."
      });
    }
  }));
  app.post("/api/wallets", safeAsync(async (req, res) => {
    const client = await getCircleClient();
    const { name = "Agent Wallet", blockchain = "ETH-SEPOLIA", accountType = "SCA" } = req.body;
    try {
      if (!client) throw new Error("Circle SDK not configured");
      const setRes = await withTimeout(
        client.createWalletSet({ name: `${name} Set` }),
        CIRCLE_REQUEST_TIMEOUT_MS,
        "Circle createWalletSet"
      );
      const walletSetId = setRes.data?.walletSet?.id;
      if (!walletSetId) throw new Error("Wallet set creation returned no ID");
      const walletRes = await withTimeout(client.createWallets({
        accountType,
        blockchains: [blockchain],
        count: 1,
        walletSetId
      }), CIRCLE_REQUEST_TIMEOUT_MS, "Circle createWallets");
      const wallet = walletRes.data?.wallets?.[0];
      return res.json({
        success: true,
        walletSetId,
        wallet: wallet || null,
        address: wallet?.address || null,
        message: wallet ? `Wallet created on ${blockchain}` : "Wallet creation failed"
      });
    } catch (err) {
      const msg = err?.message || "";
      if (isRecoverableCircleError(msg)) {
        const demoAddress = "0x" + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        return res.json({
          success: true,
          demo: true,
          wallet: { id: "demo-" + Date.now(), address: demoAddress, blockchain, state: "DEMO" },
          address: demoAddress,
          info: "Hackathon demo wallet (Circle credentials invalid \u2014 API key, entity secret, or IP mismatch)"
        });
      }
      console.error("[WALLET CREATE]", err);
      return res.status(500).json({ success: false, error: msg || "Wallet creation failed" });
    }
  }));
  app.get("/api/wallets/:id", safeAsync(async (req, res) => {
    const client = await getCircleClient();
    if (!client) {
      return res.status(503).json({ success: false, error: "Circle SDK not configured" });
    }
    try {
      const response = await withTimeout(client.listWallets({}), CIRCLE_REQUEST_TIMEOUT_MS, "Circle listWallets by id");
      const wallet = (response.data?.wallets || []).find((w) => w.id === req.params.id);
      if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
      return res.json({ success: true, wallet });
    } catch (err) {
      const msg = err?.message || "Failed to get wallet";
      if (isRecoverableCircleError(msg)) {
        return res.status(503).json({ success: false, error: msg, demo: true });
      }
      return res.status(500).json({ success: false, error: msg });
    }
  }));
  app.get("/api/wallets/:id/balance", safeAsync(async (req, res) => {
    const client = await getCircleClient();
    if (!client) {
      return res.json({ success: false, error: "Circle SDK not configured", demo: true, balance: "0.00" });
    }
    try {
      const response = await withTimeout(client.listWallets({}), CIRCLE_REQUEST_TIMEOUT_MS, "Circle listWallets for balance");
      const wallet = (response.data?.wallets || []).find((w) => w.id === req.params.id);
      if (!wallet) return res.status(404).json({ success: false, error: "Wallet not found" });
      const walletData = wallet;
      const balances = walletData.balances || [];
      const usdcBalance = balances.find((b) => b?.token?.symbol === "USDC" || b?.token?.name?.includes("USD"));
      const balance = usdcBalance?.amount || "0.00";
      return res.json({ success: true, balance, walletId: req.params.id, address: wallet.address });
    } catch (err) {
      const msg = err?.message || "Failed to get balance";
      if (isRecoverableCircleError(msg)) {
        return res.json({ success: false, error: msg, demo: true, balance: "0.00" });
      }
      return res.json({ success: false, error: msg, balance: "0.00" });
    }
  }));
  app.post("/api/chat", safeAsync(async (req, res) => {
    const FALLBACK_API_KEY = process.env.FALLBACK_AI_API_KEY;
    const FALLBACK_BASE_URL = (process.env.FALLBACK_AI_BASE_URL || "").replace(/\/$/, "");
    const FALLBACK_MODEL = process.env.FALLBACK_AI_MODEL || "gpt-3.5-turbo";
    if (!FALLBACK_API_KEY) {
      return res.status(500).json({ success: false, error: "FALLBACK_AI_API_KEY not configured" });
    }
    const endpoints = FALLBACK_BASE_URL ? [FALLBACK_BASE_URL] : [
      "https://api.openai.com/v1",
      "https://openrouter.ai/api/v1",
      "https://api.groq.com/openai/v1",
      "https://api.together.xyz/v1",
      "https://api.fireworks.ai/inference/v1"
    ];
    const { messages, temperature = 0.7, max_tokens = 512 } = req.body;
    for (const baseUrl of endpoints) {
      try {
        const model = baseUrl.includes("openrouter") ? "openai/gpt-3.5-turbo" : FALLBACK_MODEL;
        const headers = {
          "Authorization": `Bearer ${FALLBACK_API_KEY}`,
          "Content-Type": "application/json"
        };
        if (baseUrl.includes("openrouter")) {
          headers["HTTP-Referer"] = req.headers.referer || getRequestBaseUrl(req);
          headers["X-Title"] = "Arc Agentic Swarm";
        }
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens
          })
        });
        if (!response.ok) {
          const errorText = await response.text();
          console.log(`[Fallback] ${baseUrl} failed: HTTP ${response.status} - ${errorText.slice(0, 200)}`);
          continue;
        }
        const data = await response.json();
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const text = choices[0]?.message?.content || data.output || "";
        if (text) {
          return res.json({ success: true, text, provider: baseUrl });
        }
      } catch (err) {
        console.log(`[Fallback] ${baseUrl} error: ${err?.message}`);
        continue;
      }
    }
    return res.status(502).json({
      success: false,
      error: "All fallback AI providers failed. Check your FALLBACK_AI_API_KEY and FALLBACK_AI_BASE_URL in .env.local"
    });
  }));
  app.use("/api/*", (req, res) => {
    res.status(404).json({ success: false, error: "API Route Not Found" });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error("[API UNHANDLED]", err);
    const message = err?.message || "Unexpected server error";
    return res.status(500).json({ success: false, error: message, demo: true });
  });
  return app;
}
export {
  createApiApp
};
