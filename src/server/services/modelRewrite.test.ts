import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { getModelRewriteConfig, rewriteModel, saveModelRewriteConfig } from './modelRewrite.js';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('model rewrite config', () => {
  it('defaults off with no rules', () => {
    const db = memDb();
    expect(getModelRewriteConfig(db)).toEqual({ enabled: false, rules: [] });
  });

  it('rewrites only when globally enabled and rule enabled', () => {
    const db = memDb();
    const cfg = saveModelRewriteConfig(db, { enabled: true, rules: [
      { enabled: true, fromModel: 'v1/cx/gpt-5.5', toModel: 'cx/gpt-5.5' },
      { enabled: false, fromModel: 'off', toModel: 'on' },
    ] });
    expect(rewriteModel('v1/cx/gpt-5.5', cfg)).toEqual({ model: 'cx/gpt-5.5', rewritten: true, toModel: 'cx/gpt-5.5' });
    expect(rewriteModel('off', cfg).rewritten).toBe(false);
    expect(rewriteModel('other', cfg).rewritten).toBe(false);
    expect(rewriteModel('v1/cx/gpt-5.5', { ...cfg, enabled: false }).rewritten).toBe(false);
  });

  it('trims and drops empty rules', () => {
    const db = memDb();
    const cfg = saveModelRewriteConfig(db, { enabled: true, rules: [
      { fromModel: '  A  ', toModel: '  B  ', note: ' x ' },
      { fromModel: '', toModel: 'C' },
    ] });
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0].fromModel).toBe('A');
    expect(cfg.rules[0].toModel).toBe('B');
    expect(cfg.rules[0].note).toBe('x');
  });
});
