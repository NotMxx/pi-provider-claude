#!/usr/bin/env node
// A stand-in for the `claude` binary: the same stream-json and control protocol, including the in-process ("sdk") MCP
// server whose messages travel as control requests to the host (the extension). Responses follow a script; everything is logged.
//
// The extension passes only a few variables through, so the fake finds its files in CLAUDE_CONFIG_DIR, which it always gets.
// `script.json` there: an array of { match?: string, steps: Step[] }. The first entry whose `match` appears in the
// system prompt is used; its position is kept in `script.json.<entry>.pos`, so it continues across processes.
// Step: { text?, thinking?: {text, signature}, toolCalls?: [{name, args}], usage?, stop?, error?, crash?, slowMs?, limit?, overage?, overageInUse? }
// `overage` marks the response as drawn from usage credits (Extra Usage) with `isUsingOverage` (a plan window used up);
// `overageInUse` marks it the way Anthropic reports third-party Extra Usage billing (`overageInUse`, `rateLimitType: overage`).
// `limit` is a rate_limit_info sent with status `rejected`, followed by an error result, as when the plan limit is reached.
// An entry may list `refuseModels`, which `set_model` refuses, and `models`, which `initialize` reports.
// `log.jsonl` there: JSON lines of what happened.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SCRIPT = join(process.env.CLAUDE_CONFIG_DIR, 'script.json');
const LOG = join(process.env.CLAUDE_CONFIG_DIR, 'log.jsonl');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const log = (o) => appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resume = arg('--resume') ? readFileSync(arg('--resume'), 'utf8') : undefined;
const mcpConfig = JSON.parse(arg('--mcp-config')).mcpServers;
log({ kind: 'spawn', args: argv, env: process.env, cwd: process.cwd(), resume, mcpConfig });

let system = '', entry = -1, model = arg('--model'), tools = [];
const nextStep = () => {
  const posFile = `${SCRIPT}.${entry}.pos`;
  const pos = existsSync(posFile) ? Number(readFileSync(posFile, 'utf8')) : 0;
  writeFileSync(posFile, String(pos + 1));
  return script[entry].steps[pos] ?? { text: 'script exhausted' };
};
const script = JSON.parse(readFileSync(SCRIPT, 'utf8'));

// Control requests to the host, answered by control responses.
const waiting = new Map();
let reqN = 0;
const toHost = (request) => new Promise((resolve) => { const id = `cli-${++reqN}`; waiting.set(id, resolve); out({ type: 'control_request', request_id: id, request }); });
const mcp = async (method, params) => (await toHost({ subtype: 'mcp_message', server_name: 'pi', message: { jsonrpc: '2.0', id: reqN + 1, method, params } })).response.mcp_response;
const listTools = async () => { tools = (await mcp('tools/list', {})).result.tools; log({ kind: 'mcp-list', tools }); };

// Like Claude Code, MCP servers are connected before the first turn runs.
let started;
let msgN = 0;
async function respond() {
  const step = nextStep();
  if (step.crash) { process.stderr.write('fake crash: something broke\n'); process.exit(3); }
  if (step.limit) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...step.limit } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' });
    return;
  }
  if (step.error) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: step.error }); return; }
  const id = `msg_fake_${++msgN}`;
  const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, ...(step.usage ?? {}) };
  const info = step.overageTypeOnly ? { status: 'allowed', rateLimitType: 'overage' } : step.overageInUse
    // As Claude Code reports Anthropic's third-party Extra Usage billing: the header's overageInUse, isUsingOverage false.
    ? { status: 'allowed', rateLimitType: 'overage', overageInUse: true, isUsingOverage: false }
    : { status: 'allowed', isUsingOverage: step.overage === true };
  out({ type: 'rate_limit_event', rate_limit_info: info });
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, model, usage: { ...usage, output_tokens: 1 } } } });
  let index = 0;
  if (step.thinking) {
    out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: step.thinking.text } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: step.thinking.signature } } });
    out({ type: 'stream_event', event: { type: 'content_block_stop', index } });
    index++;
  }
  if (step.text) {
    out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    for (const piece of step.text.match(/.{1,8}/gs)) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
      if (step.slowMs) await sleep(step.slowMs);
    }
    out({ type: 'stream_event', event: { type: 'content_block_stop', index } });
    index++;
  }
  const calls = (step.toolCalls ?? []).map((c, i) => ({ ...c, id: `toolu_fake_${msgN}_${i}` }));
  for (const c of calls) {
    if (!tools.some((t) => t.name === c.name)) { log({ kind: 'unknown-tool', name: c.name }); }
    out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: `mcp__pi__${c.name}`, input: {} } } });
    const json = JSON.stringify(c.args);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } } });
    out({ type: 'stream_event', event: { type: 'content_block_stop', index } });
    index++;
  }
  const stop = calls.length ? 'tool_use' : (step.stop ?? 'end_turn');
  out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  if (!calls.length) { out({ type: 'result', subtype: 'success', is_error: false, result: step.text ?? '' }); return; }
  // Like Claude Code: one MCP call at a time, in order, then the model continues on its own.
  for (const c of calls) {
    const reply = await mcp('tools/call', { name: c.name, arguments: c.args });
    log({ kind: 'mcp-result', name: c.name, args: c.args, result: reply.result });
  }
  await respond();
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_response') { waiting.get(msg.response.request_id)?.(msg.response); waiting.delete(msg.response.request_id); return; }
  log({ kind: 'stdin', msg });
  const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
  if (msg.type === 'control_request') {
    const r = msg.request;
    if (r.subtype === 'initialize') {
      system = (r.systemPrompt ?? []).join('\n') || (r.appendSystemPrompt ?? '');
      entry = script.findIndex((e) => !e.match || system.includes(e.match));
      log({ kind: 'initialize', system, systemPrompt: r.systemPrompt, appendSystemPrompt: r.appendSystemPrompt, sdkMcpServers: r.sdkMcpServers });
      ok({ commands: [], models: script[entry].models ?? [] });
      started = (async () => {
        await mcp('initialize', { protocolVersion: '2025-06-18' });
        await listTools();
        out({ type: 'system', subtype: 'init', tools: tools.map((t) => `mcp__pi__${t.name}`), model });
      })();
    } else if (r.subtype === 'set_model') {
      if ((script[entry].refuseModels ?? []).includes(r.model)) out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'model not available' } });
      else { model = r.model; ok(null); }
    }
    else if (r.subtype === 'apply_flag_settings') { ok(null); }
    else if (r.subtype === 'mcp_message' && r.message.method === 'notifications/tools/list_changed') { ok({ mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } }); await listTools(); }
    else if (r.subtype === 'interrupt') { ok(null); process.exit(0); }
    else out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'unsupported in fake' } });
    return;
  }
  if (msg.type === 'user') { await started; await respond(); }
});
process.stdin.on('end', () => process.exit(0));
