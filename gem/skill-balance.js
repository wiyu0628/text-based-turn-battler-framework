'use strict';
// 主動寶石平衡：同一套裝備、同一個難度，在不同情境下能打贏多強的敵人。
// 把敵方所有單位的生命與攻擊／智力同乘 k，找勝率剛好 50% 的 k（越大越強）。
// 用法：node gem/skill-balance.js [寶石,寶石…] [情境,情境…] [階級=3] [難度=9]（約 1～2 分鐘）
//   情境：base（基準單隻怪）、ruins、sewer（monsters.js 組的戰鬥）、boss（第一隻王，用它自己的難度）
//   物理寶石用物理裝備（猛攻配方）、魔法飛彈用法術裝備（奧術配方）；都不連輔助寶石。
//   加 --acc=飾品id（例如 --acc=hourglass）讓角色穿著那個飾品；預設不穿。
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout } = require('./gemCompiler');
const { gear, FOE } = require('./affix-budget');
const { scaleMonster } = require('./difficulty');
const { rollEncounter } = require('./monsters');
const { buildBossEncounter, BOSSES } = require('./bosses');
const { ACTIVE_GEMS } = require('./gems');

const MIX = main => ({ weapon: [[main, 10]], helmet: [['vital', 5], ['bulwark', 5]], armor: [[main, 4], ['vital', 3], ['bulwark', 3]], boots: [['gale', 4], ['vital', 3], ['bulwark', 3]] });
const ENGR = {
  phys: { weapon: ['fury', 'fury'], helmet: ['precise', 'precise'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] },
  spell: { weapon: ['arcane', 'arcane'], helmet: ['arcane', 'endure'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] }
};
const ACCESSORY = process.argv.find(a => a.startsWith('--acc='))?.slice(6) || null;
const N = 120;
const SAMPLES = 3;

const isSpell = gemId => ACTIVE_GEMS[gemId].actions.some(a => a.stat === 'int');

function enemies(context, difficulty, seed) {
  if (context === 'base') {
    return { monsters: [new Entity({ id: 'f', name: 'f', team: 'B', normalAttack: new Skill({ id: 'c', name: 'c', actions: [{ type: 'DAMAGE' }] }), normalAttackSpCost: 2,
      stats: scaleMonster(FOE, difficulty) })] };
  }
  if (context === 'boss') return buildBossEncounter(BOSSES[0].id);
  return rollEncounter(context, difficulty, createSeededRandom(seed * 7919 + difficulty));
}

function fight(gemId, setup, context, difficulty, k, seed, supports = []) {
  const spell = isSpell(gemId);
  const loadout = compileLoadout([{ active: gemId, supports }], { equipment: setup.fx });
  const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE', stat: spell ? 'int' : 'atk' }] }),
    normalAttackSpCost: 2, skills: loadout.skills, passives: loadout.passives, stats: { ...setup.stats } });
  const { monsters, summonFactory } = enemies(context, difficulty, seed);
  for (const m of monsters) {
    for (const key of ['hp', 'maxHp', 'atk', 'int']) if (typeof m.stats[key] === 'number') m.stats[key] = Math.round(m.stats[key] * k);
  }
  const wrapped = summonFactory && ((id, opts) => {
    const e = summonFactory(id, opts);
    if (e) for (const key of ['hp', 'maxHp', 'atk', 'int']) if (typeof e.stats[key] === 'number') e.stats[key] = Math.round(e.stats[key] * k);
    return e;
  });
  return new BattleEngine([hero], monsters, { rng: createSeededRandom(seed), maxTurns: 60, skillSelectionResolver: loadout.resolver, hitFormula: 'contest', summonFactory: wrapped })
    .start().winner === 'TEAM_A';
}

function setups(gemId, tier) {
  const build = isSpell(gemId) ? 'spell' : 'phys';
  const rng = createSeededRandom(900 + tier);
  return Array.from({ length: SAMPLES }, () => gear(ENGR[build], tier, rng, MIX(build === 'spell' ? 'arcane' : 'fury'), ACCESSORY));
}

function rateAt(gemId, list, context, difficulty, k, supports) {
  let wins = 0, total = 0;
  for (const setup of list) for (let s = 1; s <= N; s++) { total++; if (fight(gemId, setup, context, difficulty, k, s, supports)) wins++; }
  return wins / total;
}

// 勝率 50% 的 k：先倍增找區間，再二分 7 次
function k50(gemId, context, tier = 3, difficulty = 9, supports = []) {
  const list = setups(gemId, tier);
  let lo = 0.25, hi = 0.5;
  while (rateAt(gemId, list, context, difficulty, hi, supports) >= 0.5 && hi < 64) { lo = hi; hi *= 2; }
  if (hi === 0.5 && rateAt(gemId, list, context, difficulty, lo, supports) < 0.5) return lo;
  for (let i = 0; i < 7; i++) {
    const mid = Math.sqrt(lo * hi);
    if (rateAt(gemId, list, context, difficulty, mid, supports) >= 0.5) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

if (require.main === module) {
  process.argv = process.argv.filter(a => !a.startsWith('--acc='));
  const gems = (process.argv[2] ?? 'whirlwind,rend,pursuit,magicmissile').split(',');
  const contexts = (process.argv[3] ?? 'base,ruins,sewer,boss').split(',');
  const tier = Number(process.argv[4] ?? 3);
  const difficulty = Number(process.argv[5] ?? 9);
  console.log(`第 ${tier} 階整套、難度 ${difficulty}（王用自己的難度）${ACCESSORY ? `、飾品 ${ACCESSORY}` : ""}；數字是勝率 50% 時敵方的強度倍率 k`);
  console.log(['寶石'.padEnd(12), ...contexts.map(c => c.padStart(7)), '平均'.padStart(7)].join(''));
  for (const gemId of gems) {
    const ks = contexts.map(c => k50(gemId, c, tier, difficulty));
    const mean = Math.exp(ks.reduce((a, b) => a + Math.log(b), 0) / ks.length);
    console.log([gemId.padEnd(12), ...ks.map(k => k.toFixed(2).padStart(7)), mean.toFixed(2).padStart(7)].join(''));
  }
}

module.exports = { k50, fight };
