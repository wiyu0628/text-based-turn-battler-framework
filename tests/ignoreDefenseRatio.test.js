const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas } = require('../src');

// ───────────── ignoreDefense 比例（1.0.58） ─────────────
// Math.random 固定 0.5，傷害浮動剛好是 ×1.0，數字才能直接比。
const make = (id, team, stats = {}) => new Entity({
  id, name: id, team, normalAttack: new Skill({ id: 'hit', name: 'hit', actions: [{ type: 'DAMAGE' }] }),
  stats: { hp: 100000, maxHp: 100000, sp: 100, atk: 300, int: 300, def: 300, spd: 100, ...stats }
});
const duel = () => ({ a: make('a', 'A'), b: make('b', 'B') });

test('ignoreDefense 比例：防禦先乘上 (1 - 比例) 再進公式', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { a, b } = duel();
  // 攻擊 300、防禦 300：減傷 0.5 → 150。比例 0.5 等於防禦 150：減傷 300/450。
  assert.equal(Formulas.calculateDamage(a, b), 150);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: 0.5 }), 200);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: 0.4 }), Math.floor(300 * 300 / (180 + 300)));
  // 不是「40% 的傷害無視防禦」：高防禦下加成沒有線性補償。
  const tank = make('tank', 'B', { def: 900 });
  assert.equal(Formulas.calculateDamage(a, tank), 75);
  assert.equal(Formulas.calculateDamage(a, tank, 1, 'atk', { ignoreDefense: 0.5 }), Math.floor(300 * 300 / (450 + 300)));
});

test('ignoreDefense：true 等於 1、false 與 0 等於沒有，原本的寫法結果不變', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { a, b } = duel();
  const base = Formulas.calculateDamage(a, b);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: true }), 300);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: 1 }), 300);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: false }), base);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: 0 }), base);
  assert.equal(Formulas.calculateDamage(a, b, 1, 'atk', {}), base);
});

test('ignoreDefense 比例不會改動目標身上的防禦', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const { a, b } = duel();
  Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: 0.5 });
  assert.equal(b.stats.def, 300);
  assert.equal(b.getEffectiveStats().def, 300);
});

test('ignoreDefense 不合法時拋錯：公式、Skill 建構都擋', () => {
  const { a, b } = duel();
  for (const bad of [1.5, -0.1, NaN, Infinity, 'half', null]) {
    assert.throws(() => Formulas.calculateDamage(a, b, 1, 'atk', { ignoreDefense: bad }), /ignoreDefense/);
  }
  for (const bad of [1.5, -0.1, NaN, 'half', null]) {
    assert.throws(() => new Skill({ id: 'x', name: 'x', actions: [{ type: 'DAMAGE', ignoreDefense: bad }] }), /ignoreDefense/);
  }
  assert.throws(() => new Skill({ id: 'x', name: 'x', actions: [{ type: 'HEAL', ignoreDefense: 0.5 }] }), /ignoreDefense requires a DAMAGE action/);
  for (const ok of [true, false, 0, 0.3, 1]) {
    assert.doesNotThrow(() => new Skill({ id: 'x', name: 'x', actions: [{ type: 'DAMAGE', ignoreDefense: ok }] }));
  }
});

test('DAMAGE 段的 ignoreDefense 比例真的進到傷害裡', t => {
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(Formulas, 'isHit', () => true);
  t.mock.method(Formulas, 'isCritical', () => false);
  const run = ignoreDefense => {
    const { a, b } = duel();
    const skill = new Skill({ id: 's', name: 's', actions: [{ type: 'DAMAGE', ...(ignoreDefense === undefined ? {} : { ignoreDefense }) }] });
    const engine = new BattleEngine([a], [b]);
    skill.execute(a, [a], [b], engine.logger, engine);
    return 100000 - b.stats.hp;
  };
  assert.equal(run(undefined), 150);
  assert.equal(run(0.5), 200);
  assert.equal(run(true), 300);
});
