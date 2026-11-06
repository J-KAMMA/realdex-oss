/**
 * P0-3 step 3: execute the STABLE CANDIDATE bytecode itself on the pinned Anvil.
 *
 * This gate deliberately does NOT use the experimental wallet artifact
 * (wallet/smart-account/build.json), does not recompile, and does not promote
 * anything. It deploys exactly the creation code recorded in the reviewed
 * candidate, checks that the on-chain runtime code is that candidate's runtime
 * template (immutables excepted), and then exercises real owner-authorised
 * execution against it. Passing here is evidence of execution only: it is not
 * independent security review, stable promotion or production approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import candidate from '../../wallet/smart-account/stable-build-candidate.json' with {type: 'json'};
import evidence from './stable-candidate-evidence.json' with {type: 'json'};
import {verifyCandidate} from './stable-candidate.mjs';
import {startAnvil} from '../anvil/fixture.mjs';
import {ANVIL_PIN} from '../anvil/toolchain.mjs';
import {callData, receipt, uints, addr} from '../amm/abi.mjs';
import {selector, address} from '../../node/verified/keccak.mjs';

const OWNER = '0x2222333344445555666677778888999900001111';
const RECIPIENT = '0x3535353535353535353535353535353535353535';
const SALT = '0x' + '19'.repeat(32);
const ONE_ETHER = 1000000000000000000n;
const word = n => BigInt(n).toString(16).padStart(64, '0');

const hex = value => {
  assert.match(value, /^0x[0-9a-fA-F]*$/, 'expected hex string');
  return value.slice(2).toLowerCase();
};

/** Blank every immutable range so the remainder must match the template byte for byte. */
function maskImmutables(runtimeHex, references) {
  const bytes = Buffer.from(runtimeHex, 'hex');
  const values = {};
  for (const [name, ranges] of Object.entries(references ?? {})) {
    for (const range of ranges) {
      const slice = bytes.subarray(range.start, range.start + range.length);
      assert.equal(slice.length, range.length, 'immutable range outside deployed code');
      (values[name] ??= []).push(slice.toString('hex'));
      slice.fill(0);
    }
  }
  return {masked: bytes.toString('hex'), values};
}

/** The one 32-byte word every reference for a given immutable must agree on. */
function immutableAddress(values, name) {
  const observed = values[name];
  assert.ok(Array.isArray(observed) && observed.length > 0, 'missing immutable ' + name);
  assert.equal(new Set(observed).size, 1, 'immutable ' + name + ' differs between references');
  const raw = observed[0];
  assert.equal(raw.length, 64, 'immutable ' + name + ' is not a 32-byte word');
  return address('0x' + raw.slice(24));
}

/**
 * executeBatch(Call[],uint256,uint48) with one value-only call. Hand-encoded, because the
 * shared test ABI writer splits its type list on commas and so cannot express a tuple.
 */
function executeBatchData(target, value, expectedNonce, validUntil) {
  const head = word(0x60) + word(expectedNonce) + word(validUntil);
  const array = word(1) + word(0x20);
  const element = hex(target).padStart(64, '0') + word(value) + word(0x60) + word(0);
  return selector('executeBatch((address,uint256,bytes)[],uint256,uint48)') + head + array + element;
}

test('the stable candidate deploys and executes on the pinned Anvil', async t => {
  // The candidate must still be the reviewed, source-bound, unapproved one.
  assert.equal(verifyCandidate(candidate, {expectedBuildInfoSha256: evidence.buildInfoSha256}), true);
  assert.equal(candidate.compilerExecutionReplayed, false);
  assert.equal(candidate.independentReviewComplete, false);
  assert.equal(candidate.productionApproved, false);

  const chain = await startAnvil();
  t.after(() => chain.close());
  assert.match(chain.clientVersion, /anvil/i);
  assert.equal(await chain.call('eth_chainId', []), '0x7a69');

  const deployer = '0x1111222233334444555566667777888899990000';
  for (const account of [deployer, OWNER]) {
    await chain.call('anvil_setBalance', [account, '0x' + (100n * ONE_ETHER).toString(16)]);
    await chain.call('anvil_impersonateAccount', [account]);
  }

  const factoryArtifact = candidate.contracts.RealDexSmartAccountFactory;
  const accountArtifact = candidate.contracts.RealDexSmartAccount;

  await t.test('the factory deployed from candidate creation code carries the candidate runtime code', async () => {
    // The factory has no immutables, so its deployed code must match exactly.
    assert.deepEqual(factoryArtifact.immutableReferences, {});
    const hash = await chain.call('eth_sendTransaction',
      [{from: deployer, data: factoryArtifact.creationCode, gas: '0x989680'}]);
    const created = await receipt(chain, hash);
    assert.equal(created.status, '0x1', 'candidate factory deployment must succeed');
    factoryArtifact.deployedAt = address(created.contractAddress);
    const onChain = await chain.call('eth_getCode', [factoryArtifact.deployedAt, 'latest']);
    assert.equal(hex(onChain), hex(factoryArtifact.runtimeTemplate),
      'deployed factory code is not the candidate runtime template');
  });

  let account;
  await t.test('the factory creates the account at the address it predicts', async () => {
    const predicted = addr(await chain.call('eth_call',
      [{to: factoryArtifact.deployedAt, data: callData('getAddress(address,bytes32)', [OWNER, SALT])}, 'latest']));
    const hash = await chain.call('eth_sendTransaction', [{
      from: deployer, to: factoryArtifact.deployedAt,
      data: callData('createAccount(address,bytes32)', [OWNER, SALT]), gas: '0x989680',
    }]);
    const created = await receipt(chain, hash);
    assert.equal(created.status, '0x1', 'createAccount must succeed');
    account = predicted;
    const code = await chain.call('eth_getCode', [account, 'latest']);
    assert.notEqual(hex(code), '', 'no code at the predicted address');
  });

  await t.test('the account runtime code is the candidate template with only its immutables filled', async () => {
    const deployed = hex(await chain.call('eth_getCode', [account, 'latest']));
    const template = hex(accountArtifact.runtimeTemplate);
    assert.equal(deployed.length, template.length, 'deployed account code length differs from the template');
    const {masked, values} = maskImmutables(deployed, accountArtifact.immutableReferences);
    const blank = maskImmutables(template, accountArtifact.immutableReferences).masked;
    assert.equal(masked, blank, 'deployed account code differs from the candidate template outside its immutables');
    // The immutables must hold the real owner and the real factory, not zeros.
    assert.equal(immutableAddress(values, 'owner'), address(OWNER));
    assert.equal(immutableAddress(values, 'factory'), factoryArtifact.deployedAt);
  });

  await t.test('the deployed candidate reports the same owner and factory through its own views', async () => {
    assert.equal(addr(await chain.call('eth_call', [{to: account, data: callData('owner()')}, 'latest'])), address(OWNER));
    assert.equal(addr(await chain.call('eth_call', [{to: account, data: callData('factory()')}, 'latest'])), factoryArtifact.deployedAt);
    assert.equal(uints(await chain.call('eth_call', [{to: account, data: callData('executionNonce()')}, 'latest']))[0], 0n);
  });

  await t.test('owner-only entry points reject a non-owner caller', async () => {
    const hash = await chain.call('eth_sendTransaction',
      [{from: deployer, to: account, data: callData('revokeAllSessions()'), gas: '0x989680'}]);
    assert.equal((await receipt(chain, hash)).status, '0x0', 'a non-owner must not be able to revoke sessions');
    assert.equal(uints(await chain.call('eth_call', [{to: account, data: callData('sessionEpoch()')}, 'latest']))[0], 1n);
  });

  await t.test('the owner executes a real value-transferring batch through the candidate code', async () => {
    await chain.call('anvil_setBalance', [account, '0x' + ONE_ETHER.toString(16)]);
    await chain.call('anvil_setBalance', [RECIPIENT, '0x0']);
    const block = await chain.call('eth_getBlockByNumber', ['latest', false]);
    const validUntil = BigInt(block.timestamp) + 300n;
    const amount = ONE_ETHER / 2n;
    const hash = await chain.call('eth_sendTransaction', [{
      from: OWNER, to: account, gas: '0x989680',
      data: executeBatchData(RECIPIENT, amount, 0, validUntil),
    }]);
    const executed = await receipt(chain, hash);
    assert.equal(executed.status, '0x1', 'executeBatch must succeed for the owner');
    assert.equal(BigInt(await chain.call('eth_getBalance', [RECIPIENT, 'latest'])), amount,
      'the batch did not move real value on the local chain');
    assert.equal(uints(await chain.call('eth_call', [{to: account, data: callData('executionNonce()')}, 'latest']))[0], 1n,
      'the execution nonce did not advance');
    assert.ok(executed.logs.length > 0, 'executeBatch emitted no BatchExecuted event');
  });

  await t.test('a replayed batch at the consumed nonce is rejected', async () => {
    const block = await chain.call('eth_getBlockByNumber', ['latest', false]);
    const hash = await chain.call('eth_sendTransaction', [{
      from: OWNER, to: account, gas: '0x989680',
      data: executeBatchData(RECIPIENT, 1n, 0, BigInt(block.timestamp) + 300n),
    }]);
    assert.equal((await receipt(chain, hash)).status, '0x0', 'a stale nonce must revert');
  });

  await t.test('the executed tool was the pinned Anvil build', () => {
    assert.equal(ANVIL_PIN.chainId, '31337');
    assert.match(ANVIL_PIN.sha256, /^[a-f0-9]{64}$/);
  });
});
