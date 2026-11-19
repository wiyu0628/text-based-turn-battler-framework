const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BOSSES, findBoss, buildBossEncounter } = require('./bosses');
const { REGIONS } = require('./monsters');
const { strength } = require('./difficulty');
const save = require('./saveLayer');

const starter = () => save.createStarterSave({ now: '2026-01-01T00:00:00Z' });

test('the first boss is a placeholder at difficulty 6 that rewards pursuit and firestorm', () => {
  const boss = BOSSES[0];
  assert.equal(boss.difficulty, 6);
  assert.equal(boss.placeholder, true);
  assert.deepEqual(boss.rewards.gems, ['pursuit', 'firestorm']);
  const { monsters, difficulty } = buildBossEncounter(boss.id);
  assert.equal(difficulty, 6);
  assert.equal(monsters.length, 1);
  assert.equal(monsters[0].stats.maxHp, Math.round(Math.round(3000 * 1.6) * strength(6)));
  assert.throws(() => findBoss('nope'), /找不到王/);
});

test('enrage: below 30% HP the boss hits harder for the rest of the fight, once', () => {
  const [boss] = buildBossEncounter('gatekeeper').monsters;
  const enrage = boss.passives.find(p => p.trigger === 'AFTER_DAMAGE_RECEIVED');
  const logs = [];
  const logger = { addLog: entry => logs.push(entry) };
  const atk = boss.getEffectiveStats().atk;
  boss.stats.hp = Math.floor(boss.stats.maxHp * 0.5);
  assert.equal(enrage.enabled(boss), false);
  boss.stats.hp = Math.floor(boss.stats.maxHp * 0.2);
  assert.equal(enrage.enabled(boss), true);
  enrage.action(boss, {}, logger);
  assert.ok(Math.abs(boss.getEffectiveStats().atk - atk * 1.3) < 1);
  assert.equal(enrage.enabled(boss), false);
  assert.match(logs[0].message, /廢都守門者 的眼中燃起紅光/);
  for (let i = 0; i < 10; i++) boss.tickBuffs();
  assert.ok(Math.abs(boss.getEffectiveStats().atk - atk * 1.3) < 1);   // 持續到戰鬥結束
});

test('bosses unlock in order, old ones stay available; first clear gives rewards once', () => {
  const extra = { id: 'test_second', name: '第二隻王', difficulty: 9, monsters: [], rewards: { gems: [], unlockRegions: ['test_region'] } };
  BOSSES.push(extra);
  REGIONS.test_region = { id: 'test_region', name: '測試區', locked: true, count: [1, 1], budget: 1, monsters: ['dog'] };
  try {
    let state = starter();
    assert.deepEqual(save.bossStatus(state).map(b => [b.id, b.defeated, b.available]), [['gatekeeper', false, true], ['test_second', false, false]]);
    assert.throws(() => save.recordBossVictory(state, 'test_second'), /還沒開放/);
    assert.deepEqual(save.availableRegions(state), ['ruins', 'sewer']);
    const first = save.recordBossVictory(state, 'gatekeeper');
    assert.equal(first.firstClear, true);
    assert.equal(first.save.gems.pursuit, 1);
    assert.equal(first.save.gems.firestorm, 1);
    assert.equal(state.gems.pursuit, undefined);                              // 原存檔不變
    state = first.save;
    assert.deepEqual(save.bossStatus(state).map(b => b.available), [true, true]);
    const again = save.recordBossVictory(state, 'gatekeeper');
    assert.equal(again.firstClear, false);
    assert.equal(again.save.gems.pursuit, 1);                                 // 不重複發
    const second = save.recordBossVictory(state, 'test_second');
    assert.deepEqual(second.rewards.unlockRegions, ['test_region']);
    assert.deepEqual(save.availableRegions(second.save), ['ruins', 'sewer', 'test_region']);
    assert.throws(() => save.recordBossVictory(state, 'nope'), /找不到王/);
  } finally {
    BOSSES.pop();
    delete REGIONS.test_region;
  }
});
