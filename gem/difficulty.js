'use strict';

/**
 * 難度縮放（初版，數值是我擬的佔位）：怪物的屬性怎麼隨難度 1～15 成長。純函式，不依賴框架。
 *
 * ── 公式 ──────────────────────────────────────────────────────
 *   強度倍率 M(難度) = BASE × GROWTH^(難度 − 1) = 1.07 × 1.153^(難度 − 1)
 *     難度 1 ≈ 1.07、5 ≈ 1.89、10 ≈ 3.85、15 ≈ 7.85。
 *   生命、攻擊、智力 × M；命中 + HIT_PER_LEVEL × (難度 − 1)；**防禦 + DEF_PER_LEVEL × (難度 − 1)**（加法，基準怪 50 → 難度 15 302）。
 *   速度、SP、閃避、爆擊**不隨難度變**，由怪物種類自己決定（速度差決定連擊段數，縮放會讓手感劇變）。
 *   防禦用加法、不用乘法：減傷是 300/(def+300)，乘上去高防禦的怪（魔像 200）會失控。
 *
 * ── 第二版（2026-11-19，使用者決定）──────────────────────────────
 *   目標：難度 15 約是難度 1 的 **10 倍**（以難度 1 為基準拉高上限，讓越級變難）；裝備預算同步從 ×5 拉到約 ×10。
 *   10 倍裡包含防禦成長：防禦 50 → 300 讓第 5 階整套能打的倍率從 5.67 降到 4.17（約等於怪物 ×1.36），
 *   所以生命／攻擊只成長 7.85 ÷ 1.07 ≈ 7.3 倍（每級 ×1.153），7.3 × 1.36 ≈ 10。
 *   第一版：1.07 × 1.115^(難度 − 1)（難度 15 ≈ 4.6 倍）、防禦不成長。
 *   遊戲用 hitFormula: 'contest'（命中 = 200 + hit）。
 *
 * ── 怎麼定出來的（node gem/difficulty-check.js 驗證）──────────────
 *   先量「各階一整套裝備（講究配方）能打贏多強的怪」：怪物生命與攻擊同乘 m，找勝率 75% 的 m。
 *   物理 build（比法術弱，當基準；防禦 50）：空手 1.17、第 1 階 1.66、第 2 階 2.96、第 3 階 4.74、第 4 階 7.78、第 5 階 12.3
 *   （第二版；第一版是 1.13／1.72／2.22／3.02／4.15／5.49）。
 *   勝率對 m 很敏感（75% 與 50% 只差約 5%），所以曲線要同時滿足：
 *     入段：拿上一階整套，能穩定打這段的第一個難度（3、7、10、13）。
 *     段末：拿這一階整套，能穩定打這段的最後一個難度（2、6、9、12、15）。
 *     段內：只拿上一階裝備打到段末會明顯吃力，逼玩家換這一階的裝備。
 *   基準怪（M = 1）就是 affix-budget.js 的 FOE：生命 3000、攻擊 90、防禦 50、速度 90、SP 200。
 */

const DIFFICULTY_SCALE = { base: 1.07, growth: 1.153 };
const HIT_PER_LEVEL = 10;
const DEF_PER_LEVEL = 18;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 15;

function checkDifficulty(difficulty) {
  if (!Number.isInteger(difficulty) || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
    throw new Error(`難度必須是 ${MIN_DIFFICULTY}～${MAX_DIFFICULTY} 的整數（收到 ${difficulty}）`);
  }
}

/** 某難度的強度倍率 M。 */
function strength(difficulty) {
  checkDifficulty(difficulty);
  return DIFFICULTY_SCALE.base * DIFFICULTY_SCALE.growth ** (difficulty - 1);
}

/**
 * 把怪物的基礎屬性縮放到某難度（回傳新物件，不改傳入的）。
 * hp／maxHp／atk／int 乘 M 後取整；hit 加上 HIT_PER_LEVEL × (難度 − 1)、def 加上 DEF_PER_LEVEL × (難度 − 1)；其他原樣保留。
 */
function scaleMonster(stats, difficulty) {
  const m = strength(difficulty);
  const out = { ...stats };
  for (const key of ['hp', 'maxHp', 'atk', 'int']) if (typeof stats[key] === 'number') out[key] = Math.round(stats[key] * m);
  if (out.maxHp === undefined && typeof out.hp === 'number') out.maxHp = out.hp;
  out.hit = (stats.hit ?? 0) + HIT_PER_LEVEL * (difficulty - 1);
  if (typeof stats.def === 'number') out.def = stats.def + DEF_PER_LEVEL * (difficulty - 1);
  return out;
}

module.exports = { DIFFICULTY_SCALE, HIT_PER_LEVEL, DEF_PER_LEVEL, MIN_DIFFICULTY, MAX_DIFFICULTY, strength, scaleMonster };
