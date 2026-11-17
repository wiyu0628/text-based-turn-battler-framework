const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { ENGRAVING_TYPES, rollEngraving } = require('./affixTable');
const { applyStatBonuses, STAT_DEFS } = require('./statLayer');
const { KIND_SHARES } = require('./craftTable');

test('deft engraving: hit +150, eva +50, SPD +12% (tier 5, full roll), integer flat values', () => {
  const deft = ENGRAVING_TYPES.deft;
  assert.equal(deft.name, '靈巧');
  assert.deepEqual(deft.lines.map(l => [l.stat, l.op, l.max]), [['hit', 'flat', 150], ['eva', 'flat', 50], ['spd', 'inc', 0.12]]);
  const lines = rollEngraving('deft', 3, scripted(0.99, 0.5, 0.5));   // 落選第 3 行；命中與閃避各擲 0.85
  assert.deepEqual(lines.map(l => [l.stat, l.value]), [['hit', Math.round(150 * 0.55 * 0.85)], ['eva', Math.round(50 * 0.55 * 0.85)]]);
  assert.ok(KIND_SHARES.deft, '製作裝備也能投入靈巧');
});
function scripted(...values) { return () => (values.length ? values.shift() : 1); }

test('hit and eva are stats of the bonus layer', () => {
  assert.ok(STAT_DEFS.hit && STAT_DEFS.eva);
  const stats = applyStatBonuses({ hp: 100, atk: 10, spd: 100 }, [
    { stat: 'hit', op: 'flat', value: 150 }, { stat: 'eva', op: 'flat', value: 50 }, { stat: 'eva', op: 'flat', value: 30.6 }]);
  assert.equal(stats.hit, 150);
  assert.equal(stats.eva, 81);
});

test('with the contest formula, eva on the hero makes the monster miss more and hit on the hero misses less', () => {
  const make = (id, team, stats) => new Entity({ id, name: id, team, normalAttack: new Skill({ id: `${id}_a`, name: 'a', actions: [{ type: 'DAMAGE' }] }),
    stats: { hp: 1e9, maxHp: 1e9, sp: 1e4, maxSp: 1e4, atk: 10, def: 0, spd: 100, ...stats } });
  const missRate = (heroStats, side) => {
    const hero = make('h', 'A', heroStats);
    const foe = make('f', 'B', {});
    const engine = new BattleEngine([hero], [foe], { maxTurns: 300, rng: createSeededRandom(2), hitFormula: 'contest' });
    engine.start();
    const logs = engine.logger.logs.filter(l => l.actorId === side && (l.type === 'DAMAGE' || l.type === 'MISS'));
    return logs.filter(l => l.type === 'MISS').length / logs.length;
  };
  const base = missRate({}, 'f');
  assert.ok(Math.abs(base - 0.25) < 0.05, `base ${base}`);
  assert.ok(Math.abs(missRate({ eva: 200 }, 'f') - 0.5) < 0.06);                                  // 差距 0
  assert.ok(Math.abs(missRate({ hit: 600 }, 'h') - Formulas.contestEvadeChance(600, 0)) < 0.04);  // 10%
});
