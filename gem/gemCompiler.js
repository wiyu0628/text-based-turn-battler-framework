'use strict';

/**
 * 寶石編譯器 v9：主動寶石 + 輔助寶石 → 框架的 Skill（以及需要時的被動）。
 *
 * 只依賴框架公開的 Skill，不改框架任何檔案。流程與規則見 gems.js 開頭的說明。
 * 你的專案裡把下面的 require 換成 require('text-based-turn-battler-framework')。
 */
const { Skill, Buff, Entity, Formulas, random } = require('../src');
const { ACTIVE_GEMS, SUPPORT_GEMS, AILMENTS, GROUPS, MAX_SUPPORTS, DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT } = require('./gems');
const { validateBuffBonuses, statModifier } = require('./statLayer');

class GemLinkError extends Error {
  /**
   * @param {string} gemId 被指出的寶石。輔助寶石沒有順序，所以衝突時挑哪一顆是固定的（依 id 字母順序處理），
   *                       UI 不要只標這一顆，請搭配 conflictsWith 把雙方都標出來。
   * @param {string} reason 給玩家看的原因
   * @param {{ conflictsWith?: string }} [detail] 衝突的另一顆寶石 id（不是衝突類的錯誤時為 null）
   */
  constructor(gemId, reason, { conflictsWith = null } = {}) {
    super(`寶石「${gemId}」無法連結：${reason}`);
    this.name = 'GemLinkError';
    this.gemId = gemId;
    this.reason = reason;
    this.conflictsWith = conflictsWith;
  }
}

const KNOWN_OPS = new Set(['inc', 'more', 'cost', 'scope', 'actionFlag', 'appendAction', 'prependAction', 'reaction', 'grant', 'wrap', 'castCondition', 'proc', 'repeat', 'condInc', 'critAsDamage', 'sameActiveInc', 'chainAura', 'auraRecycle']);
const CONDITION_STATS = { selfHp: { name: '自身生命', ratio: true }, enemyCount: { name: '敵人數量', ratio: false } };
const GRANT_KINDS = new Set(['opening', 'lastResort', 'onCrit', 'comboCast']);
const WRAP_KINDS = new Set(['charge', 'echo']);
const PROC_PER = new Set(['hit', 'target']);

// ── 資料驗證 ────────────────────────────────────────────────

/**
 * 檢查輔助寶石資料本身有沒有寫錯（拼錯互斥組、未知的 op、requires 引用不存在的寶石…）。
 * 回傳問題清單；空陣列代表沒問題。compileSkill 每次都會先跑一次，寫錯會立刻失敗而不是靜默失效。
 */
function validateGemData(supportGems, groups) {
  const problems = [];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const lastResortThreshold = new Map(); // 'value' → 第一顆 lastResort 寶石的門檻，其餘要與它一致
  const onCritChance = new Map();        // 'value' → 第一顆 onCrit 寶石的機率，其餘要與它一致
  const comboMinHits = new Map();        // 'value' → 第一顆 comboCast 寶石的連擊門檻，其餘要與它一致
  for (const [key, gem] of Object.entries(supportGems)) {
    const where = `寶石「${key}」`;
    if (gem.id !== key) problems.push(`${where}的 id（${gem.id}）與登錄的鍵不一致`);
    if (gem.desc !== undefined && typeof gem.desc !== 'string') problems.push(`${where}的 desc 必須是字串`);
    else if (gem.desc !== undefined && Array.isArray(gem.effects)) {
      for (const key of unknownPlaceholders(gem)) problems.push(`${where}的 desc 用到算不出來的佔位 {${key}}`);
    }
    if (gem.exclusiveGroup !== undefined && !Object.hasOwn(groups, gem.exclusiveGroup)) {
      problems.push(`${where}的互斥組「${gem.exclusiveGroup}」沒有登錄在 GROUPS`);
    }
    for (const ref of gem.requires?.gems?.none || []) {
      if (!Object.hasOwn(supportGems, ref)) problems.push(`${where}的 requires.gems.none 引用了不存在的寶石「${ref}」`);
    }
    if (!Array.isArray(gem.effects) || !gem.effects.length) {
      problems.push(`${where}沒有 effects`);
      continue;
    }
    if (gem.removeTags !== undefined && !(Array.isArray(gem.removeTags) && gem.removeTags.every(tag => typeof tag === 'string'))) {
      problems.push(`${where}的 removeTags 必須是字串陣列`);
    }
    for (const effect of gem.effects) {
      if (!KNOWN_OPS.has(effect.op)) { problems.push(`${where}使用了未知的 op「${effect.op}」`); continue; }
      if ((effect.op === 'inc' || effect.op === 'more') && !finite(effect.value)) {
        problems.push(`${where}的 ${effect.op} 需要有限數字的 value（增量，例如 0.3 代表 +30%）`);
      }
      if (effect.op === 'cost' && !(finite(effect.value) && effect.value > -1)) {
        problems.push(`${where}的 cost 需要大於 -1 的增量（0.25 代表 +25%，-0.4 代表 -40%）`);
      }
      if (effect.op === 'scope' && (typeof effect.from !== 'string' || typeof effect.to !== 'string')) {
        problems.push(`${where}的 scope 需要 from 與 to`);
      }
      if (effect.op === 'actionFlag' && typeof effect.flag !== 'string') problems.push(`${where}的 actionFlag 需要 flag`);
      if ((effect.op === 'appendAction' || effect.op === 'prependAction') && !(effect.action && typeof effect.action.type === 'string')) {
        problems.push(`${where}的 ${effect.op} 需要 action`);
      }
      // BUFF 動作的 buff 可以用 statBonuses 描述數值修改（純資料）；編譯時轉成 STAT Buff 的 effect 函式。
      if ((effect.op === 'appendAction' || effect.op === 'prependAction') && effect.action?.type === 'BUFF') {
        for (const buff of effect.action.buffs || []) {
          if (buff.statBonuses === undefined) continue;
          if (typeof buff.effect === 'function') problems.push(`${where}的 buff「${buff.id}」不能同時有 statBonuses 與 effect`);
          if (buff.type !== 'STAT') problems.push(`${where}的 buff「${buff.id}」有 statBonuses，type 必須是 STAT`);
          problems.push(...validateBuffBonuses(buff.statBonuses).map(problem => `${where}的 buff「${buff.id}」statBonuses：${problem}`));
        }
      }
      if (effect.op === 'reaction' && !(effect.trigger && effect.do?.kind)) {
        problems.push(`${where}的 reaction 需要 trigger 與 do.kind`);
      }
      if (effect.op === 'proc') {
        if (!PROC_PER.has(effect.per)) problems.push(`${where}的 proc 需要 per 是 'hit' 或 'target'（收到「${effect.per}」）`);
        if (!(finite(effect.chance) && effect.chance > 0 && effect.chance <= 1)) problems.push(`${where}的 proc 需要 0 到 1 之間（不含 0）的 chance`);
        if (typeof effect.summary !== 'string' || !effect.summary) problems.push(`${where}的 proc 需要 summary（給玩家看的效果說明）`);
        if (effect.message !== undefined && typeof effect.message !== 'string') problems.push(`${where}的 proc message 必須是字串`);
        try { new Buff(structuredClone(effect.buff)); } catch (error) {
          problems.push(`${where}的 proc buff 不是合法的 Buff 設定：${error.message}`);
        }
      }
      if (effect.op === 'castCondition') {
        const stat = CONDITION_STATS[effect.of];
        if (!stat) {
          problems.push(`${where}的 castCondition 使用了未知的 of「${effect.of}」`);
        } else {
          const bounds = ['min', 'max'].filter(key => effect[key] !== undefined);
          if (!bounds.length) problems.push(`${where}的 castCondition 需要 min 或 max`);
          for (const key of bounds) {
            const value = effect[key];
            if (!finite(value) || value < 0 || (stat.ratio && value > 1) || (!stat.ratio && !Number.isInteger(value))) {
              problems.push(`${where}的 castCondition ${key} 不合理（${effect.of} ${stat.ratio ? '需要 0～1 的比例' : '需要不小於 0 的整數'}）`);
            }
          }
          if (bounds.length === 2 && effect.min > effect.max) problems.push(`${where}的 castCondition min 大於 max，永遠不會成立`);
        }
      }
      if (effect.op === 'condInc') {
        if (!finite(effect.value)) problems.push(`${where}的 condInc 需要有限數字 value`);
        const below = effect.when?.hpBelow;
        if (!(finite(below) && below > 0 && below <= 1)) problems.push(`${where}的 condInc 需要 when.hpBelow（0 到 1 之間，不含 0）`);
      }
      if (effect.op === 'sameActiveInc' && !finite(effect.value)) problems.push(`${where}的 sameActiveInc 需要有限數字 value`);
      if (effect.op === 'reaction' && effect.do?.kind === 'critMaxHp') {
        if (effect.trigger !== 'AFTER_DAMAGE_DEALT') problems.push(`${where}的 critMaxHp 只能掛在 AFTER_DAMAGE_DEALT`);
        if (!(finite(effect.do.ratio) && effect.do.ratio > 0 && effect.do.ratio <= 1)) problems.push(`${where}的 critMaxHp 需要 0 到 1 之間（不含 0）的 ratio`);
        if (effect.do.chance !== undefined && !(finite(effect.do.chance) && effect.do.chance > 0 && effect.do.chance <= 1)) problems.push(`${where}的 critMaxHp 的 chance 要在 0 到 1 之間（不含 0）`);
      }
      if (effect.op === 'reaction' && effect.do?.kind === 'drainSp') {
        if (effect.trigger !== 'AFTER_DAMAGE_DEALT') problems.push(`${where}的 drainSp 只能掛在 AFTER_DAMAGE_DEALT`);
        if (!(finite(effect.do.ratio) && effect.do.ratio > 0 && effect.do.ratio <= 1)) problems.push(`${where}的 drainSp 需要 0 到 1 之間（不含 0）的 ratio`);
      }
      if (effect.op === 'repeat') {
        if (!(Number.isInteger(effect.times) && effect.times >= 1)) problems.push(`${where}的 repeat 需要不小於 1 的整數 times`);
        if (effect.text !== undefined && typeof effect.text !== 'string') problems.push(`${where}的 repeat text 必須是字串`);
      }
      if (effect.op === 'wrap' && !WRAP_KINDS.has(effect.kind)) {
        problems.push(`${where}的 wrap 使用了未知的 kind「${effect.kind}」`);
      }
      if (effect.op === 'grant') {
        if (effect.text !== undefined && typeof effect.text !== 'string') problems.push(`${where}的 grant text 必須是字串`);
        if (!GRANT_KINDS.has(effect.kind)) {
          problems.push(`${where}的 grant 使用了未知的 kind「${effect.kind}」`);
        } else if (effect.kind === 'comboCast') {
          if (!(Number.isInteger(effect.minHits) && effect.minHits >= 2)) {
            problems.push(`${where}的 comboCast 需要不小於 2 的整數 minHits`);
          } else {
            const seen = comboMinHits.get('value');
            if (seen === undefined) comboMinHits.set('value', effect.minHits);
            else if (seen !== effect.minHits) problems.push(`${where}的 comboCast minHits（${effect.minHits}）與其他寶石（${seen}）不一致；同類 grant 會合併成一個被動，門檻必須相同`);
          }
        } else if (effect.kind === 'onCrit') {
          if (!(finite(effect.chance) && effect.chance > 0 && effect.chance <= 1)) {
            problems.push(`${where}的 onCrit 需要 0 到 1 之間（不含 0）的 chance`);
          } else {
            const seen = onCritChance.get('value');
            if (seen === undefined) onCritChance.set('value', effect.chance);
            else if (seen !== effect.chance) {
              problems.push(`${where}的 onCrit chance（${effect.chance}）與其他寶石（${seen}）不一致；同類 grant 會合併成一個被動，機率必須相同`);
            }
          }
        } else if (effect.kind === 'lastResort') {
          if (!(finite(effect.threshold) && effect.threshold > 0 && effect.threshold < 1)) {
            problems.push(`${where}的 lastResort 需要介於 0 與 1 之間的 threshold`);
          } else {
            const seen = lastResortThreshold.get('value');
            if (seen === undefined) lastResortThreshold.set('value', effect.threshold);
            else if (seen !== effect.threshold) {
              problems.push(`${where}的 lastResort threshold（${effect.threshold}）與其他寶石（${seen}）不一致；同類 grant 會合併成一個被動，門檻必須相同`);
            }
          }
        }
      }
    }
  }
  return problems;
}

function assertValidGemData(supportGems, groups) {
  const problems = validateGemData(supportGems, groups);
  if (problems.length) throw new Error(`寶石資料有誤：\n- ${problems.join('\n- ')}`);
}

// ── 條件 ────────────────────────────────────────────────────

// action 沒寫 targetType 時，框架視為 ENEMY_SINGLE。
const targetTypeOf = action => action.targetType || 'ENEMY_SINGLE';

// 條件一律對「基準」（主動寶石原本的樣子）判斷，不看其他輔助寶石改了什麼，
// 所以結果與連結順序無關。回傳 { reason, conflictsWith }；符合回傳 null。
function unmetReason(base, requires, linkedIds) {
  if (!requires) return null;
  const { tags, action, gems } = requires;
  if (tags?.all) {
    const missing = tags.all.filter(tag => !base.tags.includes(tag));
    if (missing.length) return { reason: `技能需要標籤 ${missing.join('、')}` };
  }
  if (tags?.none) {
    const present = tags.none.filter(tag => base.tags.includes(tag));
    if (present.length) return { reason: `技能不能有標籤 ${present.join('、')}` };
  }
  if (action) {
    const found = base.actions.some(item => item.type === action.type &&
      (action.targetType === undefined || targetTypeOf(item) === action.targetType));
    if (!found) {
      return { reason: `技能需要一段 ${action.type}${action.targetType ? `（${action.targetType}）` : ''} 動作` };
    }
  }
  if (gems?.none) {
    const clash = gems.none.filter(id => linkedIds.includes(id));
    if (clash.length) return { reason: `不能與 ${clash.join('、')} 同時連結`, conflictsWith: clash[0] };
  }
  return null;
}

// ── 文字 ────────────────────────────────────────────────────

// 字串裡的 {caster} {target} {value} {skill} 展開成框架要的函式。
const PLACEHOLDER = /\{(caster|target|value|skill)\}/g;
function expandPart(part) {
  if (typeof part !== 'string' || !part.includes('{')) return part;
  return ctx => part.replace(PLACEHOLDER, (_, key) => {
    if (key === 'caster') return ctx.caster.name;
    if (key === 'target') return ctx.target?.name ?? '';
    if (key === 'value') return ctx.value ?? '';
    return ctx.skill.name;
  });
}

function expandText(action) {
  if (!action.text) return action;
  const text = {};
  for (const [key, part] of Object.entries(action.text)) text[key] = expandPart(part);
  return { ...action, text };
}

const round4 = value => Math.round(value * 1e4) / 1e4;

// BUFF 動作裡的 statBonuses（純資料）→ 框架 STAT Buff 需要的 effect 函式。其他動作原樣回傳。
function withStatEffects(action) {
  if (action.type !== 'BUFF' || !Array.isArray(action.buffs)) return action;
  return {
    ...action,
    buffs: action.buffs.map(buff => {
      if (buff.statBonuses === undefined) return buff;
      const { statBonuses, ...rest } = buff;
      return { ...rest, effect: statModifier(statBonuses) };
    })
  };
}

// ── 玩家看的說明 ────────────────────────────────────────────

// 0.3 → '30%'，0.155 → '15.5%'。符號由呼叫端用「增加 / 減少」表達，這裡只給大小。
const pct = value => `${+(Math.abs(value) * 100).toFixed(2)}%`;

const TARGET_NAMES = {
  ENEMY_SINGLE: '單一敵人', ENEMY_ALL: '全體敵人',
  ALLY_SINGLE: '單一友方', ALLY_ALL: '全體友方', SELF: '自身'
};
const FLAG_TEXT = { ignoreDefense: '無視目標防禦' };
const BADGE = { inc: '加算', more: '乘算' };

// 施放條件的說明：只講一個量的上下界，例如「自身生命 50% 以下時才能施放」。
function describeCondition({ of, min, max }) {
  const hp = of === 'selfHp';
  const lower = min === undefined ? null : hp ? `${pct(min)} 以上` : `至少 ${min} 名`;
  const upper = max === undefined ? null : hp ? `${pct(max)} 以下` : `至多 ${max} 名`;
  return `${hp ? '自身生命' : '存活敵人'} ${[lower, upper].filter(Boolean).join('且 ')}時才能施放`;
}

function describeEffect(effect) {
  switch (effect.op) {
    // 加算與乘算刻意用不同的措辭與括號標記，玩家一眼就分得出是哪一區。
    case 'inc':
      return { kind: 'inc', text: `${effect.value >= 0 ? '提高' : '降低'} ${pct(effect.value)} 傷害（加算）` };
    case 'more':
      return { kind: 'more', text: `額外${effect.value >= 0 ? '增加' : '減少'} ${pct(effect.value)} 傷害（乘算）` };
    case 'cost':
      return { kind: 'cost', text: `SP 消耗${effect.value >= 0 ? '增加' : '減少'} ${pct(effect.value)}` };
    case 'scope':
      return { kind: 'scope', text: `攻擊對象由${TARGET_NAMES[effect.from] ?? effect.from}改為${TARGET_NAMES[effect.to] ?? effect.to}` };
    case 'actionFlag':
      if (effect.flag === 'ignoreDefense' && typeof effect.value === 'number') {
        return { kind: 'flag', text: `無視目標 ${Math.round(effect.value * 100)}% 的防禦` };
      }
      return { kind: 'flag', text: effect.value === true ? (FLAG_TEXT[effect.flag] ?? `啟用 ${effect.flag}`) : `${effect.flag} = ${effect.value}` };
    case 'appendAction':
      return { kind: 'effect', text: effect.text ?? '追加一段效果' };
    case 'prependAction':
      return { kind: 'effect', text: effect.text ?? '使用前先發動一段效果' };
    case 'reaction':
      return { kind: 'effect', text: effect.do.kind === 'leech'
        ? `造成實際傷害的 ${pct(effect.do.ratio)} 回復自身生命`
        : effect.do.kind === 'drainSp' ? `每一擊命中時，減少目標 ${pct(effect.do.ratio)} SP 上限的 SP`
        : effect.do.kind === 'critMaxHp' ? `暴擊時${(effect.do.chance ?? 1) < 1 ? `有 ${pct(effect.do.chance)} 機率` : ''}追加目標生命上限 ${pct(effect.do.ratio)} 的傷害（不會暴擊、受防禦影響）`
        : `${effect.trigger} 時觸發 ${effect.do.kind}` };
    case 'auraRecycle':
      return { kind: 'effect', text: `光環每回合的維持費累計每 ${effect.per} 點，回復 ${effect.gain} 點 SP（零頭保留；開啟前不算；不超過 SP 上限；每個光環各自累計）` };
    case 'chainAura':
      return { kind: 'effect', text: '只對光環主動寶石有效（連到其他主動寶石沒有效果）：輔助槽可以放其他光環主動寶石，被放進來的光環不會自己開啟，這個光環開啟時一起開啟（不會多給行動；SP 各自每回合扣、各自判斷）' };
    case 'sameActiveInc':
      return { kind: 'inc', text: `穿戴中每多一組相同的主動寶石（這組以外），提高 ${pct(effect.value)} 傷害（加算）` };
    case 'proc':
      return { kind: 'proc', text: `${effect.per === 'hit' ? '每一擊' : '每個被打中的敵人'}有 ${pct(effect.chance)} 機率：${effect.summary}` };
    case 'castCondition':
      return { kind: 'condition', text: describeCondition(effect) };
    case 'condInc':
      return { kind: 'inc', text: `生命低於 ${pct(effect.when.hpBelow)} 時，提高 ${pct(effect.value)} 傷害（加算，施放當下判斷）` };
    case 'critAsDamage':
      return { kind: 'more', text: '傷害額外乘上（1 + 爆擊率 ×（爆擊傷害 − 1））（乘算，施放當下讀取；爆擊率最多算到 100%）' };
    case 'repeat':
      return { kind: 'effect', text: `追加 ${effect.times} 次同樣的攻擊：打同一個目標，各自判定命中與暴擊、各自附加異常與機率效果（目標倒下就不再追擊）` };
    case 'wrap':
      if (effect.kind === 'echo') {
        return { kind: 'effect', text: '使用時只開啟迴響（付 SP、不造成傷害）；之後這個技能不再被選用，改為每回合開始時自動免費釋放一次（佈局、追擊等觸發仍可施放）' };
      }
      return { kind: 'effect', text: '使用後需要等一個行動槽：下一次行動時自動釋放，期間不能改做別的事（SP 在使用時一次扣完）' };
    case 'grant':
      if (effect.kind === 'opening') {
        return { kind: 'effect', text: '戰鬥開始後的第一次行動必定施放此技能（多個技能連結佈局時，隨機選一個）' };
      }
      if (effect.kind === 'comboCast') {
        return { kind: 'effect', text: `普攻一次打出 ${effect.minHits} 連擊以上時，立刻額外施放此技能（不耗 SP；每個行動槽最多一次；多個技能連結時，隨機選一個）` };
      }
      if (effect.kind === 'onCrit') {
        return { kind: 'effect', text: `自己的任何攻擊暴擊時，有 ${pct(effect.chance)} 機率立刻額外施放此技能（不耗 SP；每個行動槽最多一次，額外施放的那次不會再觸發；多個技能連結時，隨機選一個）` };
      }
      return { kind: 'effect', text: `生命第一次降到 ${pct(effect.threshold)} 以下時，立刻額外行動一次並施放此技能（多個技能連結時，隨機選一個）` };
    default:
      return { kind: 'effect', text: `未知效果 ${effect.op}` };
  }
}

/**
 * 產生一顆輔助寶石給玩家看的說明。
 * @returns {{ id, name, badges: string[], lines: { kind, text }[] }}
 *   badges  這顆寶石涉及的傷害加成區，'加算' 與 / 或 '乘算'（可能是空陣列）
 *   lines   每個效果一行；kind 可讓 UI 依類型上色（inc / more / cost / scope / flag / condition / proc / effect / group）
 */
function describeSupport(gem, groups = GROUPS) {
  const lines = gem.effects.map(describeEffect);
  const badges = ['inc', 'more'].filter(kind => lines.some(line => line.kind === kind)).map(kind => BADGE[kind]);
  if (gem.exclusiveGroup) {
    const name = groups[gem.exclusiveGroup]?.name ?? gem.exclusiveGroup;
    lines.push({ kind: 'group', text: `互斥組：${name}（同組只能連結一顆）` });
  }
  return { id: gem.id, name: gem.name, badges, lines };
}

// ── 背包說明（玩家看的兩行） ────────────────────────────────
// 第一行「與○○技能連結。」由 requires 自動產生；第二行是寶石資料的 desc，裡面的 {佔位} 從 effects 算出來，
// 所以數字改了說明就跟著改（使用者 2026-11-19 指定句子）。describeSupport() 的逐條規則留給詳細說明與數值表。

/** 依連結條件產生「與○○技能連結。」 */
function linkTargetText(gem) {
  if (gem.linkText) return gem.linkText;   // 條件不寫在 requires 的寶石（例如連續光環：連錯沒有效果、不報錯）自己寫第一行
  const action = gem.requires?.action;
  if (!action) return '與任意技能連結。';
  const tags = gem.requires?.tags ?? {};
  const kind = (tags.all ?? []).includes('spell') ? '法術' : (tags.none ?? []).includes('spell') ? '物理' : '';
  const range = action.targetType === 'ENEMY_SINGLE' ? '單體' : action.targetType === 'ENEMY_ALL' ? '群體' : '';
  return `與${range}${kind}${action.type === 'DAMAGE' ? '攻擊' : ''}技能連結。`;
}

/** desc 可用的佔位與數值（都轉成百分比字串）。 */
function playerPlaceholders(gem) {
  const effects = gem.effects ?? [];
  const values = {};
  const mores = effects.filter(e => e.op === 'more');
  if (mores.length) values.more = pct(mores.reduce((p, e) => p * (1 + e.value), 1));
  const incs = effects.filter(e => e.op === 'inc');
  if (incs.length) values.inc = pct(incs.reduce((s, e) => s + e.value, 0));
  const costs = effects.filter(e => e.op === 'cost');
  if (costs.length) values.cost = pct(costs.reduce((p, e) => p * (1 + e.value), 1) - 1);
  for (const e of effects) {
    if (e.op === 'actionFlag' && e.flag === 'ignoreDefense') values.ignoreDefense = pct(e.value);
    if (e.op === 'reaction' && e.do?.kind === 'leech') values.leech = pct(e.do.ratio);
    if (e.op === 'reaction' && e.do?.kind === 'drainSp') values.drain = pct(e.do.ratio);
    if (e.op === 'reaction' && e.do?.kind === 'critMaxHp') { values.critMaxHp = pct(e.do.ratio); values.critChance = pct(e.do.chance ?? 1); }
    if (e.op === 'sameActiveInc') values.sameActiveInc = pct(e.value);
    if (e.op === 'auraRecycle') { values.per = String(e.per); values.gain = String(e.gain); }
    if (e.op === 'condInc') { values.condInc = pct(e.value); values.hpBelow = pct(e.when.hpBelow); }
    if (e.op === 'grant' && e.threshold !== undefined) values.threshold = pct(e.threshold);
    if (e.op === 'grant' && e.chance !== undefined) values.chance = pct(e.chance);
    if (e.op === 'grant' && e.minHits !== undefined) values.minHits = String(e.minHits);
    for (const buff of e.action?.buffs ?? []) {
      for (const bonus of buff.statBonuses ?? []) if (bonus.op === 'flat') values[bonus.stat] = pct(bonus.value);
      if (buff.damageTaken?.multiplier !== undefined) values.damageTaken = pct(buff.damageTaken.multiplier - 1);
      if (buff.duration !== undefined) values.duration = String(buff.duration);
    }
  }
  return values;
}

/** desc 裡用到、但算不出來的佔位（資料檢查用）。 */
function unknownPlaceholders(gem) {
  const values = playerPlaceholders(gem);
  return [...String(gem.desc ?? '').matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(key => values[key] === undefined);
}

/**
 * 背包裡給玩家看的說明：[第一行（連結對象）, 第二行（desc 填好數字）]。
 * 沒寫 desc 的寶石（例如測試用寶石）退回 describeSupport 的逐條規則。
 */
function describePlayer(gem) {
  const values = playerPlaceholders(gem);
  const body = gem.desc !== undefined
    ? gem.desc.replace(/\{(\w+)\}/g, (all, key) => values[key] ?? all)
    : describeSupport(gem).lines.map(line => line.text).join('；');
  return [linkTargetText(gem), body];
}

// ── 被動 ────────────────────────────────────────────────────

function buildPassive(skillId, reaction) {
  if (reaction.trigger === 'AFTER_ATTACK_DEALT' && reaction.do?.kind === 'leech') {
    const { ratio } = reaction.do;
    return {
      trigger: 'AFTER_ATTACK_DEALT',
      enabled: (self, hit) => self.isAlive && hit.skill?.id === skillId,
      action(self, hit, logger, engine) {
        const amount = Math.floor(hit.actualDamage * ratio);
        if (amount <= 0) return;
        const healed = self.heal(amount, logger, { engine, deferReactions: true });
        if (healed > 0) {
          logger.addLog({ type: 'HEAL', actorId: self.id, targetId: self.id, skillId, value: healed,
            message: `${self.name} 汲取了 ${healed} 點生命！` });
        }
        self.checkPassives('ON_HP_CHANGE', logger, engine);
      }
    };
  }
  // 吸魔：這個技能每一擊命中（目標還活著）就扣目標 ratio × SP 上限的 SP（無條件捨去，最多扣到 0）。
  if (reaction.trigger === 'AFTER_DAMAGE_DEALT' && reaction.do?.kind === 'drainSp') {
    const { ratio } = reaction.do;
    return {
      trigger: 'AFTER_DAMAGE_DEALT',
      enabled: (self, hit) => self.isAlive && hit.skill?.id === skillId && hit.target?.isAlive,
      action(self, hit, logger) {
        const target = hit.target;
        const lost = Math.min(target.stats.sp, Math.floor((target.stats.maxSp || 0) * ratio));
        if (lost <= 0) return;
        target.stats.sp -= lost;
        logger.addLog({ type: 'TEXT', actorId: self.id, targetId: target.id, skillId, value: lost, message: `${target.name} 失去了 ${lost} 點 SP！` });
      }
    };
  }
  // 混沌爆擊（2026-11-22 使用者）：這個技能暴擊的那一擊之後，追加目標生命上限 ratio 的傷害。
  // 不會暴擊；受防禦影響（同框架公式 300 ÷ (防禦 + 300)，讀目標含 Buff 的防禦）；當成直接扣血，不再觸發攻擊類反應。
  if (reaction.trigger === 'AFTER_DAMAGE_DEALT' && reaction.do?.kind === 'critMaxHp') {
    const { ratio, chance = 1 } = reaction.do;
    return {
      trigger: 'AFTER_DAMAGE_DEALT',
      enabled: (self, hit) => self.isAlive && hit.skill?.id === skillId && hit.isCrit && hit.target?.isAlive,
      action(self, hit, logger, engine) {
        if (chance < 1 && random() >= chance) return;   // 2026-11-22 使用者：50% 機率
        const target = hit.target;
        const def = Math.max(0, (target.getEffectiveStats?.() ?? target.stats).def ?? 0);
        const amount = Math.max(1, Math.floor((target.stats.maxHp ?? 0) * ratio * 300 / (def + 300)));
        const dealt = target.takeDamage(amount, logger, { source: 'DIRECT', tags: ['chaos'] });
        logger.addLog({ type: 'DAMAGE', actorId: self.id, targetId: target.id, skillId, isNormalAttack: false, value: dealt.actualDamage ?? amount,
          message: `混沌的裂痕撕開了 ${target.name}，追加 ${dealt.actualDamage ?? amount} 點傷害！` });
        target.finishDamage?.(dealt, logger, engine);
      }
    };
  }
  throw new Error(`尚不支援的 reaction：${reaction.trigger} / ${reaction.do?.kind}`);
}

// 機率附加效果：做成施放者身上的被動，用框架的 random() 擲骰。
// per 'hit' 掛在逐擊的 AFTER_DAMAGE_DEALT（打完目標還活著才會叫到）；
// per 'target' 掛在整招彙總的 AFTER_ATTACK_DEALT（每個目標一次，目標已倒下就略過）。
function buildProcPassive(skillId, proc) {
  const applyTo = (self, target, hit, logger, engine) => {
    if (!target?.isAlive) return;
    if (proc.chance < 1 && random() >= proc.chance) return;
    const buff = target.addBuff(structuredClone(proc.buff), engine);
    if (buff === false) return; // 被目標拒收（addBuff 回傳 false）就不印施加句
    const context = { caster: self, target, skill: hit.skill };
    logger.addLog({
      type: 'BUFF_APPLY', actorId: self.id, skillId, isNormalAttack: false, targetId: target.id,
      message: proc.message ? expandPart(proc.message)(context) : `${self.name} 使 ${target.name} 陷入「${proc.buff.name}」！`
    });
  };
  return {
    gemSkillId: skillId,
    trigger: proc.per === 'hit' ? 'AFTER_DAMAGE_DEALT' : 'AFTER_ATTACK_DEALT',
    enabled: (self, hit) => self.isAlive && hit.skill?.id === skillId,
    action: (self, hit, logger, engine) => applyTo(self, hit.target, hit, logger, engine)
  };
}

// ── 異常效果（裂傷等持續傷害）──────────────────────────────

const AILMENT_BASES = new Set(['stat', 'hit']);

// 檢查動作上的 ailments（見 gems.js 檔頭「異常效果」）；資料有誤直接丟錯。
function checkAilments(action, where) {
  if (action.ailments === undefined) return;
  if (action.type !== 'DAMAGE') throw new Error(`${where}：ailments 只能寫在 DAMAGE 動作上`);
  if (!Array.isArray(action.ailments) || !action.ailments.length) throw new Error(`${where}：ailments 必須是非空陣列`);
  for (const ailment of action.ailments) {
    if (!Object.hasOwn(AILMENTS, ailment?.kind)) throw new Error(`${where}：找不到異常效果「${ailment?.kind}」（見 gems.js 的 AILMENTS）`);
    if (!AILMENT_BASES.has(ailment.basis)) throw new Error(`${where}：異常效果的 basis 必須是 'stat' 或 'hit'（收到「${ailment.basis}」）`);
    if (!(Number.isFinite(ailment.power) && ailment.power > 0)) throw new Error(`${where}：異常效果的 power 必須是大於 0 的有限數字`);
    if (!(Number.isInteger(ailment.duration) && ailment.duration >= 1)) throw new Error(`${where}：異常效果的 duration 必須是 1 以上的整數`);
  }
}

// 命中當下結算的每次發作傷害（不暴擊、不浮動）：
//   stat  施放者有效能力值 × power（不吃寶石與裝備的傷害加成、不看防禦）
//   hit   這一擊的傷害（戰報數字，hit.damage）× power
function ailmentDamage(caster, hit, ailment) {
  const base = ailment.basis === 'hit' ? hit.damage : caster.getEffectiveStats()[hit.action.stat ?? 'atk'];
  return Math.max(1, Math.floor(base * ailment.power));
}

// 每次命中（AFTER_DAMAGE_DEALT：造成傷害且目標還活著）對目標疊一層異常；讀的是這一擊所屬動作上的 gemAilments。
function buildAilmentPassive(skillId) {
  return {
    gemSkillId: skillId,
    trigger: 'AFTER_DAMAGE_DEALT',
    enabled: (self, hit) => self.isAlive && hit.skill?.id === skillId && Array.isArray(hit.action?.gemAilments),
    action(self, hit, logger, engine) {
      const target = hit.target;
      if (!target?.isAlive) return;
      for (const ailment of hit.action.gemAilments) {
        const def = AILMENTS[ailment.kind];
        const value = ailmentDamage(self, hit, ailment);
        // 不加 stackPolicy：同 id 的 Buff 並存，每層各自倒數（重複獲得可疊加、持續時間分別計算）。
        const buff = target.addBuff({ id: `gem_ailment:${ailment.kind}`, name: def.name, type: 'DOT', duration: ailment.duration, value,
          polarity: 'negative', dispellable: true, tags: [...(def.tags ?? [])] }, engine);
        if (buff === false) continue;
        logger.addLog({ type: 'BUFF_APPLY', actorId: self.id, skillId, isNormalAttack: false, targetId: target.id, value,
          message: `${target.name} 陷入「${def.name}」！` });
      }
    }
  };
}

// ── 角色層級的被動（佈局、撒手鐧）──────────────────────────

// 從候選裡隨機挑一個；只有一個時不擲骰（不多吃亂數）。
const pickOne = pool => pool.length === 1 ? pool[0] : pool[Math.floor(random() * pool.length)];

// 動作串裡「對自己、只持續一個行動槽（duration 1）」的 Buff id，例如爆擊強化。
function slotBuffIds(actions) {
  const ids = [];
  for (const action of actions) {
    if (action.type !== 'BUFF' || action.targetType !== 'SELF') continue;
    for (const buff of action.buffs || []) if (buff.duration === 1 && !buff.trigger) ids.push(buff.id);
  }
  return ids;
}

// 插隊行動槽（撒手鐧）結束時，框架（BattleEngine.runInsertedActions）不會倒數 Buff，
// 所以「只持續一個行動槽」的 Buff 會多撐到角色下一個自己的行動槽，讓下一次攻擊也吃到。
// 這裡在插隊的技能跑完後，把它自己掛上的這類 Buff 移除，效果就與一般行動槽一致。
function withSlotCleanup(skill, buffIds) {
  if (!buffIds?.length) return skill;
  const variant = Object.create(skill);
  variant.execute = function execute(caster, ...args) {
    try { return skill.execute.call(this, caster, ...args); }
    finally { caster.buffs = caster.buffs.filter(buff => !buffIds.includes(buff.id)); }
  };
  return variant;
}

// 施放時戰報第一句多出一段開頭（目前佈局的「第一動」用到；grant 的 text 欄位通用，撒手鐧也可以寫）。
// 做法：回傳原技能的「複本」——id、名稱、判定、被動的比對全都照舊，只有第一個動作的 text.action 換成加了開頭的版本。
// 原技能不動，所以平常施放（不是以佈局／撒手鐧的身分）的戰報完全沒有變。
//   - 一次施放只加一次：複本的 execute 開頭立一面旗，第一次用到 text.action 時才加（全體攻擊不會每個目標都重複）。
//   - 開頭接在「技能那一行」（gemLeadIndex 指的動作）：前置動作（爆擊強化的提示）排在它前面，不被接上開頭。
//   - 原本的第一句若以施放者名字開頭（「勇者 詠唱…」），先拿掉名字再接上，避免變成「勇者的第一動，勇者 詠唱…」。
function withLeadText(skill, rawText) {
  const lead = expandPart(rawText);
  const index = skill.gemLeadIndex ?? 0;
  const first = skill.actions[index];
  const baseText = first.text?.action;
  const resolve = (part, ctx) => typeof part === 'function' ? part(ctx) : (part ?? '');
  let pending = false;
  const action = {
    ...first,
    text: {
      ...first.text,
      action: ctx => {
        // 框架對沒寫 text.action 的傷害段預設是「施放者 攻擊，」
        const base = baseText === undefined ? (first.type === 'DAMAGE' ? `${ctx.caster.name} 攻擊，` : '') : resolve(baseText, ctx);
        if (!pending) return base;
        pending = false;
        const name = ctx.caster.name;
        const body = base.startsWith(name) ? base.slice(name.length).trimStart() : base;
        return resolve(lead, ctx) + body;
      }
    }
  };
  const variant = Object.create(skill);
  variant.actions = skill.actions.map((original, i) => (i === index ? action : original));
  variant.execute = function execute(...args) {
    pending = true;
    try { return skill.execute.apply(this, args); } finally { pending = false; }
  };
  return variant;
}

/**
 * 把一批編譯結果的 grants 合併成被動：同類只有一個被動，觸發時從「當下可用」的候選技能裡隨機挑一個。
 *   opening     BATTLE_START 時挑一個付得起的，設成 entity.openingSkill（框架在第一次行動時使用；SP 不夠就照常行動）
 *   lastResort  HP_BELOW 一次性觸發，挑一個付得起且沒被沉默的，用 engine.insertAction 插隊多一個行動槽
 * 被動帶有戰鬥狀態（triggered 旗標），每場戰鬥都要重新建立。
 * @param {{ skill: Skill, grants: object[] }[]} compiledList compileSkill 的回傳值
 */
function buildGrantPassives(compiledList) {
  const candidates = { opening: [], lastResort: [], onCrit: [], comboCast: [] };
  let threshold = null;
  let critChance = null;
  let comboMinHits = null;
  for (const { skill: own, grantSkill, grants = [] } of compiledList) {
    const skill = grantSkill ?? own;   // 迴響：觸發類要用「開啟前開啟、開啟後釋放」的分派版本
    for (const grant of grants) {
      // skill 用來判斷能不能放；use 是實際放出去的版本（有 text 時是加了開頭的複本）
      candidates[grant.kind].push({ skill, use: grant.text ? withLeadText(skill, grant.text) : skill });
      if (grant.kind === 'lastResort') threshold = grant.threshold;
      if (grant.kind === 'onCrit') critChance = grant.chance;
      if (grant.kind === 'comboCast') comboMinHits = grant.minHits;
    }
  }
  const passives = [];

  if (candidates.opening.length) {
    const pool = candidates.opening;
    passives.push({
      id: 'gem_opening',
      trigger: 'BATTLE_START',
      action(self, battle, logger, engine) {
        const castable = pool.filter(entry => entry.skill.canCast(self, engine));
        if (castable.length) self.openingSkill = pickOne(castable).use;
      }
    });
  }

  if (candidates.lastResort.length) {
    const pool = candidates.lastResort;
    passives.push({
      id: 'gem_lastResort',
      condition: 'HP_BELOW',
      threshold,
      action(self, logger, engine) {
        if (!engine) return; // 沒有引擎就無法插隊（例如只呼叫 skill.execute 的測試）
        // 插隊行動不檢查沉默、SP 不足也不會被擋下，所以在這裡先把不能用的濾掉。
        const usable = pool.filter(entry => entry.skill.canCast(self, engine) && !self.silencedBy(entry.skill));
        if (!usable.length) return;
        const picked = pickOne(usable);
        const use = withSlotCleanup(picked.use, picked.skill.gemSlotBuffIds);
        logger.addLog({ type: 'TEXT', actorId: self.id, message: `${self.name} 拚死一搏，獲得額外的行動！` });
        engine.insertAction(self, use, {
          onSkip: entity => logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name} 的額外行動被打斷了。` })
        });
      }
    });
  }
  // 暴擊時觸發（onCrit）：自己的任何一擊暴擊（普攻、技能都算）時擲 critChance，成功就插隊免費施放。
  if (candidates.onCrit.length) {
    passives.push(...buildTriggeredCast('onCrit', candidates.onCrit,
      (self, hit) => hit.isCrit === true && random() < critChance, '{caster}乘勢追擊，'));
  }
  // 普攻連擊觸發（comboCast，追擊）：自己的普攻這一槽打 minHits 擊以上時，插隊免費施放（必定觸發）。
  // 以普攻第一次打中（AFTER_DAMAGE_DEALT）時判斷；連擊數是框架這一槽算好的 hits。
  if (candidates.comboCast.length) {
    passives.push(...buildTriggeredCast('comboCast', candidates.comboCast,
      (self, hit) => hit.isNormalAttack === true && hit.hits >= comboMinHits, '{caster}追擊，'));
  }
  return passives;
}

/**
 * 觸發式免費施放（onCrit、comboCast 共用）：自己造成傷害的某一擊符合 condition 時，插隊多一個行動槽免費（不耗 SP）施放。
 * 每個「自己的行動槽」最多觸發一次（AFTER_ACTION 數槽）；觸發出來的那一次帶 gemTriggered 標記，它造成的傷害不再觸發。
 * 多個技能連結同一種時隨機選一個（被沉默的跳過）。lead 是技能那一行的開頭（例如「{caster}追擊，」），跟佈局一樣接在施放行前面。
 */
function buildTriggeredCast(kind, entries, condition, lead) {
  const pool = entries.map(entry => {
    const base = withLeadText(entry.use, lead);
    const free = Object.create(base);
    free.gemTriggered = true;
    free.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
      return base.execute.call(this, caster, allies, enemies, logger, context, { ...options, ignoreSp: true });
    };
    return { skill: entry.skill, use: withSlotCleanup(free, entry.skill.gemSlotBuffIds) };
  });
  let slot = 0;
  let usedAt = -1;
  return [{
    id: `gem_${kind}:slot`,
    trigger: 'AFTER_ACTION',
    enabled: (self, ctx) => ctx?.actor === self,
    action: () => { slot++; }
  }, {
    id: `gem_${kind}`,
    trigger: 'AFTER_DAMAGE_DEALT',
    enabled: (self, hit) => self.isAlive && !hit.skill?.gemTriggered && usedAt !== slot,
    action(self, hit, logger, engine) {
      if (!engine || engine.result) return;
      if (!condition(self, hit)) return;
      const usable = pool.filter(entry => !self.silencedBy?.(entry.skill));
      if (!usable.length || !self.canAct?.()) return;
      usedAt = slot;
      engine.insertAction(self, pickOne(usable).use);
    }
  }];
}

// ── 裝備給的機制（傳說裝備，見 legendaryTable.js）────────────────

/**
 * 連攜匕首（castOnCrit）：自己的任何一擊暴擊時擲 chance，成功就插隊免費釋放這件裝備上的主動寶石一次。
 * 同一件裝備上的多組連結合成一個觸發（隨機選一），規則同 buildTriggeredCast（每槽最多一次、不連鎖）。
 * 蓄力用本體、迴響用分派版（開啟前是開啟、開啟後是傷害版），和報喪法杖相同。
 */
function buildCritCastPassives(critCasts) {
  if (!critCasts.length) return [];
  const { chance, text } = critCasts[0][1];
  const entries = critCasts.map(([result]) => {
    const skill = result.grantSkill ?? result.release ?? result.skill;
    return { skill, use: skill };
  });
  return buildTriggeredCast('legendCrit', entries, (self, hit) => hit.isCrit === true && random() < chance, text ?? '{caster}連攜追擊，');
}

/**
 * 魔力循環法球（spShield）：包住技能的 execute，量「這次施放實際扣掉的 SP」；有扣就給自己魔力護盾
 * = 智力（含 Buff）× 扣的 SP × ratio。已經有魔力護盾時取較大值並重置持續時間（不疊加）。
 */
const MANA_SHIELD_ID = 'legend_manaShield';
function withSpShield(skill, spec) {
  const base = skill.execute;
  skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    const before = caster.stats.sp;
    const result = base.call(this, caster, allies, enemies, logger, context, options);
    const spent = before - caster.stats.sp;
    if (spent > 0 && caster.isAlive) {
      const intel = (caster.getEffectiveStats?.() ?? caster.stats).int || 0;
      const amount = Math.max(1, Math.round(intel * spent * spec.ratio));
      const current = caster.buffs.find(buff => buff.id === MANA_SHIELD_ID);
      if (current) {
        current.shield.value = Math.max(current.shield.value, amount);
        current.duration = spec.duration;
      } else {
        caster.addBuff({ id: MANA_SHIELD_ID, name: '魔力護盾', duration: spec.duration, shield: amount, polarity: 'positive', dispellable: true }, context);
      }
      logger?.addLog({ type: 'TEXT', actorId: caster.id, value: amount, message: `${caster.name} 獲得了 ${amount} 點魔力護盾！` });
    }
    return result;
  };
  return skill;
}

/**
 * 幻影戰斧（phantom）：開戰時在自己這一隊召喚「幻影」——屬性照自己（含裝備與 Buff）：生命／攻擊／智力／防禦 × ratio，
 * 生命再 ×（1 + 召喚物生命）；速度、爆擊、命中、閃避照抄。幻影平常依速度自己普攻，沒有技能。
 * 自己倒下時幻影一起消失（isAlive 綁在召喚者身上，所以勝負只看自己）。
 */
function buildPhantomPassive(spec, summonHp = 0) {
  return {
    id: 'legend_phantom',
    trigger: 'BATTLE_START',
    enabled: self => self.isAlive,
    action(self, battle, logger, engine) {
      if (!engine || engine.result) return;
      const base = self.getEffectiveStats?.() ?? self.stats;
      // ratios（選填）可以每項分開：{ hp, atk, int, def, spd }；沒寫的用 ratio。spd 預設照抄（1）。
      const ratioOf = key => spec.ratios?.[key] ?? (key === 'spd' ? 1 : spec.ratio);
      const scale = key => Math.max(key === 'hp' ? 1 : 0, Math.round((base[key] || 0) * ratioOf(key) * (key === 'hp' ? 1 + summonHp : 1)));
      const hp = scale('hp');
      const stats = { hp, maxHp: hp, atk: scale('atk'), int: scale('int'), def: scale('def'), sp: 0, maxSp: 0,
        spd: Math.max(1, Math.round(base.spd * ratioOf('spd'))), cri: base.cri, criDmg: base.criDmg, hit: base.hit ?? 0, eva: base.eva ?? 0, skillCastRate: 0 };
      const stat = self.normalAttack?.actions?.[0]?.stat ?? 'atk';
      const fill = template => template.replaceAll('{caster}', self.name);
      const phantom = new Entity({ id: `${self.id}_phantom`, name: fill(spec.name ?? '{caster}的幻影'), team: self.team, stats,
        normalAttack: new Skill({ id: 'phantom_attack', name: '幻影普攻', actions: [{ type: 'DAMAGE', stat }] }), normalAttackSpCost: 0 });
      let alive = phantom.isAlive;
      Object.defineProperty(phantom, 'isAlive', { get: () => alive && self.isAlive, set: value => { alive = value; }, configurable: true });
      phantom.summonerId = self.id;
      phantom.gemPhantom = true;
      (self.team === 'A' ? engine.teamA : engine.teamB).push(phantom);
      engine.onGemSummon?.(phantom);   // 地區特色（例如共鳴）也套到幻影身上
      self.gemPhantom = phantom;
      logger.addLog({ type: 'SUMMON', actorId: self.id, targetId: phantom.id, message: fill(spec.summonText ?? '{caster} 召喚了幻影！') });
    }
  };
}

/**
 * 幻影追擊：這件裝備上的主動寶石施放完後，幻影插隊普攻一次。
 * 單體技能打同一個目標（還活著的話），其他（全體、目標已倒下）隨機。
 */
function withPhantomChase(skill, spec) {
  const base = skill.execute;
  skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    const start = logger?.logs?.length ?? 0;
    const result = base.call(this, caster, allies, enemies, logger, context, options);
    const phantom = caster.gemPhantom;
    const engine = context?.insertAction ? context : null;
    if (!engine || engine.result || !phantom?.isAlive || !phantom.canAct?.()) return result;
    const single = this.actions.some(action => action.type === 'DAMAGE' && action.targetType === 'ENEMY_SINGLE');
    const hitLog = single ? (logger.logs ?? []).slice(start).find(log => log.actorId === caster.id && log.targetId && enemies.some(e => e.id === log.targetId)) : null;
    const target = hitLog ? enemies.find(e => e.id === hitLog.targetId && e.isAlive) : null;
    const chase = new Skill({ id: 'phantom_chase', name: '幻影追擊', actions: [{ type: 'DAMAGE', stat: phantom.normalAttack.actions[0].stat ?? 'atk', text: { action: expandPart(spec.chaseText ?? '{caster} 隨之追擊，') } }] });
    if (target) {
      const select = chase._selectTargets.bind(chase);
      chase._selectTargets = (targetType, ...rest) => (target.isAlive && targetType === 'ENEMY_SINGLE' ? [target] : select(targetType, ...rest));
    }
    engine.insertAction(phantom, chase);
    return result;
  };
  return skill;
}

/** 護盾破裂回 SP（shieldBreakSp）：自己受到的一擊打碎幾面盾，就回幾次 sp（任何來源的盾都算）。 */
function buildShieldBreakSpPassive(sp) {
  return {
    id: 'legend_shieldBreakSp',
    trigger: 'AFTER_DAMAGE_RECEIVED',
    enabled: (self, hit) => self.isAlive && (hit.shieldsBroken?.length ?? 0) > 0,
    action(self, hit, logger) {
      const restored = self.restoreSp(sp * hit.shieldsBroken.length, logger);
      if (restored > 0) logger.addLog({ type: 'TEXT', actorId: self.id, value: restored, message: `${self.name} 從碎裂的護盾回復了 ${restored} 點 SP！` });
    }
  };
}

// 敵人倒下時，插隊多一個行動槽釋放 entry 的技能一次（不扣 SP）。
// 框架沒有「單位倒下」的被動事件，所以在 AFTER_ACTION（每個行動槽結束、含插隊槽）與 ROUND_START 檢查
// 「新倒下的敵人」：在行動中被打倒的會在同一槽結束時發現；在自己行動槽開頭被持續傷害打倒的，會在下一個行動槽結束時發現。
// 最後一個敵人倒下時戰鬥已經結束，不會施放。連鎖（施放又打倒別人）會再觸發，次數以敵人數量為上限。
// 被動帶戰鬥狀態（記得哪些敵人已處理過），每場戰鬥都要重新編譯。
function buildEnemyDeathCastPassives(entry, text) {
  const skill = entry.grantSkill ?? entry.release ?? entry.skill;
  const free = Object.create(skill);
  free.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    return skill.execute.call(this, caster, allies, enemies, logger, context, { ...options, ignoreSp: true });
  };
  const use = withSlotCleanup(free, skill.gemSlotBuffIds);
  const seen = new Set();
  const check = (self, ctx, logger, engine) => {
    if (!engine || !self.isAlive) return;
    const enemies = self.team === 'A' ? engine.teamB : engine.teamA;
    for (const enemy of enemies) {
      if (enemy.isAlive || seen.has(enemy)) continue;
      seen.add(enemy);
      if (engine.result || !self.canAct?.() || self.silencedBy?.(skill)) continue;
      if (text) {
        logger.addLog({ type: 'TEXT', actorId: self.id, targetId: enemy.id,
          message: text.replaceAll('{caster}', self.name).replaceAll('{target}', enemy.name) });
      }
      engine.insertAction(self, use);
    }
  };
  const id = `gem_deathcast:${entry.skill.id}`;
  return [
    { id, gemSkillId: entry.skill.id, trigger: 'AFTER_ACTION', action: check },
    { id: `${id}:round`, gemSkillId: entry.skill.id, trigger: 'ROUND_START', action: check }
  ];
}

// 額外輔助寶石（grantSupport）：先照玩家的連結編譯（玩家的錯照常報），再逐一加上額外的輔助寶石；
// 玩家已連同一顆就跳過；加上去會出錯（條件不符、互斥）的那一顆不套用。額外的不算進連結上限。
function compileWithGranted(active, supports, granted, options) {
  let result = compileSkill(active, supports, options);
  const applied = [];
  const maxSupports = options.maxSupports ?? MAX_SUPPORTS;
  for (const gemId of granted) {
    if (supports.includes(gemId) || applied.includes(gemId)) continue;
    try {
      result = compileSkill(active, [...supports, ...applied, gemId], { ...options, maxSupports: maxSupports + applied.length + 1 });
      applied.push(gemId);
    } catch (error) {
      if (!(error instanceof GemLinkError)) throw error;
    }
  }
  result.grantedSupports = applied;
  return result;
}

// ── 施放條件 ────────────────────────────────────────────────

// 條件只影響 canCast：引擎抽技能時先濾掉 canCast 為 false 的，所以不成立的技能不會被抽到，也不會讓行動槽落空。
// 這裡只覆寫「能不能施放」的判斷，execute 與戰報完全是框架原樣。
function conditionsMet(entity, context, conditions) {
  const { selfHp, enemyCount } = conditions;
  if (selfHp) {
    const ratio = entity.stats.hp / entity.stats.maxHp;
    if (selfHp.min !== undefined && ratio < selfHp.min) return false;
    if (selfHp.max !== undefined && ratio > selfHp.max) return false;
  }
  // 沒有引擎就看不到敵人，這個條件視為成立（見 gems.js 的說明）。
  if (enemyCount && context && Array.isArray(context.teamA) && Array.isArray(context.teamB)) {
    const enemies = entity.team === 'A' ? context.teamB : context.teamA;
    const alive = enemies.filter(enemy => enemy.isAlive).length;
    if (enemyCount.min !== undefined && alive < enemyCount.min) return false;
    if (enemyCount.max !== undefined && alive > enemyCount.max) return false;
  }
  return true;
}

class ConditionalSkill extends Skill {
  constructor(config, conditions) {
    super(config);
    this.castConditions = conditions;
  }

  canCast(entity, context, options) {
    return conditionsMet(entity, context, this.castConditions) && super.canCast(entity, context, options);
  }
}

// 沒有條件時就是一般的 Skill，和以前完全一樣。
const makeSkill = (config, conditions) => Object.keys(conditions).length ? new ConditionalSkill(config, conditions) : new Skill(config);

// ── 編譯 ────────────────────────────────────────────────────

/**
 * 編譯一組連結。輔助寶石沒有順序（與 PoE 相同）：同一組寶石不論插槽怎麼排，
 * 合法與否、技能 id、動作串、數值都完全相同。做法：
 *   1. 內部一律依寶石 id 的字母順序處理，並用這個順序組成技能 id、決定追加段落的先後。
 *   2. 所有條件只看主動寶石原本的樣子；所有效果同時作用在原本的動作上，彼此不看對方的結果。
 *   3. 兩顆寶石對同一個東西寫入不同的值（scope 的目標、同一個 actionFlag）就是衝突，整組拒絕。
 * @param {string} activeId 主動寶石 id
 * @param {string[]} supportIds 輔助寶石 id；順序不影響結果
 * @param {object} [options] 測試或自訂資料時可以換掉 activeGems / supportGems / groups / maxSupports
 *   maxSupports  輔助寶石數量上限，預設 MAX_SUPPORTS（見 gems.js）
 * @returns {{ skill: Skill, release: Skill|null, charge: object|null, passives: object[], grants: object[], spCost: number, damageFactor: number, links: string[] }}
 *   skill         可直接放進 Entity 的 skills / normalAttack（連結蓄力時是「外殼」：只扣 SP 並掛標記）
 *   release       連結蓄力時的本體（實際造成傷害的技能，id 是 外殼 id + '#release'），否則為 null。
 *                 蓄力要靠 compileLoadout 給的 resolver 才會釋放
 *   charge        { markerId, release } 或 null，給 buildChargeResolver 用
 *   passives      reaction 類寶石產生的被動（例如汲取）；只要 skill 的話可以忽略
 *   grants        角色層級的效果（佈局、撒手鐧）。同類要合併成一個被動才正確，所以這裡只給資料，
 *                 被動由 compileLoadout 建立（或自己呼叫 buildGrantPassives）
 *   conditions    合併後的施放條件，例如 { selfHp: { max: 0.5 } }；沒有條件是 {}。條件成立與否只影響 skill.canCast
 *   damageFactor  最終傷害倍率 = (1 + Σinc) × Π(1 + more)
 *   links         固定順序（id 字母序）的輔助寶石 id
 * @throws {GemLinkError} 連結不合法時
 * @throws {Error} 寶石資料本身有誤時（見 validateGemData）
 */
function compileSkill(activeId, supportIds = [], {
  activeGems = ACTIVE_GEMS, supportGems = SUPPORT_GEMS, groups = GROUPS, maxSupports = MAX_SUPPORTS, equipment = null, mechanics = [], copy = 1, sameActiveOthers = 0
} = {}) {
  if (!Number.isInteger(maxSupports) || maxSupports < 0) {
    throw new Error(`maxSupports 必須是不小於 0 的整數，收到 ${maxSupports}`);
  }
  const equip = checkEquipment(equipment);
  assertValidGemData(supportGems, groups);
  const active = activeGems[activeId];
  if (!active) throw new GemLinkError(activeId, '找不到這顆主動寶石');
  active.actions.forEach((action, index) => checkAilments(action, `主動寶石「${activeId}」第 ${index + 1} 段`));
  if (active.id !== activeId) throw new Error(`主動寶石「${activeId}」的 id（${active.id}）與登錄的鍵不一致；技能 id 是用鍵組出來的，改 id 時鍵要一起改`);
  // 數量上限先檢查，指出「第一顆放不下」的那一顆（照傳入順序）。這是整組的錯，只有這則提示會看順序。
  if (supportIds.length > maxSupports) {
    throw new GemLinkError(supportIds[maxSupports],
      `每顆主動寶石最多連結 ${maxSupports} 顆輔助寶石（這組有 ${supportIds.length} 顆）`);
  }

  // 固定處理順序：與插槽順序無關。
  const ids = [...supportIds].sort();
  // 光環這類只能連結特定輔助寶石的主動寶石（supportWhitelist）；照排序後的順序找，錯誤訊息才與插槽順序無關
  if (active.supportWhitelist) {
    const bad = ids.find(gemId => !active.supportWhitelist.includes(gemId));
    if (bad) throw new GemLinkError(bad, `「${active.name}」只能連結${active.supportWhitelist.map(gemId => supportGems[gemId]?.name ?? gemId).join('、')}`);
  }
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] === ids[i - 1]) throw new GemLinkError(ids[i], '同一個技能不能連結兩次');
  }

  // 基準：主動寶石原本的樣子。條件只對它判斷；效果也都以它為依據。
  const base = { tags: [...active.tags], actions: structuredClone(active.actions) };
  const draft = {
    tags: [...active.tags],
    actions: structuredClone(active.actions),
    inc: [], more: [], costMult: 1, prepended: [], appended: [], reactions: [], grants: [], wraps: [], procs: [], repeats: [], dynamics: [], recycles: []
  };
  const groupOwner = new Map();   // 互斥組 id → 先處理到的寶石 id
  const scopeWriters = new Map(); // 基準動作的索引 → { to, gemId }
  const flagWriters = new Map();  // 旗標名稱 → { value, gemId }
  const tagAdders = new Map();    // 標籤 → 加上它的寶石 id
  const tagRemovers = new Map();  // 標籤 → 移除它的寶石 id
  const bounds = {};              // 施放條件：量 → { min: { value, gemId }, max: { value, gemId } }，只留最嚴格的

  for (const id of ids) {
    const gem = supportGems[id];
    if (!gem) throw new GemLinkError(id, '找不到這顆輔助寶石');

    if (gem.exclusiveGroup) {
      const owner = groupOwner.get(gem.exclusiveGroup);
      if (owner) {
        throw new GemLinkError(id, `與「${supportGems[owner].name}」互斥` +
          `（同屬「${groups[gem.exclusiveGroup].name}」組，同組只能連結一顆）`, { conflictsWith: owner });
      }
      groupOwner.set(gem.exclusiveGroup, id);
    }
    const unmet = unmetReason(base, gem.requires, ids);
    if (unmet) throw new GemLinkError(id, unmet.reason, { conflictsWith: unmet.conflictsWith });

    // 一顆加、一顆移除同一個標籤算衝突（同一個東西被寫成不同的值）。
    for (const tag of gem.addTags || []) {
      if (tagRemovers.has(tag)) {
        throw new GemLinkError(id, `與「${supportGems[tagRemovers.get(tag)].name}」衝突：一個要加上標籤 ${tag}，一個要移除它`,
          { conflictsWith: tagRemovers.get(tag) });
      }
      tagAdders.set(tag, id);
      if (!draft.tags.includes(tag)) draft.tags.push(tag);
    }
    for (const tag of gem.removeTags || []) {
      if (tagAdders.has(tag)) {
        throw new GemLinkError(id, `與「${supportGems[tagAdders.get(tag)].name}」衝突：一個要加上標籤 ${tag}，一個要移除它`,
          { conflictsWith: tagAdders.get(tag) });
      }
      tagRemovers.set(tag, id);
    }
    for (const effect of gem.effects) {
      switch (effect.op) {
        case 'inc': draft.inc.push(effect.value); break;
        case 'more': draft.more.push(effect.value); break;
        case 'cost': draft.costMult *= 1 + effect.value; break;
        case 'scope':
          // 只認「基準」裡 targetType 等於 from 的傷害段；先記下，最後才一起套用。
          base.actions.forEach((action, index) => {
            if (action.type !== 'DAMAGE' || targetTypeOf(action) !== effect.from) return;
            const writer = scopeWriters.get(index);
            if (writer && writer.to !== effect.to) {
              throw new GemLinkError(id, `與「${supportGems[writer.gemId].name}」衝突：` +
                '兩者要把同一段傷害改成不同的攻擊對象', { conflictsWith: writer.gemId });
            }
            scopeWriters.set(index, { to: effect.to, gemId: id });
          });
          break;
        case 'actionFlag': {
          const writer = flagWriters.get(effect.flag);
          if (writer && writer.value !== effect.value) {
            throw new GemLinkError(id, `與「${supportGems[writer.gemId].name}」衝突：` +
              `兩者對 ${effect.flag} 設定了不同的值`, { conflictsWith: writer.gemId });
          }
          flagWriters.set(effect.flag, { value: effect.value, gemId: id });
          break;
        }
        case 'appendAction': draft.appended.push(structuredClone(effect.action)); break;
        case 'prependAction': draft.prepended.push(structuredClone(effect.action)); break;
        case 'reaction': draft.reactions.push(effect); break;
        case 'grant': draft.grants.push({ ...effect }); break;
        case 'proc': draft.procs.push(effect); break;
        case 'repeat': draft.repeats.push(effect); break;
        case 'condInc': case 'critAsDamage': draft.dynamics.push(effect); break;
        // 反覆：穿戴中這組以外每多一組相同的主動寶石（compileLoadout 算好傳進來），加算區 +value
        case 'auraRecycle': draft.recycles.push(effect); break;   // 能量回收：光環付維持費時結算（compileAura／compileThorns）
        case 'chainAura': break;   // 連續光環：效果在 compileLoadout（接上被連結的光環），單一技能本身不變
        case 'sameActiveInc': if (sameActiveOthers > 0) draft.inc.push(effect.value * sameActiveOthers); break;
        case 'wrap': if (!draft.wraps.includes(effect.kind)) draft.wraps.push(effect.kind); break;
        case 'castCondition': {
          // 同一個量取最嚴格的上下界；寶石依 id 字母序處理，數值相同時留先處理到的，所以與連結順序無關。
          const entry = bounds[effect.of] ||= {};
          if (effect.min !== undefined && (!entry.min || effect.min > entry.min.value)) entry.min = { value: effect.min, gemId: id };
          if (effect.max !== undefined && (!entry.max || effect.max < entry.max.value)) entry.max = { value: effect.max, gemId: id };
          break;
        }
        default: throw new Error(`寶石 ${id} 使用了未知的 op：${effect.op}`);
      }
    }
  }

  // 套用 scope 與旗標：只作用在原本的傷害段，追加的段落是獨立的一段，不受影響。
  draft.actions.forEach((action, index) => {
    if (action.type !== 'DAMAGE') return;
    const scoped = scopeWriters.get(index);
    if (scoped) action.targetType = scoped.to;
    for (const [flag, { value }] of flagWriters) action[flag] = value;
  });

  // 結算：加算區先加總，乘算區各自相乘，兩區最後才相乘。這一步對所有 DAMAGE 段（含追加的）生效。
  // 撥弦槍【鶴之聲援】的和弦：施放當下才知道加成，當成一種動態加算（只加在智力的傷害段，見 withDynamicDamage）
  if (mechanics.some(m => m.type === 'chord')) draft.dynamics.push({ op: 'chordInc' });
  const incSum = draft.inc.reduce((sum, value) => sum + value, 0);
  const moreProduct = draft.more.reduce((product, value) => product * (1 + value), 1);
  const factor = (1 + incSum) * moreProduct;
  // 框架對 `action.power || 1` 的處理會把 0 當成 1，所以倍率歸零不是「打不出傷害」而是「變回原本的傷害」。
  if (!(factor > 0)) {
    throw new GemLinkError(ids.join('、'), '加算與乘算合計後傷害倍率會小於或等於 0');
  }

  draft.tags = draft.tags.filter(tag => !tagRemovers.has(tag));

  // 施放條件合起來不可能成立就整組拒絕；雙方都指出（字母序在後的當作 gemId，前者當作 conflictsWith）。
  for (const [of, { min, max } = {}] of Object.entries(bounds)) {
    if (min && max && min.value > max.value) {
      const [first, second] = [min.gemId, max.gemId].sort();
      throw new GemLinkError(second, `與「${supportGems[first].name}」衝突：兩者對${CONDITION_STATS[of].name}的施放條件合起來永遠不會成立`,
        { conflictsWith: first });
    }
  }
  const conditions = Object.fromEntries(Object.entries(bounds).map(([of, { min, max }]) => [of,
    { ...(min ? { min: min.value } : {}), ...(max ? { max: max.value } : {}) }]));

  // 動作順序：前置（依寶石 id 字母序）→ 原本的動作 → 追加。前置的是「對自己」這類動作時，
  // 緊接在後的原本第一個動作必須重新挑目標：框架預設沿用上一個動作的目標，不處理的話傷害會打到自己。
  // 連擊（repeat）：把套用過 scope／旗標的「原本傷害段」整段複製，接在原本的動作後面、追加段前面。
  // 複本沿用上一段的目標（框架預設），所以打同一個目標；異常、機率效果照原段落各自觸發；開頭句換成 repeat 的 text。
  const repeated = [];
  for (const effect of draft.repeats) {
    for (let i = 0; i < effect.times; i++) {
      for (const action of draft.actions) {
        if (action.type !== 'DAMAGE') continue;
        const copy = structuredClone(action);
        delete copy.spCost;
        if (effect.text !== undefined) copy.text = { ...(copy.text || {}), action: effect.text };
        repeated.push(copy);
      }
    }
  }
  const actions = [...draft.prepended, ...draft.actions, ...repeated, ...draft.appended].map(action => {
    const next = withStatEffects(expandText(action));
    if (next.type === 'DAMAGE') {
      next.power = round4((next.power ?? 1) * damageFactorOf(next, incSum, moreProduct, equip));
      // 施放當下才決定的加成（暴怒、法術會心）要知道這段的加算區底數，才能把條件加算正確地加進去
      if (draft.dynamics.length) next.gemIncBase = round4(damageFactorOf(next, incSum, 1, equip));
      // 資料欄位 ailments 不送進框架，改放 gemAilments 給被動讀。倍率不乘命中的傷害加成，
      // 只乘裝備的異常傷害增加（自己一個加算區）；basis 'hit' 讀的命中傷害本身已含命中的加成（使用者決定兩者都吃）。
      if (next.ailments) {
        next.gemAilments = next.ailments.map(ailment => ({ ...ailment, power: round4(ailment.power * (1 + equip.ailmentDmg)),
          duration: ailment.duration + (AILMENTS[ailment.kind]?.extendable === false ? 0 : equip.ailmentDuration) }));
        delete next.ailments;
      }
    }
    return next;
  });
  if (draft.prepended.length && draft.actions.length) {
    const first = draft.prepended.length;
    actions[first] = { ...actions[first], inheritTarget: actions[first].inheritTarget ?? false };
  }
  const spCost = active.spCost > 0
    ? Math.max(1, Math.ceil(+(active.spCost * draft.costMult).toFixed(6)))
    : 0;
  // copy：同一組（主動＋輔助完全相同）在配置裡第 n 次出現時加 #n，技能 id 才不會撞（2026-11-22 使用者：相同主動寶石可以重複裝）
  const id = [activeId, ...ids].join('+') + (copy > 1 ? `#${copy}` : '');
  const tags = draft.tags;
  const uncounterable = active.uncounterable === true;

  if (draft.wraps.includes('echo') && draft.wraps.includes('charge')) {
    throw new GemLinkError(activeId, '迴響與蓄力不能同時連結');
  }
  const critEcho = active.critEcho ?? null;

  if (active.aura) return compileAura(active, { id, tags, conditions, grants: draft.grants, ids, recycles: draft.recycles });
  if (active.swords) {
    if (draft.wraps.includes('charge') || draft.wraps.includes('echo')) throw new GemLinkError(activeId, `${active.name}不能連結蓄力或迴響`);
    return compileSwords(active, { id, tags, conditions, actions, draft, ids, spCost, factor });
  }

  // 迴響：玩家選到的是外殼（付 SP、掛「迴響中」標記、不造成傷害），開啟後外殼不能再選；
  // 本體（release）每回合開始時由被動插隊免費釋放。觸發類（佈局、追擊、撒手鐧、裝備的倒下釋放）用分派版本：
  // 還沒開啟時等於外殼（開啟迴響），開啟後等於本體（造成傷害）。
  if (draft.wraps.includes('echo')) {
    const releaseId = `${id}#echo`;
    const markerId = `gem_echo:${id}`;
    const releaseActions = actions.map(action => { const next = { ...action }; delete next.spCost; return next; });
    // 迴響釋放的每一行（全體技能每個目標一行）都寫成「○○的迴響引發△△，」，戰報看得出是自動釋放
    const leadAt = draft.prepended.length;
    if (releaseActions[leadAt]) releaseActions[leadAt] = { ...releaseActions[leadAt], text: { ...(releaseActions[leadAt].text || {}), action: expandPart('{caster}的迴響引發{skill}，') } };
    let release = withDynamicDamage(new Skill({ id: releaseId, name: active.name, tags: [...tags], actions: releaseActions, uncounterable }), draft.dynamics);
    if (critEcho) release = withCritEcho(release, critEcho);
    if (active.tuplet) release = withTuplet(release, active.tuplet);
    release.gemLeadIndex = draft.prepended.length;
    release.gemSlotBuffIds = slotBuffIds(releaseActions);
    const releaseUse = release;
    const shellAction = {
      type: 'BUFF', targetType: 'SELF', spCost,
      text: { action: expandPart('{caster} 開啟了迴響（{skill}）！'), buff: '' },
      buffs: [{ id: markerId, name: '迴響中', type: 'STAT', polarity: 'neutral', duration: 1e6, stackPolicy: 'refresh', dispellable: false }]
    };
    const active_ = entity => entity.buffs?.some(buff => buff.id === markerId);
    const shell = makeSkill({ id, name: active.name, tags: [...tags], actions: [shellAction] }, conditions);
    const shellCanCast = shell.canCast.bind(shell);
    shell.canCast = (entity, ...rest) => !active_(entity) && shellCanCast(entity, ...rest);
    shell.gemSlotBuffIds = [];
    const dispatch = Object.create(shell);
    dispatch.canCast = (entity, ...rest) => active_(entity) ? release.canCast(entity, ...rest) : shellCanCast(entity, ...rest);
    dispatch.execute = function execute(caster, ...rest) {
      return active_(caster) ? releaseUse.execute(caster, ...rest) : shell.execute.call(this, caster, ...rest);
    };
    const echoPassive = {
      id: `gem_echo_round:${id}`,
      trigger: 'ROUND_START',
      enabled: self => self.isAlive && active_(self),
      action(self, round, logger, engine) {
        if (!engine || engine.result || !self.canAct?.() || self.silencedBy?.(release)) return;
        engine.insertAction(self, withSlotCleanup(releaseUse, release.gemSlotBuffIds));
        engine.runInsertedActions();
      }
    };
    return {
      skill: shell, release: null, charge: null, grantSkill: dispatch, echo: { markerId, release },
      passives: [echoPassive, ...draft.reactions.map(reaction => buildPassive(releaseId, reaction)), ...draft.procs.map(proc => buildProcPassive(releaseId, proc)),
        ...(releaseActions.some(action => action.gemAilments) ? [buildAilmentPassive(releaseId)] : [])],
      grants: draft.grants, conditions, spCost, damageFactor: round4(factor), links: ids
    };
  }

  // 蓄力：玩家選到的是外殼（只扣 SP、掛標記），本體等下一個行動槽由 skillSelectionResolver 換上來釋放。
  // 反應被動（汲取）要綁在本體上，因為實際造成傷害的是本體。
  if (draft.wraps.includes('charge')) {
    const releaseId = `${id}#release`;
    const markerId = `gem_charged:${releaseId}`;
    let release = withDynamicDamage(new Skill({ id: releaseId, name: active.name, tags: [...tags], actions, uncounterable }), draft.dynamics);
    if (critEcho) release = withCritEcho(release, critEcho);
    if (active.tuplet) release = withTuplet(release, active.tuplet);
    release.gemLeadIndex = draft.prepended.length;
    release.gemSlotBuffIds = slotBuffIds(actions);
    const shellAction = {
      type: 'BUFF', targetType: 'SELF', spCost,
      text: { action: expandPart('{caster} 開始蓄力 {skill}！'), buff: '' },
      buffs: [{ id: markerId, name: '蓄力中', type: 'STAT', polarity: 'neutral', duration: 1e6, stackPolicy: 'refresh' }]
    };
    const skill = makeSkill({ id, name: active.name, tags: [...tags], actions: [shellAction] }, conditions);
    return {
      skill, release, charge: { markerId, release },
      passives: [...draft.reactions.map(reaction => buildPassive(releaseId, reaction)), ...draft.procs.map(proc => buildProcPassive(releaseId, proc)),
        ...(actions.some(action => action.gemAilments) ? [buildAilmentPassive(releaseId)] : [])],
      grants: draft.grants, conditions, spCost, damageFactor: round4(factor), links: ids
    };
  }

  if (actions.length) actions[0] = { ...actions[0], spCost };
  let skill = withDynamicDamage(makeSkill({ id, name: active.name, tags, actions, uncounterable }, conditions), draft.dynamics);
  if (critEcho) skill = withCritEcho(skill, critEcho);
  if (active.tuplet) skill = withTuplet(skill, active.tuplet);
  // 前置動作（例如爆擊強化的提示）排在技能那一行之前；佈局的開頭文字要接在技能那一行，不能接在前置動作上。
  skill.gemLeadIndex = draft.prepended.length;
  skill.gemSlotBuffIds = slotBuffIds(actions);
  const passives = [...draft.reactions.map(reaction => buildPassive(id, reaction)), ...draft.procs.map(proc => buildProcPassive(id, proc)),
    ...(actions.some(action => action.gemAilments) ? [buildAilmentPassive(id)] : [])];
  return { skill, release: null, charge: null, passives, grants: draft.grants, conditions, spCost, damageFactor: round4(factor), links: ids };
}

// ── 連音（tuplet）與光環（aura），2026-11-22 ─────────────────────

const CN_NUMBERS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 連音：施放時先決定目標（engine.selectTargets，照框架的單體選法），擊數 = base − 1 + 速度連擊數（框架 getCombos），
 * 夾在 base～max；開頭寫一行「…——N連音！」，每一擊的句子是「第 N 道音符，」。迅擊之類複製出來的段落也照同樣擊數、同樣句子。
 */
function withTuplet(skill, { base, max, intro, hit }) {
  const baseExecute = skill.execute;
  const hitText = ctx => hit.replace('{i}', CN_NUMBERS[ctx.hitIndex] ?? String(ctx.hitIndex));
  skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    const target = options.targets?.find(t => t.isAlive)
      ?? (context?.selectTargets ? context.selectTargets(caster, 'ENEMY_SINGLE')[0] : enemies.find(e => e.isAlive));
    if (!target) return baseExecute.call(this, caster, allies, enemies, logger, context, options);
    const hits = Math.min(max, Math.max(base, base - 1 + Formulas.getCombos(caster, target)));
    const variant = Object.create(this);
    variant.actions = this.actions.map(action => action.type === 'DAMAGE'
      ? { ...action, hits, text: { ...(action.text || {}), action: hitText, combo: hitText } }
      : action);
    logger.addLog({ type: 'SKILL_TEXT', actorId: caster.id, skillId: this.id, isNormalAttack: false,
      message: intro.replace('{caster}', caster.name).replace('{n}', CN_NUMBERS[hits] ?? String(hits)) });
    return baseExecute.call(variant, caster, allies, enemies, logger, context, { ...options, targets: [target] });
  };
  return skill;
}

/**
 * 光環（忍耐）：外殼開啟光環（不扣 SP、掛「光環」標記、開啟後不能再選），開啟後立刻多行動一次（照平常選招）。
 * 每回合開始：付得起 spCost 就扣 SP、發動效果；付不起就不扣、這回合不發動。觸發類（佈局、撒手鐧）開啟時一樣多行動一次。
 *   healTaken：回復上一回合受到傷害的 ratio（任何來源；每回合開始結算後歸零）。
 *   thorns（荊棘，2026-11-23 使用者設計）：被攻擊擊中時，反彈（扣血量＋被護盾吸收的量）×（自己的防禦＋300）× ratio 給攻擊者，
 *     再吃攻擊者的防禦（× 300 ÷（攻擊者防禦＋300））。自己的防禦和受傷公式的 300 ÷（防禦＋300）剛好抵消，
 *     所以反彈量≈對方這一擊防禦前的傷害 × 300 × ratio，防禦不是負收益。持續傷害、共鳴爆發、直接傷害、被閃避、
 *     被無敵擋下的都不算；打在護盾上算（2026-11-24 使用者）；反彈是直接傷害（不暴擊、沒有浮動、可以致死、不觸發反擊／和弦／共鳴等）。
 *     開啟的那一回合免費生效；之後每回合開始付 spCost，付不起這回合不反彈。
 */
/**
 * 光環每回合付維持費；有能量回收（auraRecycle）時，每顆各自累計付掉的 SP，每滿 per 點回復 gain 點（零頭保留、不超過上限）。
 */
function payAuraUpkeep(self, id, skillName, spCost, recycles, logger) {
  self.stats.sp -= spCost;
  recycles.forEach((effect, index) => {
    const key = `gemRecycle:${id}:${index}`;
    const total = (self[key] ?? 0) + spCost;
    const times = Math.floor(total / effect.per);
    self[key] = total - times * effect.per;
    if (times <= 0) return;
    const max = self.stats.maxSp ?? Infinity;
    const value = Math.max(0, Math.min(times * effect.gain, max - self.stats.sp));
    if (value <= 0) return;
    self.stats.sp += value;
    logger.addLog({ type: 'TEXT', actorId: self.id, skillId: id, value,
      message: effect.text.replace('{caster}', self.name).replace('{skill}', skillName).replace('{value}', String(value)) });
  });
  self.syncFatigue?.(logger);
}

function compileAura(active, { id, tags, conditions, grants, ids, recycles = [] }) {
  if (active.aura.kind === 'thorns') return compileThorns(active, { id, tags, conditions, grants, ids, recycles });
  const { aura, spCost } = active;
  const markerId = `gem_aura:${id}`;
  const isOpen = entity => entity.buffs?.some(buff => buff.id === markerId);
  const shell = makeSkill({ id, name: active.name, tags: [...tags], actions: [{
    type: 'BUFF', targetType: 'SELF',
    text: { action: expandPart(aura.openText), buff: '' },
    buffs: [{ id: markerId, name: active.name, type: 'STAT', polarity: 'positive', duration: 1e6, stackPolicy: 'refresh', dispellable: false }]
  }] }, conditions);
  const shellCanCast = shell.canCast.bind(shell);
  shell.canCast = (entity, ...rest) => !isOpen(entity) && shellCanCast(entity, ...rest);
  const shellExecute = shell.execute;
  shell.execute = function execute(caster, allies, enemies, logger, context, options) {
    const result = shellExecute.call(this, caster, allies, enemies, logger, context, options);
    if (context?.insertAction && isOpen(caster)) context.insertAction(caster, extraTurnSkill(markerId));
    return result;
  };
  shell.gemSlotBuffIds = [];
  const taken = `gemAuraTaken:${id}`;
  const passives = [
    {
      id: `gem_aura_taken:${id}`,
      trigger: 'AFTER_DAMAGE_RECEIVED',
      enabled: self => isOpen(self),
      action(self, hit) { self[taken] = (self[taken] ?? 0) + (hit?.actualDamage ?? 0); }
    },
    {
      id: `gem_aura_round:${id}`,
      trigger: 'ROUND_START',
      enabled: self => self.isAlive && isOpen(self),
      action(self, round, logger, engine) {
        const amount = Math.floor((self[taken] ?? 0) * aura.ratio);
        self[taken] = 0;
        if (self.stats.sp < spCost) {   // SP 不夠：不扣、不發動，提示一句
          if (aura.lowSpText) logger.addLog({ type: 'TEXT', actorId: self.id, skillId: id, message: aura.lowSpText.replace('{caster}', self.name) });
          return;
        }
        payAuraUpkeep(self, id, active.name, spCost, recycles, logger);
        if (amount <= 0) return;
        const healed = self.heal(amount, logger, { engine });
        if (healed > 0) logger.addLog({ type: 'HEAL', actorId: self.id, targetId: self.id, skillId: id, value: healed,
          message: aura.text.replace('{caster}', self.name).replace('{value}', String(healed)) });
      }
    }
  ];
  return { skill: shell, release: null, charge: null, grantSkill: shell, aura: { markerId }, passives, grants, conditions, spCost, damageFactor: 0, links: ids };
}

function compileThorns(active, { id, tags, conditions, grants, ids, recycles = [] }) {
  const { aura, spCost } = active;
  const markerId = `gem_aura:${id}`;
  const armedKey = `gemThornsArmed:${id}`;
  const isOpen = entity => entity.buffs?.some(buff => buff.id === markerId);
  const fill = (line, vars) => Object.entries(vars).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), line);
  const shell = makeSkill({ id, name: active.name, tags: [...tags], actions: [{
    type: 'BUFF', targetType: 'SELF',
    text: { action: expandPart(aura.openText), buff: '' },
    buffs: [{ id: markerId, name: active.name, type: 'STAT', polarity: 'positive', duration: 1e6, stackPolicy: 'refresh', dispellable: false }]
  }] }, conditions);
  const shellCanCast = shell.canCast.bind(shell);
  shell.canCast = (entity, ...rest) => !isOpen(entity) && shellCanCast(entity, ...rest);
  const shellExecute = shell.execute;
  shell.execute = function execute(caster, allies, enemies, logger, context, options) {
    const wasOpen = isOpen(caster);
    const result = shellExecute.call(this, caster, allies, enemies, logger, context, options);
    if (!wasOpen && isOpen(caster)) caster[armedKey] = true;   // 開啟的那一回合免費生效
    if (context?.insertAction && isOpen(caster)) context.insertAction(caster, extraTurnSkill(markerId));
    return result;
  };
  shell.gemSlotBuffIds = [];
  const defOf = entity => Math.max(0, (entity.getEffectiveStats?.() ?? entity.stats).def ?? 0);
  // 受到的量＝扣血＋被護盾吸收的部分（2026-11-24 使用者：護盾也吃得到反傷）
  const taken = hit => (hit?.actualDamage > 0 ? hit.actualDamage : 0) + (hit?.shieldAbsorbed > 0 ? hit.shieldAbsorbed : 0);
  const canReflect = (self, hit) => self.isAlive && isOpen(self) && self[armedKey] && hit?.source === 'ATTACK'
    && taken(hit) > 0 && hit.caster && hit.caster !== self && hit.caster.isAlive && hit.caster.team !== self.team;
  const reflect = (self, hit, logger, engine) => {
    const attacker = hit.caster;
    const raw = taken(hit) * (defOf(self) + 300) * aura.ratio;
    const amount = Math.max(1, Math.floor(raw * 300 / (defOf(attacker) + 300)));
    const dealt = attacker.takeDamage(amount, logger, { source: 'DIRECT', tags: ['thorns'] });
    const value = dealt.actualDamage ?? amount;
    logger.addLog({ type: 'DAMAGE', actorId: self.id, targetId: attacker.id, skillId: id, isNormalAttack: false, value, logStyle: 'dot',
      message: fill(aura.text, { caster: self.name, value, target: attacker.name }) });
    attacker.finishDamage?.(dealt, logger, engine);
  };
  const wrappedKey = `gemThornsWrapped:${id}`;
  const passives = [
    {
      // 有扣到血的一擊：照框架的受傷反應時機（傷害行之後、攻擊方的造成傷害反應之前）
      id: `gem_thorns:${id}`,
      trigger: 'AFTER_DAMAGE_RECEIVED',
      enabled: (self, hit) => canReflect(self, hit),
      action: (self, hit, logger, engine) => reflect(self, hit, logger, engine)
    },
    {
      // 整擊被護盾吃光：框架不響 AFTER_DAMAGE_RECEIVED，改包 finishDamage（同共鳴的做法）
      id: `gem_thorns_shield:${id}`,
      trigger: 'BATTLE_START',
      enabled: self => !self[wrappedKey],
      action(self) {
        self[wrappedKey] = true;
        const baseFinish = self.finishDamage;
        self.finishDamage = function finishDamage(hit, logger, engine) {
          const fresh = !this.settledDamage?.has(hit);
          const result = baseFinish.call(this, hit, logger, engine);
          if (fresh && !(hit?.actualDamage > 0) && !engine?.result && canReflect(this, hit)) {
            reflect(this, hit, logger, engine);
            engine?.settleDeaths?.();
            engine?.checkWinCondition?.();
          }
          return result;
        };
      }
    },
    {
      id: `gem_thorns_round:${id}`,
      trigger: 'ROUND_START',
      enabled: self => self.isAlive && isOpen(self),
      action(self, round, logger) {
        if (self.stats.sp < spCost) {
          self[armedKey] = false;
          if (aura.lowSpText) logger.addLog({ type: 'TEXT', actorId: self.id, skillId: id, message: fill(aura.lowSpText, { caster: self.name }) });
          return;
        }
        payAuraUpkeep(self, id, active.name, spCost, recycles, logger);
        self[armedKey] = true;
      }
    }
  ];
  return { skill: shell, release: null, charge: null, grantSkill: shell, aura: { markerId }, passives, grants, conditions, spCost, damageFactor: 0, links: ids };
}

// ── 喚劍（swords），2026-11-23 使用者設計（第三區獎勵；SP、倍率、戰報文字我擬）────────
// 外殼：付 SP、召喚 initial 把飛劍（不造成傷害），持續期間外殼不能再選（其他技能照常）。
// 飛劍狀態記在施放者身上（self[gemSwords:id] = { count, left, fresh }），「飛劍 ×N」標記只是顯示。
//   ・每把飛劍一擊＝本體（release：主動寶石原本的傷害段，已套用連結的輔助寶石）打一次；反擊率 × 1 / 這次一起出手的把數
//     （框架的 counterChanceMultiplier，gem 的閃避反擊也讀它）。
//   ・自己的普攻那一槽結束後（AFTER_ACTION），cfg.chase 把（1）追擊一次：打這槽普攻第一個打中的目標，倒下或沒打中就隨機挑。
//   ・自己的行動槽結束後 +1 把（上限 max）；插隊的行動槽（追擊、佈局、多行動一次…）與召喚的那一槽不加。
//   ・持續 rounds 回合（施放的回合算第 1 回合，第 rounds 次回合開始時結束，同勝利的旋律），結束時每把各隨機挑目標再攻擊一次。
//   ・觸發類（佈局、撒手鐧、追擊、報喪法杖…）用分派版：飛劍不在＝召喚，飛劍在場＝cfg.volley 把（1）立刻攻擊一次。
//   2026-11-23 使用者：追擊與齊射只有 1 把，3 把的上限只在結束時用到（原本每把都追擊，混沌爆擊觸發太多）。
function compileSwords(active, { id, tags, conditions, actions, draft, ids, spCost, factor }) {
  const cfg = active.swords;
  const texts = cfg.texts ?? {};
  const releaseId = `${id}#sword`;
  const markerId = `gem_swords:${id}`;
  const key = `gemSwords:${id}`;
  const memoKey = `gemSwordTarget:${id}`;
  const leadAt = draft.prepended.length;
  // 三種出手（追擊、結束、齊射）只差在開頭那句；id 都是 releaseId，汲取、異常等反應被動綁在它身上
  const makeRelease = lead => {
    const strikeActions = actions.map(action => { const next = { ...action }; delete next.spCost; return next; });
    if (lead && strikeActions[leadAt]) strikeActions[leadAt] = { ...strikeActions[leadAt], text: { ...(strikeActions[leadAt].text || {}), action: expandPart(lead) } };
    const release = withDynamicDamage(new Skill({ id: releaseId, name: active.name, tags: [...tags], actions: strikeActions }), draft.dynamics);
    release.gemLeadIndex = leadAt;
    release.gemSlotBuffIds = slotBuffIds(strikeActions);
    return release;
  };
  const chase = makeRelease(texts.chase), volley = makeRelease(texts.volley);
  // 結束時的最後一擊照連音的寫法（2026-11-23 使用者）：先一行 finalIntro，每把一句 finalHit（「第{i}擊，」）
  const finals = Array.from({ length: cfg.max }, (_, i) => makeRelease((texts.finalHit ?? '第{i}擊，').replace('{i}', CN_NUMBERS[i + 1] ?? String(i + 1))));
  const stateOf = self => self[key];
  const isOn = self => (stateOf(self)?.left ?? 0) > 0;
  const label = n => `飛劍 ×${n}`;
  const setLabel = self => { const buff = self.buffs?.find(b => b.id === markerId); if (buff) buff.name = label(stateOf(self).count); };
  const fill = (line, self, extra = {}) => line.replaceAll('{caster}', self.name).replaceAll('{n}', String(extra.n ?? ''));
  const sides = (self, engine) => self.team === 'A' ? [engine.teamA, engine.teamB] : [engine.teamB, engine.teamA];
  const randomFoe = (self, engine) => {
    const foes = sides(self, engine)[1].filter(e => e.isAlive);
    return foes.length ? foes[Math.floor((engine.rng ?? Math.random)() * foes.length)] : null;
  };
  // 一把飛劍出手一次；group＝這次一起出手的把數，反擊率 × 1 / group（2026-11-23 使用者：照出手的把數算）
  const strike = (self, skill, target, logger, engine, group = 1) => {
    if (!engine || engine.result || !self.isAlive || !target?.isAlive) return;
    const variant = Object.create(skill);
    variant.counterChanceMultiplier = 1 / Math.max(1, group);
    const [allies, enemies] = sides(self, engine);
    withSlotCleanup(variant, skill.gemSlotBuffIds).execute(self, allies, enemies, logger, engine, { targets: [target], ignoreSp: true });
  };
  // limit：這次最多幾把出手（cfg.chase／cfg.volley；沒寫＝全部）。結束時一定是全部。
  const allStrike = (self, skill, pick, logger, engine, limit = Infinity) => {
    const n = Math.min(limit, stateOf(self)?.count ?? 0);
    for (let i = 0; i < n; i++) strike(self, skill, pick(self, engine), logger, engine, n);
  };

  const shellAction = {
    type: 'BUFF', targetType: 'SELF', spCost,
    text: { action: expandPart(texts.summon ?? '{caster} 召喚了飛劍！'), buff: '' },
    buffs: [{ id: markerId, name: label(cfg.initial), type: 'STAT', polarity: 'positive', duration: 1e6, stackPolicy: 'refresh', dispellable: false }]
  };
  const shell = makeSkill({ id, name: active.name, tags: [...tags], actions: [shellAction] }, conditions);
  const shellCanCast = shell.canCast.bind(shell);
  shell.canCast = (entity, ...rest) => !isOn(entity) && shellCanCast(entity, ...rest);
  const shellExecute = shell.execute;
  shell.execute = function execute(caster, ...rest) {
    const result = shellExecute.call(this, caster, ...rest);
    if (caster.buffs?.some(b => b.id === markerId)) { caster[key] = { count: cfg.initial, left: cfg.rounds, fresh: true }; setLabel(caster); }
    return result;
  };
  shell.gemSlotBuffIds = [];
  const dispatch = Object.create(shell);
  dispatch.canCast = (entity, ...rest) => isOn(entity) || shellCanCast(entity, ...rest);
  dispatch.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    if (!isOn(caster)) return shell.execute.call(this, caster, allies, enemies, logger, context, options);
    const first = options.targets?.find(t => t.isAlive) ?? context?.selectTargets?.(caster, 'ENEMY_SINGLE')?.[0];
    let target = first;
    const pick = (self, engine) => (target?.isAlive ? target : (target = randomFoe(self, engine)));
    allStrike(caster, volley, pick, logger, context, cfg.volley ?? Infinity);
    return { success: true };
  };

  const passives = [
    {
      // 插隊的行動槽不加飛劍：記錄 engine 是否正在跑插隊（同一場只包一次）
      id: `gem_swords_track:${id}`,
      trigger: 'BATTLE_START',
      action(self, ctx, logger, engine) {
        if (!engine || engine.gemInsertTracked) return;
        const run = engine.runInsertedActions;
        engine.runInsertedActions = function runInsertedActions(...args) {
          this.gemInsertDepth = (this.gemInsertDepth ?? 0) + 1;
          try { return run.apply(this, args); } finally { this.gemInsertDepth -= 1; }
        };
        engine.gemInsertTracked = true;
      }
    },
    {
      id: `gem_swords_memo:${id}`,
      trigger: 'AFTER_DAMAGE_DEALT',
      enabled: (self, hit) => isOn(self) && hit?.isNormalAttack === true && !self[memoKey],
      action(self, hit) { self[memoKey] = hit.target; }
    },
    {
      id: `gem_swords_action:${id}`,
      trigger: 'AFTER_ACTION',
      enabled: (self, ctx) => ctx?.actor === self && isOn(self),
      action(self, ctx, logger, engine) {
        const st = stateOf(self);
        const memo = self[memoKey];
        self[memoKey] = null;
        if (ctx.skill === self.normalAttack) {
          let target = memo;
          allStrike(self, chase, (me, eng) => (target?.isAlive ? target : (target = randomFoe(me, eng))), logger, engine, cfg.chase ?? Infinity);
        }
        if (st.fresh) { st.fresh = false; return; }
        if (engine?.gemInsertDepth > 0 || st.count >= cfg.max || !isOn(self)) return;
        st.count += 1;
        setLabel(self);
        if (texts.grow) logger.addLog({ type: 'TEXT', actorId: self.id, skillId: id, message: fill(texts.grow, self, { n: st.count }) });
      }
    },
    {
      id: `gem_swords_round:${id}`,
      trigger: 'ROUND_START',
      enabled: self => self.isAlive && isOn(self),
      action(self, round, logger, engine) {
        const st = stateOf(self);
        st.left -= 1;
        if (st.left > 0) return;
        const n = st.count;
        if (n > 0 && !engine.result && sides(self, engine)[1].some(e => e.isAlive)) {
          if (texts.finalIntro) logger.addLog({ type: 'SKILL_TEXT', actorId: self.id, skillId: id, isNormalAttack: false, message: fill(texts.finalIntro, self) });
          for (let i = 0; i < n; i++) strike(self, finals[i], randomFoe(self, engine), logger, engine, n);
        }
        self[key] = null;
        self.buffs = self.buffs.filter(b => b.id !== markerId);
        if (texts.end) logger.addLog({ type: 'TEXT', actorId: self.id, skillId: id, message: fill(texts.end, self) });
      }
    },
    ...draft.reactions.map(reaction => buildPassive(releaseId, reaction)),
    ...draft.procs.map(proc => buildProcPassive(releaseId, proc)),
    ...(actions.some(action => action.gemAilments) ? [buildAilmentPassive(releaseId)] : [])
  ];
  return { skill: shell, release: null, charge: null, grantSkill: dispatch, swords: { markerId, release: chase }, passives, grants: draft.grants, conditions, spCost, damageFactor: round4(factor), links: ids };
}

/**
 * 「多行動一次」用的技能：照引擎平常的選法——擲技能施放率，從能用的技能裡挑一個（再交給 skillSelectionResolver，
 * 權重、蓄力釋放照樣適用），沒擲中或沒有能用的就普攻。已開啟的光環本來就不能再選。
 */
function extraTurnSkill(markerId) {
  const picker = new Skill({ id: `gem_extra_turn:${markerId}`, name: '額外行動', actions: [{ type: 'TEXT', text: { action: '' } }] });
  picker.execute = function execute(caster, allies, enemies, logger, engine) {
    const rng = engine.rng ?? Math.random;
    const usable = caster.skills.filter(skill => skill.canCast(caster, engine));
    let chosen = usable.length && rng() < engine.getSkillCastChance(caster) ? usable[Math.floor(rng() * usable.length)] : caster.normalAttack;
    const replaced = engine.skillSelectionResolver?.({ caster, skill: chosen, allies, enemies, engine });
    if (replaced) chosen = replaced;
    return chosen.execute(caster, allies, enemies, logger, engine);
  };
  return picker;
}

/**
 * 施放當下才決定的傷害加成（condInc 暴怒、critAsDamage 法術會心）：包住 execute，
 * 每次施放依施放者當下的狀態算出倍率，用一個暫時的變體（Object.create）帶著改好 power 的動作去打，不改技能本身。
 *   condInc      條件成立時把 value 加進這段的加算區：power × (底數 + value) ÷ 底數
 *   critAsDamage 乘上 1 + 爆擊率 × (爆擊傷害 − 1)（爆擊率夾在 0～1；讀含 Buff 的實際屬性）
 *   chordInc     撥弦槍的和弦：施放者的 gemChordBonus（和弦值 × 1%）加進所有傷害段（物理與法術，2026-11-22 使用者改）的加算區
 */
function withDynamicDamage(skill, dynamics) {
  if (!dynamics.length) return skill;
  if (dynamics.some(effect => effect.op === 'chordInc')) skill.gemChordAware = true;   // chord.js 的 applyChordDamage 不再重複包
  const base = skill.execute;
  skill.execute = function execute(caster, ...rest) {
    const stats = caster.getEffectiveStats?.() ?? caster.stats;
    const hpRatio = caster.stats.maxHp > 0 ? caster.stats.hp / caster.stats.maxHp : 1;
    let inc = 0, more = 1, spellInc = 0;
    for (const effect of dynamics) {
      if (effect.op === 'condInc' && hpRatio < effect.when.hpBelow) inc += effect.value;
      if (effect.op === 'critAsDamage') more *= 1 + Math.min(1, Math.max(0, stats.cri || 0)) * Math.max(0, (stats.criDmg ?? 1.5) - 1);
      if (effect.op === 'chordInc') spellInc += caster.gemChordBonus || 0;
    }
    if (inc === 0 && more === 1 && spellInc === 0) return base.call(this, caster, ...rest);
    const variant = Object.create(this);
    variant.actions = this.actions.map(action => {
      if (action.type !== 'DAMAGE') return action;
      const incBase = action.gemIncBase ?? 1;
      const add = inc + spellInc;   // 和弦：物理與法術都加（2026-11-22 使用者）
      return { ...action, power: round4(action.power * (incBase + add) / incBase * more) };
    });
    return base.call(variant, caster, ...rest);
  };
  return skill;
}

/**
 * 主動寶石的 critEcho（火焰風暴）：施放完後擲一次施放者的爆擊率（含 Buff，夾在 0～1），
 * 成功就在同一個行動槽裡再打一次：傷害段 power × critEcho.power、開頭換成 critEcho.text。額外那次不再擲（不連鎖）。
 */
function withCritEcho(skill, critEcho) {
  const base = skill.execute;
  skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    const result = base.call(this, caster, allies, enemies, logger, context, options);
    if (!caster.isAlive || !enemies.some(enemy => enemy.isAlive)) return result;
    const stats = caster.getEffectiveStats?.() ?? caster.stats;
    if (random() >= Math.min(1, Math.max(0, stats.cri || 0))) return result;
    const variant = Object.create(this);
    let first = true;
    variant.actions = this.actions.slice(this.gemLeadIndex ?? 0).map(action => {   // 前置動作（Buff 提示）不重放
      if (action.type !== 'DAMAGE') return action;
      const next = { ...action, power: round4(action.power * critEcho.power) };
      delete next.spCost;
      if (first && critEcho.text) { next.text = { ...(next.text || {}), action: expandPart(critEcho.text) }; first = false; }
      return next;
    });
    base.call(variant, caster, allies, enemies, logger, context, { ...options, ignoreSp: true });
    return result;
  };
  return skill;
}

// ── 裝備的非屬性效果 ────────────────────────────────────────

/**
 * 檢查 options.equipment：{ physDmg?, spellDmg?, reduction?, ailmentDmg?, ailmentDuration?, spRegen? }，都是不小於 0 的有限數字（reduction 還要小於 1）。
 * 沒給就是全部 0。回傳補齊的物件。
 */
function checkEquipment(equipment) {
  const result = { physDmg: 0, spellDmg: 0, reduction: 0, ailmentDmg: 0, ailmentDuration: 0, spRegen: 0, summonHp: 0 };
  if (equipment === null || equipment === undefined) return result;
  if (typeof equipment !== 'object' || Array.isArray(equipment)) throw new Error('options.equipment 必須是物件');
  for (const key of Object.keys(equipment)) {
    if (!(key in result)) throw new Error(`options.equipment 沒有「${key}」這個欄位（只有 ${Object.keys(result).join('、')}）`);
    const value = equipment[key];
    if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error(`options.equipment.${key} 必須是不小於 0 的有限數字（收到 ${value}）`);
    result[key] = value;
  }
  if (result.reduction >= 1) throw new Error(`options.equipment.reduction 必須小於 1（收到 ${result.reduction}）`);
  if (!Number.isInteger(result.ailmentDuration)) throw new Error(`options.equipment.ailmentDuration 必須是整數（收到 ${result.ailmentDuration}）`);
  return result;
}

/**
 * 一段傷害動作的最終倍率。裝備的物理／法術傷害提高跟寶石的 inc 同在加算區：(1 + Σinc + 裝備) × Π(1 + more)。
 * 依動作的 stat 判斷：int 是法術；atk 或沒寫是物理；其他屬性（例如拿 def 當傷害來源）不吃這兩種加成。
 */
function damageFactorOf(action, incSum, moreProduct, equip) {
  const stat = action.stat ?? 'atk';
  const bonus = stat === 'int' ? equip.spellDmg : stat === 'atk' ? equip.physDmg : 0;
  return (1 + incSum + bonus) * moreProduct;
}

/** 常駐減傷：開戰時掛一個永久的 damageTaken Buff（只減普通攻擊類傷害，不含持續傷害，與框架的預設一致）。 */
function buildReductionPassive(reduction) {
  return {
    id: 'gem_equipment_reduction',
    trigger: 'BATTLE_START',
    action(self) {
      self.addBuff({ id: 'gem_equipment_reduction', name: '裝備減傷', type: 'STAT', polarity: 'positive', duration: Infinity,
        effect: () => {}, damageTaken: { multiplier: 1 - reduction } });
    }
  };
}

// 每個自己的行動槽結束時回復 SP（AFTER_ACTION 對所有存活單位都會跑，只在 actor 是自己時回復；喘息的槽不算）。
// 小數部分累積到下一次，所以 0.5 = 每兩槽 1 點。框架的 restoreSp 不寫戰報、會同步疲勞狀態。
function buildSpRegenPassive(amount) {
  let carry = 0;
  return {
    id: 'gem_equipment_spRegen',
    trigger: 'AFTER_ACTION',
    enabled: (self, ctx) => self.isAlive && ctx?.actor === self,
    action(self, ctx, logger) {
      carry += amount;
      const whole = Math.floor(carry + 1e-9);
      if (whole <= 0) return;
      carry -= whole;
      self.restoreSp(whole, logger);
    }
  };
}

// ── 蓄力的釋放與檢查 ────────────────────────────────────────

/**
 * 建立 skillSelectionResolver：角色身上有「蓄力中」標記時，把這一槽換成對應的本體並移除標記。
 * 角色暈眩、疲勞動不了的槽不會選招，標記留著，等下一個能行動的槽才釋放。
 * 釋放是已經投入的招式：不再檢查沉默。回傳 undefined 代表這一槽照常。
 * @param {{ charge: { markerId: string, release: Skill } | null }[]} compiledList
 */
function buildChargeResolver(compiledList) {
  const releases = new Map();
  for (const { charge } of compiledList) if (charge) releases.set(charge.markerId, charge.release);
  return ({ caster }) => {
    if (!releases.size) return undefined;
    const marker = caster.buffs.find(buff => releases.has(buff.id));
    if (!marker) return undefined;
    caster.buffs = caster.buffs.filter(buff => buff !== marker);
    return releases.get(marker.id);
  };
}

// ── 施放權重 ────────────────────────────────────────────────

// 從 items 裡依權重抽一個：權重相加成總和，抽 0 到 總和-1 的整數，依序扣掉各項權重，扣到小於 0 的那一項就是結果。
// 權重必須是正整數，所以每一項的機率剛好是 權重 ÷ 總和，沒有浮點誤差。
function pickWeighted(items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let roll = Math.floor(random() * total);
  for (const item of items) {
    roll -= weightOf(item);
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

/**
 * 建立「依權重選招」的 skillSelectionResolver。
 *
 * 時機：引擎先擲 skillCastRate 決定要不要放技能，放的話先均等抽一招，然後才問 resolver。
 * 所以這裡只決定「放哪一招」，施放頻率不變；普攻（沒抽中技能的槽）完全不碰。
 *
 * 介入的條件（任何一個不成立就回傳 undefined，讓引擎照原本的結果走）：
 *   - 引擎抽到的是這組配置的技能（普攻、蓄力釋放的本體、佈局的開場技能不是抽籤抽到的，不動）
 *   - 開場的那一槽不動：佈局承諾「第一動必定施放這一招」
 *   - 可選的技能（SP 夠、施放條件成立、沒被沉默）至少兩個，且權重不全相等
 *   - 權重抽中的和引擎抽到的是同一招時也回傳 undefined：不算「換招」，隊友的 ALLY_SKILL_SELECT 被動照常有機會介入
 * 權重全相等時完全不介入，也不消耗任何亂數，所以沒用到權重的配置，戰鬥結果與亂數序列和以前一模一樣。
 *
 * 限制：
 *   - 權重只在這組配置的技能之間分配。角色身上另外手寫的技能維持原本的均等抽籤，權重管不到。
 *   - 被沉默的招排除在候選之外（resolver 換出來的招不會再被引擎檢查沉默，不排除就會繞過沉默）。
 *     所以引擎先抽到被沉默的招、退回普攻的那一槽，resolver 看到的是普攻，不會介入。
 *   - 一旦換招，引擎會視為「遭遇戰已經選好招」，隊友的 ALLY_SKILL_SELECT 被動那一槽不再被問（蓄力也是同樣的情況）。
 *
 * 亂數用框架的 random()，所以 BattleEngine 的 rng 種子照常可重現。
 * 每場戰鬥都要重新建立（內部記著誰已經行動過）。
 * @param {{ skill: Skill, weight: number }[]} compiledList
 */
function buildWeightResolver(compiledList) {
  const weights = new Map(compiledList.map(result => [result.skill, result.weight]));
  const values = [...weights.values()];
  if (values.every(weight => weight === values[0])) return () => undefined;
  const acted = new WeakSet();
  return ({ caster, skill, engine }) => {
    const first = !acted.has(caster);
    acted.add(caster);
    if (!weights.has(skill)) return undefined;
    if (first && skill === caster.openingSkill) return undefined;
    const candidates = caster.skills.filter(entry => weights.has(entry) && entry.canCast(caster, engine) && !caster.silencedBy(entry));
    if (candidates.length < 2) return undefined;
    const weightOf = entry => weights.get(entry);
    if (candidates.every(entry => weightOf(entry) === weightOf(candidates[0]))) return undefined;
    const picked = pickWeighted(candidates, weightOf);
    return picked === skill ? undefined : picked;
  };
}

/**
 * 把多個 skillSelectionResolver 串起來：依序詢問，第一個回傳技能的決定這一槽。
 * 你已經有自己的 resolver 時用它與 loadout.resolver 合併。
 */
function combineResolvers(...resolvers) {
  const list = resolvers.filter(fn => typeof fn === 'function');
  return context => {
    for (const fn of list) {
      const picked = fn(context);
      if (picked !== undefined) return picked;
    }
    return undefined;
  };
}

// 蓄力的釋放完全靠引擎的 skillSelectionResolver：沒傳的話，標記掛上去就再也不會釋放（技能看起來「什麼都沒發生」）。
// 所以開場就檢查，設定錯誤立刻報錯而不是靜默失效。
function buildChargeGuardPassive() {
  return {
    id: 'gem_charge_guard',
    trigger: 'BATTLE_START',
    action(self, battle, logger, engine) {
      if (typeof engine?.skillSelectionResolver !== 'function') {
        throw new Error('蓄力寶石需要在建立 BattleEngine 時傳入 skillSelectionResolver（例如 { skillSelectionResolver: loadout.resolver }）；' +
          '沒有它，蓄力的技能只會掛上標記而不會釋放。');
      }
    }
  };
}

// 權重不全相等時，一定要把 loadout.resolver 交給 BattleEngine，否則權重只是靜默失效（技能照樣均等抽籤）。
// 與蓄力同樣的理由：設定錯誤在開場就報錯，不要讓玩家以為權重有在運作。
function buildWeightGuardPassive() {
  return {
    id: 'gem_weight_guard',
    trigger: 'BATTLE_START',
    action(self, battle, logger, engine) {
      if (typeof engine?.skillSelectionResolver !== 'function') {
        throw new Error('施放權重不全相等時，需要在建立 BattleEngine 時傳入 skillSelectionResolver（例如 { skillSelectionResolver: loadout.resolver }）；' +
          '沒有它，權重不會生效，技能只會均等抽籤。');
      }
    }
  };
}

/**
 * 編譯一整個角色的寶石配置，回傳可以直接放進 Entity 的 skills 與 passives。
 * passives 包含 reaction 類寶石的被動，以及佈局、撒手鐧這類角色層級的被動（同類已合併，見 buildGrantPassives）。
 *   new Entity({ ..., skills: loadout.skills, passives: loadout.passives })
 * 被動物件帶有戰鬥狀態，所以「每場戰鬥」都要重新呼叫一次，不要在多場戰鬥之間共用。
 * @param {{ active: string, supports?: string[], weight?: number, grantedSupports?: string[], castOnEnemyDeath?: { text?: string } }[]} gems
 *   每個元素是一顆主動寶石與它連結的輔助寶石，以及選填的施放權重 weight（MIN_WEIGHT～MAX_WEIGHT 的整數，預設 DEFAULT_WEIGHT；見 gems.js 的「施放權重」）。
 *   grantedSupports  裝備給的額外輔助寶石（不佔連結位；不相容的自動不套用；見 compileWithGranted）
 *   castOnEnemyDeath 裝備給的「敵人倒下時釋放一次」（見 buildEnemyDeathCastPassives）
 * @param {object} [options] 同 compileSkill 的 options；另有 equipment: { physDmg, spellDmg, reduction, ailmentDmg }（裝備的非屬性效果，見 affixTable.js）
 *   ailmentDmg 乘在每個異常效果的倍率上：power × (1 + ailmentDmg)（異常自己的加算區）
 *   ailmentDuration 加在每個異常的持續槽數上（AILMENTS 標 extendable: false 的除外；目前沒有）
 *   spRegen 變成「每個自己的行動槽結束時回復 SP」的被動（passives 裡多一個 gem_equipment_spRegen）
 *   physDmg／spellDmg 進每段傷害的加算區；reduction 變成開戰時掛上的常駐減傷 Buff（passives 裡多一個 gem_equipment_reduction）
 * @returns {{ skills: Skill[], passives: object[], resolver: Function, weights: object, releaseSkills: Skill[], compiled: object[] }}
 *   resolver       給 BattleEngine 的 skillSelectionResolver：蓄力的釋放（先問）加上依權重選招。
 *                  配置裡有蓄力或權重不全相等時一定要傳（沒傳都會在開場報錯，免得蓄力不釋放、權重靜默失效）；
 *                  都沒有時傳了也無害。已經有自己的 resolver 就用 combineResolvers 串起來。
 *   weights        { 技能 id: 權重 }，給 UI 與除錯看
 *   releaseSkills  蓄力技能的本體（給 UI 或除錯看，不要放進 Entity.skills）
 *   compiled  每組的完整編譯結果（含 spCost、damageFactor、links），給 UI 顯示用
 * @throws {GemLinkError} 任何一組連結不合法。同一組（主動＋輔助完全相同）重複出現時，第 n 組的技能 id 加上 #n，不再報錯
 */
// ── 連續光環（chainaura，2026-11-24 使用者設計）────────────────────────
// 連了連續光環的光環主動寶石，輔助槽可以放其他光環主動寶石（佔輔助槽名額）。
//   ・被連結的光環共用主光環的輔助寶石（觸發型與不合法的除外，見 inheritedSupports；2026-11-25 使用者）。
//   ・被連結的光環不會自己開啟（不進技能清單、不會被選）；主光環開啟時（自己施放、佈局、撒手鐧…）一起開啟：
//     照它自己的開啟文本印一行，不多給行動；每回合的 SP 各自扣、各自判斷（被動照常掛在角色身上）。
//   ・連續光環連到不是光環的主動寶石：沒有效果、不報錯（使用者）。只有「輔助槽放了主動寶石」不合規時才報錯。
//   ・穿戴中同一顆光環只能開一個：照裝備順序第一個保留；之後重複的（直接裝的整組、或被連結的那一顆）沒有效果（不報錯）。
function checkChainedAuras(activeId, supports, chained, activeGems) {
  const host = activeGems[activeId];
  const isAura = gem => gem?.tags?.includes('aura');
  for (const gemId of chained) {
    if (!isAura(activeGems[gemId])) throw new GemLinkError(gemId, `「${activeGems[gemId].name}」不是光環，不能放進輔助槽`);
    if (!isAura(host) || !supports.includes('chainaura')) throw new GemLinkError(gemId, '只有連結「連續光環」的光環主動寶石，輔助槽才能放光環主動寶石');
    if (gemId === activeId) throw new GemLinkError(gemId, '不能連結主光環自己');
  }
  const sorted = [...chained].sort();
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new GemLinkError(sorted[i], '同一個技能不能連結兩次');
}

/**
 * 被連結的光環共用主光環的輔助寶石（2026-11-25 使用者）：主光環連的輔助寶石，扣掉連續光環本身、觸發型（grant：佈局、撒手鐧、追擊…，
 * 開啟時機只跟主光環走）、以及對這顆光環不合法的（逐顆試編譯，不合法就跳過、不報錯），其餘照套。介面也用這個列出「也吃哪些」。
 */
function inheritedSupports(chainedId, hostSupports, options = {}) {
  const supportGems = options.supportGems ?? SUPPORT_GEMS;
  const candidates = hostSupports.filter(gemId => gemId !== 'chainaura' && Object.hasOwn(supportGems, gemId)
    && !(supportGems[gemId].effects ?? []).some(effect => effect.op === 'grant'));
  return candidates.filter(gemId => {
    try { compileSkill(chainedId, [gemId], { ...options, copy: 1, sameActiveOthers: 0 }); return true; }
    catch (error) { if (error instanceof GemLinkError) return false; throw error; }
  });
}

function linkChainedAuras(compiled, options) {
  const taken = new Set(compiled.map(result => result.activeId));
  const linked = [];
  for (const host of compiled) {
    if (!host.chainedAuras || !host.aura) continue;
    const subs = [];
    for (const gemId of host.chainedAuras) {
      if (taken.has(gemId)) continue;   // 重複：沒有效果
      taken.add(gemId);
      const inherited = inheritedSupports(gemId, host.hostSupports ?? [], options);
      const sub = compileSkill(gemId, inherited, { ...options, maxSupports: MAX_SUPPORTS, copy: 1, sameActiveOthers: 0 });
      sub.inheritedSupports = inherited;
      subs.push(sub);
    }
    if (!subs.length) continue;
    host.linkedAuras = subs;
    linked.push(...subs);
    const isOpen = (entity, markerId) => entity.buffs?.some(buff => buff.id === markerId);
    const shell = host.skill;
    const hostExecute = shell.execute;
    shell.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
      const result = hostExecute.call(this, caster, allies, enemies, logger, context, options);
      if (!isOpen(caster, host.aura.markerId)) return result;
      // 被連結的光環照它自己的外殼開啟（開啟文本、荊棘的開啟回合免費…），但不多給行動
      // context 通常就是 engine（insertAction 在原型上）：暫時用自己的屬性蓋掉，結束後刪掉還原
      const own = context && Object.prototype.hasOwnProperty.call(context, 'insertAction');
      const insert = context?.insertAction;
      if (context) context.insertAction = undefined;
      try {
        for (const sub of subs) {
          if (!isOpen(caster, sub.aura.markerId)) sub.skill.execute(caster, allies, enemies, logger, context, { ...options, ignoreSp: true });
        }
      } finally {
        if (context) { if (own) context.insertAction = insert; else delete context.insertAction; }
      }
      return result;
    };
  }
  return linked;
}

function compileLoadout(gems, options = {}) {
  const compiled = [];
  // 反覆（sameActiveInc）用：每顆主動寶石在這份配置裡出現幾組
  const activeCounts = new Map();
  for (const { active } of gems) activeCounts.set(active, (activeCounts.get(active) ?? 0) + 1);
  const seen = new Set();
  const deathCasts = [];
  const critCasts = [];
  const chasers = [];
  const activeGems = options.activeGems ?? ACTIVE_GEMS;
  const maxSlots = options.maxSupports ?? MAX_SUPPORTS;
  for (const { active, supports: slotted = [], weight = DEFAULT_WEIGHT, grantedSupports = [], castOnEnemyDeath = null, castOnCrit = null, phantomChase = false } of gems) {
    if (!Number.isInteger(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
      throw new GemLinkError(active, `施放權重必須是 ${MIN_WEIGHT}～${MAX_WEIGHT} 的整數（收到 ${weight}）`);
    }
    // 連續光環：輔助槽裡的主動寶石＝被連結的光環（佔輔助槽名額），其餘照常是輔助寶石
    const chained = slotted.filter(gemId => Object.hasOwn(activeGems, gemId));
    const supports = slotted.filter(gemId => !Object.hasOwn(activeGems, gemId));
    if (chained.length) {
      if (slotted.length > maxSlots) throw new GemLinkError(slotted[maxSlots], `每顆主動寶石最多連結 ${maxSlots} 顆輔助寶石（這組有 ${slotted.length} 顆）`);
      checkChainedAuras(active, supports, chained, activeGems);
    }
    if (!Array.isArray(grantedSupports)) throw new GemLinkError(active, 'grantedSupports 必須是陣列');
    for (const gemId of grantedSupports) {
      if (!Object.hasOwn(options.supportGems ?? SUPPORT_GEMS, gemId)) throw new GemLinkError(gemId, '裝備給的輔助寶石不存在');
    }
    const compileAs = copyOptions => grantedSupports.length ? compileWithGranted(active, supports, grantedSupports, copyOptions) : compileSkill(active, supports, copyOptions);
    const linkOptions = { ...options, sameActiveOthers: activeCounts.get(active) - 1, ...(chained.length ? { maxSupports: maxSlots - chained.length } : {}) };
    let result = compileAs(linkOptions);
    // 同一組重複裝：第 n 次出現的那組重新編譯成 #n（各自獨立的技能，權重、蓄力、迴響都分開算）
    for (let copy = 2; seen.has(result.skill.id); copy++) result = compileAs({ ...linkOptions, copy });
    result.weight = weight;
    result.activeId = active;
    if (castOnEnemyDeath) deathCasts.push([result, castOnEnemyDeath.text]);
    if (castOnCrit) critCasts.push([result, castOnCrit]);
    if (phantomChase) chasers.push(result);
    if (chained.length) { result.chainedAuras = chained; result.hostSupports = supports; }
    seen.add(result.skill.id);
    compiled.push(result);
  }
  // 穿戴中同一顆光環只能開一個（2026-11-24 使用者）：照裝備順序，第一個保留，之後重複的那組沒有效果（不報錯）
  const auraSeen = new Set();
  for (const result of compiled) {
    if (!result.aura) continue;
    if (auraSeen.has(result.activeId)) result.inert = true;
    else auraSeen.add(result.activeId);
  }
  const live = compiled.filter(result => !result.inert);
  const linkedAuras = linkChainedAuras(live, options);
  const equip = checkEquipment(options.equipment);
  const mechanics = options.mechanics ?? [];
  const spShield = mechanics.find(m => m.type === 'spShield');
  if (spShield) for (const result of live) withSpShield(result.skill, spShield);   // 外殼（蓄力、迴響）付 SP，本體免費，不用包
  const breakSp = mechanics.filter(m => m.type === 'shieldBreakSp').reduce((sum, m) => sum + m.sp, 0);
  const phantom = mechanics.find(m => m.type === 'phantom');
  if (phantom) for (const result of chasers.filter(result => !result.inert)) for (const skill of [result.skill, result.release, result.echo?.release]) if (skill) withPhantomChase(skill, phantom);
  const hasCharge = live.some(result => result.charge);
  const hasUnequalWeights = new Set(live.map(result => result.weight)).size > 1;
  return {
    skills: live.map(result => result.skill),
    passives: [
      ...live.flatMap(result => result.passives),
      ...linkedAuras.flatMap(result => result.passives),
      ...buildGrantPassives(live),
      ...deathCasts.filter(([result]) => !result.inert).flatMap(([result, text]) => buildEnemyDeathCastPassives(result, text)),
      ...buildCritCastPassives(critCasts.filter(([result]) => !result.inert)),
      ...(breakSp > 0 ? [buildShieldBreakSpPassive(breakSp)] : []),
      ...(phantom ? [buildPhantomPassive(phantom, equip.summonHp)] : []),
      ...(equip.reduction > 0 ? [buildReductionPassive(equip.reduction)] : []),
      ...(equip.spRegen > 0 ? [buildSpRegenPassive(equip.spRegen)] : []),
      ...(hasCharge ? [buildChargeGuardPassive()] : []),
      ...(hasUnequalWeights ? [buildWeightGuardPassive()] : [])
    ],
    resolver: combineResolvers(buildChargeResolver(live), buildWeightResolver(live)),
    weights: Object.fromEntries(live.map(result => [result.skill.id, result.weight])),
    releaseSkills: live.filter(result => result.release).map(result => result.release),
    compiled
  };
}

module.exports = { compileSkill, compileLoadout, buildGrantPassives, buildChargeResolver, buildWeightResolver, combineResolvers, describeSupport, describePlayer, validateGemData, inheritedSupports, GemLinkError };
