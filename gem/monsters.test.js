const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, Formulas, createSeededRandom } = require('../src');
const { MONSTERS, REGIONS, RARE_CHANCE, ELITE_CHANCE, buildMonster, availableMonsters, rollEncounter } = require('./monsters');
const { strength, DEF_PER_LEVEL } = require('./difficulty');
const { rollDrops, RARE_BONUS, ELITE_BONUS } = require('./dropTable');

// ── 資料 ──────────────────────────────────────────────────

test('two regions, each with at least 5 monster kinds including exactly one rare and one elite', () => {
  assert.deepEqual(Object.keys(REGIONS), ['ruins', 'sewer']);
  assert.deepEqual(REGIONS.ruins.count, [1, 3]);
  assert.deepEqual(REGIONS.sewer.count, [2, 5]);
  for (const region of Object.values(REGIONS)) {
    const defs = region.monsters.map(id => MONSTERS[id]);
    assert.ok(defs.length >= 5 && defs.every(Boolean), region.id);
    assert.equal(defs.filter(d => d.rarity === 'rare').length, 1, region.id);
    assert.equal(defs.filter(d => d.rarity === 'elite').length, 1, region.id);
  }
  assert.deepEqual(REGIONS.ruins.monsters.map(id => MONSTERS[id].name), ['憤怒野犬', '守衛魔法陣', '修繕人偶', '地精', '自動魔像']);
});

test('difficulty unlocks new monsters and new skills', () => {
  assert.deepEqual(availableMonsters('ruins', 1).map(d => d.id), ['dog', 'circle', 'goblin']);
  assert.deepEqual(availableMonsters('ruins', 3).map(d => d.id), ['dog', 'circle', 'doll', 'goblin']);
  assert.deepEqual(availableMonsters('ruins', 7).map(d => d.id), ['dog', 'circle', 'doll', 'goblin', 'golem']);
  assert.deepEqual(availableMonsters('sewer', 7).map(d => d.id), ['rat', 'tentacle', 'slime', 'mimic', 'scavenger']);
  assert.deepEqual([1, 7, 13].map(d => buildMonster('dog', d).skills.map(s => s.name)), [['撕咬'], ['撕咬', '狂吠'], ['撕咬', '狂吠', '撲殺']]);
  assert.throws(() => availableMonsters('moon', 1), /地區/);
  assert.throws(() => buildMonster('dragon', 1), /怪物/);
});

test('monster stats = base × multiplier × difficulty strength; spell monsters use int and cannot crit or be countered', () => {
  const dog = buildMonster('dog', 10);
  assert.equal(dog.stats.maxHp, Math.round(Math.round(3000 * 0.35) * strength(10)));
  assert.equal(dog.stats.spd, MONSTERS.dog.stats.spd);   // 速度固定值，不隨難度（2026-11-19 加倍成 240）
  assert.equal(dog.stats.hit, 90);                                  // +10 × (10 − 1)
  const circle = buildMonster('circle', 1);
  assert.equal(circle.normalAttack.actions[0].stat, 'int');
  assert.ok(circle.normalAttack.actions[0].uncritable && circle.normalAttack.actions[0].uncounterable);
  assert.ok(circle.skills[0].actions.every(a => a.stat === 'int' && a.uncritable));
  assert.equal(buildMonster('goblin', 1).stats.eva, 250);
  assert.equal(buildMonster('golem', 7).stats.def, 200 + DEF_PER_LEVEL * 6);          // 防禦隨難度加法成長
  assert.equal(buildMonster('dog', 1).stats.def, 20);
});

// ── 組戰鬥 ────────────────────────────────────────────────

test('encounters respect the count range and normalize total strength to the region budget', () => {
  const rng = createSeededRandom(5);
  for (const regionId of ['ruins', 'sewer']) {
    const region = REGIONS[regionId];
    for (const d of [1, 3, 7, 15]) {
      for (let i = 0; i < 200; i++) {
        const { monsters, info } = rollEncounter(regionId, d, rng);
        assert.ok(monsters.length >= region.count[0] && monsters.length <= region.count[1], `${regionId} d${d} ${monsters.length}`);
        assert.ok(Math.abs(info.totalCost * info.scale - region.budget) < 1e-9);
        assert.equal(new Set(monsters.map(m => m.id)).size, monsters.length);
        assert.ok(info.ids.every(id => availableMonsters(regionId, d).some(def => def.id === id)));
      }
    }
  }
});

test('maxPerEncounter caps how many of one monster appear (doll: at most 1 per encounter)', () => {
  assert.equal(MONSTERS.doll.maxPerEncounter, 1);
  const rng = createSeededRandom(11);
  let withDoll = 0;
  for (const d of [3, 7, 15]) {
    for (let i = 0; i < 2000; i++) {
      const { info } = rollEncounter('ruins', d, rng);
      const dolls = info.ids.filter(id => id === 'doll').length;
      assert.ok(dolls <= 1, `d${d} dolls=${dolls}`);
      if (dolls) withDoll++;
    }
  }
  assert.ok(withDoll > 0);   // 人偶仍會出現
  // 沒寫 maxPerEncounter 的怪不受限：水道的老鼠仍可多隻
  const sewer = createSeededRandom(12);
  assert.ok(Array.from({ length: 500 }, () => rollEncounter('sewer', 1, sewer).info.ids.filter(id => id === 'rat').length).some(n => n >= 2));
});

test('rare appears about 3%, elite about 15% once unlocked, never together; duplicate names get letters', () => {
  const rng = createSeededRandom(9);
  let rare = 0, elite = 0, both = 0;
  const n = 6000;
  for (let i = 0; i < n; i++) {
    const { info } = rollEncounter('sewer', 7, rng);
    if (info.rare) rare++;
    if (info.elite) elite++;
    if (info.rare && info.elite) both++;
  }
  assert.equal(both, 0);
  assert.ok(Math.abs(rare / n - RARE_CHANCE) < 0.01, `rare ${rare / n}`);
  assert.ok(Math.abs(elite / n - (1 - RARE_CHANCE) * ELITE_CHANCE) < 0.015, `elite ${elite / n}`);
  for (let i = 0; i < 50; i++) assert.ok(!rollEncounter('ruins', 6, rng).info.elite);   // 魔像難度 7 才出現
  const { monsters } = rollEncounter('ruins', 1, () => 0.5);
  const names = monsters.map(m => m.name);
  if (new Set(monsters.map(m => m.id.split('_')[0])).size < monsters.length) assert.ok(names.some(n => /[AB]$/.test(n)));
});

// ── 特性與技能 ────────────────────────────────────────────

const hero = (stats = {}) => new Entity({ id: 'h', name: '勇者', team: 'A', normalAttack: new Skill({ id: 'na', name: 'na', actions: [{ type: 'DAMAGE' }] }),
  stats: { hp: 1e6, maxHp: 1e6, sp: 1e4, maxSp: 1e4, atk: 400, def: 0, spd: 60, skillCastRate: 0, ...stats } });

test('slime splits once into two small slimes when it first drops below half HP (from difficulty 7)', t => {
  t.mock.method(Formulas, 'isHit', () => true);
  const run = d => {
    const slime = buildMonster('slime', d, { id: 'slime_1' });
    const encounter = { monsters: [slime] };
    const factory = (id, { entityId }) => new Entity({ id: entityId, name: '小史萊姆', team: 'B', normalAttack: new Skill({ id: 'x', name: 'x', actions: [{ type: 'DAMAGE' }] }),
      stats: { hp: 10, maxHp: 10, sp: 10, atk: 1, def: 0, spd: 1 } });
    const engine = new BattleEngine([hero()], encounter.monsters, { maxTurns: 30, rng: createSeededRandom(1), hitFormula: 'contest', summonFactory: factory });
    engine.start();
    return engine.logger.logs.filter(l => l.type === 'SUMMON').length;
  };
  assert.equal(run(3), 0);
  assert.equal(run(7), 2);
  // 真正的工廠：小史萊姆的屬性取自母體
  const { summonFactory, monsters } = rollEncounter('sewer', 7, createSeededRandom(1));
  const parent = monsters.find(m => m.id.startsWith('slime_'));
  if (parent) {
    const child = summonFactory('split:slime', { entityId: 'summon_1' });
    assert.equal(child.stats.maxHp, Math.round(parent.stats.maxHp * 0.3));
    assert.equal(child.name, '小史萊姆');
  }
  assert.equal(summonFactory('goblin', { entityId: 'x' }), null);
});

test('mimic ambush: the first action hits 2.5× harder, then back to normal', () => {
  const mimic = buildMonster('mimic', 1);
  assert.ok(mimic.passives.some(p => p.trigger === 'BATTLE_START'));
  const base = mimic.getEffectiveStats().atk;
  mimic.passives.find(p => p.trigger === 'BATTLE_START').action(mimic);
  assert.ok(Math.abs(mimic.getEffectiveStats().atk - base * 2.5) < 1);
  mimic.tickBuffs();
  assert.equal(mimic.getEffectiveStats().atk, base);
});

test('skill kinds: rat plague bite adds a DOT only on hit; circle ward shields allies; doll heals', () => {
  const rat = buildMonster('rat', 7);
  const plague = rat.skills.find(s => s.name === '病菌啃咬');
  const dot = plague.actions.find(a => a.type === 'BUFF');
  assert.equal(dot.requiresDamage, true);
  assert.equal(dot.buffs[0].type, 'DOT');
  assert.equal(dot.buffs[0].value, Math.round(rat.stats.atk * 0.3));
  const ward = buildMonster('circle', 7).skills.find(s => s.name === '防護結界');
  assert.equal(ward.actions[0].targetType, 'ALLY_ALL');
  assert.ok(ward.actions[0].buffs[0].shield > 0);
  const doll = buildMonster('doll', 3);
  assert.equal(doll.skills[0].actions[0].type, 'HEAL');
  assert.equal(doll.skills[0].actions[0].power, 3);                    // 修補：智力 300%（2026-11-20）
  assert.equal(doll.stats.skillCastRate, 0.5);
  const doll13 = buildMonster('doll', 13);
  assert.equal(doll13.skills.find(s => s.name === '加固').actions[0].buffs[0].shield, Math.round(doll13.stats.maxHp * 0.25));   // 加固：人偶最大生命 25%
  assert.equal(doll13.skills.find(s => s.name === '緊急修復').actions[0].power, 3);   // 緊急修復：智力 300%（2026-11-20）
  // 護盾寫 power 時改吃施放者攻擊／智力（目前沒有怪用，機制保留）
  const { buildFromDef } = require('./monsters');
  const custom = buildFromDef({ ...MONSTERS.doll, id: 'doll_test', skills: [{ kind: 'shield', id: 's', name: '測試盾', from: 1, spCost: 10, target: 'allySingle', power: 3, duration: 3 }] }, 7);
  assert.equal(custom.skills[0].actions[0].buffs[0].shield, Math.round(custom.stats.int * 3));
  assert.equal(ward.actions[0].buffs[0].shield, Math.round(buildMonster('circle', 7).stats.maxHp * 0.08));   // 寫 ratio 的仍是最大生命 × ratio
});

// ── 掉落 ──────────────────────────────────────────────────

test('rare encounters drop 2 extra engravings biased to higher tiers; elite 1 extra; normal unchanged', () => {
  const plain = rollDrops(10, createSeededRandom(4));
  assert.deepEqual(rollDrops(10, createSeededRandom(4), {}), plain);
  const withRare = rollDrops(10, createSeededRandom(4), { rare: true });
  assert.equal(withRare.engravings.length, plain.engravings.length + RARE_BONUS.engravings);
  assert.deepEqual(withRare.engravings.slice(0, plain.engravings.length), plain.engravings);
  assert.equal(rollDrops(10, createSeededRandom(4), { elite: true }).engravings.length, plain.engravings.length + ELITE_BONUS.engravings);
  // 偏高階：大量取樣的平均階級高於一般
  const rng = createSeededRandom(8);
  let normal = 0, rare = 0, nn = 0, nr = 0;
  for (let i = 0; i < 3000; i++) {
    const d = rollDrops(15, rng, { rare: true }).engravings;
    d.slice(0, -2).forEach(e => { normal += e.tier; nn++; });
    d.slice(-2).forEach(e => { rare += e.tier; nr++; });
  }
  assert.ok(rare / nr > normal / nn + 0.2, `${rare / nr} vs ${normal / nn}`);
});

// ── 閃避反擊（2026-11-20）────────────────────────────────────────────
{
  const M = require('./monsters');
  const { Entity: E, Skill: S, BattleEngine: BE, createSeededRandom: seeded } = require('../src');
  const quiet = () => { const logs = []; return { logs, addLog: entry => logs.push(entry) }; };
  const setup = (spec, heroOpts = {}) => {
    const mob = M.buildFromDef({ ...M.MONSTERS.dog, id: 'dogx', evadeCounter: spec }, 3);
    mob.stats.sp = 100; mob.stats.maxSp = 100;
    const hero = new E({ id: 'hero', name: '玩家', team: 'A', normalAttack: new S({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }),
      stats: { hp: 5000, maxHp: 5000, atk: 100, int: 100, def: 0, spd: 100, sp: 100, maxSp: 100 }, ...heroOpts });
    const engine = new BE([hero], [mob], { rng: () => 0 });
    return { mob, hero, engine, passive: mob.passives.find(p => p.trigger === 'AFTER_EVADE') };
  };

  test('閃避反擊的點數曲線：0 點不反擊；點數相同是上限一半；上限與斜率是 gem 自己的常數', () => {
    assert.deepEqual(M.EVADE_COUNTER, { ceiling: 0.4, scale: 50 });   // 2026-11-20：點數相同 20%、上限 40%
    assert.equal(M.evadeCounterChance(0), 0);
    assert.ok(Math.abs(M.evadeCounterChance(50, 50) - 0.2) < 1e-12);
    assert.ok(Math.abs(M.evadeCounterChance(100) - 0.4 / (1 + Math.exp(-2))) < 1e-12);
    assert.ok(M.evadeCounterChance(1e6) <= 0.4);
  });

  test('閃避反擊：躲掉一擊後擲反擊，成功就用預設反擊（普攻倍率、必定命中）還擊攻擊者；法術被躲開不反擊；沒有 evadeCounter 的怪沒有這個被動', () => {
    const { mob, hero, engine, passive } = setup({ points: 100, text: '{caster} 閃身反咬，' });
    const logger = quiet();
    const strike = hero.normalAttack;
    assert.equal(passive.enabled(mob, { caster: hero, skill: strike, action: strike.actions[0] }), true);
    const spell = new S({ id: 'mm', name: '魔法飛彈', uncounterable: true, actions: [{ type: 'DAMAGE', stat: 'int', uncounterable: true }] });
    assert.equal(passive.enabled(mob, { caster: hero, skill: spell, action: spell.actions[0] }), false);
    passive.action(mob, { caster: hero, skill: strike, action: strike.actions[0] }, logger, engine);   // rng 0 → 必定成功
    const hit = logger.logs.find(l => l.type === 'DAMAGE');
    assert.ok(hit && hit.targetId === 'hero');
    assert.match(hit.message, /^憤怒野犬 閃身反咬，/);
    assert.ok(hero.stats.hp < 5000);
    assert.equal(engine.counterSource, null);                                      // 結束後還原
    assert.equal(M.buildFromDef(M.MONSTERS.dog, 3).passives.some(p => p.trigger === 'AFTER_EVADE'), false);
  });

  test('閃避反擊：擲輸就不反擊；已經在反擊中（counterSource）不再反擊；有專屬反擊技能且 SP 夠就用它並扣 SP，不夠退回預設反擊', () => {
    const lose = setup({ points: 100 });
    lose.engine.rng = () => 0.99;
    const l1 = quiet();
    lose.passive.action(lose.mob, { caster: lose.hero, skill: lose.hero.normalAttack }, l1, lose.engine);
    assert.equal(l1.logs.length, 0);
    const chained = setup({ points: 100 });
    const l2 = quiet();
    chained.engine.withCounterSource({ actorId: 'x' }, () => chained.passive.action(chained.mob, { caster: chained.hero, skill: chained.hero.normalAttack }, l2, chained.engine));
    assert.equal(l2.logs.length, 0);
    const special = setup({ points: 100, skill: { kind: 'attack', id: 'riposte', name: '迴身斬', spCost: 30, target: 'single', power: 2, text: '{caster} 迴身一斬，' } });
    const l3 = quiet();
    special.passive.action(special.mob, { caster: special.hero, skill: special.hero.normalAttack }, l3, special.engine);
    assert.match(l3.logs.find(l => l.type === 'DAMAGE').message, /迴身一斬/);
    assert.equal(special.mob.stats.sp, 70);
    special.mob.stats.sp = 10;
    const l4 = quiet();
    special.passive.action(special.mob, { caster: special.hero, skill: special.hero.normalAttack }, l4, special.engine);
    assert.match(l4.logs.find(l => l.type === 'DAMAGE').message, /趁隙反擊/);
    assert.equal(special.mob.stats.sp, 10);
  });

  test('閃避反擊（整場戰鬥）：每一筆反擊都緊接在怪物躲掉玩家攻擊之後；玩家命中時不反擊', () => {
    M.EVADE_COUNTER.ceiling = 1;
    try {
      const mob = M.buildFromDef({ ...M.MONSTERS.dog, id: 'dogx', stats: { ...M.MONSTERS.dog.stats, eva: 300 }, evadeCounter: { points: 1000 } }, 3);
      const hero = new E({ id: 'hero', name: '玩家', team: 'A', normalAttack: new S({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }),
        stats: { hp: 1e6, maxHp: 1e6, atk: 100, def: 0, spd: 300, sp: 100, maxSp: 100 } });
      const engine = new BE([hero], [mob], { rng: seeded(4), maxTurns: 10, hitFormula: 'contest' });
      engine.start();
      const logs = engine.logger.logs;
      const counters = logs.map((l, i) => [l, i]).filter(([l]) => l.type === 'DAMAGE' && /趁隙反擊/.test(l.message));
      assert.ok(counters.length > 0);
      for (const [, i] of counters) assert.ok(logs[i - 1].type === 'MISS' && logs[i - 1].targetId === mob.id && logs[i - 1].actorId === 'hero');
      const playerHits = logs.filter(l => l.type === 'DAMAGE' && l.actorId === 'hero').length;
      assert.ok(playerHits > 0);
    } finally { M.EVADE_COUNTER.ceiling = 0.4; }
  });
}

test('怪物技能會扣 SP（2026-11-20 修正：spCost 放在第一個 action，框架才會扣）；怪物 SP 隨難度線性：200 + 50 × (難度 − 1)', () => {
  const { MONSTER_SP } = require('./monsters');
  assert.deepEqual(MONSTER_SP, { base: 200, perLevel: 50 });
  assert.equal(buildMonster('dog', 1).stats.maxSp, 200);
  assert.equal(buildMonster('dog', 15).stats.maxSp, 900);
  const doll = buildMonster('doll', 13);
  assert.deepEqual(doll.skills.map(s => s.actions[0].spCost), MONSTERS.doll.skills.map(s => s.spCost));
  const mend = doll.skills[0];
  const sp = doll.stats.sp;
  const ally = buildMonster('dog', 13);
  ally.stats.hp = 1;
  const engine = new BattleEngine([new Entity({ id: 'h', name: '玩家', team: 'A', normalAttack: new Skill({ id: 'na', name: '普攻', actions: [{ type: 'DAMAGE' }] }), stats: { hp: 100, maxHp: 100, atk: 1, spd: 1 } })], [doll, ally], { rng: createSeededRandom(1) });
  mend.execute(doll, engine.teamB, engine.teamA, { addLog() {} }, engine);
  assert.equal(doll.stats.sp, sp - MONSTERS.doll.skills[0].spCost);
});
