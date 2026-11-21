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

// ── 共鳴 ──────────────────────────────────────────────────

test('resonance: 4 stacks only show a badge; the 5th bursts for 8% max HP, resets, and leaves a monster vulnerable', () => {
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
  assert.equal(hp - m.stats.hp, Math.round(m.stats.maxHp * RESONANCE.burstRatio));
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
  assert.equal(hp - hero.stats.hp, Math.round(hero.stats.maxHp * RESONANCE.burstRatio));
  assert.ok(!hero.buffs.some(b => b.id === 'resonance_vulnerable'));
  const battle = game.prepareBattle(withHall(newGame()), hall(3), 7);
  for (const unit of [...battle.engine.teamA, ...battle.engine.teamB]) assert.ok(unit.passives.some(p => p.id === 'resonance'), unit.name);
  const ruins = game.prepareBattle(newGame(), { kind: 'region', id: 'ruins', difficulty: 3 }, 7);
  assert.ok(!ruins.engine.teamA[0].passives.some(p => p.id === 'resonance'));
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

test('fircha: atk weapon with eva + counter points and counter power ×2, gives the hero a counter passive', () => {
  const def = LEGENDARIES.fircha;
  assert.equal(def.name, '氣鳴楯【菲爾查哈】');
  assert.deepEqual([def.area, def.attackStat], [2, 'atk']);
  assert.ok(def.mechanics.some(m => m.type === 'counterPower' && m.power === 2));
  let state = newGame();
  const added = save.addLegendary(state, 'fircha', 15, () => 0.9999999);
  state = save.equip(added.save, added.id);
  assert.ok(game.heroStats(state).evadeCounter > 0);
  const passive = game.buildHero(state).hero.passives.find(p => p.id === 'player_evade_counter');
  assert.ok(passive);
  assert.equal(passive.trigger, 'AFTER_EVADE');
});

test('cranelance: int weapon whose spell skills ramp each damage action by +15%', () => {
  const def = LEGENDARIES.cranelance;
  assert.equal(def.name, '撥弦槍【鶴之聲援】');
  assert.deepEqual([def.area, def.attackStat], [2, 'int']);
  let state = newGame();
  const added = save.addLegendary(state, 'cranelance', 15, () => 0.9999999);
  state = save.equip(added.save, added.id);
  // 目前的法術都是一段；連結「迅擊」變兩段，第二段 ×1.15
  const links = [{ active: 'magicmissile', supports: ['multistrike'] }];
  state = save.setLinks(save.addGems(state, 'multistrike'), added.id, links);
  const staff = newGame().equipment[1].id;
  const plain = save.setLinks(save.addGems(save.equip(newGame(), staff), 'multistrike'), staff, links);
  const powers = s => game.buildHero(s).hero.skills[0].actions.filter(a => a.type === 'DAMAGE').map(a => a.power);
  const base = powers(plain), ramped = powers(state);
  assert.ok(base.length > 1);
  ramped.forEach((p, k) => assert.ok(Math.abs(p - base[k] * (1 + 0.15 * k)) < 1e-3, `第 ${k} 段`));
});

test('area-2 legendaries never drop in area 1', () => {
  const { pickLegendary } = require('./legendaryTable');
  for (let i = 0; i < 100; i++) assert.ok(!['fircha', 'cranelance'].includes(pickLegendary(() => i / 100)));
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(pickLegendary(() => i / 100, 2));
  assert.ok(seen.has('fircha') && seen.has('cranelance'));
});
