'use strict';
// 驗證刻印詞綴表的預算：滿裝（第 5 階）相對空手的涵蓋倍率。
// 每個刻印隨機取 3 行裡的 2 行、數值也隨機，所以每套配置抽 SAMPLES 件裝備組，回報平均與最小、最大。
// 用法：node gem/affix-budget.js            （repo 根目錄；裝備基底用舊版固定基底 rollBase）
//       node gem/affix-budget.js --craft    （裝備基底改用製作：每件 10 個第 5 階刻印，配置見 CRAFT_MIX，品質隨機）
//       加 --classic 改用框架原本的命中公式；預設用遊戲的 hitFormula: 'contest'（初始 25% 打空，見 docs/MECHANICS.md）
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout } = require('./gemCompiler');
const { applyStatBonuses } = require('./statLayer');
const { rollEngraving, rollBase, sumEffectAffixes } = require('./affixTable');
const { rollCraft } = require('./craftTable');

const BASE = { hp: 3000, sp: 240, atk: 150, int: 150, def: 50, spd: 200, cri: 0.1, criDmg: 1.5, skillCastRate: 0.35 };
const FOE = { hp: 3000, sp: 200, atk: 90, int: 90, def: 50, spd: 180, cri: 0.05 };   // 速度 2026-11-19 加倍
const N = 100, SAMPLES = 30;
const HIT_FORMULA = process.argv.includes('--classic') ? 'classic' : 'contest';
// 每件裝備兩個刻印（可重複）。
const SETS = {
  '物理（武器猛猛、頭盔精精、護甲與鞋子堅韌＋鐵壁）': { build: 'phys', engr: { weapon: ['fury', 'fury'], helmet: ['precise', 'precise'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] } },
  '物理（猛攻×4、堅韌＋鐵壁×2）': { build: 'phys', engr: { weapon: ['fury', 'fury'], helmet: ['fury', 'fury'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] } },
  '法術（武器奧奧、頭盔奧持、護甲與鞋子堅韌＋鐵壁）': { build: 'spell', engr: { weapon: ['arcane', 'arcane'], helmet: ['arcane', 'endure'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] } },
  '法術（奧術×4、堅韌＋鐵壁×2）': { build: 'spell', engr: { weapon: ['arcane', 'arcane'], helmet: ['arcane', 'arcane'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] } },
  '物理（武器猛猛、護甲堅鐵、頭盔與鞋子靈巧×4）': { build: 'phys', engr: { weapon: ['fury', 'fury'], helmet: ['deft', 'deft'], armor: ['vital', 'bulwark'], boots: ['deft', 'deft'] } },
  '法術（武器奧奧、護甲堅鐵、頭盔與鞋子靈巧×4）': { build: 'spell', engr: { weapon: ['arcane', 'arcane'], helmet: ['deft', 'deft'], armor: ['vital', 'bulwark'], boots: ['deft', 'deft'] } }
};

// 製作裝備的刻印配置（每件 10 個）：武器全放主屬性刻印；頭盔堅韌鐵壁各半；護甲 4 主屬性 + 3 堅韌 + 3 鐵壁；鞋子 4 疾風 + 3 堅韌 + 3 鐵壁
const CRAFT_MIX = main => ({
  weapon: [[main, 10]], helmet: [['vital', 5], ['bulwark', 5]],
  armor: [[main, 4], ['vital', 3], ['bulwark', 3]], boots: [['gale', 4], ['vital', 3], ['bulwark', 3]]
});
const expand = (mix, tier) => mix.flatMap(([type, n]) => Array.from({ length: n }, () => ({ type, tier })));

function gear(engr, tier, rng, craft = null) {
  const bonuses = [], affixes = [];
  for (const [slot, types] of Object.entries(engr)) {
    if (craft) {
      const crafted = rollCraft(slot, expand(craft[slot], tier), rng);
      bonuses.push(...crafted.base);
      affixes.push(...crafted.affixes);   // 製作詞綴（目前是異常傷害增加，對這裡的旋風斬與魔法飛彈沒有作用）
    } else {
      bonuses.push(...rollBase(slot, tier, rng));
    }
    affixes.push(...rollEngraving(types, tier, rng));
  }
  bonuses.push(...affixes.filter(a => a.scope === 'wearer'));
  return { stats: applyStatBonuses(BASE, bonuses), fx: sumEffectAffixes(affixes), bonuses, affixes };
}

function fight(build, stats, fx, m, seed) {
  const stat = build === 'spell' ? 'int' : 'atk';
  // 真正的接線：傷害提高與減傷都由編譯器處理。
  const loadout = compileLoadout([{ active: build === 'spell' ? 'magicmissile' : 'whirlwind', supports: [] }], { equipment: fx });
  const plain = id => new Skill({ id, name: id, actions: [{ type: 'DAMAGE', stat }] });
  const hero = new Entity({ id: 'h', name: 'h', team: 'A', normalAttack: plain('na'), normalAttackSpCost: 2, skills: loadout.skills, passives: loadout.passives, stats: { ...stats } });
  const foe = new Entity({ id: 'f', name: 'f', team: 'B', normalAttack: new Skill({ id: 'c', name: 'c', actions: [{ type: 'DAMAGE' }] }), normalAttackSpCost: 2,
    stats: { ...FOE, hp: FOE.hp * m, atk: FOE.atk * m } });
  return new BattleEngine([hero], [foe], { rng: createSeededRandom(seed), maxTurns: 60, skillSelectionResolver: loadout.resolver, hitFormula: HIT_FORMULA }).start().winner === 'TEAM_A';
}
function m50(build, stats, fx) {
  let prev = null;
  for (let m = 1; m <= 40; m += 0.25) {
    let w = 0;
    for (let s = 1; s <= N; s++) if (fight(build, stats, fx, m, s)) w++;
    const rate = w / N;
    if (rate < 0.5) return prev ? prev.m + (prev.rate - 0.5) / (prev.rate - rate) * (m - prev.m) : m;
    prev = { m, rate };
  }
  return NaN;
}
const ehp = (s, fx) => (s.hp / (1 - fx.reduction)) * ((s.def + 300) / 350) / BASE.hp;

if (require.main === module) {
  const useCraft = process.argv.includes('--craft');
  console.log((useCraft ? '裝備基底：製作（10 個第 5 階刻印，品質隨機）' : '裝備基底：舊版固定基底') + `；命中公式：${HIT_FORMULA}`);
  const none = { physDmg: 0, spellDmg: 0, reduction: 0 };
  const empty = { phys: m50('phys', BASE, none), spell: m50('spell', BASE, none) };
  console.log(`空手 m50：物理 ${empty.phys.toFixed(2)}、法術 ${empty.spell.toFixed(2)}`);
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  for (const [name, { build, engr }] of Object.entries(SETS)) {
    const rng = createSeededRandom(20261116);
    const covers = [], mains = [], ehps = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { stats, fx } = gear(engr, 5, rng, useCraft ? CRAFT_MIX(build === 'spell' ? 'arcane' : 'fury') : null);
      covers.push(m50(build, stats, fx) / empty[build]);
      mains.push((build === 'spell' ? stats.int : stats.atk) / 150);
      ehps.push(ehp(stats, fx));
    }
    console.log(`${name}：主屬性 ×${mean(mains).toFixed(2)}、有效生命 ×${mean(ehps).toFixed(2)}、涵蓋倍率 平均 ×${mean(covers).toFixed(2)}（${Math.min(...covers).toFixed(2)}～${Math.max(...covers).toFixed(2)}）`);
  }
}
module.exports = { gear, m50, ehp, SETS, fight, BASE, FOE };
