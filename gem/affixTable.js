'use strict';

/**
 * 刻印詞綴表（純資料 + 擲值函式，不依賴框架）。
 *
 * ── 預算（總目標：滿裝相對空手 輸出 ×5、有效生命 ×5）────────────────
 *   數值是「第 5 階、滿骰、整套 4 件」的上限，換算成輸出／有效生命的實測價值見 gem/affix-budget.js。
 *   戰鬥拉長到 15～20 回合時各詞綴的價值幾乎不變（見 HANDOFF）；SP 類詞綴略放大，施放率類詞綴不提供（物理上是負收益）。
 *
 * ── 結構 ───────────────────────────────────────────────────
 *   每件裝備掛 ENGRAVINGS_PER_ITEM（2）個刻印，可以是同一種（沒有互斥）；每種刻印固定 3 行詞綴，
 *   刻印到裝備上時**隨機取其中 2 行生效**（沒被取到的那行這次不出現），所以一件裝備有 4 行、整套 16 行。
 *   階級 1～5 決定縮放（TIER_SCALE），擲值在 [ROLL_MIN, 1] × 上限。表裡的數值是「單一詞綴行」的上限，
 *   已經照每行只有 2/3 機率出現的期望配過（所以比「3 行全開」時大 1.5 倍）。
 *   裝備的「基底」（base，固定值）另外給：武器與護甲給 atk／int，護甲與頭盔、鞋子給 hp／def（BASE_BY_SLOT）。
 *
 * ── 詞綴行的 kind ────────────────────────────────────────────
 *   stat      屬性加成，{ stat, op, value }，直接是加成層格式，scope 'wearer'
 *   physDmg   物理傷害提高（只影響寶石技能，進加算區，與寶石的 inc 同區），scope 'effect'
 *   spellDmg  法術傷害提高（同上；判斷依據是傷害動作的 stat：int 為法術，atk 或沒寫為物理）
 *   reduction 減傷率（開戰時掛常駐的 damageTaken Buff，各件相加、上限 REDUCTION_CAP），scope 'effect'
 *   ailmentDmg 異常傷害增加（裂傷、殘刃等持續傷害；自己一個加算區，與物理／法術傷害提高分開），scope 'effect'。
 *             目前只出現在製作詞綴（craftTable.js 的 CRAFT_AFFIXES），刻印沒有這一行。
 *   ailmentDuration 異常持續時間 +N 槽（整數；各件相加、上限 AILMENT_DURATION_CAP；AILMENTS 標了 extendable: false 的不受影響；目前沒有），scope 'effect'
 *   spRegen   每個自己的行動槽結束時回復 N 點 SP（可以有小數，小數部分累積到下次；不寫戰報），scope 'effect'
 *             這兩種也只出現在製作詞綴。
 *   接線：saveLayer.equippedEffects(save) 取總和 → compileLoadout(links, { equipment }) 或 saveLayer.compileEquipped(save)
 *
 * ── 刻印合成（rollCombine）──────────────────────────────────────
 *   一律投入 COMBINE_INPUTS（3）顆、同一階，產出 1 顆高一階的刻印；不會失敗；最高階（5）不能合成。
 *   三顆同種 → 同種、高一階，**不擲骰**（要指定種類就走這條）。
 *   只要不是三顆都同種（例如 2 猛攻 + 1 奧術）→ 從高一階的所有種類裡**平均**抽 1 種（含投入的種類）。
 *   平均抽的理由：①不同種合成定位是「把用不到的刻印換成高一階」，要指定種類已經有同種合成；
 *   ②依投入加權會讓丟進去的「不要的種類」更容易回來，也和同種合成的界線變模糊；
 *   ③排除投入種類會讓「投入越多種、可抽的反而越少」，而且 2 猛攻 + 1 奧術永遠拿不到猛攻，不直覺。
 *   抽取池預設是 ENGRAVING_TYPES 全部；之後有部位專用或限定階級的刻印時，由呼叫端傳 pool。
 *   合成本身不擲數值：刻印沒有個體差異，數值是刻到裝備上時才擲（ROLL_MIN～1 × 上限）。
 */

// 第二版（2026-11-19，難度改成 15 級約 10 倍、裝備預算 ×5 → ×10）：低階變弱、階與階拉開，原本 0.20／0.35／0.55／0.78／1.0
const TIER_SCALE = { 1: 0.10, 2: 0.29, 3: 0.50, 4: 0.71, 5: 1.0 };
const ROLL_MIN = 0.7;          // 擲值下限（占該階上限的比例）
const REDUCTION_CAP = 0.5;     // 減傷率合計上限
const COMBINE_INPUTS = 3;      // 合成一次投入的刻印數
const MAX_TIER = Math.max(...Object.keys(TIER_SCALE).map(Number));

const line = (kind, extra) => ({ kind, ...extra });
const stat = (statKey, op, max) => line('stat', { stat: statKey, op, max });

// 上限 = 第 5 階、滿骰、「單一詞綴行」的值。每個刻印有 3 行，刻印到裝備上時隨機取其中 2 行生效，
// 所以數值是照「每行只有 2/3 機率出現」配的（整套 8 個刻印、16 行生效，期望值與預算一致）。
// 第二版（2026-11-19，預算 ×10）：攻／智／生命／防禦的百分比、物理／法術傷害提高、平值生命與防禦都 × 1.9；
// 爆擊、爆擊傷害、速度、SP、減傷、命中、閃避不變（有上限、或放大會改變手感）。
const ENGRAVING_TYPES = {
  fury:     { name: '猛攻', lines: [stat('atk', 'inc', 0.32), line('physDmg', { max: 0.23 }), stat('criDmg', 'flat', 0.25)] },
  arcane:   { name: '奧術', lines: [stat('int', 'inc', 0.32), line('spellDmg', { max: 0.23 }), stat('sp', 'flat', 50)] },
  precise:  { name: '精準', lines: [stat('cri', 'flat', 0.08), stat('criDmg', 'flat', 0.25), stat('spd', 'inc', 0.12)] },
  vital:    { name: '堅韌', lines: [stat('hp', 'inc', 0.40), stat('def', 'flat', 63), line('reduction', { max: 0.05 })] },
  bulwark:  { name: '鐵壁', lines: [stat('def', 'inc', 0.48), stat('hp', 'flat', 630), line('reduction', { max: 0.065 })] },
  gale:     { name: '疾風', lines: [stat('spd', 'inc', 0.21), stat('sp', 'flat', 50), stat('cri', 'flat', 0.04)] },
  endure:   { name: '持久', lines: [stat('sp', 'flat', 75), stat('hp', 'inc', 0.15), stat('atk', 'inc', 0.12)] },
  // 靈巧：命中與閃避（遊戲用 hitFormula: 'contest'，命中 = 200 + hit、閃避機率 = (100 + max(0, 差距)) / (200 + |差距|)）
  deft:     { name: '靈巧', lines: [stat('hit', 'flat', 150), stat('eva', 'flat', 50), stat('spd', 'inc', 0.12)] },
  // 迴音（2026-11-21，第二區專屬：area 2 只在第二區掉落，合成也不會隨機出現）：閃避、反擊點數、爆擊率（使用者指定三項；數值是我擬的）
  resound:  { name: '迴音', area: 2, lines: [stat('eva', 'flat', 50), stat('evadeCounter', 'flat', 60), stat('cri', 'flat', 0.06)] }
};
// 各刻印能刻到哪些部位（使用者決定：部位專用是限制手段，避免全身都堆同一種效果，也讓各部位有差異）。
// 只限制「刻到裝備上」（saveLayer.engraveEquipment）；製作裝備時投入的刻印、掉落與合成都不受限。
// 已經刻在存檔裡的裝備不會因為改表而失效（讀檔不檢查），之後調整這張表不需要遷移。
// 配置是我擬的佔位：武器偏攻擊、護甲偏防禦、鞋子偏速度與閃避、頭盔最雜；閃避（靈巧）只在頭盔與鞋子。
const ENGRAVING_SLOTS = {
  fury:    ['weapon', 'helmet', 'armor'],
  arcane:  ['weapon', 'helmet', 'armor'],
  precise: ['weapon', 'helmet'],
  vital:   ['helmet', 'armor', 'boots'],
  bulwark: ['armor', 'boots'],
  gale:    ['weapon', 'boots'],
  resound: ['helmet', 'boots'],
  endure:  ['helmet', 'armor', 'boots'],
  deft:    ['helmet', 'boots']
};
/** 這種刻印能不能刻到這個部位。 */
const canEngrave = (type, slot) => Boolean(ENGRAVING_SLOTS[type]?.includes(slot));
for (const type of Object.keys(ENGRAVING_TYPES)) {
  const slots = ENGRAVING_SLOTS[type];
  if (!Array.isArray(slots) || !slots.length || slots.some(slot => !['weapon', 'helmet', 'armor', 'boots'].includes(slot))) {
    throw new Error(`刻印「${type}」的可刻部位（ENGRAVING_SLOTS）必須是 weapon／helmet／armor／boots 的非空清單`);
  }
}

const ENGRAVINGS_PER_ITEM = 2;
const LINES_PER_ENGRAVING = 3;      // 每種刻印固定的詞綴行數；刻印時落選 1 行、取 2 行
// comboFloor：普攻連擊每擊倍率的下限（「相對機動」的碎片，2026-11-22；不進 sumEffectAffixes，game.js 直接讀飾品）
const EFFECT_KINDS = ['physDmg', 'spellDmg', 'reduction', 'ailmentDmg', 'ailmentDuration', 'spRegen', 'summonHp', 'comboFloor'];   // summonHp：召喚物生命增加（2026-11-19，幻影戰斧）
const AILMENT_DURATION_CAP = 1;   // 異常持續時間加成合計上限（槽）；2026-11-20 改成 1（只有飾品給，使用者）

// 裝備基底（固定值，第 5 階滿骰）。階級用同一個 TIER_SCALE；擲值同 ROLL_MIN。
const BASE_BY_SLOT = {
  weapon: [{ stat: 'atk', op: 'flat', max: 410 }, { stat: 'int', op: 'flat', max: 410 }],
  helmet: [{ stat: 'hp', op: 'flat', max: 2030 }, { stat: 'def', op: 'flat', max: 82 }],
  armor:  [{ stat: 'hp', op: 'flat', max: 3230 }, { stat: 'def', op: 'flat', max: 143 }, { stat: 'atk', op: 'flat', max: 266 }, { stat: 'int', op: 'flat', max: 266 }],
  boots:  [{ stat: 'hp', op: 'flat', max: 1630 }, { stat: 'def', op: 'flat', max: 61 }, { stat: 'spd', op: 'flat', max: 22 }]
};

const INTEGER_STATS = new Set(['hp', 'sp', 'atk', 'int', 'def', 'spd', 'hit', 'eva']);
// 只有固定值的整數屬性取整；百分比（inc）與 cri／criDmg 保留小數。
const round = (stat, op, value) => (op === 'flat' && INTEGER_STATS.has(stat) ? Math.round(value) : Math.round(value * 10000) / 10000);

function checkTier(tier) {
  if (!Number.isInteger(tier) || !(tier in TIER_SCALE)) throw new Error(`階級必須是 1～5 的整數（收到 ${tier}）`);
}
// rng 回傳 [0, 1)；擲值 = 上限 × 階級縮放 × (ROLL_MIN + (1 - ROLL_MIN) × rng())
const rolled = (max, tier, rng) => max * TIER_SCALE[tier] * (ROLL_MIN + (1 - ROLL_MIN) * rng());

/**
 * 擲一件裝備的刻印：回傳 saveLayer 的 affixes 格式。每個刻印從 3 行裡隨機取 2 行（先擲「落選的那一行」，
 * 再依序擲被取到的行的數值），回傳的行維持表裡的順序。
 * @param {string|string[]} types ENGRAVING_TYPES 的鍵；陣列長度必須剛好是 ENGRAVINGS_PER_ITEM，可以重複同一種
 *                                （傳單一字串只擲一個刻印，給測試與預覽用）
 * @param {number} tier 1～5
 * @param {() => number} [rng] 預設 Math.random；回傳 [0, 1)。擲落選行時 rng 值 r 對應落選的行是 floor(r × 3)
 *                              （超過範圍夾到最後一行），所以測試傳 () => 1 等於「最後一行落選、其餘滿骰」
 */
function rollEngraving(types, tier, rng = Math.random) {
  checkTier(tier);
  const list = Array.isArray(types) ? types : [types];
  if (Array.isArray(types) && list.length !== ENGRAVINGS_PER_ITEM) {
    throw new Error(`每件裝備必須剛好掛 ${ENGRAVINGS_PER_ITEM} 個刻印（收到 ${list.length} 個）`);
  }
  return list.flatMap(type => {
    const def = ENGRAVING_TYPES[type];
    if (!def) throw new Error(`找不到刻印種類「${type}」`);
    const dropped = Math.min(LINES_PER_ENGRAVING - 1, Math.max(0, Math.floor(rng() * LINES_PER_ENGRAVING)));
    return def.lines.filter((_, index) => index !== dropped).map(entry => {
      const value = rolled(entry.max, tier, rng);
      const source = `engraving:${type}@${tier}`;
      if (entry.kind === 'stat') return { scope: 'wearer', stat: entry.stat, op: entry.op, value: round(entry.stat, entry.op, value), source };
      return { scope: 'effect', kind: entry.kind, value: Math.round(value * 10000) / 10000, source };
    });
  });
}

/** 擲裝備基底（固定值加成，saveLayer 的 base 格式）。 */
function rollBase(slot, tier, rng = Math.random) {
  checkTier(tier);
  const defs = BASE_BY_SLOT[slot];
  if (!defs) throw new Error(`找不到部位「${slot}」`);
  return defs.map(entry => ({ stat: entry.stat, op: entry.op, value: round(entry.stat, entry.op, rolled(entry.max, tier, rng)) }));
}

/** 加總詞綴裡所有 scope 'effect' 的效果（EFFECT_KINDS；減傷與異常持續時間夾在上限）。 */
function sumEffectAffixes(affixes) {
  const total = { physDmg: 0, spellDmg: 0, reduction: 0, ailmentDmg: 0, ailmentDuration: 0, spRegen: 0, summonHp: 0 };
  for (const affix of affixes) if (affix.scope === 'effect' && affix.kind in total) total[affix.kind] += affix.value;
  total.reduction = Math.min(total.reduction, REDUCTION_CAP);
  total.ailmentDuration = Math.min(total.ailmentDuration, AILMENT_DURATION_CAP);
  total.spRegen = Math.round(total.spRegen * 10000) / 10000;
  return total;
}

/**
 * 決定合成結果（純函式，不碰存檔；扣刻印、加刻印由 saveLayer.combineEngravings 做）。
 * @param {string[]} types 剛好 COMBINE_INPUTS 個 ENGRAVING_TYPES 的鍵，可重複
 * @param {number} tier 投入刻印的階級（三顆同階），1～4
 * @param {() => number} [rng] 預設 Math.random；只有不同種合成會呼叫一次，r 對應 pool[floor(r × 長度)]（超過範圍夾到最後一個）
 * @param {string[]} [pool] 不同種合成的抽取池，預設第一區的刻印種類（表裡的順序；地區專屬的不會合成出來）
 * @returns {{ type: string, tier: number, mode: 'same'|'mixed' }}
 */
function rollCombine(types, tier, rng = Math.random, pool = Object.keys(ENGRAVING_TYPES).filter(id => (ENGRAVING_TYPES[id].area ?? 1) === 1)) {
  checkTier(tier);
  if (tier >= MAX_TIER) throw new Error(`第 ${MAX_TIER} 階已經是最高階，不能合成`);
  if (!Array.isArray(types) || types.length !== COMBINE_INPUTS) {
    throw new Error(`合成必須剛好投入 ${COMBINE_INPUTS} 顆刻印（收到 ${Array.isArray(types) ? types.length : types}）`);
  }
  for (const type of types) if (!ENGRAVING_TYPES[type]) throw new Error(`找不到刻印種類「${type}」`);
  if (types.every(type => type === types[0])) return { type: types[0], tier: tier + 1, mode: 'same' };
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('合成的抽取池不能是空的');
  for (const type of pool) if (!ENGRAVING_TYPES[type]) throw new Error(`抽取池裡有不存在的刻印種類「${type}」`);
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return { type: pool[index], tier: tier + 1, mode: 'mixed' };
}

module.exports = { TIER_SCALE, ROLL_MIN, REDUCTION_CAP, AILMENT_DURATION_CAP, COMBINE_INPUTS, MAX_TIER, ENGRAVINGS_PER_ITEM, LINES_PER_ENGRAVING, EFFECT_KINDS, ENGRAVING_TYPES, BASE_BY_SLOT, rollEngraving, rollBase, rollCombine, sumEffectAffixes, ENGRAVING_SLOTS, canEngrave };
