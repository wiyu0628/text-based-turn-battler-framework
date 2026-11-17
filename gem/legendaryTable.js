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
 *   武器的 attackStat 決定普攻吃 atk 或 int（傳說武器每件固定）。
 *   施放權重與製作裝備相同：round(100 × (ROLL_MIN～1))。
 *
 * ── 特殊機制（mechanics，寫成程式，存檔只存 legendaryId，編譯時才查表）──────────
 *   { type: 'grantSupport', gem }       這件裝備上的主動寶石**額外**具有該輔助寶石，不佔連結位、不算進 3 顆上限。
 *                                       玩家已經連了同一顆就不重複；與主動寶石不相容（例如條件不符、互斥）時自動不套用。
 *   { type: 'castOnEnemyDeath', text }  敵人倒下時，插隊多一個行動槽釋放這件裝備上的主動寶石一次（**不扣 SP**）。
 *                                       見 gemCompiler.js 的 buildEnemyDeathCastPassive。
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
    base: [{ stat: 'int', op: 'flat', max: 240 }],
    unique: [{ scope: 'wearer', stat: 'int', op: 'inc', max: 0.30 }],
    mechanics: [
      { type: 'castOnEnemyDeath', text: '{caster} 手中的報喪法杖為 {target} 敲響喪鐘！' },
      { type: 'grantSupport', gem: 'amp' }
    ]
  }
};

const LEGENDARY_WEIGHT = { max: 100 };
const MECHANIC_TYPES = ['grantSupport', 'castOnEnemyDeath'];

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
  const base = def.base.map(line => ({ stat: line.stat, op: line.op, value: round(line.stat, line.op, line.max * scale * roll()) }));
  const source = `legendary:${legendaryId}`;
  const affixes = def.unique.map(line => line.scope === 'wearer'
    ? { scope: 'wearer', stat: line.stat, op: line.op, value: round(line.stat, line.op, line.max * scale * roll()), source }
    : { scope: 'effect', kind: line.kind, value: round(null, null, line.max * scale * roll()), source });
  const castWeight = Math.round(LEGENDARY_WEIGHT.max * roll());
  return { slot: def.slot, origin: 'drop', legendaryId, ...(def.attackStat ? { attackStat: def.attackStat } : {}), base, affixes, castWeight };
}

/** 從所有傳說裝備平均抽一件的 id（之後有部位或難度限制時再加條件）。呼叫 rng 1 次。 */
function pickLegendary(rng = Math.random) {
  const ids = Object.keys(LEGENDARIES);
  return ids[Math.min(ids.length - 1, Math.floor(rng() * ids.length))];
}

/** 一件裝備的特殊機制（依 legendaryId 查表；不是傳說裝備回傳空陣列）。 */
function mechanicsOf(item) {
  return item?.legendaryId ? structuredClone(LEGENDARIES[item.legendaryId]?.mechanics ?? []) : [];
}

// 資料檢查：寫錯直接在載入時丟錯
for (const def of Object.values(LEGENDARIES)) {
  if (!['weapon', 'helmet', 'armor', 'boots'].includes(def.slot)) throw new Error(`傳說裝備「${def.id}」的部位不對`);
  if (def.attackStat !== undefined && (def.slot !== 'weapon' || !['atk', 'int'].includes(def.attackStat))) throw new Error(`傳說裝備「${def.id}」的 attackStat 只能是武器的 atk 或 int`);
  for (const line of def.unique) {
    if (line.scope === 'effect' && !EFFECT_KINDS.includes(line.kind)) throw new Error(`傳說裝備「${def.id}」的效果「${line.kind}」不存在`);
    if (!['wearer', 'effect'].includes(line.scope)) throw new Error(`傳說裝備「${def.id}」的獨有詞綴只能是 wearer 或 effect`);
  }
  for (const mechanic of def.mechanics ?? []) {
    if (!MECHANIC_TYPES.includes(mechanic.type)) throw new Error(`傳說裝備「${def.id}」的機制「${mechanic.type}」不存在`);
  }
}

module.exports = { LEGENDARIES, MECHANIC_TYPES, rollLegendary, pickLegendary, mechanicsOf };
