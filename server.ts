import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
import fetch from "node-fetch";

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json());

  // Health check for platform verification
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // API routes
  app.get("/api/config", async (req, res) => {
    const walletId = (process.env.CIRCLE_WALLET_ID || process.env.CIRCLE_WALLET_ADDRESS || "PENDING_CONFIG");
    const isAddress = walletId.startsWith('0x');
    const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
    
    let balance = "0.00";
    let balanceDetails = null;

    if (CIRCLE_API_KEY && walletId !== "PENDING_CONFIG" && !isAddress) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout
      
      try {
        const isSandbox = CIRCLE_API_KEY?.startsWith('Q_');
        const baseUrl = isSandbox ? 'https://api-sandbox.circle.com' : 'https://api.circle.com';
        
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${CIRCLE_API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        };
        
        // Fetch balance from Circle using the correct environment URL
        const balanceRes = await fetch(`${baseUrl}/v1/wallets/${walletId}/balances`, { 
          headers,
          signal: controller.signal as any
        });
        const text = await balanceRes.text();
        clearTimeout(timeoutId);
        let balanceData;
        try {
          balanceData = JSON.parse(text);
        } catch (e) {
          console.error("Circle Balance Parse Error:", text);
          throw new Error("Invalid response from Circle balance API");
        }
        
        if (balanceRes.ok && balanceData.data && Array.isArray(balanceData.data) && balanceData.data[0]) {
          balance = balanceData.data[0].amount;
          balanceDetails = balanceData.data;
        }
      } catch (err) {
        console.error("Balance fetch error:", err);
        balanceDetails = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    
    // Always return 200 JSON for config to prevent HTML fallbacks
    return res.json({
      walletId,
      balance,
      balanceDetails,
      isAddressNotice: isAddress ? "WARNING: Your Wallet ID starts with 0x. Circle usually requires a UUID (e.g. 1000...) as the ID, not the address." : null,
      hasGemini: !!process.env.GEMINI_API_KEY,
      network: "Arc Layer-1 Mainnet",
      status: "Production Mode",
      environment: CIRCLE_API_KEY?.startsWith('Q_') ? 'sandbox' : 'production'
    });
  });

  // API Proxy for Circle
  app.post("/api/pay", async (req, res) => {
    const { amount, recipientWallet, workerId } = req.body;
    
    // Using exact variable names as they appear in the Secrets panel
    const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
    const CIRCLE_WALLET_ID = process.env.CIRCLE_WALLET_ID || process.env.CIRCLE_WALLET_ADDRESS;
    const CIRCLE_APP_ID = process.env.CIRCLE_APP_ID;
    
    const isSandbox = CIRCLE_API_KEY?.startsWith('Q_'); // Circle Sandbox keys usually start with Q_
    const baseUrl = isSandbox ? 'https://api-sandbox.circle.com' : 'https://api.circle.com';

    console.log(`[${isSandbox ? 'SANDBOX' : 'PRODUCTION'} MODE] Moving funds from ${CIRCLE_WALLET_ID} to ${recipientWallet} via Arc L1`);

    // Strict Hackathon Rule 1: Sub-cent guardrail
    if (typeof amount !== 'number' || amount > 0.01 || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Financial Policy Violation: Transaction must be between $0.0001 and $0.01 USDC." 
      });
    }

    if (!CIRCLE_API_KEY || CIRCLE_API_KEY === "MY_CIRCLE_API_KEY") {
      return res.status(500).json({ 
        success: false, 
        error: "Configuration Error: `CIRCLE_API_KEY` is missing in Secrets panel." 
      });
    }

    if (!CIRCLE_WALLET_ID || CIRCLE_WALLET_ID === "MY_WALLET_ID") {
      return res.status(500).json({ 
        success: false, 
        error: "Configuration Error: `CIRCLE_WALLET_ID` is missing in Secrets panel." 
      });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for payments

      // Circle API Headers
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      };

      // If CIRCLE_APP_ID is present, we include it as per Circle Programmable Wallets requirements
      if (CIRCLE_APP_ID && CIRCLE_APP_ID !== "MY_CIRCLE_APP_ID") {
        headers['X-Circle-Application-Id'] = CIRCLE_APP_ID;
      }

      // Correct endpoint for Wallet-to-Wallet Nanopayments on Arc
      // Documentation: https://developers.circle.com/reference/createtransfer
      const response = await fetch(`${baseUrl}/v1/transfers`, {
        method: 'POST',
        headers,
        signal: controller.signal as any,
        body: JSON.stringify({
          idempotencyKey: uuidv4(),
          source: { 
            id: CIRCLE_WALLET_ID, 
            type: 'wallet' 
          },
          destination: { 
            type: 'blockchain',
            address: recipientWallet, 
            chain: 'ARC' 
          },
          amount: { 
            amount: amount.toFixed(4), 
            currency: 'USD' 
          },
        })
      });
      clearTimeout(timeoutId);

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error("[CIRCLE RESPONSE PARSE ERROR]", text);
        return res.status(500).json({
          success: false,
          error: "Circle returned an invalid response format.",
          raw: text.slice(0, 500)
        });
      }
      
      if (!response.ok) {
        console.error("[CIRCLE ERROR DETAIL]", JSON.stringify(data, null, 2));
        const circleError = data.message || data.error || (data.errors && data.errors[0]?.message) || `Circle API error (${response.status})`;
        
        // We return 200 with success:false to prevent intermediate proxies from replacing our JSON error with HTML error pages on 403/401/etc.
        return res.json({
          success: false,
          error: circleError,
          status: response.status,
          details: data,
          info: response.status === 403 ? "Circle 403 Forbidden: 1. Ensure your API Key is authorized for 'Payments/Transfers'. 2. Check if your API Key is a 'Standard' key vs. 'Programmable Wallets' key. 3. Ensure your IP is not restricted in Circle Dashboard." : null
        });
      }

      console.log(`[SUCCESS] Payment finalized on Arc L1. Tx: ${data.data.id}`);

      return res.json({
        success: true,
        txHash: data.data.id, // Using Circle's internal tracking ID or blockchain hash
        amount: data.data.amount.amount,
        status: data.data.status,
        timestamp: Date.now()
      });

    } catch (err) {
      console.error("[PAYMENT FATAL]", err);
      res.status(500).json({ 
        success: false, 
        error: "Blockchain Settlement Failed",
        details: err instanceof Error ? err.message : "Undefined error"
      });
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
          headers['HTTP-Referer'] = req.headers.referer || 'http://localhost';
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

startServer();
