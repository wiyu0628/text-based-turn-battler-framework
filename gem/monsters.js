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
 *   shield  { target: 'allySingle'|'allyAll', ratio | power, duration, name }       護盾 = 施放者最大生命 × ratio；寫 power 時改成施放者能力值（攻擊或智力）× power
 *   heal    { target: 'allySingle'|'allyAll'|'self', power }                         回復 = 施放者能力值 × power
 *   共通：id、name、from（從第幾難度開始會用）、spCost。法術怪（spell: true）的傷害吃 int、不可暴擊、不可反擊。
 *   maxPerEncounter（選填，普通怪）：同一場最多出現幾隻；沒寫就不限。
 *   特性 traits：split（血量第一次低於一半時分裂）、ambush（第一個行動槽攻擊力 × mult）、enrage（血量第一次低於 at 時某屬性 × mult 到戰鬥結束，王用）、
 *     phase（王的轉階段，見 buildPhasePassive）。
 *
 * ── 王用的選填欄位（2026-11-20，中央廳）──────────────────────────
 *   怪物：normalAttackText（普攻的開頭，例如「中央廳的雕像揮出長矛，」）、
 *         texts: { opening, victory, death }（旁白整句：開戰、王打贏、王倒下時印；{caster} 換成怪物名字）。
 *   attack 技能：spell（這招自己的傷害類型，蓋過怪物的 spell）、text（開頭，取代「X 使出Y，」）、
 *         intro（先印一整句，再打）、hitText（命中的後半句，{target}／{value}）、missText（落空的後半句）、
 *         target: 'random' ＋ hits：每一擊各自隨機挑一個目標（打過的也可能再挑到），hitTexts 是每一擊的開頭；
 *         debuff: { stat, mult, duration, name, text }：命中才掛的減益（STAT 乘法），text 是掛上時的一句（{target}）。
 */

const { Entity, Skill } = require('../src');

// 閃避反擊的點數曲線（gem 自己的，和框架的 Formulas.counterChance 同型、常數可以自由改；使用者之後決定）：
//   chance = ceiling / (1 + e^(−(守方點數 − 攻方點數) / scale))；守方 0 點 = 不反擊
// 2026-11-20 使用者：調高一倍——點數相同 20%、上限 40%
const EVADE_COUNTER = { ceiling: 0.4, scale: 50 };
function evadeCounterChance(points, attackerPoints = 0) {
  if (!(points > 0)) return 0;
  return EVADE_COUNTER.ceiling / (1 + Math.exp(-(points - attackerPoints) / EVADE_COUNTER.scale));
}
const { scaleMonster } = require('./difficulty');

// 基準怪（強度 1）：與 affix-budget.js 的 FOE 相同
// sp 200 → 800（2026-11-20）：修正怪物技能 spCost 沒生效後，200 會讓怪物很快掉到疲累（≤50% SP 全屬性 ×0.8），難度大降；800 讓各地區勝率回到修正前的水準
const BASE_MONSTER = { hp: 3000, atk: 90, int: 90, def: 50, spd: 180, sp: 800 };
// 怪物 SP 隨難度：沒寫 stats.sp 的怪物 SP = base + perLevel × (難度 − 1)。王與寫了 stats.sp 的怪不受影響。
// 2026-11-20 使用者選線性（前期選擇少時更好上手）：難度 1 是 200、每級 +50、難度 15 是 900。perLevel 0 就是固定。
const MONSTER_SP = { base: 200, perLevel: 50 };
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
    // 智力 0.4 → 0.2（使用者，2026-11-20）：降低傷害，修補、緊急修復改成智力 300%，讓它主要靠回復撐場
    stats: { hp: 0.35, atk: 0, int: 0.2, def: 40, spd: 200 },
    skills: [
      // 修補 300% → 200%（使用者，2026-11-19）：難度 10 倍之後「野犬＋人偶」在高難度太難打（難度 15 拿第 5 階只有 32%）
      // 2026-11-20（使用者）：修補 200% → 300%；加固維持人偶最大生命 25%（試過改成智力 300% 後改回）；緊急修復 200% → 300%
      { kind: 'heal', id: 'mend_ally', name: '修補', from: 3, spCost: 10, target: 'allySingle', power: 3 },
      { kind: 'shield', id: 'reinforce', name: '加固', from: 7, spCost: 10, target: 'allySingle', ratio: 0.25, duration: 3 },
      { kind: 'heal', id: 'overhaul', name: '緊急修復', from: 13, spCost: 20, target: 'allyAll', power: 3 }
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
  },

  // ── 第二區「和聲音樂廳」（使用者設計，2026-11-21；數值是我擬的初版，之後用模擬調）──────────
  // 和聲妖精：一次至少兩隻（group: 2）；「和聲」打中後其他和聲妖精各追擊一下；難度 7 起普攻也會引發追擊。
  fairy: {
    id: 'fairy', name: '和聲妖精', from: 1, cost: 0.2, group: 2,
    stats: { hp: 0.2, atk: 0.3, def: 20, spd: 220 },
    harmony: { power: 0.4, normalFrom: 7, text: '{caster}應和著旋律追擊，' },
    skills: [
      { kind: 'attack', id: 'harmony', name: '和聲', from: 1, spCost: 10, power: 0.8, target: 'single', chase: true }
    ]
  },
  // 指揮家：清除隊友身上的減益（玩家的裂傷、殘刃、緩速、易傷……）
  conductor: {
    id: 'conductor', name: '指揮家', from: 1, cost: 0.4,
    stats: { hp: 0.45, atk: 0.35, def: 60, spd: 180 },
    skills: [
      { kind: 'cleanse', id: 'order', name: '整頓', from: 1, spCost: 15, target: 'allyAll', text: '{caster}揮動指揮棒，樂團重新整齊了起來！' },
      { kind: 'attack', id: 'baton', name: '強拍', from: 7, spCost: 10, power: 1.3, target: 'single' },
      // 獨奏（使用者 2026-11-21）：攻擊力最高的隊友（不含自己）立刻多行動一次（額外的行動槽）
      { kind: 'solo', id: 'solo', name: '獨奏', from: 10, spCost: 20, text: '{caster}指向{target}，{target}開始了華麗的獨奏！' }
    ]
  },
  // 卡農砲（2026-11-21 使用者設計）：「轟鳴砲」先蓄力，下一個能行動的槽才發射強力單體攻擊；
  // 難度 7 起多了「卡農」：其他隊友（不含自己）下一個能行動的槽重複上一次用的技能（卡農本身不會被記住）。
  cannon: {
    id: 'cannon', name: '卡農砲', from: 1, cost: 0.4,
    stats: { hp: 0.5, atk: 0.5, def: 80, spd: 120 },
    skills: [
      { kind: 'attack', id: 'boom', name: '轟鳴砲', from: 1, spCost: 15, power: 2.5, target: 'single', charge: true,
        chargeText: '{caster}的砲管開始聚集音波……', text: '{caster} 發射了轟鳴砲，' },
      { kind: 'canon', id: 'canon', name: '卡農', from: 7, spCost: 15, text: '{caster}奏起了卡農，樂團的旋律開始重複！' }
    ]
  },
  // 無序音符（稀有，2026-11-21 使用者：不會普攻、技能全是干擾型；噪音是使用者定的，其餘我擬）
  // 普攻的位置換成不耗 SP 的噪音（noAttack），所以永遠不造成傷害。
  noise: {
    id: 'noise', name: '無序音符', from: 1, cost: 0.4, rarity: 'rare', skillCastRate: 0.6, noAttack: 'noise',
    stats: { hp: 0.6, atk: 0, def: 60, spd: 230 },
    skills: [
      { kind: 'debuff', id: 'noise', name: '噪音', from: 1, spCost: 10, stats: { atk: 0.8, spd: 0.8 }, duration: 2,
        text: '{caster}發出刺耳的噪音，', buffText: '{target} 的攻擊力和速度下降了！' },
      { kind: 'silence', id: 'rest', name: '休止符', from: 4, spCost: 15, duration: 2,
        text: '{caster}畫出一個巨大的休止符，', buffText: '{target} 無法使用技能！', blockedText: '{target} 被休止符壓住，無法使用 {skill}！' },
      { kind: 'drain', id: 'detune', name: '走音', from: 7, spCost: 10, sp: 10, text: '{caster}的音調一歪，{target}失去了{value}點SP。' },
      { kind: 'resonate', id: 'dissonance', name: '不協和音', from: 10, spCost: 15, stacks: 2, text: '{caster}奏出不協和音，{target}身上的共鳴更強烈了！' }
    ]
  },
  // 管風琴魔像（菁英）：場地特效——活著時每回合開始，全場（包括自己）各疊 1 層共鳴
  organ: {
    id: 'organ', name: '管風琴魔像', rarity: 'elite', from: 7, cost: 0.9,
    stats: { hp: 1.0, atk: 0.9, def: 150, spd: 100 },
    traits: [{ kind: 'field', resonance: 1, text: '管風琴的低鳴在大廳裡迴盪……' }],
    skills: [
      { kind: 'attack', id: 'chord', name: '重和弦', from: 7, spCost: 15, power: 1.0, target: 'all' }
    ]
  }
};

// locked: true 的地區一開始不開放，要由王的獎勵（rewards.unlockRegions）開啟；目前兩區都一開始就開放。
const REGIONS = {
  // area：第幾區（掉落池＝第一區＋本區專屬，見 dropTable.inArea）
  ruins: { id: 'ruins', name: '廢都', area: 1, count: [1, 3], budget: 0.7, monsters: ['dog', 'circle', 'doll', 'goblin', 'golem'] },
  sewer: { id: 'sewer', name: '地下水道', area: 1, count: [2, 5], budget: 0.85, monsters: ['rat', 'tentacle', 'slime', 'mimic', 'scavenger'] },
  // 第二區（2026-11-21）：打倒廢都中央廳後開放；地區特色＝共鳴（resonance.js）。第 3 種一般怪與稀有怪使用者還沒想好。
  hall: { id: 'hall', name: '和聲音樂廳', area: 2, locked: true, count: [2, 4], budget: 0.7, resonance: true, monsters: ['fairy', 'conductor', 'cannon', 'noise', 'organ'] }
};

// ── 技能建構 ────────────────────────────────────────────────

const TARGET = { single: 'ENEMY_SINGLE', all: 'ENEMY_ALL', self: 'SELF', allySingle: 'ALLY_SINGLE', allyAll: 'ALLY_ALL', enemy: 'ENEMY_SINGLE' };

// 文字樣板：{caster}、{target}、{value} 換成戰報當下的值（框架的 text 收字串或函式）
function template(str, casterName) {
  if (str === undefined) return undefined;
  const fixed = str.replaceAll('{caster}', casterName);
  return fixed.includes('{') ? ctx => fixed.replaceAll('{target}', ctx.target?.name ?? '').replaceAll('{value}', String(ctx.value ?? '')) : fixed;
}

function buildSkill(spec, def, stats, casterName) {
  // 框架原樣使用 text，所以在這裡把施放者名字放進開頭（同一種怪有 A、B 時也分得出是誰）
  const text = { action: spec.text !== undefined ? template(spec.text, casterName) : `${casterName} 使出${spec.name}，`,
    ...(spec.hitText !== undefined ? { hit: template(spec.hitText, casterName) } : {}),
    ...(spec.missText !== undefined ? { miss: template(spec.missText, casterName) } : {}) };
  const spell = spec.spell ?? def.spell;
  const stat = spell ? 'int' : 'atk';
  const spellFlags = spell ? { uncritable: true, uncounterable: true } : {};
  const base = { id: `${def.id}_${spec.id}`, name: spec.name };
  if (spec.kind === 'attack') {
    const intro = spec.intro !== undefined ? [{ type: 'TEXT', text: { action: template(spec.intro, casterName) } }] : [];
    if (spec.target === 'random') {
      // 每一擊各自挑目標（inheritTarget: false 讓框架每段重抽 ENEMY_SINGLE）
      const hits = spec.hits ?? 1;
      const actions = Array.from({ length: hits }, (_, i) => ({ type: 'DAMAGE', targetType: 'ENEMY_SINGLE', inheritTarget: false, power: spec.power, stat,
        text: { ...text, ...(spec.hitTexts?.[i] !== undefined ? { action: template(spec.hitTexts[i], casterName) } : {}) }, ...spellFlags }));
      return new Skill({ ...base, ...spellFlags, actions: [...intro, ...actions] });
    }
    const actions = [...intro, { type: 'DAMAGE', targetType: TARGET[spec.target], power: spec.power, stat, text, ...(spec.hits ? { hits: spec.hits } : {}), ...spellFlags }];
    if (spec.recoil) return withRecoil(new Skill({ ...base, ...spellFlags, actions }), spec, casterName);
    if (spec.debuff) {
      const d = spec.debuff;
      actions.push({ type: 'BUFF', targetType: TARGET[spec.target], requiresDamage: true, text: { action: '', buff: template(d.text ?? `{target} 受到了${d.name}！`, casterName) },
        buffs: [{ id: `monster_debuff:${spec.id}`, name: d.name, type: 'STAT', duration: d.duration, stackPolicy: 'refresh', polarity: 'negative', dispellable: true,
          effect: s => { s[d.stat] = (s[d.stat] ?? 0) * d.mult; } }] });
    }
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
      shield: Math.max(1, Math.round(spec.power != null ? (stats[stat] ?? 0) * spec.power : stats.maxHp * spec.ratio)), polarity: 'positive', dispellable: true }] }] });
  }
  // ── 干擾型（無序音符）──
  if (spec.kind === 'debuff') {
    const mults = spec.stats;
    return new Skill({ ...base, actions: [{ type: 'BUFF', targetType: 'ENEMY_SINGLE', text: { action: template(spec.text, casterName), buff: template(spec.buffText, casterName) },
      buffs: [{ id: `monster_debuff:${def.id}_${spec.id}`, name: spec.name, type: 'STAT', duration: spec.duration, stackPolicy: 'refresh', polarity: 'negative', dispellable: true,
        effect: st => { for (const [key, mult] of Object.entries(mults)) st[key] = (st[key] ?? 0) * mult; } }] }] });
  }
  if (spec.kind === 'silence') {
    const blocked = spec.blockedText;
    return new Skill({ ...base, actions: [{ type: 'BUFF', targetType: 'ENEMY_SINGLE', text: { action: template(spec.text, casterName), buff: template(spec.buffText, casterName) },
      buffs: [{ id: `monster_silence:${def.id}_${spec.id}`, name: spec.name, type: 'STAT', duration: spec.duration, stackPolicy: 'refresh', polarity: 'negative', dispellable: true,
        effect: () => {}, silence: true, ...(blocked ? { message: ({ entity, skill }) => blocked.replaceAll('{target}', entity.name).replaceAll('{skill}', skill.name) } : {}) }] }] });
  }
  if (spec.kind === 'drain') {
    const skill = buildSpDrainSkill({ sp: spec.sp, name: spec.name, text: spec.text }, def);
    skill.id = base.id;
    return skill;
  }
  if (spec.kind === 'resonate') {
    // 不協和音：替一個敵人疊共鳴層數（沒有共鳴的地區只顯示文字，不疊）
    const skill = new Skill({ ...base, actions: [{ type: 'TEXT', targetType: 'ENEMY_SINGLE', text: { action: template(spec.text, casterName) } }] });
    const baseExecute = skill.execute;
    skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
      const start = logger.logs?.length ?? 0;
      const result = baseExecute.call(this, caster, allies, enemies, logger, context, options);
      const targetId = (logger.logs ?? []).slice(start).find(l => l.targetId)?.targetId;
      const target = enemies.find(e => e.id === targetId) ?? enemies.find(e => e.isAlive);
      if (target?.hasResonance) require('./resonance').addResonance(target, spec.stacks, logger, context);
      return result;
    };
    return skill;
  }
  if (spec.kind === 'solo') {
    // 獨奏：攻擊力最高的隊友（不含自己）在這個行動槽之後多行動一次。那一動照平常選招（蓄力中就發射），但不會再選到獨奏
    let chosen = null;
    const skill = new Skill({ ...base, actions: [{ type: 'TEXT', text: { action: ctx => (spec.text ?? '').replaceAll('{caster}', ctx.caster?.name ?? casterName).replaceAll('{target}', chosen?.name ?? '') } }] });
    const pickTarget = (entity, context) => {
      const allies = entity.team === 'A' ? context.teamA : context.teamB;
      return allies.filter(a => a !== entity && a.isAlive && a.canAct())
        .sort((x, y) => ((y.getEffectiveStats?.() ?? y.stats).atk ?? 0) - ((x.getEffectiveStats?.() ?? x.stats).atk ?? 0))[0] ?? null;
    };
    const baseExecute = skill.execute;
    skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
      chosen = context?.teamA ? pickTarget(caster, context) : null;
      const result = baseExecute.call(this, caster, allies, enemies, logger, context, options);
      if (chosen && context?.insertAction) context.insertAction(chosen, pickMonsterAction(chosen, context, { exclude: 'solo' }));
      return result;
    };
    const baseCanCast = skill.canCast;
    skill.canCast = function canCast(entity, context, opts) {
      if (context?.teamA && !pickTarget(entity, context)) return false;
      return baseCanCast.call(this, entity, context, opts);
    };
    return skill;
  }
  if (spec.kind === 'canon') {
    // 卡農：其他活著的隊友各記一個「下一動重複上一招」（canonPending，不顯示）；選招時由 monsterSkillResolver 換上來
    const skill = new Skill({ ...base, actions: [{ type: 'TEXT', text }] });
    const baseExecute = skill.execute;
    skill.execute = function execute(caster, allies, ...rest) {
      const result = baseExecute.call(this, caster, allies, ...rest);
      for (const ally of allies) if (ally !== caster && ally.isAlive) ally.canonPending = true;
      return result;
    };
    const baseCanCast = skill.canCast;
    skill.canCast = function canCast(entity, context, options) {
      if (context?.teamA && context?.teamB) {
        const allies = entity.team === 'A' ? context.teamA : context.teamB;
        if (!allies.some(a => a !== entity && a.isAlive && a.lastSkill)) return false;   // 沒有隊友出過招就不放
      }
      return baseCanCast.call(this, entity, context, options);
    };
    skill.isCanon = true;
    return skill;
  }
  if (spec.kind === 'cleanse') {
    // 清除隊友（含自己）身上可驅散的減益；框架沒有驅散動作，用 TEXT 動作開頭、自己移除
    const skill = new Skill({ ...base, actions: [{ type: 'TEXT', targetType: 'SELF', text: { action: template(spec.text ?? '{caster} 清除了隊友的減益！', casterName) } }] });
    const baseExecute = skill.execute;
    skill.execute = function execute(caster, allies, enemies, logger, context, options) {
      const result = baseExecute.call(this, caster, allies, enemies, logger, context, options);
      const removed = allies.filter(a => a.isAlive).flatMap(a => a.removeBuffs('negative').map(b => `${a.name}的${b.name}`));
      logger.addLog({ type: 'TEXT', actorId: caster.id, message: removed.length ? `清除了 ${removed.join('、')}。` : '但隊友身上沒有可以清除的減益。' });
      return result;
    };
    // 隊友身上沒有可清除的減益時不施放（2026-11-21：不然指揮家會一直空放「整頓」）
    const baseCanCast = skill.canCast;
    skill.canCast = function canCast(entity, context, options) {
      if (context?.teamA && context?.teamB) {
        const allies = entity.team === 'A' ? context.teamA : context.teamB;
        if (!allies.some(a => a.isAlive && a.buffs.some(b => b.polarity === 'negative' && b.dispellable))) return false;
      }
      return baseCanCast.call(this, entity, context, options);
    };
    return skill;
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

/**
 * 王的轉階段（phase）：血量第一次低於 at 時——
 *   mults：屬性乘上倍率到戰鬥結束（例如 { spd: 1.5, atk: 1.15, int: 1.15 }）；text：旁白一句；
 *   summon（選填）：在自己這一隊召喚一個不會行動的單位（例如應急動力源）：
 *     { name, hpRatio（王最大生命的比例）, reduction（承受傷害減少）, spd, summonText, breakRatio（被打倒時王受到王最大生命的這個比例）, breakText,
 *       drain?: { sp, name, text } }
 *     繼承王的防禦；被打倒後，在下一個行動結束（或回合開始）時對王造成 breakRatio 的傷害（直接扣血，不吃防禦與減傷）。
 *     有 drain：輪到它時只會用這一招——讓對面的主角失去 sp 點 SP（不夠就扣到 0；不造成傷害、不會落空）；沒有 drain 就不行動。
 *   文字裡的 {caster} 是王的名字、{player} 是對面主角的名字、{summon} 是召喚物的名字。
 *
 * ── 閃避反擊 evadeCounter（選填，2026-11-20 使用者：反擊必須先閃避成功）──────────
 *   { points, skill?, text? }：這隻怪閃避掉一擊之後，依 EVADE_COUNTER 的點數曲線擲反擊（攻擊方沒有點數＝0），
 *   成功就立刻還擊攻擊者一下：有 skill（attack 技能格式）且 SP 夠就用它並扣 SP，否則用預設反擊（普攻倍率一擊，text 是開頭）。
 *   還擊必定命中、不會再被反擊（框架的 counterSource）；法術（uncounterable）被躲開也不反擊。
 *   框架原本「命中才判定」的反擊不用：所有單位的 stats.counter 保持 0。
 */
// 旁白裡的 {player}：對面隊伍的主角（id 'hero'，沒有就第一個）的名字——玩家可以改名，所以不能寫死「玩家」
function playerNameFor(self, engine) {
  const foes = !engine ? [] : self.team === 'A' ? engine.teamB : engine.teamA;
  return (foes.find(e => e.id === 'hero') ?? foes[0])?.name ?? '玩家';
}

function buildPhasePassives(trait, def) {
  let entered = false;
  let source = null, paid = false;
  let engineRef = null;
  const fill = (str, self, extra = {}) => Object.entries({ player: playerNameFor(self, engineRef), ...extra })
    .reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str.replaceAll('{caster}', self.name));
  const enter = {
    id: `monster_phase:${def.id}`,
    trigger: 'AFTER_DAMAGE_RECEIVED',
    enabled: self => !entered && self.isAlive && self.stats.hp < self.stats.maxHp * trait.at,
    action(self, hit, logger, engine) {
      entered = true;
      engineRef = engine;
      const mults = trait.mults ?? {};
      self.addBuff({ id: `monster_phase:${def.id}`, name: trait.name ?? '第二階段', type: 'STAT', duration: Infinity, polarity: 'positive', dispellable: false,
        effect: s => { for (const [key, mult] of Object.entries(mults)) s[key] = (s[key] ?? 0) * mult; } });
      if (trait.text) logger.addLog({ type: 'TEXT', actorId: self.id, message: fill(trait.text, self) });
      const spec = trait.summon;
      if (!spec || !engine) return;
      const hp = Math.max(1, Math.round(self.stats.maxHp * spec.hpRatio));
      source = new Entity({ id: `${self.id}_source`, name: spec.name, team: self.team, actionDisabled: !spec.drain, fatigueEnabled: false,
        stats: { hp, maxHp: hp, atk: 0, int: 0, def: self.stats.def, spd: spec.spd ?? 50, sp: 0, maxSp: 0, eva: 0, hit: 0, skillCastRate: 0 },
        normalAttack: spec.drain ? buildSpDrainSkill(spec.drain, def) : new Skill({ id: `${def.id}_source_idle`, name: '待機', actions: [{ type: 'TEXT', text: { action: '' } }] }),
        normalAttackSpCost: 0 });
      if (spec.reduction) source.addBuff({ id: `monster_source_guard:${def.id}`, name: '減傷', type: 'STAT', duration: Infinity, polarity: 'positive', dispellable: false,
        effect: () => {}, damageTaken: { multiplier: 1 - spec.reduction } });
      // 王倒下時動力源一起消失（勝負只看王；同幻影的做法）
      let alive = source.isAlive;
      Object.defineProperty(source, 'isAlive', { get: () => alive && self.isAlive, set: value => { alive = value; }, configurable: true });
      source.summonerId = self.id;
      source.phaseSource = true;
      (self.team === 'A' ? engine.teamA : engine.teamB).push(source);
      logger.addLog({ type: 'SUMMON', actorId: self.id, targetId: source.id, message: fill(spec.summonText ?? '{caster} 召喚了{summon}！', self, { summon: spec.name }) });
    }
  };
  // 動力源倒下 → 王受傷：每個行動之後與回合開始時檢查（動力源被持續傷害打倒也算得到）
  const check = (self, _ctx, logger, engine) => {
    if (engine) engineRef = engine;
    if (!source || paid || source.stats.hp > 0 || !self.isAlive || engine?.result) return;
    paid = true;
    const amount = Math.max(1, Math.round(self.stats.maxHp * trait.summon.breakRatio));
    if (trait.summon.breakText) logger.addLog({ type: 'TEXT', actorId: self.id, message: fill(trait.summon.breakText, self, { summon: source.name }) });
    const hit = self.takeDamage(amount, logger, { source: 'DIRECT' });
    logger.addLog({ type: 'DAMAGE', actorId: source.id, targetId: self.id, value: hit.actualDamage, message: `${self.name} 受到了 ${hit.actualDamage} 點傷害！` });
    self.finishDamage(hit, logger, engine);
  };
  if (!trait.summon) return [enter];
  return [enter,
    { id: `monster_phase_break:${def.id}`, trigger: 'AFTER_ACTION', action: check },
    { id: `monster_phase_break_round:${def.id}`, trigger: 'ROUND_START', action: check }];
}

// 旁白（王用）：texts.opening 開戰時印；victory（王打贏）／death（王倒下）在戰鬥結束時依勝負印（倒下的單位也會跑 BATTLE_END）。
// 每一項可以是字串或字串陣列（陣列一行一筆）；{caster} 換成王的名字、{player} 換成對面主角的名字。
function buildNarrationPassives(texts) {
  if (!texts) return [];
  const say = (self, logger, engine, lines) => {
    for (const line of [].concat(lines)) logger.addLog({ type: 'TEXT', actorId: self.id, message: line.replaceAll('{caster}', self.name).replaceAll('{player}', playerNameFor(self, engine)) });
  };
  const out = [];
  if (texts.opening) out.push({ id: 'monster_text_opening', trigger: 'BATTLE_START', action: (self, _b, logger, engine) => say(self, logger, engine, texts.opening) });
  if (texts.victory || texts.death) out.push({ id: 'monster_text_end', trigger: 'BATTLE_END', action: (self, { winner }, logger, engine) => {
    if (winner === `TEAM_${self.team}` && texts.victory) say(self, logger, engine, texts.victory);
    else if (winner && winner !== `TEAM_${self.team}` && winner !== 'DRAW' && texts.death && !self.isAlive) say(self, logger, engine, texts.death);
  } });
  return out;
}

/**
 * 扣 SP 的招式（應急動力源用）：挑對面的主角（id 'hero'；沒有就隨機一個有 SP 的），扣 spec.sp 點（不夠扣到 0）。
 * 不造成傷害、不會落空。文字 spec.text：{caster} 施放者、{target} 目標、{value} 實際扣掉的 SP。
 */
function buildSpDrainSkill(spec, def) {
  let lost = 0;
  let victim = null;
  const skill = new Skill({ id: `${def.id}_source_drain`, name: spec.name, actions: [{ type: 'TEXT', targetType: 'ENEMY_SINGLE',
    text: { action: ctx => spec.text.replaceAll('{caster}', ctx.caster?.name ?? '').replaceAll('{target}', victim?.name ?? '').replaceAll('{value}', String(lost)) } }] });
  const base = skill.execute;
  skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    const alive = enemies.filter(e => e.isAlive && (e.stats.maxSp ?? 0) > 0);
    victim = alive.find(e => e.id === 'hero') ?? alive[Math.floor((context?.rng ?? Math.random)() * alive.length)] ?? null;
    lost = 0;
    if (victim && !caster.actionDisabled) {
      lost = Math.min(spec.sp, Math.max(0, victim.stats.sp));
      victim.stats.sp -= lost;
      victim.syncFatigue?.(logger);
    }
    if (!victim) return base.call(this, caster, allies, [], logger, context, options);
    return base.call(this, caster, allies, [victim], logger, context, options);
  };
  return skill;
}

function withSpCost(skill, cost) {
  if (cost > 0) skill.actions[0] = { ...skill.actions[0], spCost: cost };
  return skill;
}

// 閃避反擊（見檔頭 evadeCounter）。點數讀 stats.evadeCounter（怪物由 evadeCounter.points 寫進去，玩家由裝備屬性來）。
function buildEvadeCounterPassive(def, stats, entityName) {
  const spec = def.evadeCounter;
  stats.evadeCounter = spec.points;
  return makeEvadeCounterPassive({ id: `monster_evade_counter:${def.id}`, stat: def.spell ? 'int' : 'atk', crit: !def.spell, text: spec.text, entityName, hits: spec.hits ?? 1, power: spec.power ?? 1,
    special: spec.skill ? buildSkill(spec.skill, def, stats, entityName) : null, specialCost: spec.skill?.spCost ?? 0, skillId: def.id });
}

/**
 * 玩家的閃避反擊（2026-11-21）：stats.evadeCounter > 0 時掛上；反擊是普攻（stat）× power 一擊（氣鳴楯【菲爾查哈】把 power 提高）。
 */
function buildPlayerEvadeCounterPassive({ stat = 'atk', power = 1, ignoreDefense = false, name = '玩家', text } = {}) {
  return makeEvadeCounterPassive({ id: 'player_evade_counter', stat, crit: true, power, ignoreDefense, text, entityName: name, skillId: 'hero' });
}

// 反擊的句子：字串（第一擊；連擊用預設「第 N 擊」），或陣列 [第一擊, 第二擊, …]（{target} 換成被反擊的人，銀用）
function counterText(text, entityName) {
  if (!Array.isArray(text)) return { action: template(text ?? '{caster} 趁隙反擊，', entityName) };
  const resolve = (line, ctx) => { const t = template(line, entityName); return typeof t === 'function' ? t(ctx) : t; };
  return { action: ctx => resolve(text[0], ctx), combo: ctx => resolve(text[Math.min(text.length - 1, (ctx.hitIndex ?? 1) - 1)], ctx) };
}

// hits：反擊打幾下（銀是兩下）。self.counterBoost = { points, power }（選填，王的狀態用）：反擊點數加成、反擊傷害倍率。
function makeEvadeCounterPassive({ id, stat, crit, power = 1, hits = 1, ignoreDefense = false, text, entityName, special = null, specialCost = 0, skillId }) {
  const flags = crit ? {} : { uncritable: true };
  const basic = new Skill({ id: `${skillId}_evade_counter`, name: '反擊', ...flags,
    actions: [{ type: 'DAMAGE', stat, power, ...(hits > 1 ? { hits } : {}), ...flags, ...(ignoreDefense ? { ignoreDefense: true } : {}), text: counterText(text, entityName) }] });
  return {
    id,
    trigger: 'AFTER_EVADE',
    enabled: (self, evasion) => Boolean(evasion.caster?.isAlive) && !(evasion.skill?.uncounterable || evasion.action?.uncounterable),
    action(self, evasion, logger, engine) {
      if (!engine || engine.result || engine.counterSource || !self.canAct()) return;
      const attacker = evasion.caster;
      const boost = self.counterBoost ?? {};
      const chance = evadeCounterChance((self.stats.evadeCounter ?? 0) + (boost.points ?? 0), attacker.stats?.evadeCounter ?? 0);
      if (!((engine.rng ?? Math.random)() < chance)) return;
      // 怪物技能的 spCost 寫在技能規格上（框架的 Skill 只看 action.spCost），這裡自己扣
      const cost = specialCost;
      const useSpecial = special && self.stats.sp >= cost;
      const reply = useSpecial ? special : basic;
      if (useSpecial) self.stats.sp -= cost;
      const source = { actorId: self.id, targetId: attacker.id, incomingSkillId: evasion.skill?.id };
      const allies = self.team === 'A' ? engine.teamA : engine.teamB;
      const enemies = self.team === 'A' ? engine.teamB : engine.teamA;
      const mult = boost.power ?? 1;
      const saved = reply.actions;
      if (mult !== 1) reply.actions = saved.map(action => action.type === 'DAMAGE' ? { ...action, power: (action.power ?? 1) * mult } : action);
      try {
        engine.withCounterSource(source, () => reply.execute(self, allies, enemies, logger, engine, { targets: [attacker], ignoreSp: true }));
      } finally { reply.actions = saved; }
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
    def: def.stats.def ?? BASE_MONSTER.def, spd: def.stats.spd ?? BASE_MONSTER.spd, sp: def.stats.sp ?? Math.round(MONSTER_SP.base + MONSTER_SP.perLevel * (difficulty - 1)),
    eva: def.stats.eva ?? 0, hit: def.stats.hit ?? 0
  };
  const stats = scaleMonster({ ...raw, hp: Math.round(raw.hp), maxHp: Math.round(raw.hp) }, difficulty);
  Object.assign(stats, { maxSp: stats.sp, skillCastRate: def.skillCastRate ?? 0.35 });
  const stat = def.spell ? 'int' : 'atk';
  const entityName = name ?? def.name;
  const normalAttack = new Skill({ id: `${def.id}_attack`, name: '攻擊', actions: [{ type: 'DAMAGE', stat, ...(def.spell ? { uncritable: true, uncounterable: true } : {}),
    ...(def.normalAttackText !== undefined ? { text: { action: template(def.normalAttackText, entityName) } } : {}) }],
    ...(def.spell ? { uncritable: true, uncounterable: true } : {}) });
  // spCost 要放在第一個 action 上框架才會扣（Skill 只讀 action.spCost）。2026-11-20 修正：之前寫在技能層級，怪物放技能從來不扣 SP。
  let charge = null;
  const skills = def.skills.filter(spec => difficulty >= spec.from).map(spec => {
    if (spec.charge) {
      // 蓄力（比照玩家寶石的蓄力）：這一動只扣 SP、掛「蓄力中」，下一個能行動的槽由 monsterSkillResolver 換成本體發射
      const markerId = `monster_charged:${def.id}_${spec.id}`;
      const release = remember(buildSkill(spec, def, stats, entityName));
      charge = { markerId, release };
      return remember(withSpCost(new Skill({ id: `${def.id}_${spec.id}_charge`, name: spec.name, actions: [{ type: 'BUFF', targetType: 'SELF',
        text: { action: template(spec.chargeText ?? '{caster} 開始蓄力，', entityName), buff: '' },
        buffs: [{ id: markerId, name: '蓄力中', type: 'STAT', polarity: 'neutral', duration: 1e6, stackPolicy: 'refresh', dispellable: false, effect: () => {} }] }] }), spec.spCost));
    }
    const skill = withSpCost(buildSkill(spec, def, stats, entityName), spec.spCost);
    return skill.isCanon ? skill : remember(spec.chase && def.harmony ? withHarmonyChase(skill, def) : skill);
  });
  // noAttack（無序音符）：普攻的位置換成指定技能的不耗 SP 版本，永遠不普攻
  const noAttackSpec = def.noAttack ? def.skills.find(spec => spec.id === def.noAttack) : null;
  const plainAttack = noAttackSpec ? buildSkill(noAttackSpec, def, stats, entityName) : normalAttack;
  const attack = remember(def.harmony && difficulty >= (def.harmony.normalFrom ?? Infinity) ? withHarmonyChase(plainAttack, def) : plainAttack);
  const TRAIT_BUILDERS = { split: buildSplitPassive, ambush: buildAmbushPassive, enrage: buildEnragePassive, phase: buildPhasePassives, field: buildFieldPassive };
  const passives = (def.traits ?? []).filter(trait => difficulty >= (trait.from ?? 1)).flatMap(trait => {
    if (!TRAIT_BUILDERS[trait.kind]) throw new Error(`怪物「${def.id}」的特性種類不明：${trait.kind}`);
    return TRAIT_BUILDERS[trait.kind](trait, def, { difficulty, stats, entityName });
  });
  passives.push(...buildNarrationPassives(def.texts));
  if (def.evadeCounter) passives.push(buildEvadeCounterPassive(def, stats, entityName));
  const entity = new Entity({ id: id ?? def.id, name: entityName, team: 'B', normalAttack: attack, normalAttackSpCost: 2, skills, passives, stats });
  entity.monsterId = def.id;
  if (charge) entity.monsterCharge = charge;
  return entity;
}

/**
 * 反噬（翅音蟲的捨身連擊）：這次施放對敵人造成的傷害合計 × spec.recoil，施放完自己受到同量的直接傷害（不吃防禦、可能致死）。
 * 從這次施放新增的戰報裡加總（反擊等別人打的不算）。
 */
function withRecoil(skill, spec, casterName) {
  const base = skill.execute;
  skill.execute = function execute(caster, allies, enemies, logger, context, options) {
    const start = logger.logs?.length;
    const seen = [];
    const tap = start === undefined ? { addLog: entry => { seen.push(entry); logger.addLog(entry); } } : logger;
    const result = base.call(this, caster, allies, enemies, tap, context, options);
    const fresh = start === undefined ? seen : logger.logs.slice(start);
    const dealt = fresh.filter(l => l.type === 'DAMAGE' && l.actorId === caster.id && !l.isCounter && enemies.some(e => e.id === l.targetId))
      .reduce((sum, l) => sum + (l.value ?? 0), 0);
    const amount = Math.floor(dealt * spec.recoil);
    if (amount > 0 && caster.isAlive && !context?.result) {
      const hit = caster.takeDamage(amount, logger, { source: 'DIRECT', tags: ['recoil'] });
      const lost = hit.actualDamage ?? amount;
      logger.addLog({ type: 'DAMAGE', actorId: caster.id, targetId: caster.id, skillId: this.id, value: lost,
        message: (spec.recoilText ?? '{caster}受到了反噬，損失了 {value} 點生命！').replaceAll('{caster}', casterName).replaceAll('{value}', String(lost)) });
      caster.finishDamage?.(hit, logger, context);
    }
    return result;
  };
  return skill;
}

// 記住上一次用的技能（卡農用）：卡農本身不包，所以不會被記住
function remember(skill) {
  const baseExecute = skill.execute;
  skill.execute = function execute(caster, ...rest) {
    if (!rest[3]?.counterSource) caster.lastSkill = skill;
    return baseExecute.call(this, caster, ...rest);
  };
  return skill;
}

/**
 * 怪物的選招替換（接在玩家 loadout 的 resolver 前面）：
 *   1. 身上有「蓄力中」→ 移除標記，這一槽發射本體（同時用掉卡農的重複）。
 *   2. 被卡農記了「重複上一招」→ 用上一次的技能（照扣 SP；不能用就照平常選）。蓄力發射後被重複＝直接再發射一次（使用者先選 B）。
 * 回傳 undefined 代表這一槽照常。暈眩、動不了的槽不會選招，標記留到下一個能行動的槽。
 */
/** 替怪物選一招（獨奏的額外行動用）：蓄力中先發射；否則照技能施放率擲骰，從能用的技能裡隨機挑；都不行就普攻。 */
function pickMonsterAction(entity, engine, { exclude } = {}) {
  const charge = entity.monsterCharge;
  if (charge && entity.buffs.some(b => b.id === charge.markerId)) {
    entity.buffs = entity.buffs.filter(b => b.id !== charge.markerId);
    return charge.release;
  }
  const rng = engine.rng ?? Math.random;
  const usable = entity.skills.filter(skill => !skill.id.endsWith(`_${exclude}`) && skill.canCast(entity, engine));
  if (usable.length && rng() < (entity.stats.skillCastRate ?? 0.35)) return usable[Math.floor(rng() * usable.length)];
  return entity.normalAttack;
}

function monsterSkillResolver(ctx) {
  const { caster, engine } = ctx;
  if (!caster?.monsterId) return undefined;
  const custom = caster.gemResolver?.(ctx);   // 王自己的選招規則（例如銀的舉盾）優先
  if (custom) return custom;
  const charge = caster.monsterCharge;
  if (charge && caster.buffs.some(b => b.id === charge.markerId)) {
    caster.buffs = caster.buffs.filter(b => b.id !== charge.markerId);
    caster.canonPending = false;
    return charge.release;
  }
  if (caster.canonPending) {
    caster.canonPending = false;
    const last = caster.lastSkill;
    if (last && last.canCast(caster, engine)) return last;
  }
  return undefined;
}

/**
 * 和聲追擊（和聲妖精）：這一招打完後，場上其他同種的怪（活著、能行動）各對同一個目標追擊一下（攻擊 × harmony.power）。
 * 追擊是普通的攻擊：可以被閃避、被反擊，也會疊共鳴；追擊本身不再引發追擊。反擊途中不追擊。
 */
function withHarmonyChase(skill, def) {
  const spec = def.harmony;
  const stat = def.spell ? 'int' : 'atk';
  const baseExecute = skill.execute;
  skill.execute = function execute(caster, allies, enemies, logger, context, options = {}) {
    const start = logger.logs?.length ?? 0;
    const result = baseExecute.call(this, caster, allies, enemies, logger, context, options);
    if (!context || context.result || context.counterSource) return result;
    const targetId = (logger.logs ?? []).slice(start).find(l => l.actorId === caster.id && (l.type === 'DAMAGE' || l.type === 'MISS') && l.targetId)?.targetId;
    const target = enemies.find(e => e.id === targetId);
    if (!target) return result;
    for (const mate of allies) {
      if (mate === caster || mate.monsterId !== def.id || !mate.isAlive || !mate.canAct() || !target.isAlive || context.result) continue;
      const chase = new Skill({ id: `${def.id}_harmony_chase`, name: '和聲追擊', actions: [{ type: 'DAMAGE', stat, power: spec.power, text: { action: template(spec.text, mate.name) } }] });
      chase.execute(mate, allies, enemies, logger, context, { targets: [target], ignoreSp: true });
    }
    return result;
  };
  return skill;
}

// 場地特效（管風琴魔像）：活著時每回合開始，全場（雙方、包括自己）各疊 trait.resonance 層共鳴（resonance.js）
function buildFieldPassive(trait) {
  const { addResonance } = require('./resonance');
  return [{
    id: 'monster_field_resonance',
    trigger: 'ROUND_START',
    action(self, _payload, logger, engine) {
      if (!self.isAlive || !engine || engine.result) return;
      if (trait.text) logger.addLog({ type: 'TEXT', actorId: self.id, message: trait.text });
      for (const unit of [...engine.teamA, ...engine.teamB]) if (unit.isAlive) addResonance(unit, trait.resonance, logger, engine);
    }
  }];
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
    // group（選填）：抽到時一次出這麼多隻（例如和聲妖精 2 隻），要付得起、也要放得下
    const affordable = normals.filter(def => (def.group ?? 1) * def.cost <= region.budget - spent() + 1e-9 && picks.length + (def.group ?? 1) <= max
      && (def.maxPerEncounter == null || picks.filter(p => p === def).length < def.maxPerEncounter));
    if (!affordable.length) break;
    const pick = affordable[Math.min(affordable.length - 1, Math.floor(rng() * affordable.length))];
    for (let g = 0; g < (pick.group ?? 1); g++) picks.push(pick);
  }
  while (picks.length < min) for (let g = 0; g < (cheapest.group ?? 1); g++) picks.push(cheapest);
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

module.exports = {
  monsterSkillResolver, pickMonsterAction, BASE_MONSTER, MONSTER_SP, RARE_CHANCE, ELITE_CHANCE, MONSTERS, REGIONS, EVADE_COUNTER, evadeCounterChance, buildPlayerEvadeCounterPassive, buildMonster, buildFromDef, availableMonsters, rollEncounter };
