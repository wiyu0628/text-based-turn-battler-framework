const { test } = require('node:test');
const assert = require('node:assert/strict');
const game = require('./game');
const save = require('./saveLayer');

const ruins = difficulty => ({ kind: 'region', id: 'ruins', difficulty });
const messages = logs => logs.map(log => log.message);
const newGame = () => game.createNewGame({ now: '2026-01-01T00:00:00Z' });
const withWhirlwind = () => { const state = newGame(); return save.setLinks(state, state.equipped.weapon, [{ active: 'whirlwind', supports: [] }]); };

test('a new game has the starting active gems and two starter weapons (sword worn) that can hold links', () => {
  const state = newGame();
  const weapon = state.equipment.find(item => item.id === state.equipped.weapon);
  assert.deepEqual(state.equipment.map(item => [item.name, item.attackStat, item.base.length]), [['新手劍', 'atk', 0], ['新手法杖', 'int', 0]]);
  assert.equal(weapon.name, '新手劍');
  for (const item of state.equipment) assert.throws(() => save.salvageEquipment(state, item.id), /不能分解/);
  const staff = save.equip(state, state.equipment[1].id);
  assert.equal(save.compileEquipped(staff).normalAttackStat, 'int');
  assert.deepEqual(game.heroStats(staff), game.heroStats(state));                    // 加成都是 0
  assert.equal(weapon.slot, 'weapon');
  assert.equal(weapon.materials, undefined);                                         // 不能分解
  assert.throws(() => save.salvageEquipment(state, weapon.id), /不能分解/);
  assert.deepEqual(state.gems, { magicmissile: 1, whirlwind: 1, rend: 1 });
  const linked = withWhirlwind();
  assert.equal(linked.gems.whirlwind, undefined);                                     // 鑲上去了
  assert.deepEqual(save.validateSave(linked), []);
});

test('hero stats = base × worn bonuses; skills come from the worn links', () => {
  const state = withWhirlwind();
  const stats = game.heroStats(state);
  assert.equal(stats.atk, game.HERO_BASE.atk);                                       // 新手武器沒有加成
  const { hero, loadout } = game.buildHero(state);
  assert.deepEqual(hero.skills.map(s => s.id), ['whirlwind']);
  assert.equal(loadout.normalAttackStat, 'atk');
  assert.equal(hero.normalAttack.actions[0].stat, 'atk');
});

test('same save + same seed = the same battle; replay reproduces the log line by line', () => {
  const state = withWhirlwind();
  const a = game.runBattle(state, ruins(3), 123);
  const b = game.runBattle(state, ruins(3), 123);
  assert.deepEqual(messages(a.logs), messages(b.logs));
  assert.deepEqual(messages(game.replayBattle(a.record).logs), messages(a.logs));
  assert.notDeepEqual(messages(game.runBattle(state, ruins(3), 124).logs), messages(a.logs));
  assert.equal(a.record.seed, 123);
  assert.deepEqual(a.record.target, ruins(3));
  assert.deepEqual(save.importSave(a.record.snapshot), state);                       // 快照是戰鬥前的存檔
});

test('a win grants drops and energy into the new save; the old save is untouched', () => {
  const state = withWhirlwind();
  const result = game.runBattle(state, ruins(1), 5);
  assert.equal(result.victory, true);
  assert.ok(result.drops.engravings.length >= 1);
  assert.equal(result.save.energy, state.energy + result.drops.energy);
  const count = s => Object.values(s.engravings).reduce((a, b) => a + b, 0);
  assert.equal(count(result.save), count(state) + result.drops.engravings.length);
  assert.equal(count(state), 0);
});

test('a loss grants nothing and returns the same save', () => {
  const state = withWhirlwind();
  const result = game.runBattle(state, ruins(15), 1);
  assert.equal(result.victory, false);
  assert.equal(result.drops, null);
  assert.equal(result.save, state);
});

test('boss fights use the boss difficulty and record the first clear once', () => {
  // 把角色變強到一定贏：直接改基礎屬性（只在這個測試）
  const original = { ...game.HERO_BASE };
  Object.assign(game.HERO_BASE, { hp: 1e6, atk: 5000 });
  try {
    const state = withWhirlwind();
    const first = game.runBattle(state, { kind: 'boss', id: 'gatekeeper' }, 9);
    assert.equal(first.victory, true);
    assert.equal(first.difficulty, 6);
    assert.equal(first.firstClear, true);
    assert.deepEqual(first.rewards.gems, ['pursuit']);
    assert.equal(first.save.gems.pursuit, 1);
    assert.ok(first.drops.engravings.length >= 2);                                     // 王戰比照菁英多 1 個
    const again = game.runBattle(first.save, { kind: 'boss', id: 'gatekeeper' }, 10);
    assert.equal(again.firstClear, false);
    assert.equal(again.save.gems.pursuit, 1);
  } finally {
    Object.assign(game.HERO_BASE, original);
  }
});

test('bad targets are refused before fighting', () => {
  const state = newGame();
  assert.throws(() => game.runBattle(state, { kind: 'region', id: 'moon', difficulty: 1 }, 1), /找不到地區/);
  assert.throws(() => game.runBattle(state, ruins(0), 1), /難度/);
  assert.throws(() => game.runBattle(state, { kind: 'boss', id: 'nope' }, 1), /找不到王/);
  assert.throws(() => game.runBattle(state, { kind: 'dungeon' }, 1), /戰鬥目標/);
  assert.throws(() => game.runBattle(state, ruins(1), 1.5), /種子/);
});

test('region preview lists monsters and skills unlocked at that difficulty; battle text skips empty lines', () => {
  assert.deepEqual(game.regionPreview('ruins', 1).map(m => m.name), ['憤怒野犬', '守衛魔法陣', '地精']);
  assert.deepEqual(game.regionPreview('ruins', 7).find(m => m.id === 'dog').skills, ['撕咬', '狂吠']);
  assert.equal(game.regionPreview('ruins', 7).find(m => m.id === 'golem').rarity, 'elite');
  assert.equal(game.battleText([{ message: 'a' }, { message: '' }, { message: 'b' }], '標題'), '標題\na\nb');
});

test('player name: default 玩家, rename trims, empty or too long is refused, battles use the name', () => {
  const state = game.createNewGame();
  assert.equal(game.playerName(state), '玩家');
  const renamed = save.setPlayerName(state, '  阿明 ');
  assert.equal(game.playerName(renamed), '阿明');
  assert.equal(game.playerName(state), '玩家');
  assert.throws(() => save.setPlayerName(state, '   '), /名字不能是空的/);
  assert.throws(() => save.setPlayerName(state, 'x'.repeat(save.PLAYER_NAME_MAX + 1)), /最多/);
  assert.equal(save.importSave(save.exportSave(renamed)).settings.playerName, '阿明');
  assert.throws(() => save.importSave(JSON.stringify({ ...renamed, settings: { ...renamed.settings, playerName: '' } })));
  const { hero } = game.prepareBattle(renamed, { kind: 'region', id: 'ruins', difficulty: 1 }, 5);
  assert.equal(hero.name, '阿明');
});

test('strength level 1～5 starts at difficulty 1, 4, 7, 10, 13', () => {
  assert.deepEqual([1, 3, 4, 6, 7, 10, 12, 13, 15].map(game.strengthLevel), [1, 1, 2, 2, 3, 4, 4, 5, 5]);
});

test('opening shows enemy HP; the end summary replaces the BATTLE_END line with the winner HP', () => {
  const state = withWhirlwind();
  const result = game.runBattle(state, ruins(1), 7);
  assert.equal(result.opening.length, result.enemies.length);
  for (const e of result.opening) assert.ok(e.hp > 0 && e.hp === e.maxHp);
  const hero = result.final.find(e => e.team === 'A');
  if (result.victory) assert.equal(result.summary, `勝利，剩餘 HP：${hero.name} ${hero.hp} / ${hero.maxHp}`);
  const text = game.battleText(result.logs, 'x', result.summary);
  assert.ok(!text.includes('戰鬥結束，獲勝方'));
  assert.ok(text.endsWith(result.summary));
  assert.equal(game.battleText(result.logs, 'x').includes('戰鬥結束，獲勝方'), true);
  const replay = game.replayBattle(result.record);
  assert.deepEqual(replay.final, result.final);
  assert.equal(replay.summary, result.summary);
  const final = [{ team: 'A', name: '玩家', hp: 0, maxHp: 3000, alive: false }, { team: 'B', name: '野犬', hp: 120, maxHp: 900, alive: true }, { team: 'B', name: '地精', hp: 0, maxHp: 500, alive: false }];
  assert.equal(game.endSummary('TEAM_B', final), '敗北，敵方剩餘 HP：野犬 120 / 900');
  assert.equal(game.endSummary('DRAW', [{ ...final[0], hp: 5, alive: true }, final[1]]), '平手，剩餘 HP：玩家 5 / 3000｜敵方 野犬 120 / 900');
});
