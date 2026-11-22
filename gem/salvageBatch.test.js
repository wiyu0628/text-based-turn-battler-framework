const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SALVAGE_RETURN } = require('./craftTable');
const save = require('./saveLayer');

// 批量分解（2026-11-22 使用者）：分解模式勾選多件，一次確認

const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));

function setup() {
  let state = save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 5, 20);
  const a = save.craftEquipment(state, 'weapon', ten('fury'));
  const b = save.craftEquipment(a.save, 'helmet', ten('fury'));
  const legend = save.addLegendary(b.save, 'omen', 15);
  state = save.addGems(legend.save, 'whirlwind', 1);
  state = save.equip(save.setLinks(state, a.id, [{ active: 'whirlwind', supports: [] }]), a.id);
  return { state, ids: [a.id, b.id, legend.id], craftIds: [a.id, b.id], legendId: legend.id };
}

test('salvagePreview counts engravings (no tiers) and black dice', () => {
  const { state, ids, craftIds, legendId } = setup();
  assert.deepEqual(save.salvagePreview(state, ids), { count: 3, engravings: 2 * SALVAGE_RETURN, blackDice: save.BLACK_DICE_PER_SALVAGE });
  assert.deepEqual(save.salvagePreview(state, craftIds), { count: 2, engravings: 2 * SALVAGE_RETURN, blackDice: 0 });
  assert.deepEqual(save.salvagePreview(state, [legendId, legendId]), { count: 1, engravings: 0, blackDice: 1 });   // 重複只算一次
  assert.deepEqual(save.salvagePreview(state, []), { count: 0, engravings: 0, blackDice: 0 });
});

test('salvageEquipmentBatch removes every selected item and grants the totals', () => {
  const { state, ids } = setup();
  const result = save.salvageEquipmentBatch(state, ids, () => 0);
  assert.equal(result.count, 3);
  assert.equal(result.returned.length, 2 * SALVAGE_RETURN);
  assert.equal(result.blackDice, 1);
  assert.equal(result.save.equipment.length, 0);
  assert.equal(result.save.blackDice, state.blackDice + 1);
  assert.equal(result.save.engravings['fury@5'], (state.engravings['fury@5'] ?? 0) + 2 * SALVAGE_RETURN);
  assert.equal(result.save.gems.whirlwind, 1);          // 鑲著的寶石退回
  assert.equal(result.save.equipped.weapon, null);      // 穿著的脫下
  assert.equal(state.equipment.length, 3);              // 原存檔不變
  assert.deepEqual(save.validateSave(result.save), []);
});

test('salvageEquipmentBatch is all-or-nothing', () => {
  const { state, ids } = setup();
  const starter = save.addEquipment(state, { slot: 'weapon', origin: 'craft', base: [], affixes: [] });   // 沒有 materials：不能分解
  assert.throws(() => save.salvageEquipmentBatch(starter.save, [...ids, starter.id]), /不能分解/);
  assert.throws(() => save.salvageEquipmentBatch(state, [...ids, 'nope']), /找不到/);
  assert.throws(() => save.salvageEquipmentBatch(state, []), /沒有選擇/);
  assert.equal(save.canSalvage(starter.save.equipment.find(e => e.id === starter.id)), false);
  assert.equal(save.canSalvage(state.equipment.find(e => e.id === ids[2])), true);
});
