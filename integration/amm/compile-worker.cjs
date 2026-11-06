/** Isolated TEST compiler process. No automatic downloads or alternative compiler fallback. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const pin = require('./experimental-pin.json');
try {
  const file = process.argv[2];
  if (!file) throw Error('EXPERIMENTAL_COMPILER_NOT_CONFIGURED');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== pin.bytes || (before.mode & 0o022)) throw Error('EXPERIMENTAL_COMPILER_UNSAFE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw Error('EXPERIMENTAL_COMPILER_CHANGED');
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw Error('EXPERIMENTAL_COMPILER_HASH_MISMATCH');
  let input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 2097152) throw Error('COMPILER_INPUT_TOO_LARGE');
  // Compile the exact bytes just verified, not a second file read by require().
  const module = new Module(path.resolve(__dirname, 'verified-soljson.cjs'), moduleParent());
  module.filename = path.resolve(__dirname, 'verified-soljson.cjs');
  module.paths = [];
  module._compile(bytes.toString('utf8'), module.filename);
  const soljson = module.exports;
  const version = soljson.cwrap('solidity_version', 'string', [])();
  if (version !== pin.version) throw Error('EXPERIMENTAL_COMPILER_VERSION_MISMATCH');
  const compiled = soljson.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])(input, 0, 0);
  process.stdout.write(JSON.stringify({version, output: JSON.parse(compiled)}));
} catch (error) {
  console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'EXPERIMENTAL_COMPILER_EXECUTION_FAILED');
  process.exitCode = 2;
}
function moduleParent() { return require.main; }
