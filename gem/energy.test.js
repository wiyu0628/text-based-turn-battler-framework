const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ENERGY_CAP, SALVAGE_ENERGY, CLEAR_COST, WIN_ENERGY, addEnergy } = require('./energyTable');
const { energyForWin, rollDrops } = require('./dropTable');
const save = require('./saveLayer');

const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));
const withEnergy = (state, energy) => save.grantDrops(state, { engravings: [], supportGems: [], energy });

// ── 數值 ──────────────────────────────────────────────────

test('salvage follows the 3-to-1 combine ratio, clearing costs two same-tier salvages, cap 500', () => {
  assert.equal(ENERGY_CAP, 500);
  for (let t = 1; t < 5; t++) assert.equal(SALVAGE_ENERGY[t + 1], 3 * SALVAGE_ENERGY[t]);   // 先合成再分解不會多拿
  for (let t = 1; t <= 5; t++) assert.equal(CLEAR_COST[t], 2 * SALVAGE_ENERGY[t]);
  assert.deepEqual(addEnergy(480, 50), { energy: 500, gained: 20, wasted: 30 });
  assert.deepEqual(addEnergy(10, 5), { energy: 15, gained: 5, wasted: 0 });
});

test('a win gives energy by the opened tier of the difficulty, without rolling', () => {
  assert.deepEqual([1, 2, 3, 6, 7, 9, 10, 12, 13, 15].map(energyForWin), [1, 1, 2, 2, 5, 5, 14, 14, 40, 40]);
  assert.deepEqual(Object.values(WIN_ENERGY), [1, 2, 5, 14, 40]);
  let calls = 0;
  const drops = rollDrops(15, () => { calls++; return 0.5; });
  assert.equal(drops.energy, 40);
  const before = calls;
  energyForWin(15);
  assert.equal(calls, before);
});

// ── 存檔 ──────────────────────────────────────────────────

test('new saves start at 0 energy; v1 saves migrate to v2 with 0 energy; bad energy is rejected', () => {
  assert.equal(save.SAVE_VERSION, 2);
  assert.equal(fresh().energy, 0);
  const { energy, ...v1 } = { ...fresh(), version: 1 };
  const upgraded = save.importSave(JSON.stringify(v1));
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.energy, 0);
  for (const bad of [-1, 501, 1.5, '3', undefined]) assert.ok(save.validateSave({ ...fresh(), energy: bad }).some(p => /energy/.test(p)), String(bad));
});

test('grantDrops adds the win energy and drops the overflow', () => {
  let state = withEnergy(fresh(), 40);
  assert.equal(state.energy, 40);
  state = withEnergy(state, 490);
  assert.equal(state.energy, 500);
  assert.throws(() => withEnergy(state, -1), /energy/);
  assert.throws(() => withEnergy(state, 1.5), /energy/);
});

test('salvaging engravings converts them into energy and reports the overflow', () => {
  let state = save.addEngraving(save.addEngraving(fresh(), 'fury', 5, 7), 'vital', 2, 3);
  const a = save.salvageEngravings(state, 'vital', 2, 3);
  assert.deepEqual([a.gained, a.wasted, a.save.energy], [9, 0, 9]);
  assert.equal(a.save.engravings['vital@2'], undefined);
  const b = save.salvageEngravings(a.save, 'fury', 5, 7);                     // 9 + 567 → 上限 500
  assert.deepEqual([b.gained, b.wasted, b.save.energy], [491, 76, 500]);
  assert.equal(state.energy, 0);                                              // 原存檔不變
  assert.throws(() => save.salvageEngravings(state, 'fury', 5, 8), /不夠/);
  assert.throws(() => save.salvageEngravings(state, 'fury', 5, 0), /數量/);
  assert.throws(() => save.salvageEngravings(state, 'fury', 9), save.SaveError);
});

test('clearing an engraving costs energy by its tier and fails without enough', () => {
  let state = save.addEngraving(fresh(), 'fury', 5, 11);
  state = save.addEngraving(state, 'gale', 2, 1);
  const crafted = save.craftEquipment(state, 'weapon', ten('fury'));
  let item = save.engraveEquipment(crafted.save, crafted.id, 'fury', 5).save;
  item = save.engraveEquipment(item, crafted.id, 'gale', 2).save;
  assert.throws(() => save.clearEngraving(item, crafted.id, 1), err => err instanceof save.SaveError && /能量不足/.test(err.message));
  const low = save.clearEngraving(withEnergy(item, 10), crafted.id, 1);     // 第 2 階：6
  assert.equal(low.cost, 6);
  assert.equal(low.save.energy, 4);
  assert.throws(() => save.clearEngraving(withEnergy(item, 161), crafted.id, 0), /能量不足：清除第 5 階刻印要 162，目前只有 161/);
  const high = save.clearEngraving(withEnergy(item, 162), crafted.id, 0);
  assert.deepEqual([high.cost, high.save.energy, high.removed], [162, 0, 'fury@5']);
});
