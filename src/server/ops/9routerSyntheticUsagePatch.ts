export const PATCH_MARKER = 'gocinema_synthetic_zero_usage_v2';
export const REQUEST_DETAILS_PATCH_MARKER = 'gocinema_request_details_stream_id_v1';
export const REQUEST_DETAILS_TOKEN_PATCH_MARKER = 'gocinema_request_details_stream_tokens_v1';

const ZERO_USAGE_SKIP_PATTERN =
  'if(!c||"object"!=typeof c)return;let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;if(0===k&&0===l)return;';

const TOKEN_OBJECT_PATTERN =
  'let o={prompt_tokens:c.prompt_tokens??c.input_tokens??0,completion_tokens:c.completion_tokens??c.output_tokens??0};(0,d.sZ)';

const STREAM_START_DETAIL_ID_PATTERN =
  'C=(0,g.Jb)(a,B,z),D=`${Date.now()}-${Math.random().toString(36).slice(2,11)}`;return(0,i.ox)';

const STREAM_COMPLETE_HANDLER_START_PATTERN =
  'let n=`${Date.now()}-${Math.random().toString(36).slice(2,11)}`;return{onStreamComplete:(l,o,p)=>{let q=';

const STREAM_COMPLETE_HANDLER_END_PATTERN =
  '}),(0,h.qr)({provider:a,model:b,tokens:o,connectionId:c,apiKey:d,endpoint:m?.endpoint,label:"STREAM USAGE"})},streamDetailId:n}}';

const STREAM_COMPLETE_TOKEN_PATTERN =
  'let q={ttft:p?p-e:Date.now()-e,total:Date.now()-e},r=l?.content||"[Empty streaming response]",s=l?.thinking||null;(0,i.ox';

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
  const hasSyntheticPatch = source.includes(PATCH_MARKER);
  const hasRequestDetailsPatch = source.includes(REQUEST_DETAILS_PATCH_MARKER);
  const hasRequestDetailsTokenPatch = source.includes(REQUEST_DETAILS_TOKEN_PATCH_MARKER);
  if (hasSyntheticPatch && hasRequestDetailsPatch && hasRequestDetailsTokenPatch) {
    return { changed: false, content: source };
  }

  let content = source;
  let changed = false;
  const providerIds = JSON.stringify([...new Set(options.providerIds)].sort());

  if (!hasSyntheticPatch) {
    if (options.providerIds.length === 0) throw new Error('No v4/cl provider ids found for synthetic usage patch');
    if (!content.includes(ZERO_USAGE_SKIP_PATTERN) || !content.includes(TOKEN_OBJECT_PATTERN)) {
      throw new Error('9router usage writer pattern not found; installed 9router build may have changed');
    }

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

    content = content
      .replace(ZERO_USAGE_SKIP_PATTERN, syntheticTokenPatch)
      .replace(TOKEN_OBJECT_PATTERN, tokenObjectPatch);
    changed = true;
  }

  if (!hasRequestDetailsPatch) {
    if (
      !content.includes(STREAM_START_DETAIL_ID_PATTERN) ||
      !content.includes(STREAM_COMPLETE_HANDLER_START_PATTERN) ||
      !content.includes(STREAM_COMPLETE_HANDLER_END_PATTERN)
    ) {
      throw new Error('9router streaming requestDetails pattern not found; installed 9router build may have changed');
    }

    content = content
      .replace(
        STREAM_START_DETAIL_ID_PATTERN,
        `C=(0,g.Jb)(a,B,z),D=A?.${REQUEST_DETAILS_PATCH_MARKER}||\`${'${Date.now()}'}-${'${Math.random().toString(36).slice(2,11)}'}\`;return(0,i.ox)`,
      )
      .replace(
        STREAM_COMPLETE_HANDLER_START_PATTERN,
        `let n=\`${'${Date.now()}'}-${'${Math.random().toString(36).slice(2,11)}'}\`;let t=(l,o,p)=>{let q=`,
      )
      .replace(
        STREAM_COMPLETE_HANDLER_END_PATTERN,
        `}),(0,h.qr)({provider:a,model:b,tokens:o,connectionId:c,apiKey:d,endpoint:m?.endpoint,label:"STREAM USAGE"})};return t.${REQUEST_DETAILS_PATCH_MARKER}=n,{onStreamComplete:t,streamDetailId:n}}`,
      );
    changed = true;
  }

  if (!hasRequestDetailsTokenPatch) {
    if (options.providerIds.length === 0) {
      throw new Error('No v4/cl provider ids found for streaming requestDetails token patch');
    }
    if (!content.includes(STREAM_COMPLETE_TOKEN_PATTERN)) {
      throw new Error('9router streaming requestDetails token pattern not found; installed 9router build may have changed');
    }

    const requestDetailsTokenPatch = [
      'let q={ttft:p?p-e:Date.now()-e,total:Date.now()-e},r=l?.content||"[Empty streaming response]",s=l?.thinking||null;',
      `/*${REQUEST_DETAILS_TOKEN_PATCH_MARKER}*/`,
      `let u=${providerIds},v=u.includes(String(a||""));`,
      'if(v){',
      'o&&"object"==typeof o||(o={});',
      'let w=o.input_tokens??o.prompt_tokens??0,x=o.output_tokens??o.completion_tokens??0;',
      `if(0===w){w=50000+Math.floor(Math.random()*50001),o.prompt_tokens=w,o.input_tokens=w,o.${PATCH_MARKER}=!0}`,
      `if(0===x){x=100+Math.floor(Math.random()*4901),o.completion_tokens=x,o.output_tokens=x,o.${PATCH_MARKER}=!0}`,
      '}',
      '(0,i.ox',
    ].join('');

    content = content.replace(STREAM_COMPLETE_TOKEN_PATTERN, requestDetailsTokenPatch);
    changed = true;
  }

  return { changed, content };
}
