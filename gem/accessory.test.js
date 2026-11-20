'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const save = require('./saveLayer');
const { ACCESSORIES, STARTING_ACCESSORIES, accessoryAffixes } = require('./accessoryTable');
const { BOSSES } = require('./bosses');
const { applyStatBonuses } = require('./statLayer');

const NOW = '2026-11-20T00:00:00Z';

test('飾品表：「靈式」的碎片（技能施放率 +5%、SP +40）開局就有；「烈風爪痕」的碎片（異常持續時間 +1）是守門者首次擊敗的獎勵', () => {
  assert.deepEqual(STARTING_ACCESSORIES, ['focus']);
  assert.equal(ACCESSORIES.focus.name, '「靈式」的碎片');
  assert.equal(ACCESSORIES.hourglass.name, '「烈風爪痕」的碎片');
  assert.equal(require('./accessoryTable').ACCESSORY_LABEL, '「世界」的碎片');
  assert.deepEqual(ACCESSORIES.focus.affixes, [
    { scope: 'wearer', stat: 'skillCastRate', op: 'flat', value: 0.05 },
    { scope: 'wearer', stat: 'sp', op: 'flat', value: 40 }
  ]);
  assert.deepEqual(ACCESSORIES.hourglass.affixes, [{ scope: 'effect', kind: 'ailmentDuration', value: 1 }]);
  assert.deepEqual(BOSSES.find(b => b.id === 'gatekeeper').rewards.accessories, ['hourglass']);
  assert.deepEqual(accessoryAffixes('hourglass'), [{ scope: 'effect', kind: 'ailmentDuration', value: 1, source: 'accessory:hourglass' }]);
  assert.deepEqual(accessoryAffixes(null), []);
});

test('新存檔：空存檔沒有飾品；開局存檔擁有並穿著focus', () => {
  assert.deepEqual(save.createEmptySave({ now: NOW }).accessories, { owned: [], equipped: null });
  const starter = save.createStarterSave({ now: NOW });
  assert.deepEqual(starter.accessories, { owned: ['focus'], equipped: 'focus' });
  assert.deepEqual(save.validateSave(starter), []);
});

test('穿著的飾品：屬性進 equippedBonuses、效果進 equippedEffects；脫下就沒有', () => {
  let state = save.addAccessory(save.createStarterSave({ now: NOW }), 'hourglass');
  const base = { hp: 3000, sp: 240, skillCastRate: 0.35 };
  const stats = applyStatBonuses(base, save.equippedBonuses(state));
  assert.equal(stats.sp, 280);
  assert.ok(Math.abs(stats.skillCastRate - 0.4) < 1e-9);
  assert.equal(save.equippedEffects(state).ailmentDuration, 0);
  state = save.equipAccessory(state, 'hourglass');                 // 只有一個欄位：換掉focus
  assert.equal(state.accessories.equipped, 'hourglass');
  assert.equal(save.equippedEffects(state).ailmentDuration, 1);
  assert.equal(applyStatBonuses(base, save.equippedBonuses(state)).sp, 240);
  const compiled = save.compileEquipped(state);
  assert.ok(compiled);
  state = save.equipAccessory(state, null);
  assert.equal(save.equippedEffects(state).ailmentDuration, 0);
  assert.deepEqual(save.validateSave(state), []);
});

test('飾品：沒擁有的不能穿；不存在的不能給；重複給不會變兩個', () => {
  const starter = save.createStarterSave({ now: NOW });
  assert.throws(() => save.equipAccessory(starter, 'hourglass'), /還沒有「烈風爪痕」的碎片/);
  assert.throws(() => save.addAccessory(starter, 'nope'), /不存在/);
  assert.deepEqual(save.addAccessory(save.addAccessory(starter, 'hourglass'), 'hourglass').accessories.owned, ['focus', 'hourglass']);
  assert.deepEqual(starter.accessories.owned, ['focus']);           // 原存檔不變
});

test('存檔驗證：飾品欄位錯誤會列出來', () => {
  const broken = save.createStarterSave({ now: NOW });
  broken.accessories = { owned: ['focus', 'nope', 'focus'], equipped: 'hourglass' };
  const problems = save.validateSave(broken).join('\n');
  assert.match(problems, /不存在的飾品「nope」/);
  assert.match(problems, /重複/);
  assert.match(problems, /不是擁有的飾品/);
  const missing = save.createStarterSave({ now: NOW });
  delete missing.accessories;
  assert.match(save.validateSave(missing).join('\n'), /accessories 必須是物件/);
});

test('首次打贏守門者發hourglass；再打贏不重複發', () => {
  const first = save.recordBossVictory(save.createStarterSave({ now: NOW }), 'gatekeeper');
  assert.deepEqual(first.rewards.accessories, ['hourglass']);
  assert.deepEqual(first.save.accessories.owned, ['focus', 'hourglass']);
  assert.equal(first.save.accessories.equipped, 'focus');            // 不自動換上
  const again = save.recordBossVictory(first.save, 'gatekeeper');
  assert.deepEqual(again.rewards.accessories, []);
  assert.deepEqual(again.save.accessories.owned, ['focus', 'hourglass']);
});

test('遷移 v6 → v7：給focus並穿上，打贏過守門者的補發hourglass；舊的異常持續時間製作詞綴改擲成目前的種類（結果固定）', () => {
  let state = save.addEngraving(save.createEmptySave({ now: NOW }), 'fury', 5, 20);
  const ten = Array.from({ length: 10 }, () => ({ type: 'fury', tier: 5 }));
  const a = save.craftEquipment(state, 'weapon', ten, () => 0.5); state = a.save;
  const b = save.craftEquipment(state, 'armor', ten, () => 0.1); state = b.save;
  const v6 = structuredClone(state);
  v6.version = 6;
  delete v6.accessories;
  v6.equipment[0].affixes = [{ scope: 'effect', kind: 'ailmentDuration', value: 1, source: 'craft:ailmentDuration' }];
  const keep = structuredClone(v6.equipment[1].affixes);
  v6.progress.defeatedBosses = ['gatekeeper'];
  const upgraded = save.importSave(JSON.stringify(v6));
  assert.equal(upgraded.version, save.SAVE_VERSION);
  assert.deepEqual(upgraded.accessories, { owned: ['focus', 'hourglass'], equipped: 'focus' });
  const [rerolled] = upgraded.equipment[0].affixes;
  assert.ok(['ailmentDmg', 'reduction', 'spRegen'].includes(rerolled.kind));
  assert.equal(rerolled.source, `craft:${rerolled.kind}`);
  assert.ok(rerolled.value > 0);
  assert.deepEqual(upgraded.equipment[1].affixes, keep);              // 其他詞綴不動
  assert.deepEqual(save.importSave(JSON.stringify(v6)).equipment[0].affixes, upgraded.equipment[0].affixes);   // 同一份存檔結果固定
  assert.equal(v6.equipment[0].affixes[0].kind, 'ailmentDuration');   // 不改傳入的物件
  const notCleared = { ...v6, progress: { ...v6.progress, defeatedBosses: [] } };
  assert.deepEqual(save.migrateSave(notCleared).accessories, { owned: ['focus'], equipped: 'focus' });
});
