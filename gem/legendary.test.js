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
  const ids = Object.keys(LEGENDARIES).filter(id => (LEGENDARIES[id].area ?? 1) === 1);
  assert.equal(pickLegendary(() => 0), ids[0]);
  assert.equal(pickLegendary(() => 0.9999999), ids.at(-1));   // 平均抽
});

test('values scale with the opened tier of the drop difficulty and roll 0.7~1, like engravings', () => {
  const top = rollLegendary('omen', 15, () => 0.9999999);
  assert.deepEqual(top.base, [{ stat: 'int', op: 'flat', value: OMEN_INT }]);
  assert.deepEqual(top.affixes, [{ scope: 'wearer', stat: 'int', op: 'inc', value: OMEN_INC, source: 'legendary:omen' }]);
  assert.equal(top.castWeight, 120);
  assert.equal(top.attackStat, 'int');
  // rng 順序：base、unique、權重
  const low = rollLegendary('omen', 1, scripted(0, 0, 0));
  assert.equal(low.base[0].value, Math.round(OMEN_INT * TIER_SCALE[1] * 0.7));
  assert.equal(low.affixes[0].value, Math.round(OMEN_INC * TIER_SCALE[1] * 0.7 * 10000) / 10000);
  assert.equal(low.castWeight, 60);
  assert.equal(rollLegendary('omen', 6, () => 0.9999999).base[0].value, Math.round(OMEN_INT * TIER_SCALE[2] * (0.7 + 0.3 * 0.9999999)));   // 難度 6 開放到第 2 階（3% 預覽不算）
  assert.equal(rollLegendary('omen', 7, () => 0.9999999).base[0].value, Math.round(OMEN_INT * TIER_SCALE[3] * (0.7 + 0.3 * 0.9999999)));
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
  assert.equal(one([{ active: 'magicmissile', supports: ['heavy', 'shock', 'pierce'], grantedSupports: ['amp'] }]).skill.id, 'magicmissile+amp+heavy+pierce+shock');
  const mend = one([{ active: 'mend', grantedSupports: ['amp'] }]);
  assert.equal(mend.skill.id, 'mend');
  assert.deepEqual(mend.grantedSupports, []);
  assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: ['heavy', 'shock', 'pierce', 'lean'] }]), /最多連結 3 顆/);
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

// ── 連攜匕首（castOnCrit）、魔力循環法球（spShield、shieldBreakSp），2026-11-19 ─────

test('連攜匕首：攻擊武器；爆擊率隨階級縮放，爆擊傷害減少是固定區間（不隨難度）', () => {
  const dagger = LEGENDARIES.linkdagger;
  assert.equal(dagger.attackStat, 'atk');
  const [low, high] = dagger.unique[1].range;
  for (const difficulty of [1, 15]) {
    for (const r of [0, 0.9999999]) {
      const item = rollLegendary('linkdagger', difficulty, () => r);
      const criDmg = item.affixes.find(a => a.stat === 'criDmg').value;
      assert.ok(criDmg >= low && criDmg <= high, `${criDmg}`);
    }
  }
  assert.equal(rollLegendary('linkdagger', 1, () => 0).affixes.find(a => a.stat === 'criDmg').value, low);   // 難度 1 也一樣
  assert.ok(rollLegendary('linkdagger', 1, () => 0.9999999).affixes[0].value < rollLegendary('linkdagger', 15, () => 0.9999999).affixes[0].value, '爆擊率有縮放');
});

test('連攜匕首：暴擊時依機率免費釋放裝備的主動寶石，每槽最多一次、觸發的那次不連鎖；穿戴時接上', t => {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => true);
  const loadout = compileLoadout([{ active: 'rend', castOnCrit: { chance: 1, text: '{caster}連攜追擊，' } }]);
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
    skills: loadout.skills, passives: loadout.passives, stats: { hp: 1e6, maxHp: 1e6, sp: 0, maxSp: 100, atk: 10, def: 0, spd: 300, skillCastRate: 0 } });
  const foe = new Entity({ id: 'f', name: '怪', team: 'B', normalAttack: new Skill({ id: 'fa', name: 'fa', actions: [{ type: 'DAMAGE' }] }), stats: { hp: 1e6, maxHp: 1e6, sp: 0, atk: 1, def: 0, spd: 150 } });
  const logs = new BattleEngine([hero], [foe], { maxTurns: 2, rng: createSeededRandom(1), skillSelectionResolver: loadout.resolver }).start().logs;
  const slots = logs.filter(l => l.actorId === 'h' && l.message?.startsWith('勇者 攻擊')).length;
  const casts = logs.filter(l => l.message?.startsWith('勇者連攜追擊，使出撕裂')).length;
  assert.ok(slots > 0);
  assert.equal(casts, slots, '每個普攻槽（每擊都暴擊）只觸發一次，觸發出來的撕裂暴擊也不再觸發');
  // 存檔：穿上匕首，連結帶 castOnCrit
  let state = save.addGems(fresh(), 'rend', 1);
  const added = save.addLegendary(state, 'linkdagger', 15, () => 0.5);
  state = save.equip(save.setLinks(added.save, added.id, [{ active: 'rend', supports: [] }]), added.id);
  assert.deepEqual(save.equippedLinks(state)[0].castOnCrit, { chance: LEGENDARIES.linkdagger.mechanics[0].chance, text: LEGENDARIES.linkdagger.mechanics[0].text });
  assert.ok(save.compileEquipped(state).passives.some(p => p.id === 'gem_legendCrit'));
});

test('魔力循環法球：施放技能依實際扣的 SP 得到護盾（取較大值、重置時間），免費施放沒有盾；任何盾碎掉回 SP', t => {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  const mechanics = LEGENDARIES.manaorb.mechanics;
  const spec = mechanics.find(m => m.type === 'spShield');
  const loadout = compileLoadout([{ active: 'magicmissile' }], { mechanics });
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
    skills: loadout.skills, passives: loadout.passives, stats: { hp: 1e6, maxHp: 1e6, sp: 100, maxSp: 100, atk: 10, int: 100, def: 0, spd: 100, skillCastRate: 1 } });
  const foe = new Entity({ id: 'f', name: '怪', team: 'B', normalAttack: new Skill({ id: 'fa', name: 'fa', actions: [{ type: 'DAMAGE' }] }), stats: { hp: 1e6, maxHp: 1e6, sp: 0, atk: 1, def: 0, spd: 1 } });
  const skill = loadout.skills[0];
  const engine = new BattleEngine([hero], [foe], { maxTurns: 1, rng: createSeededRandom(1), skillSelectionResolver: loadout.resolver });
  const cast = (options = {}) => skill.execute(hero, [hero], [foe], engine.logger, engine, options);
  cast();
  const cost = 100 - hero.stats.sp;
  const shield = hero.buffs.find(b => b.id === 'legend_manaShield');
  assert.equal(shield.shield.value, Math.round(100 * cost * spec.ratio));
  assert.equal(shield.duration, spec.duration);
  shield.shield.value = 5; shield.duration = 1;
  cast();
  assert.equal(hero.buffs.filter(b => b.id === 'legend_manaShield').length, 1, '不疊加');
  assert.equal(shield.shield.value, Math.round(100 * cost * spec.ratio), '取較大值');
  assert.equal(shield.duration, spec.duration, '重置時間');
  const before = shield.shield.value;
  cast({ ignoreSp: true });
  assert.equal(shield.shield.value, before, '免費施放沒有盾');
  // 碎盾回 SP（任何來源的盾）
  hero.stats.sp = 0;
  hero.addBuff({ id: 'other', name: '別的盾', duration: 3, shield: 1, polarity: 'positive', dispellable: true });
  const logs = [];
  const breaker = new Entity({ id: 'b', name: '打手', team: 'B', normalAttack: new Skill({ id: 'bb', name: 'bb', actions: [{ type: 'DAMAGE' }] }), stats: { hp: 10, sp: 0, atk: 1e5, def: 0, spd: 1 } });
  t.mock.method(Formulas, 'calculateDamage', () => 1e5);
  const engine2 = new BattleEngine([hero], [breaker], { maxTurns: 1, rng: createSeededRandom(1) });
  breaker.normalAttack.execute(breaker, [breaker], [hero], engine2.logger, engine2);
  logs.push(...engine2.logger.logs);
  const sp = mechanics.find(m => m.type === 'shieldBreakSp').sp;
  assert.equal(hero.stats.sp, sp * 2, '魔力護盾與別的盾一起碎，各回一次');
  assert.ok(logs.some(l => l.message?.includes('從碎裂的護盾回復了')));
  // 存檔：穿上法球，機制接上
  let state = save.addGems(fresh(), 'magicmissile', 1);
  const added = save.addLegendary(state, 'manaorb', 15, () => 0.5);
  state = save.equip(save.setLinks(added.save, added.id, [{ active: 'magicmissile', supports: [] }]), added.id);
  assert.deepEqual(save.equippedMechanics(state).map(m => m.type).sort(), ['shieldBreakSp', 'spShield']);
  assert.ok(save.compileEquipped(state).passives.some(p => p.id === 'legend_shieldBreakSp'));
  assert.equal(save.compileEquipped(state).normalAttackStat, 'int');
});

// ── 幻影戰斧（phantom），2026-11-19 ────────────────────────────────

function phantomFight(t, { active = 'rend', heroHp = 1e6, chase = true, summonHp = 0, turns = 2 } = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  const spec = LEGENDARIES.phantomaxe.mechanics[0];
  const loadout = compileLoadout([{ active, phantomChase: chase }], { equipment: { summonHp }, mechanics: [spec] });
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
    skills: loadout.skills, passives: loadout.passives, stats: { hp: heroHp, maxHp: heroHp, sp: 200, maxSp: 200, atk: 100, int: 50, def: 40, spd: 200, cri: 0.1, skillCastRate: 1 } });
  const foes = ['a', 'b'].map(id => new Entity({ id, name: `怪${id}`, team: 'B', normalAttack: new Skill({ id: `f${id}`, name: 'f', actions: [{ type: 'DAMAGE' }] }), stats: { hp: 1e6, maxHp: 1e6, sp: 0, atk: 500, def: 0, spd: 150 } }));
  const engine = new BattleEngine([hero], foes, { maxTurns: turns, rng: createSeededRandom(3), skillSelectionResolver: loadout.resolver });
  const result = engine.start();
  return { hero, engine, result, spec, logs: result.logs.filter(l => l.message) };
}

test('幻影戰斧：開戰召喚幻影（屬性 × ratio，生命再乘 1 + 召喚物生命），平常自己普攻', t => {
  const { hero, engine, spec, logs } = phantomFight(t, { summonHp: 0.4 });
  const phantom = engine.teamA.find(e => e.gemPhantom === true);
  assert.ok(phantom);
  assert.equal(logs[1].message, '勇者揮動斧頭，一道幻影浮現在勇者的身後。');
  assert.equal(phantom.name, '勇者的幻影');
  const ratio = key => spec.ratios?.[key] ?? (key === 'spd' ? 1 : spec.ratio);
  assert.equal(phantom.stats.maxHp, Math.round(1e6 * ratio('hp') * 1.4));
  assert.equal(phantom.stats.atk, Math.round(100 * ratio('atk')));
  assert.equal(phantom.stats.def, Math.round(40 * ratio('def')));
  assert.equal(phantom.stats.spd, Math.round(200 * ratio('spd')));
  assert.deepEqual([ratio('hp'), ratio('spd'), ratio('atk'), ratio('int'), ratio('def')], [0.5, 0.5, 0.3, 0.3, 0.3]);   // 使用者定案
  assert.equal(phantom.summonerId, hero.id);
  assert.ok(logs.some(l => l.actorId === phantom.id && l.message.startsWith('勇者的幻影 攻擊')), '自己普攻');
});

test('幻影戰斧：裝備的主動寶石施放後幻影追擊——單體跟同一個目標；沒有 phantomChase 的連結不追擊', t => {
  const { logs } = phantomFight(t);
  const pairs = [];
  logs.forEach((log, i) => { if (log.message.startsWith('勇者 使出撕裂')) pairs.push([log, logs.slice(i + 1).find(l => l.message.startsWith('勇者的幻影 隨之追擊'))]); });
  assert.ok(pairs.length > 0);
  for (const [cast, chase] of pairs) assert.equal(chase.targetId, cast.targetId);
  t.mock.restoreAll();
  assert.equal(phantomFight(t, { chase: false }).logs.filter(l => l.message.includes('隨之追擊')).length, 0);
});

test('幻影戰斧：自己倒下時幻影一起消失，勝負只看自己；穿上時接好', t => {
  const { result, engine } = phantomFight(t, { heroHp: 600, turns: 10 });
  assert.equal(result.winner, 'TEAM_B');
  assert.equal(engine.teamA.find(e => e.gemPhantom === true).isAlive, false);
  let state = save.addGems(fresh(), 'rend', 1);
  const added = save.addLegendary(state, 'phantomaxe', 15, () => 0.9999999);
  state = save.equip(save.setLinks(added.save, added.id, [{ active: 'rend', supports: [] }]), added.id);
  assert.equal(save.equippedLinks(state)[0].phantomChase, true);
  assert.deepEqual(save.equippedMechanics(state).map(m => m.type), ['phantom']);
  assert.equal(save.equippedEffects(state).summonHp, LEGENDARIES.phantomaxe.unique[1].max);
  assert.ok(save.compileEquipped(state).passives.some(p => p.id === 'legend_phantom'));
});

test('分解傳說裝備（2026-11-20）：鑲著的寶石退回背包、穿著的會脫下；獎勵還沒定，不給刻印', () => {
  let state = save.addGems(save.addGems(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), 'magicmissile', 1), 'heavy', 1);
  const legend = save.addLegendary(state, 'omen', 15);
  state = save.equip(legend.save, legend.id);
  state = save.setLinks(state, legend.id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  assert.equal(state.gems.heavy ?? 0, 0);
  const result = save.salvageEquipment(state, legend.id);
  assert.equal(result.save.equipped.weapon, null);
  assert.equal(result.save.gems.heavy, 1);
  assert.equal(result.save.equipment.length, 0);
  assert.deepEqual(result.save.engravings, state.engravings);
  assert.deepEqual(save.validateSave(result.save), []);
});

test('黑骰（2026-11-20）：分解傳說裝備得 1 顆；重置消耗 1 顆，依掉落階級重擲基礎與特殊詞綴，權重與連結不變', () => {
  const { BLACK_DICE_PER_SALVAGE, BLACK_DICE_REROLL_COST } = save;
  assert.equal(BLACK_DICE_PER_SALVAGE, 1);
  assert.equal(BLACK_DICE_REROLL_COST, 1);
  let state = save.addGems(save.addGems(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), 'magicmissile', 1), 'heavy', 1);
  assert.equal(state.blackDice, 0);
  const keep = save.addLegendary(state, 'omen', 15, () => 0);              // 第 5 階、最低值
  assert.equal(keep.save.equipment[0].tier, 5);
  const junk = save.addLegendary(keep.save, 'linkdagger', 3);
  state = save.setLinks(junk.save, keep.id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  assert.throws(() => save.rerollLegendary(state, keep.id), /黑骰不足/);
  const salvaged = save.salvageEquipment(state, junk.id);
  assert.equal(salvaged.blackDice, 1);
  assert.equal(salvaged.save.blackDice, 1);
  const before = salvaged.save.equipment.find(i => i.id === keep.id);
  const rolled = save.rerollLegendary(salvaged.save, keep.id, () => 0.9999999);
  const after = rolled.save.equipment.find(i => i.id === keep.id);
  assert.equal(rolled.save.blackDice, 0);
  assert.deepEqual(after.base, [{ stat: 'int', op: 'flat', value: OMEN_INT }]);   // 第 5 階滿值
  assert.deepEqual(after.affixes, [{ scope: 'wearer', stat: 'int', op: 'inc', value: OMEN_INC, source: 'legendary:omen' }]);
  assert.deepEqual(rolled.before.base, before.base);
  assert.deepEqual(rolled.after.base, after.base);
  assert.equal(after.castWeight, before.castWeight);
  assert.deepEqual(after.links, before.links);
  assert.equal(after.tier, 5);
  assert.equal(salvaged.save.blackDice, 1);                                  // 原存檔不變
  assert.throws(() => save.rerollLegendary(rolled.save, keep.id), /黑骰不足/);
  const craftId = save.addEquipment({ ...salvaged.save }, { slot: 'weapon', origin: 'drop', base: [], affixes: [] });
  assert.throws(() => save.rerollLegendary(craftId.save, craftId.id), /不是傳說裝備/);
  // 低階掉落的重置仍是低階縮放
  const low = save.addLegendary({ ...salvaged.save }, 'omen', 1, () => 0.9999999);
  const lowRolled = save.rerollLegendary(low.save, low.id, () => 0.9999999).save.equipment.find(i => i.id === low.id);
  assert.equal(lowRolled.base[0].value, Math.round(OMEN_INT * TIER_SCALE[1]));
  assert.deepEqual(save.validateSave(rolled.save), []);
});

test('存檔 v8 遷移：加 blackDice: 0，舊傳說裝備從數值反推掉落階級', () => {
  const { inferLegendaryTier } = require('./legendaryTable');
  for (const difficulty of [1, 4, 7, 10, 13, 15]) {
    for (const r of [0, 0.5, 0.9999999]) {
      for (const id of Object.keys(LEGENDARIES)) {
        const item = rollLegendary(id, difficulty, () => r);
        const { tier, ...old } = item;
        const guess = inferLegendaryTier(old);
        // 0.7～1 的區間在相鄰階級邊界會重疊（例如第 4 階滿值 ≈ 第 5 階最低），重疊時取高階；其餘必須猜對
        assert.ok(guess === tier || guess === tier + 1, `${id} 難度 ${difficulty} r=${r}：猜 ${guess}，實際 ${tier}`);
      }
    }
  }
  const legend = save.addLegendary(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), 'omen', 7, () => 0.5);
  const v7 = structuredClone(legend.save);
  v7.version = 7;
  delete v7.blackDice;
  delete v7.equipment[0].tier;
  const upgraded = save.migrateSave(v7);
  assert.equal(upgraded.blackDice, 0);
  assert.equal(upgraded.equipment[0].tier, 3);
  assert.deepEqual(save.validateSave(upgraded), []);
});

test('傳說削弱（2026-11-21）不改舊存檔：已有的傳說武器數值照舊（使用者決定），遷移不動數值', () => {
  const r = save.addLegendary(save.createEmptySave({ now: '2026-11-21T00:00:00Z' }), 'linkdagger', 15, () => 0.9999999);
  const old = structuredClone(r.save);
  old.equipment[0].base[0].value = 532;                                     // 削弱前的上限
  assert.deepEqual(save.validateSave(old), []);
  assert.equal(save.migrateSave(old).equipment[0].base[0].value, 532);
});
