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
    base: [{ stat: 'int', op: 'flat', max: 532 }],   // 預算 ×10 後 × 1.9（原本 280、35%）
    unique: [{ scope: 'wearer', stat: 'int', op: 'inc', max: 0.665 }],
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
    base: [{ stat: 'atk', op: 'flat', max: 532 }],
    unique: [
      { scope: 'wearer', stat: 'cri', op: 'flat', max: 0.2 },
      { scope: 'wearer', stat: 'criDmg', op: 'flat', range: [-0.3, -0.2] }
    ],
    mechanics: [{ type: 'castOnCrit', chance: 0.4, text: '{caster}連攜追擊，' }]
  },

  // 魔力循環法球（使用者設計，2026-11-19）：靠自循環拿 SP、補一點生存。
  // 護盾 = 智力 × 扣的 SP × 0.1（第 5 階放魔法飛彈約生命的 9%），持續 3 槽、再放取較大值並重置；任何盾碎掉回 2 SP。
  manaorb: {
    id: 'manaorb',
    name: '魔力循環法球',
    slot: 'weapon',
    attackStat: 'int',
    base: [{ stat: 'int', op: 'flat', max: 532 }],
    unique: [{ scope: 'wearer', stat: 'int', op: 'inc', max: 0.4 }],
    mechanics: [
      { type: 'spShield', ratio: 0.1, duration: 3 },
      { type: 'shieldBreakSp', sp: 2 }
    ]
  }
};

const LEGENDARY_WEIGHT = { low: 60, high: 120 };
const MECHANIC_TYPES = ['grantSupport', 'castOnEnemyDeath', 'castOnCrit', 'spShield', 'shieldBreakSp'];

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
 * @returns {{ slot, origin: 'drop', legendaryId, attackStat?, base, affixes, castWeight }}
 */
function rollLegendary(legendaryId, difficulty, rng = Math.random) {
  const def = LEGENDARIES[legendaryId];
  if (!def) throw new Error(`找不到傳說裝備「${legendaryId}」`);
  const scale = TIER_SCALE[openTier(difficulty)];
  const roll = () => ROLL_MIN + (1 - ROLL_MIN) * rng();
  // 每行 1 個亂數：一般行是 上限 × 階級縮放 × (0.7～1)；固定區間行直接在 range 內擲
  const raw = line => line.range ? line.range[0] + (line.range[1] - line.range[0]) * rng() : line.max * scale * roll();
  const base = def.base.map(line => ({ stat: line.stat, op: line.op, value: round(line.stat, line.op, raw(line)) }));
  const source = `legendary:${legendaryId}`;
  const affixes = def.unique.map(line => line.scope === 'wearer'
    ? { scope: 'wearer', stat: line.stat, op: line.op, value: round(line.stat, line.op, raw(line)), source }
    : { scope: 'effect', kind: line.kind, value: round(null, null, raw(line)), source });
  const castWeight = Math.round(LEGENDARY_WEIGHT.low + (LEGENDARY_WEIGHT.high - LEGENDARY_WEIGHT.low) * rng());   // 一樣只用一個亂數
  return { slot: def.slot, origin: 'drop', legendaryId, ...(def.attackStat ? { attackStat: def.attackStat } : {}), base, affixes, castWeight };
}

/** 從所有傳說裝備平均抽一件的 id（之後有部位或難度限制時再加條件）。呼叫 rng 1 次。 */
function pickLegendary(rng = Math.random) {
  const ids = Object.keys(LEGENDARIES);
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

module.exports = { LEGENDARIES, MECHANIC_TYPES, rollLegendary, pickLegendary, mechanicsOf, describeMechanic };
