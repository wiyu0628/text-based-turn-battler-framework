const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { compileLoadout, compileSkill } = require('./gemCompiler');
const save = require('./saveLayer');
const { rollEngraving, rollBase } = require('./affixTable');

const powers = (loadoutOrSkill) => (loadoutOrSkill.skills ?? [loadoutOrSkill.skill])[0].actions.filter(a => a.type === 'DAMAGE').map(a => a.power);
const power = (active, supports, equipment) => powers(compileLoadout([{ active, supports }], { equipment }))[0];
// 預期值從寶石資料算（平衡調整旋風斬的倍率時不用改測試）；編譯器取到小數 4 位
const WW = require('./gems').ACTIVE_GEMS.whirlwind.actions[0].power;
const r4 = x => Math.round(x * 10000) / 10000;

// ── 物理／法術傷害提高：進加算區 ─────────────────────────────

test('physical damage bonus applies to atk actions only; spell bonus to int actions only', () => {
  assert.equal(power('whirlwind', [], { physDmg: 0.3 }), r4(WW * 1.3));
  assert.equal(power('whirlwind', [], { spellDmg: 0.3 }), WW);
  assert.equal(power('magicmissile', [], { spellDmg: 0.3 }), 1.95);    // 1.5 × 1.3
  assert.equal(power('magicmissile', [], { physDmg: 0.5 }), 1.5);
});

test('equipment bonus shares the additive zone with gem inc, and multiplies with gem more', () => {
  assert.equal(power('whirlwind', ['amp'], { physDmg: 0.3 }), r4(WW * 1.5));          // × (1 + 0.2 + 0.3)
  assert.equal(power('whirlwind', ['heavy'], { physDmg: 0.3 }), r4(WW * 1.3 * 1.3));   // × 1.3 × 1.3
  assert.equal(power('whirlwind', ['amp', 'heavy'], { physDmg: 0.3 }), r4(WW * 1.5 * 1.3)); // × 1.5 × 1.3
});

test('no equipment option leaves every power unchanged (default behaviour)', () => {
  assert.equal(power('whirlwind', ['amp'], undefined), r4(WW * 1.2));
  assert.equal(power('whirlwind', ['amp'], {}), r4(WW * 1.2));
  assert.equal(compileSkill('whirlwind', ['amp']).damageFactor, 1.2);
});

test('compileSkill also accepts the equipment option and the charge release carries the bonus', () => {
  assert.equal(compileSkill('whirlwind', [], { equipment: { physDmg: 0.1 } }).skill.actions[0].power, r4(WW * 1.1));
  const charged = compileSkill('whirlwind', ['charge'], { equipment: { physDmg: 0.1 } });
  const chargeMore = require('./gems').SUPPORT_GEMS.charge.effects.find(e => e.op === 'more').value;
  assert.equal(charged.release.actions[0].power, r4(WW * 1.1 * (1 + chargeMore)));   // × 1.1 × (1 + 蓄力)
});

test('bad equipment options are rejected', () => {
  assert.throws(() => compileLoadout([{ active: 'whirlwind' }], { equipment: { physDmg: -0.1 } }), /physDmg/);
  assert.throws(() => compileLoadout([{ active: 'whirlwind' }], { equipment: { physDmg: NaN } }), /physDmg/);
  assert.throws(() => compileLoadout([{ active: 'whirlwind' }], { equipment: { reduction: 1 } }), /reduction/);
  assert.throws(() => compileLoadout([{ active: 'whirlwind' }], { equipment: { luck: 1 } }), /luck/);
  assert.throws(() => compileLoadout([{ active: 'whirlwind' }], { equipment: [] }), /物件/);
});

// ── 減傷：開戰時掛常駐 Buff ──────────────────────────────────

function battle(t, reduction) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'calculateDamage', () => 100);
  t.mock.method(Formulas, 'isCritical', () => false);
  const loadout = compileLoadout([{ active: 'whirlwind' }], { equipment: { reduction } });
  const strike = id => new Skill({ id, name: id, actions: [{ type: 'DAMAGE' }] });
  const hero = new Entity({ id: 'h', name: 'h', team: 'A', normalAttack: strike('na'), skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 100000, maxHp: 100000, sp: 100, atk: 10, spd: 100 } });
  const foe = new Entity({ id: 'f', name: 'f', team: 'B', normalAttack: strike('fa'),
    stats: { hp: 1e9, maxHp: 1e9, sp: 100, atk: 10, spd: 100 } });
  const engine = new BattleEngine([hero], [foe], { maxTurns: 6, rng: createSeededRandom(7), skillSelectionResolver: loadout.resolver });
  engine.start();
  return { hero, loadout, foeHits: engine.logger.logs.filter(l => l.type === 'DAMAGE' && l.actorId === 'f').length };
}

test('reduction passive is added only when reduction is positive', () => {
  assert.ok(!compileLoadout([{ active: 'whirlwind' }]).passives.some(p => p.id === 'gem_equipment_reduction'));
  assert.ok(!compileLoadout([{ active: 'whirlwind' }], { equipment: { reduction: 0 } }).passives.some(p => p.id === 'gem_equipment_reduction'));
  assert.ok(compileLoadout([{ active: 'whirlwind' }], { equipment: { reduction: 0.1 } }).passives.some(p => p.id === 'gem_equipment_reduction'));
});

test('reduction scales every incoming attack hit and lasts the whole battle', t => {
  const { hero, foeHits } = battle(t, 0.2);
  assert.ok(foeHits >= 3);
  assert.equal(100000 - hero.stats.hp, foeHits * 80);
  assert.ok(hero.buffs.some(b => b.id === 'gem_equipment_reduction'));
});

test('without reduction the same battle deals full damage', t => {
  const { hero, foeHits } = battle(t, 0);
  assert.equal(100000 - hero.stats.hp, foeHits * 100);
});

// ── 存檔層：effect 詞綴 ──────────────────────────────────────

const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
// 依序給值的 rng，用完回傳 1。擲刻印的順序：落選行、行 A 的骰、行 B 的骰（每個刻印各一輪）。
const scripted = (...values) => () => (values.length ? values.shift() : 1);
// types：{ 部位: [兩個刻印種類, rng] }，rng 省略時是最後一行落選、其餘滿骰
function equipped(types) {
  let state = fresh();
  for (const [slot, [pair, rng = () => 1]] of Object.entries(types)) {
    const added = save.addEquipment(state, { slot, origin: 'craft', base: rollBase(slot, 5, () => 1), affixes: rollEngraving(pair, 5, rng) });
    state = save.equip(added.save, added.id);
  }
  return state;
}
// 猛攻留下「ATK +17%、物理傷害 +12%」（第 3 行落選）；堅韌第 2 行落選留下 hp 與減傷；鐵壁第 2 行落選留下 def 與減傷
const FURY = ['fury', 'fury'];
const vitalBulwark = () => [['vital', 'bulwark'], scripted(0.5, 1, 1, 0.5, 1, 1)];   // rng 有狀態，每次用都要新做一個

test('save accepts effect affixes and rejects bad kinds and values', () => {
  const add = affix => save.addEquipment(fresh(), { slot: 'weapon', origin: 'drop', base: [], affixes: [affix] });
  assert.doesNotThrow(() => add({ scope: 'effect', kind: 'physDmg', value: 0.1 }));
  assert.throws(() => add({ scope: 'effect', kind: 'luck', value: 0.1 }), /kind/);
  assert.throws(() => add({ scope: 'effect', kind: 'physDmg', value: -0.1 }), /value/);
  assert.throws(() => add({ scope: 'effect', kind: 'physDmg', value: Infinity }), /value/);
});

test('equippedEffects sums equipped items only, with reduction capped', () => {
  const state = equipped({ weapon: [FURY], helmet: vitalBulwark() });
  const fx = save.equippedEffects(state);
  assert.ok(Math.abs(fx.physDmg - 0.24) < 1e-9);          // 12% × 2
  assert.ok(Math.abs(fx.reduction - 0.115) < 1e-9);       // 5% + 6.5%
  assert.equal(fx.spellDmg, 0);
  assert.deepEqual(save.equippedEffects(fresh()), { physDmg: 0, spellDmg: 0, reduction: 0, ailmentDmg: 0, ailmentDuration: 0, spRegen: 0 });
});

test('compileEquipped wires links, damage bonus and reduction in one step', () => {
  let state = equipped({ weapon: [FURY], helmet: vitalBulwark() });
  state = save.addGems(state, 'whirlwind', 1);
  const weaponId = state.equipped.weapon;
  state = save.setLinks(state, weaponId, [{ active: 'whirlwind', supports: [] }]);
  const loadout = save.compileEquipped(state);
  assert.equal(loadout.skills[0].actions[0].power, r4(WW * 1.24));   // × (1 + 0.24)
  assert.ok(loadout.passives.some(p => p.id === 'gem_equipment_reduction'));
});

test('effect affixes survive export and import', async () => {
  const state = equipped({ weapon: [['fury', 'arcane']] });
  const back = save.importSave(save.exportSave(state));
  assert.deepEqual(save.equippedEffects(back), save.equippedEffects(state));
});
