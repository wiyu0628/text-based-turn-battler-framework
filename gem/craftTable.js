'use strict';

/**
 * 裝備製作表（純資料 + 擲骰函式，不依賴框架）。數值都是佔位，用 node gem/affix-budget.js 驗證。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   一件裝備投入 CRAFT_INPUTS（10）個刻印，種類與階級都可以混。
 *   基礎數值 = Σ（每個刻印的基礎數值）× 品質倍率 × 部位倍率，各屬性分開算，最後取整（0 的屬性不列出）。
 *     每個刻印的基礎數值 = STAT_UNIT[屬性] × KIND_SHARES[種類][屬性] × TIER_SCALE[階級]
 *       KIND_SHARES 是「偏向」：每種刻印主屬性約六成，其餘分給次要屬性（猛攻也給 HP，只是比堅韌、持久少）。
 *       階級只影響基礎數值，不影響品質機率。
 *     品質（QUALITIES）：次等 ×1（45%）、普通 ×1.15（30%）、上等 ×1.3（15%）、精良 ×1.4（8%）、頂級 ×1.5（2%）。
 *     部位倍率（SLOT_MULT）：武器偏攻智、護甲偏血防、鞋子偏速度、頭盔居中。
 *   施放權重 = round(WEIGHT.low～WEIGHT.high 均勻隨機) + Σ 刻印的權重加成 × TIER_SCALE，夾在 10～999。
 *     區間 60～120（使用者，2026-11-19；原本 100 × 0.7～1 = 70～100）。新手武器固定 100；傳說裝備同樣 60～120。
 *     目前只有疾風、精準提高權重（WEIGHT.bonus）。
 *   製作出來的裝備帶 CRAFT_AFFIX_SLOTS（1）條「製作詞綴」，放不適合做成刻印的效果（CRAFT_AFFIXES，依 weight 抽 1 種）。
 *     數值 = 上限 × 投入刻印的平均階級縮放（10 個刻印的 TIER_SCALE 平均）× (ROLL_MIN～1 隨機，與刻印詞綴相同)；品質不影響。
 *     目前三種（各 1/3）：異常傷害增加 ailmentDmg（上限 25%）、減傷 reduction（上限 5%，和刻印的減傷相加，合計上限 REDUCTION_CAP）、
 *     行動回復 SP spRegen（每個自己的行動槽，上限 1.25 點）。source 是 'craft:種類'。
 *     異常持續時間 2026-11-20 移到飾品（舊存檔的這條詞綴在 v7 遷移時改擲成目前三種之一）。fixed: true 的詞綴數值固定為 max（目前沒有）。
 *   之後仍可另外刻 2 個刻印（詞綴），與掉落裝備相同。
 *
 * ── 預算校準 ──────────────────────────────────────────────────
 *   STAT_UNIT 讓「10 個第 5 階刻印、合理配置、品質期望值」的基底大約等於舊版固定基底（BASE_BY_SLOT 的期望值），
 *   維持滿裝 ×5 的目標；實際涵蓋倍率以 affix-budget.js 為準。
 *
 * ── rng 呼叫順序 ──────────────────────────────────────────────
 *   品質 1 次 → 施放權重 1 次 → 製作詞綴：抽種類 1 次、擲數值 1 次（只有一種時也照樣擲，之後加種類不會改變前面的順序）。
 */

const { TIER_SCALE, ROLL_MIN, ENGRAVING_TYPES, EFFECT_KINDS } = require('./affixTable');

const CRAFT_INPUTS = 10;
const CRAFT_AFFIX_SLOTS = 1;   // 製作詞綴的條數
// 分解製作裝備時，從當初投入的 10 個刻印裡隨機退回幾個（使用者：做壞的裝備也能回收；數量我擬，佔位）
const SALVAGE_RETURN = 3;

// 製作詞綴表：kind 是 affixTable 的 EFFECT_KINDS（scope 'effect'）；max 是第 5 階、滿骰的值；weight 是抽中的相對機率。
// fixed: true 的數值固定為 max（不乘階級縮放、不擲值），但仍照樣呼叫 rng 一次，讓擲取順序不變。
// 2026-11-20（使用者）：異常持續時間移到飾品（accessoryTable）；新增減傷（每件最高 5%，四件 20%）；行動回復 SP 上限 1 → 1.25。
const CRAFT_AFFIXES = [
  { kind: 'ailmentDmg',      name: '異常傷害增加', max: 0.25, weight: 100 },
  { kind: 'reduction',       name: '減傷',        max: 0.05, weight: 100 },
  { kind: 'spRegen',         name: '行動回復 SP',  max: 1.25, weight: 100 }
];
const CRAFT_STATS = ['hp', 'sp', 'atk', 'int', 'def', 'spd'];

// 一個第 5 階刻印「全部點數都給這個屬性」時的值（部位倍率 1、品質 ×1）
// 第二版（2026-11-19，預算 ×10）：生命、攻擊、智力、防禦 × 1.9（原本 290／36／36／15），SP 與速度不變
const STAT_UNIT = { hp: 551, sp: 20, atk: 68.4, int: 68.4, def: 28.5, spd: 6.2 };   // 速度 2026-11-19 加倍（原本 3.1）

// 每種刻印的屬性偏向（加總 1）
const KIND_SHARES = {
  fury:    { atk: 0.6, hp: 0.25, def: 0.15 },
  arcane:  { int: 0.6, hp: 0.25, sp: 0.15 },
  precise: { atk: 0.3, int: 0.3, spd: 0.2, hp: 0.2 },
  vital:   { hp: 0.6, def: 0.25, sp: 0.15 },
  bulwark: { def: 0.6, hp: 0.4 },
  gale:    { spd: 0.6, hp: 0.2, sp: 0.2 },
  endure:  { hp: 0.4, sp: 0.4, def: 0.2 },
  deft:    { spd: 0.5, hp: 0.3, atk: 0.1, int: 0.1 },
  resound: { spd: 0.4, hp: 0.3, def: 0.3 }   // 迴音（第二區專屬）
};

const SLOT_MULT = {
  weapon: { atk: 1.0, int: 1.0, hp: 0.2, def: 0.2, spd: 0.3, sp: 0.5 },
  helmet: { atk: 0.3, int: 0.3, hp: 0.6, def: 0.6, spd: 0.3, sp: 0.5 },
  armor:  { atk: 0.6, int: 0.6, hp: 1.0, def: 1.0, spd: 0.3, sp: 1.0 },
  boots:  { atk: 0.3, int: 0.3, hp: 0.5, def: 0.5, spd: 1.0, sp: 0.5 }
};

const QUALITIES = [
  { id: 'inferior', name: '次等', mult: 1.0,  chance: 0.45 },
  { id: 'common',   name: '普通', mult: 1.15, chance: 0.30 },
  { id: 'superior', name: '上等', mult: 1.3,  chance: 0.15 },
  { id: 'fine',     name: '精良', mult: 1.4,  chance: 0.08 },
  { id: 'supreme',  name: '頂級', mult: 1.5,  chance: 0.02 }
];

const WEIGHT = { low: 60, high: 120, bonus: { gale: 6, precise: 3 }, min: 10, cap: 999 };

function normalizeInputs(engravings) {
  if (!Array.isArray(engravings) || engravings.length !== CRAFT_INPUTS) {
    throw new Error(`製作裝備必須剛好投入 ${CRAFT_INPUTS} 個刻印（收到 ${Array.isArray(engravings) ? engravings.length : engravings}）`);
  }
  return engravings.map((entry, index) => {
    const { type, tier } = entry ?? {};
    if (!ENGRAVING_TYPES[type] || !KIND_SHARES[type]) throw new Error(`第 ${index + 1} 個刻印的種類「${type}」不存在`);
    if (!Number.isInteger(tier) || !(tier in TIER_SCALE)) throw new Error(`第 ${index + 1} 個刻印的階級必須是 1～5 的整數（收到 ${tier}）`);
    return { type, tier };
  });
}

/** 品質倍率 1 時、還沒乘部位倍率的基礎點數（各屬性，未取整）。給 UI 預覽與測試用。 */
function rawBase(engravings) {
  const total = Object.fromEntries(CRAFT_STATS.map(stat => [stat, 0]));
  for (const { type, tier } of normalizeInputs(engravings)) {
    for (const [stat, share] of Object.entries(KIND_SHARES[type])) total[stat] += STAT_UNIT[stat] * share * TIER_SCALE[tier];
  }
  return total;
}

function rollQuality(r) {
  let acc = 0;
  for (const quality of QUALITIES) {
    acc += quality.chance;
    if (r < acc) return quality;
  }
  return QUALITIES.at(-1);
}

// 製作詞綴：依 weight 抽種類，數值 = 上限 × 平均階級縮放 × (ROLL_MIN～1)。
// lockKind：指定種類時不抽種類（黑骰鎖定種類重擲用），只擲數值（少用一個亂數）
function rollCraftAffixes(inputs, rng, lockKind = null) {
  const scale = inputs.reduce((sum, { tier }) => sum + TIER_SCALE[tier], 0) / inputs.length;
  const total = CRAFT_AFFIXES.reduce((sum, affix) => sum + affix.weight, 0);
  const affixes = [];
  for (let i = 0; i < CRAFT_AFFIX_SLOTS; i++) {
    let r = lockKind ? 0 : rng() * total;
    const pick = lockKind ? CRAFT_AFFIXES.find(affix => affix.kind === lockKind) : CRAFT_AFFIXES.find(affix => (r -= affix.weight) < 0) ?? CRAFT_AFFIXES.at(-1);
    if (!pick) throw new Error(`製作詞綴「${lockKind}」不存在`);
    const rolled = pick.max * scale * (ROLL_MIN + (1 - ROLL_MIN) * rng());
    const value = pick.fixed ? pick.max : rolled;
    affixes.push({ scope: 'effect', kind: pick.kind, value: Math.round(value * 10000) / 10000, source: `craft:${pick.kind}` });
  }
  return affixes;
}
for (const affix of CRAFT_AFFIXES) {
  if (!EFFECT_KINDS.includes(affix.kind)) throw new Error(`製作詞綴「${affix.kind}」不是 EFFECT_KINDS 之一`);
}

/**
 * 製作結果（不碰存檔；扣刻印、配發 id 由 saveLayer.craftEquipment 做）。
 * @param {string} slot weapon／helmet／armor／boots
 * @param {{ type: string, tier: number }[]} engravings 剛好 10 個
 * @param {() => number} [rng] 預設 Math.random
 * @returns {{ slot, base: { stat, op: 'flat', value }[], castWeight: number, quality: string, affixes: { scope: 'effect', kind, value, source }[] }}
 */
function rollCraft(slot, engravings, rng = Math.random) {
  const mult = SLOT_MULT[slot];
  if (!mult) throw new Error(`找不到部位「${slot}」`);
  const raw = rawBase(engravings);
  const inputs = normalizeInputs(engravings);
  const quality = rollQuality(rng());
  const base = CRAFT_STATS
    .map(stat => ({ stat, op: 'flat', value: Math.round(raw[stat] * quality.mult * mult[stat]) }))
    .filter(entry => entry.value > 0);
  const bonus = inputs.reduce((sum, { type, tier }) => sum + (WEIGHT.bonus[type] ?? 0) * TIER_SCALE[tier], 0);
  const rolledWeight = WEIGHT.low + (WEIGHT.high - WEIGHT.low) * rng();   // 一樣只用一個亂數，亂數序列不變
  const castWeight = Math.min(WEIGHT.cap, Math.max(WEIGHT.min, Math.round(rolledWeight + bonus)));
  return { slot, base, castWeight, quality: quality.id, affixes: rollCraftAffixes(inputs, rng) };
}

/**
 * 依投入的刻印重擲製作詞綴（存檔 v7 遷移、黑骰重骰用）。lockKind：只重擲這個種類的數值。
 * @param {string[]} materials 「種類@階級」；沒有或格式不對時當作第 3 階
 */
function rerollCraftAffixes(materials, rng, { lockKind = null } = {}) {
  const inputs = Array.isArray(materials) && materials.length
    ? materials.map(key => ({ tier: Number(String(key).split('@')[1]) })).map(({ tier }) => ({ tier: TIER_SCALE[tier] ? tier : 3 }))
    : [{ tier: 3 }];
  return rollCraftAffixes(inputs, rng, lockKind);
}

module.exports = { rerollCraftAffixes, CRAFT_INPUTS, CRAFT_AFFIX_SLOTS, SALVAGE_RETURN, CRAFT_AFFIXES, CRAFT_STATS, STAT_UNIT, KIND_SHARES, SLOT_MULT, QUALITIES, WEIGHT, rawBase, rollQuality, rollCraft };
