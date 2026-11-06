#!/usr/bin/env node
// Runs three temporary loopback peers and a synthetic optimizer example. No chain
// RPC, wallet, real Factory address, permanent key file or transaction is used.
import { createIdentity } from './lib/protocol.mjs';
import { RealDexNode } from './lib/server.mjs';
import { runOptimizerDemo } from './optimizer/demo-data.mjs';

const nodes = [];
async function start(peers = [], publishers = [], factories = []) {
  const identity = createIdentity();
  const config = { schema: 'realdex.node.config.v1', host: '127.0.0.1', port: 8787,
    allowedHosts: [], dataDir: '.', syncIntervalMs: 10000, peers, publishers,
    catalogue: { revision: 1, factories }, serveDex: false };
  const node = new RealDexNode({ identity, config }); nodes.push(node);
  const address = await node.start({ port: 0, autoSync: false });
  config.allowedHosts = ['127.0.0.1:' + address.port];
  return { node, publicKey: identity.publicKey, peer: { url: 'http://127.0.0.1:' + address.port, publicKey: identity.publicKey } };
}
try {
  const a = await start([], [], [{ chainId: 'eip155:84532', address: '0x' + '1'.repeat(40), protocol: 'realdex-cpmm-v1' }]);
  const b = await start([a.peer]); await b.node.syncNow();
  const c = await start([b.peer], [a.publicKey]); await c.node.syncNow();
  const relayed = c.node.status().candidates;
  if (relayed.length !== 1 || relayed[0].sources[0].publisher !== a.publicKey || relayed[0].executable !== false) throw new Error('RELAY_DEMO_FAILED');
  await b.node.close(); await c.node.syncNow();
  const response = await fetch(c.peer.url + '/node/');
  const output = { mode: 'loopback-and-synthetic-only', peers: 3,
    checks: { originalPublisherPreserved: true, intermediaryStopped: true, remainingNodeConsoleResponds: response.status === 200,
      candidateStillWithinTtl: c.node.status().candidates.length === 1, executable: false },
    optimizer: runOptimizerDemo() };
  if (response.status !== 200) throw new Error('CONSOLE_DEMO_FAILED');
  console.log(JSON.stringify(output, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'DEMO_FAILED'); process.exitCode = 1;
} finally { await Promise.all(nodes.map(node => node.close())); }
