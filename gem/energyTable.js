'use strict';

/**
 * 能量表（純資料，不依賴框架）。數值都是佔位。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   玩家有一個**有上限**的能量槽（存檔的 energy）。
 *   取得：打怪（勝利，隨掉落一起給：dropTable.rollDrops 的 energy，grantDrops 加進存檔）、分解刻印（saveLayer.salvageEngravings）。
 *   消耗：清除裝備上的刻印（saveLayer.clearEngraving），**清除的刻印階級越高，消耗越多**。
 *
 * ── 數值（我擬的，佔位）────────────────────────────────────────
 *   分解：第 t 階 = 3^(t−1)（1、3、9、27、81）。與「3 顆合成 1 顆高一階」同一個比例，
 *         所以「先合成再分解」與「直接分解」得到的能量相同，不會有套利。
 *   清除：第 t 階 = 分解 2 顆同階的能量（2、6、18、54、162）。
 *   勝利：依該難度已開放的最高階（dropTable.openTier）給（1、2、5、14、40），約等於半顆該階刻印的分解值。
 *         難度 15 約 4 場勝利可以清一次第 5 階。打輸不給。
 *   上限 ENERGY_CAP = 500（約 3 次第 5 階清除）。超過上限的部分**作廢**，操作會回報作廢多少，讓介面提醒。
 */

const ENERGY_CAP = 500;
const SALVAGE_ENERGY = { 1: 1, 2: 3, 3: 9, 4: 27, 5: 81 };
const CLEAR_COST = { 1: 2, 2: 6, 3: 18, 4: 54, 5: 162 };
const WIN_ENERGY = { 1: 1, 2: 2, 3: 5, 4: 14, 5: 40 };   // 鍵是 openTier(難度)；換算在 dropTable.energyForWin

/** 加上能量並夾在上限：回傳 { energy, gained, wasted }。 */
function addEnergy(current, amount) {
  const energy = Math.min(ENERGY_CAP, current + amount);
  return { energy, gained: energy - current, wasted: current + amount - energy };
}

module.exports = { ENERGY_CAP, SALVAGE_ENERGY, CLEAR_COST, WIN_ENERGY, addEnergy };
