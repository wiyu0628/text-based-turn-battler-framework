const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TIER_SCALE, ROLL_MIN, REDUCTION_CAP, ENGRAVINGS_PER_ITEM, LINES_PER_ENGRAVING, EFFECT_KINDS, ENGRAVING_TYPES, BASE_BY_SLOT, rollEngraving, rollBase, sumEffectAffixes } = require('./affixTable');
const { createEmptySave, addEquipment, equip, equippedBonuses } = require('./saveLayer');
const { applyStatBonuses, validateBonuses } = require('./statLayer');

// 依序給值的 rng：用完後一律回傳 1。擲刻印的順序是「落選行、行 A 的骰、行 B 的骰」。
const scripted = (...values) => () => (values.length ? values.shift() : 1);

test('an engraving keeps exactly 2 of its 3 lines; the dropped line is chosen by the first roll', () => {
  const lines = ENGRAVING_TYPES.fury.lines;
  const keep = excluded => rollEngraving('fury', 5, scripted(excluded)).map(l => l.stat ?? l.kind);
  assert.deepEqual(keep(0), ['physDmg', 'criDmg']);      // r < 1/3：第 1 行落選
  assert.deepEqual(keep(0.5), ['atk', 'criDmg']);        // 1/3 ≤ r < 2/3：第 2 行落選
  assert.deepEqual(keep(0.99), ['atk', 'physDmg']);      // r ≥ 2/3：第 3 行落選
  assert.equal(lines.length, LINES_PER_ENGRAVING);
});

test('every line is equally likely to be dropped', () => {
  const counts = { atk: 0, physDmg: 0, criDmg: 0 };
  const n = 3000;
  for (let i = 0; i < n; i++) {
    const kept = rollEngraving('fury', 5, Math.random).map(l => l.stat ?? l.kind);
    assert.equal(kept.length, 2);
    for (const k of kept) counts[k]++;
  }
  for (const k of Object.keys(counts)) assert.ok(Math.abs(counts[k] / n - 2 / 3) < 0.04, `${k} 出現率 ${counts[k] / n}`);
});

test('max roll at tier 5 equals the table maximum; tier and roll scale it', () => {
  const [atk, phys] = rollEngraving('fury', 5, () => 1);      // 最後一行落選、其餘滿骰
  assert.deepEqual([atk.value, phys.value], [0.17, 0.12]);
  const [low] = rollEngraving('fury', 1, scripted(0.99, 0));  // 第 3 行落選，第一行擲到下限
  assert.equal(low.value, Math.round(0.17 * TIER_SCALE[1] * ROLL_MIN * 10000) / 10000);
});

test('percent lines keep their decimals; only flat integer stats are rounded', () => {
  const lines = rollEngraving('vital', 5, () => 1);            // hp inc、def flat
  assert.equal(lines[0].op, 'inc');
  assert.equal(lines[0].value, 0.21);
  assert.equal(lines[1].value, 33);
  const flatHp = rollEngraving('bulwark', 3, scripted(0, 0.5, 0.5)).find(l => l.stat === 'hp');   // 第 1 行（def inc）落選
  assert.ok(Number.isInteger(flatHp.value));
});

test('affixes use the save layer formats and pass validation', () => {
  for (const type of Object.keys(ENGRAVING_TYPES)) for (const tier of Object.keys(TIER_SCALE).map(Number)) {
    const one = rollEngraving(type, tier, Math.random);
    assert.equal(one.length, 2);
    assert.equal(rollEngraving([type, type], tier, Math.random).length, 4);
    const wearer = one.filter(a => a.scope === 'wearer').map(({ stat, op, value, source }) => ({ stat, op, value, source }));
    assert.deepEqual(validateBonuses(wearer), []);
    for (const a of one.filter(a => a.scope === 'effect')) assert.ok(EFFECT_KINDS.includes(a.kind));
    assert.ok(!one.some(a => a.scope === 'gems'));
  }
});

test('a rolled item can be added to a save and its bonuses reach the stats', () => {
  let state = createEmptySave({ now: '2026-01-01T00:00:00Z' });
  const result = addEquipment(state, { slot: 'weapon', origin: 'craft', base: rollBase('weapon', 5, () => 1), affixes: rollEngraving(['fury', 'fury'], 5, () => 1) });
  state = equip(result.save, result.id);
  const stats = applyStatBonuses({ hp: 3000, sp: 240, atk: 150, int: 150, def: 50, spd: 100 }, equippedBonuses(state));
  // 兩個猛攻各取到「ATK +17%」（最後一行落選），同在加算區：(150 + 215) × (1 + 0.17 + 0.17)
  assert.equal(stats.atk, Math.round((150 + 215) * 1.34));
});

test('spell engravings carry no crit lines and physical ones no spell lines', () => {
  const kinds = type => ENGRAVING_TYPES[type].lines.map(l => l.stat ?? l.kind);
  assert.ok(!kinds('arcane').some(k => k === 'cri' || k === 'criDmg' || k === 'physDmg'));
  assert.ok(!kinds('fury').includes('spellDmg') && !kinds('fury').includes('int'));
});

test('no engraving offers skill cast rate (negative value for physical builds)', () => {
  for (const def of Object.values(ENGRAVING_TYPES)) assert.ok(!def.lines.some(l => l.stat === 'skillCastRate'));
});

test('damage reduction sums across engravings and is capped', () => {
  // vital 的第 1 行（hp）落選 → 留下 def 與 reduction；bulwark 的第 2 行（hp flat）落選 → 留下 def inc 與 reduction
  const set = [rollEngraving(['vital', 'bulwark'], 5, scripted(0, 1, 1, 0.5, 1, 1))].flat();
  const total = sumEffectAffixes(set);
  assert.ok(Math.abs(total.reduction - (0.05 + 0.065)) < 1e-9);
  assert.equal(sumEffectAffixes([{ scope: 'effect', kind: 'reduction', value: 0.9 }]).reduction, REDUCTION_CAP);
  assert.equal(sumEffectAffixes([{ scope: 'gems', kind: 'reduction', value: 0.9 }]).reduction, 0);
});

test('invalid tier, type or slot throw', () => {
  assert.throws(() => rollEngraving('fury', 0), /階級/);
  assert.throws(() => rollEngraving('nope', 1), /找不到刻印/);
  assert.throws(() => rollBase('ring', 1), /找不到部位/);
  assert.ok(BASE_BY_SLOT.weapon);
});

test('an item takes exactly two engravings, and the same one twice is allowed', () => {
  assert.equal(ENGRAVINGS_PER_ITEM, 2);
  assert.doesNotThrow(() => rollEngraving(['fury', 'fury'], 3));
  assert.doesNotThrow(() => rollEngraving(['fury', 'arcane'], 3));
  assert.throws(() => rollEngraving(['fury'], 3), /剛好掛 2 個/);
  assert.throws(() => rollEngraving(['fury', 'fury', 'fury'], 3), /剛好掛 2 個/);
});

test('armor carries atk and int base like the weapon', () => {
  const stats = rollBase('armor', 5, () => 1).map(b => b.stat);
  assert.ok(stats.includes('atk') && stats.includes('int'));
  assert.deepEqual(rollBase('armor', 5, () => 1).filter(b => b.stat === 'atk' || b.stat === 'int').map(b => b.value), [140, 140]);
});
