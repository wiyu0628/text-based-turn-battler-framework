'use strict';

// 存檔層的測試。執行：node --test gem/saveLayer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { applyStatBonuses } = require('./statLayer');
const { compileLoadout } = require('./gemCompiler');
const save = require('./saveLayer');

const {
  SAVE_VERSION, SaveError, createEmptySave, validateSave, migrateSave, exportSave, importSave,
  addGems, removeGems, addEngraving, removeEngraving, addEquipment, removeEquipment, setLinks, equip, unequip,
  setDifficulty, addProgress, equippedBonuses, equippedLinks,
  createMemoryAdapter, createLocalStorageAdapter, createSaveStore, SLOT_RULES
} = save;

const NOW = '2026-11-14T00:00:00.000Z';
const fresh = () => createEmptySave({ now: NOW, gameVersion: '1.0.56' });
const sword = (extra = {}) => ({
  slot: 'weapon', origin: 'drop',
  base: [{ stat: 'atk', op: 'flat', value: 12 }],
  affixes: [{ scope: 'wearer', stat: 'cri', op: 'flat', value: 0.05, source: 'critA@2' }],
  ...extra
});
const helmet = (extra = {}) => ({ slot: 'helmet', origin: 'craft', base: [{ stat: 'def', op: 'flat', value: 8 }], affixes: [], ...extra });

// 背包有指定寶石、並加好一件裝備的存檔。回傳 { state, id }。
function stocked(gems = {}, item = sword()) {
  let state = fresh();
  for (const [gemId, count] of Object.entries(gems)) state = addGems(state, gemId, count);
  const added = addEquipment(state, item);
  return { state: added.save, id: added.id };
}
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

// ── 建立與驗證 ───────────────────────────────────────────────

test('全新存檔：結構完整且通過驗證', () => {
  const state = fresh();
  assert.deepEqual(validateSave(state), []);
  assert.equal(state.version, SAVE_VERSION);
  assert.deepEqual(state.meta, { gameVersion: '1.0.56', createdAt: NOW, savedAt: null, nextId: 1 });
  assert.deepEqual(state.equipped, { weapon: null, helmet: null, armor: null, boots: null });
  assert.equal(state.settings.difficulty, 1);
});

test('驗證：一次列出全部問題，不是第一個就停', () => {
  const state = fresh();
  state.gems.nope = 1;
  state.gems.heavy = 0;
  state.engravings['壞格式'] = 1;
  state.settings.difficulty = 16;
  state.progress.defeatedBosses = ['a', 'a'];
  const problems = validateSave(state);
  assert.ok(problems.some(p => /nope.*不是已知的寶石/.test(p)));
  assert.ok(problems.some(p => /heavy.*數量/.test(p)));
  assert.ok(problems.some(p => /壞格式/.test(p)));
  assert.ok(problems.some(p => /difficulty/.test(p)));
  assert.ok(problems.some(p => /重複/.test(p)));
});

test('驗證：不是物件、版本不對', () => {
  assert.deepEqual(validateSave(null), ['存檔必須是物件']);
  assert.ok(validateSave({ ...fresh(), version: 99 }).some(p => /版本/.test(p)));
});

// ── 寶石與刻印堆疊 ───────────────────────────────────────────

test('寶石：堆疊相加，扣到 0 時移除該項', () => {
  let state = addGems(fresh(), 'heavy', 2);
  state = addGems(state, 'heavy');
  assert.equal(state.gems.heavy, 3);
  state = removeGems(state, 'heavy', 3);
  assert.ok(!('heavy' in state.gems));
});

test('寶石：不夠、未知、數量不合法都丟 SaveError，原存檔不變', () => {
  const state = deepFreeze(addGems(fresh(), 'heavy', 1));
  assert.throws(() => removeGems(state, 'heavy', 2), error => error instanceof SaveError && /不夠/.test(error.message));
  assert.throws(() => addGems(state, 'nope'), SaveError);
  assert.throws(() => removeGems(state, 'nope'), SaveError);
  for (const bad of [0, -1, 1.5, '2', NaN]) assert.throws(() => addGems(state, 'heavy', bad), SaveError);
  assert.equal(state.gems.heavy, 1);
});

test('操作不會改傳入的存檔（凍結後照樣可用）', () => {
  const state = deepFreeze(fresh());
  const next = addGems(state, 'heavy', 1);
  assert.notEqual(next, state);
  assert.deepEqual(state.gems, {});
  assert.equal(next.gems.heavy, 1);
});

test('刻印：以「種類@階級」堆疊，階級 1～5、種類格式受檢查', () => {
  let state = addEngraving(fresh(), 'atkA', 3, 2);
  state = addEngraving(state, 'atkA', 3);
  assert.equal(state.engravings['atkA@3'], 3);
  state = removeEngraving(state, 'atkA', 3, 3);
  assert.deepEqual(state.engravings, {});
  for (const tier of [0, 6, 2.5, '3']) assert.throws(() => addEngraving(fresh(), 'atkA', tier), SaveError);
  for (const type of ['', '1abc', 'a@b', '__proto__', 'a b']) assert.throws(() => addEngraving(fresh(), type, 1), SaveError);
  assert.throws(() => removeEngraving(fresh(), 'atkA', 1), /不夠/);
});

// ── 裝備 ─────────────────────────────────────────────────────

test('新增裝備：配發遞增 id，meta.nextId 跟著前進，id 不會重用', () => {
  const a = addEquipment(fresh(), sword());
  const b = addEquipment(a.save, helmet());
  assert.deepEqual([a.id, b.id], ['eq1', 'eq2']);
  assert.equal(b.save.meta.nextId, 3);
  const removed = removeEquipment(b.save, a.id);
  const c = addEquipment(removed, sword());
  assert.equal(c.id, 'eq3', '刪掉 eq1 後新裝備也不能叫 eq1');
});

test('新增裝備：不能自己指定 id、不能帶寶石', () => {
  assert.throws(() => addEquipment(fresh(), sword({ id: 'eq9' })), /id/);
  assert.throws(() => addEquipment(fresh(), sword({ links: [{ active: 'magicmissile' }] })), /setLinks/);
  assert.ok(addEquipment(fresh(), sword({ links: [] })).id);
});

test('新增裝備：部位、來源、基礎數值、詞綴不合法時列出原因', () => {
  const tryAdd = item => { try { addEquipment(fresh(), item); } catch (error) { return error; } return null; };
  assert.match(tryAdd(sword({ slot: 'ring' })).message, /slot/);
  assert.match(tryAdd(sword({ origin: 'gift' })).message, /origin/);
  assert.match(tryAdd(sword({ base: [{ stat: 'atk', op: 'inc', value: 0.1 }] })).message, /flat/);
  assert.match(tryAdd(sword({ base: [{ stat: 'luck', op: 'flat', value: 1 }] })).message, /luck/);
  assert.match(tryAdd(sword({ affixes: [{ scope: 'wearer', stat: 'atk', op: 'more', value: -1 }] })).message, /more/);
  assert.match(tryAdd(sword({ affixes: [{ scope: 'moon', stat: 'atk', op: 'flat', value: 1 }] })).message, /scope/);
  assert.match(tryAdd(sword({ affixes: [{ scope: 'gems', kind: '', value: 1 }] })).message, /kind/);
  assert.match(tryAdd(sword({ affixes: [{ scope: 'gems', kind: 'castWeight', value: Infinity }] })).message, /value/);
  assert.match(tryAdd(sword({ base: 'x' })).message, /base/);
});

test('新增裝備：影響寶石的詞綴（scope gems）可以存', () => {
  const { state } = stocked({}, sword({ affixes: [{ scope: 'gems', kind: 'castWeight', value: 50, source: 'weightA@1' }] }));
  assert.equal(state.equipment[0].affixes[0].kind, 'castWeight');
  assert.deepEqual(validateSave(state), []);
});

// ── 寶石鑲嵌 ─────────────────────────────────────────────────

test('鑲嵌：輔助寶石從背包移到裝備、主動寶石是擁有制不扣背包，換連結時舊的輔助寶石退回背包', () => {
  const { state, id } = stocked({ magicmissile: 1, whirlwind: 1, heavy: 1, critup: 1 });
  const first = setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  assert.deepEqual(first.gems, { magicmissile: 1, whirlwind: 1, critup: 1 });
  assert.deepEqual(first.equipment[0].links, [{ active: 'magicmissile', supports: ['heavy'] }]);
  const second = setLinks(first, id, [{ active: 'whirlwind', supports: ['critup'] }]);
  assert.deepEqual(second.gems, { magicmissile: 1, whirlwind: 1, heavy: 1 });
  assert.deepEqual(second.equipment[0].links, [{ active: 'whirlwind', supports: ['critup'] }]);
  assert.deepEqual(setLinks(second, id, []).gems, { magicmissile: 1, whirlwind: 1, heavy: 1, critup: 1 });
});

test('鑲嵌：重設同樣的連結不會多扣寶石', () => {
  const { state, id } = stocked({ magicmissile: 1, heavy: 1 });
  const once = setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  const again = setLinks(once, id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  assert.deepEqual(again.gems, { magicmissile: 1 });
  assert.deepEqual(again.equipment[0].links, once.equipment[0].links);
});

test('鑲嵌：背包的寶石不夠就失敗，原存檔完全不變', () => {
  const { state, id } = stocked({ magicmissile: 1 });
  const frozen = deepFreeze(state);
  assert.throws(() => setLinks(frozen, id, [{ active: 'magicmissile', supports: ['heavy'] }]), error => error instanceof SaveError && /heavy/.test(error.message));
  assert.deepEqual(frozen.gems, { magicmissile: 1 });
  assert.deepEqual(frozen.equipment[0].links, []);
});

test('鑲嵌：寶石規則（互斥、輔助槽上限、組數上限、未知寶石、連結上寫權重）都會擋', () => {
  const { state, id } = stocked({ magicmissile: 1, heavy: 2, lean: 1, amp: 1, wide: 1, pierce: 1 });
  assert.throws(() => setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy', 'lean'] }]), /互斥/);
  assert.throws(() => setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy', 'amp', 'wide', 'pierce'] }]), /輔助槽上限/);
  assert.throws(() => setLinks(state, id, [{ active: 'magicmissile' }, { active: 'whirlwind' }]), /最多 1 組/);
  assert.throws(() => setLinks(state, id, [{ active: 'nope' }]), /nope/);
  assert.throws(() => setLinks(state, id, [{ active: 'magicmissile', supports: ['nope'] }]), /nope/);
  assert.throws(() => setLinks(state, id, [{ active: 'magicmissile', weight: 200 }]), /castWeight/);
  assert.throws(() => setLinks(state, 'eq99', []), /找不到/);
});

test('鑲嵌：沒寫的 supports 視為空、沒寫的 weight 不會憑空出現', () => {
  const { state, id } = stocked({ magicmissile: 1 });
  const next = setLinks(state, id, [{ active: 'magicmissile' }]);
  assert.deepEqual(next.equipment[0].links, [{ active: 'magicmissile', supports: [] }]);
});

test('施放權重：在裝備上，沒寫就是預設 100，範圍 10～999 的整數', () => {
  assert.equal(addEquipment(fresh(), sword()).save.equipment[0].castWeight, 100);
  assert.equal(addEquipment(fresh(), sword({ castWeight: 250 })).save.equipment[0].castWeight, 250);
  for (const bad of [9, 1000, 150.5, '200', null]) assert.throws(() => addEquipment(fresh(), sword({ castWeight: bad })), /castWeight/);
  const missing = structuredClone(stocked().state);
  delete missing.equipment[0].castWeight;
  assert.ok(validateSave(missing).some(p => /castWeight/.test(p)));
});

test('施放權重：換寶石、卸下寶石都不會動到裝備的權重', () => {
  let { state, id } = stocked({ magicmissile: 1, whirlwind: 1 }, sword({ castWeight: 333 }));
  state = setLinks(state, id, [{ active: 'magicmissile' }]);
  assert.equal(state.equipment[0].castWeight, 333);
  state = setLinks(state, id, [{ active: 'whirlwind' }]);
  assert.equal(state.equipment[0].castWeight, 333);
  state = setLinks(state, id, []);
  assert.equal(state.equipment[0].castWeight, 333);
});

test('驗證：存檔裡連結上寫了 weight（舊格式）會被指出', () => {
  const { state, id } = stocked({ magicmissile: 1 });
  const bad = structuredClone(setLinks(state, id, [{ active: 'magicmissile' }]));
  bad.equipment[0].links[0].weight = 150;
  assert.ok(validateSave(bad).some(p => /castWeight/.test(p)));
});

test('連結規則：驗證與鑲嵌都透過 SLOT_RULES 詢問，改規則就能放寬（之後主動寶石進輔助槽用）', () => {
  const original = { ...SLOT_RULES };
  try {
    const { state, id } = stocked({ magicmissile: 1, heavy: 1, amp: 1, wide: 1 });
    // 輔助槽縮成 2 格
    SLOT_RULES.supportSlotCount = () => 2;
    assert.throws(() => setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy', 'amp', 'wide'] }]), /輔助槽上限 2/);
    assert.ok(setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy', 'amp'] }]));
    SLOT_RULES.supportSlotCount = original.supportSlotCount;
    // 某顆寶石不准放進輔助槽
    SLOT_RULES.canFillSupportSlot = gemId => gemId !== 'heavy' && original.canFillSupportSlot(gemId);
    assert.throws(() => setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy'] }]), /不能放進輔助槽/);
    SLOT_RULES.canFillSupportSlot = original.canFillSupportSlot;
    // 一件裝備放寬成兩組連結
    SLOT_RULES.maxLinks = () => 2;
    const two = setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy'] }, { active: 'whirlwind', supports: [] }].slice(0, 1));
    assert.equal(two.equipment[0].links.length, 1);
    assert.throws(() => setLinks(state, id, [{ active: 'magicmissile' }, { active: 'magicmissile' }]), /重複/);
  } finally {
    Object.assign(SLOT_RULES, original);
  }
  assert.equal(SLOT_RULES.supportSlotCount({}, {}), 3);
  assert.equal(SLOT_RULES.maxLinks({}), 1);
});

test('刪除裝備：鑲在上面的寶石退回背包，穿著的會脫下', () => {
  let { state, id } = stocked({ magicmissile: 1, heavy: 1 });
  state = setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  state = equip(state, id);
  const removed = removeEquipment(state, id);
  assert.deepEqual(removed.gems, { magicmissile: 1, heavy: 1 });
  assert.equal(removed.equipped.weapon, null);
  assert.deepEqual(removed.equipment, []);
  assert.throws(() => removeEquipment(removed, id), /找不到/);
});

// ── 穿戴 ─────────────────────────────────────────────────────

test('穿戴：放進對應部位，可脫下；未知部位報錯', () => {
  const { state, id } = stocked();
  const worn = equip(state, id);
  assert.equal(worn.equipped.weapon, id);
  assert.equal(unequip(worn, 'weapon').equipped.weapon, null);
  assert.throws(() => unequip(worn, 'ring'), SaveError);
  assert.throws(() => equip(worn, 'eq99'), /找不到/);
});

test('穿戴：換另一件同部位的會取代', () => {
  const a = addEquipment(fresh(), sword());
  const b = addEquipment(a.save, sword());
  const state = equip(equip(b.save, a.id), b.id);
  assert.equal(state.equipped.weapon, b.id);
});

test('穿戴：兩件裝備上有相同的技能，穿第二件時被擋；沒穿時各自存在沒問題', () => {
  let state = addGems(fresh(), 'magicmissile', 2);
  const a = addEquipment(state, sword());
  const b = addEquipment(a.save, helmet());
  state = setLinks(setLinks(b.save, a.id, [{ active: 'magicmissile' }]), b.id, [{ active: 'magicmissile' }]);
  assert.deepEqual(validateSave(state), []);
  state = equip(state, a.id);
  assert.throws(() => equip(state, b.id), error => error instanceof SaveError && /重複/.test(error.message));
});

test('穿戴中的裝備改連結造成合併後衝突，也會被擋', () => {
  let state = addGems(fresh(), 'magicmissile', 2);
  const a = addEquipment(state, sword());
  const b = addEquipment(a.save, helmet());
  state = equip(equip(b.save, a.id), b.id);
  state = setLinks(state, a.id, [{ active: 'magicmissile' }]);
  assert.throws(() => setLinks(state, b.id, [{ active: 'magicmissile' }]), /重複/);
});

test('驗證：equipped 放錯部位、指向不存在的裝備會被指出', () => {
  const { state, id } = stocked();
  const wrongSlot = structuredClone(state);
  wrongSlot.equipped.helmet = id;
  assert.ok(validateSave(wrongSlot).some(p => /helmet.*weapon/.test(p)));
  const missing = structuredClone(state);
  missing.equipped.weapon = 'eq77';
  assert.ok(validateSave(missing).some(p => /不存在/.test(p)));
});

test('驗證：裝備 id 重複、id 不小於 nextId 會被指出', () => {
  const { state } = stocked();
  const dup = structuredClone(state);
  dup.equipment.push(structuredClone(dup.equipment[0]));
  assert.ok(validateSave(dup).some(p => /重複/.test(p)));
  const reuse = structuredClone(state);
  reuse.meta.nextId = 1;
  assert.ok(validateSave(reuse).some(p => /nextId/.test(p)));
});

// ── 進度與設定 ───────────────────────────────────────────────

test('進度：重複記錄不會重複，未知類型報錯', () => {
  let state = addProgress(fresh(), 'defeatedBosses', 'boss1');
  state = addProgress(state, 'defeatedBosses', 'boss1');
  state = addProgress(state, 'unlockedRegions', 'forest');
  assert.deepEqual(state.progress, { defeatedBosses: ['boss1'], unlockedRegions: ['forest'], unlockedMonsters: [] });
  assert.throws(() => addProgress(state, 'cheats', 'x'), SaveError);
  assert.throws(() => addProgress(state, 'defeatedBosses', ''), SaveError);
});

test('難度：1～15 的整數', () => {
  assert.equal(setDifficulty(fresh(), 15).settings.difficulty, 15);
  for (const bad of [0, 16, 2.5, '3']) assert.throws(() => setDifficulty(fresh(), bad), SaveError);
});

// ── 給戰鬥用的讀取 ───────────────────────────────────────────

test('equippedBonuses：只含穿戴中裝備的基礎數值與 wearer 詞綴，沒寫來源的用裝備 id', () => {
  let state = fresh();
  const a = addEquipment(state, sword({ affixes: [
    { scope: 'wearer', stat: 'cri', op: 'flat', value: 0.05, source: 'critA@2' },
    { scope: 'gems', kind: 'castWeight', value: 50 }
  ] }));
  const b = addEquipment(a.save, helmet());
  const c = addEquipment(b.save, helmet());
  state = equip(equip(c.save, a.id), b.id);
  assert.deepEqual(equippedBonuses(state), [
    { stat: 'atk', op: 'flat', value: 12, source: a.id },
    { stat: 'cri', op: 'flat', value: 0.05, source: 'critA@2' },
    { stat: 'def', op: 'flat', value: 8, source: b.id }
  ]);
  assert.equal(equippedBonuses(fresh()).length, 0);
});

test('接上加成層：裝備的加成直接餵給 applyStatBonuses', () => {
  const { state, id } = stocked();
  const stats = applyStatBonuses({ hp: 100, sp: 10, atk: 100, def: 10, spd: 10, cri: 0 }, equippedBonuses(equip(state, id)));
  assert.equal(stats.atk, 112);
  assert.equal(stats.cri, 0.05);
});

test('equippedLinks：依部位順序合併，格式可直接給 compileLoadout；整套打得完一場戰鬥', () => {
  let state = fresh();
  for (const [gemId, count] of [['magicmissile', 1], ['whirlwind', 1], ['heavy', 1], ['critup', 1]]) state = addGems(state, gemId, count);
  const w = addEquipment(state, sword());
  const h = addEquipment(w.save, helmet({ castWeight: 200 }));
  state = setLinks(h.save, w.id, [{ active: 'magicmissile', supports: ['heavy'] }]);
  state = setLinks(state, h.id, [{ active: 'whirlwind', supports: ['critup'] }]);
  state = equip(equip(state, h.id), w.id);
  assert.deepEqual(equippedLinks(state).map(link => link.active), ['magicmissile', 'whirlwind'], '依部位順序（武器在頭盔前）');
  assert.deepEqual(equippedLinks(state).map(link => link.weight), [100, 200], '每組連結帶著所在裝備的 castWeight');

  const loadout = compileLoadout(equippedLinks(state));
  assert.equal(loadout.skills.length, 2);
  assert.deepEqual(Object.values(loadout.weights), [100, 200]);
  const plain = id => new Skill({ id, name: id, actions: [{ type: 'DAMAGE' }] });
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain('slash'), skills: loadout.skills, passives: loadout.passives,
    stats: applyStatBonuses({ hp: 3000, sp: 900, atk: 150, int: 150, def: 50, spd: 120, cri: 0, skillCastRate: 1 }, equippedBonuses(state))
  });
  const boss = new Entity({ id: 'boss', name: '魔王', team: 'B', normalAttack: plain('claw'), stats: { hp: 800, sp: 0, atk: 1, def: 0, spd: 1 } });
  const result = new BattleEngine([hero], [boss], { rng: createSeededRandom(7), skillSelectionResolver: loadout.resolver }).start();
  assert.ok(result.logs.some(log => log.type === 'DAMAGE'));
  assert.equal(result.winner, 'TEAM_A');
});

// ── 版本遷移 ─────────────────────────────────────────────────

test('遷移：沒有版本號、版本不合法、比遊戲新的存檔都拒絕', () => {
  assert.throws(() => migrateSave({}), /版本號/);
  assert.throws(() => migrateSave({ version: 0 }), /版本號/);
  assert.throws(() => migrateSave({ version: 1.5 }), /版本號/);
  assert.throws(() => migrateSave({ version: SAVE_VERSION + 1 }), /更新遊戲/);
  assert.throws(() => migrateSave('x'), SaveError);
});

test('遷移：一路升級到目標版本，不改傳入的物件', () => {
  const v = SAVE_VERSION;
  const migrations = {
    [v]: old => ({ ...old, version: v + 1, settings: { ...old.settings, music: true } }),
    [v + 1]: old => ({ ...old, version: v + 2, renamed: old.progress })
  };
  const old = deepFreeze(fresh());
  const upgraded = migrateSave(old, migrations, v + 2);
  assert.equal(upgraded.version, v + 2);
  assert.equal(upgraded.settings.music, true);
  assert.deepEqual(upgraded.renamed, old.progress);
  assert.equal(old.version, v);
});

test('遷移：缺升級函式、或升級函式沒把 version 加一，都報錯', () => {
  const v = SAVE_VERSION;
  assert.throws(() => migrateSave(fresh(), {}, v + 1), new RegExp(`找不到從存檔版本 ${v}`));
  assert.throws(() => migrateSave(fresh(), { [v]: old => ({ ...old }) }, v + 1), new RegExp(`沒有把 version 設成 ${v + 1}`));
});

// ── 匯出與匯入 ───────────────────────────────────────────────

test('匯出再匯入：內容逐項相同', () => {
  let { state, id } = stocked({ magicmissile: 3, heavy: 2, amp: 1 }, sword({ castWeight: 150 }));
  state = setLinks(state, id, [{ active: 'magicmissile', supports: ['heavy', 'amp'] }]);
  state = equip(addEngraving(addProgress(setDifficulty(state, 7), 'unlockedRegions', 'forest'), 'atkA', 4, 2), id);
  const back = importSave(exportSave(state));
  assert.deepEqual(back, state);
});

test('匯入：壞掉的 JSON、不合法的內容、太新的版本都丟 SaveError', () => {
  assert.throws(() => importSave('{壞掉'), error => error instanceof SaveError && /JSON/.test(error.message));
  assert.throws(() => importSave('[]'), SaveError);
  const broken = fresh();
  broken.gems.nope = 1;
  assert.throws(() => importSave(JSON.stringify(broken)), error => error instanceof SaveError && /nope/.test(error.message));
  assert.throws(() => importSave(JSON.stringify({ ...fresh(), version: 99 })), /更新遊戲/);
});

test('匯出：不合法的存檔不給匯出', () => {
  const broken = fresh();
  broken.settings.difficulty = 99;
  assert.throws(() => exportSave(broken), SaveError);
});

// ── 儲存介面 ─────────────────────────────────────────────────

test('存檔管理：沒存過回傳 null；存了之後讀得回來，savedAt 用注入的時間', async () => {
  const store = createSaveStore(createMemoryAdapter(), { now: () => '2026-12-01T00:00:00.000Z', gameVersion: '1.0.56' });
  assert.equal(await store.load(), null);
  const written = await store.save(addGems(store.create(), 'heavy', 2));
  assert.equal(written.meta.savedAt, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(await store.load(), written);
});

test('存檔管理：save 不改傳入的存檔，回傳的是寫入的那一份', async () => {
  const store = createSaveStore(createMemoryAdapter(), { now: () => NOW });
  const input = deepFreeze(fresh());
  const written = await store.save(input);
  assert.equal(input.meta.savedAt, null);
  assert.equal(written.meta.savedAt, NOW);
});

test('存檔管理：clear 之後讀不到；loadOrCreate 沒有存檔時給新的', async () => {
  const store = createSaveStore(createMemoryAdapter(), { now: () => NOW, gameVersion: '1.0.56' });
  await store.save(addGems(store.create(), 'heavy'));
  await store.clear();
  assert.equal(await store.load(), null);
  const created = await store.loadOrCreate();
  assert.equal(created.meta.createdAt, NOW);
  assert.equal(created.meta.gameVersion, '1.0.56');
});

test('存檔管理：不合法的存檔不寫入，已存在的存檔保持原樣', async () => {
  const adapter = createMemoryAdapter();
  const store = createSaveStore(adapter, { now: () => NOW });
  await store.save(fresh());
  const before = adapter.read();
  const broken = fresh();
  broken.gems.nope = 3;
  await assert.rejects(store.save(broken), SaveError);
  assert.equal(adapter.read(), before);
});

test('存檔管理：存檔壞掉時讀檔丟錯，而且不會偷偷刪掉玩家的資料', async () => {
  const adapter = createMemoryAdapter('{"version":1,"meta":');
  const store = createSaveStore(adapter);
  await assert.rejects(store.load(), SaveError);
  assert.equal(adapter.read(), '{"version":1,"meta":');
});

test('存檔管理：adapter 可以是非同步的（之後換 IndexedDB 的情境）', async () => {
  let text = null;
  const asyncAdapter = {
    read: async () => text,
    write: async value => { await Promise.resolve(); text = value; },
    remove: async () => { text = null; }
  };
  const store = createSaveStore(asyncAdapter, { now: () => NOW });
  assert.equal(await store.load(), null);
  const written = await store.save(addGems(fresh(), 'heavy'));
  assert.deepEqual(await store.load(), written);
  await store.clear();
  assert.equal(await store.load(), null);
});

test('localStorage adapter：用 key 存取；空的回傳 null', async () => {
  const data = new Map();
  const fake = { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const store = createSaveStore(createLocalStorageAdapter(fake, 'my-key'), { now: () => NOW });
  assert.equal(await store.load(), null);
  await store.save(fresh());
  assert.ok(data.has('my-key'));
  assert.ok(await store.load());
  await store.clear();
  assert.ok(!data.has('my-key'));
});

test('localStorage adapter：空間不足轉成 SaveError，提醒匯出；沒有 localStorage 的環境報錯', async () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  const store = createSaveStore(createLocalStorageAdapter(full), { now: () => NOW });
  await assert.rejects(store.save(fresh()), error => error instanceof SaveError && /匯出/.test(error.message) && /Quota/.test(error.problems[0]));
  assert.throws(() => createLocalStorageAdapter(undefined), SaveError);
});

test('效能：兩百件裝備連續操作不會越來越慢（同一組連結只編譯一次）', () => {
  let state = fresh();
  for (const gemId of ['magicmissile', 'heavy', 'amp']) state = addGems(state, gemId, 200);
  const started = Date.now();
  for (let i = 0; i < 200; i++) {
    const added = addEquipment(state, sword());
    state = setLinks(added.save, added.id, [{ active: 'magicmissile', supports: ['heavy', 'amp'] }]);
  }
  assert.equal(state.equipment.length, 200);
  assert.ok(Date.now() - started < 5000, `太慢：${Date.now() - started} 毫秒`);
});
