const { test } = require('node:test');
const assert = require('node:assert/strict');
const save = require('./saveLayer');
const { rollEngraving } = require('./affixTable');

const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));
const scripted = (...values) => () => (values.length ? values.shift() : 1);

// 一件製作好的武器，背包另有 fury@5 ×3、gale@2 ×1
function crafted() {
  let state = save.addEngraving(fresh(), 'fury', 5, 13);
  state = save.addEngraving(state, 'gale', 2, 1);
  const result = save.craftEquipment(state, 'weapon', ten('fury'), () => 0);
  // 清除刻印要能量：先給滿（勝利掉落的 energy 欄位）
  return { state: save.grantDrops(result.save, { engravings: [], supportGems: [], energy: 500 }), id: result.id };
}
const itemOf = (state, id) => state.equipment.find(e => e.id === id);

test('engraving consumes one engraving and appends its two rolled lines', () => {
  const { state, id } = crafted();
  const result = save.engraveEquipment(state, id, 'fury', 5, () => 1);   // 最後一行落選、滿骰
  assert.deepEqual(result.affixes, rollEngraving('fury', 5, () => 1));
  assert.equal(result.affixes.length, 2);
  assert.deepEqual(itemOf(result.save, id).affixes, [...itemOf(state, id).affixes, ...result.affixes]);   // 接在製作詞綴後面
  assert.deepEqual(result.save.engravings, { 'fury@5': 2, 'gale@2': 1 });
  assert.deepEqual(save.itemEngravings(itemOf(result.save, id)), ['fury@5']);
  assert.equal(itemOf(state, id).affixes.length, 1);                      // 原存檔不變（只有製作詞綴）
  assert.equal(state.engravings['fury@5'], 3);
});

test('two engravings per item, same kind allowed, different tiers allowed; a third is refused', () => {
  const { state, id } = crafted();
  let next = save.engraveEquipment(state, id, 'fury', 5).save;
  next = save.engraveEquipment(next, id, 'gale', 2).save;
  assert.deepEqual(save.itemEngravings(itemOf(next, id)), ['fury@5', 'gale@2']);
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
  assert.deepEqual(state.engravings, { 'fury@5': 3, 'gale@2': 1 });
});

test('save validation rejects more than two engravings and engraving lines on drop items', () => {
  const lines = rollEngraving(['fury', 'fury'], 5, () => 1);
  assert.doesNotThrow(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'craft', base: [], affixes: lines }));
  assert.throws(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'craft', base: [], affixes: [...lines, ...rollEngraving('fury', 5, () => 1)] }), /最多只能有 2 個刻印/);
  assert.throws(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'drop', base: [], affixes: lines }), /不能有刻印詞綴/);
});

// ── 清除刻印 ──────────────────────────────────────────────

test('clearing removes that engraving\u2019s two lines, frees the slot, keeps the other engraving and the craft affix', () => {
  const { state, id } = crafted();
  let next = save.engraveEquipment(state, id, 'fury', 5, () => 1).save;
  next = save.engraveEquipment(next, id, 'gale', 2, () => 1).save;
  const before = itemOf(next, id).affixes;
  const result = save.clearEngraving(next, id, 0);
  assert.equal(result.removed, 'fury@5');
  assert.deepEqual(result.affixes, before.slice(1, 3));                  // 製作詞綴在最前面，接著是猛攻的 2 行
  assert.deepEqual(itemOf(result.save, id).affixes, [before[0], ...before.slice(3)]);
  assert.deepEqual(save.itemEngravings(itemOf(result.save, id)), ['gale@2']);
  assert.deepEqual(result.save.engravings, next.engravings);            // 不退回背包
  assert.equal(itemOf(next, id).affixes.length, 5);                     // 原存檔不變
  // 空出的位置可以再刻，新刻的排在後面
  const again = save.engraveEquipment(result.save, id, 'fury', 5).save;
  assert.deepEqual(save.itemEngravings(itemOf(again, id)), ['gale@2', 'fury@5']);
});

test('clearing the second engraving, or the only one, works the same', () => {
  const { state, id } = crafted();
  const one = save.engraveEquipment(state, id, 'fury', 5).save;
  const cleared = save.clearEngraving(one, id, 0).save;
  assert.deepEqual(save.itemEngravings(itemOf(cleared, id)), []);
  assert.equal(itemOf(cleared, id).affixes.length, 1);                  // 只剩製作詞綴
  const two = save.engraveEquipment(save.engraveEquipment(state, id, 'fury', 5).save, id, 'gale', 2).save;
  assert.deepEqual(save.itemEngravings(itemOf(save.clearEngraving(two, id, 1).save, id)), ['fury@5']);
});

test('clearing works on worn items and the effect disappears from the wearer', () => {
  const { state, id } = crafted();
  let worn = save.equip(save.engraveEquipment(state, id, 'fury', 5, scripted(0.99, 1, 1)).save, id);
  assert.ok(save.equippedBonuses(worn).some(b => b.op === 'inc' && b.stat === 'atk'));
  worn = save.clearEngraving(worn, id, 0).save;
  assert.equal(worn.equipped.weapon, id);
  assert.ok(!save.equippedBonuses(worn).some(b => b.op === 'inc' && b.stat === 'atk'));
  assert.equal(save.equippedEffects(worn).physDmg, 0);
});

test('clearing is refused without changing the save: no engraving, bad index, unknown item, legendary', () => {
  const { state, id } = crafted();
  assert.throws(() => save.clearEngraving(state, id, 0), err => err instanceof save.SaveError && /沒有刻印/.test(err.message));
  const one = save.engraveEquipment(state, id, 'fury', 5).save;
  for (const bad of [1, -1, 0.5, '0', undefined]) assert.throws(() => save.clearEngraving(one, id, bad), save.SaveError);
  assert.throws(() => save.clearEngraving(one, 'eq999', 0), /找不到裝備/);
  const legend = save.addLegendary(state, 'omen', 15);
  assert.throws(() => save.clearEngraving(legend.save, legend.id, 0), /沒有刻印/);
  assert.equal(itemOf(one, id).affixes.length, 3);
});

// ── 部位限制 ──────────────────────────────────────────────

test('engravings can only go on their allowed slots; crafting inputs are not restricted', () => {
  const { ENGRAVING_SLOTS, canEngrave } = require('./affixTable');
  assert.deepEqual(ENGRAVING_SLOTS.deft, ['helmet', 'boots']);              // 閃避只在頭盔與鞋子
  assert.ok(canEngrave('fury', 'weapon') && !canEngrave('fury', 'boots'));
  assert.ok(!canEngrave('nope', 'weapon'));
  const { state, id } = crafted();
  const withDeft = save.addEngraving(state, 'deft', 5, 1);
  assert.throws(() => save.engraveEquipment(withDeft, id, 'deft', 5), err => err instanceof save.SaveError && /「靈巧」刻印不能刻在武器上/.test(err.message));
  assert.equal(withDeft.engravings['deft@5'], 1);                          // 失敗不扣刻印
  // 鞋子可以刻靈巧；製作鞋子時投入猛攻（不能刻在鞋子上）也沒問題
  let boots = save.addEngraving(save.addEngraving(fresh(), 'fury', 5, 10), 'deft', 5, 1);
  const made = save.craftEquipment(boots, 'boots', Array.from({ length: 10 }, () => ({ type: 'fury', tier: 5 })));
  boots = save.engraveEquipment(made.save, made.id, 'deft', 5).save;
  assert.deepEqual(save.itemEngravings(itemOf(boots, made.id)), ['deft@5']);
  // 讀檔不檢查部位（之後改表，舊存檔照樣能讀）
  const lines = rollEngraving(['deft', 'deft'], 5, () => 1);
  assert.doesNotThrow(() => save.addEquipment(fresh(), { slot: 'weapon', origin: 'craft', base: [], affixes: lines }));
});

test('every slot has some engravings and every set in affix-budget is legal', () => {
  const { ENGRAVING_SLOTS, canEngrave } = require('./affixTable');
  for (const slot of ['weapon', 'helmet', 'armor', 'boots']) assert.ok(Object.values(ENGRAVING_SLOTS).filter(s => s.includes(slot)).length >= 4, slot);
  const { SETS } = require('./affix-budget');
  for (const [name, { engr }] of Object.entries(SETS)) {
    for (const [slot, types] of Object.entries(engr)) for (const type of types) assert.ok(canEngrave(type, slot), `${name}: ${type} @ ${slot}`);
  }
});
