'use strict';
// 驗證難度縮放：每個難度，拿「上一階整套」與「這一階整套」（講究配方、第 5 階刻印換成對應階）打基準怪的勝率。
// 用法：node gem/difficulty-check.js [phys|spell] [場數=200] [地區]（repo 根目錄；不寫地區＝基準怪；ruins／sewer／hall 用 monsters.js 組的真實戰鬥，hall 會掛共鳴）
// 每階抽 6 組裝備（隨機取行、擲值、品質），每組打 N 場，回報平均勝率。命中公式用 contest。
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout } = require('./gemCompiler');
const { gear, BASE, FOE } = require('./affix-budget');
const { scaleMonster } = require('./difficulty');
const { openTier } = require('./dropTable');
const { rollEncounter, REGIONS } = require('./monsters');
const { applyResonance } = require('./resonance');

const MIX = main => ({ weapon: [[main, 10]], helmet: [['vital', 5], ['bulwark', 5]], armor: [[main, 4], ['vital', 3], ['bulwark', 3]], boots: [['gale', 4], ['vital', 3], ['bulwark', 3]] });
const ENGR = {
  phys: { weapon: ['fury', 'fury'], helmet: ['precise', 'precise'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] },
  spell: { weapon: ['arcane', 'arcane'], helmet: ['arcane', 'endure'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] }
};
const SAMPLES = 6;

function fight(build, stats, fx, difficulty, seed, region) {
  const stat = build === 'spell' ? 'int' : 'atk';
  const loadout = compileLoadout([{ active: build === 'spell' ? 'magicmissile' : 'whirlwind', supports: [] }], { equipment: fx });
  const hero = new Entity({ id: 'h', name: 'h', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE', stat }] }),
    normalAttackSpCost: 2, skills: loadout.skills, passives: loadout.passives, stats: { ...stats } });
  let foes, summonFactory;
  if (region) {
    ({ monsters: foes, summonFactory } = rollEncounter(region, difficulty, createSeededRandom(seed * 7919 + difficulty)));
  } else {
    foes = [new Entity({ id: 'f', name: 'f', team: 'B', normalAttack: new Skill({ id: 'c', name: 'c', actions: [{ type: 'DAMAGE' }] }), normalAttackSpCost: 2,
      stats: scaleMonster(FOE, difficulty) })];
  }
  if (region && REGIONS[region].resonance) applyResonance([hero, ...foes]);   // 第二區：共鳴
  return new BattleEngine([hero], foes, { rng: createSeededRandom(seed), maxTurns: 60, skillSelectionResolver: loadout.resolver, hitFormula: 'contest', summonFactory })
    .start().winner === 'TEAM_A';
}

function winRate(build, tier, difficulty, n, region) {
  const none = { physDmg: 0, spellDmg: 0, reduction: 0 };
  const rng = createSeededRandom(4242 + tier);
  const sets = tier === 0 ? [{ stats: BASE, fx: none }] : Array.from({ length: SAMPLES }, () => gear(ENGR[build], tier, rng, MIX(build === 'spell' ? 'arcane' : 'fury')));
  let wins = 0, total = 0;
  for (const { stats, fx } of sets) for (let s = 1; s <= n; s++) { total++; if (fight(build, stats, fx, difficulty, s, region)) wins++; }
  return wins / total;
}

if (require.main === module) {
  const build = process.argv[2] ?? 'phys';
  const n = Number(process.argv[3] ?? 200) / SAMPLES | 0;
  const region = process.argv[4];
  console.log(`${build}${region ? `、${region}` : '、基準怪'}：每格約 ${n * SAMPLES} 場（第 0 階 = 空手）`);
  console.log('難度 | 開放 | 上一階整套 | 這一階整套');
  for (let d = 1; d <= 15; d++) {
    const t = openTier(d);
    const pct = x => `${(x * 100).toFixed(0)}%`;
    console.log(`${String(d).padStart(2)} | 第${t}階 | 第${t - 1}階 ${pct(winRate(build, t - 1, d, n, region))} | 第${t}階 ${pct(winRate(build, t, d, n, region))}`);
  }
}

module.exports = { winRate };
