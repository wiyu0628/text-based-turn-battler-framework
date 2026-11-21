'use strict';

/**
 * 存檔層 v2：存檔的資料結構、驗證、版本遷移、背包操作，以及可替換的儲存介面。
 *
 * ── 存檔裡有什麼 ─────────────────────────────────────────────
 *   version     存檔版本號（整數）。改了資料結構就加一，並在 MIGRATIONS 補上升級函式。
 *   meta        gameVersion、createdAt、savedAt、nextId（下一個物品 id 的編號，保證 id 不重複）
 *   gems        背包裡的寶石堆疊：{ magicmissile: 3, heavy: 2 }。寶石沒有個體差異，所以只存數量。
 *               「鑲在裝備上」的寶石不在這裡，而是記在那件裝備的 links。
 *   engravings  刻印堆疊：{ "atkA@3": 2 }（種類@階級）。詞綴在「賦予裝備」時才擲，刻印本身沒有個體差異。
 *   equipment   裝備陣列，每件只存「擲出來的結果」，讀檔不重抽：
 *                 { id: 'eq7', slot, origin: 'drop'|'craft',
 *                   base:    [{ stat, op: 'flat', value }]          基礎數值
 *                   affixes: [{ scope: 'wearer', stat, op, value, source? }      影響穿戴者（與加成層同格式）
 *                            { scope: 'effect', kind, value, source? }           穿戴者全體的非屬性效果：EFFECT_KINDS（見 affixTable.js）
 *                            { scope: 'gems', kind, value, source? }],           影響這件裝備上的寶石（kind 之後設計）
 *                   castWeight: 100,                                             施放權重（10～999），裝備擲出來的結果
 *                   quality?: 'common'                                           製作裝備的品質（craftTable.QUALITIES 的 id；掉落裝備沒有）
 *                   legendaryId?: 'omen'                                         傳說裝備的種類（legendaryTable.LEGENDARIES 的鍵；只有掉落裝備）
 *                   attackStat?: 'int'                                           武器：普攻吃 atk 或 int（沒寫＝atk；只有武器能寫）
 *                   name?: '堅韌布甲'                                            玩家取的名字（1～ITEM_NAME_MAX 字；只有製作裝備；沒寫就用部位名）
 *                   materials?: ['fury@5', …]                                    製作時投入的 10 個刻印（分解時從這裡退回；只有製作裝備）
 *                   links:   [{ active, supports: [] }] }                        鑲在這件裝備上的寶石連結
 *               每件裝備一組連結（1 顆主動 + 3 顆輔助），槽數沒有個體差異，所以不存在裝備裡，
 *               而是由 SLOT_RULES 決定。之後主動寶石能放進輔助槽時，只要改 SLOT_RULES（與編譯器），存檔格式不變。
 *               權重在裝備上、不在連結上：換寶石不會洗掉權重。穿戴時 equippedLinks 才把權重帶進連結。
 *   equipped    { weapon, helmet, armor, boots }：穿戴中的裝備 id 或 null
 *   progress    defeatedBosses、unlockedRegions、unlockedMonsters（id 字串陣列）
 *   settings    difficulty（1～15）；playerName（選填，1～PLAYER_NAME_MAX 字；沒有就用遊戲層的預設名，不需要遷移）
 *   energy      能量槽（不小於 0 的整數，沒有上限；v2 新增，2026-11-20 移除上限 500）。勝利與分解刻印取得，清除裝備上的刻印時消耗（見 energyTable.js）
 *   blackDice   黑骰數量（不小於 0 的整數；v8 新增）。分解傳說裝備得 1 顆，用來重置一件傳說裝備的數值（rerollLegendary）
 *
 * 不存：編譯後的技能、最終屬性、戰報、掉落表。這些讀檔後重新計算。
 *
 * ── 操作都是「回傳新存檔」 ─────────────────────────────────────
 * addGems、setLinks 這類函式不會改傳入的存檔，而是回傳修改後的複本；操作後的結果不合法就丟 SaveError，
 * 原存檔完全不受影響（不會出現扣了一半的背包）。
 *
 * ── 儲存介面 ──────────────────────────────────────────────────
 * 儲存位置抽象成 adapter：{ read(), write(text), remove() }，可同步也可回傳 Promise。
 * 現在有記憶體版（測試用）與 localStorage 版；之後換 IndexedDB 只需要寫新的 adapter，呼叫端不用改。
 * createSaveStore 回傳的方法一律是 async。
 */

const { ACTIVE_GEMS, SUPPORT_GEMS, STARTING_ACTIVE_GEMS, MAX_SUPPORTS, DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT } = require('./gems');
const { validateBonuses } = require('./statLayer');
const { EFFECT_KINDS, ENGRAVINGS_PER_ITEM, LINES_PER_ENGRAVING, ENGRAVING_TYPES, canEngrave, sumEffectAffixes, rollCombine, rollEngraving, COMBINE_INPUTS, TIER_SCALE, ROLL_MIN } = require('./affixTable');
const { compileLoadout } = require('./gemCompiler');
const { QUALITIES, CRAFT_AFFIX_SLOTS, CRAFT_INPUTS, SALVAGE_RETURN, rollCraft, rerollCraftAffixes } = require('./craftTable');
const { ACCESSORIES, STARTING_ACCESSORIES, accessoryAffixes } = require('./accessoryTable');
const { createSeededRandom } = require('../src');
const { LEGENDARIES, rollLegendary, pickLegendary, mechanicsOf, rerollLegendaryValues, inferLegendaryTier } = require('./legendaryTable');
const { SALVAGE_ENERGY, CLEAR_COST, TRANSFER_ENERGY, CRAFT_REROLL_LOCK_ENERGY, addEnergy } = require('./energyTable');
const { BOSSES } = require('./bosses');
const { REGIONS } = require('./monsters');
const ATTACK_STATS = ['atk', 'int'];

const SAVE_VERSION = 10;
const SLOTS = ['weapon', 'helmet', 'armor', 'boots'];
const ORIGINS = ['drop', 'craft'];
// 可以刻刻印的裝備來源。掉落裝備目前只有傳說裝備（獨有效果、沒有隨機詞綴），所以不能刻。
const ENGRAVABLE_ORIGINS = ['craft'];
const SLOT_NAMES = { weapon: '武器', helmet: '頭盔', armor: '護甲', boots: '鞋子' };
const ENGRAVING_SOURCE = /^engraving:([A-Za-z][A-Za-z0-9_]*@[1-5])$/;
const LINES_PER_ITEM_ENGRAVING = LINES_PER_ENGRAVING - 1;   // 每個刻印刻上去生效的行數（3 取 2）
const AFFIX_SCOPES = ['wearer', 'gems', 'effect'];
const PROGRESS_KEYS = ['defeatedBosses', 'unlockedRegions', 'unlockedMonsters'];
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 15;
const PLAYER_NAME_MAX = 12;   // 玩家名字長度上限（字元數，我定的）
const ITEM_NAME_MAX = 12;     // 製作裝備名字長度上限（使用者決定）
const validName = (name, max) => typeof name === 'string' && name.trim() === name && name.length > 0 && [...name].length <= max;
const MIN_TIER = 1;
const MAX_TIER = 5;
const ENGRAVING_TYPE = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENGRAVING_KEY = /^[A-Za-z][A-Za-z0-9_]*@[1-5]$/;
const ITEM_ID = /^eq(\d+)$/;
const DEFAULT_STORAGE_KEY = 'gem-battler-save';

class SaveError extends Error {
  /**
   * @param {string} message 給玩家／開發者看的原因
   * @param {string[]} [problems] 詳細問題清單（驗證失敗時一次列出全部）
   */
  constructor(message, problems = []) {
    super(problems.length ? `${message}：\n- ${problems.join('\n- ')}` : message);
    this.name = 'SaveError';
    this.problems = problems;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isInteger(value) && value >= 1;
// 主動寶石是「擁有制」（使用者決定）：背包數量只會是 1（擁有）或沒有；鑲上去不扣背包，同一顆可以鑲在任意多件裝備上
// （穿戴中的裝備仍然同一種主動寶石只能有一顆生效，見 compileEquipped）。輔助寶石照舊一顆一顆算，鑲上去會從背包扣。
const isActiveGem = id => Object.hasOwn(ACTIVE_GEMS, id);
const isGemId = id => Object.hasOwn(ACTIVE_GEMS, id) || Object.hasOwn(SUPPORT_GEMS, id);

// ── 建立 ─────────────────────────────────────────────────────

/**
 * 開新遊戲用的存檔：空存檔 ＋ 開局的主動寶石各 1 顆（gems.STARTING_ACTIVE_GEMS）。
 * createEmptySave 維持完全空白（測試與工具用）。
 */
function createStarterSave(options = {}) {
  const save = createEmptySave(options);
  for (const gemId of STARTING_ACTIVE_GEMS) save.gems[gemId] = (save.gems[gemId] ?? 0) + 1;
  save.accessories = { owned: [...STARTING_ACCESSORIES], equipped: STARTING_ACCESSORIES[0] ?? null };   // 開局飾品，第一個直接穿上
  return save;
}

/**
 * 全新的存檔。
 * @param {{ now?: string, gameVersion?: string }} [options] now 是 ISO 時間字串（測試時傳固定值）
 */
function createEmptySave({ now = new Date().toISOString(), gameVersion = null } = {}) {
  return {
    version: SAVE_VERSION,
    meta: { gameVersion, createdAt: now, savedAt: null, nextId: 1 },
    gems: {},
    engravings: {},
    equipment: [],
    equipped: Object.fromEntries(SLOTS.map(slot => [slot, null])),
    progress: Object.fromEntries(PROGRESS_KEYS.map(key => [key, []])),
    settings: { difficulty: MIN_DIFFICULTY },
    energy: 0,
    blackDice: 0,   // 黑骰（v8）
    accessories: { owned: [], equipped: null }   // 飾品：擁有制，只記 id（詞綴查 accessoryTable）
  };
}

// ── 驗證 ─────────────────────────────────────────────────────

// 連結的標準形狀：只有 active 與 supports（權重在裝備上，不在連結上）。
function normalizeLinks(links) {
  return links.map(link => ({ active: link.active, supports: [...(link.supports ?? [])] }));
}

/**
 * 連結的規則：哪些事「之後可能會變」都集中在這裡，驗證與背包操作一律透過它問，不自己寫死。
 * 例如之後設計出「主動寶石可以放進輔助槽」時：改 canFillSupportSlot 放行主動寶石、
 * 改 supportSlotCount 讓槽數隨寶石變動（再配合編譯器），存檔格式與背包操作都不用動。
 * 參數的 link 是那一組連結（{ active, supports }），item 是那件裝備，現在都還用不到，是留給之後的條件。
 */
const SLOT_RULES = {
  /** 一件裝備最多有幾組連結。 */
  maxLinks(item) { return 1; },
  /** 這組連結有幾個輔助槽。 */
  supportSlotCount(link, item) { return MAX_SUPPORTS; },
  /** 這顆寶石能不能放進輔助槽。 */
  canFillSupportSlot(gemId, link, item) { return Object.hasOwn(SUPPORT_GEMS, gemId); }
};

// 編譯結果只取決於連結內容（寶石資料是固定的），所以同一組連結只編譯一次，之後直接用結果。
// 每次背包操作都會整份重新驗證，沒有這層快取的話，裝備一多就會越來越慢。
const compileCheckCache = new Map();

function compileProblem(links) {
  const key = JSON.stringify(links);
  if (!compileCheckCache.has(key)) {
    let problem = null;
    try { compileLoadout(links); } catch (error) { problem = error.message; }
    compileCheckCache.set(key, problem);
  }
  return compileCheckCache.get(key);
}

function validateLinks(links, where, item) {
  if (!Array.isArray(links)) return [`${where}的 links 必須是陣列`];
  const problems = [];
  const maxLinks = SLOT_RULES.maxLinks(item);
  if (links.length > maxLinks) problems.push(`${where}的連結超過上限：一件裝備最多 ${maxLinks} 組`);
  links.forEach((link, index) => {
    const at = `${where}第 ${index + 1} 組連結`;
    if (!isObject(link)) { problems.push(`${at}不是物件`); return; }
    if (!Object.hasOwn(ACTIVE_GEMS, link.active)) problems.push(`${at}的主動寶石「${link.active}」不存在`);
    if (link.weight !== undefined) problems.push(`${at}不能寫 weight：權重在裝備的 castWeight 上`);
    const supports = link.supports ?? [];
    if (!Array.isArray(supports)) problems.push(`${at}的 supports 必須是陣列`);
    else {
      const slots = SLOT_RULES.supportSlotCount(link, item);
      if (supports.length > slots) problems.push(`${at}的輔助寶石超過輔助槽上限 ${slots} 顆`);
      for (const id of supports) {
        if (!isGemId(id)) problems.push(`${at}的輔助寶石「${id}」不存在`);
        else if (!SLOT_RULES.canFillSupportSlot(id, link, item)) problems.push(`${at}的寶石「${id}」不能放進輔助槽`);
      }
    }
  });
  // 形狀沒問題才試編譯：互斥、重複的技能 id 等寶石規則由編譯器負責，這裡不重寫一份。
  if (!problems.length) {
    const problem = compileProblem(normalizeLinks(links));
    if (problem) problems.push(`${where}：${problem}`);
  }
  return problems;
}

function validateEquipmentItem(item, where, nextId) {
  if (!isObject(item)) return [`${where}不是物件`];
  const problems = [];
  const match = typeof item.id === 'string' ? ITEM_ID.exec(item.id) : null;
  if (!match) problems.push(`${where}的 id 必須是 eq 加數字（收到 ${JSON.stringify(item.id)}）`);
  else if (Number(match[1]) >= nextId) problems.push(`${where}的 id「${item.id}」不小於 meta.nextId（${nextId}），之後配發的 id 會重複`);
  if (!SLOTS.includes(item.slot)) problems.push(`${where}的 slot「${item.slot}」不是 ${SLOTS.join('、')} 之一`);
  if (!ORIGINS.includes(item.origin)) problems.push(`${where}的 origin「${item.origin}」不是 ${ORIGINS.join('、')} 之一`);

  if (!Array.isArray(item.base)) problems.push(`${where}的 base 必須是陣列`);
  else {
    problems.push(...validateBonuses(item.base).map(problem => `${where}的 base：${problem}`));
    item.base.forEach((bonus, index) => {
      if (isObject(bonus) && bonus.op !== 'flat') problems.push(`${where}的 base 第 ${index + 1} 筆必須是 flat（基礎數值只有固定值）`);
    });
  }

  if (!Array.isArray(item.affixes)) problems.push(`${where}的 affixes 必須是陣列`);
  else {
    item.affixes.forEach((affix, index) => {
      const at = `${where}第 ${index + 1} 條詞綴`;
      if (!isObject(affix)) { problems.push(`${at}不是物件`); return; }
      if (!AFFIX_SCOPES.includes(affix.scope)) { problems.push(`${at}的 scope「${affix.scope}」不是 ${AFFIX_SCOPES.join('、')} 之一`); return; }
      if (affix.scope === 'wearer') problems.push(...validateBonuses([affix]).map(problem => `${at}：${problem}`));
      else if (affix.scope === 'effect') {
        if (!EFFECT_KINDS.includes(affix.kind)) problems.push(`${at}的 kind「${affix.kind}」不是 ${EFFECT_KINDS.join('、')} 之一`);
        if (!(Number.isFinite(affix.value) && affix.value >= 0)) problems.push(`${at}的 value 必須是不小於 0 的有限數字`);
        else if (affix.kind === 'ailmentDuration' && !Number.isInteger(affix.value)) problems.push(`${at}的 ailmentDuration 必須是整數（槽）`);
        if (affix.source !== undefined && typeof affix.source !== 'string') problems.push(`${at}的 source 必須是字串`);
      } else {
        if (typeof affix.kind !== 'string' || !affix.kind) problems.push(`${at}的 kind 必須是非空字串`);
        if (!Number.isFinite(affix.value)) problems.push(`${at}的 value 必須是有限數字`);
        if (affix.source !== undefined && typeof affix.source !== 'string') problems.push(`${at}的 source 必須是字串`);
      }
    });
  }

  if (Array.isArray(item.affixes)) {
    const lines = item.affixes.filter(affix => isObject(affix) && typeof affix.source === 'string' && ENGRAVING_SOURCE.test(affix.source)).length;
    if (lines > ENGRAVINGS_PER_ITEM * LINES_PER_ITEM_ENGRAVING) problems.push(`${where}最多只能有 ${ENGRAVINGS_PER_ITEM} 個刻印（${ENGRAVINGS_PER_ITEM * LINES_PER_ITEM_ENGRAVING} 行刻印詞綴），現在有 ${lines} 行`);
    if (lines && !ENGRAVABLE_ORIGINS.includes(item.origin)) problems.push(`${where}的 origin「${item.origin}」不能有刻印詞綴`);
    const craftLines = item.affixes.filter(affix => isObject(affix) && typeof affix.source === 'string' && affix.source.startsWith('craft:')).length;
    if (craftLines > CRAFT_AFFIX_SLOTS) problems.push(`${where}最多只能有 ${CRAFT_AFFIX_SLOTS} 條製作詞綴，現在有 ${craftLines} 條`);
    if (craftLines && item.origin !== 'craft') problems.push(`${where}的 origin「${item.origin}」不能有製作詞綴`);
  }

  if (item.legendaryId !== undefined) {
    const def = LEGENDARIES[item.legendaryId];
    if (!def) problems.push(`${where}的 legendaryId「${item.legendaryId}」不存在`);
    else if (def.slot !== item.slot) problems.push(`${where}是傳說裝備「${def.name}」，部位必須是 ${def.slot}`);
    if (item.origin !== 'drop') problems.push(`${where}有 legendaryId，origin 必須是 drop`);
    if (!(Number.isInteger(item.tier) && item.tier >= 1 && item.tier <= 5)) problems.push(`${where}是傳說裝備，tier 必須是 1～5 的整數`);
  } else if (item.tier !== undefined) problems.push(`${where}不是傳說裝備，不能有 tier`);
  if (item.materials !== undefined) {
    if (item.origin !== 'craft') problems.push(`${where}不是製作裝備，不能有 materials`);
    else if (!Array.isArray(item.materials) || item.materials.length !== CRAFT_INPUTS || item.materials.some(key => typeof key !== 'string' || !ENGRAVING_KEY.test(key))) {
      problems.push(`${where}的 materials 必須是 ${CRAFT_INPUTS} 個「種類@階級」`);
    }
  }
  if (item.name !== undefined) {
    if (item.origin !== 'craft') problems.push(`${where}不是製作裝備，不能寫 name`);
    else if (!validName(item.name, ITEM_NAME_MAX)) problems.push(`${where}的 name 必須是 1～${ITEM_NAME_MAX} 字、前後沒有空白的字串`);
  }
  if (item.attackStat !== undefined) {
    if (item.slot !== 'weapon') problems.push(`${where}不是武器，不能寫 attackStat`);
    else if (!ATTACK_STATS.includes(item.attackStat)) problems.push(`${where}的 attackStat「${item.attackStat}」不是 ${ATTACK_STATS.join('、')} 之一`);
  }

  if (item.quality !== undefined && !QUALITIES.some(quality => quality.id === item.quality)) {
    problems.push(`${where}的 quality「${item.quality}」不是 ${QUALITIES.map(quality => quality.id).join('、')} 之一`);
  }

  if (!(Number.isInteger(item.castWeight) && item.castWeight >= MIN_WEIGHT && item.castWeight <= MAX_WEIGHT)) {
    problems.push(`${where}的 castWeight 必須是 ${MIN_WEIGHT}～${MAX_WEIGHT} 的整數（收到 ${JSON.stringify(item.castWeight)}）`);
  }

  problems.push(...validateLinks(item.links, where, item));
  return problems;
}

function validateStacks(stacks, where, keyProblem) {
  if (!isObject(stacks)) return [`${where}必須是物件`];
  const problems = [];
  for (const [key, count] of Object.entries(stacks)) {
    const reason = keyProblem(key);
    if (reason) problems.push(`${where}的「${key}」${reason}`);
    if (!isCount(count)) problems.push(`${where}的「${key}」數量必須是 1 以上的整數（收到 ${JSON.stringify(count)}；數量歸零的堆疊要直接移除）`);
  }
  return problems;
}

/**
 * 檢查存檔格式與內容。回傳問題清單；空陣列代表沒問題。一次列出全部問題，不在第一個就停。
 * @param {object} save
 */
function validateSave(save) {
  if (!isObject(save)) return ['存檔必須是物件'];
  const problems = [];
  if (save.version !== SAVE_VERSION) problems.push(`存檔版本是 ${JSON.stringify(save.version)}，這個版本讀得懂的是 ${SAVE_VERSION}`);

  const meta = save.meta;
  if (!isObject(meta)) problems.push('meta 必須是物件');
  else {
    if (!Number.isInteger(meta.nextId) || meta.nextId < 1) problems.push('meta.nextId 必須是 1 以上的整數');
    for (const key of ['gameVersion', 'createdAt', 'savedAt']) {
      if (meta[key] !== null && typeof meta[key] !== 'string') problems.push(`meta.${key} 必須是字串或 null`);
    }
  }

  if (!(Number.isInteger(save.blackDice) && save.blackDice >= 0)) problems.push(`blackDice 必須是不小於 0 的整數（收到 ${JSON.stringify(save.blackDice)}）`);
  if (!(Number.isInteger(save.energy) && save.energy >= 0)) {
    problems.push(`energy 必須是不小於 0 的整數（收到 ${JSON.stringify(save.energy)}）`);
  }

  problems.push(...validateStacks(save.gems, 'gems', id => (isGemId(id) ? null : '不是已知的寶石')));
  if (isObject(save.gems)) {
    for (const [id, count] of Object.entries(save.gems)) if (isActiveGem(id) && count > 1) problems.push(`主動寶石「${id}」是擁有制，數量只能是 1（收到 ${count}）`);
    for (const item of Array.isArray(save.equipment) ? save.equipment : []) {
      for (const link of Array.isArray(item?.links) ? item.links : []) {
        if (isActiveGem(link?.active) && !(save.gems[link.active] > 0)) problems.push(`裝備 ${item.id} 鑲著還沒擁有的主動寶石「${link.active}」`);
      }
    }
  }
  const acc = save.accessories;
  if (!isObject(acc)) problems.push('accessories 必須是物件 { owned, equipped }');
  else {
    if (!Array.isArray(acc.owned)) problems.push('accessories.owned 必須是陣列');
    else {
      for (const id of acc.owned) if (!Object.hasOwn(ACCESSORIES, id)) problems.push(`accessories.owned 有不存在的飾品「${id}」`);
      if (new Set(acc.owned).size !== acc.owned.length) problems.push('accessories.owned 有重複的飾品');
    }
    if (acc.equipped !== null && !(Array.isArray(acc.owned) && acc.owned.includes(acc.equipped))) problems.push(`accessories.equipped「${acc.equipped}」不是擁有的飾品`);
  }
  problems.push(...validateStacks(save.engravings, 'engravings', key => (ENGRAVING_KEY.test(key) ? null : `格式必須是「種類@階級」，階級 ${MIN_TIER}～${MAX_TIER}`)));

  const itemProblems = [];
  const itemsById = new Map();
  if (!Array.isArray(save.equipment)) itemProblems.push('equipment 必須是陣列');
  else {
    save.equipment.forEach((item, index) => {
      itemProblems.push(...validateEquipmentItem(item, `equipment[${index}]`, meta?.nextId ?? 1));
      if (isObject(item) && typeof item.id === 'string') {
        if (itemsById.has(item.id)) itemProblems.push(`equipment[${index}] 的 id「${item.id}」重複`);
        else itemsById.set(item.id, item);
      }
    });
  }
  problems.push(...itemProblems);

  const equippedProblems = [];
  if (!isObject(save.equipped)) equippedProblems.push('equipped 必須是物件');
  else {
    for (const slot of SLOTS) {
      const id = save.equipped[slot];
      if (id === undefined) { equippedProblems.push(`equipped 缺少 ${slot}`); continue; }
      if (id === null) continue;
      const item = itemsById.get(id);
      if (!item) equippedProblems.push(`equipped.${slot} 指向不存在的裝備「${id}」`);
      else if (item.slot !== slot) equippedProblems.push(`equipped.${slot} 放了 ${item.slot} 部位的裝備「${id}」`);
    }
    for (const key of Object.keys(save.equipped)) if (!SLOTS.includes(key)) equippedProblems.push(`equipped 有未知的部位「${key}」`);
  }
  problems.push(...equippedProblems);

  // 穿在身上的所有連結會合併成一份配置去編譯（不同裝備上的技能 id 不能重複），所以要整體試一次。
  if (!itemProblems.length && !equippedProblems.length) {
    const problem = compileProblem(equippedLinks(save));
    if (problem) problems.push(`穿戴中的裝備合併後無法編譯：${problem}`);
  }

  if (!isObject(save.progress)) problems.push('progress 必須是物件');
  else {
    for (const key of PROGRESS_KEYS) {
      const list = save.progress[key];
      if (!Array.isArray(list)) { problems.push(`progress.${key} 必須是陣列`); continue; }
      if (list.some(id => typeof id !== 'string' || !id)) problems.push(`progress.${key} 只能放非空字串`);
      else if (new Set(list).size !== list.length) problems.push(`progress.${key} 有重複的項目`);
    }
  }

  if (!isObject(save.settings)) problems.push('settings 必須是物件');
  else {
    const { difficulty } = save.settings;
    if (!Number.isInteger(difficulty) || difficulty < MIN_DIFFICULTY || difficulty > MAX_DIFFICULTY) {
      problems.push(`settings.difficulty 必須是 ${MIN_DIFFICULTY}～${MAX_DIFFICULTY} 的整數`);
    }
    const { playerName } = save.settings;
    if (playerName !== undefined && !validName(playerName, PLAYER_NAME_MAX)) {
      problems.push(`settings.playerName 必須是 1～${PLAYER_NAME_MAX} 字的非空字串`);
    }
  }
  return problems;
}

// ── 版本遷移 ─────────────────────────────────────────────────

// 舊版本 → 升到下一版的函式。例如存檔結構改成第 2 版時：
//   MIGRATIONS[1] = save => ({ ...save, version: 2, 新欄位: 預設值 });
// 每一步只升一版，必須把 version 設成原本加一；讀檔時會一路升到 SAVE_VERSION。
const MIGRATIONS = {
  // v1 → v2：新增能量槽，舊存檔從 0 開始
  1: save => ({ ...save, version: 2, energy: 0 }),
  // v2 → v3：主動寶石改成擁有制——背包有或鑲在任何裝備上的主動寶石都記成擁有 1 顆
  2: save => {
    const gems = { ...save.gems };
    const owned = new Set(Object.keys(gems).filter(id => isActiveGem(id) && gems[id] > 0));
    for (const item of save.equipment ?? []) for (const link of item.links ?? []) if (isActiveGem(link.active)) owned.add(link.active);
    for (const id of owned) gems[id] = 1;
    return { ...save, version: 3, gems };
  },
  // v3 → v4：移除擴散（wide，使用者決定直接刪除、不換成別顆）——背包裡的、鑲在裝備上的都刪掉。
  // 寫死 id 是刻意的：這一步只描述「v4 移除了哪些寶石」，之後再移除別顆要另寫一步。
  3: save => ({ ...dropRemovedGems(save, ['wide']), version: 4 }),
  // v4 → v5：移除乘勢（oncrit，2026-11-19 使用者決定；Artifact 版上線過約兩小時，存檔裡可能有）。
  4: save => ({ ...dropRemovedGems(save, ['oncrit']), version: 5 }),
  // v5 → v6：守門者的首次擊敗獎勵加了火焰風暴（2026-11-19）；已經打贏過的存檔補發一顆（沒有的才補）。
  5: save => {
    const gems = { ...(save.gems ?? {}) };
    if ((save.progress?.defeatedBosses ?? []).includes('gatekeeper') && !gems.firestorm) gems.firestorm = 1;
    return { ...save, version: 6, gems };
  },
  // v6 → v7：加回飾品欄（2026-11-20）。給開局飾品並穿上；打贏過守門者的補發 hourglass（「烈風爪痕」的碎片）。
  // 製作詞綴「異常持續時間」移到飾品：舊裝備上的這條依當初投入的刻印改擲成目前的製作詞綴（亂數以裝備 id 當種子，結果固定）。
  6: save => {
    const owned = ['focus'];
    if ((save.progress?.defeatedBosses ?? []).includes('gatekeeper')) owned.push('hourglass');
    const equipment = (save.equipment ?? []).map(item => {
      if (!(item.affixes ?? []).some(affix => affix.source === 'craft:ailmentDuration')) return item;
      const rng = createSeededRandom(7000 + Number(String(item.id).replace(/\D/g, '') || 0));
      const [replacement] = rerollCraftAffixes(item.materials, rng);
      return { ...item, affixes: item.affixes.map(affix => (affix.source === 'craft:ailmentDuration' ? replacement : affix)) };
    });
    return { ...save, version: 7, equipment, accessories: { owned, equipped: 'focus' } };
  },
  // v7 → v8：黑骰（2026-11-20）。加 blackDice: 0；傳說裝備補記掉落階級 tier（從數值反推，黑骰重置時沿用）。
  7: save => ({
    ...save, version: 8, blackDice: 0,
    equipment: (save.equipment ?? []).map(item => (item.legendaryId !== undefined && LEGENDARIES[item.legendaryId] && item.tier === undefined
      ? { ...item, tier: inferLegendaryTier(item) } : item))
  }),
  // v8 → v9：第二區「和聲音樂廳」（2026-11-21）由中央廳首次擊敗開放；已經打贏過的存檔補開。
  8: save => {
    const progress = { ...save.progress, unlockedRegions: [...(save.progress?.unlockedRegions ?? [])] };
    if ((progress.defeatedBosses ?? []).includes('gatekeeper') && !progress.unlockedRegions.includes('hall')) progress.unlockedRegions.push('hall');
    return { ...save, version: 9, progress };
  },
  // v9 → v10：氣鳴楯【菲爾查哈】、撥弦槍【鶴之聲援】改版（2026-11-21 晚，行數變了）。舊的照原本的骰值比例重擲新的每一行，
  // 比例從舊的第一行基底反推（菲爾查哈攻擊上限 372、鶴之聲援智力上限 319）。
  9: save => ({
    ...save, version: 10,
    equipment: (save.equipment ?? []).map(item => {
      const oldMax = { fircha: 372, cranelance: 319 }[item.legendaryId];
      if (!oldMax || !TIER_SCALE[item.tier] || item.base?.length !== 1) return item;
      const ratio = (item.base[0]?.value ?? 0) / (oldMax * TIER_SCALE[item.tier]);
      const roll = Math.min(1, Math.max(0, (ratio - ROLL_MIN) / (1 - ROLL_MIN)));
      return { ...item, ...rerollLegendaryValues(item, () => roll) };
    })
  })
};

/** 從背包與所有裝備連結裡刪掉指定的輔助寶石（遷移用；不改傳入的物件）。 */
function dropRemovedGems(save, ids) {
  const removed = new Set(ids);
  const gems = Object.fromEntries(Object.entries(save.gems ?? {}).filter(([id]) => !removed.has(id)));
  const equipment = (save.equipment ?? []).map(item => ({
    ...item,
    links: (item.links ?? []).map(link => ({ ...link, supports: (link.supports ?? []).filter(id => !removed.has(id)) }))
  }));
  return { ...save, gems, equipment };
}

function migrateSave(raw, migrations = MIGRATIONS, target = SAVE_VERSION) {
  if (!isObject(raw)) throw new SaveError('存檔必須是物件');
  let save = structuredClone(raw);
  if (!Number.isInteger(save.version) || save.version < 1) throw new SaveError(`存檔的版本號不正確（${JSON.stringify(save.version)}）`);
  if (save.version > target) throw new SaveError(`這份存檔的版本是 ${save.version}，比目前遊戲讀得懂的 ${target} 新，請更新遊戲`);
  while (save.version < target) {
    const step = migrations[save.version];
    if (typeof step !== 'function') throw new SaveError(`找不到從存檔版本 ${save.version} 升級的方法`);
    const next = step(save);
    if (!isObject(next) || next.version !== save.version + 1) throw new SaveError(`存檔版本 ${save.version} 的升級函式沒有把 version 設成 ${save.version + 1}`);
    save = next;
  }
  return save;
}

// ── 匯出／匯入 ───────────────────────────────────────────────

/** 轉成 JSON 文字（給玩家備份）。不合法的存檔不給匯出。 */
function exportSave(save) {
  const problems = validateSave(save);
  if (problems.length) throw new SaveError('存檔不合法，無法匯出', problems);
  return JSON.stringify(save, null, 2);
}

/** 解析 JSON 文字、升級到目前版本、驗證。任何一步失敗都丟 SaveError，不會回傳半成品。 */
function importSave(text, migrations = MIGRATIONS) {
  let raw;
  try { raw = JSON.parse(text); } catch (error) { throw new SaveError('存檔不是有效的 JSON', [error.message]); }
  const save = migrateSave(raw, migrations);
  const problems = validateSave(save);
  if (problems.length) throw new SaveError('存檔內容有問題', problems);
  return save;
}

// ── 背包操作（回傳新存檔，失敗丟 SaveError，原存檔不變）──────────

function mutate(save, change) {
  const draft = structuredClone(save);
  const result = change(draft);
  const problems = validateSave(draft);
  if (problems.length) throw new SaveError('操作後的存檔不合法', problems);
  return result === undefined ? draft : { save: draft, ...result };
}

function stackKey(type, tier) {
  if (typeof type !== 'string' || !ENGRAVING_TYPE.test(type)) throw new SaveError(`刻印種類「${type}」格式不正確（英數字與底線，開頭是英文字母）`);
  if (!Number.isInteger(tier) || tier < MIN_TIER || tier > MAX_TIER) throw new SaveError(`刻印階級必須是 ${MIN_TIER}～${MAX_TIER} 的整數（收到 ${tier}）`);
  return `${type}@${tier}`;
}

function requireCount(count) {
  if (!isCount(count)) throw new SaveError(`數量必須是 1 以上的整數（收到 ${count}）`);
}

function addToStack(stacks, key, count) {
  stacks[key] = (stacks[key] ?? 0) + count;
}

function takeFromStack(stacks, key, count, label) {
  const have = stacks[key] ?? 0;
  if (have < count) throw new SaveError(`${label}不夠：需要 ${count}，只有 ${have}`);
  if (have === count) delete stacks[key]; else stacks[key] = have - count;
}

function requireGem(gemId) {
  if (!isGemId(gemId)) throw new SaveError(`「${gemId}」不是已知的寶石`);
}

/** 放進背包：主動寶石是擁有制，拿到幾顆都只記成擁有（1）。 */
function giveGem(draft, gemId, count) {
  if (isActiveGem(gemId)) draft.gems[gemId] = 1;
  else addToStack(draft.gems, gemId, count);
}

function addGems(save, gemId, count = 1) {
  requireCount(count);
  requireGem(gemId);
  return mutate(save, draft => giveGem(draft, gemId, count));
}

function removeGems(save, gemId, count = 1) {
  requireCount(count);
  requireGem(gemId);
  return mutate(save, draft => takeFromStack(draft.gems, gemId, count, `寶石「${gemId}」`));
}

/** 寶石轉換一次要投入幾顆輔助寶石（使用者 2026-11-19：重複寶石的用途，3 換 1）。 */
const GEM_CONVERT_INPUTS = 3;
const BLACK_DICE_PER_SALVAGE = 1;   // 分解一件傳說裝備得到的黑骰（使用者，2026-11-20）
const BLACK_DICE_REROLL_COST = 1;   // 重置一次消耗的黑骰

/**
 * 寶石轉換：投入 GEM_CONVERT_INPUTS 顆輔助寶石（可以同種、可以混），換 1 顆輔助寶石。
 * 給的種類從「還沒有的種類」平均抽（背包裡 0 顆、也沒鑲在任何裝備上）；全部都有時，從投入以外的種類抽；
 * 投入涵蓋所有種類時才從全部種類抽。只用 1 個亂數。回傳 { save, gemId, fromMissing }。
 */
function convertGems(save, gemIds, rng = Math.random) {
  if (!Array.isArray(gemIds) || gemIds.length !== GEM_CONVERT_INPUTS) throw new SaveError(`寶石轉換要投入 ${GEM_CONVERT_INPUTS} 顆輔助寶石`);
  for (const id of gemIds) {
    requireGem(id);
    if (!Object.hasOwn(SUPPORT_GEMS, id)) throw new SaveError(`「${id}」是主動寶石，不能拿來轉換`);
  }
  const need = {};
  for (const id of gemIds) need[id] = (need[id] ?? 0) + 1;
  const socketed = {};
  for (const item of save.equipment ?? []) for (const link of item.links ?? []) for (const id of link.supports ?? []) socketed[id] = (socketed[id] ?? 0) + 1;
  // 區域（2026-11-20 使用者）：第一區的寶石都會出；其他區的寶石要玩家已經有那一區的寶石（背包或鑲著）才會出
  const ownedAreas = new Set([1]);
  for (const id of Object.keys(SUPPORT_GEMS)) if (save.gems?.[id] > 0 || socketed[id] > 0) ownedAreas.add(SUPPORT_GEMS[id].area ?? 1);
  const all = Object.keys(SUPPORT_GEMS).filter(id => ownedAreas.has(SUPPORT_GEMS[id].area ?? 1));
  const missing = all.filter(id => !(save.gems?.[id] > 0) && !(socketed[id] > 0));
  const notInput = all.filter(id => !need[id]);
  const pool = missing.length ? missing : notInput.length ? notInput : all;
  const gemId = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  return mutate(save, draft => {
    for (const [id, count] of Object.entries(need)) takeFromStack(draft.gems, id, count, `寶石「${id}」`);
    addToStack(draft.gems, gemId, 1);
    return { gemId, fromMissing: missing.length > 0 };
  });
}

function addEngraving(save, type, tier, count = 1) {
  requireCount(count);
  const key = stackKey(type, tier);
  return mutate(save, draft => addToStack(draft.engravings, key, count));
}

function removeEngraving(save, type, tier, count = 1) {
  requireCount(count);
  const key = stackKey(type, tier);
  return mutate(save, draft => takeFromStack(draft.engravings, key, count, `刻印「${key}」`));
}

/**
 * 合成刻印：從背包扣掉 3 顆同階刻印，加入 1 顆高一階的刻印（規則見 affixTable.js 的 rollCombine）。
 * 背包不夠、種類不存在、階級是最高階都丟 SaveError，原存檔不變。回傳 { save, type, tier, mode }。
 * @param {string[]} types 剛好 3 個刻印種類，可重複（['fury', 'fury', 'fury'] 是同種合成）
 * @param {number} tier 投入的階級（三顆同階）
 * @param {() => number} [rng] 只有不同種合成會用到
 * @param {{ pool?: string[] }} [options] 不同種合成的抽取池（預設全部種類）
 */
function combineEngravings(save, types, tier, rng = Math.random, { pool } = {}) {
  if (!Array.isArray(types)) throw new SaveError('合成的刻印必須是陣列');
  const keys = types.map(type => stackKey(type, tier));
  let result;
  try {
    result = rollCombine(types, tier, rng, pool);
  } catch (error) {
    throw new SaveError(error.message);
  }
  const need = {};
  for (const key of keys) need[key] = (need[key] ?? 0) + 1;
  return mutate(save, draft => {
    for (const [key, count] of Object.entries(need)) takeFromStack(draft.engravings, key, count, `刻印「${key}」`);
    addToStack(draft.engravings, stackKey(result.type, result.tier), 1);
    return result;
  });
}

/**
 * 批量合成（2026-11-20 使用者）：把背包裡某種某階的刻印全部同種合成，每 3 顆換 1 顆高一階；湊不滿 3 顆的留著。
 * 例：14 顆第 1 階猛攻 → 4 顆第 2 階猛攻，剩 2 顆第 1 階。不用亂數。
 * 少於 3 顆、第 5 階、種類不存在丟 SaveError，原存檔不變。回傳 { save, type, tier（產出的階級）, made, used, left }。
 */
function combineAllEngravings(save, type, tier) {
  try { rollCombine([type, type, type], tier); } catch (error) { throw new SaveError(error.message); }
  const key = stackKey(type, tier);
  const have = save.engravings?.[key] ?? 0;
  const made = Math.floor(have / COMBINE_INPUTS);
  if (made < 1) throw new SaveError(`刻印「${key}」不到 ${COMBINE_INPUTS} 顆，不能合成`);
  return mutate(save, draft => {
    takeFromStack(draft.engravings, key, made * COMBINE_INPUTS, `刻印「${key}」`);
    addToStack(draft.engravings, stackKey(type, tier + 1), made);
    return { type, tier: tier + 1, made, used: made * COMBINE_INPUTS, left: have - made * COMBINE_INPUTS };
  });
}

/**
 * 把一場的掉落（dropTable.rollDrops 的結果）放進背包：刻印、輔助寶石、傳說裝備，以及能量（沒有上限）。
 * 傳說裝備（drops.legendary 件）從 legendaryTable 平均抽、依掉落難度縮放，所以有傳說裝備時**一定要傳 difficulty**，
 * 沒傳會丟錯（不會默默丟掉玩家的掉落）。內容不合法丟 SaveError，原存檔不變。
 * @param {{ difficulty?: number, rng?: () => number }} [options] rng 只用在傳說裝備（每件：抽種類 1 次，再照 rollLegendary 的順序）
 */
function grantDrops(save, drops, { difficulty, rng = Math.random, area = drops?.area ?? 1 } = {}) {
  if (!isObject(drops)) throw new SaveError('掉落必須是物件');
  const { engravings = [], supportGems = [] } = drops;
  if (!Array.isArray(engravings) || !Array.isArray(supportGems)) throw new SaveError('掉落的 engravings 與 supportGems 必須是陣列');
  const keys = engravings.map(entry => stackKey(entry?.type, entry?.tier));
  supportGems.forEach(requireGem);
  const energyGain = drops.energy ?? 0;
  if (!(Number.isInteger(energyGain) && energyGain >= 0)) throw new SaveError('掉落的 energy 必須是不小於 0 的整數');
  const legendaryCount = drops.legendary ?? 0;
  if (!(Number.isInteger(legendaryCount) && legendaryCount >= 0)) throw new SaveError('掉落的 legendary 必須是不小於 0 的整數');
  const legendaries = [];
  for (let i = 0; i < legendaryCount; i++) {
    if (difficulty === undefined) throw new SaveError('掉落裡有傳說裝備，grantDrops 必須傳 { difficulty } 才能決定數值');
    try { legendaries.push(rollLegendary(pickLegendary(rng, area), difficulty, rng)); } catch (error) { throw new SaveError(error.message); }
  }
  return mutate(save, draft => {
    for (const key of keys) addToStack(draft.engravings, key, 1);
    for (const gemId of supportGems) addToStack(draft.gems, gemId, 1);
    for (const item of legendaries) draft.equipment.push({ id: `eq${draft.meta.nextId++}`, ...item, links: [] });
    draft.energy = addEnergy(draft.energy, energyGain).energy;
  });
}

/**
 * 加入一件指定的傳說裝備（測試、王的獎勵等用）；數值依 difficulty 縮放。回傳 { save, id }。
 */
function addLegendary(save, legendaryId, difficulty, rng = Math.random) {
  let item;
  try { item = rollLegendary(legendaryId, difficulty, rng); } catch (error) { throw new SaveError(error.message); }
  return mutate(save, draft => {
    const id = `eq${draft.meta.nextId++}`;
    draft.equipment.push({ id, ...item, links: [] });
    return { id };
  });
}

/**
 * 製作裝備：從背包扣掉 10 個刻印（種類與階級可混），產生一件 origin 'craft' 的裝備（規則見 craftTable.js）。
 * 回傳 { save, id, quality }。背包不夠、刻印不存在、部位不對都丟 SaveError，原存檔不變。
 * 裝備帶 1 條製作詞綴（craftTable.CRAFT_AFFIXES），之後還能另外刻 2 個刻印。
 * @param {string} slot weapon／helmet／armor／boots
 * @param {{ type: string, tier: number }[]} engravings 剛好 10 個
 * @param {() => number} [rng]
 * @param {{ attackStat?: 'atk'|'int', name?: string }} [options] attackStat：武器的普攻屬性（玩家製作時選，預設 atk）；其他部位不能寫。
 *   name：玩家取的名字（去掉前後空白；空的就不存，顯示時用部位名；超過 ITEM_NAME_MAX 字丟 SaveError）
 */
function craftEquipment(save, slot, engravings, rng = Math.random, { attackStat, name } = {}) {
  if (!SLOTS.includes(slot)) throw new SaveError(`部位「${slot}」不是 ${SLOTS.join('、')} 之一`);
  if (attackStat !== undefined && slot !== 'weapon') throw new SaveError('只有武器能選普攻屬性（attackStat）');
  if (attackStat !== undefined && !ATTACK_STATS.includes(attackStat)) throw new SaveError(`普攻屬性必須是 ${ATTACK_STATS.join('、')} 之一`);
  if (name !== undefined && typeof name !== 'string') throw new SaveError('裝備名字必須是字串');
  const itemName = (name ?? '').trim();
  if ([...itemName].length > ITEM_NAME_MAX) throw new SaveError(`裝備名字最多 ${ITEM_NAME_MAX} 個字`);
  if (!Array.isArray(engravings)) throw new SaveError('製作的刻印必須是陣列');
  const keys = engravings.map(entry => stackKey(entry?.type, entry?.tier));
  let crafted;
  try {
    crafted = rollCraft(slot, engravings, rng);
  } catch (error) {
    throw new SaveError(error.message);
  }
  const need = {};
  for (const key of keys) need[key] = (need[key] ?? 0) + 1;
  return mutate(save, draft => {
    for (const [key, count] of Object.entries(need)) takeFromStack(draft.engravings, key, count, `刻印「${key}」`);
    const id = `eq${draft.meta.nextId++}`;
    draft.equipment.push({ id, slot, origin: 'craft', base: crafted.base, affixes: crafted.affixes, castWeight: crafted.castWeight, quality: crafted.quality,
      ...(slot === 'weapon' ? { attackStat: attackStat ?? 'atk' } : {}), ...(itemName ? { name: itemName } : {}), materials: keys, links: [] });
    return { id, quality: crafted.quality };
  });
}

/**
 * 一件裝備上已刻的刻印（「種類@階級」，依刻上去的順序）。由詞綴的 source（engraving:種類@階級）推得，
 * 每個刻印固定 2 行，所以不用另外存欄位。
 */
function itemEngravings(item) {
  const keys = (item?.affixes ?? []).map(affix => ENGRAVING_SOURCE.exec(affix?.source ?? '')?.[1]).filter(Boolean);
  const result = [];
  for (let i = 0; i < keys.length; i += LINES_PER_ITEM_ENGRAVING) result.push(keys[i]);
  return result;
}

/**
 * 把背包裡的 1 個刻印刻到現有裝備上：扣 1 個刻印，擲出 2 行詞綴（3 取 2，數值隨機，見 affixTable.rollEngraving）加到裝備的 affixes 後面。
 * 每件最多 ENGRAVINGS_PER_ITEM（2）個，可以是同一種；**已刻的不能覆蓋**（清除重刻尚未決定）。
 * 只有 ENGRAVABLE_ORIGINS（製作裝備）能刻；刻印要符合部位限制（affixTable.ENGRAVING_SLOTS）；穿戴中、鑲著寶石的裝備也能刻。
 * 回傳 { save, affixes（這次新增的行）}；失敗丟 SaveError，原存檔不變。
 */
function engraveEquipment(save, id, type, tier, rng = Math.random) {
  const key = stackKey(type, tier);
  return mutate(save, draft => {
    const item = findItem(draft, id);
    if (!ENGRAVABLE_ORIGINS.includes(item.origin)) throw new SaveError(`裝備「${id}」是${item.origin === 'drop' ? '掉落的傳說裝備' : `「${item.origin}」裝備`}，不能刻刻印`);
    if (ENGRAVING_TYPES[type] && !canEngrave(type, item.slot)) {
      throw new SaveError(`「${ENGRAVING_TYPES[type].name}」刻印不能刻在${SLOT_NAMES[item.slot] ?? item.slot}上`);
    }
    const current = itemEngravings(item);
    if (current.length >= ENGRAVINGS_PER_ITEM) throw new SaveError(`裝備「${id}」已經有 ${ENGRAVINGS_PER_ITEM} 個刻印（${current.join('、')}），不能再刻`);
    takeFromStack(draft.engravings, key, 1, `刻印「${key}」`);
    let lines;
    try {
      lines = rollEngraving(type, tier, rng);
    } catch (error) {
      throw new SaveError(error.message);
    }
    item.affixes.push(...lines);
    return { affixes: structuredClone(lines) };
  });
}

/**
 * 分解一件製作裝備：從它的 materials（當初投入的 10 個刻印）隨機退回 SALVAGE_RETURN 個到背包，
 * 鑲著的寶石退回背包、穿著的脫下，裝備消失。用在品質做壞、或用不到的製作裝備。
 * 傳說裝備與沒有 materials 的裝備不能分解（丟 SaveError，原存檔不變）。回傳 { save, returned: ['fury@5', …] }。
 */
function salvageEquipment(save, id, rng = Math.random) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    // 傳說裝備可以分解（2026-11-20 使用者）：得 1 顆黑骰，鑲著的寶石退回背包。
    if (item.legendaryId !== undefined) {
      for (const [gemId, count] of Object.entries(linkGemCounts(item.links))) addToStack(draft.gems, gemId, count);
      for (const slot of SLOTS) if (draft.equipped[slot] === id) draft.equipped[slot] = null;
      draft.equipment = draft.equipment.filter(entry => entry.id !== id);
      draft.blackDice += BLACK_DICE_PER_SALVAGE;
      return { returned: [], legendary: true, blackDice: BLACK_DICE_PER_SALVAGE };
    }
    if (item.origin !== 'craft' || !Array.isArray(item.materials)) throw new SaveError(`裝備「${id}」不是製作裝備或傳說裝備，不能分解`);
    const pool = [...item.materials];
    const returned = [];
    for (let i = 0; i < Math.min(SALVAGE_RETURN, pool.length); i++) {
      const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
      returned.push(pool.splice(index, 1)[0]);
    }
    for (const key of returned) addToStack(draft.engravings, key, 1);
    for (const [gemId, count] of Object.entries(linkGemCounts(item.links))) addToStack(draft.gems, gemId, count);
    for (const slot of SLOTS) if (draft.equipped[slot] === id) draft.equipped[slot] = null;
    draft.equipment = draft.equipment.filter(entry => entry.id !== id);
    return { returned };
  });
}

/**
 * 黑骰：消耗 1 顆，依裝備記的掉落階級重擲一件傳說裝備的所有數值（基礎與特殊詞綴；施放權重、鑲的寶石不變）。
 * 回傳 { save, before: { base, affixes }, after: { base, affixes } }。不是傳說裝備、黑骰不夠丟 SaveError，原存檔不變。
 */
function rerollLegendary(save, id, rng = Math.random) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    if (item.legendaryId === undefined) throw new SaveError(`裝備「${id}」不是傳說裝備，不能用黑骰`);
    if (draft.blackDice < BLACK_DICE_REROLL_COST) throw new SaveError(`黑骰不足：重置要 ${BLACK_DICE_REROLL_COST} 顆，目前有 ${draft.blackDice} 顆`);
    const before = { base: structuredClone(item.base), affixes: structuredClone(item.affixes) };
    const after = rerollLegendaryValues(item, rng);
    item.base = after.base;
    item.affixes = after.affixes;
    draft.blackDice -= BLACK_DICE_REROLL_COST;
    return { before, after: structuredClone(after) };
  });
}

/**
 * 黑骰重骰製作詞綴（2026-11-20 使用者）：消耗 1 顆黑骰，照製作時投入的刻印階級重擲製作詞綴。
 *   lockKind: false → 種類與數值一起重抽；true → 種類不變、只重擲數值，另外消耗 CRAFT_REROLL_LOCK_ENERGY 能量。
 * 只有製作裝備能用；黑骰或能量不夠丟 SaveError，原存檔不變。回傳 { save, before, after, energyCost }（before／after 是製作詞綴陣列）。
 */
function rerollCraftAffix(save, id, { lockKind = false } = {}, rng = Math.random) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    if (item.origin !== 'craft') throw new SaveError(`裝備「${id}」不是製作裝備，沒有製作詞綴`);
    const positions = item.affixes.map((affix, i) => (String(affix.source ?? '').startsWith('craft:') ? i : -1)).filter(i => i >= 0);
    if (!positions.length) throw new SaveError(`裝備「${id}」沒有製作詞綴`);
    if (draft.blackDice < BLACK_DICE_REROLL_COST) throw new SaveError(`黑骰不足：重骰要 ${BLACK_DICE_REROLL_COST} 顆，目前有 ${draft.blackDice} 顆`);
    const energyCost = lockKind ? CRAFT_REROLL_LOCK_ENERGY : 0;
    if (draft.energy < energyCost) throw new SaveError(`能量不足：鎖定種類要 ${energyCost}，目前只有 ${draft.energy}`);
    const before = positions.map(i => structuredClone(item.affixes[i]));
    const after = positions.map(i => rerollCraftAffixes(item.materials, rng, { lockKind: lockKind ? item.affixes[i].kind : null })[0]);
    positions.forEach((pos, k) => { item.affixes[pos] = after[k]; });
    draft.blackDice -= BLACK_DICE_REROLL_COST;
    draft.energy -= energyCost;
    return { before, after: structuredClone(after), energyCost };
  });
}

/**
 * 轉移刻印（2026-11-20 使用者）：把一件裝備的第 index 個刻印（連同擲出的數值）移到另一件**同部位**的可刻印裝備，固定花 TRANSFER_ENERGY。
 * 目標已刻滿時必須指定 replaceIndex：先清除目標的那個刻印（另外花它的 CLEAR_COST，刻印不退回）再轉移；沒指定就丟 SaveError。
 * 傳說裝備（不能刻刻印）不能當來源或目標。回傳 { save, moved, replaced, cost }。
 */
function transferEngraving(save, fromId, index, toId, { replaceIndex = null } = {}) {
  return mutate(save, draft => {
    if (fromId === toId) throw new SaveError('來源和目標是同一件裝備');
    const from = findItem(draft, fromId);
    const to = findItem(draft, toId);
    for (const item of [from, to]) if (!ENGRAVABLE_ORIGINS.includes(item.origin)) throw new SaveError(`裝備「${item.id}」不能刻刻印，不能轉移`);
    if (from.slot !== to.slot) throw new SaveError(`只能轉移到相同部位的裝備（${SLOT_NAMES[from.slot]} → ${SLOT_NAMES[to.slot]}）`);
    const groups = item => {
      const positions = item.affixes.map((affix, i) => (ENGRAVING_SOURCE.test(affix?.source ?? '') ? i : -1)).filter(i => i >= 0);
      return Array.from({ length: positions.length / LINES_PER_ITEM_ENGRAVING }, (_, g) => positions.slice(g * LINES_PER_ITEM_ENGRAVING, (g + 1) * LINES_PER_ITEM_ENGRAVING));
    };
    const fromGroups = groups(from);
    if (!Number.isInteger(index) || index < 0 || index >= fromGroups.length) throw new SaveError(`刻印位置必須是 0～${fromGroups.length - 1} 的整數（收到 ${index}）`);
    const toKeys = itemEngravings(to);
    let cost = TRANSFER_ENERGY;
    let replaced = null;
    if (toKeys.length >= ENGRAVINGS_PER_ITEM) {
      if (!(Number.isInteger(replaceIndex) && replaceIndex >= 0 && replaceIndex < toKeys.length)) {
        throw new SaveError(`目標裝備已經有 ${ENGRAVINGS_PER_ITEM} 個刻印，要指定清除哪一個才能轉移`);
      }
      replaced = toKeys[replaceIndex];
      cost += CLEAR_COST[Number(replaced.split('@')[1])];
    }
    if (draft.energy < cost) throw new SaveError(`能量不足：轉移要 ${cost}，目前只有 ${draft.energy}`);
    const moving = fromGroups[index];
    const moved = itemEngravings(from)[index];
    const lines = moving.map(i => from.affixes[i]);
    from.affixes = from.affixes.filter((_, i) => !moving.includes(i));
    if (replaced !== null) {
      const drop = groups(to)[replaceIndex];
      to.affixes = to.affixes.filter((_, i) => !drop.includes(i));
    }
    to.affixes.push(...lines);
    draft.energy -= cost;
    return { moved, replaced, cost };
  });
}

/**
 * 分解背包裡的刻印換能量：每個第 t 階給 energyTable.SALVAGE_ENERGY[t]（能量沒有上限；回傳的 wasted 永遠是 0）。
 * 背包不夠、格式不對丟 SaveError，原存檔不變。回傳 { save, gained, wasted }。
 */
function salvageEngravings(save, type, tier, count = 1) {
  const key = stackKey(type, tier);
  if (!Number.isInteger(count) || count < 1) throw new SaveError(`分解數量必須是 1 以上的整數（收到 ${count}）`);
  return mutate(save, draft => {
    takeFromStack(draft.engravings, key, count, `刻印「${key}」`);
    const result = addEnergy(draft.energy, SALVAGE_ENERGY[tier] * count);
    draft.energy = result.energy;
    return { gained: result.gained, wasted: result.wasted };
  });
}

/**
 * 清除裝備上的一個刻印：移除那個刻印的 2 行詞綴，空出位置可以再刻。被清掉的刻印**不會退回背包**。
 * index 是 itemEngravings(item) 的位置（0 = 先刻的、1 = 後刻的）；另一個刻印與製作詞綴不受影響，順序不變。
 * 代價：消耗能量，依被清除刻印的階級（energyTable.CLEAR_COST）；能量不夠就失敗。
 * 回傳 { save, removed: '種類@階級', affixes: 被移除的詞綴, cost }；失敗丟 SaveError，原存檔不變。
 */
function clearEngraving(save, id, index) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    const current = itemEngravings(item);
    if (!current.length) throw new SaveError(`裝備「${id}」沒有刻印可以清除`);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
      throw new SaveError(`刻印位置必須是 0～${current.length - 1} 的整數（收到 ${index}）`);
    }
    // 刻印的詞綴依刻上去的順序排列、每個固定 LINES_PER_ITEM_ENGRAVING 行，所以第 index 個刻印是第 index 組。
    const positions = item.affixes
      .map((affix, position) => (ENGRAVING_SOURCE.test(affix?.source ?? '') ? position : -1))
      .filter(position => position >= 0)
      .slice(index * LINES_PER_ITEM_ENGRAVING, (index + 1) * LINES_PER_ITEM_ENGRAVING);
    const tier = Number(current[index].split('@')[1]);
    const cost = CLEAR_COST[tier];
    if (draft.energy < cost) throw new SaveError(`能量不足：清除第 ${tier} 階刻印要 ${cost}，目前只有 ${draft.energy}`);
    draft.energy -= cost;
    const removed = positions.map(position => item.affixes[position]);
    item.affixes = item.affixes.filter((_, position) => !positions.includes(position));
    return { removed: current[index], affixes: structuredClone(removed), cost };
  });
}

/**
 * 新增一件裝備並配發 id。新裝備不帶寶石（links 必須是空的）：寶石要用 setLinks 從背包鑲上去，
 * 才不會憑空多出寶石。回傳 { save, id }。
 * @param {object} item { slot, origin, base, affixes, castWeight? }（不要自己寫 id；castWeight 沒寫就是 DEFAULT_WEIGHT）
 */
function addEquipment(save, item) {
  if (!isObject(item)) throw new SaveError('裝備必須是物件');
  if (item.id !== undefined) throw new SaveError('新裝備不能自己指定 id，id 由存檔配發');
  if (item.links !== undefined && (!Array.isArray(item.links) || item.links.length)) throw new SaveError('新裝備不能帶寶石，請用 setLinks 從背包鑲上去');
  return mutate(save, draft => {
    const id = `eq${draft.meta.nextId++}`;
    draft.equipment.push({ ...structuredClone(item), id, castWeight: item.castWeight === undefined ? DEFAULT_WEIGHT : item.castWeight, links: [] });
    return { id };
  });
}

function findItem(draft, id) {
  const item = draft.equipment.find(entry => entry.id === id);
  if (!item) throw new SaveError(`找不到裝備「${id}」`);
  return item;
}

/** 連結會佔用背包的寶石數量：只算輔助寶石（主動寶石是擁有制，不扣背包）。 */
function linkGemCounts(links) {
  const counts = {};
  for (const link of links) {
    for (const support of link.supports ?? []) addToStack(counts, support, 1);
  }
  return counts;
}

/** 刪除裝備（穿著的會先脫下）。鑲在上面的寶石回到背包。 */
function removeEquipment(save, id) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    for (const [gemId, count] of Object.entries(linkGemCounts(item.links))) addToStack(draft.gems, gemId, count);
    for (const slot of SLOTS) if (draft.equipped[slot] === id) draft.equipped[slot] = null;
    draft.equipment = draft.equipment.filter(entry => entry.id !== id);
  });
}

/**
 * 重設一件裝備上的寶石連結。舊連結的寶石先退回背包，再從背包扣新連結要的寶石，所以背包不夠就失敗。
 * 連結不合法（互斥、技能重複、超過槽數）時也會失敗。只動寶石，不會動裝備的 castWeight。
 * @param {{ active: string, supports?: string[] }[]} links
 */
function setLinks(save, id, links) {
  if (!Array.isArray(links)) throw new SaveError('links 必須是陣列');
  const shapeProblems = validateLinks(links, '新的連結', findItem(save, id));
  if (shapeProblems.length) throw new SaveError('連結不合法', shapeProblems);
  for (const link of links) {
    if (isActiveGem(link?.active) && !(save.gems[link.active] > 0)) throw new SaveError(`還沒有主動寶石「${link.active}」`);
  }
  return mutate(save, draft => {
    const item = findItem(draft, id);
    for (const [gemId, count] of Object.entries(linkGemCounts(item.links))) addToStack(draft.gems, gemId, count);
    const next = normalizeLinks(links);
    for (const [gemId, count] of Object.entries(linkGemCounts(next))) takeFromStack(draft.gems, gemId, count, `背包的寶石「${gemId}」`);
    item.links = next;
  });
}

// 換下的裝備自動卸下寶石（使用者決定）：寶石退回背包、連結清空，不會卡在沒穿的裝備上。
function releaseLinks(draft, itemId) {
  const item = itemId ? draft.equipment.find(x => x.id === itemId) : null;
  if (!item || !item.links?.length) return;
  for (const [gemId, count] of Object.entries(linkGemCounts(item.links))) addToStack(draft.gems, gemId, count);
  item.links = [];
}

/** 穿上：同部位原本穿著的那件換下，它的寶石退回背包。 */
function equip(save, id) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    const previous = draft.equipped[item.slot];
    if (previous && previous !== id) releaseLinks(draft, previous);
    draft.equipped[item.slot] = id;
  });
}

/** 穿上飾品（只有 1 個飾品欄；換上新的會取代原本的）。id 是 null 就脫下。沒擁有的丟 SaveError。 */
function equipAccessory(save, id) {
  if (id !== null && !save.accessories?.owned?.includes(id)) throw new SaveError(`還沒有${ACCESSORIES[id]?.name ?? `「${id}」`}`);
  return mutate(save, draft => { draft.accessories.equipped = id; });
}

/** 給一個飾品（測試、工具用；已經有就不變）。 */
function addAccessory(save, id) {
  if (!Object.hasOwn(ACCESSORIES, id)) throw new SaveError(`飾品「${id}」不存在`);
  return mutate(save, draft => { if (!draft.accessories.owned.includes(id)) draft.accessories.owned.push(id); });
}

/** 脫下：寶石退回背包。 */
function unequip(save, slot) {
  if (!SLOTS.includes(slot)) throw new SaveError(`未知的部位「${slot}」`);
  return mutate(save, draft => { releaseLinks(draft, draft.equipped[slot]); draft.equipped[slot] = null; });
}

/** 舊存檔整理：沒穿著的裝備上還鑲著的寶石全部退回背包（讀檔後呼叫；沒有要整理的就回傳原存檔）。 */
function releaseUnwornLinks(save) {
  const worn = new Set(Object.values(save.equipped).filter(Boolean));
  if (!save.equipment.some(item => !worn.has(item.id) && item.links?.length)) return save;
  return mutate(save, draft => { for (const item of draft.equipment) if (!worn.has(item.id)) releaseLinks(draft, item.id); });
}

function setDifficulty(save, difficulty) {
  return mutate(save, draft => { draft.settings.difficulty = difficulty; });
}

/** 改玩家名字：去掉前後空白；空的或超過 PLAYER_NAME_MAX 字就丟 SaveError。 */
function setPlayerName(save, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new SaveError('名字不能是空的');
  if ([...trimmed].length > PLAYER_NAME_MAX) throw new SaveError(`名字最多 ${PLAYER_NAME_MAX} 個字`);
  return mutate(save, draft => { draft.settings.playerName = trimmed; });
}

/** 記錄進度（已擊敗的王、已解鎖的地區或怪物）。重複記錄不會有影響。 */
/**
 * 王的狀態（依 bosses.BOSSES 的順序）：擊敗過的都能再打，第一隻沒擊敗的也能打，之後的鎖住。
 * @returns {{ id, name, difficulty, defeated: boolean, available: boolean }[]}
 */
function bossStatus(save) {
  let nextOpen = true;
  return BOSSES.map(boss => {
    const defeated = save.progress.defeatedBosses.includes(boss.id);
    const available = defeated || nextOpen;
    if (!defeated) nextOpen = false;
    return { id: boss.id, name: boss.name, difficulty: boss.difficulty, defeated, available };
  });
}

/**
 * 記錄打贏王：第一次擊敗時記進 progress.defeatedBosses，並發首次獎勵（rewards.gems 各 1 顆、rewards.unlockRegions 開放地區）。
 * 再打贏不會重複發首次獎勵（一般掉落由呼叫端照常給）。還沒開放的王丟 SaveError。
 * 回傳 { save, firstClear, rewards }（rewards 是這次實際發的；不是首次時為空）。
 */
function recordBossVictory(save, bossId) {
  const status = bossStatus(save).find(entry => entry.id === bossId);
  if (!status) throw new SaveError(`找不到王「${bossId}」`);
  if (!status.available) throw new SaveError(`王「${status.name}」還沒開放（要先擊敗前一隻王）`);
  const boss = BOSSES.find(entry => entry.id === bossId);
  return mutate(save, draft => {
    if (status.defeated) return { firstClear: false, rewards: { gems: [], unlockRegions: [], accessories: [] } };
    draft.progress.defeatedBosses.push(bossId);
    const gems = [...(boss.rewards?.gems ?? [])];
    const unlockRegions = (boss.rewards?.unlockRegions ?? []).filter(id => !draft.progress.unlockedRegions.includes(id));
    for (const gemId of gems) giveGem(draft, gemId, 1);
    draft.progress.unlockedRegions.push(...unlockRegions);
    const accessories = (boss.rewards?.accessories ?? []).filter(id => !draft.accessories.owned.includes(id));
    draft.accessories.owned.push(...accessories);
    return { firstClear: true, rewards: { gems, unlockRegions, accessories } };
  });
}

/** 開放中的地區：沒有標 locked 的一開始就開放；locked: true 的要在 progress.unlockedRegions 裡（王的獎勵會加進去）。 */
function availableRegions(save) {
  return Object.values(REGIONS).filter(region => !region.locked || save.progress.unlockedRegions.includes(region.id)).map(region => region.id);
}

function addProgress(save, kind, id) {
  if (!PROGRESS_KEYS.includes(kind)) throw new SaveError(`未知的進度類型「${kind}」（支援：${PROGRESS_KEYS.join('、')}）`);
  return mutate(save, draft => { if (!draft.progress[kind].includes(id)) draft.progress[kind].push(id); });
}

// ── 給戰鬥用的讀取 ───────────────────────────────────────────

function equippedItems(save) {
  return SLOTS.map(slot => save.equipped[slot]).filter(Boolean).map(id => save.equipment.find(item => item.id === id));
}

/**
 * 穿戴中的裝備提供給穿戴者的屬性加成（基礎數值 + scope 為 wearer 的詞綴），
 * 格式與加成層相同，可直接傳給 applyStatBonuses／explainStatBonuses。
 * 沒寫 source 的加成會用裝備 id 當來源。
 */
function equippedBonuses(save) {
  return [
    ...equippedItems(save).flatMap(item => [
      ...item.base,
      ...item.affixes.filter(affix => affix.scope === 'wearer')
    ].map(({ stat, op, value, source }) => ({ stat, op, value, source: source ?? item.id }))),
    ...equippedAccessoryAffixes(save).filter(affix => affix.scope === 'wearer').map(({ stat, op, value, source }) => ({ stat, op, value, source }))
  ];
}

/** 穿著的飾品的詞綴（查 accessoryTable；沒穿是空陣列）。 */
function equippedAccessoryAffixes(save) {
  return accessoryAffixes(save.accessories?.equipped);
}

/**
 * 穿戴中的裝備提供的非屬性效果總和：{ physDmg, spellDmg, reduction, ailmentDmg, ailmentDuration, spRegen }（scope 為 effect 的詞綴；減傷已夾在上限）。
 * 傳給 compileLoadout 的 options.equipment；或直接用 compileEquipped。
 */
function equippedEffects(save) {
  return sumEffectAffixes([...equippedItems(save).flatMap(item => item.affixes), ...equippedAccessoryAffixes(save)]);
}

/**
 * 一步編譯穿戴中的裝備：寶石連結 + 物理／法術傷害提高 + 減傷。回傳 compileLoadout 的結果。
 * 屬性加成仍要自己用 equippedBonuses 套到角色基礎屬性上。
 */
function compileEquipped(save, options = {}) {
  return { ...compileLoadout(equippedLinks(save), { ...options, equipment: equippedEffects(save), mechanics: equippedMechanics(save) }), normalAttackStat: equippedAttackStat(save) };
}

/** 穿戴中的傳說裝備給的角色層級機制（spShield、shieldBreakSp），交給 compileLoadout 的 options.mechanics。 */
function equippedMechanics(save) {
  return equippedItems(save).flatMap(item => mechanicsOf(item)).filter(m => ['spShield', 'shieldBreakSp', 'phantom', 'counterIgnoreDefense', 'chord'].includes(m.type));
}

/** 普攻吃的屬性：穿著的武器的 attackStat；沒穿武器或武器沒寫時是 atk。普攻本身由遊戲建立（傷害段寫 stat）。 */
function equippedAttackStat(save) {
  const weaponId = save.equipped?.weapon;
  const weapon = weaponId ? save.equipment.find(item => item.id === weaponId) : null;
  return weapon?.attackStat ?? 'atk';
}

/**
 * 穿戴中的裝備上所有寶石連結（依部位順序），格式與 compileLoadout 的輸入相同。
 * 每組連結會帶上它所在裝備的 castWeight 當 weight。
 */
function equippedLinks(save) {
  return equippedItems(save).flatMap(item => {
    // 傳說裝備的機制依 legendaryId 查表（不存在存檔裡，改了表不用遷移）
    const mechanics = mechanicsOf(item);
    const granted = mechanics.filter(m => m.type === 'grantSupport').map(m => m.gem);
    const deathCast = mechanics.find(m => m.type === 'castOnEnemyDeath');
    const critCast = mechanics.find(m => m.type === 'castOnCrit');
    const phantomChase = mechanics.some(m => m.type === 'phantom');
    return normalizeLinks(item.links).map(link => ({
      ...link, weight: item.castWeight,
      ...(granted.length ? { grantedSupports: granted } : {}),
      ...(deathCast ? { castOnEnemyDeath: { text: deathCast.text } } : {}),
      ...(critCast ? { castOnCrit: { chance: critCast.chance, text: critCast.text } } : {}),
      ...(phantomChase ? { phantomChase: true } : {})
    }));
  });
}

// ── 儲存介面 ─────────────────────────────────────────────────

/** 記憶體版 adapter：測試用，或不想碰瀏覽器儲存時使用。 */
function createMemoryAdapter(initialText = null) {
  let text = initialText;
  return {
    read: () => text,
    write: value => { text = value; },
    remove: () => { text = null; }
  };
}

/** localStorage 版 adapter。寫入失敗（空間不足、被停用）會轉成 SaveError，提醒玩家匯出備份。 */
function createLocalStorageAdapter(storage = globalThis.localStorage, key = DEFAULT_STORAGE_KEY) {
  if (!storage) throw new SaveError('這個環境沒有 localStorage');
  return {
    read: () => storage.getItem(key),
    write: text => {
      try { storage.setItem(key, text); } catch (error) {
        throw new SaveError('寫入瀏覽器儲存失敗（空間不足或被停用），請先匯出存檔備份', [error.message]);
      }
    },
    remove: () => storage.removeItem(key)
  };
}

/**
 * 存檔管理：load／save／clear。方法都是 async，之後換成 IndexedDB 不用改呼叫端。
 * @param {{ read: Function, write: Function, remove: Function }} adapter
 * @param {{ now?: () => string, gameVersion?: string }} [options] now 回傳 ISO 時間字串（測試時傳固定值）
 */
function createSaveStore(adapter, { now = () => new Date().toISOString(), gameVersion = null, migrations = MIGRATIONS } = {}) {
  return {
    /** 讀檔；沒有存檔回傳 null；存檔壞掉或太新丟 SaveError（不會自動刪除玩家的資料）。 */
    async load() {
      const text = await adapter.read();
      if (text === null || text === undefined) return null;
      return importSave(text, migrations);
    },
    /** 存檔。回傳寫入的那一份（meta.savedAt 已更新），請改用這份繼續操作。 */
    async save(save) {
      const problems = validateSave(save);
      if (problems.length) throw new SaveError('存檔不合法，沒有寫入', problems);
      const written = { ...save, meta: { ...save.meta, savedAt: now() } };
      await adapter.write(JSON.stringify(written));
      return written;
    },
    async clear() { await adapter.remove(); },
    /** 全新的存檔（不會自動寫入）。 */
    create() { return createEmptySave({ now: now(), gameVersion }); },
    /** 有存檔就讀，沒有就建立新的。 */
    async loadOrCreate() { return (await this.load()) ?? this.create(); }
  };
}

module.exports = {
  SAVE_VERSION, SLOTS, SLOT_RULES, ORIGINS, ENGRAVABLE_ORIGINS, AFFIX_SCOPES, PROGRESS_KEYS, MIN_DIFFICULTY, MAX_DIFFICULTY, PLAYER_NAME_MAX, ITEM_NAME_MAX, MIGRATIONS, SaveError,
  createEmptySave, createStarterSave, validateSave, migrateSave, exportSave, importSave,
  convertGems, GEM_CONVERT_INPUTS, combineAllEngravings, rerollLegendary, rerollCraftAffix, transferEngraving, BLACK_DICE_PER_SALVAGE, BLACK_DICE_REROLL_COST, equipAccessory, addAccessory, equippedAccessoryAffixes, addGems, removeGems, addEngraving, removeEngraving, combineEngravings, grantDrops, craftEquipment, addLegendary, bossStatus, recordBossVictory, availableRegions, equippedAttackStat, engraveEquipment, clearEngraving, salvageEngravings, salvageEquipment, itemEngravings, addEquipment, removeEquipment, setLinks, equip, unequip, releaseUnwornLinks,
  setDifficulty, setPlayerName, addProgress, equippedBonuses, equippedEffects, compileEquipped, equippedMechanics, equippedLinks,
  createMemoryAdapter, createLocalStorageAdapter, createSaveStore
};
