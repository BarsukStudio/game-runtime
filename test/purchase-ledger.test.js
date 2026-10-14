// Extracted from Muscle Clicker's scripts/purchase-ledger-test.mjs. Muscle
// Clicker 2 and Miner carry the same module and the same suite byte for byte, so
// there was no merge to do and no canonical copy to choose between.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  addPurchaseId,
  limitPurchaseIds,
  mergePurchaseIds,
  normalizePurchaseId,
  purchaseIdsContain,
} from '../src/purchase-ledger.js';

test('an id is a non-empty string and nothing else', () => {
  // Everything else is a corrupted save or an SDK answering with an object, and
  // counting it as a delivery would let the real transaction behind it be paid
  // twice.
  assert.equal(normalizePurchaseId('  GPA.1234  '), 'GPA.1234');
  assert.equal(normalizePurchaseId(''), '');
  assert.equal(normalizePurchaseId('   '), '');
  for (const value of [42, null, undefined, {}, [], true, { id: 'nope' }]) {
    assert.equal(normalizePurchaseId(value), '', `${JSON.stringify(value)} is not an id`);
  }
});

test('the merge is a union in delivery order and never trims', () => {
  // Each half of a journal may be kept to a different depth, so cutting here
  // would silently shorten the deeper one.
  assert.deepEqual(mergePurchaseIds(['a', 'b'], ['c']), ['a', 'b', 'c']);
  assert.deepEqual(mergePurchaseIds([' a ', 'b', 42, null, '', '  '], ['c']), ['a', 'b', 'c']);
  assert.deepEqual(mergePurchaseIds(), []);
  assert.deepEqual(mergePurchaseIds(undefined, null, 'not-an-array', ['a']), ['a']);

  const long = Array.from({ length: 5000 }, (unused, index) => `id-${index}`);
  assert.equal(mergePurchaseIds(long).length, 5000, 'the merge must not impose a limit of its own');
});

test('a repeated id keeps only its newest position', () => {
  // That is what makes the order a delivery order, and it is the reason trimming
  // can drop the head.
  assert.deepEqual(mergePurchaseIds(['a', 'b', 'c'], ['a']), ['b', 'c', 'a']);
  assert.deepEqual(mergePurchaseIds(['a', 'a', 'a']), ['a']);
  assert.deepEqual(mergePurchaseIds(['a', 'b'], [' a ']), ['b', 'a'], 'the same id spelled with spaces is the same id');
});

test('trimming keeps the newest ids and never loses the journal to a missing limit', () => {
  assert.deepEqual(limitPurchaseIds(['a', 'b', 'c'], 2), ['b', 'c']);
  assert.deepEqual(limitPurchaseIds(['a', 'b'], 5), ['a', 'b']);
  assert.deepEqual(limitPurchaseIds(['a', 'b'], 0), []);
  assert.deepEqual(limitPurchaseIds([], 3), []);
  // A caller that lost its limit must not silently lose the journal with it.
  assert.deepEqual(limitPurchaseIds(['a', 'b'], undefined), ['a', 'b']);
  assert.deepEqual(limitPurchaseIds(['a', 'b'], -1), ['a', 'b']);
  assert.deepEqual(limitPurchaseIds('not-an-array', 3), []);
  const source = ['a', 'b'];
  assert.notEqual(limitPurchaseIds(source, 5), source, 'the result must not alias the caller\'s array');
});

test('the replay guard is exact about what an id is', () => {
  // A false answer here pays a transaction twice, so it must be exact about what
  // an id is — and equally exact that a stored id with stray whitespace still
  // matches.
  assert.equal(purchaseIdsContain(['a', 'b'], 'b'), true);
  assert.equal(purchaseIdsContain(['a', 'b'], 'c'), false);
  assert.equal(purchaseIdsContain([' a '], 'a'), true);
  assert.equal(purchaseIdsContain(['a'], ' a '), true);
  assert.equal(purchaseIdsContain(['a'], ''), false);
  assert.equal(purchaseIdsContain(['a'], null), false);
  assert.equal(purchaseIdsContain(['a'], 42), false);
  assert.equal(purchaseIdsContain(null, 'a'), false);
  assert.equal(purchaseIdsContain([42, null, 'a'], 'a'), true, 'junk beside a real id must not hide it');
});

test('one delivery is recorded into one half at that half\'s own limit', () => {
  assert.deepEqual(addPurchaseId(['a', 'b'], 'c', 5), ['a', 'b', 'c']);
  assert.deepEqual(addPurchaseId(['a', 'b', 'c'], 'd', 2), ['c', 'd']);
  assert.deepEqual(addPurchaseId(['a', 'b'], 'a', 5), ['b', 'a'], 'a re-recorded id moves to the newest end');
  assert.deepEqual(addPurchaseId(['a'], '', 5), ['a'], 'nothing is recorded for a missing id');
  assert.deepEqual(addPurchaseId([], 'a', 5), ['a']);

  // Two halves of different depths, which is what the whole split exists for:
  // the shallow one forgets, the deep one still answers.
  const deep = Array.from({ length: 300 }, (unused, index) => `id-${index}`);
  const shallow = limitPurchaseIds(deep, 100);
  const union = mergePurchaseIds(deep, shallow);
  assert.equal(union.length, 300, 'reading both halves must not cut back to the shallow one');
  assert.equal(purchaseIdsContain(shallow, 'id-0'), false);
  assert.equal(purchaseIdsContain(union, 'id-0'), true);
});

test('the module reaches for nothing hard rule 1 forbids', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/purchase-ledger.js', import.meta.url)),
    'utf8',
  );
  for (const forbidden of [
    /\bimport\b/,
    /\bwindow\b/,
    /\bdocument\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bfetch\s*\(/,
    /\bDate\.now\b/,
    /\bsetTimeout\b/,
    /\bglobalThis\b/,
    /\bCapacitor\b/,
    /\bCdvPurchase\b/,
  ]) {
    assert.doesNotMatch(source, forbidden, `hard rule 1: ${forbidden}`);
  }
});
