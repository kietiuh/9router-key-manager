export const PATCH_MARKER = 'gocinema_synthetic_zero_usage_v2';

const ZERO_USAGE_SKIP_PATTERN =
  'if(!c||"object"!=typeof c)return;let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;if(0===k&&0===l)return;';

const TOKEN_OBJECT_PATTERN =
  'let o={prompt_tokens:c.prompt_tokens??c.input_tokens??0,completion_tokens:c.completion_tokens??c.output_tokens??0};(0,d.sZ)';

export interface Patch9routerUsageBundleOptions {
  providerIds: string[];
}

export interface Patch9routerUsageBundleResult {
  changed: boolean;
  content: string;
}

export interface ProviderNodeRow {
  id: string;
  data: string;
}

export function readSyntheticUsageProviderIds(rows: ProviderNodeRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as { prefix?: unknown };
      if (parsed.prefix === 'v4' || parsed.prefix === 'cl') ids.add(row.id);
    } catch {
      // Ignore broken provider-node JSON; 9router itself will skip unusable node data too.
    }
  }
  return [...ids].sort();
}

export function patch9routerUsageBundle(
  source: string,
  options: Patch9routerUsageBundleOptions,
): Patch9routerUsageBundleResult {
  if (source.includes(PATCH_MARKER)) return { changed: false, content: source };
  if (options.providerIds.length === 0) throw new Error('No v4/cl provider ids found for synthetic usage patch');
  if (!source.includes(ZERO_USAGE_SKIP_PATTERN) || !source.includes(TOKEN_OBJECT_PATTERN)) {
    throw new Error('9router usage writer pattern not found; installed 9router build may have changed');
  }

  const providerIds = JSON.stringify([...new Set(options.providerIds)].sort());
  const syntheticTokenPatch = [
    `const p=${providerIds},q=String(a||""),r=p.includes(q);`,
    'if((!c||"object"!=typeof c)&&!r)return;',
    'c&&"object"==typeof c||(c={});',
    'let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;',
    `if(r&&0===k){k=50000+Math.floor(Math.random()*50001),c.prompt_tokens=k,c.input_tokens=k,c.${PATCH_MARKER}=!0}`,
    `if(r&&0===l){l=100+Math.floor(Math.random()*4901),c.completion_tokens=l,c.output_tokens=l,c.${PATCH_MARKER}=!0}`,
    'if(0===k&&0===l)return;',
  ].join('');
  const tokenObjectPatch =
    `let o={prompt_tokens:c.prompt_tokens??c.input_tokens??0,completion_tokens:c.completion_tokens??c.output_tokens??0};c.${PATCH_MARKER}&&(o.synthetic_zero_usage_random=!0);(0,d.sZ)`;

  return {
    changed: true,
    content: source
      .replace(ZERO_USAGE_SKIP_PATTERN, syntheticTokenPatch)
      .replace(TOKEN_OBJECT_PATTERN, tokenObjectPatch),
  };
}
