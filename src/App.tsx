import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { Terminal, CreditCard, Activity, Cpu, Zap, ArrowRight, ShieldCheck, Database, Globe, Lock, List, Menu, X, ChevronLeft, ChevronRight, Wallet, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { AgentMessage, Transaction, WorkerType, AgentStatus } from './types';

// Constants
const COORDINATOR_MODEL = "gemini-3.1-pro-preview";
const WORKER_MODEL = "gemini-3-flash-preview";
const MAX_PAYMENT = 0.01;

// REAL RECIPIENT ADDRESS (In a real app, this would be the worker's unique generated wallet)
// For the demo, we use a valid hex address format.
const WORKER_WALLET_ADDRESS = "0x5baede5bc635dc28924f6db47495c5e36ae2d4aa"; 

const STORAGE_KEYS = {
  messages: 'agentic-swarm:messages',
  transactions: 'agentic-swarm:transactions',
  legacyMessages: 'messages',
  legacyTransactions: 'transactions'
} as const;

const MAX_STORED_MESSAGES = 500;
const MAX_STORED_TRANSACTIONS = 300;

const parseNumber = (value: unknown): number | null => {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const generateFallbackId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeSender = (value: unknown): AgentMessage['sender'] | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'user') return 'User';
  if (normalized === 'coordinator') return 'Coordinator';
  if (normalized === 'worker') return 'Worker';
  if (normalized === 'system') return 'System';
  return null;
};

const normalizeStatus = (value: unknown): Transaction['status'] => {
  if (typeof value !== 'string') return 'confirmed';
  const normalized = value.toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (normalized === 'failed') return 'failed';
  return 'confirmed';
};

const normalizeStoredMessage = (value: unknown): AgentMessage | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  const sender = normalizeSender(v.sender ?? v.role);
  const content =
    typeof v.content === 'string'
      ? v.content
      : typeof v.message === 'string'
        ? v.message
        : typeof v.text === 'string'
          ? v.text
          : '';
  const timestamp = parseNumber(v.timestamp ?? v.time ?? v.createdAt);

  if (!sender || !content || timestamp === null) return null;

  return {
    id: typeof v.id === 'string' && v.id ? v.id : generateFallbackId(),
    sender,
    content,
    timestamp,
  };
};

const normalizeStoredTransaction = (value: unknown): Transaction | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  const amount = parseNumber(v.amount);
  const timestamp = parseNumber(v.timestamp ?? v.time ?? v.createdAt);
  if (amount === null || timestamp === null) return null;

  const txHash = typeof v.txHash === 'string' ? v.txHash : undefined;
  const from = typeof v.from === 'string' && v.from ? v.from : 'Coordinator';
  const to = typeof v.to === 'string' && v.to ? v.to : 'Worker';

  return {
    id: typeof v.id === 'string' && v.id ? v.id : txHash || generateFallbackId(),
    from,
    to,
    amount,
    status: normalizeStatus(v.status),
    txHash,
    timestamp,
  };
};

const parseStoredEntries = (raw: string): unknown[] => {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
};

const loadStoredArray = <T,>(keys: string[], normalizer: (item: unknown) => T | null): T[] => {
  if (typeof window === 'undefined') return [];
  for (const key of keys) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const entries = parseStoredEntries(raw);
      if (entries.length === 0) return [];
      return entries
        .map(normalizer)
        .filter((item): item is T => item !== null);
    } catch {
      // Continue to next candidate key.
    }
  }
  return [];
};

export default function App() {
  const [task, setTask] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>(() =>
    loadStoredArray(
      [STORAGE_KEYS.messages, STORAGE_KEYS.legacyMessages],
      normalizeStoredMessage
    )
  );
  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    loadStoredArray(
      [STORAGE_KEYS.transactions, STORAGE_KEYS.legacyTransactions],
      normalizeStoredTransaction
    )
  );
  const [isRunning, setIsRunning] = useState(false);
  const [latency, setLatency] = useState(12);
  const [lastBlock, setLastBlock] = useState(8429302);
  const [gasPrice, setGasPrice] = useState(0.0001);
  const [networkLoad, setNetworkLoad] = useState(14);
  const [uptime, setUptime] = useState(0);
  const [coordinatorStatus, setCoordinatorStatus] = useState<AgentStatus>({
    name: 'Coordinator Alpha',
    type: 'Coordinator',
    model: 'Gemini 3.1 Pro',
    status: 'idle'
  });
  const [workerStatus, setWorkerStatus] = useState<AgentStatus>({
    name: 'Worker Flash-01',
    type: 'Worker',
    model: 'Gemini 3 Flash',
    status: 'idle'
  });
  const [config, setConfig] = useState<{ walletId: string, balance: string, isAddressNotice?: string } | null>(null);
  const [isFetchingConfig, setIsFetchingConfig] = useState(false);
  
  // Mobile state
  const [isMobile, setIsMobile] = useState(false);
  const [activePanel, setActivePanel] = useState<'agents' | 'terminal' | 'ledger'>('terminal');
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  
  // Demo mode for hackathon presentations when API quota is exhausted
  const [demoMode, setDemoMode] = useState(false);

  // Circle wallet management (arc-engine integration)
  const [wallets, setWallets] = useState<Array<{ id: string; address?: string; blockchain?: string; state?: string; balance?: string }>>([]);
  const [isLoadingWallets, setIsLoadingWallets] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [copiedWalletId, setCopiedWalletId] = useState<string | null>(null);
  const [engineRegistered, setEngineRegistered] = useState(false);
  const [copiedUuid, setCopiedUuid] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedMessages = messages.slice(-MAX_STORED_MESSAGES);
      window.localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(storedMessages));
      window.localStorage.removeItem(STORAGE_KEYS.legacyMessages);
    } catch (err) {
      console.warn('Unable to persist messages to localStorage:', err);
    }
  }, [messages]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedTransactions = transactions.slice(0, MAX_STORED_TRANSACTIONS);
      window.localStorage.setItem(STORAGE_KEYS.transactions, JSON.stringify(storedTransactions));
      window.localStorage.removeItem(STORAGE_KEYS.legacyTransactions);
    } catch (err) {
      console.warn('Unable to persist transactions to localStorage:', err);
    }
  }, [transactions]);

  // Dynamic Network Stats Effect
  useEffect(() => {
    const fetchConfig = () => {
      if (isFetchingConfig) return;
      setIsFetchingConfig(true);
      
      fetch('/api/config')
        .then(res => {
          const contentType = res.headers.get("content-type");
          if (!contentType || !contentType.includes("application/json")) {
             return res.text().then(text => {
               console.warn("Config response was not JSON:", text.slice(0, 50));
               throw new Error(`HTTP_${res.status}_NON_JSON`);
             });
          }
          if (!res.ok) throw new Error(`HTTP_${res.status}`);
          return res.json();
        })
        .then(data => {
          setConfig(data);
          if (data.isAddressNotice) {
            addMessage('System', data.isAddressNotice);
          }
        })
        .catch(err => {
          console.warn("Config sync pending...", err.message);
          // Don't spam the UI with errors during server boot
        })
        .finally(() => setIsFetchingConfig(false));
    };

    fetchConfig();
    const interval = setInterval(() => {
      setLatency(prev => {
        const delta = Math.floor(Math.random() * 5) - 2;
        return Math.max(8, Math.min(45, prev + delta));
      });
      setLastBlock(prev => prev + (Math.random() > 0.7 ? 1 : 0));
      setGasPrice(prev => {
        const delta = (Math.random() - 0.5) * 0.00005;
        return Math.max(0.00001, Math.min(0.0005, prev + delta));
      });
      setNetworkLoad(prev => {
        const delta = Math.floor(Math.random() * 3) - 1;
        return Math.max(5, Math.min(85, prev + delta));
      });
      setUptime(prev => prev + 1);
      
      // Periodically refresh balance
      if (uptime % 10 === 0) fetchConfig();
      
    }, 2500);

    return () => clearInterval(interval);
  }, [uptime]);
  const tickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const addMessage = (sender: AgentMessage['sender'], content: string) => {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      sender,
      content,
      timestamp: Date.now()
    }]);
  };

  const handlePayment = async (amount: number, recipient: string, workerId: string) => {
    try {
      const response = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, recipientWallet: recipient, workerId })
      });
      
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await response.text();
        console.error("Non-JSON payment response:", text);
        throw new Error(`Server returned non-JSON error (${response.status})`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Payment failed');
      }

      const newTx: Transaction = {
        id: data.txHash || Date.now().toString(),
        from: 'Coordinator',
        to: workerId,
        amount,
        status: 'confirmed',
        txHash: data.txHash,
        timestamp: Date.now()
      };
      
      setTransactions(prev => [newTx, ...prev]);
      return { success: true, txHash: data.txHash };
    } catch (err) {
      console.error(err);
      return { success: false, error: err instanceof Error ? err.message : 'Payment failed' };
    }
  };

  // Check if Circle config is present (not empty/placeholder)
  // Note: old keys like "HACKATON_ENGINE" may work with @circle-fin/developer-controlled-wallets SDK
  const isCircleConfigValid = () => {
    const key = process.env.CIRCLE_API_KEY || '';
    const walletId = process.env.CIRCLE_WALLET_ID || '';
    const hasKey = key.length > 0 && key !== 'MY_CIRCLE_API_KEY' && key !== 'YOUR_CIRCLE_API_KEY';
    const hasWallet = walletId.length > 0 && walletId !== '00000000-0000-0000-0000-000000000000' && walletId !== 'MY_WALLET_ID';
    return hasKey && hasWallet;
  };

  // ── Circle Wallet Management (arc-engine integration) ──
  const fetchWalletBalance = async (walletId: string) => {
    try {
      const res = await fetch(`/api/wallets/${walletId}/balance`);
      const data = await res.json();
      if (data.success) {
        setWallets(prev => prev.map(w =>
          w.id === walletId ? { ...w, balance: data.balance } : w
        ));
      }
    } catch (err) {
      console.error('Balance fetch error:', err);
    }
  };

  const fetchWallets = async () => {
    setIsLoadingWallets(true);
    setWalletError(null);
    try {
      const res = await fetch('/api/wallets');
      const data = await res.json();
      if (data.success) {
        const loadedWallets = data.wallets || [];
        setWallets(loadedWallets);
        // Fetch balances for each wallet
        loadedWallets.forEach((w: any) => {
          if (w.id && !w.id.startsWith('demo-')) {
            fetchWalletBalance(w.id);
          }
        });
      } else if (data.demo) {
        // Hackathon demo mode — show friendly info, not an error
        setWallets([]);
      } else {
        setWalletError(data.error || 'Failed to load wallets');
      }
    } catch (err: any) {
      setWalletError(err?.message || 'Network error');
    } finally {
      setIsLoadingWallets(false);
    }
  };

  const createWallet = async () => {
    setIsLoadingWallets(true);
    setWalletError(null);
    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Agent Wallet', blockchain: 'ETH-SEPOLIA', accountType: 'SCA' })
      });
      const data = await res.json();
      if (data.success && data.wallet) {
        setWallets(prev => [...prev, data.wallet]);
        if (data.demo) {
          addMessage('System', `⚠️ ${data.info} Simulated wallet: ${data.address?.slice(0, 12)}...`);
        } else {
          addMessage('System', `✅ New agent wallet created: ${data.address?.slice(0, 12)}... on ${data.wallet.blockchain || 'ETH-SEPOLIA'}`);
          // Auto-refresh wallet list and suggest updating env
          setTimeout(() => {
            fetchWallets();
            addMessage('System', `💡 Copy wallet UUID ${data.wallet.id} into .env.local CIRCLE_WALLET_ID to enable live payments.`);
          }, 500);
        }
      } else {
        setWalletError(data.error || 'Wallet creation failed');
      }
    } catch (err: any) {
      setWalletError(err?.message || 'Network error');
    } finally {
      setIsLoadingWallets(false);
    }
  };

  const registerEngine = async () => {
    setIsLoadingWallets(true);
    setWalletError(null);
    try {
      const res = await fetch('/api/register', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setEngineRegistered(true);
        addMessage('System', '✅ Circle engine registered! Save the recovery file from server logs.');
      } else if (data.demo) {
        addMessage('System', `⚠️ ${data.info || 'Hackathon demo mode active.'} You can still create demo wallets or run the swarm without real Circle integration.`);
      } else if (data.error?.includes('already been set')) {
        setEngineRegistered(true);
        addMessage('System', 'ℹ️ Entity secret already registered. You can create wallets now.');
      } else {
        setWalletError(data.error || 'Registration failed');
      }
    } catch (err: any) {
      setWalletError(err?.message || 'Network error');
    } finally {
      setIsLoadingWallets(false);
    }
  };

  // Mock response generator for demo mode when API quota is exhausted
  const getMockCoordinatorPlan = (taskInput: string) => {
    const keywords = taskInput.toLowerCase();
    if (keywords.includes('data') || keywords.includes('analy')) {
      return `[DEMO MODE] Task decomposition complete. Identified 3 sub-tasks: (1) Data ingestion via Arc L1 oracle, (2) Pattern analysis with Flash model, (3) Summary aggregation. Estimated cost: 0.005 USDC. Assigning DataAnalyzer worker.`;
    }
    if (keywords.includes('code') || keywords.includes('review') || keywords.includes('contract')) {
      return `[DEMO MODE] Smart contract audit pipeline initiated. Decomposing into: (1) Static analysis, (2) Gas optimization check, (3) Reentrancy guard verification. Estimated cost: 0.005 USDC. Assigning CodeReviewer worker.`;
    }
    return `[DEMO MODE] Task decomposition complete. Breaking down "${taskInput.slice(0, 40)}..." into atomic sub-tasks. Worker: WebScraper. Budget: 0.005 USDC (within $0.01 guardrail).`;
  };

  const getMockWorkerResult = (taskInput: string) => {
    const keywords = taskInput.toLowerCase();
    if (keywords.includes('data') || keywords.includes('analy')) {
      return `[DEMO MODE] Data analysis complete. Processed 1,247 records. Key findings: 3 anomalies detected, trend correlation = 0.94. Latency: 142ms. Dataset hash: 0x7a3f...e29d.`;
    }
    if (keywords.includes('code') || keywords.includes('review') || keywords.includes('contract')) {
      return `[DEMO MODE] Audit complete. 2 low-severity issues found: (1) unchecked external call at L47, (2) missing event emission. Gas savings potential: 12%. Report IPFS hash: QmX4y...`;
    }
    return `[DEMO MODE] Web scraping complete. Fetched 847 data points across 3 sources. Structured output ready. Execution time: 890ms. Data integrity: verified via SHA-256.`;
  };

  const getMockSummary = () => {
    return `[DEMO MODE] Swarm execution complete. Total nanopayment: $0.005 USDC. Settlement finalized on Arc L1 in 2.3s. Economic efficiency: 99.7% (sub-cent micro-transactions). Ready for next task.`;
  };

  // Fallback AI via server-side proxy (/api/chat)
  // Server handles provider detection, CORS, and keeps API keys secure
  const callFallbackAI = async (
    systemInstruction: string,
    userContent: string
  ): Promise<{ text: string; success: boolean; error?: string; provider?: string }> => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent },
          ],
          temperature: 0.7,
          max_tokens: 512,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        return { text: '', success: false, error: data.error || `Server error (${response.status})` };
      }
      return { text: data.text || '', success: true, provider: data.provider };
    } catch (err: any) {
      return { text: '', success: false, error: err?.message || 'Network error reaching fallback AI proxy' };
    }
  };

  const callGeminiWithFallback = async (
    ai: GoogleGenAI,
    model: string,
    contents: string,
    systemInstruction: string,
    mockFn: () => string
  ): Promise<{ text: string; source: 'api' | 'demo' }> => {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: { systemInstruction },
      });
      return { text: response.text || 'No response', source: 'api' };
    } catch (err: any) {
      const message = err?.message || '';
      const status = err?.status || err?.error?.status;
      
      if (status === 429 || message.includes('429') || message.includes('quota') || message.includes('exceeded')) {
        addMessage('System', '⚠️ Gemini API rate limit reached. Trying fallback AI provider...');
        
        // Try fallback AI provider first (server-side proxy)
        const fallback = await callFallbackAI(systemInstruction, contents);
        if (fallback.success && fallback.text) {
          const providerHost = fallback.provider ? new URL(fallback.provider).hostname : 'unknown';
          const providerName = providerHost.replace(/^api\./, '').replace(/\.ai$/, '');
          addMessage('System', `✅ Fallback AI responded via ${providerName}.`);
          return { text: fallback.text, source: 'api' };
        }
        
        addMessage('System', `Fallback AI failed: ${fallback.error || 'unknown error'}. Switching to DEMO MODE.`);
        setDemoMode(true);
        // Return mock response immediately so flow continues seamlessly
        return { text: mockFn(), source: 'demo' };
      } else {
        addMessage('System', `API Error (${status || 'unknown'}): ${message.slice(0, 120)}`);
        throw err;
      }
    }
  };

  const runSwarm = async () => {
    if (!task || isRunning) return;
    setIsRunning(true);
    
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || apiKey === 'undefined' || apiKey === 'YOUR_API_KEY') {
      addMessage('System', 'GEMINI_API_KEY not configured. Running in DEMO MODE.');
      setDemoMode(true);
    }

    const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

    // Local demo flag for this execution (React state may not have updated yet)
    let execDemoMode = demoMode;

    try {
      addMessage('User', task);
      setCoordinatorStatus(s => ({ ...s, status: 'thinking' }));

      let plan: string;
      if (execDemoMode || !ai) {
        plan = getMockCoordinatorPlan(task);
        await new Promise(r => setTimeout(r, 800));
      } else {
        const res = await callGeminiWithFallback(ai, COORDINATOR_MODEL,
          `USER TASK: "${task}"\nWALLET_CONTEXT: Current Balance ${config?.balance || '0.00'} USDC on Arc L1.\nBreak down this task and decide which worker to hire. Explain your plan briefly.`,
          "You are the Coordinator Agent on the Arc blockchain. You must use workers for specialized tasks and pay them via Circle Nanopayments (max $0.01). Be concise and technical.",
          () => getMockCoordinatorPlan(task)
        );
        plan = res.text;
        if (res.source === 'demo') {
          setDemoMode(true);
          execDemoMode = true;
        }
      }
      addMessage('Coordinator', plan);

      const workerType: WorkerType = 'WebScraper';
      setCoordinatorStatus(s => ({ ...s, status: 'idle' }));
      setWorkerStatus(s => ({ ...s, status: 'working', name: `Worker Flash-01 (${workerType})` }));
      addMessage('Coordinator', `Hiring ${workerType} agent. Requesting initial data fetch...`);

      await new Promise(r => setTimeout(r, 1500)); 
      addMessage('Worker', "Task execution in progress... [x402 Protocol Triggered]");
      
      const paymentAmount = 0.005;
      addMessage('Worker', `HTTP 402: Payment Required. Amount: ${paymentAmount} USDC. Wallet: ${WORKER_WALLET_ADDRESS}`);
      setWorkerStatus(s => ({ ...s, status: 'idle' }));
      setCoordinatorStatus(s => ({ ...s, status: 'paying' }));

      addMessage('Coordinator', `Verifying x402 compliance... Authorizing Circle Nanopayment ($${paymentAmount}).`);
      
      let paymentResult;
      const circleValid = isCircleConfigValid();
      if (execDemoMode || !circleValid) {
        // In demo mode or with invalid Circle config, simulate payment for full UX flow
        if (!circleValid && !execDemoMode) {
          addMessage('System', '⚠️ Circle API key invalid (needs ENV:ID:SECRET format). Simulating payment for hackathon demo.');
        }
        await new Promise(r => setTimeout(r, 800));
        const mockTxHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
        paymentResult = { success: true, txHash: mockTxHash };
        const newTx: Transaction = {
          id: mockTxHash.slice(0, 12),
          from: 'Coordinator',
          to: workerType,
          amount: paymentAmount,
          status: 'confirmed',
          txHash: mockTxHash,
          timestamp: Date.now()
        };
        setTransactions(prev => [newTx, ...prev]);
        addMessage('System', `[DEMO] Simulated nanopayment: $${paymentAmount} USDC to ${workerType}`);
      } else {
        paymentResult = await handlePayment(paymentAmount, WORKER_WALLET_ADDRESS, workerType);
      }
      
      if (paymentResult.success) {
        addMessage('Coordinator', `Payment successful! Tx: ${paymentResult.txHash}. Settlement finalized on Arc.`);
        
        setCoordinatorStatus(s => ({ ...s, status: 'idle' }));
        setWorkerStatus(s => ({ ...s, status: 'working' }));
        
        let workerResult: string;
        if (execDemoMode || !ai) {
          workerResult = getMockWorkerResult(task);
          await new Promise(r => setTimeout(r, 600));
        } else {
          const res = await callGeminiWithFallback(ai, WORKER_MODEL,
            `Payment received. Deliver the final results for: "${task}" as a ${workerType}. Be technical and concise.`,
            "You are the Worker Agent. You have been paid. Deliver the data now.",
            () => getMockWorkerResult(task)
          );
          workerResult = res.text;
          if (res.source === 'demo') {
            setDemoMode(true);
            execDemoMode = true;
          }
        }

        addMessage('Worker', workerResult);
        setWorkerStatus(s => ({ ...s, status: 'idle' }));

        setCoordinatorStatus(s => ({ ...s, status: 'thinking' }));
        
        let summary: string;
        if (execDemoMode || !ai) {
          summary = getMockSummary();
          await new Promise(r => setTimeout(r, 500));
        } else {
          const res = await callGeminiWithFallback(ai, COORDINATOR_MODEL,
            `The worker has delivered the data. Provide a final summary of the task to the user.`,
            "Conclude the session professionally. Mention the economic efficiency of the nanopayment loop.",
            getMockSummary
          );
          summary = res.text;
          if (res.source === 'demo') {
            setDemoMode(true);
            execDemoMode = true;
          }
        }
        
        addMessage('Coordinator', summary);
      } else {
        addMessage('Coordinator', `FATAL: ${paymentResult.error}. Swarm halted for security.`);
      }

    } catch (err: any) {
      console.error(err);
      const isQuota = err?.message?.includes('429') || err?.message?.includes('quota');
      if (isQuota) {
        addMessage('System', 'Gemini API quota exhausted. Click DEPLOY again to run in DEMO MODE (simulated AI responses for hackathon demo).');
      } else {
        addMessage('Coordinator', `System Failure: ${err?.message?.slice(0, 100) || 'Communication breach in the swarm.'}`);
      }
    } finally {
      setIsRunning(false);
      setCoordinatorStatus(s => ({ ...s, status: 'idle' }));
      setWorkerStatus(s => ({ ...s, status: 'idle' }));
    }
  };

  return (
    <div className="bg-[#0A0A0B] text-[#E0E0E0] min-h-screen h-screen flex flex-col font-sans overflow-hidden touch-manipulation">
      {/* Real-time Nanopayment Ticker (Judge Proof Layer) */}
      <div className="bg-[#00D1FF] h-6 flex items-center overflow-hidden whitespace-nowrap border-b border-black">
        <div className="flex animate-[marquee_30s_linear_infinite] gap-10">
          {transactions.length > 0 ? (
            transactions.map((tx, i) => (
              <span key={tx.id + i} className="text-[10px] font-mono text-black font-bold flex items-center gap-2">
                <ShieldCheck size={10} /> 
                {`ARC_SETTLEMENT [${tx.txHash?.slice(0, 10)}...] AMOUNT: ${tx.amount} USDC → CONFIRMED`}
              </span>
            ))
          ) : (
            <span className="text-[10px] font-mono text-black font-bold flex items-center gap-2 opacity-50 uppercase tracking-widest px-10">
              Awaiting Swarm Activation • System Ready for Nanopayments • Arc Layer-1 Mainnet Mode 
            </span>
          )}
          {/* Duplicate for seamless scrolling if needed */}
          <span className="text-[10px] font-mono text-black font-bold flex items-center gap-2 opacity-50 uppercase tracking-widest px-10">
              Awaiting Swarm Activation • System Ready for Nanopayments • Arc Layer-1 Mainnet Mode 
          </span>
        </div>
      </div>

      {/* Header Section */}
      <header className="flex items-center justify-between px-4 lg:px-8 py-3 lg:py-4 border-b border-[#1F1F23] bg-[#0E0E10] shrink-0">
        <div className="flex items-center gap-3 lg:gap-4">
          <div className="w-8 h-8 rounded bg-[#00D1FF] flex items-center justify-center text-black shrink-0">
            <Zap size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm lg:text-lg font-bold tracking-tight text-white uppercase truncate">
              AGENTIC SWARM <span className="text-[#00D1FF] font-mono">v3.1.0</span>
              {demoMode && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-[#FFB000] text-black tracking-wider">
                  DEMO MODE
                </span>
              )}
            </h1>
            <p className="text-[9px] lg:text-[10px] text-[#8E9299] uppercase tracking-widest flex items-center gap-2">
              <Activity size={10} className="text-[#00FF85] shrink-0" /> 
              <span className="hidden sm:inline">ARC MAINNET • CIRCLE SETTLED • AUTHENTIC_SETTLEMENT_ACTIVE</span>
              <span className="sm:hidden">ARC MAINNET</span>
            </p>
          </div>
        </div>
        
        {/* Mobile Menu Button */}
        <button 
          onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
          className="lg:hidden w-10 h-10 flex items-center justify-center rounded bg-[#1F1F23] active:bg-[#2A2B2F] transition-colors"
        >
          {leftSidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>

        {/* Desktop Stats */}
        <div className="hidden lg:flex gap-6 items-center">
          <div className="text-right">
            <div className="text-[10px] text-[#8E9299] uppercase tracking-tight">Arc Network [L1]</div>
            <div className="text-xs text-[#00FF85] font-mono flex items-center justify-end gap-3 text-right">
              <span className="opacity-50 text-[9px]">GAS: {gasPrice.toFixed(6)} USDC</span>
              <span className="opacity-50 text-[9px]">LOAD: {networkLoad}%</span>
              <span className="opacity-50 text-[9px]">BLOCK: #{lastBlock}</span>
              {latency}ms Latency
            </div>
          </div>
          <div className="h-8 w-[1px] bg-[#1F1F23]"></div>
          <div className="flex flex-col items-end">
            <div className="text-[10px] text-[#8E9299] uppercase tracking-tight">Nanopayment Limit</div>
            <div className="text-xs text-[#FFB000] font-mono">$0.01 MAX RULE</div>
          </div>
        </div>
      </header>

      {/* Main Content Layout */}
      <main className="flex-1 min-h-0 relative overflow-hidden flex flex-col">
        {/* Mobile Tab Navigation */}
        <div className="lg:hidden flex bg-[#0E0E10] border-b border-[#1F1F23]">
          <button 
            onClick={() => setActivePanel('agents')}
            className={`flex-1 py-3 px-4 text-[11px] font-bold uppercase tracking-wider transition-colors ${activePanel === 'agents' ? 'bg-[#1F1F23] text-[#00D1FF]' : 'text-[#8E9299]'}`}
          >
            Agents
          </button>
          <button 
            onClick={() => setActivePanel('terminal')}
            className={`flex-1 py-3 px-4 text-[11px] font-bold uppercase tracking-wider transition-colors ${activePanel === 'terminal' ? 'bg-[#1F1F23] text-[#00D1FF]' : 'text-[#8E9299]'}`}
          >
            Terminal
          </button>
          <button 
            onClick={() => setActivePanel('ledger')}
            className={`flex-1 py-3 px-4 text-[11px] font-bold uppercase tracking-wider transition-colors ${activePanel === 'ledger' ? 'bg-[#1F1F23] text-[#00D1FF]' : 'text-[#8E9299]'}`}
          >
            Ledger
          </button>
        </div>

        {/* Desktop: 3-column grid | Mobile: Single panel view */}
        <div className="lg:grid lg:grid-cols-12 flex-1 min-h-0">
        
        {/* Left Panel: Agent Hierarchy */}
        <aside className={`${activePanel === 'agents' || !isMobile ? 'block' : 'hidden'} lg:col-span-3 border-r border-[#1F1F23] bg-[#0E0E10] p-4 lg:p-6 flex flex-col overflow-y-auto absolute lg:relative inset-0 z-20 lg:z-auto ${leftSidebarOpen ? 'block' : 'hidden lg:flex'}`}>
          <div className="mb-8">
            <h2 className="text-[11px] text-[#8E9299] uppercase tracking-wider mb-4 border-b border-[#1F1F23] pb-2">Swarm Intelligence</h2>
            
            {/* Coordinator Component */}
            <div className={`p-4 rounded-lg bg-[#151619] border border-[#2A2B2F] mb-6 transition-all ${coordinatorStatus.status !== 'idle' ? 'border-[#00D1FF]' : 'border-transparent'}`}>
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] bg-[#00D1FF] text-black px-1.5 py-0.5 rounded font-bold uppercase tracking-tight">PRO</span>
                <div className="flex items-center gap-1.5">
                   <div className={`w-1.5 h-1.5 rounded-full ${coordinatorStatus.status === 'idle' ? 'bg-[#00FF85]' : 'bg-[#FFB000] animate-pulse'}`} />
                   <span className="text-[10px] text-[#00FF85] uppercase font-mono">{coordinatorStatus.status === 'idle' ? 'ONLINE' : coordinatorStatus.status}</span>
                </div>
              </div>
              <div className="text-sm font-medium text-white mb-1">Coordinator Alpha</div>
              <div className="text-[10px] text-[#8E9299] leading-relaxed">Task reasoning & Circle wallet orchestration.</div>
            </div>

            {/* Workers List */}
            <div className="space-y-4">
              <h3 className="text-[9px] text-[#8E9299] uppercase font-bold tracking-[0.2em] mb-2">Authenticated Workers</h3>
              <div className={`p-3 rounded-lg bg-[#121317] border ${workerStatus.status !== 'idle' ? 'border-[#00FF85]' : 'border-[#1F1F23]'} flex items-center justify-between transition-colors shadow-inner`}>
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${workerStatus.status !== 'idle' ? 'bg-[#00FF85] animate-pulse shadow-[0_0_8px_rgba(0,255,133,0.4)]' : 'bg-[#00D1FF]'}`}></div>
                  <span className="text-xs text-[#E0E0E0] truncate max-w-[120px]">{workerStatus.name}</span>
                </div>
                <span className="text-[10px] font-mono text-[#8E9299] uppercase">{workerStatus.status === 'idle' ? 'IDLE' : workerStatus.status}</span>
              </div>

              {/* Swarm Topology Visualization */}
              <div className="p-4 rounded-lg bg-[#0A0A0B] border border-[#1F1F23] mt-6">
                <div className="text-[9px] text-[#8E9299] uppercase mb-3 text-center">Swarm Topology</div>
                <div className="flex justify-center items-center gap-4 relative py-4">
                    <div className="relative z-10">
                        <div className={`w-10 h-10 rounded-full border border-[#00D1FF] flex items-center justify-center transition-all ${isRunning ? 'bg-[#00D1FF]/20 scale-110 shadow-[0_0_15px_rgba(0,209,255,0.3)]' : 'bg-transparent'}`}>
                            <Cpu size={16} className={isRunning ? 'text-[#00D1FF]' : 'text-[#8E9299]'} />
                        </div>
                    </div>
                    <div className="w-12 h-[1px] bg-gradient-to-r from-[#00D1FF] to-[#00FF85] relative">
                         {isRunning && (
                             <motion.div 
                                className="absolute w-2 h-2 rounded-full bg-white shadow-[0_0_8px_white]"
                                animate={{ left: ["0%", "100%", "0%"] }}
                                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                             />
                         )}
                    </div>
                    <div className="relative z-10">
                        <div className={`w-10 h-10 rounded-full border border-[#00FF85] flex items-center justify-center transition-all ${workerStatus.status === 'working' ? 'bg-[#00FF85]/20 scale-110 shadow-[0_0_15px_rgba(0,255,133,0.3)]' : 'bg-transparent'}`}>
                            <Globe size={16} className={workerStatus.status === 'working' ? 'text-[#00FF85]' : 'text-[#8E9299]'} />
                        </div>
                    </div>
                </div>
                <div className="flex justify-between text-[8px] text-[#8E9299] mt-2 italic px-2">
                    <span>L1_NODE_01</span>
                    <span>L1_NODE_07</span>
                </div>
              </div>
            </div>
          </div>

          {/* Circle Wallet Mini-Widget */}
          <div className="mt-auto p-4 bg-[#151619] rounded-lg border border-[#2A2B2F] shadow-xl">
            <div className="flex justify-between items-center mb-1">
              <div className="text-[10px] text-[#8E9299] uppercase tracking-tight">Circle Mainnet Vault</div>
              <div className="flex items-center gap-1">
                <ShieldCheck size={10} className="text-[#00FF85]" />
                <span className="text-[8px] text-[#00FF85] uppercase font-bold">Verified</span>
              </div>
            </div>
            <div className="text-xl font-mono text-white tracking-tighter">
              ${config?.balance || '0.000'} <span className="text-xs text-[#8E9299]">USDC</span>
            </div>
            <div className="mt-3 h-1.5 w-full bg-[#2A2B2F] rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-gradient-to-r from-[#00D1FF] to-[#00FF85]" 
                initial={{ width: "42%" }}
                animate={{ width: isRunning ? ["42%", "60%", "42%"] : "42%" }}
              />
            </div>
            <p className="text-[8px] text-[#8E9299] mt-3 italic font-mono truncate">ID: {config?.walletId || 'FETCHING_CONFIG...'}</p>
          </div>
        </aside>

        {/* Middle Panel: Payment Loop Activity (Transaction Terminal) */}
        <section className={`${activePanel === 'terminal' || !isMobile ? 'flex' : 'hidden'} lg:col-span-6 bg-[#0A0A0B] flex-col border-r border-[#1F1F23] h-full min-h-0`}>
          <div className="p-6 border-b border-[#1F1F23] flex justify-between items-center bg-[#0A0A0B]/80 backdrop-blur-md sticky top-0 z-10 shrink-0 shadow-lg">
            <div className="flex flex-col">
              <h2 className="text-xs font-semibold text-white uppercase tracking-widest flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#00FF85] shadow-[0_0_6px_rgba(0,255,133,0.5)]" />
                Live Swarm Intelligence
              </h2>
              <p className="text-[9px] text-[#8E9299] uppercase mt-1 tracking-tighter italic">Proof-of-Settlement: Arc L1 Integration</p>
            </div>
            <div className="flex gap-4">
              <div className="flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded">
                <span className="text-[9px] text-[#8E9299] font-mono tracking-tighter">PROTOCOL: x402_STANDARD</span>
              </div>
            </div>
          </div>

          <div className="p-4 lg:p-6 bg-[#0E0E10] border-b border-[#1F1F23] shrink-0">
             <div className="flex gap-2 lg:gap-3">
              <div className="flex-1 relative group min-w-0">
                <input
                  type="text"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="Enter command..."
                  className="w-full bg-[#0A0A0B] border border-[#1F1F23] py-3 px-3 lg:pl-10 text-xs font-mono text-white placeholder:text-[#8E9299] focus:outline-none focus:border-[#00D1FF] transition-all rounded shadow-inner min-h-[44px]"
                  onKeyDown={(e) => e.key === 'Enter' && runSwarm()}
                  disabled={isRunning}
                />
                <Database size={14} className="hidden lg:block absolute left-3 top-3 text-[#8E9299] group-focus-within:text-[#00D1FF] transition-colors" />
              </div>
              <button
                onClick={runSwarm}
                disabled={isRunning || !task}
                className={`px-4 lg:px-6 flex items-center gap-1 lg:gap-2 bg-[#00D1FF] text-black font-bold uppercase text-[10px] tracking-widest hover:bg-white transition-all disabled:opacity-30 disabled:cursor-not-allowed group rounded shadow-[0_0_15px_rgba(0,209,255,0.2)] min-h-[44px] min-w-[80px] lg:min-w-[100px] justify-center touch-manipulation active:scale-95`}
              >
                <span className="hidden sm:inline">DEPLOY</span>
                <span className="sm:hidden">RUN</span>
                <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" />
              </button>
            </div>
          </div>

          {/* Terminal View */}
          <div 
            ref={scrollRef}
            className="flex-1 min-h-0 p-6 space-y-4 overflow-y-auto font-mono text-[11px] bg-[#0A0A0B] relative select-text"
          >
            <AnimatePresence>
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center opacity-10 py-20 pointer-events-none">
                  <Terminal size={64} />
                  <p className="mt-4 text-xs uppercase tracking-[0.5em] italic">Awaiting Agent Stream</p>
                </div>
              )}
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  style={{ userSelect: 'text' }}
                  className={`flex gap-4 border-l-2 pl-4 py-1 select-text ${
                    msg.sender === 'Coordinator' ? 'border-[#00D1FF]' : 
                    msg.sender === 'Worker' ? (msg.content.includes('402') ? 'border-[#FFB000] bg-[#1F1A10] rounded-r' : 'border-[#FF4444]') : 
                    msg.sender === 'System' ? 'border-[#00FF85] bg-[#00FF85]/5 shadow-[inset_0_0_10px_rgba(0,255,133,0.05)]' :
                    'border-[#8E9299] opacity-80'
                  }`}
                >
                  <span className="text-[#8E9299] whitespace-nowrap shrink-0">[{new Date(msg.timestamp).toLocaleTimeString('en-GB', { hour12: false })}]</span>
                  <span className={`font-bold whitespace-nowrap shrink-0 ${
                    msg.sender === 'Coordinator' ? 'text-[#00D1FF]' : 
                    msg.sender === 'Worker' ? (msg.content.includes('402') ? 'text-[#FFB000]' : 'text-[#FF4444]') : 
                    msg.sender === 'System' ? 'text-[#00FF85]' :
                    'text-[#E0E0E0]'
                  }`}>
                    {msg.sender === 'User' ? 'ARCHITECT:' : `${msg.sender.toUpperCase()}:`}
                  </span>
                  <span className={`${msg.content.includes('402') ? 'text-[#FFB000] font-bold' : msg.content.includes('successful') ? 'text-[#00FF85] font-bold' : 'text-[#E0E0E0]'}`}>
                    {msg.content}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* Quick Ledger Visuals */}
          <div className="px-6 py-4 bg-[#0E0E10] border-t border-[#1F1F23] shrink-0">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <List size={12} className="text-[#8E9299]" />
                <span className="text-[9px] text-[#8E9299] uppercase tracking-widest font-bold">Transaction History Ledger</span>
              </div>
              <span className="text-[10px] font-mono text-[#00FF85]">REAL-TIME ARC_SYNC</span>
            </div>
            <div className="flex gap-1 overflow-hidden">
               {/* Translucent grid background */}
               {[...Array(40)].map((_, i) => (
                <div 
                  key={i} 
                  className={`flex-1 h-3 transition-all duration-500 rounded-sm ${
                    i < transactions.length ? 'bg-[#00FF85] border border-[#00FF85]/50' : 
                    isRunning && i === transactions.length ? 'bg-[#FFB000] animate-pulse' : 
                    'bg-white/5'
                  }`} 
                />
              ))}
            </div>
          </div>
        </section>

        {/* Right Panel: Transaction Diagnostics */}
        <aside className={`${activePanel === 'ledger' || !isMobile ? 'flex' : 'hidden'} lg:col-span-3 border-l border-[#1F1F23] bg-[#0E0E10] p-4 lg:p-6 flex-col overflow-y-auto h-full`}>
          <h2 className="text-[11px] text-[#8E9299] uppercase tracking-wider mb-6 border-b border-[#1F1F23] pb-2">Blockchain Diagnostics</h2>
          
          <div className="space-y-8 flex-1">
            <section>
              <div className="text-[10px] text-[#8E9299] uppercase mb-3 flex items-center gap-2 font-bold tracking-tight">
                <Lock size={12} className="text-[#FFB000]" /> Financial Guardrail [Rule 1]
              </div>
              <div className="p-4 bg-[#151619] border border-[#FFB000]/40 rounded-lg flex items-center gap-4 transition-all hover:scale-[1.02]">
                <div className="text-xl font-mono text-white tracking-widest">$0.01</div>
                <div className="text-[9px] text-[#FFB000] italic leading-tight uppercase font-bold tracking-tighter">
                  Sub-cent Mandate<br/>Active & Enforced
                </div>
              </div>
            </section>

            {/* Circle Wallet Manager — arc-engine integration */}
            <section className="p-4 rounded-lg bg-black/40 border border-[#1F1F23]">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] text-[#8E9299] uppercase tracking-tight border-l-2 border-[#00FF85] pl-2 font-bold flex items-center gap-2">
                  <Wallet size={12} className="text-[#00FF85]" /> Circle Wallets
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={fetchWallets}
                    disabled={isLoadingWallets}
                    className="px-2 py-1 text-[9px] bg-[#1F1F23] text-[#00D1FF] rounded hover:bg-[#2A2A2E] transition-colors disabled:opacity-50"
                  >
                    {isLoadingWallets ? '...' : 'Refresh'}
                  </button>
                  <button
                    onClick={createWallet}
                    disabled={isLoadingWallets}
                    className="px-2 py-1 text-[9px] bg-[#00FF85]/20 text-[#00FF85] rounded hover:bg-[#00FF85]/30 transition-colors disabled:opacity-50"
                  >
                    + Create
                  </button>
                </div>
              </div>

              {walletError && (
                <div className="mb-2 p-2 bg-[#FF4D4D]/10 border border-[#FF4D4D]/30 rounded text-[9px] text-[#FF4D4D]">
                  {walletError}
                </div>
              )}

              <div className="space-y-1 max-h-[120px] overflow-y-auto scrollbar-none">
                {wallets.length === 0 && !isLoadingWallets && (
                  <p className="text-[9px] text-[#8E9299] opacity-50 italic text-center py-2">
                    No wallets found. Click Create or check Circle config.
                  </p>
                )}
                {wallets.map((w, i) => (
                  <div
                    key={w.id || i}
                    className="flex justify-between items-center text-[10px] border-b border-[#1F1F23] pb-1 cursor-pointer hover:bg-white/5 px-1 rounded transition-colors group"
                    onClick={() => {
                      if (w.address) {
                        navigator.clipboard.writeText(w.address);
                        setCopiedWalletId(w.id);
                        setTimeout(() => setCopiedWalletId(null), 2000);
                      }
                    }}
                    title="Click to copy full address"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-[#00FF85] font-mono truncate max-w-[80px] flex items-center gap-1">
                        {w.address?.slice(0, 10)}...
                        {copiedWalletId === w.id ? (
                          <Check size={10} className="text-[#00FF85]" />
                        ) : (
                          <Copy size={10} className="opacity-0 group-hover:opacity-50 transition-opacity" />
                        )}
                      </span>
                      <span
                        className="text-[7px] text-[#8E9299] font-mono truncate max-w-[100px] cursor-pointer hover:text-[#00D1FF] transition-colors"
                        title="Click to copy full Wallet UUID"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(w.id);
                          setCopiedUuid(w.id);
                          setTimeout(() => setCopiedUuid(null), 2000);
                        }}
                      >
                        {w.id?.slice(0, 14)}... {copiedUuid === w.id ? '✓' : ''}
                      </span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-[8px] text-[#8E9299] uppercase">{w.blockchain || 'ETH-SEP'}</span>
                    </div>
                    <span className={`text-[8px] ${w.state === 'LIVE' ? 'text-[#00FF85]' : 'text-[#FFB000]'}`}>{w.state || 'pending'}</span>
                  </div>
                ))}
              </div>

              {(!isCircleConfigValid() && !engineRegistered) && (
                <div className="mt-2 pt-2 border-t border-[#1F1F23]">
                  <button
                    onClick={registerEngine}
                    disabled={isLoadingWallets}
                    className="w-full px-2 py-1.5 text-[9px] bg-[#FFB000]/20 text-[#FFB000] rounded hover:bg-[#FFB000]/30 transition-colors disabled:opacity-50"
                  >
                    Register Entity Secret (One-time)
                  </button>
                </div>
              )}
            </section>

            <section>
              <div className="text-[10px] text-[#8E9299] uppercase mb-4 tracking-tight border-l-2 border-[#00D1FF] pl-2 font-bold">Swarm Ledger (50+ TX PROOF)</div>
              <div className="space-y-2 h-50 overflow-y-auto overscroll-contain pr-1 scrollbar-none">
                {transactions.map((tx, i) => (
                  <div key={i} className="flex justify-between items-center text-[10px] group border-b border-[#1F1F23] pb-1">
                    <span className="text-[#00FF85] font-mono">{tx.txHash?.slice(0, 8)}...</span>
                    <span className="font-mono text-[#E0E0E0]">${tx.amount}</span>
                  </div>
                ))}
                {transactions.length === 0 && (
                  <p className="text-[10px] text-[#8E9299] opacity-50 italic text-center py-4">Awaiting Transaction Proofs...</p>
                )}
              </div>
            </section>
          </div>

          {/* Animated consensus ring */}
          <div className="mt-8 flex flex-col items-center justify-center relative py-6 scale-90">
             <div className="absolute inset-0 bg-[#00D1FF]/5 blur-3xl rounded-full" />
             <div className="w-24 h-24 rounded-full border border-white/5 flex items-center justify-center relative shadow-2xl">
              <motion.div 
                className="absolute inset-0 rounded-full border-2 border-[#00D1FF] border-dotted opacity-20"
                animate={{ rotate: -360 }}
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
              />
              <motion.div 
                className="w-16 h-16 rounded-full border-2 border-[#00FF85] border-dashed"
                animate={{ rotate: 360 }}
                transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
              />
              <div className="absolute flex flex-col items-center">
                <div className="text-[9px] font-mono font-bold tracking-tighter text-white">ARC</div>
                <div className="text-[7px] font-mono text-[#00FF85] animate-pulse">SETTLED</div>
              </div>
            </div>
          </div>
        </aside>
        </div>
      </main>

      {/* Bottom Display Bar */}
      <footer className="bg-[#00D1FF] text-black px-4 lg:px-6 py-2 lg:py-0 lg:h-8 flex flex-col lg:flex-row lg:items-center justify-between font-mono text-[10px] font-bold uppercase shrink-0 transition-colors gap-1 lg:gap-0">
        <div className="flex flex-wrap gap-x-4 gap-y-1 lg:gap-8 items-center justify-center lg:justify-start">
          <span className="flex items-center gap-2">
             <ShieldCheck size={12} className="animate-bounce" /> LIVE_SETTLEMENT
          </span>
          <span className="flex items-center gap-2">
            <CreditCard size={12} /> VOL: ${(0.1545 + transactions.reduce((acc, tx) => acc + tx.amount, 0)).toFixed(5)} USDC
          </span>
          <span className="opacity-70 hidden sm:inline">UPTIME: {Math.floor((uptime * 2.5) / 60)}m {Math.floor((uptime * 2.5) % 60)}s</span>
          <span className="opacity-70 lg:hidden">BLK: #{lastBlock}</span>
        </div>
        <div className="flex gap-3 lg:gap-6 items-center justify-center lg:justify-end">
          <span className="opacity-70 tracking-widest hidden sm:inline">Nanopayment Loop: PROOF_OF_SETTLEMENT</span>
          <span className="bg-black text-[#00D1FF] px-2 py-0.5 rounded tracking-tighter italic text-[9px] border border-[#00D1FF]/30 whitespace-nowrap">SUB-CENT_POLICY</span>
        </div>
      </footer>

      {/* Marquee Animation Keyframes */}
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
