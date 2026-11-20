const { test } = require('node:test');
const assert = require('node:assert/strict');
const energyTable = require('./energyTable');
const { SALVAGE_ENERGY, CLEAR_COST, WIN_ENERGY, addEnergy } = energyTable;
const { energyForWin, rollDrops } = require('./dropTable');
const save = require('./saveLayer');

const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));
const withEnergy = (state, energy) => save.grantDrops(state, { engravings: [], supportGems: [], energy });

// ── 數值 ──────────────────────────────────────────────────

test('salvage follows the 3-to-1 combine ratio, clearing costs two same-tier salvages, no cap (2026-11-20)', () => {
  assert.equal(energyTable.ENERGY_CAP, undefined);
  for (let t = 1; t < 5; t++) assert.equal(SALVAGE_ENERGY[t + 1], 3 * SALVAGE_ENERGY[t]);   // 先合成再分解不會多拿
  for (let t = 1; t <= 5; t++) assert.equal(CLEAR_COST[t], 2 * SALVAGE_ENERGY[t]);
  assert.deepEqual(addEnergy(480, 50), { energy: 530, gained: 50, wasted: 0 });
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

test('new saves start at 0 energy; v1 saves migrate up with 0 energy; bad energy is rejected', () => {
  assert.equal(fresh().energy, 0);
  const { energy, ...v1 } = { ...fresh(), version: 1 };
  const upgraded = save.importSave(JSON.stringify(v1));
  assert.equal(upgraded.version, save.SAVE_VERSION);
  assert.equal(upgraded.energy, 0);
  assert.deepEqual(save.validateSave({ ...fresh(), energy: 99999 }), []);   // 沒有上限
  for (const bad of [-1, 1.5, '3', undefined]) assert.ok(save.validateSave({ ...fresh(), energy: bad }).some(p => /energy/.test(p)), String(bad));
});

test('grantDrops adds the win energy (no cap)', () => {
  let state = withEnergy(fresh(), 40);
  assert.equal(state.energy, 40);
  state = withEnergy(state, 490);
  assert.equal(state.energy, 530);
  assert.throws(() => withEnergy(state, -1), /energy/);
  assert.throws(() => withEnergy(state, 1.5), /energy/);
});

test('salvaging engravings converts them into energy (no cap, nothing wasted)', () => {
  let state = save.addEngraving(save.addEngraving(fresh(), 'fury', 5, 7), 'vital', 2, 3);
  const a = save.salvageEngravings(state, 'vital', 2, 3);
  assert.deepEqual([a.gained, a.wasted, a.save.energy], [9, 0, 9]);
  assert.equal(a.save.engravings['vital@2'], undefined);
  const b = save.salvageEngravings(a.save, 'fury', 5, 7);                     // 9 + 567
  assert.deepEqual([b.gained, b.wasted, b.save.energy], [567, 0, 576]);
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

// ── 2026-11-20：黑骰重骰製作詞綴、轉移刻印 ──────────────────────
const { TRANSFER_ENERGY, CRAFT_REROLL_LOCK_ENERGY } = energyTable;
const craftOne = (state, slot = 'weapon', tier = 5, rng = () => 0.5) => {
  state = save.addEngraving(state, 'fury', tier, 10);
  const r = save.craftEquipment(state, slot, ten('fury', tier), rng);
  return { save: r.save, id: r.id };
};

test('黑骰重骰製作詞綴：1 顆黑骰；連種類重抽，或鎖定種類只重擲數值（另外花能量）；照製作時的刻印階級縮放', () => {
  assert.equal(TRANSFER_ENERGY, 500);
  assert.equal(CRAFT_REROLL_LOCK_ENERGY, 100);
  let { save: state, id } = craftOne(fresh());
  const original = state.equipment.find(i => i.id === id).affixes.find(a => a.source.startsWith('craft:'));
  assert.throws(() => save.rerollCraftAffix(state, id), /黑骰不足/);
  state = { ...state, blackDice: 3, energy: 150 };
  // 鎖定種類：只換數值，第 5 階滿值
  const locked = save.rerollCraftAffix(state, id, { lockKind: true }, () => 0.9999999);
  const [after] = locked.after;
  assert.equal(after.kind, original.kind);
  const { CRAFT_AFFIXES } = require('./craftTable');
  assert.ok(Math.abs(after.value - CRAFT_AFFIXES.find(a => a.kind === original.kind).max) < 1e-3);
  assert.deepEqual([locked.save.blackDice, locked.save.energy, locked.energyCost], [2, 50, 100]);
  assert.deepEqual(locked.before, [original]);
  // 連種類重抽：不花能量；r=0 抽到第一種
  const full = save.rerollCraftAffix(locked.save, id, {}, () => 0);
  assert.equal(full.after[0].kind, CRAFT_AFFIXES[0].kind);
  assert.equal(full.after[0].source, `craft:${CRAFT_AFFIXES[0].kind}`);
  assert.deepEqual([full.save.blackDice, full.save.energy], [1, 50]);
  assert.throws(() => save.rerollCraftAffix({ ...full.save, energy: 99 }, id, { lockKind: true }), /能量不足/);
  // 低階製作：滿值只到該階的縮放
  const low = craftOne(fresh(), 'weapon', 1);
  const lowRolled = save.rerollCraftAffix({ ...low.save, blackDice: 1 }, low.id, {}, () => 0.9999999).after[0];
  const { TIER_SCALE } = require('./affixTable');
  assert.ok(lowRolled.value <= CRAFT_AFFIXES.find(a => a.kind === lowRolled.kind).max * TIER_SCALE[1] + 1e-9);
  // 傳說裝備沒有製作詞綴
  const legend = save.addLegendary({ ...fresh(), blackDice: 1 }, 'omen', 15);
  assert.throws(() => save.rerollCraftAffix(legend.save, legend.id), /不是製作裝備/);
  assert.equal(state.blackDice, 3);                                           // 原存檔不變
  assert.deepEqual(save.validateSave(full.save), []);
});

test('轉移刻印：同部位、固定 500 能量、保留原本的數值；目標刻滿要指定清除哪一個（另外花清除費）；傳說裝備與不同部位不行', () => {
  let a = craftOne(fresh());
  let b = craftOne(a.save);
  let state = save.addEngraving(save.addEngraving(b.save, 'gale', 2, 3), 'fury', 5, 1);
  state = save.engraveEquipment(state, a.id, 'fury', 5, () => 0.3).save;
  state = save.engraveEquipment(state, a.id, 'gale', 2, () => 0.6).save;
  const lines = state.equipment.find(i => i.id === a.id).affixes.filter(x => x.source === 'engraving:fury@5');
  assert.throws(() => save.transferEngraving(state, a.id, 0, b.id), /能量不足：轉移要 500/);
  state = { ...state, energy: 1000 };
  const moved = save.transferEngraving(state, a.id, 0, b.id);
  assert.deepEqual([moved.moved, moved.replaced, moved.cost, moved.save.energy], ['fury@5', null, 500, 500]);
  assert.deepEqual(save.itemEngravings(moved.save.equipment.find(i => i.id === a.id)), ['gale@2']);
  const target = moved.save.equipment.find(i => i.id === b.id);
  assert.deepEqual(save.itemEngravings(target), ['fury@5']);
  assert.deepEqual(target.affixes.filter(x => x.source === 'engraving:fury@5'), lines);   // 數值不變
  // 目標刻滿
  let full = save.engraveEquipment(moved.save, b.id, 'gale', 2, () => 0.1).save;
  full = { ...full, energy: 1000 };
  assert.throws(() => save.transferEngraving(full, a.id, 0, b.id), /要指定清除哪一個/);
  const swap = save.transferEngraving(full, a.id, 0, b.id, { replaceIndex: 1 });
  assert.deepEqual([swap.moved, swap.replaced, swap.cost], ['gale@2', 'gale@2', 500 + CLEAR_COST[2]]);
  assert.deepEqual(save.itemEngravings(swap.save.equipment.find(i => i.id === b.id)), ['fury@5', 'gale@2']);
  assert.deepEqual(save.itemEngravings(swap.save.equipment.find(i => i.id === a.id)), []);
  // 不同部位、傳說、同一件
  const helm = craftOne(full, 'helmet');
  assert.throws(() => save.transferEngraving({ ...helm.save, energy: 1000 }, a.id, 0, helm.id), /相同部位/);
  const legend = save.addLegendary(full, 'omen', 15);
  assert.throws(() => save.transferEngraving(legend.save, a.id, 0, legend.id), /不能刻刻印/);
  assert.throws(() => save.transferEngraving(full, a.id, 0, a.id), /同一件/);
  assert.deepEqual(save.validateSave(swap.save), []);
});
