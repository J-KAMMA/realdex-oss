import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The one place the test-only signing key is read.
//
// This was copied into ten scripts and hardhat.config.cjs, each with its own hard
// coded default path. That matters because V01_SCOPE records the key as an
// explicit, bounded exception that must NOT carry into v0.2 — and an exception
// spread across eleven files is closed by editing eleven files, which is how a
// forgotten copy keeps working after the others are shut. Closing it now means
// changing this module.
//
// Conditions the scope attaches to the exception, unchanged here: the key is
// never in the repository, documentation, logs, command arguments or shared
// memory; it is test-only and holds nothing of value; it is never used for a
// production deployment, a Safe owner, or any persistent role.
//
// Callers get the key and immediately hand it to ethers. Nothing here prints it,
// and no caller should: an error message that includes the key is the same leak
// as writing it to a file.
export const V01_SIGNER_ADDRESS = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";

const DEFAULT_KEY_FILE = path.join(os.homedir(), ".realdex", "v01-test-signer.json");

/**
 * Reads the test-only key. `REALDEX_V01_SIGNER_PRIVATE_KEY` wins, then the JSON
 * file named by `REALDEX_V01_SIGNER_KEY_FILE`, then the default location.
 *
 * Throws rather than returning empty: a script that silently continues without a
 * signer looks like it ran and proved something.
 */
export function v01SignerPrivateKey () {
  const direct = process.env.REALDEX_V01_SIGNER_PRIVATE_KEY;
  if (direct) return direct;
  const keyFile = process.env.REALDEX_V01_SIGNER_KEY_FILE ?? DEFAULT_KEY_FILE;
  if (!fs.existsSync(keyFile)) throw new Error(`no signer key at ${keyFile}; set REALDEX_V01_SIGNER_KEY_FILE or REALDEX_V01_SIGNER_PRIVATE_KEY`);
  const { privateKey } = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  if (!privateKey) throw new Error("signer key file has no privateKey field");
  return privateKey;
}

/**
 * The same key, or an empty list when there is none. Only hardhat wants this
 * shape: a network defined without accounts can still read, which is what should
 * happen when no key is configured.
 */
export function v01SignerAccounts () {
  try {
    return [v01SignerPrivateKey()];
  } catch {
    return [];
  }
}
