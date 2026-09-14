import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '../server/storage';
import { MakerEngine } from '../server/engine';

const testRoot = path.resolve('work', 'storage-tests');
mkdirSync(testRoot, { recursive: true });
function directory() { return mkdtempSync(path.join(testRoot, 'case-')); }
function clean(dir: string) { assert.equal(path.dirname(path.resolve(dir)), testRoot); rmSync(dir, { recursive: true, force: true }); }

test('validated state persists with an atomic replacement and a last-good backup', () => {
  const dir = directory(); const store = new StateStore(dir);
  try {
    const engine = new MakerEngine(); store.save(engine.persist());
    engine.wallets.USDC = '9999.9'; store.save(engine.persist());
    assert.equal(store.read()?.wallets.USDC, '9999.9');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json.bak'), 'utf8')).wallets.USDC, '0');
  } finally { store.release(); clean(dir); }
});

test('a corrupt primary file recovers only from a validated backup', () => {
  const dir = directory(); const store = new StateStore(dir);
  try {
    const engine = new MakerEngine(); store.save(engine.persist()); store.save(engine.persist());
    writeFileSync(path.join(dir, 'state.json'), '{broken');
    const recovered = store.read(); assert.equal(recovered?.wallets.USDC, '0'); assert.equal(store.recovered, true);
  } finally { store.release(); clean(dir); }
});

test('unrecoverable data is never silently reset or overwritten', () => {
  const dir = directory(); const store = new StateStore(dir);
  try {
    writeFileSync(path.join(dir, 'state.json'), '{broken');
    assert.throws(() => store.read(), /停止启动/);
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), '{broken');
  } finally { store.release(); clean(dir); }
});

test('a second process writer cannot acquire the same data directory', () => {
  const dir = directory(); const store = new StateStore(dir);
  try { assert.throws(() => new StateStore(dir), /第二个写入/); }
  finally { store.release(); clean(dir); }
});
