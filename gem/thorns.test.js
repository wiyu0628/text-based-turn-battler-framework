'use strict';

// 荊棘（2026-11-23 使用者設計，光環；第三區王的獎勵）。執行：node --test gem/thorns.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout, GemLinkError } = require('./gemCompiler');
const { ACTIVE_GEMS, BOSS_REWARD_GEMS } = require('./gems');
const { BOSSES } = require('./bosses');

const TH = ACTIVE_GEMS.thorns;
const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });

function battle({ def = 300, foeDef = 0, foeAtk = 200, foeHp = 1e6, sp = 200, turns = 5, seed = 3, foePassives = [], heroEva = 0, hitFormula, heroAtk = 100, heroShield = 0 } = {}) {
  const loadout = compileLoadout([{ active: 'thorns', supports: [] }]);
  const hero = new Entity({ id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 1e6, maxHp: 1e6, sp, maxSp: Math.max(sp, 1), atk: heroAtk, def, spd: 200, cri: 0, eva: heroEva, skillCastRate: 0.9 } });
  const foe = new Entity({ id: 'foe', name: '野犬', team: 'B', normalAttack: plain, passives: foePassives,
    stats: { hp: foeHp, maxHp: foeHp, sp: 0, atk: foeAtk, def: foeDef, spd: 150 } });
  if (heroShield) hero.addBuff({ id: 'test_shield', name: '護盾', duration: 1e6, shield: heroShield, polarity: 'positive', dispellable: false });
  const result = new BattleEngine([hero], [foe], { rng: createSeededRandom(seed), maxTurns: turns, skillSelectionResolver: loadout.resolver, hitFormula }).start();
  return { result, logs: result.logs.filter(log => log.message), hero, foe };
}
const isReflect = log => log.skillId === 'thorns' && log.type === 'DAMAGE';
// 每一次反彈和它前面那一擊配對：[受到的傷害, 反彈]
function pairs(logs) {
  const out = [];
  for (let i = 1; i < logs.length; i++) if (isReflect(logs[i])) out.push([logs[i - 1].value, logs[i].value]);
  return out;
}

test('荊棘：開啟（不扣 SP）並多行動一次；之後被攻擊擊中就反彈，戰報照使用者的文字', () => {
  const { logs, hero } = battle();
  const open = logs.findIndex(log => log.message === '勇者開啟了荊棘！');
  assert.ok(open >= 0);
  assert.equal(logs[open + 1].actorId, 'hero', '開啟後立刻多行動一次');
  const reflect = logs.find(isReflect);
  assert.match(reflect.message, /^勇者身上的荊棘反彈了\d+點傷害給野犬！$/);
  assert.equal(logs.slice(0, open).filter(isReflect).length, 0, '開啟前不反彈');
  assert.ok(hero.buffs.some(b => b.name === '荊棘'));
});

test('荊棘：反彈 = 扣血 ×（防禦＋300）× 倍率 × 300 ÷（攻擊者防禦＋300）；自己的防禦不影響反彈量', () => {
  const ratio = TH.aura.ratio;
  for (const def of [0, 300, 900]) {
    const list = pairs(battle({ def }).logs);
    assert.ok(list.length >= 3);
    for (const [taken, back] of list) assert.ok(Math.abs(back - Math.floor(taken * (def + 300) * ratio)) <= 1, `def ${def}: ${taken} → ${back}`);
    // 對方攻擊 200：反彈 ≈ 200 × 300 × 倍率（± 浮動），和自己的防禦無關
    const mean = list.reduce((a, [, b]) => a + b, 0) / list.length;
    const expect = 200 * 300 * ratio;
    assert.ok(mean > expect * 0.85 && mean < expect * 1.15, `def ${def}: 平均反彈 ${mean}`);
  }
  const armored = pairs(battle({ foeDef: 300 }).logs);
  for (const [taken, back] of armored) assert.ok(Math.abs(back - Math.floor(taken * 600 * ratio * 0.5)) <= 1, '再吃攻擊者防禦（300 → ×0.5）');
});

test('荊棘：每回合開始付 SP；付不起的回合寫提示、不反彈；開啟的那一回合免費', () => {
  const { logs, hero } = battle({ sp: TH.spCost + 3, turns: 4 });
  const low = logs.findIndex(log => log.message === '勇者 的 SP 不足，荊棘沒有發動。');
  assert.ok(low >= 0);
  const next = logs.findIndex((log, i) => i > low && log.message.startsWith('--- 第'));
  const window = logs.slice(low, next < 0 ? undefined : next);
  assert.ok(window.some(log => log.actorId === 'foe' && log.value > 0), '那一回合有被打');
  assert.equal(window.filter(isReflect).length, 0);
  assert.ok(hero.stats.sp >= 0);
});

test('荊棘：被閃避、持續傷害不反彈；反彈可以打倒攻擊者', () => {
  // 閃避極高（遊戲用的對抗式命中）：野犬的攻擊全部落空 → 沒有反彈
  const dodge = battle({ heroEva: 1e6, hitFormula: 'contest' });
  const misses = dodge.logs.filter(log => log.actorId === 'foe' && log.type === 'MISS').length;
  assert.ok(misses >= 5);
  // 對抗式命中沒有 100% 閃避：偶爾打中的那幾下才反彈，被躲開的不反彈
  for (let i = 1; i < dodge.logs.length; i++) if (isReflect(dodge.logs[i])) assert.equal(dodge.logs[i - 1].type, 'DAMAGE');
  for (let i = 0; i + 1 < dodge.logs.length; i++) if (dodge.logs[i].actorId === 'foe' && dodge.logs[i].type === 'MISS') assert.ok(!isReflect(dodge.logs[i + 1]));
  assert.ok(dodge.logs.filter(isReflect).length < misses);
  // 非攻擊來源的傷害（持續傷害、共鳴爆發這類直接扣血）不觸發
  const poison = { id: 'poison', trigger: 'ROUND_START', action(self, round, logger, engine) {
    const hero = engine.teamA[0];
    const hit = hero.takeDamage(50, logger, { source: 'DIRECT', tags: ['poison'] });
    logger.addLog({ type: 'DAMAGE', actorId: self.id, targetId: hero.id, value: hit.actualDamage, message: `毒 ${hit.actualDamage}` });
  } };
  const dot = battle({ foeAtk: 0, foePassives: [poison] });
  assert.ok(dot.logs.some(log => log.message.startsWith('毒 ')));
  assert.equal(dot.logs.filter(isReflect).filter(log => log.value > 1).length, 0);
  for (let i = 1; i < dot.logs.length; i++) if (isReflect(dot.logs[i])) assert.equal(dot.logs[i - 1].actorId, 'foe', '反彈只跟在攻擊後面');
  // 攻擊者血很少：被反彈打倒
  const kill = battle({ foeHp: 300, foeAtk: 400, turns: 6, heroAtk: 1 });
  assert.equal(kill.result.winner, 'TEAM_A');
  const death = kill.logs.findIndex(log => log.type === 'DEATH' && log.actorId === 'foe');
  assert.ok(isReflect(kill.logs[death - 1]), '最後一下是荊棘');
});

test('荊棘：反彈的戰報用持續傷害的顏色（logStyle dot）', () => {
  const reflects = battle().logs.filter(isReflect);
  assert.ok(reflects.length > 0);
  for (const log of reflects) assert.equal(log.logStyle, 'dot');
});

test('荊棘：打在護盾上也反彈（整擊被吃光、部分吸收都算，量＝扣血＋吸收）', () => {
  const ratio = TH.aura.ratio;
  // 護盾很厚：整擊都被吸收，沒扣血也照樣反彈
  const full = battle({ heroShield: 1e7 });
  assert.equal(full.hero.stats.hp, 1e6, '沒扣到血');
  const reflects = full.logs.filter(isReflect);
  assert.ok(reflects.length >= 2, '被護盾吸收的攻擊也反彈');
  const mean = reflects.reduce((a, log) => a + log.value, 0) / reflects.length;
  const expect = 200 * 300 * ratio;
  assert.ok(mean > expect * 0.85 && mean < expect * 1.15, `平均 ${mean}，預期約 ${expect}`);
  // 護盾很薄：第一擊部分吸收，反彈量和沒護盾時一樣（扣血＋吸收）
  const thin = battle({ heroShield: 10 });
  const none = battle();
  assert.deepEqual(thin.logs.filter(isReflect).map(log => log.value), none.logs.filter(isReflect).map(log => log.value));
  // 被閃避仍然不反彈（沒有吸收也沒有扣血）
  for (let i = 1; i < full.logs.length; i++) if (isReflect(full.logs[i])) assert.notEqual(full.logs[i - 1].type, 'MISS');
});

test('荊棘：只能連佈局、撒手鐧；列在王的獎勵但目前沒有王給', () => {
  assert.throws(() => compileLoadout([{ active: 'thorns', supports: ['heavy'] }]), GemLinkError);
  assert.doesNotThrow(() => compileLoadout([{ active: 'thorns', supports: ['layout'] }]));
  assert.ok(BOSS_REWARD_GEMS.includes('thorns'));
  assert.ok(!BOSSES.some(boss => boss.rewards?.gems?.includes('thorns')));
});
