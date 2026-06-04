import crypto from 'node:crypto';
import type { PublicImageGenerateResponse, PublicImageJobStatus, PublicImageJobView } from '../../shared/types.js';

export type PublicImageResult = PublicImageGenerateResponse;
export type { PublicImageJobStatus, PublicImageJobView };

export type PublicImageJob = {
  id: string;
  keyId: string;
  key: string;
  prompt: string;
  size: string;
  status: PublicImageJobStatus;
  createdAt: number;
  updatedAt: number;
  result?: PublicImageResult;
  error?: string;
};

export type PublicImageJobQueueOptions = {
  maxGlobal: number;
  maxPerKey: number;
  ttlMs: number;
  generate: (job: PublicImageJob) => Promise<PublicImageResult>;
  now?: () => number;
  id?: () => string;
};

function defaultId() {
  return crypto.randomUUID();
}

export function createPublicImageJobQueue(options: PublicImageJobQueueOptions) {
  const now = options.now ?? Date.now;
  const id = options.id ?? defaultId;
  const imageJobs = new Map<string, PublicImageJob>();
  const imageQueue: PublicImageJob[] = [];

  const runningJobs = (keyId?: string) => [...imageJobs.values()].filter(job => job.status === 'running' && (!keyId || job.keyId === keyId)).length;

  const queuePosition = (jobId: string) => {
    const idx = imageQueue.findIndex(job => job.id === jobId && job.status === 'queued');
    return idx >= 0 ? idx + 1 : null;
  };

  const publicJob = (job: PublicImageJob): PublicImageJobView => ({
    jobId: job.id,
    status: job.status,
    queuePosition: queuePosition(job.id),
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    error: job.error,
    result: job.result,
  });

  const cleanupJobs = () => {
    const cutoff = now() - options.ttlMs;
    for (const [jobId, job] of imageJobs) {
      if (job.updatedAt < cutoff && job.status !== 'queued' && job.status !== 'running') imageJobs.delete(jobId);
    }
  };

  const scheduleJobs = () => {
    cleanupJobs();
    while (runningJobs() < options.maxGlobal) {
      const idx = imageQueue.findIndex(job => job.status === 'queued' && runningJobs(job.keyId) < options.maxPerKey);
      if (idx < 0) return;
      const job = imageQueue.splice(idx, 1)[0];
      job.status = 'running';
      job.updatedAt = now();
      options.generate(job).then(result => {
        job.status = 'success';
        job.result = result;
        job.updatedAt = now();
        scheduleJobs();
      }).catch((err: unknown) => {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : 'image generation failed';
        job.updatedAt = now();
        scheduleJobs();
      });
    }
  };

  const createJob = (match: { id: string; key: string }, prompt: string, size: string) => {
    cleanupJobs();
    const timestamp = now();
    const job: PublicImageJob = {
      id: id(),
      keyId: match.id,
      key: match.key,
      prompt,
      size,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    imageJobs.set(job.id, job);
    imageQueue.push(job);
    scheduleJobs();
    return publicJob(job);
  };

  const getJob = (jobId: string, keyId: string) => {
    const job = imageJobs.get(jobId);
    if (!job || job.keyId !== keyId) return null;
    return publicJob(job);
  };

  const cancelJob = (jobId: string, keyId: string) => {
    const job = imageJobs.get(jobId);
    if (!job || job.keyId !== keyId) return null;
    if (job.status !== 'queued') throw new Error('image generation already started');
    job.status = 'cancelled';
    job.updatedAt = now();
    const idx = imageQueue.findIndex(item => item.id === job.id);
    if (idx >= 0) imageQueue.splice(idx, 1);
    scheduleJobs();
    return publicJob(job);
  };

  const waitForJob = (jobId: string, timeoutMs = 180000) => new Promise<PublicImageJob>((resolve, reject) => {
    const started = now();
    const timer = setInterval(() => {
      const job = imageJobs.get(jobId);
      if (!job) {
        clearInterval(timer);
        reject(new Error('job not found'));
        return;
      }
      if (job.status === 'success' || job.status === 'error' || job.status === 'cancelled') {
        clearInterval(timer);
        resolve(job);
        return;
      }
      if (now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('image generation timeout'));
      }
    }, 1000);
  });

  return { createJob, getJob, cancelJob, waitForJob, cleanupJobs };
}
