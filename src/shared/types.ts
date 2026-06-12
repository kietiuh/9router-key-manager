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
  imageDailyLimit?: number | null;
  imageDailyUsed?: number;
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
  dataSqlitePath?: string;
  usageSource?: string;
  dbJsonExists: boolean;
  usageJsonExists: boolean;
  dataSqliteExists?: boolean;
  managerDbPath: string;
  hardDisable: boolean;
  timezone: string;
  errors: string[];
};


export type ModelRewriteRule = {
  id: number;
  groupId?: number | null;
  enabled: boolean;
  fromModel: string;
  toModel: string;
  toModels: string[];
  stickyCount: number;
  targetWeights?: number[];
  stickyIndex?: number;
  stickyUsed?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type ModelRewriteGroup = {
  id: number;
  name: string;
  enabled: boolean;
  rules: ModelRewriteRule[];
  createdAt?: string;
  updatedAt?: string;
};

export type ModelRewriteConfig = {
  enabled: boolean;
  groups: ModelRewriteGroup[];
  rules?: ModelRewriteRule[];
};

export type FinalFallbackConfig = {
  enabled: boolean;
  model: string;
  models?: string[];
};

export type ModelRateLimitRule = {
  model: string;
  enabled: boolean;
  rpm: number;
  queueLimit: number;
  maxQueueWaitMs: number;
};

export type ModelRateLimitConfig = {
  enabled: boolean;
  rules: ModelRateLimitRule[];
};

export type ModelRateLimitSnapshot = {
  model: string;
  enabled: boolean;
  rpm: number;
  queued: number;
  queueLimit: number;
  nextAvailableAt: number;
};

export type ClientRateLimitConfig = {
  enabled: boolean;
  rpm: number;
  concurrency: number;
};

export type ClientRateLimitSnapshot = {
  keyId: string;
  enabled: boolean;
  rpm: number;
  concurrency: number;
  requestCount: number;
  active: number;
  resetAt: number | null;
};

export type TrafficLatencySummary = {
  avg: number;
  max: number;
};

export type TrafficSummaryBucket = {
  bucketStart: string;
  requestCount: number;
  streamCount?: number;
  errorCount: number;
  timeoutCount: number;
  largeContextCount: number;
  avgQueuedMs: number;
  avgUpstreamMs: number;
  avgTotalMs: number;
  maxUpstreamMs: number;
};

export type TrafficModelSummary = {
  model: string;
  requestCount: number;
  streamCount?: number;
  errorCount: number;
  avgUpstreamMs: number;
  maxUpstreamMs: number;
};

export type TrafficSummary = {
  source?: 'key-manager-memory' | '9router-journal';
  windowMinutes: number;
  bucketMinutes: number;
  generatedAt: string;
  latestEventAt?: string | null;
  error?: string | null;
  requestCount: number;
  streamCount?: number;
  errorCount: number;
  timeoutCount: number;
  largeContextCount: number;
  bodyBytes: number;
  estimatedInputTokens: number;
  queuedMs: TrafficLatencySummary;
  upstreamMs: TrafficLatencySummary;
  totalMs: TrafficLatencySummary;
  buckets: TrafficSummaryBucket[];
  models: TrafficModelSummary[];
};
