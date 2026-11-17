const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { LEGENDARIES, rollLegendary, pickLegendary, mechanicsOf } = require('./legendaryTable');
// 平衡會調的數值從資料讀
const OMEN_INT = LEGENDARIES.omen.base[0].max;
const OMEN_INC = LEGENDARIES.omen.unique[0].max;
const { TIER_SCALE } = require('./affixTable');
const { compileLoadout } = require('./gemCompiler');
const save = require('./saveLayer');

const fresh = () => save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
const scripted = (...values) => () => (values.length ? values.shift() : 0.9999999);
const ten = (type, tier = 5) => Array.from({ length: 10 }, () => ({ type, tier }));

// ── 資料與擲值 ────────────────────────────────────────────

test('omen staff: int weapon with INT flat base, INT % unique, death cast and amp support', () => {
  const omen = LEGENDARIES.omen;
  assert.equal(omen.name, '報喪法杖');
  assert.equal(omen.slot, 'weapon');
  assert.equal(omen.attackStat, 'int');
  assert.deepEqual(omen.mechanics.map(m => m.type).sort(), ['castOnEnemyDeath', 'grantSupport']);
  assert.deepEqual(mechanicsOf({ legendaryId: 'omen' }).find(m => m.type === 'grantSupport'), { type: 'grantSupport', gem: 'amp' });
  assert.deepEqual(mechanicsOf({}), []);
  assert.equal(pickLegendary(() => 0.5), 'omen');
});

test('values scale with the opened tier of the drop difficulty and roll 0.7~1, like engravings', () => {
  const top = rollLegendary('omen', 15, () => 0.9999999);
  assert.deepEqual(top.base, [{ stat: 'int', op: 'flat', value: OMEN_INT }]);
  assert.deepEqual(top.affixes, [{ scope: 'wearer', stat: 'int', op: 'inc', value: OMEN_INC, source: 'legendary:omen' }]);
  assert.equal(top.castWeight, 100);
  assert.equal(top.attackStat, 'int');
  // rng 順序：base、unique、權重
  const low = rollLegendary('omen', 1, scripted(0, 0, 0));
  assert.equal(low.base[0].value, Math.round(OMEN_INT * TIER_SCALE[1] * 0.7));
  assert.equal(low.affixes[0].value, Math.round(OMEN_INC * TIER_SCALE[1] * 0.7 * 10000) / 10000);
  assert.equal(low.castWeight, 70);
  assert.equal(rollLegendary('omen', 6, () => 0.9999999).base[0].value, Math.round(OMEN_INT * TIER_SCALE[2]));   // 難度 6 開放到第 2 階（3% 預覽不算）
  assert.equal(rollLegendary('omen', 7, () => 0.9999999).base[0].value, Math.round(OMEN_INT * TIER_SCALE[3]));
  assert.throws(() => rollLegendary('nope', 5), /nope/);
  assert.throws(() => rollLegendary('omen', 16), /難度/);
});

// ── 存檔 ──────────────────────────────────────────────────

test('legendary items are drop items that cannot be engraved, and bad legendary data is rejected', () => {
  let state = save.addEngraving(fresh(), 'arcane', 5, 1);
  const added = save.addLegendary(state, 'omen', 15, () => 0.9999999);
  const item = added.save.equipment.find(e => e.id === added.id);
  assert.equal(item.origin, 'drop');
  assert.equal(item.legendaryId, 'omen');
  assert.throws(() => save.engraveEquipment(added.save, added.id, 'arcane', 5), /傳說/);
  assert.deepEqual(save.importSave(save.exportSave(added.save)).equipment, added.save.equipment);
  const add = spec => save.addEquipment(fresh(), { base: [], affixes: [], ...spec });
  assert.throws(() => add({ slot: 'weapon', origin: 'drop', legendaryId: 'nope' }), /legendaryId/);
  assert.throws(() => add({ slot: 'helmet', origin: 'drop', legendaryId: 'omen' }), /部位/);
  assert.throws(() => add({ slot: 'weapon', origin: 'craft', legendaryId: 'omen' }), /origin/);
  assert.throws(() => add({ slot: 'helmet', origin: 'craft', attackStat: 'int' }), /attackStat/);
  assert.throws(() => add({ slot: 'weapon', origin: 'craft', attackStat: 'def' }), /attackStat/);
});

test('normal attack stat comes from the worn weapon: legendary fixed, crafted chosen (default atk), none = atk', () => {
  assert.equal(save.equippedAttackStat(fresh()), 'atk');
  const legend = save.addLegendary(fresh(), 'omen', 15);
  assert.equal(save.equippedAttackStat(save.equip(legend.save, legend.id)), 'int');
  let state = save.addEngraving(fresh(), 'arcane', 5, 20);
  const plain = save.craftEquipment(state, 'weapon', ten('arcane'));
  assert.equal(plain.save.equipment[0].attackStat, 'atk');
  const staff = save.craftEquipment(plain.save, 'weapon', ten('arcane'), Math.random, { attackStat: 'int' });
  assert.equal(save.equippedAttackStat(save.equip(staff.save, staff.id)), 'int');
  assert.equal(save.equippedAttackStat(save.equip(staff.save, plain.id)), 'atk');
  state = save.addEngraving(fresh(), 'vital', 5, 10);
  assert.throws(() => save.craftEquipment(state, 'helmet', ten('vital'), Math.random, { attackStat: 'int' }), /武器/);
  assert.throws(() => save.craftEquipment(state, 'weapon', ten('vital'), Math.random, { attackStat: 'spd' }), save.SaveError);
});

// ── 額外輔助寶石：增幅 ────────────────────────────────────

test('granted amp supports the gem on the weapon without taking a link slot; skipped if linked already or incompatible', () => {
  const one = links => compileLoadout(links).compiled[0];
  const granted = one([{ active: 'magicmissile', grantedSupports: ['amp'] }]);
  assert.equal(granted.skill.id, 'magicmissile+amp');
  assert.deepEqual(granted.grantedSupports, ['amp']);
  assert.equal(granted.skill.actions[0].power, 1.8);                                  // 1.5 × 1.2
  assert.equal(one([{ active: 'magicmissile', supports: ['amp'], grantedSupports: ['amp'] }]).skill.id, 'magicmissile+amp');
  assert.equal(one([{ active: 'magicmissile', supports: ['heavy', 'shock', 'wide'], grantedSupports: ['amp'] }]).skill.id, 'magicmissile+amp+heavy+shock+wide');
  const mend = one([{ active: 'mend', grantedSupports: ['amp'] }]);
  assert.equal(mend.skill.id, 'mend');
  assert.deepEqual(mend.grantedSupports, []);
  assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: ['heavy', 'shock', 'wide', 'lean'] }]), /最多連結 3 顆/);
  assert.throws(() => compileLoadout([{ active: 'magicmissile', grantedSupports: ['nope'] }]), /nope|不存在/);
});

test('compileEquipped wires the omen staff: INT bonuses, amp, death cast passives and int normal attack', () => {
  let state = save.addGems(fresh(), 'magicmissile', 1);
  const added = save.addLegendary(state, 'omen', 15, () => 0.9999999);
  state = save.equip(save.setLinks(added.save, added.id, [{ active: 'magicmissile', supports: [] }]), added.id);
  const loadout = save.compileEquipped(state);
  assert.equal(loadout.normalAttackStat, 'int');
  assert.equal(loadout.skills[0].id, 'magicmissile+amp');
  assert.ok(loadout.passives.some(p => p.trigger === 'AFTER_ACTION' && p.id.startsWith('gem_deathcast:')));
  const bonuses = save.equippedBonuses(state);
  assert.ok(bonuses.some(b => b.stat === 'int' && b.op === 'flat' && b.value === OMEN_INT));
  assert.ok(bonuses.some(b => b.stat === 'int' && b.op === 'inc' && b.value === OMEN_INC));
});

// ── 敵人倒下時施放 ────────────────────────────────────────

function deathFight(t, { foes = 3, linkActive = 'magicmissile', deathCast = true } = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  const loadout = compileLoadout([{ active: linkActive, grantedSupports: ['amp'], ...(deathCast ? { castOnEnemyDeath: { text: '{caster} 手中的報喪法杖為 {target} 敲響喪鐘！' } } : {}) }]);
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
    skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 1e6, maxHp: 1e6, sp: 1, maxSp: 100, atk: 10, int: 10, def: 0, spd: 999, skillCastRate: 0 } });
  const enemies = Array.from({ length: foes }, (_, i) => new Entity({ id: `f${i}`, name: `怪${i}`, team: 'B',
    normalAttack: new Skill({ id: `fa${i}`, name: 'fa', actions: [{ type: 'DAMAGE' }] }), stats: { hp: 5, maxHp: 5, sp: 100, atk: 1, def: 0, spd: 1 } }));
  const engine = new BattleEngine([hero], enemies, { maxTurns: 3, rng: createSeededRandom(1), skillSelectionResolver: loadout.resolver });
  const result = engine.start();
  return { hero, enemies, result, logs: engine.logger.logs };
}

test('each enemy death inserts one free cast of the weapon gem; the chain clears the pack in the first slot', t => {
  const { hero, enemies, result, logs } = deathFight(t);
  assert.equal(result.winner, 'TEAM_A');
  assert.ok(enemies.every(e => !e.isAlive));
  const bells = logs.filter(l => l.type === 'TEXT' && /敲響喪鐘/.test(l.message));
  assert.equal(bells.length, 2);                                   // 最後一隻倒下時戰鬥已結束，不再施放
  assert.match(bells[0].message, /^勇者 手中的報喪法杖為 怪[0-2] 敲響喪鐘！$/);
  assert.equal(logs.filter(l => l.type === 'DAMAGE' && l.skillId === 'magicmissile+amp').length, 2);
  assert.equal(hero.stats.sp, 0);                                  // 普攻扣 1；插隊的魔法飛彈（SP 10）不扣 SP
  // 每次施放都在對應的倒下之後
  const deaths = logs.map((l, i) => (l.type === 'DEATH' ? i : -1)).filter(i => i >= 0);
  const casts = logs.map((l, i) => (l.skillId === 'magicmissile+amp' && l.type === 'DAMAGE' ? i : -1)).filter(i => i >= 0);
  assert.ok(casts[0] > deaths[0] && casts[1] > deaths[1]);
});

test('without the death-cast mechanic nothing extra happens', t => {
  const { logs, enemies } = deathFight(t, { deathCast: false });
  assert.equal(logs.filter(l => /敲響喪鐘/.test(l.message ?? '')).length, 0);
  assert.equal(logs.filter(l => l.skillId === 'magicmissile+amp').length, 0);   // skillCastRate 0：只有普攻
  assert.ok(enemies.length === 3);
});

test('a single enemy never triggers the death cast (the battle ends first)', t => {
  const { logs } = deathFight(t, { foes: 1 });
  assert.equal(logs.filter(l => /敲響喪鐘/.test(l.message ?? '')).length, 0);
});
