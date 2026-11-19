'use strict';

/**
 * 遊戲層的接線（第 11 項：正式介面用）。把存檔、角色、戰鬥、掉落串起來；介面只呼叫這裡，所以可以在 node 測試。
 *
 * ── 一場戰鬥 ──────────────────────────────────────────────────
 *   prepareBattle(save, target, seed) → 建好角色與敵人（還沒打）
 *   runBattle(save, target, seed)     → 打完、打贏就發掉落與首次擊敗獎勵，回傳新存檔與「戰鬥紀錄」
 *   replayBattle(record)              → 用紀錄裡的存檔快照與種子重打一次，戰報逐行相同
 *   target：{ kind: 'region', id: 'ruins', difficulty } 或 { kind: 'boss', id: 'gatekeeper' }（王用自己的難度）
 *
 * ── 種子 ──────────────────────────────────────────────────────
 *   同一顆種子分成三條互不干擾的亂數：組敵人（seed）、戰鬥（seed + 1，engine 的 rng）、掉落（seed + 2）。
 *   所以「同一份存檔 ＋ 同一顆種子」一定是同一場戰鬥；裝備換了再用同一顆種子，敵人相同、過程不同。
 *
 * ── 角色 ──────────────────────────────────────────────────────
 *   HERO_BASE（沒有等級，成長全靠裝備）× 穿戴中的屬性加成（equippedBonuses → applyStatBonuses）。
 *   技能來自穿戴中裝備的寶石連結（compileEquipped，含裝備的傷害提高、減傷、異常、SP 回復）。
 *   普攻吃武器的 attackStat（沒穿武器是 atk）。命中公式一律 contest。
 */

const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { applyStatBonuses } = require('./statLayer');
const save = require('./saveLayer');
const { rollEncounter, availableMonsters, REGIONS } = require('./monsters');
const { buildBossEncounter, findBoss } = require('./bosses');
const { rollDrops } = require('./dropTable');

const HERO_BASE = { hp: 3000, sp: 240, atk: 150, int: 150, def: 50, spd: 200, cri: 0.1, criDmg: 1.5, skillCastRate: 0.35 };   // 速度 2026-11-19 加倍（原本 100）
const HERO_NAME = '玩家';   // 預設名；玩家改過名就用 settings.playerName
const MAX_TURNS = 40;

// 開新遊戲送的兩把新手武器（使用者決定）：沒有任何加成，差別只在普攻屬性——新手劍吃攻擊、新手法杖吃智力。
// 寶石要鑲在裝備上才能用，而製作要先湊 10 個刻印，沒有它們的話開局送的主動寶石用不到。
// 沒有 materials 所以不能分解、可以刻刻印；名字放在 name（origin 是 craft、沒有 quality，介面直接顯示 name）。
const STARTER_WEAPONS = [
  { slot: 'weapon', origin: 'craft', name: '新手劍', base: [], affixes: [], castWeight: 100, attackStat: 'atk' },
  { slot: 'weapon', origin: 'craft', name: '新手法杖', base: [], affixes: [], castWeight: 100, attackStat: 'int' }
];

/** 開新遊戲：開局主動寶石（saveLayer.createStarterSave）＋兩把新手武器（新手劍穿上）。 */
function createNewGame(options = {}) {
  let state = save.createStarterSave(options);
  const ids = STARTER_WEAPONS.map(weapon => { const added = save.addEquipment(state, weapon); state = added.save; return added.id; });
  return save.equip(state, ids[0]);
}

/** 玩家名字（存檔沒有就用預設名）。 */
const playerName = state => state.settings.playerName ?? HERO_NAME;

/** 強度等級 1～5（介面顯示用）：難度 1、4、7、10、13 起各升一級。 */
const strengthLevel = difficulty => Math.min(5, Math.floor((difficulty - 1) / 3) + 1);

/** 角色的最終屬性（介面顯示用）。 */
function heroStats(state) {
  return applyStatBonuses(HERO_BASE, save.equippedBonuses(state));
}

/** 建角色 Entity 與編譯好的 loadout。每場戰鬥都要重建（被動帶戰鬥狀態）。 */
function buildHero(state) {
  const loadout = save.compileEquipped(state);
  const stat = loadout.normalAttackStat;
  const hero = new Entity({
    id: 'hero', name: playerName(state), team: 'A', normalAttackSpCost: 2,
    normalAttack: new Skill({ id: 'hero_attack', name: '普攻', actions: [{ type: 'DAMAGE', stat }] }),
    skills: loadout.skills, passives: loadout.passives, stats: heroStats(state)
  });
  return { hero, loadout };
}

function checkTarget(state, target) {
  if (target?.kind === 'region') {
    if (!REGIONS[target.id]) throw new save.SaveError(`找不到地區「${target.id}」`);
    if (!save.availableRegions(state).includes(target.id)) throw new save.SaveError(`地區「${REGIONS[target.id].name}」還沒開放`);
    if (!Number.isInteger(target.difficulty) || target.difficulty < 1 || target.difficulty > 15) throw new save.SaveError('難度必須是 1～15 的整數');
    return { difficulty: target.difficulty, name: REGIONS[target.id].name };
  }
  if (target?.kind === 'boss') {
    const status = save.bossStatus(state).find(b => b.id === target.id);
    if (!status) throw new save.SaveError(`找不到王「${target.id}」`);
    if (!status.available) throw new save.SaveError(`王「${status.name}」還沒開放`);
    return { difficulty: findBoss(target.id).difficulty, name: status.name };
  }
  throw new save.SaveError('戰鬥目標必須是 { kind: "region", id, difficulty } 或 { kind: "boss", id }');
}

const hpOf = entity => ({ id: entity.id, name: entity.name, hp: Math.max(0, Math.round(entity.stats.hp)), maxHp: Math.round(entity.stats.maxHp ?? entity.stats.hp), alive: entity.isAlive });

/**
 * 戰鬥結束的血量（介面與下載戰報用，取代框架的「戰鬥結束，獲勝方: …」那一行）。
 * 回傳 { winner, text }：玩家勝 → 玩家剩餘 HP；敵方勝 → 還站著的敵人（含召喚）剩餘 HP；平手 → 雙方。
 */
function endSummary(winner, final) {
  const list = side => final.filter(e => e.team === side && e.alive).map(e => `${e.name} ${e.hp} / ${e.maxHp}`).join('、') || '—';
  if (winner === 'TEAM_A') return `勝利，剩餘 HP：${list('A')}`;
  if (winner === 'TEAM_B') return `敗北，敵方剩餘 HP：${list('B')}`;
  return `平手，剩餘 HP：${list('A')}｜敵方 ${list('B')}`;
}

function finish(battle, result) {
  const logs = battle.engine.logger.logs;
  const final = [...result.finalTeamA.map(e => ({ ...hpOf(e), team: 'A' })), ...result.finalTeamB.map(e => ({ ...hpOf(e), team: 'B' }))];
  return { logs, winner: result.winner, victory: result.winner === 'TEAM_A', turns: logs.filter(log => log.type === 'TURN_START').length,
    enemies: battle.monsters.map(m => m.name), opening: battle.opening, final, summary: endSummary(result.winner, final) };
}

/** 建好一場戰鬥（還沒打）。回傳 { engine, hero, monsters, info, difficulty, name }。 */
function prepareBattle(state, target, seed) {
  if (!Number.isInteger(seed)) throw new save.SaveError('種子必須是整數');
  const { difficulty, name } = checkTarget(state, target);
  const { hero, loadout } = buildHero(state);
  let monsters, summonFactory, info = { rare: false, elite: false };
  if (target.kind === 'region') {
    ({ monsters, summonFactory, info } = rollEncounter(target.id, difficulty, createSeededRandom(seed)));
  } else {
    ({ monsters } = buildBossEncounter(target.id));
    info = { boss: true, elite: true };
  }
  const engine = new BattleEngine([hero], monsters, {
    maxTurns: MAX_TURNS, rng: createSeededRandom(seed + 1), skillSelectionResolver: loadout.resolver,
    hitFormula: 'contest', summonFactory
  });
  // 開場的敵人血量（介面只顯示血量，其他數值不顯示）
  const opening = monsters.map(hpOf);
  return { engine, hero, monsters, info, difficulty, name, opening };
}

/**
 * 打一場。打贏：掉落（王戰比照菁英多 1 個刻印）＋王的首次擊敗獎勵；打輸或平手：什麼都沒有，存檔不變。
 * 回傳 { save, victory, winner, logs, turns, enemies, opening（開場敵人血量）, final（結束時雙方血量）, summary, drops, firstClear, rewards, record }。
 * record = { seed, target, snapshot（戰鬥前的存檔 JSON）, at } 給 replayBattle 用。
 */
function runBattle(state, target, seed, { now = () => new Date().toISOString() } = {}) {
  const snapshot = save.exportSave(state);
  const battle = prepareBattle(state, target, seed);
  const done = finish(battle, battle.engine.start());
  const victory = done.victory;
  let next = state, drops = null, firstClear = false, rewards = null;
  if (victory) {
    const dropRng = createSeededRandom(seed + 2);
    drops = rollDrops(battle.difficulty, dropRng, { rare: battle.info.rare, elite: battle.info.elite });
    next = save.grantDrops(next, drops, { difficulty: battle.difficulty, rng: dropRng });
    if (target.kind === 'boss') {
      const recorded = save.recordBossVictory(next, target.id);
      next = recorded.save;
      firstClear = recorded.firstClear;
      rewards = recorded.rewards;
    }
  }
  return {
    ...done, save: next, difficulty: battle.difficulty, name: battle.name, info: battle.info, drops, firstClear, rewards,
    record: { seed, target, snapshot, at: now() }
  };
}

/** 用戰鬥紀錄重打一次（不改任何存檔）。回傳 { logs, winner, victory, turns, enemies, opening, final, summary }。 */
function replayBattle(record) {
  const state = save.importSave(record.snapshot);
  const battle = prepareBattle(state, record.target, record.seed);
  return finish(battle, battle.engine.start());
}

/** 戰報純文字（下載用）：跳過空訊息行；給了 summary 就用它取代框架的 BATTLE_END 那一行。 */
function battleText(logs, header = '', summary = null) {
  const lines = logs.filter(log => !(summary && log.type === 'BATTLE_END')).map(log => log.message).filter(Boolean);
  return [header, ...lines, ...(summary ? [summary] : [])].filter(line => line !== '').join('\n');
}

/** 這個地區、這個難度會出現的怪（介面預覽用）。 */
function regionPreview(regionId, difficulty) {
  return availableMonsters(regionId, difficulty).map(def => ({
    id: def.id, name: def.name, rarity: def.rarity ?? null,
    skills: def.skills.filter(s => difficulty >= s.from).map(s => s.name)
  }));
}

/** 隨機種子（介面用；測試請自己給種子）。 */
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

module.exports = { HERO_BASE, HERO_NAME, playerName, strengthLevel, MAX_TURNS, STARTER_WEAPONS, createNewGame, heroStats, buildHero, prepareBattle, runBattle, replayBattle, battleText, endSummary, regionPreview, randomSeed };
