'use strict';

/**
 * 掉落表（純資料 + 擲骰函式，不依賴框架）。數值都是佔位，改了之後要重新評估刷取速度。
 *
 * ── 只有打贏才掉 ─────────────────────────────────────────────
 *   打輸什麼都不掉：呼叫端只在勝利時呼叫 rollDrops。
 *
 * ── 刻印 ──────────────────────────────────────────────────────
 *   數量：必掉 1 個；有機率掉 2 個或 3 個（ENGRAVING_COUNT），難度越高機率越高，3 個只在難度 13 起出現。
 *   階級：TIER_WEIGHTS[難度] 是第 1～5 階的權重（%）。開放規則（使用者決定）：
 *     難度 1～2 第 1 階、3～6 開第 2 階、7～9 開第 3 階、10～12 開第 4 階、13～15 開第 5 階。
 *     新開放的階級從 15% 起跳、同一段每升一級 +10%；最低階逐漸淡出。
 *     難度 6、9、12（下一階開放的前一級）有 3% 機率先掉下一階（預覽）。
 *   種類：所有刻印種類平均抽（affixTable.ENGRAVING_TYPES，目前 8 種）。
 *
 * ── 區域專屬（2026-11-20 使用者）──────────────────────────────
 *   刻印種類、輔助寶石、傳說裝備都可以寫 area（沒寫＝1，第一區）。第一區是基準：
 *   在第 N 區打贏，掉落池＝第一區的東西＋第 N 區專屬的東西（不含其他區專屬的）。見 inArea。
 *   專屬詞綴走「新的刻印種類」（使用者選 C）：刻印詞綴跟著只在該區掉落的刻印來。
 *
 * ── 輔助寶石 ──────────────────────────────────────────────────
 *   GEM_CHANCE 掉 1 顆，從所有輔助寶石平均抽；只掉輔助寶石（主動寶石不掉）。沒有難度門檻。
 *   2026-11-21 使用者：一般 13%；那場有稀有怪 100%、有菁英怪（王戰比照菁英）75%。
 *
 * ── 傳說裝備 ──────────────────────────────────────────────────
 *   不能用刻印製作的獨有裝備。機率 0.5% 起、每升一級 +0.25%，難度 15 是 4%。沒有難度門檻。
 *   傳說裝備本身還沒設計，所以 rollDrops 只回傳「掉了幾件」（legendary），由之後的傳說表決定是哪一件。
 *
 * ── 能量 ──────────────────────────────────────────────────────
 *   每場勝利依「已開放的最高階」給固定能量（energyTable.WIN_ENERGY，不擲骰），放在 rollDrops 的 energy。
 *
 * ── 稀有怪與菁英怪的額外掉落（monsters.rollEncounter 的 info.rare／info.elite）────────
 *   稀有怪那場：多掉 RARE_BONUS.engravings（2）個刻印，每個擲兩次階級取高的（偏向高階）。
 *   菁英怪那場：多掉 ELITE_BONUS.engravings（1）個刻印，照一般機率。數值是我擬的佔位。
 *
 * ── rng 呼叫順序（測試依賴）──────────────────────────────────
 *   1. 刻印數量 1 次
 *   2. 每個刻印：階級 1 次、種類 1 次
 *   3. 寶石是否掉落 1 次；掉了再 1 次決定是哪一顆
 *   4. 傳說裝備 1 次
 *   5. 額外刻印（有稀有或菁英時才有）：每個 階級 1 次（稀有再 1 次）、種類 1 次。排在最後，所以沒有稀有菁英時順序不變。
 */

const { ENGRAVING_TYPES } = require('./affixTable');
const { SUPPORT_GEMS } = require('./gems');
const { WIN_ENERGY } = require('./energyTable');

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 15;

// 各難度刻印的階級權重（%），依序是第 1～5 階；每一列加總 100
const TIER_WEIGHTS = {
  1:  [100,  0,  0,  0,  0],
  2:  [100,  0,  0,  0,  0],
  3:  [ 85, 15,  0,  0,  0],
  4:  [ 75, 25,  0,  0,  0],
  5:  [ 65, 35,  0,  0,  0],
  6:  [ 52, 45,  3,  0,  0],   // 3% 預覽第 3 階
  7:  [ 35, 50, 15,  0,  0],
  8:  [ 25, 50, 25,  0,  0],
  9:  [ 12, 50, 35,  3,  0],   // 3% 預覽第 4 階
  10: [  5, 40, 40, 15,  0],
  11: [  0, 30, 45, 25,  0],
  12: [  0, 17, 45, 35,  3],   // 3% 預覽第 5 階
  13: [  0, 10, 40, 35, 15],
  14: [  0,  5, 30, 40, 25],
  15: [  0,  0, 25, 40, 35]
};

// 各難度「已開放」的最高階（不含 6、9、12 的 3% 預覽）：傳說裝備依它縮放數值
const TIER_OPEN = [[1, 2, 1], [3, 6, 2], [7, 9, 3], [10, 12, 4], [13, 15, 5]];
function openTier(difficulty) {
  checkDifficulty(difficulty);
  return TIER_OPEN.find(([from, to]) => difficulty >= from && difficulty <= to)[2];
}

// 刻印數量：P(2 個) = 30% + 1.5% × (難度 − 1)；P(3 個) = 8% × (難度 − 12)，難度 13 起才有（平均：難度 1 約 1.30 個、15 約 1.99 個）
// 第二版（2026-11-17，依刷取速度目標調整：難度 15 講究配方約 120～150 場、基本約 40～50 場；見 grind-sim.js）
const ENGRAVING_COUNT = {
  twoBase: 0.30, twoPerLevel: 0.015,
  threeFrom: 13, threePerLevel: 0.08
};
const GEM_CHANCE = 0.13;   // 15% → 30% → 13%（2026-11-21 使用者：改成看稀有／菁英）
const GEM_CHANCE_RARE = 1;      // 有稀有怪的那場必掉
const GEM_CHANCE_ELITE = 0.75;  // 有菁英怪（或王戰）的那場
const LEGENDARY = { base: 0.005, perLevel: 0.0025 };
const RARE_BONUS = { engravings: 2, rollsForTier: 2 };
const ELITE_BONUS = { engravings: 1, rollsForTier: 1 };

function checkDifficulty(difficulty) {
  if (!Number.isInteger(difficulty) || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
    throw new Error(`難度必須是 ${MIN_DIFFICULTY}～${MAX_DIFFICULTY} 的整數（收到 ${difficulty}）`);
  }
}

/** 某難度的掉落機率摘要（給 UI 顯示與測試）：{ tiers: [5 個機率], count: { 1, 2, 3 }, gem, legendary } */
function dropRates(difficulty) {
  checkDifficulty(difficulty);
  const level = difficulty - 1;
  const three = difficulty >= ENGRAVING_COUNT.threeFrom ? ENGRAVING_COUNT.threePerLevel * (difficulty - ENGRAVING_COUNT.threeFrom + 1) : 0;
  const two = ENGRAVING_COUNT.twoBase + ENGRAVING_COUNT.twoPerLevel * level;
  const fix = x => Math.round(x * 1e6) / 1e6;
  return {
    tiers: TIER_WEIGHTS[difficulty].map(w => w / 100),
    count: { 1: fix(1 - two - three), 2: fix(two), 3: fix(three) },
    gem: GEM_CHANCE,
    legendary: fix(LEGENDARY.base + LEGENDARY.perLevel * level)
  };
}

// 依累積機率挑；r 落在最後一格之後（浮點誤差或 rng 回傳 1）時夾到最後一個機率大於 0 的選項
function pickWeighted(weights, r) {
  let acc = 0;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    last = i;
    acc += weights[i];
    if (r < acc) return i;
  }
  return last;
}
const pickUniform = (list, r) => list[Math.min(list.length - 1, Math.max(0, Math.floor(r * list.length)))];

/** 某難度打贏一場得到的能量（不擲骰）。 */
function energyForWin(difficulty) {
  return WIN_ENERGY[openTier(difficulty)];
}

/**
 * 擲一場勝利的掉落。
 * @param {number} difficulty 1～15
 * @param {() => number} [rng] 預設 Math.random；回傳 [0, 1)
 * @param {{ rare?: boolean, elite?: boolean }} [encounter] 這場有沒有稀有怪、菁英怪（rollEncounter 的 info）
 * @returns {{ engravings: { type: string, tier: number }[], supportGems: string[], legendary: number, energy: number }}
 */
/** 這個東西（有 area 欄位的資料）會不會在第 area 區掉落：第一區的東西每一區都掉，其他區的只在自己區掉。 */
function inArea(def, area = 1) {
  const own = def?.area ?? 1;
  return own === 1 || own === area;
}

function rollDrops(difficulty, rng = Math.random, { rare = false, elite = false, area = 1 } = {}) {
  const rates = dropRates(difficulty);
  const count = 1 + pickWeighted([rates.count[1], rates.count[2], rates.count[3]], rng());
  const types = Object.keys(ENGRAVING_TYPES).filter(id => inArea(ENGRAVING_TYPES[id], area));
  const engravings = [];
  for (let i = 0; i < count; i++) {
    const tier = pickWeighted(rates.tiers, rng()) + 1;
    engravings.push({ type: pickUniform(types, rng()), tier });
  }
  const gemChance = rare ? GEM_CHANCE_RARE : elite ? GEM_CHANCE_ELITE : rates.gem;
  const supportGems = rng() < gemChance ? [pickUniform(Object.keys(SUPPORT_GEMS).filter(id => inArea(SUPPORT_GEMS[id], area)), rng())] : [];
  const legendary = rng() < rates.legendary ? 1 : 0;
  const bonus = rare ? RARE_BONUS : elite ? ELITE_BONUS : null;
  for (let i = 0; bonus && i < bonus.engravings; i++) {
    let tier = 0;
    for (let k = 0; k < bonus.rollsForTier; k++) tier = Math.max(tier, pickWeighted(rates.tiers, rng()) + 1);
    engravings.push({ type: pickUniform(types, rng()), tier });
  }
  return { engravings, supportGems, legendary, area, energy: energyForWin(difficulty) };
}

// 資料檢查：area 必須是正整數
for (const [name, table] of [['刻印', ENGRAVING_TYPES], ['輔助寶石', SUPPORT_GEMS]]) {
  for (const [id, def] of Object.entries(table)) {
    if (def.area !== undefined && !(Number.isInteger(def.area) && def.area >= 1)) throw new Error(`${name}「${id}」的 area 必須是正整數`);
  }
}

module.exports = { inArea, MIN_DIFFICULTY, MAX_DIFFICULTY, TIER_WEIGHTS, TIER_OPEN, openTier, energyForWin, ENGRAVING_COUNT, GEM_CHANCE, GEM_CHANCE_RARE, GEM_CHANCE_ELITE, LEGENDARY, RARE_BONUS, ELITE_BONUS, dropRates, rollDrops };
