const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');

// ───────────── 對抗式命中 hitFormula: 'contest'（1.0.59） ─────────────
const make = (id, team, stats = {}) => new Entity({
  id, name: id, team, normalAttack: new Skill({ id: `${id}_hit`, name: 'hit', actions: [{ type: 'DAMAGE' }] }),
  stats: { hp: 1e9, maxHp: 1e9, sp: 1000, maxSp: 1000, atk: 10, def: 0, spd: 100, ...stats }
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('contest 閃避機率：(100 + max(0, 差距)) / (200 + |差距|)，初始命中 200', () => {
  assert.equal(Formulas.CONTEST_BASE_HIT, 200);
  close(Formulas.contestEvadeChance(0, 0), 0.25);        // 差距 −200
  close(Formulas.contestEvadeChance(0, 200), 0.5);       // 相等
  close(Formulas.contestEvadeChance(100, 0), 0.2);       // −300
  close(Formulas.contestEvadeChance(0, 300), 200 / 300); // +100
  close(Formulas.contestEvadeChance(600, 0), 0.1);       // −800
  // 以 50% 為中心對稱
  for (const gap of [10, 75, 300, 1500]) close(Formulas.contestEvadeChance(0, 200 + gap) + Formulas.contestEvadeChance(gap, 200), 1);
  // 負值當 0
  close(Formulas.contestEvadeChance(-50, -50), 0.25);
});

test('contest isHit：命中率 = (1 − 閃避機率) × accuracy + 修正，夾在 10%～100%，只擲一次骰', t => {
  const a = make('a', 'A');
  const b = make('b', 'B');
  let calls = 0;
  const at = value => () => { calls++; return value; };
  t.mock.method(Math, 'random', at(0.7499));
  assert.equal(Formulas.isHit(a, b, 1, 0, 'contest'), true);
  t.mock.method(Math, 'random', at(0.75));
  assert.equal(Formulas.isHit(a, b, 1, 0, 'contest'), false);
  t.mock.method(Math, 'random', at(0.3749));
  assert.equal(Formulas.isHit(a, b, 0.5, 0, 'contest'), true);           // 0.75 × 0.5
  t.mock.method(Math, 'random', at(0.3751));
  assert.equal(Formulas.isHit(a, b, 0.5, 0, 'contest'), false);
  t.mock.method(Math, 'random', at(0.8499));
  assert.equal(Formulas.isHit(a, b, 1, 0.1, 'contest'), true);           // + 修正
  t.mock.method(Math, 'random', at(0.0999));
  assert.equal(Formulas.isHit(a, make('ghost', 'B', { eva: 1e9 }), 1, 0, 'contest'), true);   // 保底 10%
  t.mock.method(Math, 'random', at(0.9999));
  assert.equal(Formulas.isHit(make('ace', 'A', { hit: 1e9 }), b, 1, 0.5, 'contest'), true);   // 上限 100%（仍擲一次骰）
  assert.equal(calls, 7);
});

test('classic（預設）結果不變：對方沒有閃避時一定命中；未知公式拋錯', t => {
  const a = make('a', 'A');
  t.mock.method(Math, 'random', () => 0.9999);
  assert.equal(Formulas.isHit(a, make('b', 'B')), true);
  assert.equal(Formulas.isHit(a, make('b', 'B'), 1, 0, 'classic'), true);
  assert.equal(Formulas.isHit(a, make('b', 'B', { eva: 100 })), false);   // 1 − 0.5 = 50%
  assert.throws(() => Formulas.isHit(a, make('b', 'B'), 1, 0, 'luck'), /hitFormula/);
  assert.throws(() => new BattleEngine([a], [make('b', 'B')], { hitFormula: 'luck' }), /hitFormula/);
});

function duel(hitFormula, foeStats = {}) {
  const hero = make('hero', 'A', { spd: 100 });
  const foe = make('foe', 'B', { spd: 100, ...foeStats });
  const engine = new BattleEngine([hero], [foe], { maxTurns: 40, rng: createSeededRandom(11), ...(hitFormula ? { hitFormula } : {}) });
  engine.start();
  const logs = engine.logger.logs.filter(l => l.actorId === 'hero' && (l.type === 'DAMAGE' || l.type === 'MISS'));
  return { messages: engine.logger.logs.map(l => l.message), misses: logs.filter(l => l.type === 'MISS').length, total: logs.length };
}

test('引擎選項：沒寫或寫 classic 戰報一字不差；contest 在初始值下約 25% 打空', () => {
  assert.deepEqual(duel('classic').messages, duel(undefined).messages);
  assert.equal(duel(undefined).misses, 0);
  const contest = duel('contest');
  assert.ok(contest.total >= 60, `attacks ${contest.total}`);
  const rate = contest.misses / contest.total;
  assert.ok(rate > 0.15 && rate < 0.35, `miss rate ${rate}`);
  // 閃避高的一方打空更多
  const evasive = duel('contest', { eva: 400 });
  assert.ok(evasive.misses / evasive.total > 0.5, `miss rate ${evasive.misses / evasive.total}`);
});
