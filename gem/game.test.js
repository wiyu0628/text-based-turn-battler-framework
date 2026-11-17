const { test } = require('node:test');
const assert = require('node:assert/strict');
const game = require('./game');
const save = require('./saveLayer');

const ruins = difficulty => ({ kind: 'region', id: 'ruins', difficulty });
const messages = logs => logs.map(log => log.message);
const newGame = () => game.createNewGame({ now: '2026-01-01T00:00:00Z' });
const withWhirlwind = () => { const state = newGame(); return save.setLinks(state, state.equipped.weapon, [{ active: 'whirlwind', supports: [] }]); };

test('a new game has the starting active gems and a worn starter weapon that can hold links', () => {
  const state = newGame();
  const weapon = state.equipment.find(item => item.id === state.equipped.weapon);
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
  assert.equal(stats.atk, game.HERO_BASE.atk + 20);
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
