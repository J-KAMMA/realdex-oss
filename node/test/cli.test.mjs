import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { directory } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (...args) => spawnSync(process.execPath, ['node/cli.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
function init(t, port = 8787) {
  const dir = path.join(directory(t), 'node');
  const result = run('init', '--directory', dir, '--port', String(port)); assert.equal(result.status, 0, result.stderr);
  return { dir, config: path.join(dir, 'config.json'), result };
}
async function availablePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
test('CLI init creates only node identity/config with no key in console output', t => {
  const { dir, result } = init(t); const output = JSON.parse(result.stdout);
  const identity = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json')));
  assert.equal(output.publicKey, identity.publicKey); assert.ok(!result.stdout.includes(identity.privateKey));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'identity.json']);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.serveDex, false); assert.deepEqual(config.peers, []);
});
test('CLI refuses to overwrite an existing node identity', t => {
  const { dir } = init(t); const before = fs.readFileSync(path.join(dir, 'identity.json'));
  const result = run('init', '--directory', dir); assert.equal(result.status, 1); assert.match(result.stderr, /DIRECTORY_EXISTS_NOT_OVERWRITTEN/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'identity.json')), before);
});
test('CLI identity outputs just node ID and public key', t => {
  const { config } = init(t); const output = run('identity', '--config', config); assert.equal(output.status, 0);
  assert.deepEqual(Object.keys(JSON.parse(output.stdout)).sort(), ['nodeId', 'publicKey']);
});
test('CLI rejects malformed or duplicate options without creating a directory', t => {
  const dir = path.join(directory(t), 'node');
  for (const args of [['init', '--directory', dir, '--port', '0'], ['init', '--directory', dir, '--port', 'not-a-number'],
    ['init', '--directory', dir, '--directory', dir], ['init', '--directory', dir, '--unknown', 'x']]) {
    assert.equal(run(...args).status, 1); assert.equal(fs.existsSync(dir), false);
  }
});
test('CLI network binding requires an extra explicit start flag', t => {
  const { config } = init(t); const data = JSON.parse(fs.readFileSync(config)); data.host = '0.0.0.0'; fs.writeFileSync(config, JSON.stringify(data));
  const output = run('start', '--config', config); assert.equal(output.status, 1); assert.match(output.stderr, /NETWORK_LISTEN_REQUIRES_EXPLICIT_FLAG/);
});
test('CLI starts a loopback node, rejects a concurrent instance, stops cleanly and restarts with durable heads', async t => {
  const port = await availablePort(); const { dir, config } = init(t, port);
  async function start() {
    const child = spawn(process.execPath, ['node/cli.mjs', 'start', '--config', config], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const exit = once(child, 'exit'); t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exit; });
    const deadline = Date.now() + 5000;
    while (!stdout.includes('read-only-discovery-preview')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('CLI_START_FAILED:' + stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { child, exit, stdout };
  }
  const first = await start(); const origin = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(origin + '/node/')).status, 200);
  const status = await (await fetch(origin + '/v1/status')).json(); assert.equal(status.custody, false);
  const duplicate = run('start', '--config', config); assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /INSTANCE_LOCKED/);
  first.child.kill('SIGTERM'); const [code] = await first.exit; assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(dir, 'instance.lock')), false); assert.equal(fs.existsSync(path.join(dir, 'heads.json')), true);
  const restarted = await start(); const secondStatus = await (await fetch(origin + '/v1/status')).json(); assert.equal(secondStatus.publicKey, status.publicKey);
  restarted.child.kill('SIGTERM'); assert.equal((await restarted.exit)[0], 0);
});
test('CLI three-peer demo runs without external configuration and outputs no keys', () => {
  const result = spawnSync(process.execPath, ['node/demo.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  assert.equal(data.checks.originalPublisherPreserved, true); assert.equal(data.checks.remainingNodeConsoleResponds, true);
  assert.equal(data.optimizer.split.plan.score, '94854'); assert.ok(!result.stdout.includes('privateKey'));
});
