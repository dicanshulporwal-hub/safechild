import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PAIRING_CODE_ALPHABET,
  normalizePairingCode,
  formatPairingCode,
} from '../src/types';

describe('SafeBrowse Shared Pairing Code Helpers', () => {
  it('1. PAIRING_CODE_ALPHABET strictly excludes visually ambiguous characters', () => {
    assert.strictEqual(PAIRING_CODE_ALPHABET.length, 32);
    assert.ok(!PAIRING_CODE_ALPHABET.includes('0'), 'Excludes digit 0');
    assert.ok(!PAIRING_CODE_ALPHABET.includes('O'), 'Excludes letter O');
    assert.ok(!PAIRING_CODE_ALPHABET.includes('1'), 'Excludes digit 1');
    assert.ok(!PAIRING_CODE_ALPHABET.includes('I'), 'Excludes letter I');
  });

  it('2. normalizePairingCode normalizes canonical, hyphenated, prefixed, and lowercase codes', () => {
    assert.strictEqual(normalizePairingCode('K8X9M2W7'), 'K8X9M2W7');
    assert.strictEqual(normalizePairingCode('K8X9-M2W7'), 'K8X9M2W7');
    assert.strictEqual(normalizePairingCode('SB-K8X9-M2W7'), 'K8X9M2W7');
    assert.strictEqual(normalizePairingCode('sb-k8x9-m2w7'), 'K8X9M2W7');
    assert.strictEqual(normalizePairingCode('  k8x9 - m2w7  '), 'K8X9M2W7');
    assert.strictEqual(normalizePairingCode('SBK8X9M2W7'), 'K8X9M2W7');
    assert.strictEqual(normalizePairingCode(''), '');
    assert.strictEqual(normalizePairingCode(null as any), '');
  });

  it('3. formatPairingCode formats 8-character codes to 4-4 hyphenated display', () => {
    assert.strictEqual(formatPairingCode('K8X9M2W7'), 'K8X9-M2W7');
    assert.strictEqual(formatPairingCode('k8x9m2w7'), 'K8X9-M2W7');
    assert.strictEqual(formatPairingCode('SB-K8X9-M2W7'), 'K8X9-M2W7');
    assert.strictEqual(formatPairingCode('SHORT'), 'SHORT');
  });
});
