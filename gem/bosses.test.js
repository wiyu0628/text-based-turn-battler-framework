const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BOSSES, findBoss, buildBossEncounter } = require('./bosses');
const { REGIONS } = require('./monsters');
const { strength } = require('./difficulty');
const save = require('./saveLayer');

const starter = () => save.createStarterSave({ now: '2026-01-01T00:00:00Z' });

const { buildFromDef } = require('./monsters');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const quietLogger = () => { const logs = []; return { logs, addLog: entry => logs.push(entry) }; };

test('第一隻王是「廢都中央廳」（使用者設計，2026-11-20）：難度 6、id 沿用 gatekeeper、獎勵不變', () => {
  const boss = BOSSES[0];
  assert.equal(boss.id, 'gatekeeper');
  assert.equal(boss.name, '廢都中央廳');
  assert.equal(boss.difficulty, 6);
  assert.equal(boss.placeholder, undefined);
  assert.deepEqual(boss.rewards.gems, ['pursuit', 'firestorm']);
  const { monsters, difficulty } = buildBossEncounter(boss.id);
  assert.equal(difficulty, 6);
  assert.equal(monsters.length, 1);
  assert.equal(monsters[0].name, '中央廳');
  assert.equal(monsters[0].stats.maxHp, Math.round(Math.round(3000 * boss.monsters[0].stats.hp) * strength(6)));
  assert.throws(() => findBoss('nope'), /找不到王/);
});

test('中央廳的招式：普攻開頭、電光（開場一句＋群體法術＋命中才麻痺）、五重魔法飛彈（每發各自隨機挑目標）', () => {
  const [hall] = buildBossEncounter('gatekeeper').monsters;
  assert.equal(hall.normalAttack.actions[0].stat, 'atk');
  assert.equal(hall.normalAttack.actions[0].text.action, '中央廳的雕像揮出長矛，');
  const lightning = hall.skills.find(s => s.name === '電光');
  assert.deepEqual(lightning.actions.map(a => a.type), ['TEXT', 'DAMAGE', 'BUFF']);
  assert.equal(lightning.actions[0].text.action, '中央廳地板上的魔法陣高速運轉，無數道雷光從魔法陣竄出——');
  assert.equal(lightning.actions[1].targetType, 'ENEMY_ALL');
  assert.equal(lightning.actions[1].stat, 'int');
  assert.equal(lightning.actions[1].uncritable, true);
  assert.equal(lightning.actions[1].text.action, '雷光穿過');
  assert.equal(lightning.actions[1].text.hit({ target: { name: '玩家' }, value: 12 }), '玩家，造成了 12 點傷害！');
  assert.equal(lightning.actions[2].requiresDamage, true);
  assert.equal(lightning.actions[2].text.buff({ target: { name: '玩家' } }), '玩家的手腳一陣麻痺！');
  const stats = { spd: 200 };
  lightning.actions[2].buffs[0].effect(stats);
  assert.equal(stats.spd, 200 * BOSSES[0].monsters[0].skills[0].debuff.mult);
  const missiles = hall.skills.find(s => s.name === '五重魔法飛彈');
  assert.equal(missiles.actions[0].type, 'TEXT');
  const shots = missiles.actions.slice(1);
  assert.equal(shots.length, 5);
  assert.deepEqual(shots.map(a => a.text.action), ['第一發，', '第二發，', '第三發，', '第四發，', '第五發，']);
  assert.ok(shots.every(a => a.inheritTarget === false && a.targetType === 'ENEMY_SINGLE' && a.stat === 'int'));
});

test('轉階段：血量第一次低於一半時速度與攻擊提高、召喚應急動力源（18% 生命、同防禦、減傷 40%、只會扣 SP、跟著王消失）', () => {
  const def = BOSSES[0].monsters[0];
  const [hall] = buildBossEncounter('gatekeeper').monsters;
  const hero = new Entity({ id: 'h', name: '玩家', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }),
    stats: { hp: 1000, maxHp: 1000, atk: 10, def: 0, spd: 100 } });
  const engine = new BattleEngine([hero], [hall], { rng: createSeededRandom(1) });
  const logger = quietLogger();
  const phase = hall.passives.find(p => p.id === 'monster_phase:centralhall');
  const before = hall.getEffectiveStats();
  hall.stats.hp = Math.floor(hall.stats.maxHp * 0.6);
  assert.equal(phase.enabled(hall), false);
  hall.stats.hp = Math.floor(hall.stats.maxHp * 0.49);
  assert.equal(phase.enabled(hall), true);
  phase.action(hall, {}, logger, engine);
  assert.equal(phase.enabled(hall), false);                                          // 只轉一次
  const after = hall.getEffectiveStats();
  assert.ok(Math.abs(after.spd - before.spd * def.traits[0].mults.spd) < 1);
  assert.ok(Math.abs(after.atk - before.atk * def.traits[0].mults.atk) < 1);
  assert.ok(Math.abs(after.int - before.int * def.traits[0].mults.int) < 1);
  const source = engine.teamB.find(e => e.phaseSource);
  assert.ok(source);
  assert.equal(source.name, '應急動力源');
  assert.equal(source.stats.maxHp, Math.round(hall.stats.maxHp * 0.18));
  assert.equal(source.stats.def, hall.stats.def);
  assert.equal(source.actionDisabled, false);
  assert.equal(source.normalAttack.name, '魔力汲取');
  assert.equal(source.stats.skillCastRate, 0);
  assert.equal(source.takeDamage(1000, logger, { action: { type: 'DAMAGE' } }).damage, 600);   // 攻擊傷害減 40%
  assert.equal(logger.logs.length, 2);                                               // 轉階段旁白＋召喚
  hall.stats.hp = 0; hall.isAlive = false;
  assert.equal(source.isAlive, false);                                               // 王倒下，動力源一起消失
});

test('應急動力源被打倒後，在下一個行動結束時對中央廳造成其最大生命 30% 的傷害（只一次）', () => {
  const [hall] = buildBossEncounter('gatekeeper').monsters;
  const hero = new Entity({ id: 'h', name: '玩家', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }),
    stats: { hp: 1000, maxHp: 1000, atk: 10, def: 0, spd: 100 } });
  const engine = new BattleEngine([hero], [hall], { rng: createSeededRandom(1) });
  const logger = quietLogger();
  hall.stats.hp = Math.floor(hall.stats.maxHp * 0.49);
  hall.passives.find(p => p.id === 'monster_phase:centralhall').action(hall, {}, logger, engine);
  const check = hall.passives.find(p => p.id === 'monster_phase_break:centralhall');
  const hp = hall.stats.hp;
  check.action(hall, {}, logger, engine);
  assert.equal(hall.stats.hp, hp);                                                   // 動力源還在：沒事
  const source = engine.teamB.find(e => e.phaseSource);
  source.stats.hp = 0; source.isAlive = false;
  check.action(hall, {}, logger, engine);
  assert.equal(hall.stats.hp, hp - Math.round(hall.stats.maxHp * 0.3));
  check.action(hall, {}, logger, engine);
  assert.equal(hall.stats.hp, hp - Math.round(hall.stats.maxHp * 0.3));              // 只一次
  assert.ok(logger.logs.some(l => l.message === '從應急動力源傾瀉而出的魔力反噬了中央廳的線路！'));
});

test('旁白：開戰印 opening；中央廳倒下印 death、打贏印 victory（一整場戰鬥）', () => {
  const texts = BOSSES[0].monsters[0].texts;
  const run = heroAtk => {
    const [hall] = buildBossEncounter('gatekeeper').monsters;
    const hero = new Entity({ id: 'h', name: '玩家', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }),
      stats: { hp: heroAtk > 1000 ? 1e6 : 10, maxHp: heroAtk > 1000 ? 1e6 : 10, atk: heroAtk, def: 0, spd: 300, hit: 1000 } });
    const engine = new BattleEngine([hero], [hall], { rng: createSeededRandom(2), maxTurns: 60, hitFormula: 'contest' });
    const result = engine.start();
    return { result, messages: engine.logger.logs.map(l => l.message) };
  };
  const win = run(1e5);
  assert.equal(win.result.winner, 'TEAM_A');
  for (const line of texts.opening) assert.ok(win.messages.includes(line.replaceAll('{player}', '玩家')), line);
  assert.ok(win.messages.includes('玩家走進殿堂的那一刻，燈光一齊亮了起來，空曠的大廳、持矛的雕像以及無數精細的魔力刻痕映入眼簾。'));
  assert.ok(win.messages.includes(texts.death));
  assert.ok(!win.messages.includes(texts.victory));
  const lose = run(1);
  assert.equal(lose.result.winner, 'TEAM_B');
  assert.ok(lose.messages.includes(texts.victory));
  assert.ok(!lose.messages.includes(texts.death));
});

test('enrage（舊守門者用的特性，保留）：血量低於 at 時某屬性提高到戰鬥結束，只一次', () => {
  const boss = buildFromDef({ id: 'oldkeeper', name: '廢都守門者', stats: { hp: 1.6, atk: 0.8, def: 80, spd: 170 }, skills: [],
    traits: [{ kind: 'enrage', at: 0.3, stat: 'atk', mult: 1.3, text: '{caster} 的眼中燃起紅光，攻勢變得更加猛烈！' }] }, 6);
  const enrage = boss.passives.find(p => p.trigger === 'AFTER_DAMAGE_RECEIVED');
  const logger = quietLogger();
  const atk = boss.getEffectiveStats().atk;
  boss.stats.hp = Math.floor(boss.stats.maxHp * 0.5);
  assert.equal(enrage.enabled(boss), false);
  boss.stats.hp = Math.floor(boss.stats.maxHp * 0.2);
  assert.equal(enrage.enabled(boss), true);
  enrage.action(boss, {}, logger);
  assert.ok(Math.abs(boss.getEffectiveStats().atk - atk * 1.3) < 1);
  assert.equal(enrage.enabled(boss), false);
  assert.match(logger.logs[0].message, /廢都守門者 的眼中燃起紅光/);
  for (let i = 0; i < 10; i++) boss.tickBuffs();
  assert.ok(Math.abs(boss.getEffectiveStats().atk - atk * 1.3) < 1);
});

test('bosses unlock in order, old ones stay available; first clear gives rewards once', () => {
  const extra = { id: 'test_second', name: '第二隻王', difficulty: 9, monsters: [], rewards: { gems: [], unlockRegions: ['test_region'] } };
  BOSSES.push(extra);
  REGIONS.test_region = { id: 'test_region', name: '測試區', locked: true, count: [1, 1], budget: 1, monsters: ['dog'] };
  try {
    let state = starter();
    assert.deepEqual(save.bossStatus(state).map(b => [b.id, b.defeated, b.available]), [['gatekeeper', false, true], ['test_second', false, false]]);
    assert.throws(() => save.recordBossVictory(state, 'test_second'), /還沒開放/);
    assert.deepEqual(save.availableRegions(state), ['ruins', 'sewer']);
    const first = save.recordBossVictory(state, 'gatekeeper');
    assert.equal(first.firstClear, true);
    assert.equal(first.save.gems.pursuit, 1);
    assert.equal(first.save.gems.firestorm, 1);
    assert.equal(state.gems.pursuit, undefined);                              // 原存檔不變
    state = first.save;
    assert.deepEqual(save.bossStatus(state).map(b => b.available), [true, true]);
    const again = save.recordBossVictory(state, 'gatekeeper');
    assert.equal(again.firstClear, false);
    assert.equal(again.save.gems.pursuit, 1);                                 // 不重複發
    const second = save.recordBossVictory(state, 'test_second');
    assert.deepEqual(second.rewards.unlockRegions, ['test_region']);
    assert.deepEqual(save.availableRegions(second.save), ['ruins', 'sewer', 'test_region']);
    assert.throws(() => save.recordBossVictory(state, 'nope'), /找不到王/);
  } finally {
    BOSSES.pop();
    delete REGIONS.test_region;
  }
});

test('應急動力源的魔力汲取：讓主角失去 6 點 SP（不夠扣到 0），不造成傷害；旁白的 {player} 用玩家改過的名字', () => {
  const [hall] = buildBossEncounter('gatekeeper').monsters;
  const hero = new Entity({ id: 'hero', name: '艾琳', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }),
    stats: { hp: 1000, maxHp: 1000, atk: 10, def: 0, spd: 100, sp: 10, maxSp: 100 } });
  const engine = new BattleEngine([hero], [hall], { rng: createSeededRandom(1) });
  const logger = quietLogger();
  hall.stats.hp = Math.floor(hall.stats.maxHp * 0.49);
  hall.passives.find(p => p.id === 'monster_phase:centralhall').action(hall, {}, logger, engine);
  const source = engine.teamB.find(e => e.phaseSource);
  source.normalAttack.execute(source, engine.teamB, engine.teamA, logger, engine);
  assert.equal(hero.stats.sp, 4);
  assert.equal(hero.stats.hp, 1000);
  assert.equal(logger.logs.at(-1).message, '應急動力源吸收了艾琳的6點SP。');
  source.normalAttack.execute(source, engine.teamB, engine.teamA, logger, engine);
  assert.equal(hero.stats.sp, 0);
  assert.equal(logger.logs.at(-1).message, '應急動力源吸收了艾琳的4點SP。');
  const opening = hall.passives.find(p => p.id === 'monster_text_opening');
  const lines = quietLogger();
  opening.action(hall, {}, lines, engine);
  assert.ok(lines.logs.some(l => l.message.startsWith('艾琳走進殿堂的那一刻')));
});
