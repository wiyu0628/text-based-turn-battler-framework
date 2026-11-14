'use strict';

/**
 * 寶石編譯器 v9：主動寶石 + 輔助寶石 → 框架的 Skill（以及需要時的被動）。
 *
 * 只依賴框架公開的 Skill，不改框架任何檔案。流程與規則見 gems.js 開頭的說明。
 * 你的專案裡把下面的 require 換成 require('text-based-turn-battler-framework')。
 */
const { Skill, Buff, random } = require('../src');
const { ACTIVE_GEMS, SUPPORT_GEMS, GROUPS, MAX_SUPPORTS, DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT } = require('./gems');
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

const KNOWN_OPS = new Set(['inc', 'more', 'cost', 'scope', 'actionFlag', 'appendAction', 'prependAction', 'reaction', 'grant', 'wrap', 'castCondition', 'proc']);
const CONDITION_STATS = { selfHp: { name: '自身生命', ratio: true }, enemyCount: { name: '敵人數量', ratio: false } };
const GRANT_KINDS = new Set(['opening', 'lastResort']);
const WRAP_KINDS = new Set(['charge']);
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
  for (const [key, gem] of Object.entries(supportGems)) {
    const where = `寶石「${key}」`;
    if (gem.id !== key) problems.push(`${where}的 id（${gem.id}）與登錄的鍵不一致`);
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
      if (effect.op === 'wrap' && !WRAP_KINDS.has(effect.kind)) {
        problems.push(`${where}的 wrap 使用了未知的 kind「${effect.kind}」`);
      }
      if (effect.op === 'grant') {
        if (effect.text !== undefined && typeof effect.text !== 'string') problems.push(`${where}的 grant text 必須是字串`);
        if (!GRANT_KINDS.has(effect.kind)) {
          problems.push(`${where}的 grant 使用了未知的 kind「${effect.kind}」`);
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
        : `${effect.trigger} 時觸發 ${effect.do.kind}` };
    case 'proc':
      return { kind: 'proc', text: `${effect.per === 'hit' ? '每一擊' : '每個被打中的敵人'}有 ${pct(effect.chance)} 機率：${effect.summary}` };
    case 'castCondition':
      return { kind: 'condition', text: describeCondition(effect) };
    case 'wrap':
      return { kind: 'effect', text: '使用後需要等一個行動槽：下一次行動時自動釋放，期間不能改做別的事（SP 在使用時一次扣完）' };
    case 'grant':
      if (effect.kind === 'opening') {
        return { kind: 'effect', text: '戰鬥開始後的第一次行動必定施放此技能（多個技能連結佈局時，隨機選一個）' };
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
  const candidates = { opening: [], lastResort: [] };
  let threshold = null;
  for (const { skill, grants = [] } of compiledList) {
    for (const grant of grants) {
      // skill 用來判斷能不能放；use 是實際放出去的版本（有 text 時是加了開頭的複本）
      candidates[grant.kind].push({ skill, use: grant.text ? withLeadText(skill, grant.text) : skill });
      if (grant.kind === 'lastResort') threshold = grant.threshold;
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
  return passives;
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
  activeGems = ACTIVE_GEMS, supportGems = SUPPORT_GEMS, groups = GROUPS, maxSupports = MAX_SUPPORTS
} = {}) {
  if (!Number.isInteger(maxSupports) || maxSupports < 0) {
    throw new Error(`maxSupports 必須是不小於 0 的整數，收到 ${maxSupports}`);
  }
  assertValidGemData(supportGems, groups);
  const active = activeGems[activeId];
  if (!active) throw new GemLinkError(activeId, '找不到這顆主動寶石');
  if (active.id !== activeId) throw new Error(`主動寶石「${activeId}」的 id（${active.id}）與登錄的鍵不一致；技能 id 是用鍵組出來的，改 id 時鍵要一起改`);
  // 數量上限先檢查，指出「第一顆放不下」的那一顆（照傳入順序）。這是整組的錯，只有這則提示會看順序。
  if (supportIds.length > maxSupports) {
    throw new GemLinkError(supportIds[maxSupports],
      `每顆主動寶石最多連結 ${maxSupports} 顆輔助寶石（這組有 ${supportIds.length} 顆）`);
  }

  // 固定處理順序：與插槽順序無關。
  const ids = [...supportIds].sort();
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] === ids[i - 1]) throw new GemLinkError(ids[i], '同一個技能不能連結兩次');
  }

  // 基準：主動寶石原本的樣子。條件只對它判斷；效果也都以它為依據。
  const base = { tags: [...active.tags], actions: structuredClone(active.actions) };
  const draft = {
    tags: [...active.tags],
    actions: structuredClone(active.actions),
    inc: [], more: [], costMult: 1, prepended: [], appended: [], reactions: [], grants: [], wraps: [], procs: []
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
  const actions = [...draft.prepended, ...draft.actions, ...draft.appended].map(action => {
    const next = withStatEffects(expandText(action));
    if (next.type === 'DAMAGE') next.power = round4((next.power ?? 1) * factor);
    return next;
  });
  if (draft.prepended.length && draft.actions.length) {
    const first = draft.prepended.length;
    actions[first] = { ...actions[first], inheritTarget: actions[first].inheritTarget ?? false };
  }
  const spCost = active.spCost > 0
    ? Math.max(1, Math.ceil(+(active.spCost * draft.costMult).toFixed(6)))
    : 0;
  const id = [activeId, ...ids].join('+');
  const tags = draft.tags;
  const uncounterable = active.uncounterable === true;

  // 蓄力：玩家選到的是外殼（只扣 SP、掛標記），本體等下一個行動槽由 skillSelectionResolver 換上來釋放。
  // 反應被動（汲取）要綁在本體上，因為實際造成傷害的是本體。
  if (draft.wraps.includes('charge')) {
    const releaseId = `${id}#release`;
    const markerId = `gem_charged:${releaseId}`;
    const release = new Skill({ id: releaseId, name: active.name, tags: [...tags], actions, uncounterable });
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
      passives: [...draft.reactions.map(reaction => buildPassive(releaseId, reaction)), ...draft.procs.map(proc => buildProcPassive(releaseId, proc))],
      grants: draft.grants, conditions, spCost, damageFactor: round4(factor), links: ids
    };
  }

  if (actions.length) actions[0] = { ...actions[0], spCost };
  const skill = makeSkill({ id, name: active.name, tags, actions, uncounterable }, conditions);
  // 前置動作（例如爆擊強化的提示）排在技能那一行之前；佈局的開頭文字要接在技能那一行，不能接在前置動作上。
  skill.gemLeadIndex = draft.prepended.length;
  skill.gemSlotBuffIds = slotBuffIds(actions);
  const passives = [...draft.reactions.map(reaction => buildPassive(id, reaction)), ...draft.procs.map(proc => buildProcPassive(id, proc))];
  return { skill, release: null, charge: null, passives, grants: draft.grants, conditions, spCost, damageFactor: round4(factor), links: ids };
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
 * @param {{ active: string, supports?: string[], weight?: number }[]} gems 每個元素是一顆主動寶石與它連結的輔助寶石，
 *   以及選填的施放權重 weight（MIN_WEIGHT～MAX_WEIGHT 的整數，預設 DEFAULT_WEIGHT；見 gems.js 的「施放權重」）
 * @param {object} [options] 同 compileSkill 的 options
 * @returns {{ skills: Skill[], passives: object[], resolver: Function, weights: object, releaseSkills: Skill[], compiled: object[] }}
 *   resolver       給 BattleEngine 的 skillSelectionResolver：蓄力的釋放（先問）加上依權重選招。
 *                  配置裡有蓄力或權重不全相等時一定要傳（沒傳都會在開場報錯，免得蓄力不釋放、權重靜默失效）；
 *                  都沒有時傳了也無害。已經有自己的 resolver 就用 combineResolvers 串起來。
 *   weights        { 技能 id: 權重 }，給 UI 與除錯看
 *   releaseSkills  蓄力技能的本體（給 UI 或除錯看，不要放進 Entity.skills）
 *   compiled  每組的完整編譯結果（含 spCost、damageFactor、links），給 UI 顯示用
 * @throws {GemLinkError} 任何一組連結不合法，或兩組編譯出同一個技能 id（同一顆主動寶石連結相同輔助寶石兩次）
 */
function compileLoadout(gems, options = {}) {
  const compiled = [];
  const seen = new Set();
  for (const { active, supports = [], weight = DEFAULT_WEIGHT } of gems) {
    if (!Number.isInteger(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
      throw new GemLinkError(active, `施放權重必須是 ${MIN_WEIGHT}～${MAX_WEIGHT} 的整數（收到 ${weight}）`);
    }
    const result = compileSkill(active, supports, options);
    result.weight = weight;
    if (seen.has(result.skill.id)) {
      throw new GemLinkError(active, `配置重複：${result.skill.id} 出現兩次（同一個技能 id 無法同時存在）`);
    }
    seen.add(result.skill.id);
    compiled.push(result);
  }
  const hasCharge = compiled.some(result => result.charge);
  const hasUnequalWeights = new Set(compiled.map(result => result.weight)).size > 1;
  return {
    skills: compiled.map(result => result.skill),
    passives: [
      ...compiled.flatMap(result => result.passives),
      ...buildGrantPassives(compiled),
      ...(hasCharge ? [buildChargeGuardPassive()] : []),
      ...(hasUnequalWeights ? [buildWeightGuardPassive()] : [])
    ],
    resolver: combineResolvers(buildChargeResolver(compiled), buildWeightResolver(compiled)),
    weights: Object.fromEntries(compiled.map(result => [result.skill.id, result.weight])),
    releaseSkills: compiled.filter(result => result.release).map(result => result.release),
    compiled
  };
}

module.exports = { compileSkill, compileLoadout, buildGrantPassives, buildChargeResolver, buildWeightResolver, combineResolvers, describeSupport, validateGemData, GemLinkError };
