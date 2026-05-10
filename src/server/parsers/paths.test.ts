import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { dataSqlitePath, dbJsonPath, default9routerDir, usageJsonPath } from './paths.js';

const originalNineRouterDir = process.env.NINE_ROUTER_DIR;

describe('9router paths', () => {
  afterEach(() => {
    if (originalNineRouterDir === undefined) delete process.env.NINE_ROUTER_DIR;
    else process.env.NINE_ROUTER_DIR = originalNineRouterDir;
  });

  it('uses NINE_ROUTER_DIR as the default base directory', () => {
    process.env.NINE_ROUTER_DIR = '/tmp/custom-9router';

    expect(default9routerDir()).toBe('/tmp/custom-9router');
    expect(dbJsonPath()).toBe(path.join('/tmp/custom-9router', 'db.json'));
    expect(usageJsonPath()).toBe(path.join('/tmp/custom-9router', 'usage.json'));
    expect(dataSqlitePath()).toBe(path.join('/tmp/custom-9router', 'db', 'data.sqlite'));
  });

  it('uses explicit base directory before env defaults', () => {
    process.env.NINE_ROUTER_DIR = '/tmp/custom-9router';

    expect(dbJsonPath('/tmp/explicit-9router')).toBe(path.join('/tmp/explicit-9router', 'db.json'));
    expect(usageJsonPath('/tmp/explicit-9router')).toBe(path.join('/tmp/explicit-9router', 'usage.json'));
    expect(dataSqlitePath('/tmp/explicit-9router')).toBe(path.join('/tmp/explicit-9router', 'db', 'data.sqlite'));
  });
});
