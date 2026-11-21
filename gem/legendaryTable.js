'use strict';

/**
 * 傳說裝備表（純資料 + 擲骰函式，不依賴框架）。數值都是佔位。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   傳說裝備只從掉落取得（dropTable 的 legendary），不能用刻印製作；**不能刻刻印、沒有製作詞綴**。
 *   目前只有武器。存檔裡是 origin 'drop'、帶 legendaryId。
 *   數值：每件有自己的上限（第 5 階、滿骰），掉落時乘「該難度已開放的最高階」的 TIER_SCALE，再擲 ROLL_MIN～1。
 *     所以難度 1 掉的傳說裝備比難度 15 掉的弱。基底（base）與獨有詞綴（unique）都這樣擲。
 *   獨有詞綴兩種格式：
 *     { scope: 'wearer', stat, op, max }   屬性（走加成層，同刻印的屬性行）
 *     { scope: 'effect', kind, max }       非屬性效果（physDmg／spellDmg／reduction／ailmentDmg）
 *     任一種把 max 換成 range: [低, 高] 就是**固定區間**：不乘階級縮放、不擲 0.7～1，直接在區間內均勻擲（連攜匕首的爆擊傷害減少）。
 *   武器的 attackStat 決定普攻吃 atk 或 int（傳說武器每件固定）。
 *   施放權重與製作裝備相同：round(60～120 均勻隨機)（2026-11-19 使用者，原本 100 × 0.7～1 = 70～100）。
 *
 * ── 特殊機制（mechanics，寫成程式，存檔只存 legendaryId，編譯時才查表）──────────
 *   { type: 'grantSupport', gem }       這件裝備上的主動寶石**額外**具有該輔助寶石，不佔連結位、不算進 3 顆上限。
 *                                       玩家已經連了同一顆就不重複；與主動寶石不相容（例如條件不符、互斥）時自動不套用。
 *   { type: 'castOnEnemyDeath', text }  敵人倒下時，插隊多一個行動槽釋放這件裝備上的主動寶石一次（**不扣 SP**）。
 *                                       見 gemCompiler.js 的 buildEnemyDeathCastPassive。
 *   { type: 'castOnCrit', chance }      自己的任何一擊暴擊時擲 chance，成功就插隊免費釋放這件裝備上的主動寶石一次（多組隨機選一）；
 *                                       每個行動槽最多一次，觸發出來的那次不再觸發（同迅擊以外的觸發類規則）。
 *   { type: 'spShield', ratio, duration } 角色層級：施放技能實際扣了 SP 時，得到「魔力護盾」= 智力 × 扣的 SP × ratio，
 *                                       持續 duration 個行動槽；已有魔力護盾時取較大值並重置時間。免費施放沒扣 SP 就沒有盾。
 *   { type: 'phantom', ratio, ratios?, name?, summonText?, chaseText? } 開戰時召喚幻影（自己的生命／攻擊／智力／防禦 × ratio，
 *                                       ratios 可以每項分開（hp／atk／int／def／spd；spd 沒寫就照抄），生命再乘 1 + 召喚物生命；
 *                                       爆擊、命中、閃避照抄；name、summonText 裡的 {caster} 換成玩家名字）；平常依速度普攻；這件裝備上的主動寶石施放後幻影插隊追擊一次
 *                                       （單體跟同一個目標，其他隨機）；自己倒下時幻影消失。見 gemCompiler 的 buildPhantomPassive。
 *   { type: 'shieldBreakSp', sp }       角色層級：自己的任何護盾碎掉時，每碎一面回復 sp 點 SP（不限這件裝備給的盾）。
 *
 * ── rng 呼叫順序 ──────────────────────────────────────────────
 *   base 每行 1 次 → unique 每行 1 次 → 施放權重 1 次。
 */

const { TIER_SCALE, ROLL_MIN, EFFECT_KINDS } = require('./affixTable');
const { openTier } = require('./dropTable');

const LEGENDARIES = {
  omen: {
    id: 'omen',
    name: '報喪法杖',
    slot: 'weapon',
    attackStat: 'int',
    // 平衡第一輪：240 → 280、30% → 35%（原本比製作的第 5 階武器還弱；調整後單體 +2～3%、多隻怪 +5～10%）
    // 2026-11-21 削弱（使用者：前期刻印少時傳說太強，會一路跳級）：主屬性 ×0.6（532 → 319、66.5% → 40%），目標介於隨機製作與配方製作武器之間
    base: [{ stat: 'int', op: 'flat', max: 319 }],
    unique: [{ scope: 'wearer', stat: 'int', op: 'inc', max: 0.4 }],
    mechanics: [
      { type: 'castOnEnemyDeath', text: '{caster} 手中的報喪法杖為 {target} 敲響喪鐘！' },
      { type: 'grantSupport', gem: 'amp' }
    ]
  },

  // 連攜匕首（使用者設計，2026-11-19）：把「暴擊時釋放技能」做成武器；用爆擊傷害換爆擊率。
  // 爆擊傷害減少是固定區間 −30～−20 個百分點（不隨難度）；觸發機率固定 40%（使用者：30～50% 挑一個，我選中間）。
  linkdagger: {
    id: 'linkdagger',
    name: '連攜匕首',
    slot: 'weapon',
    attackStat: 'atk',
    // 2026-11-21 削弱：主屬性 ×0.7（532 → 372、攻擊 inc 50% → 35%）；爆擊兩行不動
    base: [{ stat: 'atk', op: 'flat', max: 372 }],
    // 攻擊力提高 50%（2026-11-21 → 35%）：2026-11-19 補強（少了刻印的攻擊力%，比同階製作武器弱）。試過速度提高 20～40%，難度 15 仍不到製作武器，改用攻擊力%（使用者）。
    unique: [
      { scope: 'wearer', stat: 'cri', op: 'flat', max: 0.2 },
      { scope: 'wearer', stat: 'criDmg', op: 'flat', range: [-0.3, -0.2] },
      { scope: 'wearer', stat: 'atk', op: 'inc', max: 0.35 }
    ],
    mechanics: [{ type: 'castOnCrit', chance: 0.4, text: '{caster}連攜追擊，' }]
  },

  // 魔力循環法球（使用者設計，2026-11-19）：靠自循環拿 SP、補一點生存。
  // 護盾 = 智力 × 扣的 SP × 0.04（2026-11-19 使用者從 0.1 削弱；第 5 階放魔法飛彈約生命的 3.5%），持續 3 槽、再放取較大值並重置；任何盾碎掉回 2 SP。
  manaorb: {
    id: 'manaorb',
    name: '魔力循環法球',
    slot: 'weapon',
    attackStat: 'int',
    // 2026-11-21 削弱：主屬性 ×0.45（532 → 239、40% → 18%）；護盾機制不動
    base: [{ stat: 'int', op: 'flat', max: 239 }],
    unique: [{ scope: 'wearer', stat: 'int', op: 'inc', max: 0.18 }],
    mechanics: [
      { type: 'spShield', ratio: 0.04, duration: 3 },
      { type: 'shieldBreakSp', sp: 2 }
    ]
  },

  // 幻影戰斧（使用者設計，2026-11-19；測試召喚物機制，之後可以做召喚物主動寶石）。
  // 基底攻擊 +532 比照其他傳說武器（使用者沒指定）；速度 +40、召喚物生命 +40%（使用者：最高考慮 40%）。
  phantomaxe: {
    id: 'phantomaxe',
    name: '幻影戰斧',
    slot: 'weapon',
    attackStat: 'atk',
    // 2026-11-21 削弱：主屬性 ×0.45（532 → 239）；速度、召喚物生命、幻影不動
    base: [{ stat: 'atk', op: 'flat', max: 239 }],
    unique: [
      { scope: 'wearer', stat: 'spd', op: 'flat', max: 40 },
      { scope: 'effect', kind: 'summonHp', max: 0.4 }
    ],
    // 幻影倍率（使用者 2026-11-19 定案）：生命、速度 ×0.5，攻擊、智力、防禦 ×0.3（原設計全部 ×0.8 太強）。
    mechanics: [{ type: 'phantom', ratio: 0.3, ratios: { hp: 0.5, spd: 0.5 }, name: '{caster}的幻影',
      summonText: '{caster}揮動斧頭，一道幻影浮現在{caster}的身後。', chaseText: '{caster} 隨之追擊，' }]
  },

  // ── 第二區專屬（area 2，只在第二區掉落；2026-11-21 使用者設計，數值是我擬的初版）──────────
  // 氣鳴楯【菲爾查哈】（2026-11-21 晚使用者改版）：強化反擊。基底攻擊＋防禦；閃避、反擊點數、反擊傷害；反擊無視防禦。
  fircha: {
    id: 'fircha',
    name: '氣鳴楯【菲爾查哈】',
    slot: 'weapon',
    attackStat: 'atk',
    area: 2,
    base: [{ stat: 'atk', op: 'flat', max: 300 }, { stat: 'def', op: 'flat', max: 100 }],
    unique: [
      { scope: 'wearer', stat: 'eva', op: 'flat', max: 80 },
      { scope: 'wearer', stat: 'evadeCounter', op: 'flat', max: 80 },
      { scope: 'wearer', stat: 'counterDmg', op: 'flat', max: 0.6 }
    ],
    mechanics: [{ type: 'counterIgnoreDefense' }]
  },
  // 撥弦槍【鶴之聲援】（2026-11-21 晚使用者改版）：依攻擊次數增強。基底智力＋SP；智力%、速度；機制「妖精的和弦」（chord.js）。
  cranelance: {
    id: 'cranelance',
    name: '撥弦槍【鶴之聲援】',
    slot: 'weapon',
    attackStat: 'int',
    area: 2,
    base: [{ stat: 'int', op: 'flat', max: 280 }, { stat: 'sp', op: 'flat', max: 50 }],
    unique: [
      { scope: 'wearer', stat: 'int', op: 'inc', max: 0.3 },
      { scope: 'wearer', stat: 'spd', op: 'flat', max: 30 }
    ],
    mechanics: [{ type: 'chord', gain: 4, loss: 1, max: 100, perPoint: 0.01, rounds: 3, heal: 0.25, spdInc: 1,
      text: {
        full: '{caster}：「我要奏響『勝利的旋律』來阻止你！」',
        start: '一陣激昂的樂聲迴盪在整個戰場，{caster}的腳步隨著樂聲加快了！',
        shout: '「BreakNight」！',
        end: '歌曲結束了，戰場回復原先的平靜。'
      } }]
  }
};

const LEGENDARY_WEIGHT = { low: 60, high: 120 };
const MECHANIC_TYPES = ['grantSupport', 'castOnEnemyDeath', 'castOnCrit', 'spShield', 'shieldBreakSp', 'phantom', 'counterIgnoreDefense', 'chord'];

function round(stat, op, value) {
  // 只有 flat 的整數屬性取整（同 affixTable 的修正：inc 百分比不能取整）
  if (op === 'flat' && ['hp', 'sp', 'atk', 'int', 'def', 'spd'].includes(stat)) return Math.round(value);
  return Math.round(value * 10000) / 10000;
}

/**
 * 擲一件傳說裝備（不碰存檔；saveLayer.addLegendary 配發 id）。
 * @param {string} legendaryId LEGENDARIES 的鍵
 * @param {number} difficulty 掉落難度 1～15（決定階級縮放）
 * @param {() => number} [rng]
 * @returns {{ slot, origin: 'drop', legendaryId, tier, attackStat?, base, affixes, castWeight }}
 *   tier：掉落時的階級縮放（之後用黑骰重置數值時沿用）
 */
function rollLegendary(legendaryId, difficulty, rng = Math.random) {
  const def = LEGENDARIES[legendaryId];
  if (!def) throw new Error(`找不到傳說裝備「${legendaryId}」`);
  const tier = openTier(difficulty);
  const { base, affixes } = rollValues(def, tier, rng);
  const castWeight = Math.round(LEGENDARY_WEIGHT.low + (LEGENDARY_WEIGHT.high - LEGENDARY_WEIGHT.low) * rng());   // 一樣只用一個亂數
  return { slot: def.slot, origin: 'drop', legendaryId, tier, ...(def.attackStat ? { attackStat: def.attackStat } : {}), base, affixes, castWeight };
}

/**
 * 黑骰：依裝備記的 tier 重擲傳說裝備的所有數值行（base 與 unique；施放權重不動）。不碰存檔，回傳 { base, affixes }。
 * rng 順序和掉落時相同（base、unique 各 1 個）。
 */
function rerollLegendaryValues(item, rng = Math.random) {
  const def = LEGENDARIES[item?.legendaryId];
  if (!def) throw new Error(`「${item?.id ?? '?'}」不是傳說裝備`);
  if (!TIER_SCALE[item.tier]) throw new Error(`傳說裝備「${item.id}」沒有記錄階級`);
  return rollValues(def, item.tier, rng);
}

/**
 * 從數值反推舊傳說裝備的掉落階級（存檔 v8 遷移用；之前的存檔沒有記 tier）。
 * 每條非固定區間的行都要落在「上限 × 縮放 × 0.7～1」內（容許取整誤差）；都符合的取最高階，沒有可推的行（全是固定區間）回傳 5。
 */
function inferLegendaryTier(item) {
  const def = LEGENDARIES[item.legendaryId];
  const pairs = [...def.base.map((line, i) => [line, item.base?.[i]]), ...def.unique.map((line, i) => [line, item.affixes?.[i]])]
    .filter(([line, got]) => !line.range && got && Number.isFinite(got.value));
  if (!pairs.length) return 5;
  const fits = tier => pairs.every(([line, got]) => {
    const hi = line.max * TIER_SCALE[tier];
    const slack = Math.max(0.6, hi * 0.01);
    return got.value >= hi * ROLL_MIN - slack && got.value <= hi + slack;
  });
  const tiers = [5, 4, 3, 2, 1];
  const ok = tiers.find(fits);
  if (ok) return ok;
  // 都不符合（資料改過上限）：取比例最接近的
  const ratio = pairs[0][1].value / pairs[0][0].max;
  return tiers.reduce((best, t) => (Math.abs(TIER_SCALE[t] * 0.85 - ratio) < Math.abs(TIER_SCALE[best] * 0.85 - ratio) ? t : best), 5);
}

function rollValues(def, tier, rng) {
  const scale = TIER_SCALE[tier];
  const roll = () => ROLL_MIN + (1 - ROLL_MIN) * rng();
  // 每行 1 個亂數：一般行是 上限 × 階級縮放 × (0.7～1)；固定區間行直接在 range 內擲
  const raw = line => line.range ? line.range[0] + (line.range[1] - line.range[0]) * rng() : line.max * scale * roll();
  const base = def.base.map(line => ({ stat: line.stat, op: line.op, value: round(line.stat, line.op, raw(line)) }));
  const source = `legendary:${def.id}`;
  const affixes = def.unique.map(line => line.scope === 'wearer'
    ? { scope: 'wearer', stat: line.stat, op: line.op, value: round(line.stat, line.op, raw(line)), source }
    : { scope: 'effect', kind: line.kind, value: round(null, null, raw(line)), source });
  return { base, affixes };
}

/** 從所有傳說裝備平均抽一件的 id（之後有部位或難度限制時再加條件）。呼叫 rng 1 次。 */
// area：第幾區掉的（第一區的傳說每一區都掉，其他區的只在自己區掉；LEGENDARIES 每件可寫 area，沒寫＝1）
function pickLegendary(rng = Math.random, area = 1) {
  const ids = Object.keys(LEGENDARIES).filter(id => (LEGENDARIES[id].area ?? 1) === 1 || LEGENDARIES[id].area === area);
  return ids[Math.min(ids.length - 1, Math.floor(rng() * ids.length))];
}

/** 機制給玩家看的一句話（介面與數值表共用）。supportName：輔助寶石 id → 名稱。 */
function describeMechanic(mechanic, supportName = id => id) {
  switch (mechanic.type) {
    case 'grantSupport': return `裝備的主動寶石具有「${supportName(mechanic.gem)}」`;
    case 'castOnEnemyDeath': return '敵人倒下時釋放一次裝備的主動寶石（不耗 SP）';
    case 'castOnCrit': return `暴擊時有 ${Math.round(mechanic.chance * 100)}% 機率釋放一次裝備的主動寶石（不耗 SP；每個行動槽最多一次）`;
    case 'spShield': return `施放技能時依消耗的 SP 獲得護盾，持續 ${mechanic.duration} 個行動槽`;
    case 'shieldBreakSp': return `護盾破裂時獲得 ${mechanic.sp} 點 SP`;
    case 'phantom': return '開戰時召喚幻影；裝備的主動寶石會讓幻影追擊';
    case 'counterIgnoreDefense': return '閃避反擊的傷害無視防禦';
    // 2026-11-21 使用者指定括弧內的文字
    case 'chord': return '妖精的和弦能夠變為勝利的旋律（每次攻擊命中時增加和弦，被攻擊命中時會減少和弦，和弦滿了發動勝利的旋律）';
    default: return mechanic.type;
  }
}

/** 一件裝備的特殊機制（依 legendaryId 查表；不是傳說裝備回傳空陣列）。 */
function mechanicsOf(item) {
  return item?.legendaryId ? structuredClone(LEGENDARIES[item.legendaryId]?.mechanics ?? []) : [];
}

// 資料檢查：寫錯直接在載入時丟錯
for (const def of Object.values(LEGENDARIES)) {
  if (!['weapon', 'helmet', 'armor', 'boots'].includes(def.slot)) throw new Error(`傳說裝備「${def.id}」的部位不對`);
  if (def.attackStat !== undefined && (def.slot !== 'weapon' || !['atk', 'int'].includes(def.attackStat))) throw new Error(`傳說裝備「${def.id}」的 attackStat 只能是武器的 atk 或 int`);
  for (const line of [...def.base, ...def.unique]) {
    if (line.range !== undefined && !(Array.isArray(line.range) && line.range.length === 2 && line.range.every(Number.isFinite) && line.range[0] <= line.range[1])) {
      throw new Error(`傳說裝備「${def.id}」的 range 要是 [低, 高]`);
    }
    if (line.range === undefined && !Number.isFinite(line.max)) throw new Error(`傳說裝備「${def.id}」的詞綴要有 max 或 range`);
  }
  for (const line of def.unique) {
    if (line.scope === 'effect' && !EFFECT_KINDS.includes(line.kind)) throw new Error(`傳說裝備「${def.id}」的效果「${line.kind}」不存在`);
    if (!['wearer', 'effect'].includes(line.scope)) throw new Error(`傳說裝備「${def.id}」的獨有詞綴只能是 wearer 或 effect`);
  }
  for (const mechanic of def.mechanics ?? []) {
    if (!MECHANIC_TYPES.includes(mechanic.type)) throw new Error(`傳說裝備「${def.id}」的機制「${mechanic.type}」不存在`);
  }
}

module.exports = { LEGENDARIES, MECHANIC_TYPES, rollLegendary, rerollLegendaryValues, inferLegendaryTier, pickLegendary, mechanicsOf, describeMechanic };
