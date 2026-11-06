import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {testEnvironment} from './parallel-process.mjs';

/** Inspect and execute only an explicitly selected pnpm CLI; never install one. */
export function pinnedPnpmStatus(cli, expectedVersion, environment = testEnvironment()) {
  try {
    const need = (value, code) => { if (!value) throw Error(code); };
    need(typeof cli === 'string' && path.isAbsolute(cli), 'PINNED_PNPM_CLI_NOT_CONFIGURED');
    need(typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(expectedVersion), 'PNPM_VERSION_PIN_INVALID');
    const stat = fs.lstatSync(cli);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 33554432, 'PNPM_CLI_FILE_INVALID');
    const manifestBytes = fs.readFileSync(path.resolve(path.dirname(cli), '../package.json'));
    const manifest = JSON.parse(manifestBytes);
    need(manifest.name === 'pnpm' && manifest.version === expectedVersion, 'PNPM_PACKAGE_VERSION_MISMATCH');
    const result = spawnSync(process.execPath, [cli, '--version'], {
      env: testEnvironment(environment), encoding: 'utf8', timeout: 10000, maxBuffer: 65536, shell: false,
    });
    need(result.status === 0 && !result.signal && !result.error, 'PNPM_VERSION_PROCESS_FAILED');
    need(result.stdout.trim() === expectedVersion, 'PNPM_EXECUTED_VERSION_MISMATCH');
    return {available: true, version: expectedVersion, cli,
      cliSha256: createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
      packageManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      autoInstallPerformed: false};
  } catch (error) {
    return {available: false, reason: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PNPM_CLI_UNAVAILABLE', autoInstallPerformed: false};
  }
}
