import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import fetch from "node-fetch";
import { initiateDeveloperControlledWalletsClient, registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

// Circle SDK client helper (returns null if config is empty/placeholder)
// Note: old keys like "HACKATON_ENGINE" may work with @circle-fin/developer-controlled-wallets SDK
let circleClientInstance: any = null;
let circleClientError: string | null = null;

function getCircleClient() {
  const apiKey = process.env.CIRCLE_API_KEY?.trim() || '';
  const entitySecret = process.env.ENTITY_SECRET?.trim() || '';
  const hasKey = apiKey.length > 0 && apiKey !== 'MY_CIRCLE_API_KEY' && apiKey !== 'YOUR_CIRCLE_API_KEY';
  const hasSecret = entitySecret.length > 0 && entitySecret !== 'MY_ENTITY_SECRET' && entitySecret !== 'YOUR_ENTITY_SECRET';
  if (!hasKey || !hasSecret) return null;

  // Return cached instance if available
  if (circleClientInstance) return circleClientInstance;
  if (circleClientError) return null;

  try {
    circleClientInstance = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
    return circleClientInstance;
  } catch (err: any) {
    circleClientError = err?.message || 'Failed to initialize Circle client';
    console.error('[Circle SDK Init Error]', circleClientError);
    return null;
  }
}

const FINAL_SUCCESS_STATES = new Set(["CONFIRMED", "COMPLETE"]);
const FINAL_FAILURE_STATES = new Set(["FAILED", "DENIED", "CANCELLED"]);

function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isExactNanopayment(amount: number): boolean {
  return Math.abs(amount - 0.005) < 1e-9;
}

async function resolveArcUsdcTokenId(client: any, walletId: string): Promise<string> {
  const balanceRes = await client.getWalletTokenBalance({
    id: walletId,
    includeAll: true
  });

  const tokenBalances = balanceRes?.data?.tokenBalances || [];
  const usdcOnArc = tokenBalances.find((b: any) => {
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

async function waitForFinalTransaction(client: any, txId: string, timeoutMs = 60000, pollMs = 1500): Promise<any> {
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

function isCircleSandboxKey(apiKey?: string): boolean {
  const key = (apiKey || '').trim().toUpperCase();
  return key.startsWith('TEST_API_KEY:') || key.startsWith('TEST_') || key.startsWith('Q_');
}

function getRequestBaseUrl(req?: express.Request): string {
  const configuredRaw = (process.env.APP_URL || '').trim();
  const configured = configuredRaw.replace(/\/$/, '');
  const looksLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured);

  // Ignore localhost APP_URL in serverless/production deployments.
  if (configured && !(process.env.VERCEL && looksLocalhost)) {
    return configured;
  }

  if (req) {
    const forwardedProtoHeader = req.headers['x-forwarded-proto'];
    const forwardedHostHeader = req.headers['x-forwarded-host'];
    const proto =
      (Array.isArray(forwardedProtoHeader) ? forwardedProtoHeader[0] : forwardedProtoHeader)?.split(',')[0]?.trim() ||
      req.protocol ||
      'https';
    const host =
      (Array.isArray(forwardedHostHeader) ? forwardedHostHeader[0] : forwardedHostHeader)?.split(',')[0]?.trim() ||
      req.get('host');
    if (host) {
      return `${proto}://${host}`;
    }
  }

  return configured || 'http://localhost:3000';
}

export function createApiApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  // Health check for platform verification
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), appUrl: getRequestBaseUrl(req) });
  });

  // API routes
  app.get("/api/config", async (req, res) => {
    const walletId = (process.env.CIRCLE_WALLET_ID || process.env.CIRCLE_WALLET_ADDRESS || "PENDING_CONFIG");
    const isAddress = walletId.startsWith('0x');
    const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY?.trim() || '';
    const environment = CIRCLE_API_KEY ? (isCircleSandboxKey(CIRCLE_API_KEY) ? 'sandbox' : 'production') : 'unconfigured';
    
    let balance = "0.00";
    let balanceDetails: any = null;
    let balanceSource: 'sdk' | 'rest' | 'none' = 'none';

    if (walletId !== "PENDING_CONFIG" && !isAddress) {
      const client = getCircleClient();

      try {
        // Primary path: Circle SDK (works with Developer-Controlled Wallets and Entity Secret signing setup)
        if (client) {
          const sdkBalance = await client.getWalletTokenBalance({ id: walletId, includeAll: true });
          const tokenBalances = sdkBalance?.data?.tokenBalances || [];
          const usdcOnArc = tokenBalances.find((b: any) => {
            const symbol = String(b?.token?.symbol || '').toUpperCase();
            const chain = String(b?.token?.blockchain || '').toUpperCase();
            return symbol === 'USDC' && chain === 'ARC-TESTNET';
          });
          const preferred = usdcOnArc || tokenBalances[0];
          if (preferred?.amount) balance = preferred.amount;
          balanceDetails = tokenBalances;
          balanceSource = 'sdk';
        } else if (CIRCLE_API_KEY) {
          // Fallback path: direct REST call to W3S endpoint
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          try {
            const baseUrl = environment === 'sandbox' ? 'https://api-sandbox.circle.com' : 'https://api.circle.com';
            const headers: Record<string, string> = {
              'Authorization': `Bearer ${CIRCLE_API_KEY}`,
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            };
            const balanceRes = await fetch(`${baseUrl}/v1/w3s/wallets/${walletId}/balances`, {
              headers,
              signal: controller.signal as any
            });
            const text = await balanceRes.text();
            let balanceData: any;
            try {
              balanceData = JSON.parse(text);
            } catch (e) {
              console.error("Circle Balance Parse Error:", text);
              throw new Error("Invalid response from Circle balance API");
            }

            const tokenBalances = balanceData?.data?.tokenBalances || [];
            const usdcOnArc = tokenBalances.find((b: any) => {
              const symbol = String(b?.token?.symbol || '').toUpperCase();
              const chain = String(b?.token?.blockchain || '').toUpperCase();
              return symbol === 'USDC' && chain === 'ARC-TESTNET';
            });
            const preferred = usdcOnArc || tokenBalances[0];
            if (preferred?.amount) balance = preferred.amount;
            balanceDetails = tokenBalances;
            balanceSource = 'rest';
          } finally {
            clearTimeout(timeoutId);
          }
        }
      } catch (err) {
        console.error("Balance fetch error:", err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        balanceDetails = {
          error: errorMessage,
          code: (err as any)?.code || null,
          hint: "If this persists, verify CIRCLE_WALLET_ID belongs to the same Circle account and environment as CIRCLE_API_KEY."
        };
      }
    }
    
    // Always return 200 JSON for config to prevent HTML fallbacks
    return res.json({
      walletId,
      balance,
      balanceDetails,
      balanceSource,
      appUrl: getRequestBaseUrl(req),
      isAddressNotice: isAddress ? "WARNING: Your Wallet ID starts with 0x. Circle usually requires a UUID (e.g. 1000...) as the ID, not the address." : null,
      hasGemini: !!process.env.GEMINI_API_KEY,
      network: "Arc Layer-1 Testnet",
      status: environment === 'sandbox' ? 'Sandbox Mode' : (environment === 'production' ? 'Production Mode' : 'Unconfigured'),
      environment
    });
  });

  // API Proxy for Circle
  app.post("/api/pay", async (req, res) => {
    const { amount, recipientWallet, workerId } = req.body || {};

    const walletId = (process.env.CIRCLE_WALLET_ID || "").trim();
    const appId = (process.env.CIRCLE_APP_ID || "").trim(); // optional tracking value
    const client = getCircleClient(); // must be initialized with CIRCLE_API_KEY + ENTITY_SECRET

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

      const finalized = await waitForFinalTransaction(client, circleTransactionId, 60000, 1500);

      return res.json({
        success: true,
        txHash: finalized?.txHash || circleTransactionId,
        circleTransactionId,
        status: finalized?.state || "PENDING",
        amount: amount.toFixed(6),
        appIdLoaded: Boolean(appId),
        timestamp: Date.now()
      });
    } catch (err: any) {
      const details = err?.response?.data || err?.data || null;
      const message = details?.message || err?.message || "Circle transfer failed";

      return res.status(502).json({
        success: false,
        error: message,
        details
      });
    }
  });

  // ── Circle SDK Wallet Management (from arc-engine integration) ──

  // Register entity secret ciphertext (one-time setup)
  app.post("/api/register", async (req, res) => {
    const apiKey = process.env.CIRCLE_API_KEY?.trim() || '';
    const entitySecret = process.env.ENTITY_SECRET?.trim() || '';
    if (!apiKey || !entitySecret) {
      return res.status(400).json({ success: false, error: 'CIRCLE_API_KEY and ENTITY_SECRET required' });
    }
    try {
      const response = await registerEntitySecretCiphertext({ apiKey, entitySecret });
      return res.json({
        success: true,
        recoveryFile: response.data?.recoveryFile,
        message: 'Engine registered successfully. Save the recovery file!'
      });
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('malformed API key')) {
        return res.json({ success: false, error: msg, demo: true, info: 'Your Circle key is in the old format. Hackathon demo mode active.' });
      }
      if (msg.includes('Invalid credentials')) {
        return res.json({
          success: false,
          error: 'Invalid credentials: Entity Secret may already be registered, or API key / IP allowlist mismatch.',
          demo: true,
          info: 'Skip registration and try creating a wallet directly. If that also fails, the app will use demo mode for the hackathon.'
        });
      }
      console.error('[REGISTER]', err);
      return res.status(500).json({ success: false, error: msg || 'Registration failed' });
    }
  });

  // List all wallets
  app.get("/api/wallets", async (req, res) => {
    const client = getCircleClient();
    if (!client) {
      // Client init failed or not configured — return demo mode gracefully
      if (circleClientError) {
        return res.json({ success: false, error: circleClientError, demo: true, info: 'Circle SDK initialization failed. Hackathon demo mode active.' });
      }
      return res.json({ success: false, error: 'Circle SDK not configured', demo: true, info: 'Hackathon demo mode: create a wallet to see simulated addresses.' });
    }
    try {
      const response = await client.listWallets({});
      return res.json({
        success: true,
        wallets: response.data?.wallets || [],
        count: response.data?.wallets?.length || 0
      });
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('malformed API key') || msg.includes('Invalid credentials')) {
        return res.json({ success: false, error: msg, demo: true, info: 'Circle credentials invalid (API key format, entity secret, or IP mismatch). Hackathon demo mode active.' });
      }
      console.error('[WALLETS LIST]', err);
      return res.status(500).json({ success: false, error: msg || 'Failed to list wallets' });
    }
  });

  // Create wallet set + wallet (returns address for agent use)
  app.post("/api/wallets", async (req, res) => {
    const client = getCircleClient();
    const { name = 'Agent Wallet', blockchain = 'ETH-SEPOLIA', accountType = 'SCA' } = req.body;
    try {
      if (!client) throw new Error('Circle SDK not configured');
      const setRes = await client.createWalletSet({ name: `${name} Set` });
      const walletSetId = setRes.data?.walletSet?.id;
      if (!walletSetId) throw new Error('Wallet set creation returned no ID');

      const walletRes = await client.createWallets({
        accountType: accountType as 'SCA' | 'EOA',
        blockchains: [blockchain],
        count: 1,
        walletSetId
      });

      const wallet = walletRes.data?.wallets?.[0];
      return res.json({
        success: true,
        walletSetId,
        wallet: wallet || null,
        address: wallet?.address || null,
        message: wallet ? `Wallet created on ${blockchain}` : 'Wallet creation failed'
      });
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('malformed API key') || msg.includes('Invalid credentials')) {
        // Return a simulated demo wallet so the UI still works
        const demoAddress = '0x' + Array.from({length: 40}, () => Math.floor(Math.random() * 16).toString(16)).join('');
        return res.json({
          success: true,
          demo: true,
          wallet: { id: 'demo-' + Date.now(), address: demoAddress, blockchain, state: 'DEMO' },
          address: demoAddress,
          info: 'Hackathon demo wallet (Circle credentials invalid — API key, entity secret, or IP mismatch)'
        });
      }
      console.error('[WALLET CREATE]', err);
      return res.status(500).json({ success: false, error: msg || 'Wallet creation failed' });
    }
  });

  // Get wallet details by ID
  app.get("/api/wallets/:id", async (req, res) => {
    const client = getCircleClient();
    if (!client) {
      return res.status(503).json({ success: false, error: 'Circle SDK not configured' });
    }
    try {
      const response = await client.listWallets({});
      const wallet = (response.data?.wallets || []).find((w: any) => w.id === req.params.id);
      if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });
      return res.json({ success: true, wallet });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Failed to get wallet' });
    }
  });

  // Get wallet balance (USDC) by wallet ID
  app.get("/api/wallets/:id/balance", async (req, res) => {
    const client = getCircleClient();
    if (!client) {
      return res.json({ success: false, error: 'Circle SDK not configured', demo: true, balance: '0.00' });
    }
    try {
      // Circle SDK getWalletTokenBalance or listWallets with ID
      const response = await client.listWallets({});
      const wallet = (response.data?.wallets || []).find((w: any) => w.id === req.params.id);
      if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });

      // Try to get balance from wallet object (SDK may return balances in extended data)
      const walletData = wallet as any;
      const balances = walletData.balances || [];
      const usdcBalance = balances.find((b: any) => b?.token?.symbol === 'USDC' || b?.token?.name?.includes('USD'));
      const balance = usdcBalance?.amount || '0.00';

      return res.json({ success: true, balance, walletId: req.params.id, address: wallet.address });
    } catch (err: any) {
      return res.json({ success: false, error: err?.message || 'Failed to get balance', balance: '0.00' });
    }
  });

  // Proxy endpoint for fallback AI (OpenAI-compatible chat completions)
  app.post("/api/chat", async (req, res) => {
    const FALLBACK_API_KEY = process.env.FALLBACK_AI_API_KEY;
    const FALLBACK_BASE_URL = (process.env.FALLBACK_AI_BASE_URL || '').replace(/\/$/, '');
    const FALLBACK_MODEL = process.env.FALLBACK_AI_MODEL || 'gpt-3.5-turbo';

    if (!FALLBACK_API_KEY) {
      return res.status(500).json({ success: false, error: "FALLBACK_AI_API_KEY not configured" });
    }

    // Common OpenAI-compatible endpoints to try
    const endpoints = FALLBACK_BASE_URL
      ? [FALLBACK_BASE_URL]
      : [
          'https://api.openai.com/v1',
          'https://openrouter.ai/api/v1',
          'https://api.groq.com/openai/v1',
          'https://api.together.xyz/v1',
          'https://api.fireworks.ai/inference/v1',
        ];

    const { messages, temperature = 0.7, max_tokens = 512 } = req.body;

    for (const baseUrl of endpoints) {
      try {
        const model = baseUrl.includes('openrouter')
          ? 'openai/gpt-3.5-turbo'
          : FALLBACK_MODEL;

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${FALLBACK_API_KEY}`,
          'Content-Type': 'application/json',
        };

        if (baseUrl.includes('openrouter')) {
          headers['HTTP-Referer'] = req.headers.referer || getRequestBaseUrl(req);
          headers['X-Title'] = 'Arc Agentic Swarm';
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.log(`[Fallback] ${baseUrl} failed: HTTP ${response.status} - ${errorText.slice(0, 200)}`);
          continue;
        }

        const data = await response.json() as Record<string, unknown>;
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const text = (choices[0] as any)?.message?.content || (data.output as string) || '';
        if (text) {
          return res.json({ success: true, text, provider: baseUrl });
        }
      } catch (err: any) {
        console.log(`[Fallback] ${baseUrl} error: ${err?.message}`);
        continue;
      }
    }

    return res.status(502).json({
      success: false,
      error: "All fallback AI providers failed. Check your FALLBACK_AI_API_KEY and FALLBACK_AI_BASE_URL in .env.local",
    });
  });

  // Global 404 for API routes to prevent HTML fallout
  app.use("/api/*", (req, res) => {
    res.status(404).json({ success: false, error: "API Route Not Found" });
  });

  return app;
}

async function startServer() {
  const app = createApiApp();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (process.env.NODE_ENV === "production" && !fs.existsSync(path.join(process.cwd(), "dist"))) {
      console.warn("WARNING: Server started in PRODUCTION mode but 'dist' directory is missing!");
    }
  });
}

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === path.resolve(currentFilePath);
})();

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
