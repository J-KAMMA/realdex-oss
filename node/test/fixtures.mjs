import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const NOW = 1788566400000;
export const factory = (digit = '1') => ({ chainId: 'eip155:84532', address: '0x' + digit.repeat(40), protocol: 'realdex-cpmm-v1' });
export function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-node-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
export const context = { requestId: 'request-1', sourceAsset: 'eip155:84532/erc20:0x' + '1'.repeat(40),
  destinationAsset: 'eip155:84532/erc20:0x' + '2'.repeat(40), amountIn: 1000n };
export const nativeAsset = 'eip155:84532/slip44:60';
export const policy = { now: NOW, minimumLifetimeMs: 1000, maximumSeconds: 60, maximumPriceImpactBps: 1000, allowedRiskClasses: ['local-amm'], requireTrackedFinality: true };
export const quote = (id = 'route-a', changes = {}) => ({ ...context, routeId: id, expectedOut: 1100n, minimumOut: 1000n,
  expiresAt: NOW + 60000, durationSeconds: 10, priceImpactBps: 100, riskClass: 'local-amm', finality: 'tracked', costs: [], unpricedCosts: [], ...changes });
export const rate = (changes = {}) => ({ asset: nativeAsset, outputAsset: context.destinationAsset, numerator: 1n, denominator: 1n,
  asOf: NOW, expiresAt: NOW + 60000, source: 'local-test-price', ...changes });
export const cost = (changes = {}) => ({ id: 'gas', asset: context.destinationAsset, amount: 10n, treatment: 'additional', ...changes });
export function config(changes = {}) { return { schema: 'realdex.node.config.v1', host: '127.0.0.1', port: 8787,
  allowedHosts: ['127.0.0.1:8787'], dataDir: '.', syncIntervalMs: 10000, peers: [], publishers: [],
  catalogue: { revision: 1, factories: [] }, serveDex: false, ...changes }; }
