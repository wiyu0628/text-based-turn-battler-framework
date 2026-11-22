const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSeededRandom } = require('../src');
const game = require('./game');
const save = require('./saveLayer');
const { MONSTERS, REGIONS, buildMonster, rollEncounter, evadeCounterChance } = require('./monsters');
const { RESONANCE, addResonance } = require('./resonance');
const { LEGENDARIES } = require('./legendaryTable');
const { ENGRAVING_TYPES, canEngrave } = require('./affixTable');
const { rollDrops } = require('./dropTable');

// 第二區「和聲音樂廳」（2026-11-21）：共鳴、三種怪、玩家閃避反擊、迴音刻印、兩把傳說

const quiet = () => { const logs = []; return { logs, addLog: l => logs.push(l) }; };
const hall = difficulty => ({ kind: 'region', id: 'hall', difficulty });
const withHall = state => ({ ...state, progress: { ...state.progress, unlockedRegions: [...state.progress.unlockedRegions, 'hall'] } });
const newGame = () => game.createNewGame({ now: '2026-01-01T00:00:00Z' });
const text = logs => logs.map(l => l.message).join('\n');
const burst = e => Math.round(e.stats.maxHp * RESONANCE.burstRatio * 300 / (e.getEffectiveStats().def + 300));   // 吃防禦

// ── 共鳴 ──────────────────────────────────────────────────

test('resonance: 4 stacks only show a badge; the 5th bursts for max HP × ratio reduced by defense, resets, and leaves a monster vulnerable', () => {
  const m = buildMonster('conductor', 5);
  const logger = quiet();
  for (let i = 0; i < 4; i++) assert.equal(addResonance(m, 1, logger, null), false);
  assert.equal(m.resonance, 4);
  assert.equal(m.buffs.find(b => b.id === 'resonance_badge').name, '共鳴 ×4');
  assert.equal(m.buffs.find(b => b.id === 'resonance_badge').dispellable, false);
  const hp = m.stats.hp;
  assert.equal(addResonance(m, 1, logger, null), true);
  assert.equal(m.resonance, 0);
  assert.ok(!m.buffs.some(b => b.id === 'resonance_badge'));
  assert.equal(hp - m.stats.hp, burst(m));
  assert.ok(burst(m) < Math.round(m.stats.maxHp * RESONANCE.burstRatio));
  const vul = m.buffs.find(b => b.id === 'resonance_vulnerable');
  assert.equal(vul.damageTaken.multiplier, 1 + RESONANCE.vulnerable);
  assert.equal(vul.dispellable, true);
  assert.match(text(logger.logs), /共鳴爆發了！[\s\S]*易傷/);
});

test('resonance burst on a monster with damage reduction strips the reduction instead of adding vulnerability', () => {
  const m = buildMonster('conductor', 5);
  m.addBuff({ id: 'guard', name: '防禦', type: 'STAT', duration: 3, effect: () => {}, damageTaken: { multiplier: 0.6 } }, null);
  const logger = quiet();
  addResonance(m, RESONANCE.stacks, logger, null);
  assert.ok(!m.buffs.some(b => b.id === 'guard'));
  assert.ok(!m.buffs.some(b => b.id === 'resonance_vulnerable'));
  assert.match(text(logger.logs), /減傷被震散/);
});

test('resonance hits the player too (burst damage only, no vulnerability) and is wired into hall battles on both sides', () => {
  const { hero } = game.buildHero(newGame());
  const hp = hero.stats.hp;
  addResonance(hero, 5, quiet(), null);
  assert.equal(hp - hero.stats.hp, burst(hero));
  assert.ok(!hero.buffs.some(b => b.id === 'resonance_vulnerable'));
  const battle = game.prepareBattle(withHall(newGame()), hall(3), 7);
  for (const unit of [...battle.engine.teamA, ...battle.engine.teamB]) assert.ok(unit.hasResonance, unit.name);
  const ruins = game.prepareBattle(newGame(), { kind: 'region', id: 'ruins', difficulty: 3 }, 7);
  assert.ok(!ruins.engine.teamA[0].hasResonance);
});

test('every hit that is not evaded stacks resonance, even one fully absorbed by a shield; misses and DOT do not', () => {
  const { Skill, BattleEngine } = require('../src');
  const { applyResonance } = require('./resonance');
  const { hero } = game.buildHero(newGame());
  const foe = buildMonster('conductor', 5);
  applyResonance([hero, foe]);
  const engine = new BattleEngine([hero], [foe], { rng: () => 0.5 });
  const logger = quiet();
  const hit = new Skill({ id: 't', name: '測試', actions: [{ type: 'DAMAGE', power: 1, ignoreEvasion: true }] });
  foe.addBuff({ id: 'wall', name: '大盾', duration: 9, shield: 1e9 }, engine);
  const hp = foe.stats.hp;
  hit.execute(hero, [hero], [foe], logger, engine, { targets: [foe], ignoreSp: true });
  assert.equal(foe.stats.hp, hp);                       // 血沒少
  assert.equal(foe.resonance, 1);                       // 但有疊層
  foe.takeDamage(100, logger, { source: 'DIRECT' });
  foe.finishDamage(foe.takeDamage(1, logger, {}), logger, engine);
  assert.equal(foe.resonance, 1);                       // 直接傷害不疊
});

test('summons get resonance too: the phantom axe phantom in the hall, but not in area 1', () => {
  let state = withHall(newGame());
  const added = save.addLegendary(state, 'phantomaxe', 15, () => 0.9999999);
  state = save.setLinks(save.equip(added.save, added.id), added.id, [{ active: 'whirlwind', supports: [] }]);
  const phantomOf = target => {
    const battle = game.prepareBattle(state, target, 5);
    battle.engine.start();
    return [...battle.engine.teamA].find(e => e.summonerId === 'hero');
  };
  assert.equal(phantomOf(hall(3)).hasResonance, true);
  assert.ok(!phantomOf({ kind: 'region', id: 'ruins', difficulty: 3 }).hasResonance);
});

// ── 地區與怪 ──────────────────────────────────────────────

test('hall is locked until the central hall is beaten; saves from v8 that beat it get it on load', () => {
  assert.ok(!save.availableRegions(newGame()).includes('hall'));
  assert.throws(() => game.prepareBattle(newGame(), hall(1), 1), /還沒開放/);
  const parsed = JSON.parse(save.exportSave(newGame()));
  parsed.version = 8; parsed.progress = { defeatedBosses: ['gatekeeper'], unlockedRegions: [], unlockedMonsters: [] };
  assert.ok(save.importSave(JSON.stringify(parsed)).progress.unlockedRegions.includes('hall'));
});

test('fairies always come at least two at a time', () => {
  const rng = createSeededRandom(99);
  for (let i = 0; i < 300; i++) {
    const { monsters } = rollEncounter('hall', 1 + (i % 15), rng);
    const fairies = monsters.filter(m => m.monsterId === 'fairy').length;
    assert.ok(fairies === 0 || fairies >= 2, `只有 ${fairies} 隻`);
    assert.ok(monsters.length >= REGIONS.hall.count[0] && monsters.length <= REGIONS.hall.count[1]);
  }
});

test('harmony chase: other fairies follow up at 40%; normal attacks chase only from difficulty 7', () => {
  const run = (difficulty, useSkill) => {
    const state = withHall(newGame());
    for (let seed = 1; seed < 200; seed++) {
      const battle = game.prepareBattle(state, hall(difficulty), seed);
      const fairies = battle.engine.teamB.filter(m => m.monsterId === 'fairy');
      if (fairies.length < 2) continue;
      const [a] = fairies;
      const logger = quiet();
      battle.engine.logger = logger;
      const skill = useSkill ? a.skills.find(s => s.id === 'fairy_harmony') : a.normalAttack;
      skill.execute(a, battle.engine.teamB, battle.engine.teamA, logger, battle.engine, { targets: [battle.engine.teamA[0]], ignoreSp: true });
      return { log: text(logger.logs), mates: fairies.length - 1 };
    }
    throw new Error('找不到兩隻妖精的組合');
  };
  const skill = run(3, true);
  assert.equal((skill.log.match(/應和著旋律追擊/g) ?? []).length, skill.mates);
  assert.ok(!/應和著旋律追擊/.test(run(3, false).log));
  assert.ok(/應和著旋律追擊/.test(run(7, false).log));
  assert.equal(MONSTERS.fairy.harmony.power, 0.4);
});

test('conductor cleanse removes dispellable negative buffs from allies but not the resonance badge', () => {
  const c = buildMonster('conductor', 5);
  const f = buildMonster('fairy', 5);
  f.addBuff({ id: 'slow', name: '緩速', type: 'STAT', duration: 3, effect: () => {}, polarity: 'negative', dispellable: true }, null);
  addResonance(f, 2, quiet(), null);
  const logger = quiet();
  c.skills.find(s => s.id === 'conductor_order').execute(c, [c, f], [], logger, null, { ignoreSp: true });
  assert.ok(!f.buffs.some(b => b.id === 'slow'));
  assert.equal(f.resonance, 2);
  assert.ok(f.buffs.some(b => b.id === 'resonance_badge'));
});

test('organ golem (elite, D7+) adds 1 resonance stack to everyone each round start', () => {
  const organ = buildMonster('organ', 7);
  assert.equal(MONSTERS.organ.rarity, 'elite');
  const field = organ.passives.find(p => p.id === 'monster_field_resonance');
  assert.equal(field.trigger, 'ROUND_START');
  const { hero } = game.buildHero(newGame());
  const other = buildMonster('fairy', 7);
  const engine = { teamA: [hero], teamB: [organ, other] };
  field.action(organ, null, quiet(), engine);
  assert.deepEqual([hero.resonance, organ.resonance, other.resonance], [1, 1, 1]);
});

test('cannon: charging marks itself and the next usable slot fires the 250% shot (resolver), which costs no SP', () => {
  const { monsterSkillResolver } = require('./monsters');
  const c = buildMonster('cannon', 3);
  const { hero } = game.buildHero(newGame());
  const { BattleEngine } = require('../src');
  const engine = new BattleEngine([hero], [c], { rng: () => 0.5 });
  const shell = c.skills.find(s => s.id === 'cannon_boom_charge');
  const sp = c.stats.sp;
  const logger = quiet();
  shell.execute(c, [c], [hero], logger, engine, {});
  assert.equal(sp - c.stats.sp, 15);
  assert.match(text(logger.logs), /卡農砲的砲管開始聚集音波……/);
  assert.ok(c.buffs.some(b => b.id === c.monsterCharge.markerId));
  const release = monsterSkillResolver({ caster: c, engine });
  assert.equal(release, c.monsterCharge.release);
  assert.equal(release.actions.find(a => a.type === 'DAMAGE').power, 2.5);
  assert.ok(!c.buffs.some(b => b.id === c.monsterCharge.markerId));
  assert.equal(monsterSkillResolver({ caster: c, engine }), undefined);   // 只換一次
  assert.equal(monsterSkillResolver({ caster: hero, engine }), undefined); // 玩家不受影響
  assert.ok(!c.skills.some(s => s.id === 'cannon_canon'));                 // 卡農從難度 7 起
});

test('canon: other allies (not the caster) repeat their last skill next slot; canon itself is never remembered', () => {
  const { monsterSkillResolver } = require('./monsters');
  const a = buildMonster('cannon', 7, { id: 'A', name: '卡農砲A' });
  const b = buildMonster('cannon', 7, { id: 'B', name: '卡農砲B' });
  const f = buildMonster('fairy', 7);
  const { hero } = game.buildHero(newGame());
  const { BattleEngine } = require('../src');
  const engine = new BattleEngine([hero], [a, b, f], { rng: () => 0.5 });
  const canonOf = m => m.skills.find(s => s.id === 'cannon_canon');
  assert.equal(canonOf(a).canCast(a, engine), false);                    // 還沒有隊友出過招
  f.skills[0].execute(f, [a, b, f], [hero], quiet(), engine, { targets: [hero] });
  canonOf(b).execute(b, [a, b, f], [hero], quiet(), engine, {});           // B 放卡農：B 自己不記
  assert.equal(b.lastSkill, undefined);
  assert.ok(f.canonPending && a.canonPending && !b.canonPending);
  assert.equal(monsterSkillResolver({ caster: f, engine }), f.skills[0]); // 妖精重複「和聲」
  assert.equal(monsterSkillResolver({ caster: a, engine }), undefined);   // A 沒出過招：照常
  canonOf(a).execute(a, [a, b, f], [hero], quiet(), engine, {});           // A 也放卡農：B 的上一招不是卡農，不會無限覆讀
  assert.equal(monsterSkillResolver({ caster: b, engine }), undefined);
  // 蓄力發射後被卡農重複＝直接再發射（使用者先選 B）
  a.monsterCharge.release.execute(a, [a, b, f], [hero], quiet(), engine, { targets: [hero] });
  canonOf(b).execute(b, [a, b, f], [hero], quiet(), engine, {});
  assert.equal(monsterSkillResolver({ caster: a, engine }), a.monsterCharge.release);
  // SP 不夠就照平常選
  f.canonPending = true; f.stats.sp = 0;
  assert.equal(monsterSkillResolver({ caster: f, engine }), undefined);
});

test('conductor: 強拍 (renamed), and from D10 獨奏 gives the highest-attack ally (not itself) an extra action that never picks 獨奏', () => {
  assert.equal(MONSTERS.conductor.skills.find(s => s.id === 'baton').name, '強拍');
  const c = buildMonster('conductor', 10);
  const f = buildMonster('fairy', 10);
  const k = buildMonster('cannon', 10);
  const { hero } = game.buildHero(newGame());
  const { BattleEngine } = require('../src');
  const engine = new BattleEngine([hero], [c, f, k], { rng: () => 0.5 });
  const inserted = [];
  engine.insertAction = (entity, skill) => inserted.push([entity, skill]);
  const solo = c.skills.find(s => s.id === 'conductor_solo');
  const logger = quiet();
  solo.execute(c, [c, f, k], [hero], logger, engine, {});
  const top = [f, k].sort((x, y) => y.stats.atk - x.stats.atk)[0];
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], top);
  assert.ok(!inserted[0][1].id.endsWith('_solo'));
  assert.match(text(logger.logs), new RegExp(`指揮家指向${top.name}，${top.name}開始了華麗的獨奏！`));
  assert.ok(!buildMonster('conductor', 9).skills.some(s => s.id === 'conductor_solo'));
  // 只有自己活著（沒有隊友）就不放
  assert.equal(solo.canCast(c, new BattleEngine([hero], [c], {})), false);
});

test('無序音符 (rare): never attacks; noise lowers atk and speed, rest silences, detune drains 10 SP, dissonance adds 2 resonance', () => {
  const def = MONSTERS.noise;
  assert.deepEqual([def.name, def.rarity], ['無序音符', 'rare']);
  const n = buildMonster('noise', 10);
  assert.equal(n.normalAttack.actions.some(a => a.type === 'DAMAGE'), false);       // 普攻位置是噪音
  assert.equal(n.normalAttack.actions.reduce((sum, a) => sum + (a.spCost ?? 0), 0), 0);
  assert.ok(n.skills.every(s => !s.actions.some(a => a.type === 'DAMAGE')));
  const { hero } = game.buildHero(newGame());
  const { BattleEngine } = require('../src');
  const { applyResonance } = require('./resonance');
  applyResonance([hero]);
  const engine = new BattleEngine([hero], [n], { rng: () => 0.5 });
  const use = id => n.skills.find(s => s.id === `noise_${id}`).execute(n, [n], [hero], quiet(), engine, { targets: [hero] });
  const { atk, spd } = hero.getEffectiveStats();
  use('noise');
  assert.equal(hero.getEffectiveStats().atk, atk * 0.8);
  assert.equal(hero.getEffectiveStats().spd, spd * 0.8);
  use('rest');
  assert.ok(hero.buffs.some(b => b.silence));
  const sp = hero.stats.sp;
  use('detune');
  assert.equal(sp - hero.stats.sp, 10);
  use('dissonance');
  assert.equal(hero.resonance, 2);
});

// ── 玩家閃避反擊、迴音刻印 ─────────────────────────────────

test('player evade counter exists only with counter points; chance follows the shared curve', () => {
  assert.ok(!game.buildHero(newGame()).hero.passives.some(p => p.id === 'player_evade_counter'));
  assert.equal(evadeCounterChance(0, 0), 0);                         // 0 點不反擊
  assert.ok(Math.abs(evadeCounterChance(60, 60) - 0.2) < 1e-9);      // 點數相同 20%
  assert.ok(evadeCounterChance(1e9, 0) <= 0.4 + 1e-9);
  assert.ok(evadeCounterChance(80, 0) > evadeCounterChance(0, 0));
});

test('resound engraving: eva / counter points / crit, helmet and boots only, drops only in area 2', () => {
  const def = ENGRAVING_TYPES.resound;
  assert.equal(def.name, '迴音');
  assert.equal(def.area, 2);
  assert.deepEqual(def.lines.map(l => l.stat), ['eva', 'evadeCounter', 'cri']);
  assert.deepEqual(['weapon', 'helmet', 'armor', 'boots'].filter(s => canEngrave('resound', s)), ['helmet', 'boots']);
  const rng = createSeededRandom(3);
  let area1 = 0, area2 = 0;
  for (let i = 0; i < 2000; i++) {
    area1 += rollDrops(10, rng).engravings.filter(e => e.type === 'resound').length;
    area2 += rollDrops(10, rng, { area: 2 }).engravings.filter(e => e.type === 'resound').length;
  }
  assert.equal(area1, 0);
  assert.ok(area2 > 0);
});

// ── 傳說 ──────────────────────────────────────────────────

test('fircha: atk + def base, eva / counter points / counter damage, counters ignore defense', () => {
  const def = LEGENDARIES.fircha;
  assert.equal(def.name, '氣鳴楯【菲爾查哈】');
  assert.deepEqual([def.area, def.attackStat], [2, 'atk']);
  assert.deepEqual(def.base.map(l => l.stat), ['atk', 'def']);
  assert.deepEqual(def.unique.map(l => l.stat), ['eva', 'evadeCounter', 'counterDmg']);
  let state = newGame();
  const added = save.addLegendary(state, 'fircha', 15, () => 0.9999999);
  state = save.equip(added.save, added.id);
  const stats = game.heroStats(state);
  assert.ok(stats.evadeCounter > 0 && stats.counterDmg > 0);
  const { hero } = game.buildHero(state);
  const passive = hero.passives.find(p => p.id === 'player_evade_counter');
  assert.equal(passive.trigger, 'AFTER_EVADE');
  // 反擊 = 攻擊 × (1 + 反擊傷害)、無視防禦：對高防禦的目標也照打
  const foe = buildMonster('organ', 15);
  foe.stats.def = 5000;
  const logger = quiet();
  const { BattleEngine } = require('../src');
  const engine = new BattleEngine([hero], [foe], { rng: () => 0 });
  const hp = foe.stats.hp;
  passive.action(hero, { caster: foe, skill: {}, action: {} }, logger, engine);
  const dealt = hp - foe.stats.hp;
  assert.match(text(logger.logs), /趁隙使用防禦性抓技反擊，這擊視防禦為無物，/);
  assert.ok(dealt > hero.stats.atk * (1 + stats.counterDmg) * 0.8, `只打了 ${dealt}`);
});

test('cranelance: int + SP base, int % and speed; chord builds on hits, drains on hits taken, and boosts spell damage', () => {
  const def = LEGENDARIES.cranelance;
  assert.equal(def.name, '撥弦槍【鶴之聲援】');
  assert.deepEqual([def.area, def.attackStat], [2, 'int']);
  assert.deepEqual(def.base.map(l => l.stat), ['int', 'sp']);
  assert.deepEqual(def.unique.map(l => [l.stat, l.op]), [['int', 'inc'], ['spd', 'flat']]);
  let state = newGame();
  const added = save.addLegendary(state, 'cranelance', 15, () => 0.9999999);
  state = save.setLinks(save.equip(added.save, added.id), added.id, [{ active: 'magicmissile', supports: [] }]);
  const { hero } = game.buildHero(state);
  const foe = buildMonster('organ', 15);
  const engine = { teamA: [hero], teamB: [foe] };
  const gain = hero.passives.find(p => p.id === 'gem_chord_gain');
  const loss = hero.passives.find(p => p.id === 'gem_chord_loss');
  assert.ok(gain.enabled(hero, { source: 'ATTACK' }));
  assert.ok(!gain.enabled(hero, { source: 'DOT' }));                     // 持續傷害不算
  for (let i = 0; i < 5; i++) gain.action(hero, { source: 'ATTACK' }, quiet(), engine);
  assert.ok(loss.enabled(hero, { source: 'ATTACK' }));
  assert.ok(!loss.enabled(hero, { source: 'DOT' }) && !loss.enabled(hero, { source: 'DIRECT' }));   // 只有被攻擊擊中才扣
  loss.action(hero);
  assert.equal(hero.gemChord, 19);
  // 法術傷害加算：和弦 100 點（+100%）的魔法飛彈明顯比較痛（傷害有浮動，所以比大差距）
  const cast = bonus => {
    const target = buildMonster('organ', 15);
    hero.gemChordBonus = bonus;
    const before = target.stats.hp;
    const { BattleEngine } = require('../src');
    const eng = new BattleEngine([hero], [target], { rng: () => 0.5 });
    hero.skills[0].execute(hero, [hero], [target], quiet(), eng, { targets: [target], ignoreSp: true });
    return before - target.stats.hp;
  };
  const plain = cast(0), boosted = cast(1);
  assert.ok(boosted > plain * 1.4, `${plain} → ${boosted}`);
});

test('chord boosts physical damage too: the normal attack and physical gem skills (2026-11-22)', () => {
  const { BattleEngine } = require('../src');
  let state = newGame();
  const added = save.addLegendary(state, 'cranelance', 15, () => 0.9999999);
  state = save.setLinks(save.equip(added.save, added.id), added.id, [{ active: 'rend', supports: [] }]);
  const { hero } = game.buildHero(state);
  hero.passives = hero.passives.filter(p => !String(p.id ?? '').startsWith('gem_chord'));   // 只看加成：不讓和弦自己累積、集滿加速
  const avg = (skill, bonus) => {
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const target = buildMonster('organ', 15);
      hero.gemChordBonus = bonus;
      const before = target.stats.hp;
      skill.execute(hero, [hero], [target], quiet(), new BattleEngine([hero], [target], { rng: () => 0.5 }), { targets: [target], ignoreSp: true });
      total += before - target.stats.hp;
    }
    return total / 30;
  };
  assert.ok(avg(hero.normalAttack, 1) > avg(hero.normalAttack, 0) * 1.6, '普攻');
  assert.ok(avg(hero.skills[0], 1) > avg(hero.skills[0], 0) * 1.4, '撕裂（物理寶石技能）');
});

test('a summon of ours being hit drains the owner chord by 1 (not while locked, not from DOT)', () => {
  const { linkChordSummon } = require('./chord');
  let state = newGame();
  const added = save.addLegendary(state, 'cranelance', 15, () => 0.9999999);
  state = save.equip(added.save, added.id);
  const { hero } = game.buildHero(state);
  const pet = buildMonster('fairy', 3);
  pet.team = 'A';
  pet.summonerId = hero.id;
  const engine = { teamA: [hero, pet], teamB: [] };
  linkChordSummon(pet, engine);
  hero.gemChord = 10;
  const link = pet.passives.find(p => p.id === 'gem_chord_summon_loss');
  assert.ok(!link.enabled(pet, { source: 'DOT' }));
  link.action(pet, { source: 'ATTACK' }, quiet());
  assert.equal(hero.gemChord, 9);
  hero.gemChordLeft = 2;                                   // 勝利的旋律期間鎖住
  link.action(pet, { source: 'ATTACK' }, quiet());
  assert.equal(hero.gemChord, 9);
  // 實戰：幻影戰斧的幻影也會接上
  let axe = withHall(newGame());
  const a2 = save.addLegendary(axe, 'phantomaxe', 15, () => 0.9999999);
  axe = save.equip(a2.save, a2.id);
  const battle = game.prepareBattle(axe, hall(3), 5);
  battle.engine.start();
  assert.ok(battle.engine.teamA.find(e => e.summonerId === 'hero').passives.some(p => p.id === 'gem_chord_summon_loss'));
});

test('chord at 100: line + buff text, heal 25%, cleanse, speed ×2 for 3 rounds, then back to 0', () => {
  let state = newGame();
  const added = save.addLegendary(state, 'cranelance', 15, () => 0.9999999);
  state = save.equip(added.save, added.id);
  const { hero } = game.buildHero(state);
  const engine = { teamA: [hero], teamB: [] };
  const [gain, loss, round] = ['gem_chord_gain', 'gem_chord_loss', 'gem_chord_round'].map(id => hero.passives.find(p => p.id === id));
  hero.stats.hp = Math.floor(hero.stats.maxHp / 2);
  hero.addBuff({ id: 'slow', name: '緩速', type: 'STAT', duration: 9, effect: () => {}, polarity: 'negative', dispellable: true }, null);
  const spd = hero.getEffectiveStats().spd;
  const logger = quiet();
  for (let i = 0; i < 25; i++) if (gain.enabled(hero, { source: 'ATTACK' })) gain.action(hero, { source: 'ATTACK' }, logger, engine);
  assert.equal(hero.gemChord, 100);
  assert.match(text(logger.logs), /我要奏響『勝利的旋律』來阻止你！」\n一陣激昂的樂聲迴盪在整個戰場，.*的腳步隨著樂聲加快了！\n「BreakNight」！/);
  assert.equal(hero.stats.hp, Math.floor(hero.stats.maxHp / 2) + Math.floor(hero.stats.maxHp * 0.25));
  assert.match(text(logger.logs), new RegExp(`「BreakNight」！\\n${hero.name} 回復了 ${Math.floor(hero.stats.maxHp * 0.25)} 點生命！`));
  assert.ok(!hero.buffs.some(b => b.id === 'slow'));
  assert.equal(hero.getEffectiveStats().spd, spd * 2);
  assert.ok(!loss.enabled(hero, { source: 'ATTACK' }) && !gain.enabled(hero, { source: 'ATTACK' }));   // 集滿後不增不減
  round.action(hero, {}, logger);                                               // 第 2 回合開始：還在
  round.action(hero, {}, logger);                                               // 第 3 回合開始：還在
  assert.equal(hero.getEffectiveStats().spd, spd * 2);
  round.action(hero, {}, logger);                                               // 第 4 回合開始：結束
  assert.equal(hero.getEffectiveStats().spd, spd);
  assert.equal(hero.gemChord, 0);
  assert.match(text(logger.logs), /歌曲結束了，戰場回復原先的平靜。$/);
});

test('v10: old fircha / cranelance are rerolled into the new lines at the same roll ratio', () => {
  const { TIER_SCALE } = require('./affixTable');
  const parsed = JSON.parse(save.exportSave(newGame()));
  parsed.version = 9;
  parsed.meta.nextId = 100;
  parsed.equipment.push({ id: 'eq99', slot: 'weapon', origin: 'drop', legendaryId: 'fircha', tier: 3, attackStat: 'atk', castWeight: 90, links: [],
    base: [{ stat: 'atk', op: 'flat', value: Math.round(372 * TIER_SCALE[3]) }], affixes: [{ stat: 'eva', op: 'flat', value: 1 }, { stat: 'evadeCounter', op: 'flat', value: 1 }] });
  const item = save.importSave(JSON.stringify(parsed)).equipment.find(e => e.id === 'eq99');
  assert.deepEqual(item.base.map(l => l.stat), ['atk', 'def']);
  assert.deepEqual(item.affixes.map(l => l.stat), ['eva', 'evadeCounter', 'counterDmg']);
  assert.equal(item.base[0].value, Math.round(LEGENDARIES.fircha.base[0].max * TIER_SCALE[3]));   // 原本滿骰 → 新的也滿骰
  assert.equal(item.castWeight, 90);
});

test('area-2 legendaries never drop in area 1', () => {
  const { pickLegendary } = require('./legendaryTable');
  for (let i = 0; i < 100; i++) assert.ok(!['fircha', 'cranelance'].includes(pickLegendary(() => i / 100)));
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(pickLegendary(() => i / 100, 2));
  assert.ok(seen.has('fircha') && seen.has('cranelance'));
});
