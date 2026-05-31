import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { readStoredUsage, readStoredUsageForKeys } from './usageStore.js';
import { recordSyntheticV4Usage } from './syntheticV4Usage.js';

function db() { const d = new Database(':memory:'); migrate(d); return d; }

describe('recordSyntheticV4Usage', () => {
  it('stores a random 50k-100k token usage row for successful v4 requests', () => {
    const d = db();

    const result = recordSyntheticV4Usage(d, {
      apiKey: 'sk-v4',
      keyId: 'key-v4',
      requestId: 'req-v4',
      model: 'v4/gpt-5.5',
      upstreamStatus: 200,
      timestamp: '2026-05-31T16:00:00.000Z',
      estimatedInputTokens: 1200,
      randomInt: () => 75000,
    });

    expect(result).toMatchObject({ recorded: true, totalTokens: 75000, promptTokens: 1200, completionTokens: 73800 });
    const rows = readStoredUsageForKeys(d, [{ apiKey: 'sk-v4' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      apiKey: 'sk-v4',
      model: 'v4/gpt-5.5',
      provider: 'key-manager-synthetic',
      connectionId: 'v4-success',
      timestamp: '2026-05-31T16:00:00.000Z',
      tokens: { prompt_tokens: 1200, completion_tokens: 73800, total_tokens: 75000 },
    });
  });

  it('caps synthetic v4 usage at 100k tokens', () => {
    const d = db();

    const result = recordSyntheticV4Usage(d, {
      apiKey: 'sk-v4',
      keyId: 'key-v4',
      requestId: 'req-v4',
      model: 'v4/gpt-5.5',
      upstreamStatus: 200,
      timestamp: '2026-05-31T16:00:00.000Z',
      estimatedInputTokens: 120000,
      randomInt: () => 125000,
    });

    expect(result).toMatchObject({ recorded: true, totalTokens: 100000, promptTokens: 100000, completionTokens: 0 });
  });

  it('does not record non-v4, failed, or unauthenticated requests', () => {
    const d = db();

    expect(recordSyntheticV4Usage(d, { apiKey: 'sk-a', keyId: 'a', requestId: 'req-1', model: 'cx/gpt-5.5', upstreamStatus: 200, timestamp: '2026-05-31T16:00:00.000Z', estimatedInputTokens: 1 })).toEqual({ recorded: false, reason: 'model_not_targeted' });
    expect(recordSyntheticV4Usage(d, { apiKey: 'sk-a', keyId: 'a', requestId: 'req-2', model: 'v4/gpt-5.5', upstreamStatus: 500, timestamp: '2026-05-31T16:00:00.000Z', estimatedInputTokens: 1 })).toEqual({ recorded: false, reason: 'upstream_not_successful' });
    expect(recordSyntheticV4Usage(d, { apiKey: '', keyId: 'a', requestId: 'req-3', model: 'v4/gpt-5.5', upstreamStatus: 200, timestamp: '2026-05-31T16:00:00.000Z', estimatedInputTokens: 1 })).toEqual({ recorded: false, reason: 'missing_api_key' });

    expect(readStoredUsage(d)).toHaveLength(0);
  });

  it('dedupes repeated records for the same request', () => {
    const d = db();
    const args = {
      apiKey: 'sk-v4',
      keyId: 'key-v4',
      requestId: 'req-v4',
      model: 'v4/gpt-5.5',
      upstreamStatus: 200,
      timestamp: '2026-05-31T16:00:00.000Z',
      estimatedInputTokens: 200000,
      randomInt: () => 100000,
    };

    recordSyntheticV4Usage(d, args);
    recordSyntheticV4Usage(d, args);

    const rows = readStoredUsageForKeys(d, [{ apiKey: 'sk-v4' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toMatchObject({ prompt_tokens: 100000, completion_tokens: 0, total_tokens: 100000 });
  });
});
