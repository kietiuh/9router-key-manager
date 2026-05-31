import { describe, expect, it } from 'vitest';
import {
  PATCH_MARKER,
  REQUEST_DETAILS_PATCH_MARKER,
  REQUEST_DETAILS_TOKEN_PATCH_MARKER,
  patch9routerUsageBundle,
  readSyntheticUsageProviderIds,
} from './9routerSyntheticUsagePatch.js';

const ORIGINAL_QR_SNIPPET =
  'function j({provider:a,model:b,tokens:c,connectionId:f,apiKey:g,endpoint:h,label:i="USAGE"}){if(!c||"object"!=typeof c)return;let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;if(0===k&&0===l)return;let m=new Date().toLocaleTimeString("en-US",{hour12:!1,hour:"2-digit",minute:"2-digit",second:"2-digit"}),n=f?` | account=${f.slice(0,8)}...`:"";console.log(`usage ${k}/${l}`);let o={prompt_tokens:c.prompt_tokens??c.input_tokens??0,completion_tokens:c.completion_tokens??c.output_tokens??0};(0,d.sZ)({provider:a||"unknown",model:b||"unknown",tokens:o,timestamp:new Date().toISOString(),connectionId:f||void 0,apiKey:g||void 0,endpoint:h||null}).catch(()=>{})}';

const ORIGINAL_STREAM_DETAIL_SNIPPET =
  'function k({providerResponse:a,provider:b,model:c,sourceFormat:l,targetFormat:m,userAgent:n,body:o,stream:p,translatedBody:q,finalBody:r,requestStartTime:s,connectionId:t,apiKey:u,clientRawRequest:v,onRequestSuccess:w,reqLogger:x,toolNameMap:y,streamController:z,onStreamComplete:A}){w&&w();let B=buildStream({onStreamComplete:A}),C=(0,g.Jb)(a,B,z),D=`${Date.now()}-${Math.random().toString(36).slice(2,11)}`;return(0,i.ox)((0,h.$R)({provider:b,model:c,connectionId:t,latency:{ttft:0,total:Date.now()-s},tokens:{prompt_tokens:0,completion_tokens:0},request:(0,h.Fo)(o,p),providerRequest:r||q||null,providerResponse:"[Streaming - raw response not captured]",response:{content:"[Streaming in progress...]",thinking:null,type:"streaming"},status:"success"},{id:D})).catch(a=>{console.error("[RequestDetail] Failed to save streaming request:",a.message)}),{success:!0,response:new Response(C,{headers:j})}}function l({provider:a,model:b,connectionId:c,apiKey:d,requestStartTime:e,body:f,stream:g,finalBody:j,translatedBody:k,clientRawRequest:m}){let n=`${Date.now()}-${Math.random().toString(36).slice(2,11)}`;return{onStreamComplete:(l,o,p)=>{let q={ttft:p?p-e:Date.now()-e,total:Date.now()-e},r=l?.content||"[Empty streaming response]",s=l?.thinking||null;(0,i.ox)((0,h.$R)({provider:a,model:b,connectionId:c,latency:q,tokens:o||{prompt_tokens:0,completion_tokens:0},request:(0,h.Fo)(f,g),providerRequest:j||k||null,providerResponse:r,response:{content:r,thinking:s,type:"streaming"},status:"success"},{id:n})).catch(a=>{console.error("[RequestDetail] Failed to update streaming content:",a.message)}),(0,h.qr)({provider:a,model:b,tokens:o,connectionId:c,apiKey:d,endpoint:m?.endpoint,label:"STREAM USAGE"})},streamDetailId:n}}';

function streamIdPatchedSnippet() {
  return ORIGINAL_STREAM_DETAIL_SNIPPET
    .replace(
      'C=(0,g.Jb)(a,B,z),D=`${Date.now()}-${Math.random().toString(36).slice(2,11)}`;return(0,i.ox)',
      `C=(0,g.Jb)(a,B,z),D=A?.${REQUEST_DETAILS_PATCH_MARKER}||\`${'${Date.now()}'}-${'${Math.random().toString(36).slice(2,11)}'}\`;return(0,i.ox)`,
    )
    .replace(
      'let n=`${Date.now()}-${Math.random().toString(36).slice(2,11)}`;return{onStreamComplete:(l,o,p)=>{let q=',
      `let n=\`${'${Date.now()}'}-${'${Math.random().toString(36).slice(2,11)}'}\`;let t=(l,o,p)=>{let q=`,
    )
    .replace(
      '}),(0,h.qr)({provider:a,model:b,tokens:o,connectionId:c,apiKey:d,endpoint:m?.endpoint,label:"STREAM USAGE"})},streamDetailId:n}}',
      `}),(0,h.qr)({provider:a,model:b,tokens:o,connectionId:c,apiKey:d,endpoint:m?.endpoint,label:"STREAM USAGE"})};return t.${REQUEST_DETAILS_PATCH_MARKER}=n,{onStreamComplete:t,streamDetailId:n}}`,
    );
}

describe('9router synthetic usage patch', () => {
  it('patches 9router usage writer and streaming requestDetails ids', () => {
    const result = patch9routerUsageBundle(`prefix ${ORIGINAL_QR_SNIPPET} ${ORIGINAL_STREAM_DETAIL_SNIPPET} suffix`, {
      providerIds: ['openai-compatible-responses-v4', 'anthropic-compatible-cl'],
    });

    expect(result.changed).toBe(true);
    expect(result.content).toContain(PATCH_MARKER);
    expect(result.content).toContain(REQUEST_DETAILS_PATCH_MARKER);
    expect(result.content).toContain(REQUEST_DETAILS_TOKEN_PATCH_MARKER);
    expect(result.content).toContain('openai-compatible-responses-v4');
    expect(result.content).toContain('anthropic-compatible-cl');
    expect(result.content).toContain('if((!c||"object"!=typeof c)&&!r)return;');
    expect(result.content).toContain('c&&"object"==typeof c||(c={});');
    expect(result.content).toContain('Math.random()*50001');
    expect(result.content).toContain('Math.random()*4901');
    expect(result.content).toContain('synthetic_zero_usage_random');
    expect(result.content).toContain('(0,d.sZ)({provider:a||"unknown"');
    expect(result.content).toContain(`D=A?.${REQUEST_DETAILS_PATCH_MARKER}||\`${'${Date.now()}'}-`);
    expect(result.content).toContain(`let t=(l,o,p)=>{let q={ttft:p?p-e:Date.now()-e,total:Date.now()-e}`);
    expect(result.content).toContain(`/*${REQUEST_DETAILS_TOKEN_PATCH_MARKER}*/`);
    expect(result.content).toContain(`o.${PATCH_MARKER}=!0`);
    expect(result.content).toContain(`return t.${REQUEST_DETAILS_PATCH_MARKER}=n,{onStreamComplete:t,streamDetailId:n}`);
    expect(result.content).not.toContain('if(!c||"object"!=typeof c)return;let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;if(0===k&&0===l)return;');
  });

  it('does not patch an already patched bundle again', () => {
    const first = patch9routerUsageBundle(`${ORIGINAL_QR_SNIPPET} ${ORIGINAL_STREAM_DETAIL_SNIPPET}`, {
      providerIds: ['openai-compatible-responses-v4'],
    });
    const second = patch9routerUsageBundle(first.content, {
      providerIds: ['openai-compatible-responses-v4'],
    });

    expect(second).toEqual({ changed: false, content: first.content });
  });

  it('upgrades a synthetic-v2 bundle to patch streaming requestDetails ids', () => {
    const syntheticOnly = `already synthetic patched ${PATCH_MARKER} ${ORIGINAL_STREAM_DETAIL_SNIPPET}`;

    const result = patch9routerUsageBundle(syntheticOnly, {
      providerIds: ['openai-compatible-responses-v4'],
    });

    expect(result.changed).toBe(true);
    expect(result.content).toContain(PATCH_MARKER);
    expect(result.content).toContain(REQUEST_DETAILS_PATCH_MARKER);
    expect(result.content).toContain(REQUEST_DETAILS_TOKEN_PATCH_MARKER);
    expect(result.content).toContain(`D=A?.${REQUEST_DETAILS_PATCH_MARKER}||\`${'${Date.now()}'}-`);
  });

  it('upgrades a stream-id patched bundle to synthesize tokens before requestDetails writes', () => {
    const streamIdOnly = `already synthetic patched ${PATCH_MARKER} ${streamIdPatchedSnippet()}`;

    const result = patch9routerUsageBundle(streamIdOnly, {
      providerIds: ['openai-compatible-responses-v4'],
    });

    expect(result.changed).toBe(true);
    expect(result.content).toContain(REQUEST_DETAILS_PATCH_MARKER);
    expect(result.content).toContain(REQUEST_DETAILS_TOKEN_PATCH_MARKER);
    expect(result.content).toContain(`o.${PATCH_MARKER}=!0`);
  });

  it('throws when the expected 9router usage writer pattern is missing', () => {
    expect(() => patch9routerUsageBundle('function notTheUsageWriter(){}', {
      providerIds: ['openai-compatible-responses-v4'],
    })).toThrow(/usage writer pattern/);
  });

  it('reads v4 and cl provider ids from providerNodes rows', () => {
    const ids = readSyntheticUsageProviderIds([
      { id: 'v4-node', data: '{"prefix":"v4","baseUrl":"https://example.test/v1"}' },
      { id: 'cl-node', data: '{"prefix":"cl","baseUrl":"https://example.test/v1"}' },
      { id: 'other-node', data: '{"prefix":"kr","baseUrl":"https://example.test/v1"}' },
      { id: 'broken-node', data: '{broken' },
    ]);

    expect(ids).toEqual(['cl-node', 'v4-node']);
  });
});
