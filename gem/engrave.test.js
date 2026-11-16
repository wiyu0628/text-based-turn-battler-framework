const { test } = require('node:test');
const assert = require('node:assert/strict');
const save = require('./saveLayer');
const { rollEngraving } = require('./affixTable');

const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));
const scripted = (...values) => () => (values.length ? values.shift() : 1);

// 一件製作好的武器，背包另有 fury@5 ×3、vital@2 ×1
function crafted() {
  let state = save.addEngraving(fresh(), 'fury', 5, 13);
  state = save.addEngraving(state, 'vital', 2, 1);
  const result = save.craftEquipment(state, 'weapon', ten('fury'), () => 0);
  return { state: result.save, id: result.id };
}
const itemOf = (state, id) => state.equipment.find(e => e.id === id);

test('engraving consumes one engraving and appends its two rolled lines', () => {
  const { state, id } = crafted();
  const result = save.engraveEquipment(state, id, 'fury', 5, () => 1);   // 最後一行落選、滿骰
  assert.deepEqual(result.affixes, rollEngraving('fury', 5, () => 1));
  assert.equal(result.affixes.length, 2);
  assert.deepEqual(itemOf(result.save, id).affixes, [...itemOf(state, id).affixes, ...result.affixes]);   // 接在製作詞綴後面
  assert.deepEqual(result.save.engravings, { 'fury@5': 2, 'vital@2': 1 });
  assert.deepEqual(save.itemEngravings(itemOf(result.save, id)), ['fury@5']);
  assert.equal(itemOf(state, id).affixes.length, 1);                      // 原存檔不變（只有製作詞綴）
  assert.equal(state.engravings['fury@5'], 3);
});

test('two engravings per item, same kind allowed, different tiers allowed; a third is refused', () => {
  const { state, id } = crafted();
  let next = save.engraveEquipment(state, id, 'fury', 5).save;
  next = save.engraveEquipment(next, id, 'vital', 2).save;
  assert.deepEqual(save.itemEngravings(itemOf(next, id)), ['fury@5', 'vital@2']);
  assert.equal(itemOf(next, id).affixes.length, 5);   // 製作詞綴 1 + 刻印 4
  assert.throws(() => save.engraveEquipment(next, id, 'fury', 5), err => err instanceof save.SaveError && /已經有 2 個刻印/.test(err.message));
  // 同一種刻兩次
  const twice = save.engraveEquipment(save.engraveEquipment(state, id, 'fury', 5).save, id, 'fury', 5).save;
  assert.deepEqual(save.itemEngravings(itemOf(twice, id)), ['fury@5', 'fury@5']);
});

test('engraved effects reach the wearer: stat lines via equippedBonuses, effect lines via equippedEffects', () => {
  const { state, id } = crafted();
  // fury 第 3 行落選 → ATK inc 與物理傷害提高
  const next = save.equip(save.engraveEquipment(state, id, 'fury', 5, scripted(0.99, 1, 1)).save, id);
  assert.ok(save.equippedBonuses(next).some(b => b.stat === 'atk' && b.op === 'inc' && Math.abs(b.value - 0.17) < 1e-9));
  assert.ok(Math.abs(save.equippedEffects(next).physDmg - 0.12) < 1e-9);
});

test('engraving works on worn items with gems, and survives export / import', () => {
  let { state, id } = crafted();
  state = save.addGems(state, 'whirlwind', 1);
  state = save.equip(save.setLinks(state, id, [{ active: 'whirlwind', supports: [] }]), id);
  const next = save.engraveEquipment(state, id, 'fury', 5).save;
  assert.equal(next.equipped.weapon, id);
  assert.deepEqual(itemOf(next, id).links, itemOf(state, id).links);
  const back = save.importSave(save.exportSave(next));
  assert.deepEqual(save.itemEngravings(itemOf(back, id)), ['fury@5']);
});

test('refused without changing the save: missing engraving, unknown item or kind, legendary drop item', () => {
  const { state, id } = crafted();
  assert.throws(() => save.engraveEquipment(state, id, 'arcane', 5), err => err instanceof save.SaveError && /不夠/.test(err.message));
  assert.throws(() => save.engraveEquipment(state, 'eq999', 'fury', 5), /找不到裝備/);
  assert.throws(() => save.engraveEquipment(state, id, 'fury', 9), save.SaveError);
  const mystery = save.addEngraving(state, 'mystery', 1, 1);
  assert.throws(() => save.engraveEquipment(mystery, id, 'mystery', 1), err => err instanceof save.SaveError && /mystery/.test(err.message));
  const drop = save.addEquipment(state, { slot: 'helmet', origin: 'drop', base: [], affixes: [] });
  assert.throws(() => save.engraveEquipment(drop.save, drop.id, 'fury', 5), err => err instanceof save.SaveError && /傳說/.test(err.message));
  assert.deepEqual(state.engravings, { 'fury@5': 3, 'vital@2': 1 });
});

test('save validation rejects more than two engravings and engraving lines on drop items', () => {
  const lines = rollEngraving(['fury', 'fury'], 5, () => 1);
  assert.doesNotThrow(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'craft', base: [], affixes: lines }));
  assert.throws(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'craft', base: [], affixes: [...lines, ...rollEngraving('fury', 5, () => 1)] }), /最多只能有 2 個刻印/);
  assert.throws(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'drop', base: [], affixes: lines }), /不能有刻印詞綴/);
});
