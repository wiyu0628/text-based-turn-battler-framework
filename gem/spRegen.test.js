const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { compileLoadout } = require('./gemCompiler');

// 勇者只普攻（每擊扣 2）、怪物打不痛；比較有無 SP 回復的結果
function fight(t, spRegen, { spd = 100 } = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  const loadout = compileLoadout([{ active: 'whirlwind' }], { equipment: { spRegen } });
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
    normalAttackSpCost: 2, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 1e6, maxHp: 1e6, sp: 100, maxSp: 100, atk: 10, def: 0, spd, skillCastRate: 0 } });
  const foe = new Entity({ id: 'f', name: 'f', team: 'B', normalAttack: new Skill({ id: 'fa', name: 'fa', actions: [{ type: 'DAMAGE' }] }),
    stats: { hp: 1e9, maxHp: 1e9, sp: 100, maxSp: 100, atk: 1, def: 0, spd: 100 } });
  const engine = new BattleEngine([hero], [foe], { maxTurns: 10, rng: createSeededRandom(3), skillSelectionResolver: loadout.resolver });
  engine.start();
  const slots = engine.actionSlots.filter(slot => slot.actor === hero).length;
  return { hero, slots, logs: engine.logger.logs, loadout };
}

test('SP regen restores SP at the end of each of the wearer own action slots, silently', t => {
  const without = fight(t, 0);
  const withRegen = fight(t, 1);
  assert.ok(!without.loadout.passives.some(p => p.id === 'gem_equipment_spRegen'));
  assert.ok(withRegen.loadout.passives.some(p => p.id === 'gem_equipment_spRegen'));
  assert.equal(withRegen.slots, without.slots);
  assert.equal(withRegen.hero.stats.sp - without.hero.stats.sp, withRegen.slots);   // 每槽 +1，同一串亂數
  assert.equal(withRegen.logs.length, without.logs.length);                         // 不寫戰報
});

test('fractional regen carries over: 0.5 per slot = 1 SP every two slots', t => {
  const without = fight(t, 0);
  const half = fight(t, 0.5);
  assert.equal(half.hero.stats.sp - without.hero.stats.sp, Math.floor(half.slots * 0.5));
});

test('regen never exceeds max SP and bad values are rejected', t => {
  const full = fight(t, 50);
  assert.ok(full.hero.stats.sp <= full.hero.stats.maxSp);
  assert.throws(() => compileLoadout([{ active: 'whirlwind' }], { equipment: { spRegen: -1 } }), /spRegen/);
});
