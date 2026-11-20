const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CRAFT_INPUTS, CRAFT_AFFIX_SLOTS, SALVAGE_RETURN, CRAFT_AFFIXES, STAT_UNIT, KIND_SHARES, SLOT_MULT, QUALITIES, WEIGHT, rawBase, rollQuality, rollCraft } = require('./craftTable');
const { ENGRAVING_TYPES, TIER_SCALE } = require('./affixTable');
const save = require('./saveLayer');
const { createSeededRandom } = require('../src');

const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));
const scripted = (...values) => () => (values.length ? values.shift() : 0.999);
const valueOf = (base, stat) => base.find(b => b.stat === stat)?.value ?? 0;

// ── 資料表 ────────────────────────────────────────────────

test('every engraving kind has shares summing to 1, with its lean above every other stat', () => {
  assert.equal(CRAFT_INPUTS, 10);
  for (const type of Object.keys(ENGRAVING_TYPES)) {
    const shares = KIND_SHARES[type];
    assert.ok(shares, type);
    assert.ok(Math.abs(Object.values(shares).reduce((a, b) => a + b, 0) - 1) < 1e-9, type);
    for (const stat of Object.keys(shares)) assert.ok(stat in STAT_UNIT, `${type}.${stat}`);
  }
  // 猛攻也給 HP，但比堅韌、持久少
  assert.ok(KIND_SHARES.fury.hp > 0 && KIND_SHARES.fury.hp < KIND_SHARES.vital.hp && KIND_SHARES.fury.hp < KIND_SHARES.endure.hp);
});

test('qualities are 1 / 1.15 / 1.3 / 1.4 / 1.5 at 45 / 30 / 15 / 8 / 2 %', () => {
  assert.deepEqual(QUALITIES.map(q => q.mult), [1, 1.15, 1.3, 1.4, 1.5]);
  assert.deepEqual(QUALITIES.map(q => q.chance), [0.45, 0.30, 0.15, 0.08, 0.02]);
  assert.equal(rollQuality(0).id, 'inferior');
  assert.equal(rollQuality(0.449).id, 'inferior');
  assert.equal(rollQuality(0.45).id, 'common');
  assert.equal(rollQuality(0.9799).id, 'fine');
  assert.equal(rollQuality(0.999).id, 'supreme');
  assert.equal(rollQuality(1).id, 'supreme');
});

test('quality distribution matches the table and ignores engraving tier', () => {
  const rng = createSeededRandom(3);
  for (const tier of [1, 5]) {
    const counts = Object.fromEntries(QUALITIES.map(q => [q.id, 0]));
    const n = 20000;
    for (let i = 0; i < n; i++) counts[rollCraft('weapon', ten('fury', tier), rng).quality]++;
    for (const q of QUALITIES) assert.ok(Math.abs(counts[q.id] / n - q.chance) < 0.012, `tier ${tier} ${q.id}`);
  }
});

// ── 基礎數值 ──────────────────────────────────────────────

test('base = Σ engraving values × quality × slot multiplier, rounded, zeroes dropped', () => {
  // rng 0 → 次等 ×1；權重骰 0 → 70
  const { base, castWeight, quality, affixes } = rollCraft('weapon', ten('fury'), scripted(0, 0));
  assert.equal(quality, 'inferior');
  assert.equal(valueOf(base, 'atk'), Math.round(10 * STAT_UNIT.atk * 0.6 * SLOT_MULT.weapon.atk));
  assert.equal(valueOf(base, 'hp'), Math.round(10 * STAT_UNIT.hp * 0.25 * SLOT_MULT.weapon.hp));
  assert.ok(!base.some(b => b.stat === 'int' || b.value === 0));
  assert.ok(base.every(b => b.op === 'flat' && Number.isInteger(b.value)));
  assert.equal(castWeight, 60);
  assert.equal(affixes.length, 1);   // 製作詞綴 1 條（見下面的測試）
  // 頂級 ×1.5
  const top = rollCraft('weapon', ten('fury'), scripted(0.99, 0));
  assert.equal(valueOf(top.base, 'atk'), Math.round(10 * STAT_UNIT.atk * 0.6 * 1.5));
});

test('tier scales the base; kinds and tiers can be mixed', () => {
  const t1 = rawBase(ten('fury', 1)).atk, t5 = rawBase(ten('fury', 5)).atk;
  assert.ok(Math.abs(t1 / t5 - TIER_SCALE[1]) < 1e-9);
  const mixed = [...ten('fury', 5).slice(0, 5), ...ten('vital', 2).slice(0, 5)];
  const raw = rawBase(mixed);
  assert.ok(Math.abs(raw.atk - 5 * STAT_UNIT.atk * 0.6) < 1e-9);
  assert.ok(Math.abs(raw.hp - (5 * STAT_UNIT.hp * 0.25 + 5 * STAT_UNIT.hp * 0.6 * TIER_SCALE[2])) < 1e-9);
});

test('slot multipliers lean: weapon gives the most atk, armor the most hp, boots the most spd', () => {
  const q = scripted;
  const atk = slot => valueOf(rollCraft(slot, ten('fury'), q(0, 0)).base, 'atk');
  const hp = slot => valueOf(rollCraft(slot, ten('vital'), q(0, 0)).base, 'hp');
  const spd = slot => valueOf(rollCraft(slot, ten('gale'), q(0, 0)).base, 'spd');
  assert.ok(atk('weapon') > atk('armor') && atk('armor') > atk('helmet'));
  assert.ok(hp('armor') > hp('helmet') && hp('helmet') > hp('weapon'));
  assert.ok(spd('boots') > spd('weapon'));
});

// ── 製作詞綴 ──────────────────────────────────────────────

test('one craft affix: ailment damage, max 25% × average tier scale × 0.7~1 roll, quality ignored', () => {
  // rng 順序：品質、權重、詞綴種類、詞綴數值
  const [low] = rollCraft('weapon', ten('fury'), scripted(0, 0, 0, 0)).affixes;
  assert.deepEqual(low, { scope: 'effect', kind: 'ailmentDmg', value: 0.175, source: 'craft:ailmentDmg' });   // 0.25 × 1 × 0.7
  const [high] = rollCraft('weapon', ten('fury'), scripted(0.99, 0, 0, 0.9999999)).affixes;
  assert.equal(high.value, 0.25);                                                                      // 頂級品質也不會更高
  const mixed = [...ten('fury', 5).slice(0, 5), ...ten('fury', 1).slice(0, 5)];                      // 平均縮放 (第 5 階 + 第 1 階) / 2
  assert.equal(rollCraft('weapon', mixed, scripted(0, 0, 0, 0.9999999)).affixes[0].value, Math.round(0.25 * (TIER_SCALE[5] + TIER_SCALE[1]) / 2 * 10000) / 10000);
  assert.equal(CRAFT_AFFIX_SLOTS, 1);
  assert.deepEqual(CRAFT_AFFIXES.map(a => a.kind), ['ailmentDmg', 'reduction', 'spRegen']);
});

test('craft affix kinds are drawn evenly: ailment damage, reduction (max 5%), SP regen (max 1.25 per slot) — 2026-11-20', () => {
  // 種類骰 r × 300：0～100 異常傷害、100～200 減傷、200～300 SP 回復
  const affix = (pick, value, inputs = ten('fury')) => rollCraft('weapon', inputs, scripted(0, 0, pick, value)).affixes[0];
  assert.deepEqual(affix(0.4, 0.9999999), { scope: 'effect', kind: 'reduction', value: 0.05, source: 'craft:reduction' });
  assert.equal(affix(0.4, 0).value, 0.035);                                    // 0.05 × 0.7
  assert.equal(affix(0.4, 0, ten('fury', 1)).value, Math.round(0.05 * TIER_SCALE[1] * 0.7 * 10000) / 10000);
  assert.deepEqual(affix(0.9, 0.9999999), { scope: 'effect', kind: 'spRegen', value: 1.25, source: 'craft:spRegen' });
  assert.equal(affix(0.9, 0).value, 0.875);
  assert.equal(affix(0.9, 0, ten('fury', 1)).value, Math.round(1.25 * TIER_SCALE[1] * 0.7 * 10000) / 10000);   // 1.25 × 第 1 階縮放 × 0.7
  assert.ok(!CRAFT_AFFIXES.some(a => a.kind === 'ailmentDuration'));          // 異常持續時間移到飾品
  const rng = createSeededRandom(8);
  const counts = { ailmentDmg: 0, reduction: 0, spRegen: 0 };
  for (let i = 0; i < 9000; i++) counts[rollCraft('weapon', ten('fury'), rng).affixes[0].kind]++;
  for (const kind of Object.keys(counts)) assert.ok(Math.abs(counts[kind] / 9000 - 1 / 3) < 0.02, kind);
});

test('craft affix reaches equippedEffects and the compiled ailment power', () => {
  let state = save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 5, 10);
  const result = save.craftEquipment(state, 'weapon', ten('fury'), scripted(0, 0, 0, 0.9999999));
  state = save.equip(result.save, result.id);
  assert.equal(save.equippedEffects(state).ailmentDmg, 0.25);
  state = save.addGems(state, 'rend', 1);
  state = save.setLinks(state, result.id, [{ active: 'rend', supports: [] }]);
  const loadout = save.compileEquipped(state);
  assert.equal(loadout.skills[0].actions[0].gemAilments[0].power, 0.25);   // 0.2 × 1.25
  assert.throws(() => save.addEquipment(state, { slot: 'boots', origin: 'drop', base: [], affixes: [low()] }), /製作詞綴/);
  assert.throws(() => save.addEquipment(state, { slot: 'boots', origin: 'craft', base: [], affixes: [low(), low()] }), /製作詞綴/);
});
const low = () => ({ scope: 'effect', kind: 'ailmentDmg', value: 0.1, source: 'craft:ailmentDmg' });

// ── 施放權重 ──────────────────────────────────────────────

test('cast weight rolls in 60~120, and gale / precise raise it', () => {
  assert.deepEqual([WEIGHT.low, WEIGHT.high], [60, 120]);
  assert.equal(rollCraft('boots', ten('vital'), scripted(0, 0)).castWeight, 60);
  assert.equal(rollCraft('boots', ten('vital'), scripted(0, 0.5)).castWeight, 90);
  assert.equal(rollCraft('boots', ten('vital'), scripted(0, 0.9999999)).castWeight, 120);
  assert.equal(rollCraft('boots', ten('gale'), scripted(0, 0)).castWeight, 60 + 10 * WEIGHT.bonus.gale);
  assert.equal(rollCraft('boots', ten('precise', 1), scripted(0, 0)).castWeight, Math.round(60 + 10 * WEIGHT.bonus.precise * TIER_SCALE[1]));
});

test('bad craft input is rejected', () => {
  assert.throws(() => rollCraft('ring', ten('fury')), /部位/);
  assert.throws(() => rollCraft('weapon', ten('fury').slice(0, 9)), /10 個/);
  assert.throws(() => rollCraft('weapon', [...ten('fury').slice(0, 9), { type: 'nope', tier: 1 }]), /nope/);
  assert.throws(() => rollCraft('weapon', [...ten('fury').slice(0, 9), { type: 'fury', tier: 6 }]), /階級/);
});

// ── 存檔層：craftEquipment ─────────────────────────────────

test('craftEquipment consumes ten engravings and adds a craft item with quality', () => {
  let state = save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 5, 6);
  state = save.addEngraving(state, 'vital', 3, 5);
  const inputs = [...ten('fury', 5).slice(0, 6), ...ten('vital', 3).slice(0, 4)];
  const result = save.craftEquipment(state, 'armor', inputs, scripted(0.5, 0.5));
  assert.deepEqual(result.save.engravings, { 'vital@3': 1 });
  const item = result.save.equipment.find(e => e.id === result.id);
  assert.equal(item.origin, 'craft');
  assert.equal(item.quality, 'common');
  assert.equal(result.quality, 'common');
  assert.deepEqual(item.links, []);
  assert.deepEqual(state.engravings, { 'fury@5': 6, 'vital@3': 5 });   // 原存檔不變
  const back = save.importSave(save.exportSave(result.save));
  assert.deepEqual(back.equipment, result.save.equipment);
  // 製作的裝備可以穿、基底進加成
  const worn = save.equip(result.save, result.id);
  assert.ok(save.equippedBonuses(worn).some(b => b.stat === 'atk' && b.value > 0));
});

test('craftEquipment fails without changing the save; bad quality in a save is rejected', () => {
  const state = save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 5, 9);
  assert.throws(() => save.craftEquipment(state, 'weapon', ten('fury')), err => err instanceof save.SaveError && /不夠/.test(err.message));
  assert.throws(() => save.craftEquipment(state, 'ring', ten('fury')), save.SaveError);
  assert.throws(() => save.craftEquipment(state, 'weapon', ten('fury').slice(0, 9)), save.SaveError);
  assert.deepEqual(state.engravings, { 'fury@5': 9 });
  assert.throws(() => save.addEquipment(state, { slot: 'weapon', origin: 'craft', base: [], affixes: [], quality: 'legendary' }), /quality/);
});

// ── 分解製作裝備 ──────────────────────────────────────────

test('crafted items remember their ten materials; salvaging returns 3 of them at random and the linked gems', () => {
  let state = save.addEngraving(save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 5, 6), 'vital', 3, 4);
  const inputs = [...ten('fury', 5).slice(0, 6), ...ten('vital', 3).slice(0, 4)];
  const made = save.craftEquipment(state, 'weapon', inputs);
  const item = made.save.equipment.find(e => e.id === made.id);
  assert.deepEqual(item.materials, [...Array(6).fill('fury@5'), ...Array(4).fill('vital@3')]);
  state = save.addGems(made.save, 'whirlwind', 1);
  state = save.equip(save.setLinks(state, made.id, [{ active: 'whirlwind', supports: [] }]), made.id);
  // rng 0.95 → 每次挑剩下的最後一個：vital@3 ×3
  const result = save.salvageEquipment(state, made.id, () => 0.95);
  assert.deepEqual(result.returned, ['vital@3', 'vital@3', 'vital@3']);
  assert.deepEqual(result.save.engravings, { 'vital@3': 3 });
  assert.equal(result.save.gems.whirlwind, 1);
  assert.equal(result.save.equipped.weapon, null);
  assert.equal(result.save.equipment.length, 0);
  assert.equal(state.equipment.length, 1);                                   // 原存檔不變
  assert.equal(save.salvageEquipment(state, made.id, () => 0).returned.length, SALVAGE_RETURN);
});

test('only crafted items with materials (and legendaries) can be salvaged; bad materials are rejected', () => {
  const legend = save.addLegendary(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'omen', 15);
  // 傳說裝備可以分解（2026-11-20）：獎勵還沒定，目前只移除裝備
  const gone = save.salvageEquipment(legend.save, legend.id);
  assert.deepEqual(gone.returned, []);
  assert.equal(gone.legendary, true);
  assert.equal(gone.save.equipment.length, 0);
  assert.equal(legend.save.equipment.length, 1);
  const add = spec => save.addEquipment(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), { slot: 'weapon', base: [], affixes: [], ...spec });
  assert.throws(() => add({ origin: 'craft', materials: ['fury@5'] }), /materials/);
  assert.throws(() => add({ origin: 'drop', materials: Array(10).fill('fury@5') }), /materials/);
  assert.doesNotThrow(() => add({ origin: 'craft', materials: Array(10).fill('fury@5') }));
});

test('a new game starts with most active gems; the rest come from bosses', () => {
  const { STARTING_ACTIVE_GEMS, BOSS_REWARD_GEMS, UNOBTAINABLE_ACTIVE_GEMS, ACTIVE_GEMS } = require('./gems');
  const starter = save.createStarterSave({ now: '2026-01-01T00:00:00Z' });
  assert.deepEqual(starter.gems, Object.fromEntries(STARTING_ACTIVE_GEMS.map(id => [id, 1])));
  assert.deepEqual(save.validateSave(starter), []);
  // 每顆主動寶石都歸在某一類（開局、打王、暫時不能取得）
  assert.deepEqual([...STARTING_ACTIVE_GEMS, ...BOSS_REWARD_GEMS, ...UNOBTAINABLE_ACTIVE_GEMS].sort(), Object.keys(ACTIVE_GEMS).sort());
  assert.ok(!STARTING_ACTIVE_GEMS.includes('mend'));
  assert.deepEqual(save.createEmptySave().gems, {});
});

test('crafted items can be named: trimmed, empty means no name, over ITEM_NAME_MAX is refused, only craft items', () => {
  const state = save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'vital', 1, 30);
  const named = save.craftEquipment(state, 'armor', ten('vital', 1), scripted(), { name: '  堅韌布甲 ' });
  assert.equal(named.save.equipment.find(e => e.id === named.id).name, '堅韌布甲');
  assert.equal(save.importSave(save.exportSave(named.save)).equipment[0].name, '堅韌布甲');
  const blank = save.craftEquipment(state, 'armor', ten('vital', 1), scripted(), { name: '   ' });
  assert.equal('name' in blank.save.equipment[0], false);
  assert.throws(() => save.craftEquipment(state, 'armor', ten('vital', 1), scripted(), { name: '甲'.repeat(save.ITEM_NAME_MAX + 1) }), /最多/);
  assert.doesNotThrow(() => save.craftEquipment(state, 'armor', ten('vital', 1), scripted(), { name: '甲'.repeat(save.ITEM_NAME_MAX) }));
  assert.throws(() => save.addEquipment(state, { slot: 'weapon', origin: 'drop', base: [], affixes: [], name: '撿來的' }), /name/);
  assert.throws(() => save.addEquipment(state, { slot: 'weapon', origin: 'craft', base: [], affixes: [], name: ' 有空白' }), /name/);
});
