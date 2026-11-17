'use strict';

// 物理與法術拆分的測試。執行：node --test gem/spell.test.js
// 法術：吃智力（int）、不可暴擊、不可反擊。攻擊（物理）：吃攻擊力、可暴擊。兩者都被防禦（def）減傷，沒有魔防。
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { compileSkill, compileLoadout, describeSupport, GemLinkError } = require('./gemCompiler');
const { ACTIVE_GEMS, SUPPORT_GEMS } = require('./gems');
const { STAT_DEFS } = require('./statLayer');

const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });
const hero = (skills, stats = {}) => new Entity({
  id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills,
  stats: { hp: 9000, sp: 900, atk: 100, int: 100, def: 0, spd: 100, cri: 0, skillCastRate: 1, ...stats }
});
const foe = (stats = {}) => new Entity({
  id: 'foe', name: '魔物', team: 'B', normalAttack: plain,
  stats: { hp: 1e9, sp: 0, atk: 1, def: 0, spd: 1, ...stats }
});
// 固定命中、傷害不浮動，回傳這一次施放造成的傷害與戰報。
function cast(t, skill, heroStats, foeStats) {
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(Formulas, 'isHit', () => true);
  const h = hero([skill], heroStats);
  const f = foe(foeStats);
  const engine = new BattleEngine([h], [f]);
  skill.execute(h, [h], [f], engine.logger, engine);
  return { damage: 1e9 - f.stats.hp, logs: engine.logger.logs, foe: f };
}
const spell = (supports = []) => compileSkill('magicmissile', supports).skill;
const attack = (supports = []) => compileSkill('whirlwind', supports).skill;

test('法術寶石的資料：魔法飛彈讀智力、不可暴擊、不可反擊；治癒術讀智力', () => {
  const action = ACTIVE_GEMS.magicmissile.actions[0];
  assert.equal(action.stat, 'int');
  assert.equal(action.defenseStat, undefined, '沒有魔防：法術也吃防禦');
  assert.equal(action.uncritable, true);
  assert.equal(ACTIVE_GEMS.magicmissile.uncounterable, true);
  assert.equal(ACTIVE_GEMS.mend.actions[0].stat, 'int');
  // 旋風斬仍是物理：預設的 atk 與 def，沒有任何額外旗標。
  const whirl = ACTIVE_GEMS.whirlwind.actions[0];
  assert.equal(whirl.stat, undefined);
  assert.equal(whirl.uncritable, undefined);
});

test('編譯後的技能保留這些設定，連結輔助寶石也不會弄丟', () => {
  for (const supports of [[], ['heavy', 'pierce', 'amp'], ['wide', 'shock']]) {   // 爆擊強化已禁止連到法術，見下
    const [first] = spell(supports).actions.filter(action => action.type === 'DAMAGE');
    assert.equal(first.stat, 'int');
    assert.equal(first.uncritable, true);
  }
});

test('法術傷害讀智力，不看攻擊力', t => {
  const strongMind = cast(t, spell(), { atk: 1, int: 200 }).damage;
  const strongBody = cast(t, spell(), { atk: 200, int: 1 }).damage;
  assert.ok(strongMind > strongBody * 50, `智力 ${strongMind} 體力 ${strongBody}`);
});

test('物理傷害讀攻擊力，不看智力', t => {
  const strongBody = cast(t, attack(), { atk: 200, int: 1 }).damage;
  const strongMind = cast(t, attack(), { atk: 1, int: 200 }).damage;
  assert.ok(strongBody > strongMind * 50);
});

test('法術與物理都被防禦減傷', t => {
  for (const make of [spell, attack]) {
    const open = cast(t, make(), {}, {}).damage;
    const def = cast(t, make(), {}, { def: 300 }).damage;
    assert.ok(def < open * 0.6 && def > open * 0.4, `防禦 300 應該約減半：${def} / ${open}`);
  }
});

test('穿甲：法術與攻擊都無視一半防禦', t => {
  for (const make of [spell, attack]) {
    const normal = cast(t, make(), {}, { def: 300 }).damage;
    const pierce = cast(t, make(['pierce']), {}, { def: 300 }).damage;
    // 防禦砍半 → 乘數 0.667（原本 0.5），再乘寶石自己的乘算（平衡後拿掉了 −10%），約是一般的 1.33 倍。
    const more = SUPPORT_GEMS.pierce.effects.filter(e => e.op === 'more').reduce((p, e) => p * (1 + e.value), 1);
    const ratio = (300 / 450) / (300 / 600) * more;
    assert.ok(Math.abs(pierce / normal - ratio) < 0.06, `${pierce} / ${normal}，預期 ${ratio}`);
  }
});

test('穿甲的說明文字帶出比例', () => {
  assert.ok(describeSupport(SUPPORT_GEMS.pierce).lines.some(line => line.text === '無視目標 50% 的防禦'));
  assert.equal(SUPPORT_GEMS.pierce.effects.find(effect => effect.op === 'actionFlag').value, 0.5);
});

test('法術不會爆擊：爆擊率 100% 也一樣；物理照常爆擊', t => {
  const s = cast(t, spell(), { cri: 1 });
  assert.ok(s.logs.filter(log => log.type === 'DAMAGE').every(log => log.isCrit === false));
  const a = cast(t, attack(), { cri: 1 });
  assert.ok(a.logs.filter(log => log.type === 'DAMAGE').every(log => log.isCrit === true));
});

test('爆擊強化不能連到法術（平衡第一輪：法術不擲爆擊骰，連了也沒效果，所以禁止）；物理照常可以', () => {
  assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: ['critup'] }]), error => error instanceof GemLinkError && error.gemId === 'critup');
  assert.doesNotThrow(() => compileLoadout([{ active: 'whirlwind', supports: ['critup'] }]));
  assert.doesNotThrow(() => compileLoadout([{ active: 'rend', supports: ['critup'] }]));
});

test('治癒術的回復量讀智力', t => {
  const mend = compileSkill('mend', []).skill;
  t.mock.method(Math, 'random', () => 0.5);
  const heal = (stats) => {
    const h = hero([mend], { hp: 1, maxHp: 99999, ...stats });
    const engine = new BattleEngine([h], [foe()]);
    mend.execute(h, [h], [foe()], engine.logger, engine);
    return h.stats.hp - 1;
  };
  assert.ok(heal({ atk: 1, int: 200 }) > heal({ atk: 200, int: 1 }) * 50);
});

test('屬性層沒有魔防：只支援既有的屬性', () => {
  assert.equal(Object.hasOwn(STAT_DEFS, 'res'), false);
  assert.equal(Object.hasOwn(STAT_DEFS, 'int'), true);
});

test('沒有智力的單位使用法術會直接報錯', t => {
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(Formulas, 'isHit', () => true);
  const skill = spell();
  const noInt = new Entity({ id: 'h', name: 'h', team: 'A', normalAttack: plain, skills: [skill], stats: { hp: 100, sp: 100, atk: 100, spd: 1 } });
  const target = new Entity({ id: 'f', name: 'f', team: 'B', normalAttack: plain, stats: { hp: 1e6, sp: 0, atk: 1, def: 0, spd: 1 } });
  const engine = new BattleEngine([noInt], [target]);
  assert.throws(() => skill.execute(noInt, [noInt], [target], engine.logger, engine), /unknown attacker stat "int"/);
  const mage = hero([skill], {});
  skill.execute(mage, [mage], [target], engine.logger, engine);
  assert.ok(target.stats.hp < 1e6);
});
