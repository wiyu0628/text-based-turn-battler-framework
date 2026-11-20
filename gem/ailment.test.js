const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { compileSkill, compileLoadout } = require('./gemCompiler');
const { ACTIVE_GEMS } = require('./gems');

const damageAction = result => (result.release ?? result.skill).actions.find(a => a.type === 'DAMAGE');
const logger = () => ({ logs: [], addLog(entry) { this.logs.push(entry); } });
const unit = (id, team, stats) => new Entity({ id, name: id, team, normalAttack: new Skill({ id: `${id}_na`, name: 'na', actions: [{ type: 'DAMAGE' }] }),
  stats: { hp: 1e6, maxHp: 1e6, sp: 100, atk: 100, def: 0, spd: 100, ...stats } });
// 直接觸發被動（等於「這一擊命中且目標活著」）
const strike = (compiled, caster, target, log, damage = 100) => {
  const passive = compiled.passives.find(p => p.trigger === 'AFTER_DAMAGE_DEALT');
  const hit = { skill: compiled.release ?? compiled.skill, action: damageAction(compiled), target, caster, damage };
  assert.ok(passive.enabled(caster, hit));
  passive.action(caster, hit, log, null);
};
// 目標的一個行動槽：開頭發作 DOT、結尾倒數
const targetSlot = (target, log) => {
  const before = log.logs.length;
  for (const buff of [...target.buffs]) buff.onPreTurn(target, log, null);
  target.tickBuffs();
  return log.logs.slice(before).filter(l => l.type === 'BUFF_EFFECT' && l.buffType === 'DOT').length;
};

// ── 編譯 ──────────────────────────────────────────────────

test('rend is a physical single-target 120% hit costing 14 SP (balanced from 10) that carries a 20% / 2-slot bleed (3 → 2, 2026-11-20)', () => {
  const gem = ACTIVE_GEMS.rend;
  assert.equal(gem.name, '撕裂');
  assert.equal(gem.spCost, 14);   // 平衡：10 → 16（第一輪方案 A）→ 14（第二輪，使用者決定）
  assert.ok(gem.tags.includes('attack') && !gem.tags.includes('spell'));
  const compiled = compileSkill('rend');
  const action = damageAction(compiled);
  assert.equal(action.power, 1.2);
  assert.equal(action.targetType, 'ENEMY_SINGLE');
  assert.equal(action.stat, undefined);           // 吃 atk、可暴擊
  assert.equal(action.ailments, undefined);       // 資料欄位不送進框架
  assert.deepEqual(action.gemAilments, [{ kind: 'bleed', basis: 'stat', power: 0.2, duration: 2 }]);
  assert.equal(compiled.spCost, 14);
  assert.equal(compiled.passives.length, 1);
  assert.equal(compileSkill('whirlwind').passives.length, 0);   // 沒有異常的技能不多掛被動
});

test('pursuit is a physical single-target 100% hit costing 15 SP that carries a 60%-of-hit / 1-slot lingering blade (2026-11-20)', () => {
  const gem = ACTIVE_GEMS.pursuit;
  assert.equal(gem.name, '追刃');
  assert.equal(gem.spCost, 15);
  assert.ok(gem.tags.includes('attack') && !gem.tags.includes('spell'));
  const action = damageAction(compileSkill('pursuit'));
  assert.equal(action.power, 1.0);
  assert.equal(action.targetType, 'ENEMY_SINGLE');
  assert.deepEqual(action.gemAilments, [{ kind: 'lingering', basis: 'hit', power: 0.6, duration: 1 }]);
});

test('ailment power is not scaled by gem inc / more or equipment damage (the hit power still is)', () => {
  for (const options of [{}, { equipment: { physDmg: 0.5 } }]) {
    for (const supports of [[], ['amp'], ['heavy']]) {
      assert.equal(damageAction(compileSkill('rend', supports, options)).gemAilments[0].power, 0.2);
      assert.equal(damageAction(compileSkill('pursuit', supports, options)).gemAilments[0].power, 0.6);
    }
  }
  assert.equal(damageAction(compileSkill('rend', ['amp'])).power, 1.44);
});

test('equipment ailment damage multiplies both bleed and lingering blade in their own additive zone', () => {
  assert.equal(damageAction(compileSkill('rend', [], { equipment: { ailmentDmg: 0.5 } })).gemAilments[0].power, 0.3);
  assert.equal(damageAction(compileSkill('pursuit', [], { equipment: { ailmentDmg: 0.5 } })).gemAilments[0].power, 0.9);
  // 與物理傷害提高分開：物理提高只改命中，異常增加只改異常
  const both = damageAction(compileSkill('rend', ['amp'], { equipment: { physDmg: 0.3, ailmentDmg: 0.2 } }));
  assert.equal(both.power, 1.8);                     // 1.2 × (1 + 0.2 + 0.3)
  assert.equal(both.gemAilments[0].power, 0.24);     // 0.2 × (1 + 0.2)
  assert.equal(damageAction(compileSkill('whirlwind', [], { equipment: { ailmentDmg: 0.5 } })).power, ACTIVE_GEMS.whirlwind.actions[0].power);   // 沒有異常的技能不受影響
  assert.throws(() => compileSkill('rend', [], { equipment: { ailmentDmg: -0.1 } }), /ailmentDmg/);
});

test('ailment damage boosts the snapshot value in battle terms', () => {
  const log = logger();
  const foe = unit('f', 'B', {});
  strike(compileSkill('rend', [], { equipment: { ailmentDmg: 0.5 } }), unit('h', 'A', { atk: 100 }), foe, log);
  strike(compileSkill('pursuit', [], { equipment: { ailmentDmg: 0.5 } }), unit('h', 'A', {}), foe, log, 80);
  assert.deepEqual(foe.buffs.map(b => b.value), [30, 72]);   // 100 × 0.2 × 1.5、80 × 0.6 × 1.5
});

test('equipment ailment duration adds slots to both bleed and the lingering blade (extendable since 2026-11-20); capped at +1 in the sum (2026-11-20)', () => {
  assert.equal(damageAction(compileSkill('rend', [], { equipment: { ailmentDuration: 2 } })).gemAilments[0].duration, 4);
  assert.equal(damageAction(compileSkill('pursuit', [], { equipment: { ailmentDuration: 2 } })).gemAilments[0].duration, 3);
  assert.throws(() => compileSkill('rend', [], { equipment: { ailmentDuration: 1.5 } }), /整數/);
  const { sumEffectAffixes, AILMENT_DURATION_CAP } = require('./affixTable');
  const line = { scope: 'effect', kind: 'ailmentDuration', value: 1 };
  assert.equal(AILMENT_DURATION_CAP, 1);
  assert.equal(sumEffectAffixes([line, line, line, line]).ailmentDuration, 1);
  // 延長後實際多發作：+1 槽 → 3 次
  const log = logger();
  const foe = unit('f', 'B', {});
  strike(compileSkill('rend', [], { equipment: { ailmentDuration: 1 } }), unit('h', 'A', { atk: 100 }), foe, log);
  const ticks = [1, 2, 3, 4].map(() => targetSlot(foe, log));
  assert.deepEqual(ticks, [1, 1, 1, 0]);
});

test('rend links with physical supports and rejects spell-only ones; charge release keeps the bleed', () => {
  for (const support of ['heavy', 'amp', 'pierce', 'leech', 'critup', 'layout', 'trump']) assert.doesNotThrow(() => compileSkill('rend', [support]), support);
  assert.throws(() => compileSkill('rend', ['shock']), /spell/);
  const charged = compileSkill('rend', ['charge']);
  assert.ok(damageAction(charged).gemAilments);
  assert.ok(charged.passives.some(p => p.gemSkillId === 'rend+charge#release'));
});

test('bad ailment data is rejected at compile time', () => {
  const custom = action => ({ activeGems: { x: { id: 'x', name: 'x', tags: [], spCost: 1, actions: [action] } } });
  const ok = { kind: 'bleed', basis: 'stat', power: 0.1, duration: 2 };
  assert.doesNotThrow(() => compileSkill('x', [], custom({ type: 'DAMAGE', ailments: [ok] })));
  assert.throws(() => compileSkill('x', [], custom({ type: 'DAMAGE', ailments: [{ ...ok, kind: 'poison' }] })), /poison/);
  assert.throws(() => compileSkill('x', [], custom({ type: 'DAMAGE', ailments: [{ ...ok, basis: 'def' }] })), /basis/);
  assert.throws(() => compileSkill('x', [], custom({ type: 'DAMAGE', ailments: [{ ...ok, power: 0 }] })), /power/);
  assert.throws(() => compileSkill('x', [], custom({ type: 'DAMAGE', ailments: [{ ...ok, duration: 1.5 }] })), /duration/);
  assert.throws(() => compileSkill('x', [], custom({ type: 'HEAL', ailments: [ok] })), /DAMAGE/);
});

// ── 數值與疊加 ────────────────────────────────────────────

test('bleed damage = caster effective atk × 20%, ignoring defense and damage bonuses, snapshot at the hit', () => {
  const log = logger();
  const hero = unit('h', 'A', { atk: 155 });
  const foe = unit('f', 'B', { def: 300 });
  strike(compileSkill('rend', ['amp', 'heavy'], { equipment: { physDmg: 0.5 } }), hero, foe, log);
  assert.equal(foe.buffs[0].value, 31);                  // 155 × 0.2，不看防禦、不吃加成
  assert.equal(foe.buffs[0].type, 'DOT');
  assert.equal(foe.buffs[0].name, '裂傷');
  assert.deepEqual(log.logs.map(l => [l.type, l.message]), [['BUFF_APPLY', 'f 陷入「裂傷」！']]);
  hero.stats.atk = 1000;                                 // 之後改屬性不影響已掛上的那層
  assert.equal(foe.buffs[0].value, 31);
  // 有效攻擊力：STAT Buff 會算進去
  const buffed = unit('h2', 'A', { atk: 100 });
  buffed.addBuff({ id: 'up', name: 'up', type: 'STAT', duration: 5, effect: s => { s.atk += 50; } });
  strike(compileSkill('rend'), buffed, foe, log);
  assert.equal(foe.buffs[1].value, 30);
});

test('lingering blade damage = 60% of the hit damage shown in the log (floored), ticking once', () => {
  const log = logger();
  const foe = unit('f', 'B', { def: 300 });
  strike(compileSkill('pursuit'), unit('h', 'A', {}), foe, log, 137);
  assert.equal(foe.buffs[0].value, 82);   // floor(137 × 0.6)
  assert.equal(foe.buffs[0].name, '殘刃');
  assert.equal(log.logs[0].message, 'f 陷入「殘刃」！');
  strike(compileSkill('pursuit'), unit('h', 'A', {}), foe, log, 90);   // 疊第二層，各自計時
  assert.equal(targetSlot(foe, log), 2);
  assert.equal(targetSlot(foe, log), 0);
  assert.equal(1e6 - foe.stats.hp, 82 + 54);
});

test('each bleed ticks at the start of the target slot twice, and stacks keep their own timers', () => {
  const log = logger();
  const hero = unit('h', 'A', { atk: 100 });
  const foe = unit('f', 'B', {});
  const compiled = compileSkill('rend');
  strike(compiled, hero, foe, log);           // 第一層
  assert.equal(targetSlot(foe, log), 1);
  strike(compiled, hero, foe, log);           // 第二層，與第一層各自倒數
  assert.equal(foe.buffs.length, 2);
  assert.equal(targetSlot(foe, log), 2);      // 第一層第 2 次發作後消失
  assert.equal(targetSlot(foe, log), 1);      // 只剩第二層的第 2 次
  assert.equal(targetSlot(foe, log), 0);
  assert.equal(foe.buffs.length, 0);
  const ticks = log.logs.filter(l => l.type === 'BUFF_EFFECT');
  assert.ok(ticks.every(l => l.value === 20));   // 100 × 0.2
  assert.equal(1e6 - foe.stats.hp, 4 * 20);
});

// ── 實際戰鬥 ──────────────────────────────────────────────

function fight(t, hit, active = 'rend') {
  t.mock.method(Formulas, 'isHit', () => hit);
  t.mock.method(Formulas, 'isCritical', () => false);
  const loadout = compileLoadout([{ active }]);
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
    skills: loadout.skills, passives: loadout.passives, stats: { hp: 1e6, maxHp: 1e6, sp: 1000, maxSp: 1000, atk: 100, def: 0, spd: 100, skillCastRate: 1 } });
  const foe = new Entity({ id: 'f', name: '魔王', team: 'B', normalAttack: new Skill({ id: 'fa', name: 'fa', actions: [{ type: 'DAMAGE' }] }),
    stats: { hp: 1e9, maxHp: 1e9, sp: 1000, maxSp: 1000, atk: 1, def: 0, spd: 100 } });
  const engine = new BattleEngine([hero], [foe], { maxTurns: 8, rng: createSeededRandom(5), skillSelectionResolver: loadout.resolver });
  engine.start();
  const logs = engine.logger.logs;
  return {
    applied: logs.filter(l => l.type === 'BUFF_APPLY' && l.targetId === 'f' && /陷入/.test(l.message)).length,
    ticks: logs.filter(l => l.type === 'BUFF_EFFECT' && l.buffType === 'DOT' && l.actorId === 'f').length,
    hits: logs.filter(l => l.type === 'DAMAGE' && l.skillId === active && l.actorId === 'h'),
    tickLogs: logs.filter(l => l.type === 'BUFF_EFFECT' && l.buffType === 'DOT' && l.actorId === 'f'),
    remaining: foe.buffs.filter(b => b.id.startsWith('gem_ailment:')).reduce((sum, b) => sum + b.duration, 0),
    left: foe.buffs.filter(b => b.id.startsWith('gem_ailment:'))
  };
}

test('in battle every rend hit applies a bleed, and every applied bleed ticks 2 times (minus what is left at the end)', t => {
  const { applied, ticks, hits, remaining } = fight(t, true);
  assert.ok(hits.length >= 3, `casts ${hits.length}`);
  assert.equal(applied, hits.length);
  assert.equal(ticks, applied * 2 - remaining);
});

test('in battle every pursuit hit is followed once by its 60% lingering blade at the target slot start', t => {
  const { applied, hits, tickLogs, left } = fight(t, true, 'pursuit');
  assert.ok(hits.length >= 3, `casts ${hits.length}`);
  assert.equal(applied, hits.length);
  const pending = left.map(b => b.value);
  assert.deepEqual([...tickLogs.map(l => l.value), ...pending].sort(), hits.map(l => Math.max(1, Math.floor(l.value * 0.6))).sort());
});

test('a missed rend applies nothing', t => {
  const { applied, ticks } = fight(t, false);
  assert.equal(applied, 0);
  assert.equal(ticks, 0);
});

test('an ailment marked extendable: false ignores equipment ailment duration (mechanism kept; no live ailment uses it now)', t => {
  const { AILMENTS } = require('./gems');
  AILMENTS.lingering.extendable = false;
  t.after(() => { delete AILMENTS.lingering.extendable; });
  assert.equal(damageAction(compileSkill('pursuit', [], { equipment: { ailmentDuration: 2 } })).gemAilments[0].duration, 1);
  assert.equal(damageAction(compileSkill('rend', [], { equipment: { ailmentDuration: 2 } })).gemAilments[0].duration, 4);
});
