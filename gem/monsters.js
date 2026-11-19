'use strict';

/**
 * 地區與怪物（初版，數值都是佔位；第四階段第 8、9 項）。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   兩個地區，所有難度都能去：廢都（每場 1～3 隻）、地下水道（每場 2～5 隻）。之後會再加地區。
 *   每區至少 5 種怪，含一種**稀有怪**（出現機率低、掉落好）與一種**菁英怪**（數值高、技能多，是那一區的關卡）。
 *   **難度決定每隻怪學到哪些技能、以及出現哪些新怪**（skills 的 from、怪物的 from）。
 *   一場戰鬥用「強度預算」湊（使用者：先用看看，之後可能換）：每種怪有花費 cost，湊到地區的 budget，
 *   最後把整場怪物的生命與攻擊／智力乘上 budget ÷ 總花費，讓 1 隻菁英和 3 隻小怪的總強度相同。
 *
 * ── 數值 ──────────────────────────────────────────────────────
 *   怪物屬性寫成「基準怪（BASE_MONSTER，強度 1）的倍率」：hp、atk、int 是倍率，def、spd、eva、hit 是固定值。
 *   速度 2026-11-19 全部加倍（使用者：玩家、怪物、裝備的平值速度一起 ×2，讓連擊更常出現；百分比不動）。
 *   組戰鬥時：基準 × 倍率 × 預算正規化 → difficulty.scaleMonster（× 難度強度 M、命中 + 10／級）。
 *   技能的護盾、治療、持續傷害數值在組戰鬥時用怪物「縮放後」的屬性算好（框架的 Buff 是固定值）。
 *
 * ── 技能規格（純資料；buildSkill 轉成框架 Skill）──────────────────
 *   attack  { power, hits?, target: 'single'|'all', dot?: { name, power, duration } }  dot 的每槽傷害 = 施放者能力值 × power
 *   buff    { target: 'self'|'allyAll'|'enemy', stat, mult, duration, name }        STAT Buff（乘法）
 *   shield  { target: 'allySingle'|'allyAll', ratio, duration, name }               護盾 = 施放者最大生命 × ratio
 *   heal    { target: 'allySingle'|'allyAll'|'self', power }                         回復 = 施放者能力值 × power
 *   共通：id、name、from（從第幾難度開始會用）、spCost。法術怪（spell: true）的傷害吃 int、不可暴擊、不可反擊。
 *   maxPerEncounter（選填，普通怪）：同一場最多出現幾隻；沒寫就不限。
 *   特性 traits：split（血量第一次低於一半時分裂）、ambush（第一個行動槽攻擊力 × mult）、enrage（血量第一次低於 at 時某屬性 × mult 到戰鬥結束，王用）。
 */

const { Entity, Skill } = require('../src');
const { scaleMonster } = require('./difficulty');

// 基準怪（強度 1）：與 affix-budget.js 的 FOE 相同
const BASE_MONSTER = { hp: 3000, atk: 90, int: 90, def: 50, spd: 180, sp: 200 };
const RARE_CHANCE = 0.03;
const ELITE_CHANCE = 0.15;

const MONSTERS = {
  // ── 廢都 ──
  dog: {
    id: 'dog', name: '憤怒野犬', from: 1, cost: 0.35,
    stats: { hp: 0.35, atk: 0.4, def: 20, spd: 240 },
    skills: [
      { kind: 'attack', id: 'bite', name: '撕咬', from: 1, spCost: 10, power: 1.4, target: 'single' },
      { kind: 'buff', id: 'howl', name: '狂吠', from: 7, spCost: 10, target: 'self', stat: 'atk', mult: 1.3, duration: 3 },
      { kind: 'attack', id: 'maul', name: '撲殺', from: 13, spCost: 15, power: 0.9, hits: 2, target: 'single' }
    ]
  },
  circle: {
    id: 'circle', name: '守衛魔法陣', from: 1, cost: 0.45, spell: true,
    stats: { hp: 0.4, atk: 0, int: 0.5, def: 80, spd: 140 },
    skills: [
      { kind: 'attack', id: 'arcane_blast', name: '魔力衝擊', from: 1, spCost: 10, power: 1.4, target: 'single' },
      { kind: 'shield', id: 'ward', name: '防護結界', from: 7, spCost: 15, target: 'allyAll', ratio: 0.08, duration: 3 },
      { kind: 'attack', id: 'overload', name: '過載', from: 13, spCost: 20, power: 0.9, target: 'all' }
    ]
  },
  doll: {
    // 一場最多 1 隻（使用者決定，2026-11-19）：兩隻會互相補到 40 回合平手
    id: 'doll', name: '修繕人偶', from: 3, cost: 0.3, spell: true, skillCastRate: 0.5, maxPerEncounter: 1,
    stats: { hp: 0.35, atk: 0, int: 0.4, def: 40, spd: 200 },
    skills: [
      // 修補 300% → 200%（使用者，2026-11-19）：難度 10 倍之後「野犬＋人偶」在高難度太難打（難度 15 拿第 5 階只有 32%）
      { kind: 'heal', id: 'mend_ally', name: '修補', from: 3, spCost: 10, target: 'allySingle', power: 2 },
      { kind: 'shield', id: 'reinforce', name: '加固', from: 7, spCost: 10, target: 'allySingle', ratio: 0.25, duration: 3 },
      { kind: 'heal', id: 'overhaul', name: '緊急修復', from: 13, spCost: 20, target: 'allyAll', power: 2 }
    ]
  },
  goblin: {
    id: 'goblin', name: '地精', from: 1, cost: 0.3, rarity: 'rare',
    stats: { hp: 0.3, atk: 0.3, def: 20, spd: 260, eva: 250 },
    skills: [
      { kind: 'attack', id: 'sneak', name: '偷襲', from: 1, spCost: 10, power: 1.2, target: 'single' },
      { kind: 'buff', id: 'smoke', name: '煙霧彈', from: 7, spCost: 15, target: 'self', stat: 'eva', mult: 1.6, duration: 2 }
    ]
  },
  golem: {
    id: 'golem', name: '自動魔像', from: 7, cost: 1.0, rarity: 'elite',
    stats: { hp: 1.0, atk: 1.1, def: 200, spd: 100 },
    skills: [
      { kind: 'attack', id: 'slam', name: '重擊', from: 7, spCost: 20, power: 2.0, target: 'single' },
      { kind: 'buff', id: 'plating', name: '裝甲強化', from: 10, spCost: 15, target: 'self', stat: 'def', mult: 1.5, duration: 3 },
      { kind: 'attack', id: 'quake', name: '地震', from: 13, spCost: 25, power: 1.2, target: 'all' }
    ]
  },

  // ── 地下水道 ──
  rat: {
    id: 'rat', name: '鏽蝕老鼠', from: 1, cost: 0.15,
    stats: { hp: 0.15, atk: 0.18, def: 10, spd: 220 },
    skills: [
      { kind: 'attack', id: 'gnaw', name: '啃咬', from: 1, spCost: 8, power: 1.2, target: 'single' },
      { kind: 'attack', id: 'plague_bite', name: '病菌啃咬', from: 7, spCost: 10, power: 1.0, target: 'single', dot: { name: '病菌', power: 0.3, duration: 3 } },
      { kind: 'attack', id: 'swarm', name: '鼠群', from: 13, spCost: 12, power: 0.7, hits: 3, target: 'single' }
    ]
  },
  tentacle: {
    id: 'tentacle', name: '管線觸手', from: 1, cost: 0.3,
    stats: { hp: 0.35, atk: 0.35, def: 60, spd: 160 },
    skills: [
      { kind: 'attack', id: 'lash', name: '鞭打', from: 1, spCost: 10, power: 1.3, target: 'single' },
      { kind: 'buff', id: 'entangle', name: '纏繞', from: 7, spCost: 12, target: 'enemy', stat: 'spd', mult: 0.8, duration: 2 },
      { kind: 'attack', id: 'strangle', name: '絞殺', from: 13, spCost: 18, power: 1.8, target: 'single' }
    ]
  },
  slime: {
    id: 'slime', name: '毒水史萊姆', from: 3, cost: 0.3, spell: true,
    stats: { hp: 0.35, atk: 0, int: 0.3, def: 30, spd: 140 },
    skills: [
      { kind: 'attack', id: 'venom', name: '毒液', from: 3, spCost: 10, power: 1.0, target: 'single', dot: { name: '中毒', power: 0.3, duration: 3 } }
    ],
    traits: [{ kind: 'split', from: 7, at: 0.5, count: 2, hpRatio: 0.3, statRatio: 0.5, name: '小史萊姆' }]
  },
  mimic: {
    id: 'mimic', name: '寶箱擬態怪', from: 1, cost: 0.4, rarity: 'rare',
    stats: { hp: 0.5, atk: 0.6, def: 80, spd: 200 },
    skills: [
      { kind: 'attack', id: 'chomp', name: '咬合', from: 1, spCost: 10, power: 1.5, target: 'single' },
      { kind: 'heal', id: 'devour', name: '吞噬', from: 10, spCost: 15, target: 'self', power: 3 }
    ],
    traits: [{ kind: 'ambush', from: 1, mult: 2.5 }]
  },
  scavenger: {
    id: 'scavenger', name: '水道清道夫', from: 7, cost: 0.7, rarity: 'elite',
    stats: { hp: 0.7, atk: 0.6, def: 70, spd: 170 },
    skills: [
      { kind: 'attack', id: 'tail_sweep', name: '掃尾', from: 7, spCost: 15, power: 1.0, target: 'all' },
      { kind: 'heal', id: 'feed', name: '吞食', from: 10, spCost: 15, target: 'self', power: 4 },
      { kind: 'buff', id: 'frenzy', name: '狂暴', from: 13, spCost: 15, target: 'self', stat: 'atk', mult: 1.4, duration: 3 }
    ]
  }
};

// locked: true 的地區一開始不開放，要由王的獎勵（rewards.unlockRegions）開啟；目前兩區都一開始就開放。
const REGIONS = {
  ruins: { id: 'ruins', name: '廢都', count: [1, 3], budget: 0.7, monsters: ['dog', 'circle', 'doll', 'goblin', 'golem'] },
  sewer: { id: 'sewer', name: '地下水道', count: [2, 5], budget: 0.85, monsters: ['rat', 'tentacle', 'slime', 'mimic', 'scavenger'] }
};

// ── 技能建構 ────────────────────────────────────────────────

const TARGET = { single: 'ENEMY_SINGLE', all: 'ENEMY_ALL', self: 'SELF', allySingle: 'ALLY_SINGLE', allyAll: 'ALLY_ALL', enemy: 'ENEMY_SINGLE' };

function buildSkill(spec, def, stats, casterName) {
  // 框架原樣使用 text，所以在這裡把施放者名字放進開頭（同一種怪有 A、B 時也分得出是誰）
  const text = { action: `${casterName} 使出${spec.name}，` };
  const stat = def.spell ? 'int' : 'atk';
  const spellFlags = def.spell ? { uncritable: true, uncounterable: true } : {};
  const base = { id: `${def.id}_${spec.id}`, name: spec.name, spCost: spec.spCost ?? 0 };
  if (spec.kind === 'attack') {
    const actions = [{ type: 'DAMAGE', targetType: TARGET[spec.target], power: spec.power, stat, text, ...(spec.hits ? { hits: spec.hits } : {}), ...spellFlags }];
    if (spec.dot) {
      actions.push({ type: 'BUFF', targetType: TARGET[spec.target], requiresDamage: true, buffs: [{
        id: `monster_dot:${spec.dot.name}`, name: spec.dot.name, type: 'DOT', duration: spec.dot.duration,
        value: Math.max(1, Math.round(stats[stat] * spec.dot.power)), polarity: 'negative', dispellable: true, tags: ['monster_dot'] }] });
    }
    return new Skill({ ...base, ...spellFlags, actions });
  }
  if (spec.kind === 'buff') {
    const { stat: key, mult } = spec;
    return new Skill({ ...base, actions: [{ type: 'BUFF', targetType: TARGET[spec.target], text, buffs: [{
      id: `monster_buff:${spec.id}`, name: spec.name, type: 'STAT', duration: spec.duration, stackPolicy: 'refresh',
      polarity: mult >= 1 ? 'positive' : 'negative', dispellable: true, effect: s => { s[key] = (s[key] ?? 0) * mult; } }] }] });
  }
  if (spec.kind === 'shield') {
    return new Skill({ ...base, actions: [{ type: 'BUFF', targetType: TARGET[spec.target], text, buffs: [{
      id: `monster_shield:${spec.id}`, name: spec.name, duration: spec.duration, stackPolicy: 'refresh',
      shield: Math.max(1, Math.round(stats.maxHp * spec.ratio)), polarity: 'positive', dispellable: true }] }] });
  }
  if (spec.kind === 'heal') {
    return new Skill({ ...base, actions: [{ type: 'HEAL', targetType: TARGET[spec.target], power: spec.power, stat, text }] });
  }
  throw new Error(`怪物「${def.id}」的技能「${spec.id}」種類不明：${spec.kind}`);
}

// 分裂：血量第一次低於 at 時，召喚 count 隻小史萊姆（引擎的 summon，需要 encounter 的 summonFactory）
function buildSplitPassive(trait, def) {
  let done = false;
  const action = { type: 'SUMMON', monsterId: `split:${def.id}`, maxTotal: trait.count, maxAlive: trait.count };
  const skill = new Skill({ id: `${def.id}_split`, name: '分裂', text: { summon: '{caster} 分裂出了 {summon}！' }, actions: [action] });
  return {
    id: `monster_split:${def.id}`,
    trigger: 'AFTER_DAMAGE_RECEIVED',
    enabled: self => !done && self.isAlive && self.stats.hp < self.stats.maxHp * trait.at,
    action(self, hit, logger, engine) {
      done = true;
      if (!engine?.summon) return;
      for (let i = 0; i < trait.count; i++) engine.summon(self, action, skill);
    }
  };
}

// 狂怒：血量第一次低於 at 時，某個屬性 × mult 直到戰鬥結束（王用）
function buildEnragePassive(trait, def) {
  let done = false;
  return {
    id: `monster_enrage:${def.id}`,
    trigger: 'AFTER_DAMAGE_RECEIVED',
    enabled: self => !done && self.isAlive && self.stats.hp < self.stats.maxHp * trait.at,
    action(self, hit, logger) {
      done = true;
      self.addBuff({ id: `monster_enrage:${def.id}`, name: trait.name ?? '狂怒', type: 'STAT', duration: Infinity, polarity: 'positive', dispellable: false,
        effect: s => { s[trait.stat] = (s[trait.stat] ?? 0) * trait.mult; } });
      logger.addLog({ type: 'TEXT', actorId: self.id, message: trait.text ? trait.text.replaceAll('{caster}', self.name) : `${self.name} 進入了狂怒狀態！` });
    }
  };
}

// 伏擊：開戰時攻擊力 × mult，撐到自己的第一個行動槽結束
function buildAmbushPassive(trait, def) {
  return {
    id: `monster_ambush:${def.id}`,
    trigger: 'BATTLE_START',
    action(self) {
      self.addBuff({ id: `monster_ambush:${def.id}`, name: '伏擊', type: 'STAT', duration: 1, effect: s => { s.atk *= trait.mult; } });
    }
  };
}

/**
 * 建一隻怪的 Entity。scale = 預算正規化倍率；difficulty 決定強度與技能。
 * @returns {Entity}
 */
function buildMonster(monsterId, difficulty, options = {}) {
  const def = MONSTERS[monsterId];
  if (!def) throw new Error(`找不到怪物「${monsterId}」`);
  return buildFromDef(def, difficulty, options);
}

/** 用怪物定義物件建 Entity（王也用這個；定義格式同 MONSTERS）。 */
function buildFromDef(def, difficulty, { id, name, scale = 1, statsOverride } = {}) {
  const raw = statsOverride ?? {
    hp: BASE_MONSTER.hp * def.stats.hp * scale,
    atk: BASE_MONSTER.atk * (def.stats.atk ?? 0) * scale,
    int: BASE_MONSTER.int * (def.stats.int ?? 0) * scale,
    def: def.stats.def ?? BASE_MONSTER.def, spd: def.stats.spd ?? BASE_MONSTER.spd, sp: def.stats.sp ?? BASE_MONSTER.sp,
    eva: def.stats.eva ?? 0, hit: def.stats.hit ?? 0
  };
  const stats = scaleMonster({ ...raw, hp: Math.round(raw.hp), maxHp: Math.round(raw.hp) }, difficulty);
  Object.assign(stats, { maxSp: stats.sp, skillCastRate: def.skillCastRate ?? 0.35 });
  const stat = def.spell ? 'int' : 'atk';
  const normalAttack = new Skill({ id: `${def.id}_attack`, name: '攻擊', actions: [{ type: 'DAMAGE', stat, ...(def.spell ? { uncritable: true, uncounterable: true } : {}) }],
    ...(def.spell ? { uncritable: true, uncounterable: true } : {}) });
  const entityName = name ?? def.name;
  const skills = def.skills.filter(spec => difficulty >= spec.from).map(spec => buildSkill(spec, def, stats, entityName));
  const TRAIT_BUILDERS = { split: buildSplitPassive, ambush: buildAmbushPassive, enrage: buildEnragePassive };
  const passives = (def.traits ?? []).filter(trait => difficulty >= (trait.from ?? 1)).map(trait => {
    if (!TRAIT_BUILDERS[trait.kind]) throw new Error(`怪物「${def.id}」的特性種類不明：${trait.kind}`);
    return TRAIT_BUILDERS[trait.kind](trait, def);
  });
  return new Entity({ id: id ?? def.id, name: entityName, team: 'B', normalAttack, normalAttackSpCost: 2, skills, passives, stats });
}

/** 某難度某地區出現得了的怪（依 from）。 */
function availableMonsters(regionId, difficulty) {
  const region = REGIONS[regionId];
  if (!region) throw new Error(`找不到地區「${regionId}」`);
  return region.monsters.map(id => MONSTERS[id]).filter(def => difficulty >= def.from);
}

/**
 * 組一場戰鬥（rng 順序：稀有 1 次 → 菁英 1 次（有稀有時不擲）→ 每補一隻普通怪 1 次）。
 * 稀有與菁英各最多一隻、不同時出現；普通怪隨機補到預算或數量上限，不到下限時補最便宜的。
 * 回傳 { monsters: Entity[], summonFactory, info: { ids, rare, elite, totalCost, scale } }。
 */
function rollEncounter(regionId, difficulty, rng = Math.random) {
  const region = REGIONS[regionId];
  const pool = availableMonsters(regionId, difficulty);
  const normals = pool.filter(def => !def.rarity);
  const rare = pool.find(def => def.rarity === 'rare');
  const elite = pool.find(def => def.rarity === 'elite');
  const [min, max] = region.count;
  const picks = [];
  let hasRare = false, hasElite = false;
  if (rare && rng() < RARE_CHANCE) { picks.push(rare); hasRare = true; }
  else if (elite && rng() < ELITE_CHANCE) { picks.push(elite); hasElite = true; }
  const spent = () => picks.reduce((sum, def) => sum + def.cost, 0);
  const cheapest = normals.reduce((a, b) => (a.cost <= b.cost ? a : b));
  while (picks.length < max) {
    // maxPerEncounter（選填）：同一場最多幾隻；沒寫就不限，亂數序列與之前相同
    const affordable = normals.filter(def => def.cost <= region.budget - spent() + 1e-9
      && (def.maxPerEncounter == null || picks.filter(p => p === def).length < def.maxPerEncounter));
    if (!affordable.length) break;
    picks.push(affordable[Math.min(affordable.length - 1, Math.floor(rng() * affordable.length))]);
  }
  while (picks.length < min) picks.push(cheapest);
  const totalCost = spent();
  const scale = region.budget / totalCost;
  // 同名的加 A、B、C
  const counts = {};
  for (const def of picks) counts[def.id] = (counts[def.id] ?? 0) + 1;
  const seen = {};
  const monsters = picks.map((def, i) => {
    seen[def.id] = (seen[def.id] ?? 0) + 1;
    const suffix = counts[def.id] > 1 ? String.fromCharCode(64 + seen[def.id]) : '';
    return buildMonster(def.id, difficulty, { id: `${def.id}_${i + 1}`, name: def.name + suffix, scale });
  });
  // 分裂用的工廠：小史萊姆 = 母體縮放後屬性 × 比例
  const summonFactory = (monsterId, { entityId }) => {
    const [kind, parentId] = monsterId.split(':');
    if (kind !== 'split') return null;
    const def = MONSTERS[parentId];
    const trait = def.traits.find(t => t.kind === 'split');
    const parent = monsters.find(m => m.id.startsWith(`${parentId}_`)) ?? null;
    if (!parent) return null;
    const p = parent.stats;
    return new Entity({ id: entityId, name: trait.name, team: 'B', normalAttackSpCost: 2,
      normalAttack: new Skill({ id: `${parentId}_split_attack`, name: '攻擊', uncritable: !!def.spell, uncounterable: !!def.spell,
        actions: [{ type: 'DAMAGE', stat: def.spell ? 'int' : 'atk', ...(def.spell ? { uncritable: true, uncounterable: true } : {}) }] }),
      stats: { hp: Math.round(p.maxHp * trait.hpRatio), maxHp: Math.round(p.maxHp * trait.hpRatio), atk: Math.round((p.atk ?? 0) * trait.statRatio),
        int: Math.round((p.int ?? 0) * trait.statRatio), def: p.def, spd: p.spd, sp: 100, maxSp: 100, eva: p.eva ?? 0, hit: p.hit ?? 0, skillCastRate: 0 } });
  };
  return { monsters, summonFactory, info: { ids: picks.map(def => def.id), rare: hasRare, elite: hasElite, totalCost, scale } };
}

module.exports = { BASE_MONSTER, RARE_CHANCE, ELITE_CHANCE, MONSTERS, REGIONS, buildMonster, buildFromDef, availableMonsters, rollEncounter };
