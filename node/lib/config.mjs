import path from 'node:path';
import { assertFactories, exact, integer, LIMITS, need, publicKeyValid } from './protocol.mjs';

export function peerUrl(value) {
  need(typeof value === 'string' && value.length <= 300, 'PEER_URL_INVALID');
  let url; try { url = new URL(value); } catch { throw new Error('PEER_URL_INVALID'); }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  need((url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/', 'PEER_URL_INVALID');
  return url.origin;
}
export function validateConfig(value, configPath) {
  exact(value, ['schema', 'host', 'port', 'allowedHosts', 'dataDir', 'syncIntervalMs', 'peers', 'publishers', 'catalogue', 'serveDex'], 'CONFIG_INVALID');
  need(value.schema === 'realdex.node.config.v1' && ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(value.host), 'CONFIG_INVALID');
  integer(value.port, 1, 65535, 'CONFIG_PORT_INVALID'); integer(value.syncIntervalMs, 5000, 60000, 'CONFIG_INTERVAL_INVALID');
  need(Array.isArray(value.allowedHosts) && value.allowedHosts.length > 0 && value.allowedHosts.length <= 16 &&
    value.allowedHosts.every(x => typeof x === 'string' && x.length <= 255 && /^[a-z0-9.:[\]-]+$/.test(x)) &&
    new Set(value.allowedHosts).size === value.allowedHosts.length, 'CONFIG_HOSTS_INVALID');
  need(typeof value.dataDir === 'string' && value.dataDir.length > 0 && value.dataDir.length <= 1024 && !value.dataDir.includes('\0') &&
    typeof value.serveDex === 'boolean', 'CONFIG_INVALID');
  need(Array.isArray(value.peers) && value.peers.length <= LIMITS.peers && Array.isArray(value.publishers) && value.publishers.length < LIMITS.publishers &&
    value.publishers.every(publicKeyValid) && new Set(value.publishers).size === value.publishers.length, 'CONFIG_PEERS_INVALID');
  const peers = value.peers.map(peer => {
    exact(peer, ['url', 'publicKey'], 'CONFIG_PEER_INVALID'); need(publicKeyValid(peer.publicKey), 'CONFIG_PEER_INVALID');
    return { url: peerUrl(peer.url), publicKey: peer.publicKey };
  });
  need(new Set(peers.map(x => x.url)).size === peers.length && new Set(peers.map(x => x.publicKey)).size === peers.length, 'CONFIG_PEER_DUPLICATE');
  exact(value.catalogue, ['revision', 'factories'], 'CONFIG_CATALOGUE_INVALID');
  integer(value.catalogue.revision, 1, Number.MAX_SAFE_INTEGER, 'REVISION_INVALID'); assertFactories(value.catalogue.factories);
  return { ...structuredClone(value), peers, dataDir: path.resolve(path.dirname(configPath), value.dataDir) };
}
