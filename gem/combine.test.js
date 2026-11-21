const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rollCombine, ENGRAVING_TYPES, COMBINE_INPUTS, MAX_TIER } = require('./affixTable');
const save = require('./saveLayer');
const { createSeededRandom } = require('../src');

const TYPES = Object.keys(ENGRAVING_TYPES).filter(id => (ENGRAVING_TYPES[id].area ?? 1) === 1);   // 地區專屬的不會合成出來
const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
const noRng = () => { throw new Error('同種合成不該擲骰'); };

// ── 純函式：rollCombine ─────────────────────────────────────

test('three of the same kind give the same kind one tier higher without rolling', () => {
  assert.equal(COMBINE_INPUTS, 3);
  for (let tier = 1; tier < MAX_TIER; tier++) {
    assert.deepEqual(rollCombine(['fury', 'fury', 'fury'], tier, noRng), { type: 'fury', tier: tier + 1, mode: 'same' });
  }
});

test('anything but three of a kind is mixed and draws uniformly from all kinds, inputs included', () => {
  assert.equal(rollCombine(['fury', 'fury', 'arcane'], 2, () => 0).mode, 'mixed');
  assert.equal(rollCombine(['fury', 'fury', 'arcane'], 2, () => 0).tier, 3);
  // r 對應 pool[floor(r × 7)]，每個種類都抽得到（包含投入的猛攻）
  TYPES.forEach((type, i) => assert.equal(rollCombine(['fury', 'arcane', 'gale'], 1, () => (i + 0.5) / TYPES.length).type, type));
  assert.equal(rollCombine(['fury', 'fury', 'arcane'], 1, () => 1).type, TYPES.at(-1));   // 超出範圍夾到最後一個
});

test('mixed combine rolls exactly once and is roughly uniform', () => {
  let calls = 0;
  rollCombine(['fury', 'vital', 'gale'], 3, () => { calls++; return 0.4; });
  assert.equal(calls, 1);
  const rng = createSeededRandom(12345);
  const counts = Object.fromEntries(TYPES.map(type => [type, 0]));
  const n = 70000;
  for (let i = 0; i < n; i++) counts[rollCombine(['fury', 'fury', 'arcane'], 1, rng).type]++;
  for (const type of TYPES) assert.ok(Math.abs(counts[type] / n - 1 / TYPES.length) < 0.01, `${type} ${counts[type]}`);
});

test('area-exclusive kinds never come out of a mixed combine, but three of them still combine up', () => {
  assert.ok(!TYPES.includes('resound'));
  for (let i = 0; i < 50; i++) assert.notEqual(rollCombine(['resound', 'fury', 'gale'], 1, () => i / 50).type, 'resound');
  assert.deepEqual(rollCombine(['resound', 'resound', 'resound'], 2, noRng), { type: 'resound', tier: 3, mode: 'same' });
});

test('a custom pool limits the mixed draw (for future slot-only engravings)', () => {
  assert.equal(rollCombine(['fury', 'vital', 'gale'], 1, () => 0.99, ['precise', 'endure']).type, 'endure');
  assert.throws(() => rollCombine(['fury', 'vital', 'gale'], 1, () => 0, []), /抽取池/);
  assert.throws(() => rollCombine(['fury', 'vital', 'gale'], 1, () => 0, ['nope']), /nope/);
});

test('bad combine input is rejected', () => {
  assert.throws(() => rollCombine(['fury', 'fury', 'fury'], 5), /最高階/);
  assert.throws(() => rollCombine(['fury', 'fury'], 1), /3 顆/);
  assert.throws(() => rollCombine(['fury', 'fury', 'fury', 'fury'], 1), /3 顆/);
  assert.throws(() => rollCombine(['fury', 'fury', 'nope'], 1), /nope/);
  assert.throws(() => rollCombine(['fury', 'fury', 'fury'], 0), /階級/);
});

// ── 存檔層：combineEngravings ──────────────────────────────

test('same-kind combine consumes three and adds one higher-tier engraving', () => {
  const start = save.addEngraving(fresh(), 'fury', 2, 4);
  const result = save.combineEngravings(start, ['fury', 'fury', 'fury'], 2, noRng);
  assert.deepEqual(result.save.engravings, { 'fury@2': 1, 'fury@3': 1 });
  assert.deepEqual({ type: result.type, tier: result.tier, mode: result.mode }, { type: 'fury', tier: 3, mode: 'same' });
  assert.deepEqual(start.engravings, { 'fury@2': 4 });   // 原存檔不變
});

test('mixed combine consumes each input kind and empties stacks that reach zero', () => {
  let state = save.addEngraving(fresh(), 'fury', 1, 2);
  state = save.addEngraving(state, 'arcane', 1, 1);
  const result = save.combineEngravings(state, ['fury', 'arcane', 'fury'], 1, () => 0);
  assert.deepEqual(result.save.engravings, { [`${TYPES[0]}@2`]: 1 });
  assert.equal(result.mode, 'mixed');
});

test('combine fails without changing the save when the bag is short, tier is max, or kind is unknown', () => {
  const state = save.addEngraving(save.addEngraving(fresh(), 'fury', 1, 2), 'fury', 5, 3);
  assert.throws(() => save.combineEngravings(state, ['fury', 'fury', 'fury'], 1), err => err instanceof save.SaveError && /不夠/.test(err.message));
  assert.throws(() => save.combineEngravings(state, ['fury', 'fury', 'fury'], 5), err => err instanceof save.SaveError && /最高階/.test(err.message));
  const unknown = save.addEngraving(fresh(), 'mystery', 1, 3);
  assert.throws(() => save.combineEngravings(unknown, ['mystery', 'mystery', 'mystery'], 1), err => err instanceof save.SaveError && /mystery/.test(err.message));
  assert.throws(() => save.combineEngravings(state, 'fury', 1), save.SaveError);
  assert.deepEqual(state.engravings, { 'fury@1': 2, 'fury@5': 3 });
});

test('批量合成（2026-11-20）：同種全部合成，每 3 顆換 1 顆高一階，湊不滿的留著', () => {
  const save = require('./saveLayer');
  let state = save.addEngraving(save.addEngraving(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), 'fury', 1, 14), 'fury', 2, 1);
  const r = save.combineAllEngravings(state, 'fury', 1);
  assert.deepEqual([r.type, r.tier, r.made, r.used, r.left], ['fury', 2, 4, 12, 2]);
  assert.equal(r.save.engravings['fury@1'], 2);
  assert.equal(r.save.engravings['fury@2'], 5);                               // 原本 1 顆 + 4 顆
  assert.equal(state.engravings['fury@1'], 14);                              // 原存檔不變
  const exact = save.combineAllEngravings(save.addEngraving(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), 'vital', 3, 6), 'vital', 3);
  assert.equal(exact.save.engravings['vital@3'], undefined);
  assert.equal(exact.save.engravings['vital@4'], 2);
  assert.throws(() => save.combineAllEngravings(r.save, 'fury', 1), /不到 3 顆/);
  assert.throws(() => save.combineAllEngravings(save.addEngraving(state, 'fury', 5, 9), 'fury', 5), save.SaveError);
  assert.throws(() => save.combineAllEngravings(state, 'nope', 1), save.SaveError);
  assert.deepEqual(save.validateSave(r.save), []);
});
