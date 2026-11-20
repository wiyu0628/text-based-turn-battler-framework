'use strict';
// 王戰勝率：拿第 N 階整套（講究配方，同 difficulty-check.js）打某隻王。
// 用法：node gem/boss-check.js [王 id=gatekeeper] [場數=240]（約 10 秒）
// 流派：物理旋風斬（群攻）、物理撕裂（單體）、法術魔法飛彈（單體）。build 可寫 'phys:rend' 指定主動寶石。
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout } = require('./gemCompiler');
const { gear, BASE } = require('./affix-budget');
const { buildBossEncounter, findBoss } = require('./bosses');

const MIX = main => ({ weapon: [[main, 10]], helmet: [['vital', 5], ['bulwark', 5]], armor: [[main, 4], ['vital', 3], ['bulwark', 3]], boots: [['gale', 4], ['vital', 3], ['bulwark', 3]] });
const ENGR = {
  phys: { weapon: ['fury', 'fury'], helmet: ['precise', 'precise'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] },
  spell: { weapon: ['arcane', 'arcane'], helmet: ['arcane', 'endure'], armor: ['vital', 'bulwark'], boots: ['vital', 'bulwark'] }
};
const SAMPLES = 6;

function winRate(bossId, buildSpec, tier, n) {
  const [build, activeOverride] = buildSpec.split(':');
  const none = { physDmg: 0, spellDmg: 0, reduction: 0 };
  const rng = createSeededRandom(31 + tier);
  const sets = tier === 0 ? [{ stats: BASE, fx: none }] : Array.from({ length: SAMPLES }, () => gear(ENGR[build], tier, rng, MIX(build === 'spell' ? 'arcane' : 'fury')));
  let wins = 0, total = 0;
  for (const { stats, fx } of sets) {
    for (let seed = 1; seed <= n; seed++) {
      const loadout = compileLoadout([{ active: activeOverride ?? (build === 'spell' ? 'magicmissile' : 'whirlwind'), supports: [] }], { equipment: fx });
      const hero = new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE', stat: build === 'spell' ? 'int' : 'atk' }] }),
        normalAttackSpCost: 2, skills: loadout.skills, passives: loadout.passives, stats: { ...stats } });
      const { monsters } = buildBossEncounter(bossId);
      const engine = new BattleEngine([hero], monsters, { rng: createSeededRandom(seed), maxTurns: 60, skillSelectionResolver: loadout.resolver, hitFormula: 'contest' });
      total++;
      if (engine.start().winner === 'TEAM_A') wins++;
    }
  }
  return wins / total;
}

if (require.main === module) {
  const bossId = process.argv[2] ?? 'gatekeeper';
  const n = Number(process.argv[3] ?? 240) / SAMPLES | 0;
  const boss = findBoss(bossId);
  console.log(`${boss.name}（難度 ${boss.difficulty}）：每格約 ${n * SAMPLES} 場`);
  for (const build of ['phys', 'phys:rend', 'spell']) {
    console.log(`${build}：` + [0, 1, 2, 3].map(t => `第${t}階 ${(winRate(bossId, build, t, n) * 100).toFixed(0)}%`).join('  '));
  }
}

module.exports = { winRate };
