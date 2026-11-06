/**
 * Reading a built distribution off disk, for the attestation scripts.
 *
 * Kept apart from app/lib/release-attestation.mjs on purpose: everything that decides
 * anything lives there and is pure, and this is the part that touches a file system and
 * therefore cannot be reasoned about without one.
 */
import {createHash} from 'node:crypto';
import {readdir, readFile, stat, lstat} from 'node:fs/promises';
import {join, relative, resolve, sep} from 'node:path';

/**
 * Every regular file under `directory`, as a path relative to it mapped to its hash.
 *
 * Symbolic links are refused rather than followed. A link is not the bytes it points at,
 * and a distribution that contains one is not a distribution somebody can hash and hand
 * to someone else and expect the same answer.
 */
export async function readDistribution(directory) {
  const root = resolve(directory);
  const observed = {};
  const walk = async current => {
    const entries = await readdir(current, {withFileTypes: true});
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('RELEASE_DISTRIBUTION_SYMLINK: ' + relative(root, absolute));
      if (info.isDirectory()) { await walk(absolute); continue; }
      if (!info.isFile()) throw new Error('RELEASE_DISTRIBUTION_NOT_A_FILE: ' + relative(root, absolute));
      // POSIX separators in the record, whatever the host uses, so an attestation made on
      // one operating system verifies on another.
      const path = relative(root, absolute).split(sep).join('/');
      observed[path] = 'sha256:' + createHash('sha256').update(await readFile(absolute)).digest('hex');
    }
  };
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error('RELEASE_DISTRIBUTION_NOT_A_DIRECTORY: ' + root);
  await walk(root);
  if (Object.keys(observed).length === 0) throw new Error('RELEASE_DISTRIBUTION_EMPTY: ' + root);
  return observed;
}
