'use strict';

/**
 * 存檔層 v1：存檔的資料結構、驗證、版本遷移、背包操作，以及可替換的儲存介面。
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
 *                            { scope: 'gems', kind, value, source? }],           影響這件裝備上的寶石（kind 之後設計）
 *                   castWeight: 100,                                             施放權重（10～999），裝備擲出來的結果
 *                   links:   [{ active, supports: [] }] }                        鑲在這件裝備上的寶石連結
 *               每件裝備一組連結（1 顆主動 + 3 顆輔助），槽數沒有個體差異，所以不存在裝備裡，
 *               而是由 SLOT_RULES 決定。之後主動寶石能放進輔助槽時，只要改 SLOT_RULES（與編譯器），存檔格式不變。
 *               權重在裝備上、不在連結上：換寶石不會洗掉權重。穿戴時 equippedLinks 才把權重帶進連結。
 *   equipped    { weapon, helmet, armor, boots }：穿戴中的裝備 id 或 null
 *   progress    defeatedBosses、unlockedRegions、unlockedMonsters（id 字串陣列）
 *   settings    difficulty（1～15）
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

const { ACTIVE_GEMS, SUPPORT_GEMS, MAX_SUPPORTS, DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT } = require('./gems');
const { validateBonuses } = require('./statLayer');
const { compileLoadout } = require('./gemCompiler');

const SAVE_VERSION = 1;
const SLOTS = ['weapon', 'helmet', 'armor', 'boots'];
const ORIGINS = ['drop', 'craft'];
const AFFIX_SCOPES = ['wearer', 'gems'];
const PROGRESS_KEYS = ['defeatedBosses', 'unlockedRegions', 'unlockedMonsters'];
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 15;
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
const isGemId = id => Object.hasOwn(ACTIVE_GEMS, id) || Object.hasOwn(SUPPORT_GEMS, id);

// ── 建立 ─────────────────────────────────────────────────────

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
    settings: { difficulty: MIN_DIFFICULTY }
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
      else {
        if (typeof affix.kind !== 'string' || !affix.kind) problems.push(`${at}的 kind 必須是非空字串`);
        if (!Number.isFinite(affix.value)) problems.push(`${at}的 value 必須是有限數字`);
        if (affix.source !== undefined && typeof affix.source !== 'string') problems.push(`${at}的 source 必須是字串`);
      }
    });
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

  problems.push(...validateStacks(save.gems, 'gems', id => (isGemId(id) ? null : '不是已知的寶石')));
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
  }
  return problems;
}

// ── 版本遷移 ─────────────────────────────────────────────────

// 舊版本 → 升到下一版的函式。例如存檔結構改成第 2 版時：
//   MIGRATIONS[1] = save => ({ ...save, version: 2, 新欄位: 預設值 });
// 每一步只升一版，必須把 version 設成原本加一；讀檔時會一路升到 SAVE_VERSION。
const MIGRATIONS = {};

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

function addGems(save, gemId, count = 1) {
  requireCount(count);
  requireGem(gemId);
  return mutate(save, draft => addToStack(draft.gems, gemId, count));
}

function removeGems(save, gemId, count = 1) {
  requireCount(count);
  requireGem(gemId);
  return mutate(save, draft => takeFromStack(draft.gems, gemId, count, `寶石「${gemId}」`));
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

function linkGemCounts(links) {
  const counts = {};
  for (const link of links) {
    addToStack(counts, link.active, 1);
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
  return mutate(save, draft => {
    const item = findItem(draft, id);
    for (const [gemId, count] of Object.entries(linkGemCounts(item.links))) addToStack(draft.gems, gemId, count);
    const next = normalizeLinks(links);
    for (const [gemId, count] of Object.entries(linkGemCounts(next))) takeFromStack(draft.gems, gemId, count, `背包的寶石「${gemId}」`);
    item.links = next;
  });
}

function equip(save, id) {
  return mutate(save, draft => {
    const item = findItem(draft, id);
    draft.equipped[item.slot] = id;
  });
}

function unequip(save, slot) {
  if (!SLOTS.includes(slot)) throw new SaveError(`未知的部位「${slot}」`);
  return mutate(save, draft => { draft.equipped[slot] = null; });
}

function setDifficulty(save, difficulty) {
  return mutate(save, draft => { draft.settings.difficulty = difficulty; });
}

/** 記錄進度（已擊敗的王、已解鎖的地區或怪物）。重複記錄不會有影響。 */
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
  return equippedItems(save).flatMap(item => [
    ...item.base,
    ...item.affixes.filter(affix => affix.scope === 'wearer')
  ].map(({ stat, op, value, source }) => ({ stat, op, value, source: source ?? item.id })));
}

/**
 * 穿戴中的裝備上所有寶石連結（依部位順序），格式與 compileLoadout 的輸入相同。
 * 每組連結會帶上它所在裝備的 castWeight 當 weight。
 */
function equippedLinks(save) {
  return equippedItems(save).flatMap(item => normalizeLinks(item.links).map(link => ({ ...link, weight: item.castWeight })));
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
  SAVE_VERSION, SLOTS, SLOT_RULES, ORIGINS, AFFIX_SCOPES, PROGRESS_KEYS, MIN_DIFFICULTY, MAX_DIFFICULTY, MIGRATIONS, SaveError,
  createEmptySave, validateSave, migrateSave, exportSave, importSave,
  addGems, removeGems, addEngraving, removeEngraving, addEquipment, removeEquipment, setLinks, equip, unequip,
  setDifficulty, addProgress, equippedBonuses, equippedLinks,
  createMemoryAdapter, createLocalStorageAdapter, createSaveStore
};
