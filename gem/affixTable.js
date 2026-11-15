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
 *   接線：saveLayer.equippedEffects(save) 取總和 → compileLoadout(links, { equipment }) 或 saveLayer.compileEquipped(save)
 */

const TIER_SCALE = { 1: 0.20, 2: 0.35, 3: 0.55, 4: 0.78, 5: 1.0 };
const ROLL_MIN = 0.7;          // 擲值下限（占該階上限的比例）
const REDUCTION_CAP = 0.5;     // 減傷率合計上限

const line = (kind, extra) => ({ kind, ...extra });
const stat = (statKey, op, max) => line('stat', { stat: statKey, op, max });

// 上限 = 第 5 階、滿骰、「單一詞綴行」的值。每個刻印有 3 行，刻印到裝備上時隨機取其中 2 行生效，
// 所以數值是照「每行只有 2/3 機率出現」配的（整套 8 個刻印、16 行生效，期望值與預算一致）。
const ENGRAVING_TYPES = {
  fury:     { name: '猛攻', lines: [stat('atk', 'inc', 0.17), line('physDmg', { max: 0.12 }), stat('criDmg', 'flat', 0.25)] },
  arcane:   { name: '奧術', lines: [stat('int', 'inc', 0.17), line('spellDmg', { max: 0.12 }), stat('sp', 'flat', 50)] },
  precise:  { name: '精準', lines: [stat('cri', 'flat', 0.08), stat('criDmg', 'flat', 0.25), stat('spd', 'inc', 0.12)] },
  vital:    { name: '堅韌', lines: [stat('hp', 'inc', 0.21), stat('def', 'flat', 33), line('reduction', { max: 0.05 })] },
  bulwark:  { name: '鐵壁', lines: [stat('def', 'inc', 0.25), stat('hp', 'flat', 330), line('reduction', { max: 0.065 })] },
  gale:     { name: '疾風', lines: [stat('spd', 'inc', 0.21), stat('sp', 'flat', 50), stat('cri', 'flat', 0.04)] },
  endure:   { name: '持久', lines: [stat('sp', 'flat', 75), stat('hp', 'inc', 0.08), stat('atk', 'inc', 0.065)] }
};
const ENGRAVINGS_PER_ITEM = 2;
const LINES_PER_ENGRAVING = 3;      // 每種刻印固定的詞綴行數；刻印時落選 1 行、取 2 行
const EFFECT_KINDS = ['physDmg', 'spellDmg', 'reduction'];

// 裝備基底（固定值，第 5 階滿骰）。階級用同一個 TIER_SCALE；擲值同 ROLL_MIN。
const BASE_BY_SLOT = {
  weapon: [{ stat: 'atk', op: 'flat', max: 215 }, { stat: 'int', op: 'flat', max: 215 }],
  helmet: [{ stat: 'hp', op: 'flat', max: 1070 }, { stat: 'def', op: 'flat', max: 43 }],
  armor:  [{ stat: 'hp', op: 'flat', max: 1700 }, { stat: 'def', op: 'flat', max: 75 }, { stat: 'atk', op: 'flat', max: 140 }, { stat: 'int', op: 'flat', max: 140 }],
  boots:  [{ stat: 'hp', op: 'flat', max: 860 }, { stat: 'def', op: 'flat', max: 32 }, { stat: 'spd', op: 'flat', max: 11 }]
};

const INTEGER_STATS = new Set(['hp', 'sp', 'atk', 'int', 'def', 'spd']);
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

/** 加總詞綴裡所有 scope 'effect' 的 physDmg／spellDmg／reduction（減傷夾在上限）。 */
function sumEffectAffixes(affixes) {
  const total = { physDmg: 0, spellDmg: 0, reduction: 0 };
  for (const affix of affixes) if (affix.scope === 'effect' && affix.kind in total) total[affix.kind] += affix.value;
  total.reduction = Math.min(total.reduction, REDUCTION_CAP);
  return total;
}

module.exports = { TIER_SCALE, ROLL_MIN, REDUCTION_CAP, ENGRAVINGS_PER_ITEM, LINES_PER_ENGRAVING, EFFECT_KINDS, ENGRAVING_TYPES, BASE_BY_SLOT, rollEngraving, rollBase, sumEffectAffixes };
