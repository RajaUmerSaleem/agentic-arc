export interface AgentMessage {
  id: string;
  sender: 'User' | 'Coordinator' | 'Worker' | 'System';
  content: string;
  timestamp: number;
}

export interface Transaction {
  id: string;
  from: string;
  to: string;
  amount: number;
  status: 'pending' | 'confirmed' | 'failed';
  txHash?: string;
  timestamp: number;
}

export type WorkerType = 'WebScraper' | 'DataAnalyzer' | 'CodeReviewer';

export interface AgentStatus {
  name: string;
  type: 'Coordinator' | 'Worker';
  model: string;
  status: 'idle' | 'thinking' | 'paying' | 'working';
}
