// The full verifier supplies a fresh report path. Preserve the actual test configuration.
const fs = require('node:fs');
const path = require('node:path');
const suite = process.env.REALDEX_ACCEPTANCE_HARDHAT_SUITE;
const output = process.env.REALDEX_ACCEPTANCE_REPORT;
if (!['root', 'wallet'].includes(suite) || !output || !path.isAbsolute(output) || fs.existsSync(output)) {
  throw Error('HARDHAT_ACCEPTANCE_REPORT_CONFIGURATION_INVALID');
}
const base = suite === 'root' ? require('../hardhat.config.cjs') : require('./hardhat-wallet.config.cjs');
module.exports = {...base, paths: {...base.paths, root: path.resolve(__dirname, '..')},
  mocha: {...base.mocha, forbidOnly: true, reporter: 'json', reporterOptions: {output}}};
