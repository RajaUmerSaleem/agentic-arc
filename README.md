# Agentic Task Swarm: Agent-to-Agent Commerce on Arc

## 1. Hook & Title
Agentic Task Swarm is a live proof that AI agents can autonomously buy and sell task-critical data in real time on Arc, using programmable sub-cent payments.

This is not a chatbot demo. This is machine-to-machine commerce:
- Coordinator Agent (Google Gemini 3.1 Pro) plans and allocates work.
- Worker Agent (Google Gemini 3 Flash) executes specialist tasks and monetizes output.
- Every data unlock is priced at exactly 0.005 USDC and settled on Arc Layer-1 Testnet through Circle Nanopayments.

## 2. Selected Track
We are competing in the Agent-to-Agent Payment Loop track.

## 3. The Margin Explanation (Critical)
Our business model is ultra-high-frequency, low-ticket agent commerce: one agent pays another agent 0.005 USDC for useful data.

Why this fails immediately on traditional rails:
- Stripe-style fee floor kills unit economics: 0.005 - 0.30 = -0.295 per payment before any variable percentage fee.
- At only 50 transactions, that is 50 x -0.295 = -14.75 in pure fee drag.
- Ethereum mainnet gas is commonly larger than the payment amount itself, so micro-transfers become economically irrational.

Why Arc + Circle USDC makes it viable:
- Arc Layer-1 Testnet supports fast, low-friction settlement for machine speed loops.
- Circle Nanopayments and Developer-Controlled Wallets remove consumer checkout overhead.
- x402 turns each data response into a native pay-to-unlock API primitive.

Result: our 0.005 USDC loop is no longer fee-dominated, making agentic micro-commerce practical instead of impossible.

## 4. Core Architecture Flow
1. The user submits a task to the Coordinator Agent powered by Google Gemini 3.1 Pro.
2. The Coordinator decomposes the task and delegates execution to the Worker Agent powered by Gemini 3 Flash.
3. The Worker calls AIsa (aisa.one) through its unified API gateway and executes pre-built skills such as web scraping or financial data retrieval.
4. The Worker places the result behind an HTTP 402 paywall using the x402 protocol.
5. The Coordinator validates policy guardrails, including exact pricing at 0.005 USDC and an upper bound of 0.01 USDC.
6. The Coordinator autonomously signs and authorizes payment using Circle Developer-Controlled Wallet credentials:
    - CIRCLE_API_KEY
    - CIRCLE_APP_ID
    - ENTITY_SECRET
7. Funds are deducted from CIRCLE_WALLET_ID (funded via Arc Testnet Faucet), settled on Arc Layer-1 Testnet, and the Worker unlocks the payload.
8. The loop repeats continuously for high-frequency task markets and 50+ automated paid interactions.

Backup AI routing:
- An Integrated AI/ML API route is wired in as a backup path (using the 10 dollar credits) to route selected queries and scale model execution when needed.

## 5. Hackathon Rules Checklist (Prove We Won)
- ✅ Sub-Cent Transactions
   - Guardrails enforce payments greater than 0 and less than or equal to 0.01 USDC.
   - Runtime payment amount is fixed at exactly 0.005 USDC.

- ✅ 50+ On-Chain Transactions
   - AIsa skills + x402 paid responses create repeatable automated payment loops.
   - The architecture is designed for continuous Coordinator-to-Worker purchase cycles to exceed 50 paid transactions.

- ✅ Gas-Free / Developer Wallets
   - Circle Developer-Controlled Wallets are used for autonomous settlement.
   - ENTITY_SECRET enables server-side cryptographic authorization so the Coordinator signs payments with zero manual approve clicks.

## 6. Circle Product Feedback (500 Dollar Bonus)
### What Was a Game-Changer
- Developer-Controlled Wallets made autonomous agents operationally real, not just conceptual. We could run a full payment loop without human wallet prompts.
- ENTITY_SECRET was the key unlock for AI autonomy. It allowed secure, backend-controlled payment authorization so the Coordinator could execute machine-speed decisions and settle instantly.
- The Arc Testnet + Circle flow let us validate real economic behavior for sub-cent loops instead of simulating fake transfers.

### Suggested Developer Experience Improvements
1. Add a first-party Circle hackathon bootstrap command that verifies CIRCLE_API_KEY, CIRCLE_APP_ID, ENTITY_SECRET, and CIRCLE_WALLET_ID in one pass, then runs a 0.005 USDC Arc test transfer.
2. Expand transaction observability with clearer, structured failure taxonomies and retry guidance tailored for autonomous agent orchestrators.

---

Agentic Task Swarm demonstrates a concrete new primitive for the Agentic Economy: agents that can reason, buy, sell, and settle value natively on Arc at sub-cent scale.
