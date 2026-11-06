#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity, assertIdentity, nodeId, need, integer } from './lib/protocol.mjs';
import { atomicJson, readJsonFile, acquireInstanceLock, HeadStore } from './lib/store.mjs';
import { validateConfig } from './lib/config.mjs';
import { RealDexNode } from './lib/server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2); const command = args.shift();
function options() {
  const result = {};
  while (args.length) {
    const name = args.shift(); need(['--directory', '--port', '--config', '--allow-network'].includes(name) && !Object.hasOwn(result, name), 'ARGUMENT_INVALID');
    if (name === '--allow-network') result[name] = true;
    else { const value = args.shift(); need(value && !value.startsWith('--'), 'ARGUMENT_VALUE_MISSING'); result[name] = value; }
  }
  return result;
}
async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log('RealDEX Node Preview (no wallet keys / no funds / no signing API)\n' +
      '  node node/cli.mjs init --directory .realdex/my-node --port 8787\n' +
      '  node node/cli.mjs identity --config .realdex/my-node/config.json\n' +
      '  node node/cli.mjs start --config .realdex/my-node/config.json\n' +
      'Non-loopback listening additionally requires --allow-network. No port forwarding or firewall changes are performed.');
    return;
  }
  const opt = options();
  if (command === 'init') {
    need(!opt['--config'] && !opt['--allow-network'], 'ARGUMENT_INVALID');
    const directory = path.resolve(opt['--directory'] ?? '.realdex/my-node'); const port = Number(opt['--port'] ?? 8787);
    integer(port, 1, 65535, 'CONFIG_PORT_INVALID');
    need(!fs.existsSync(directory), 'DIRECTORY_EXISTS_NOT_OVERWRITTEN'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identity = createIdentity();
    atomicJson(path.join(directory, 'identity.json'), identity);
    atomicJson(path.join(directory, 'config.json'), { schema: 'realdex.node.config.v1', host: '127.0.0.1', port,
      allowedHosts: ['127.0.0.1:' + port, 'localhost:' + port], dataDir: '.', syncIntervalMs: 10000,
      peers: [], publishers: [], catalogue: { revision: 1, factories: [] }, serveDex: false });
    console.log(JSON.stringify({ config: path.join(directory, 'config.json'), publicKey: identity.publicKey, nodeId: nodeId(identity.publicKey),
      warning: 'identity.json is a node-only identity key, NOT a wallet. Keep it private; never put wallet keys here.' }, null, 2));
    return;
  }
  need(['identity', 'start'].includes(command) && !opt['--directory'] && !opt['--port'], 'ARGUMENT_INVALID');
  const configPath = path.resolve(opt['--config'] ?? '.realdex/my-node/config.json');
  const config = validateConfig(readJsonFile(configPath), configPath);
  const identity = readJsonFile(path.join(config.dataDir, 'identity.json')); assertIdentity(identity);
  if (command === 'identity') { console.log(JSON.stringify({ publicKey: identity.publicKey, nodeId: nodeId(identity.publicKey) }, null, 2)); return; }
  need(['127.0.0.1', '::1'].includes(config.host) || opt['--allow-network'] === true, 'NETWORK_LISTEN_REQUIRES_EXPLICIT_FLAG');
  let distRoot = null;
  if (config.serveDex) {
    distRoot = path.join(projectRoot, 'dist');
    const { createEvmTestnetReleasePlan } = await import('../scripts/createEvmTestnetReleasePlan.mjs');
    const { releaseId } = await createEvmTestnetReleasePlan();
    need(fs.readFileSync(path.join(distRoot, 'release-id.txt'), 'utf8').trim() === releaseId, 'DEX_BUILD_STAMP_MISMATCH');
    need(fs.lstatSync(path.join(distRoot, 'index.html')).isFile(), 'DEX_BUILD_UNAVAILABLE');
  }
  const release = acquireInstanceLock(config.dataDir); let node;
  try {
    node = new RealDexNode({ identity, config, heads: new HeadStore(path.join(config.dataDir, 'heads.json')), distRoot });
    await node.start();
  } catch (error) { await node?.close(); release(); throw error; }
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return; exiting = true;
    try { await node.close(); } finally { release(); }
  };
  process.once('SIGINT', () => { shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { shutdown().catch(() => { process.exitCode = 1; }); });
  // A ready parent may terminate immediately; the shutdown hook must already exist.
  console.log(JSON.stringify({ mode: 'read-only-discovery-preview', publicKey: identity.publicKey,
    console: `http://${config.host === '::1' || config.host === '::' ? '[::1]' : config.host}:${config.port}/node/`,
    exchangeLab: `http://${config.host === '::1' || config.host === '::' ? '[::1]' : config.host}:${config.port}/node/exchange/`,
    multichainLab: `http://${config.host === '::1' || config.host === '::' ? '[::1]' : config.host}:${config.port}/node/chains/`,
    peers: config.peers.length, walletSigning: false, custody: false, dexServed: Boolean(distRoot) }, null, 2));
}
main().catch(error => {
  // Never dump a config, key, stack, raw peer response, or an arbitrary URL.
  console.error(error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'NODE_COMMAND_FAILED'); process.exitCode = 1;
});
