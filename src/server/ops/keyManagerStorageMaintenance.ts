import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

type UsageEventRow = {
  id: number;
  signature: string;
  api_key: string | null;
  provider: string | null;
  connection_id: string | null;
  timestamp: string;
  model: string | null;
  cost: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_tokens: number | null;
};

type ExpiredImageRow = {
  id: number;
  output_file: string | null;
};

export type KeyManagerStorageMaintenanceSummary = {
  applied: boolean;
  usageEvents: {
    totalRows: number;
    duplicateGroups: number;
    rowsToDelete: number;
    rowsDeleted: number;
    signaturesToRewrite: number;
    signaturesRewritten: number;
  };
  expiredPublicImages: {
    rowsToClear: number;
    rowsCleared: number;
    filesDeleted: number;
    fileDeleteErrors: number;
  };
};

function part(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function canonicalUsageSignatureFromRow(row: Partial<UsageEventRow>): string {
  return [
    part(row.api_key),
    part(row.provider),
    part(row.connection_id),
    part(row.timestamp),
    part(row.model),
    part(row.prompt_tokens, '0'),
    part(row.completion_tokens, '0'),
    part(row.total_tokens),
  ].join('|');
}

function richness(row: UsageEventRow): number {
  return Number(row.cache_read_input_tokens != null)
    + Number(row.cache_creation_input_tokens != null)
    + Number(row.reasoning_tokens != null);
}

function isBetterSurvivor(candidate: UsageEventRow, current: UsageEventRow): boolean {
  const candidateRichness = richness(candidate);
  const currentRichness = richness(current);
  if (candidateRichness !== currentRichness) return candidateRichness > currentRichness;
  const candidateCost = candidate.cost ?? Number.POSITIVE_INFINITY;
  const currentCost = current.cost ?? Number.POSITIVE_INFINITY;
  if (candidateCost !== currentCost) return candidateCost < currentCost;
  return candidate.id < current.id;
}

function usageMaintenancePlan(rows: UsageEventRow[]) {
  const groups = new Map<string, UsageEventRow[]>();
  const signatureById = new Map<number, string>();
  for (const row of rows) {
    const signature = canonicalUsageSignatureFromRow(row);
    signatureById.set(row.id, row.signature);
    const group = groups.get(signature) ?? [];
    group.push(row);
    groups.set(signature, group);
  }

  const survivors: Array<{ id: number; signature: string }> = [];
  const deleteIds: number[] = [];
  let duplicateGroups = 0;
  for (const [signature, group] of groups) {
    let survivor = group[0];
    for (const row of group.slice(1)) {
      if (isBetterSurvivor(row, survivor)) survivor = row;
    }
    survivors.push({ id: survivor.id, signature });
    if (group.length > 1) duplicateGroups++;
    for (const row of group) {
      if (row.id !== survivor.id) deleteIds.push(row.id);
    }
  }

  return {
    duplicateGroups,
    deleteIds,
    rewrites: survivors.filter(row => signatureById.get(row.id) !== row.signature),
  };
}

function expiredPublicImageRows(db: Database.Database, nowIso: string): ExpiredImageRow[] {
  return db.prepare(`
    SELECT id, output_file
    FROM image_usage_events
    WHERE output_file IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).all(nowIso) as ExpiredImageRow[];
}

export function maintainKeyManagerStorage(
  db: Database.Database,
  options: { apply: boolean; publicImageDir?: string; nowIso?: string },
): KeyManagerStorageMaintenanceSummary {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const rows = db.prepare(`
    SELECT id, signature, api_key, provider, connection_id, timestamp, model, cost,
      prompt_tokens, completion_tokens, total_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens
    FROM usage_events
    ORDER BY id ASC
  `).all() as UsageEventRow[];
  const plan = usageMaintenancePlan(rows);
  const expiredRows = expiredPublicImageRows(db, nowIso);
  const summary: KeyManagerStorageMaintenanceSummary = {
    applied: options.apply,
    usageEvents: {
      totalRows: rows.length,
      duplicateGroups: plan.duplicateGroups,
      rowsToDelete: plan.deleteIds.length,
      rowsDeleted: 0,
      signaturesToRewrite: plan.rewrites.length,
      signaturesRewritten: 0,
    },
    expiredPublicImages: {
      rowsToClear: expiredRows.length,
      rowsCleared: 0,
      filesDeleted: 0,
      fileDeleteErrors: 0,
    },
  };

  if (!options.apply) return summary;

  db.transaction(() => {
    const deleteUsage = db.prepare('DELETE FROM usage_events WHERE id = ?');
    for (const id of plan.deleteIds) {
      const res = deleteUsage.run(id);
      summary.usageEvents.rowsDeleted += Number(res.changes || 0);
    }

    const rewriteUsage = db.prepare('UPDATE usage_events SET signature = ? WHERE id = ?');
    for (const rewrite of plan.rewrites) {
      const res = rewriteUsage.run(rewrite.signature, rewrite.id);
      summary.usageEvents.signaturesRewritten += Number(res.changes || 0);
    }

    if (expiredRows.length) {
      const clearImage = db.prepare('UPDATE image_usage_events SET output_file = NULL WHERE id = ?');
      for (const row of expiredRows) {
        if (options.publicImageDir && row.output_file) {
          try {
            fs.unlinkSync(path.join(options.publicImageDir, path.basename(row.output_file)));
            summary.expiredPublicImages.filesDeleted++;
          } catch (error: any) {
            if (error?.code !== 'ENOENT') summary.expiredPublicImages.fileDeleteErrors++;
          }
        }
        const res = clearImage.run(row.id);
        summary.expiredPublicImages.rowsCleared += Number(res.changes || 0);
      }
    }
  })();

  return summary;
}
