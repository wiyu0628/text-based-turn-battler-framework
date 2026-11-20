'use strict';

/**
 * 能量表（純資料，不依賴框架）。數值都是佔位。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   玩家有一個能量槽（存檔的 energy）。2026-11-20 使用者移除上限（原本 500，超過作廢）。
 *   取得：打怪（勝利，隨掉落一起給：dropTable.rollDrops 的 energy，grantDrops 加進存檔）、分解刻印（saveLayer.salvageEngravings）。
 *   消耗：清除裝備上的刻印（saveLayer.clearEngraving），**清除的刻印階級越高，消耗越多**。
 *
 * ── 數值（我擬的，佔位）────────────────────────────────────────
 *   分解：第 t 階 = 3^(t−1)（1、3、9、27、81）。與「3 顆合成 1 顆高一階」同一個比例，
 *         所以「先合成再分解」與「直接分解」得到的能量相同，不會有套利。
 *   清除：第 t 階 = 分解 2 顆同階的能量（2、6、18、54、162）。
 *   勝利：依該難度已開放的最高階（dropTable.openTier）給（1、2、5、14、40），約等於半顆該階刻印的分解值。
 *         難度 15 約 4 場勝利可以清一次第 5 階。打輸不給。
 *   沒有上限（2026-11-20）。addEnergy 仍回傳 wasted（永遠 0），讓呼叫端不用改。
 */

const SALVAGE_ENERGY = { 1: 1, 2: 3, 3: 9, 4: 27, 5: 81 };
const CLEAR_COST = { 1: 2, 2: 6, 3: 18, 4: 54, 5: 162 };
const WIN_ENERGY = { 1: 1, 2: 2, 3: 5, 4: 14, 5: 40 };
// 2026-11-20 使用者：轉移刻印到另一件同部位裝備，固定 500（不看階級）；目標刻滿時另外加清除那個刻印的 CLEAR_COST
const TRANSFER_ENERGY = 500;
// 黑骰重骰製作詞綴時「鎖定種類、只重擲數值」額外消耗的能量（使用者：要額外花能量；數字是我擬的佔位）
const CRAFT_REROLL_LOCK_ENERGY = 100;   // 鍵是 openTier(難度)；換算在 dropTable.energyForWin

/** 加上能量：回傳 { energy, gained, wasted }（沒有上限，wasted 永遠是 0）。 */
function addEnergy(current, amount) {
  return { energy: current + amount, gained: amount, wasted: 0 };
}

module.exports = { SALVAGE_ENERGY, CLEAR_COST, WIN_ENERGY, TRANSFER_ENERGY, CRAFT_REROLL_LOCK_ENERGY, addEnergy };
