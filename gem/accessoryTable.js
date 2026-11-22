'use strict';

/**
 * 飾品表（純資料 + 檢查，不依賴框架）。2026-11-20 使用者加回飾品欄。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   飾品欄只有 1 個。飾品沒有基礎數值、沒有刻印、不能鑲寶石，只有固定的特殊詞綴（沒有詞綴池、不擲值）。
 *   取得：開局給 STARTING_ACCESSORIES；其他的由王首次擊敗固定掉落（bosses.js 的 rewards.accessories）。
 *   飾品是「擁有制」：存檔只記擁有哪些 id（save.accessories.owned）與穿著哪一個（save.accessories.equipped），
 *   詞綴每次從這張表查，所以改了數值不用遷移存檔。
 *
 * ── 格式 ──────────────────────────────────────────────────────
 *   { id, name, affixes: [詞綴…] }，詞綴和裝備詞綴相同：
 *     { scope: 'wearer', stat, op: 'flat'|'inc'|'more', value }   給穿戴者的屬性（statLayer）
 *     { scope: 'effect', kind, value }                            非屬性效果（affixTable.EFFECT_KINDS）
 *   數值是佔位（我擬的）：「靈式」的碎片的技能施放率 +5%、SP +40。
 *   玩家看到的類別名稱是 ACCESSORY_LABEL（「世界」的碎片）。
 */

const { EFFECT_KINDS } = require('./affixTable');
const { validateBonuses } = require('./statLayer');

const ACCESSORIES = {
  focus: {
    id: 'focus', name: '「靈式」的碎片',   // 2026-11-20 使用者命名（原本佔位叫專注護符）
    affixes: [
      { scope: 'wearer', stat: 'skillCastRate', op: 'flat', value: 0.05 },
      { scope: 'wearer', stat: 'sp', op: 'flat', value: 40 }
    ]
  },
  hourglass: {
    id: 'hourglass', name: '「烈風爪痕」的碎片',   // 2026-11-20 使用者命名（原本佔位叫延時沙漏）
    affixes: [
      { scope: 'effect', kind: 'ailmentDuration', value: 1 }
    ]
  },
  // 「相對機動」的碎片（2026-11-22 使用者設計，首次擊敗銀固定掉落）：玩家普攻連擊每擊倍率最低 10%。
  // 框架的連擊遞減是第 i 擊（從 0 數）× 0.6^i；有這個碎片時改成 × max(0.6^i, 0.1)（第 6 擊起才有差）。召喚物不受影響。
  relative: {
    id: 'relative', name: '「相對機動」的碎片',
    affixes: [
      { scope: 'effect', kind: 'comboFloor', value: 0.1 }
    ]
  }
};

// 開局給的飾品（使用者：之後可能 1～2 個；第二個還沒想好）。第一個開局就穿上。
const STARTING_ACCESSORIES = ['focus'];

// 玩家看到的「飾品」這一類的名字（使用者，2026-11-20）。程式與文件裡仍叫飾品（accessory）。
const ACCESSORY_LABEL = '「世界」的碎片';

/** 飾品的詞綴（加上來源 accessory:id）。不存在的 id 回傳空陣列。 */
function accessoryAffixes(id) {
  const def = ACCESSORIES[id];
  if (!def) return [];
  return def.affixes.map(affix => ({ ...affix, source: `accessory:${id}` }));
}

// 載入時檢查表本身
for (const [key, def] of Object.entries(ACCESSORIES)) {
  if (def.id !== key) throw new Error(`飾品「${key}」的 id 不一致`);
  if (typeof def.name !== 'string' || !def.name) throw new Error(`飾品「${key}」沒有名字`);
  if (!Array.isArray(def.affixes) || !def.affixes.length) throw new Error(`飾品「${key}」至少要有一條詞綴`);
  for (const affix of def.affixes) {
    if (affix.scope === 'wearer') {
      const problems = validateBonuses([affix]);
      if (problems.length) throw new Error(`飾品「${key}」：${problems.join('；')}`);
    } else if (affix.scope === 'effect') {
      if (!EFFECT_KINDS.includes(affix.kind)) throw new Error(`飾品「${key}」的效果「${affix.kind}」不是 EFFECT_KINDS 之一`);
      if (!(Number.isFinite(affix.value) && affix.value > 0)) throw new Error(`飾品「${key}」的效果數值必須大於 0`);
    } else throw new Error(`飾品「${key}」的詞綴 scope 必須是 wearer 或 effect`);
  }
}
for (const id of STARTING_ACCESSORIES) if (!ACCESSORIES[id]) throw new Error(`開局飾品「${id}」不存在`);

module.exports = { ACCESSORIES, STARTING_ACCESSORIES, ACCESSORY_LABEL, accessoryAffixes };
