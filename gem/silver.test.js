const { test } = require('node:test');
const assert = require('node:assert/strict');
const game = require('./game');
const save = require('./saveLayer');
const { FIELD, SILVER, TEXTS } = require('./silver');

// 第二區王「老婦人 銀」（2026-11-22，使用者設計；數值與文本佔位）

const quiet = () => { const logs = []; return { logs, addLog: l => logs.push(l) }; };
const text = logs => logs.map(l => l.message).filter(Boolean).join('\n');
const unlocked = state => ({ ...state, progress: { ...state.progress, defeatedBosses: ['gatekeeper'], unlockedRegions: ['hall'] } });
const newGame = () => unlocked(game.createNewGame({ now: '2026-01-01T00:00:00Z' }));
const battle = (state = newGame(), seed = 3) => {
  const b = game.prepareBattle(state, { kind: 'boss', id: 'silver' }, seed);
  const silver = b.monsters.find(m => m.monsterId === 'silver');
  const passive = (entity, id) => entity.passives.find(p => p.id === id);
  // 跳過第 1 回合（第 2 回合開始的殘滅大魔術打完），之後銀才照平常選招
  const skipRound1 = () => passive(silver, 'silver_rounds').action(silver, { round: 2 }, quiet());
  return { ...b, silver, F: b.engine.fieldChord, passive, skipRound1 };
};

test('銀的王戰：銀、翅音蟲 ×2、和聲妖精 ×2；擊敗中央廳後開放', () => {
  assert.deepEqual(battle().monsters.slice(1, 3).map(m => m.name.replace(/\d+$/, '')), ['翅音蟲', '翅音蟲']);
  const { monsters } = battle();
  assert.deepEqual(monsters.map(m => m.monsterId), ['silver', 'wingbug', 'wingbug', 'fairy', 'fairy']);
  assert.deepEqual(save.bossStatus(game.createNewGame({ now: '2026-01-01T00:00:00Z' })).map(b => b.available), [true, false]);
});

test('場景和弦：起始 0（撥弦槍 50）；玩家每擊 +4、銀打中 −2、其他怪 −1；玩家傷害 ±1%／點', () => {
  const { hero, silver, monsters, F, passive } = battle();
  assert.equal(F.value, 0);
  const gain = passive(hero, 'gem_chord_gain'), loss = passive(hero, 'gem_chord_loss');
  gain.action(hero, { source: 'ATTACK' }, quiet());
  assert.equal(F.value, 4);
  loss.action(hero, { source: 'ATTACK', caster: silver }, quiet());
  loss.action(hero, { source: 'ATTACK', caster: monsters[1] }, quiet());
  assert.equal(F.value, 1);
  for (let i = 0; i < 10; i++) loss.action(hero, { source: 'ATTACK', caster: monsters[3] }, quiet());
  assert.equal(F.value, -9);
  assert.ok(Math.abs(hero.gemChordBonus + 0.09) < 1e-9);
  // 撥弦槍入場：起始 50
  let state = newGame();
  const added = save.addLegendary(state, 'cranelance', 15, () => 0.9999999);
  state = save.equip(added.save, added.id);
  const withLance = battle(state);
  assert.equal(withLance.F.value, FIELD.cranelanceStart);
  assert.ok(!withLance.hero.passives.some(p => p.id === 'gem_chord_round'));   // 撥弦槍的和弦被場景版取代
});

test('和弦到 50 印一次文本，直到勝利的旋律發動才會再印；集滿 100 發動玩家的勝利的旋律（3 回合）', () => {
  const { hero, F, passive } = battle();
  const gain = passive(hero, 'gem_chord_gain'), loss = passive(hero, 'gem_chord_loss');
  const logger = quiet();
  for (let i = 0; i < 13; i++) gain.action(hero, { source: 'ATTACK' }, logger);       // 52
  loss.action(hero, { source: 'ATTACK', caster: {} }, logger);                         // 51
  loss.action(hero, { source: 'ATTACK', caster: {} }, logger); loss.action(hero, { source: 'ATTACK', caster: {} }, logger);   // 49
  gain.action(hero, { source: 'ATTACK' }, logger);                                     // 53
  assert.equal(text(logger.logs).split(TEXTS.notice).length - 1, 1);
  for (let i = 0; i < 12; i++) if (gain.enabled(hero, { source: 'ATTACK' })) gain.action(hero, { source: 'ATTACK' }, logger);
  assert.equal(F.lock, 'player');
  assert.match(text(logger.logs), /我要奏響『勝利的旋律』來阻止你！/);
  assert.ok(!loss.enabled(hero, { source: 'ATTACK' }));                               // 鎖住
  const round = passive(hero, 'gem_field_round');
  round.action(hero, { round: 3 }, logger); round.action(hero, { round: 4 }, logger);
  assert.equal(F.lock, 'player');
  round.action(hero, { round: 5 }, logger);
  assert.deepEqual([F.lock, F.value], [null, 0]);
});

test('被動 1：銀扣的和弦累計 60 → 銀的勝利的旋律（−60 但玩家傷害不減、閃避所有攻擊、反擊加強）2 回合，結束變 0', () => {
  const { hero, silver, monsters, F, passive } = battle();
  const loss = passive(hero, 'gem_chord_loss');
  const logger = quiet();
  for (let i = 0; i < 70; i++) loss.action(hero, { source: 'ATTACK', caster: monsters[1] }, logger);   // 小怪扣的不算
  assert.equal(F.lock, null);
  assert.equal(F.lost60, 0);
  for (let i = 0; i < 30; i++) loss.action(hero, { source: 'ATTACK', caster: silver }, logger);
  assert.equal(F.lock, 'silver');
  assert.equal(F.value, FIELD.min);
  assert.equal(hero.gemChordBonus, 0);
  assert.ok(silver.buffs.some(b => b.untouchable));
  assert.deepEqual(silver.counterBoost, { points: SILVER.melodyBoost.points, power: SILVER.melodyBoost.power });
  const rounds = passive(silver, 'silver_rounds');
  rounds.action(silver, { round: 5 }, logger);
  assert.equal(F.lock, 'silver');
  rounds.action(silver, { round: 6 }, logger);
  assert.deepEqual([F.lock, F.value, F.lost60], [null, 0, 0]);
  assert.ok(!silver.buffs.some(b => b.untouchable));
  assert.deepEqual(silver.counterBoost, { points: 0, power: 1 });
});

test('被動 4：第 1 回合無敵不行動；第 2 回合開始解除並發動殘滅大魔術，之後每回合開始餘響', () => {
  const { engine, silver, passive } = battle();
  const logger = quiet();
  passive(silver, 'silver_round1').action(silver, {}, logger);
  assert.ok(silver.buffs.some(b => b.invincible));
  const idle = silver.gemResolver({ caster: silver });
  assert.equal(idle.id, 'silver_idle');
  idle.execute(silver, [silver], engine.teamA, logger, engine, {});
  assert.match(text(logger.logs), /銀沒有動，但是眼神從未從玩家的身上移開。/);
  passive(silver, 'silver_rounds').action(silver, { round: 2 }, logger);
  assert.ok(!silver.buffs.some(b => b.invincible));
  assert.equal(silver.gemResolver({ caster: silver }), undefined);
  assert.match(text(logger.logs), /銀詠唱殘滅大魔術，冷冽的空氣化為冰針刺穿了對手——\n冰針刺穿了肌膚，/);
  passive(silver, 'silver_rounds').action(silver, { round: 3 }, logger);
  assert.match(text(logger.logs), /殘滅大魔術留下的迴響再度襲來，/);
  void engine;
});

test('被動 2：第一次降到 50% 鎖血、無敵到下一個行動槽並舉盾；舉盾期間只會觀察或放下（放下後多行動一次）', () => {
  const { engine, silver, monsters, skipRound1 } = battle();
  skipRound1();
  const logger = quiet();
  const hit = silver.takeDamage(silver.stats.maxHp, logger, { source: 'DIRECT' });
  silver.finishDamage(hit, logger, engine);
  assert.equal(silver.stats.hp, Math.ceil(silver.stats.maxHp * 0.5));
  assert.ok(silver.buffs.some(b => b.id === 'silver_veil'));
  assert.ok(silver.skills.some(s => s.id === 'silver_ice') && silver.skills.some(s => s.id === 'silver_raise'));
  const raise = silver.gemResolver({ caster: silver });
  assert.equal(raise.id, 'silver_raise');
  assert.ok(!silver.buffs.some(b => b.id === 'silver_veil'));
  raise.execute(silver, monsters, [], quiet(), engine, {});
  assert.equal(silver.counterBoost.points, SILVER.shield.points);
  const inserted = [];
  engine.insertAction = (entity, skill) => inserted.push(skill);
  let lowered = null;
  for (let i = 0; i < 50 && !lowered; i++) {
    const next = silver.gemResolver({ caster: silver });
    assert.ok(['silver_guard', 'silver_lower'].includes(next.id));
    if (next.id === 'silver_lower') lowered = next;
  }
  lowered.execute(silver, monsters, [], quiet(), engine, {});
  assert.equal(inserted.length, 1);
  // 放下盾牌給的那一動不會再舉盾
  for (let i = 0; i < 30; i++) {
    const seen = [];
    const fake = { execute: () => {} };
    void fake;
    const { pickMonsterAction } = require('./monsters');
    seen.push(pickMonsterAction(silver, { rng: () => (i % 10) / 10, teamA: engine.teamA, teamB: engine.teamB, getSkillCastChance: () => 1 }, { exclude: 'raise' }).id);
    assert.notEqual(seen[0], 'silver_raise');
  }
  assert.equal(silver.counterBoost.points, 0);
  assert.equal(silver.gemResolver({ caster: silver }), undefined);
});

test('冰盾被打破時對打破的人造成傷害', () => {
  const { engine, hero, silver, skipRound1 } = battle();
  skipRound1();
  const logger = quiet();
  const hit = silver.takeDamage(silver.stats.maxHp, logger, { source: 'DIRECT' });
  silver.finishDamage(hit, logger, engine);
  silver.gemResolver({ caster: silver });                 // 下一個行動槽：解除無敵（這裡不舉盾）
  const ice = silver.skills.find(s => s.id === 'silver_ice');
  engine.insertAction = () => {};
  ice.execute(silver, [silver], [hero], logger, engine, {});
  const shield = silver.buffs.find(b => b.id === 'silver_ice');
  const amount = shield.shield.value;
  assert.equal(amount, Math.floor(silver.stats.maxHp * SILVER.ice.ratio));
  const hp = hero.stats.hp;
  const big = silver.takeDamage(amount + 10, logger, { source: 'ATTACK', caster: hero, action: { type: 'DAMAGE' } });
  silver.finishDamage(big, logger, engine);
  assert.ok(hero.stats.hp < hp);
  assert.match(text(logger.logs), new RegExp(`翅音圍繞在銀的身邊，化為一片片護甲，銀獲得了${amount}點護盾！`));
  assert.equal((text(logger.logs).match(/被擊碎的護甲承受了一部份衝擊，對 玩家 造成了/g) ?? []).length, 1);
});

test('整場跑得完：開場文本、勝負文本都會印', () => {
  const r = game.runBattle(newGame(), { kind: 'boss', id: 'silver' }, 1);
  const log = r.logs.map(l => l.message).join('\n');
  assert.match(log, /離開音樂廳的大門前，站著一位老婦人。/);
  assert.match(log, /向玩家這麼宣告。/);
  assert.match(log, r.victory ? /是你的心意（音色）贏了啊/ : /好好休息吧——如果能休息到永遠就好了。/);
});

test('銀的法術抗性：法術技能打銀 × 0.7（普攻不算）；舉盾期間所有攻擊再 × 0.8', () => {
  const { silver } = battle();
  const ward = silver.buffs.find(b => b.id === 'silver_spell_ward');
  assert.equal(ward.damageTaken.multiplier, SILVER.spellWard);
  assert.ok(ward.damageTaken.filter({ source: 'ATTACK', skill: { tags: ['spell'] } }));
  assert.ok(!ward.damageTaken.filter({ source: 'ATTACK', skill: { tags: [] } }));
  const take = () => { const before = silver.stats.hp; silver.takeDamage(1000, quiet(), { source: 'ATTACK', skill: { tags: ['spell'] }, action: { type: 'DAMAGE' } }); return before - silver.stats.hp; };
  assert.equal(take(), 700);
  // 舉盾：承受傷害再 × 0.8
  const { engine, monsters, skipRound1 } = battle();
  skipRound1();
  const s2 = monsters[0];
  const hit = s2.takeDamage(s2.stats.maxHp, quiet(), { source: 'DIRECT' });
  s2.finishDamage(hit, quiet(), engine);
  s2.gemResolver({ caster: s2 }).execute(s2, monsters, [], quiet(), engine, {});
  const shield = s2.buffs.find(b => b.id === 'silver_shield');
  assert.equal(shield.damageTaken.multiplier, SILVER.shield.damageTaken);
});

test('翅音蟲的捨身連擊：三連擊，打完自己受到造成傷害 30% 的反噬', () => {
  const { engine, hero, monsters } = battle();
  const bug = monsters[1];
  const skill = bug.skills.find(s => s.id === 'wingbug_reckless');
  assert.equal(skill.actions.find(a => a.type === 'DAMAGE').hits, 3);
  const logs = [];
  const logger = { logs, addLog: l => logs.push(l) };
  const hp = bug.stats.hp;
  skill.execute(bug, monsters, [hero], logger, engine, { targets: [hero], ignoreSp: true });
  const dealt = logs.filter(l => l.type === 'DAMAGE' && l.actorId === bug.id && l.targetId === hero.id).reduce((s, l) => s + l.value, 0);
  assert.ok(dealt > 0);
  assert.equal(hp - bug.stats.hp, Math.floor(dealt * 0.3));
  assert.match(text(logs), /翅音蟲\d?不顧一切地撞向玩家，[\s\S]*被反作用力震傷，損失了 \d+ 點生命！/);
});

test('「相對機動」的碎片：首次擊敗銀取得；玩家普攻連擊每擊倍率最低 10%（第 6 擊起才有差），召喚物不受影響', () => {
  const { ACCESSORIES } = require('./accessoryTable');
  assert.equal(ACCESSORIES.relative.name, '「相對機動」的碎片');
  let state = newGame();
  state = save.recordBossVictory(state, 'silver').save;
  assert.ok(state.accessories.owned.includes('relative'));
  const plain = game.buildHero(state).hero;
  state = { ...state, accessories: { ...state.accessories, equipped: 'relative' } };
  const { hero } = game.buildHero(state);
  const action = hero.normalAttack.actions[0];
  const decayAt = i => { action.text.combo({ caster: hero, hitIndex: i }); return action.damageDecay; };
  for (const i of [1, 2, 3, 4]) assert.ok(Math.abs(Math.pow(1 - decayAt(i), i) - Math.pow(0.6, i)) < 1e-9, `第 ${i + 1} 擊`);
  for (const i of [5, 8, 12]) assert.ok(Math.abs(Math.pow(1 - decayAt(i), i) - 0.1) < 1e-9, `第 ${i + 1} 擊`);
  assert.equal(plain.normalAttack.actions[0].damageDecay, undefined);   // 沒穿就照框架預設
  // 實戰：速度差很大時第 7 擊以後仍有第 1 擊的一成左右
  const { BattleEngine } = require('../src');
  const { buildMonster } = require('./monsters');
  hero.stats.spd = 3000;
  const foe = buildMonster('organ', 15);
  foe.stats.spd = 1; foe.stats.eva = 0; foe.stats.hp = foe.stats.maxHp = 1e9;
  const logs = [];
  hero.normalAttack.execute(hero, [hero], [foe], { logs, addLog: l => logs.push(l) }, new BattleEngine([hero], [foe], { rng: () => 0.5 }), { targets: [foe] });
  const values = logs.filter(l => l.type === 'DAMAGE' && l.value).map(l => l.value);
  assert.ok(values.length >= 8, `只打了 ${values.length} 擊`);
  // 傷害有 ±10% 浮動與暴擊：用第 7 擊以後的平均，和「第 1 擊、第 2 擊 ÷ 0.6」較小者估的基準比
  const baseline = Math.min(values[0], values[1] / 0.6);
  const later = values.slice(6);
  assert.ok(later.reduce((a, b) => a + b, 0) / later.length >= baseline * 0.07, JSON.stringify(values));
});
