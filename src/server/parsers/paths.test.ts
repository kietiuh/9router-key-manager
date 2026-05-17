import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataSqlitePath, dbJsonPath, default9routerDir, usageJsonPath } from './paths.js';

const originalDir = process.env.NINE_ROUTER_DIR;

afterEach(() => {
  if (originalDir === undefined) delete process.env.NINE_ROUTER_DIR;
  else process.env.NINE_ROUTER_DIR = originalDir;
});

describe('9router paths', () => {
  it('uses NINE_ROUTER_DIR when provided', () => {
    process.env.NINE_ROUTER_DIR = '/tmp/nine-router-test';

    expect(default9routerDir()).toBe('/tmp/nine-router-test');
    expect(dbJsonPath()).toBe(path.join('/tmp/nine-router-test', 'db.json'));
    expect(usageJsonPath()).toBe(path.join('/tmp/nine-router-test', 'usage.json'));
    expect(dataSqlitePath()).toBe(path.join('/tmp/nine-router-test', 'db', 'data.sqlite'));
  });

  it('builds paths from an explicit base directory', () => {
    expect(dbJsonPath('/data/app')).toBe(path.join('/data/app', 'db.json'));
    expect(usageJsonPath('/data/app')).toBe(path.join('/data/app', 'usage.json'));
    expect(dataSqlitePath('/data/app')).toBe(path.join('/data/app', 'db', 'data.sqlite'));
  });
});
