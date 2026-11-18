'use strict';
// 刷取速度模擬：在固定難度一直打贏，要幾場才能湊齊「這個難度已開放最高階」的一套（難度 13～15 是第 5 階、10～12 第 4 階…）。
// 用真正的掉落表（dropTable.rollDrops）；比目標更高階的刻印（6、9、12 的 3% 預覽）也算數。
// 用法：node gem/grind-sim.js [難度=15] [次數=300]
//
// 假設（還沒有怪物，所以是「上限速度」）：
//   - 每場都打贏；從這個難度直接開始刷，不算爬難度的過程。
//   - 刻印：每場之後把同種、同階的 3 顆合成高一階（同種合成不擲骰、保留種類）。
//     判斷能不能完成時，指定種類的需求只用「已經是第 5 階的那種刻印」；剩下的（多出來的第 5 階、
//     湊不成同種三顆的低階）可以用不同種合成一路往上換成「任意種類的第 5 階」，給不指定種類的材料用。
//     不同種合成出的隨機種類也可能剛好是需要的，這裡不算，所以結果略為保守。
//   - 製作品質：要求「上等以上」時，每件依機率重做，每次重做再花 10 個材料；做壞的裝備分解，
//     從它的 10 個材料隨機退回 SALVAGE_RETURN（3）個（saveLayer.salvageEquipment）。
//   - 輔助寶石與傳說裝備分開算（各自要幾場）。
const { createSeededRandom } = require('../src');
const { rollDrops, openTier } = require('./dropTable');
const { ENGRAVING_TYPES } = require('./affixTable');
const { QUALITIES, SALVAGE_RETURN } = require('./craftTable');
const { SUPPORT_GEMS } = require('./gems');

const KINDS = Object.keys(ENGRAVING_TYPES);
const TIERS = [1, 2, 3, 4, 5];

// 物理 build 的目標（與 affix-budget.js 的第一組 SETS／CRAFT_MIX 相同）
const ENGRAVE_TARGET = { fury: 2, precise: 2, vital: 2, bulwark: 2 };      // 8 個刻到裝備上的刻印（目標階）
const CRAFT_RECIPES = {                                                     // 每件 10 個（目標階）
  weapon: { fury: 10 }, helmet: { vital: 5, bulwark: 5 },
  armor: { fury: 4, vital: 3, bulwark: 3 }, boots: { gale: 4, vital: 3, bulwark: 3 }
};

const SCENARIOS = {
  A: { name: 'A 基本：4 件製作（材料不挑種類）＋ 8 個指定刻印', specificCraft: false, minQuality: null },
  B: { name: 'B 講究配方：製作材料也指定種類 ＋ 8 個指定刻印', specificCraft: true, minQuality: null },
  C: { name: 'C 配方＋品質：同 B，每件品質至少上等（25%，做壞的分解退回 3 個）', specificCraft: true, minQuality: 'superior' }
};

function attemptsFor(minQuality, rng) {
  if (!minQuality) return 1;
  const okChance = QUALITIES.slice(QUALITIES.findIndex(q => q.id === minQuality)).reduce((sum, q) => sum + q.chance, 0);
  let n = 1;
  while (rng() >= okChance) n++;
  return n;
}

function needsFor(scenario, rng) {
  const specific = { ...ENGRAVE_TARGET };
  let generic = 0;
  for (const recipe of Object.values(CRAFT_RECIPES)) {
    const times = attemptsFor(scenario.minQuality, rng);
    if (scenario.specificCraft) for (const [kind, n] of Object.entries(recipe)) specific[kind] = (specific[kind] ?? 0) + n * times;
    else generic += 10 * times;
    // 做壞的（times − 1 件）分解，各退回 SALVAGE_RETURN 個材料
    for (let failed = 1; failed < times; failed++) {
      const pool = Object.entries(recipe).flatMap(([kind, n]) => Array(n).fill(kind));
      for (let i = 0; i < SALVAGE_RETURN; i++) {
        const kind = pool.splice(Math.min(pool.length - 1, Math.floor(rng() * pool.length)), 1)[0];
        if (scenario.specificCraft) specific[kind]--;
        else generic--;
      }
    }
  }
  return { specific, generic };
}

function combineSameKind(bag, target) {
  for (const tier of TIERS.filter(t => t < target)) {
    for (const kind of KINDS) {
      const n = bag[kind][tier];
      if (n >= 3) {
        bag[kind][tier] = n % 3;
        bag[kind][tier + 1] += Math.floor(n / 3);
      }
    }
  }
}

function feasible(bag, { specific, generic }, target) {
  let spare = 0;
  for (const kind of KINDS) {
    const have = TIERS.filter(t => t >= target).reduce((sum, t) => sum + bag[kind][t], 0);
    const need = specific[kind] ?? 0;
    if (have < need) return false;
    spare += have - need;
  }
  if (spare >= generic) return true;
  // 低階剩下的用不同種合成一路往上（3 → 1）
  let carry = 0;
  for (const tier of TIERS.filter(t => t < target)) carry = Math.floor((carry + KINDS.reduce((sum, kind) => sum + bag[kind][tier], 0)) / 3);
  return spare + carry >= generic;
}

function runEngravings(difficulty, scenario, seed, limit = 20000) {
  const rng = createSeededRandom(seed);
  const target = openTier(difficulty);
  const needs = needsFor(scenario, rng);
  const bag = Object.fromEntries(KINDS.map(kind => [kind, Object.fromEntries(TIERS.map(t => [t, 0]))]));
  for (let battle = 1; battle <= limit; battle++) {
    for (const { type, tier } of rollDrops(difficulty, rng).engravings) bag[type][tier]++;
    combineSameKind(bag, target);
    if (feasible(bag, needs, target)) return battle;
  }
  return Infinity;
}

// 輔助寶石：要湊齊指定的寶石（可重複）
function runGems(difficulty, wanted, seed, limit = 20000) {
  const rng = createSeededRandom(seed);
  const need = { ...wanted };
  let left = Object.values(need).reduce((a, b) => a + b, 0);
  for (let battle = 1; battle <= limit; battle++) {
    for (const gem of rollDrops(difficulty, rng).supportGems) if (need[gem] > 0) { need[gem]--; left--; }
    if (left === 0) return battle;
  }
  return Infinity;
}

function stats(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const pick = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return `平均 ${mean.toFixed(0)} 場（10% ${pick(0.1)}、中位 ${pick(0.5)}、90% ${pick(0.9)}）`;
}

function simulate(difficulty = 15, runs = 300) {
  const out = { difficulty, rows: [] };
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    const list = Array.from({ length: runs }, (_, i) => runEngravings(difficulty, scenario, 1000 + i));
    out.rows.push([scenario.name, stats(list), list]);
  }
  const gems = Object.keys(SUPPORT_GEMS);
  const distinctAll = Object.fromEntries(gems.map(g => [g, 1]));
  const fourLinks = { amp: 4, heavy: 4, pierce: 4 };
  out.rows.push([`輔助寶石：${gems.length} 種各 1 顆`, stats(Array.from({ length: runs }, (_, i) => runGems(difficulty, distinctAll, 5000 + i)))]);
  out.rows.push(['輔助寶石：4 組連結都用增幅＋強力＋穿甲（各 4 顆）', stats(Array.from({ length: runs }, (_, i) => runGems(difficulty, fourLinks, 9000 + i)))]);
  return out;
}

if (require.main === module) {
  const difficulty = Number(process.argv[2] ?? 15);
  const runs = Number(process.argv[3] ?? 300);
  const { rows } = simulate(difficulty, runs);
  console.log(`難度 ${difficulty}（目標：第 ${openTier(difficulty)} 階一套）、每項 ${runs} 次模擬（每場都打贏）`);
  for (const [name, text] of rows) console.log(`${name}：${text}`);
}

module.exports = { simulate, runEngravings, runGems, SCENARIOS, CRAFT_RECIPES, ENGRAVE_TARGET };
