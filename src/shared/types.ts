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

export type ModelUsageSummary = {
  model: string;
  req: number;
  prompt: number;
  completion: number;
  lastUsageAt?: string | null;
};

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
  usageMultiplier: number;
  usageMultiplierEffectiveAt?: string | null;
  actualPrompt: number;
  actualCompletion: number;
  actualTotal: number;
  dedupedRequests: number;
  duplicateRequests: number;
  duplicateTokens: number;
  req: number;
  prompt: number;
  completion: number;
  total: number;
  cost: number;
  percentOfLimit?: number | null;
  firstUsageAt?: string | null;
  lastUsageAt?: string | null;
  models: Record<string, number>;
  modelUsage: ModelUsageSummary[];
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


export type ImageUsageEvent = {
  id: number;
  kind: 'generation' | 'edit' | string;
  model: string;
  size?: string | null;
  prompt_preview?: string | null;
  prompt_hash?: string | null;
  input_file?: string | null;
  output_file?: string | null;
  drive_path?: string | null;
  status: 'success' | 'error' | string;
  error?: string | null;
  image_count: number;
  bytes?: number | null;
  created_at: string;
};

export type ImageUsageSummary = {
  todayImages: number;
  totalImages: number;
  success: number;
  errors: number;
  bytes: number;
  events: ImageUsageEvent[];
};
