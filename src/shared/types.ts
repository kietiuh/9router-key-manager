export type ApiKeyRecord = {
  id: string;
  name: string;
  key: string;
  machineId?: string;
  isActive: boolean;
  createdAt?: string;
};

export type UsageRecord = {
  apiKey?: string;
  model?: string;
  timestamp: string;
  cost?: number;
  tokens?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_tokens?: number;
  };
};

export type KeyStatus = 'ok' | 'warning' | 'danger' | 'inactive' | 'expired' | 'unlimited';

export type KeyUsageSummary = {
  keyId: string;
  name: string;
  keyMasked: string;
  isActive: boolean;
  status: KeyStatus;
  statusReason: string;
  windowStart: string;
  windowEnd?: string | null;
  resetPolicy: 'manual' | 'daily' | 'monthly' | 'custom';
  expiresAt?: string | null;
  tokenLimit?: number | null;
  actionOnLimit: 'alert' | 'disable' | 'none';
  req: number;
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  percentOfLimit?: number | null;
  firstUsageAt?: string | null;
  lastUsageAt?: string | null;
  models: Record<string, number>;
};

export type ConfigStatus = {
  ok: boolean;
  nineRouterDir: string;
  dbJsonPath: string;
  usageJsonPath: string;
  dbJsonExists: boolean;
  usageJsonExists: boolean;
  managerDbPath: string;
  hardDisable: boolean;
  timezone: string;
  errors: string[];
};
