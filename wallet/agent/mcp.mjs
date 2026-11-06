#!/usr/bin/env node
/** MCP stdio transport. No credentials, launch URL, or non-JSON messages on stdout. */
import {AgentWalletClient} from './client.mjs';
import {AgentMcpSession} from './tools.mjs';
import {safeError} from '../lib/guard.mjs';
let client;
try {
  client = new AgentWalletClient({url: process.env.REALDEX_WALLET_URL ?? 'http://127.0.0.1:8790', token: process.env.REALDEX_AGENT_TOKEN});
  delete process.env.REALDEX_AGENT_TOKEN;
  const session = new AgentMcpSession(client);
  let buffer = Buffer.alloc(0), outstanding = 0, queue = Promise.resolve(), stopped = false;
  const write = x => { if (x && !stopped) process.stdout.write(JSON.stringify(x) + '\n'); };
  const failTransport = () => { stopped = true; process.stderr.write('MCP_INPUT_LIMIT\n'); client.destroy(); process.stdin.destroy(); process.exitCode = 1; };
  process.stdin.on('data', chunk => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > 16384 || outstanding >= 32) { failTransport(); return; }
      const line = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 1);
      if (!line.trim()) continue;
      outstanding++;
      queue = queue.then(async () => {
        if (stopped) return;
        let m; try { m = JSON.parse(line); } catch { write({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'JSON_INVALID'}}); return; }
        write(await session.dispatch(m));
      }).catch(() => write({jsonrpc: '2.0', id: null, error: {code: -32603, message: 'INTERNAL_ERROR'}})).finally(() => { outstanding--; });
    }
    if (buffer.length > 16384) failTransport();
  });
  process.stdin.on('end', () => {
    if (buffer.length && !stopped) write({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'TRUNCATED_MESSAGE'}});
    void queue.finally(() => client.destroy());
  });
  process.stdin.on('error', () => { client.destroy(); process.exitCode = 1; });
} catch (e) { process.stderr.write(safeError(e) + '\n'); process.exitCode = 1; }
