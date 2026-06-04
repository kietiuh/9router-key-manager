import { describe, expect, it } from 'vitest';
import { createPublicImageJobQueue, type PublicImageResult } from './publicImageJobs.js';

function result(id: string): PublicImageResult {
  return {
    image: `image-${id}`,
    mimeType: 'image/png',
    filename: `${id}.png`,
    prompt: `prompt-${id}`,
    bytes: 10,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('public image job queue', () => {
  it('starts the first job immediately and queues excess jobs per key', () => {
    const first = deferred<PublicImageResult>();
    const queue = createPublicImageJobQueue({
      maxGlobal: 2,
      maxPerKey: 1,
      ttlMs: 60_000,
      generate: () => first.promise,
      id: (() => {
        let n = 0;
        return () => `job-${++n}`;
      })(),
    });

    const a = queue.createJob({ id: 'key-a', key: 'sk-a' }, 'p1', '1024x1024');
    const b = queue.createJob({ id: 'key-a', key: 'sk-a' }, 'p2', '1024x1024');

    expect(a).toMatchObject({ jobId: 'job-1', status: 'running', queuePosition: null });
    expect(b).toMatchObject({ jobId: 'job-2', status: 'queued', queuePosition: 1 });
  });

  it('cancels queued jobs and removes them from the queue', () => {
    const running = deferred<PublicImageResult>();
    const queue = createPublicImageJobQueue({
      maxGlobal: 1,
      maxPerKey: 1,
      ttlMs: 60_000,
      generate: () => running.promise,
      id: (() => {
        let n = 0;
        return () => `job-${++n}`;
      })(),
    });

    queue.createJob({ id: 'key-a', key: 'sk-a' }, 'p1', '1024x1024');
    const queued = queue.createJob({ id: 'key-a', key: 'sk-a' }, 'p2', '1024x1024');

    expect(queue.cancelJob(queued.jobId, 'key-a')).toMatchObject({
      jobId: queued.jobId,
      status: 'cancelled',
      queuePosition: null,
    });
    expect(queue.getJob(queued.jobId, 'key-a')).toMatchObject({ status: 'cancelled' });
  });

  it('refuses to cancel jobs that already started', () => {
    const running = deferred<PublicImageResult>();
    const queue = createPublicImageJobQueue({
      maxGlobal: 1,
      maxPerKey: 1,
      ttlMs: 60_000,
      generate: () => running.promise,
      id: () => 'job-1',
    });
    const job = queue.createJob({ id: 'key-a', key: 'sk-a' }, 'p1', '1024x1024');

    expect(() => queue.cancelJob(job.jobId, 'key-a')).toThrow('image generation already started');
  });

  it('expires completed jobs after ttl cleanup', async () => {
    let now = 1_000;
    const queue = createPublicImageJobQueue({
      maxGlobal: 1,
      maxPerKey: 1,
      ttlMs: 500,
      now: () => now,
      generate: async () => result('done'),
      id: () => 'job-1',
    });

    const created = queue.createJob({ id: 'key-a', key: 'sk-a' }, 'p1', '1024x1024');
    await queue.waitForJob(created.jobId, 1000);

    now = 1_600;
    queue.cleanupJobs();

    expect(queue.getJob(created.jobId, 'key-a')).toBeNull();
  });
});
