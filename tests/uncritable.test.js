const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

// ───────────── uncritable（1.0.57） ─────────────
// 傷害固定 10、必定命中，爆擊倍率 2，這樣「有沒有爆擊」直接看得出來：爆擊 20、沒爆擊 10。
const strike = (extra = {}, actions = [{ type: 'DAMAGE', hits: 3 }]) =>
  new Skill({ id: 'strike', name: '斬擊', actions, ...extra });

function setup(t, skill, { cri = 1 } = {}) {
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  const make = (id, team, stats = {}) => new Entity({ id, name: id, team,
    stats: { hp: 1000, maxHp: 1000, sp: 30, atk: 10, spd: 1, criDmg: 2, ...stats }, normalAttack: strike() });
  // 攻擊方爆擊率 100%：沒有 uncritable 的話每一擊都一定爆擊。
  const a = make('a', 'A', { cri });
  const b = make('b', 'B');
  const engine = new BattleEngine([a], [b]);
  const run = () => skill.execute(a, [a], [b], engine.logger, engine);
  return { a, b, engine, run };
}

const hits = engine => engine.logger.logs.filter(log => log.type === 'DAMAGE');

test('without uncritable a 100% crit rate still crits every hit (default unchanged)', t => {
  const { b, engine, run } = setup(t, strike());
  run();
  assert.equal(b.stats.hp, 1000 - 60);
  assert.deepEqual(hits(engine).map(log => log.isCrit), [true, true, true]);
  assert.ok(hits(engine)[0].message.includes('會心一擊！'));
});

test('an uncritable skill never crits, even at 100% crit rate', t => {
  const { b, engine, run } = setup(t, strike({ uncritable: true }));
  run();
  assert.equal(b.stats.hp, 1000 - 30);
  assert.deepEqual(hits(engine).map(log => log.isCrit), [false, false, false]);
  assert.ok(!hits(engine).some(log => log.message.includes('會心一擊')));
});

test('an uncritable skill never rolls the crit check, so it is exclusion rather than a low chance', t => {
  const { run } = setup(t, strike({ uncritable: true }));
  let rolls = 0;
  t.mock.method(Formulas, 'isCritical', () => { rolls++; return true; });
  run();
  assert.equal(rolls, 0);
});

test('a skill without uncritable rolls once per landed hit, as before', t => {
  const { run } = setup(t, strike());
  let rolls = 0;
  t.mock.method(Formulas, 'isCritical', () => { rolls++; return false; });
  run();
  assert.equal(rolls, 3);
});

test('an uncritable action only protects its own hits', t => {
  const { b, engine, run } = setup(t, strike({}, [
    { type: 'DAMAGE', uncritable: true },
    { type: 'DAMAGE' }
  ]));
  run();
  assert.deepEqual(hits(engine).map(log => log.isCrit), [false, true]);
  assert.equal(b.stats.hp, 1000 - 10 - 20);
});

test('a crit buff cannot override uncritable: the check is skipped, not lowered', t => {
  // 爆擊率本來是 0，再用 STAT Buff 加到 100%（寶石的爆擊強化就是這樣做的）。
  const { a, b, run } = setup(t, strike({ uncritable: true }), { cri: 0 });
  a.addBuff({ id: 'critup', type: 'STAT', duration: 1, effect: stats => { stats.cri += 1; } });
  run();
  assert.equal(b.stats.hp, 1000 - 30);
});

test('a counter reply uses the replying skill own uncritable flag', t => {
  // 被反擊的一方出的招是 counterSkill，爆擊與否看它自己的旗標，不看被反擊的那一招。
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'calculateDamage', () => 10);
  t.mock.method(Formulas, 'isCounter', () => true);
  const counterSkill = new Skill({ id: 'riposte', name: '還擊', uncritable: true, actions: [{ type: 'DAMAGE' }] });
  const a = new Entity({ id: 'a', name: 'a', team: 'A', normalAttack: strike(),
    stats: { hp: 1000, maxHp: 1000, sp: 30, atk: 10, spd: 1000, cri: 1, criDmg: 2 } });
  const b = new Entity({ id: 'b', name: 'b', team: 'B', normalAttack: strike(), counterSkill,
    stats: { hp: 1000, maxHp: 1000, sp: 30, atk: 10, spd: 1000, cri: 1, criDmg: 2, counter: 100 } });
  const engine = new BattleEngine([a], [b]);
  strike({}, [{ type: 'DAMAGE' }]).execute(a, [a], [b], engine.logger, engine);
  const reply = engine.logger.logs.find(log => log.type === 'COUNTER');
  assert.ok(reply);
  assert.equal(reply.isCrit, false);
  assert.equal(a.stats.hp, 1000 - 10);
});

test('uncritable must be a boolean on the skill and on a DAMAGE action', () => {
  assert.throws(() => new Skill({ id: 'oops', name: 'x', uncritable: 'yes' }), /uncritable must be a boolean/);
  assert.throws(() => new Skill({ id: 'oops', name: 'x', actions: [{ type: 'DAMAGE', uncritable: 1 }] }),
    /uncritable requires a DAMAGE action and a boolean/);
  assert.throws(() => new Skill({ id: 'oops', name: 'x', actions: [{ type: 'HEAL', uncritable: true }] }),
    /uncritable requires a DAMAGE action/);
  assert.doesNotThrow(() => new Skill({ id: 'fine', name: 'x', uncritable: true, actions: [{ type: 'DAMAGE', uncritable: false }] }));
  assert.equal(new Skill({ id: 'plain', name: 'x' }).uncritable, false);
});
