'use strict';

/**
 * 第二區王「老婦人 銀」（使用者設計 2026-11-22；數值與所有文本是我擬的佔位）。
 *
 * ── 場景和弦（取代撥弦槍的和弦，全場只有一個值）──────────────────────────
 *   −60～100，起始 0（裝備撥弦槍入場是 50，另有開場文本）。玩家每 1 點 +1% 物理與法術傷害（負值就是 −1%）。
 *   玩家攻擊每擊每個目標 +4；銀打中玩家 −2、其他怪 −1；我方召喚物被打中也算（linkChordSummon）。
 *   集滿 100：玩家的勝利的旋律（同撥弦槍：3 回合，回復 25%、清除減益、速度 +100%，結束歸零）。
 *   到達 50 印一次文本，之後要等任何一方的勝利的旋律發動才會再印。
 *   任何一方的勝利的旋律期間鎖住，不增不減（玩家優先：玩家的期間不累計扣值，所以銀的不會插進來）。
 *
 * ── 銀的被動 ─────────────────────────────────────────────────────
 *   1. 銀打中玩家扣掉的和弦累計滿 60（2026-11-22 使用者：只算銀扣的）→ 銀的勝利的旋律 2 回合：和弦固定 −60，
 *      但玩家傷害不減（加成算 0%，使用者 2026-11-22）；所有攻擊都被閃避（untouchable，照樣觸發反擊）；
 *      反擊點數 +100、反擊傷害 ×1.5。結束時和弦變 0、累計歸零（之後可以再觸發）。
 *   2. 生命第一次降到 50%：停在 50%（BEFORE_DAMAGE 截掉多的），無敵到她下一個行動槽；獲得舉盾、冰盾與被動 3；
 *      下一個行動槽一開始解除無敵並舉盾。
 *   3. 50% 以下：和弦每被扣滿 20 點（另外計數）放一次群體攻擊（插在當下的行動之後）。
 *   4. 第 1 回合無敵、不行動；第 2 回合開始解除無敵、立刻發動殘滅大魔術（之後每回合開始再造成群體傷害）。
 *
 * ── 技能 ─────────────────────────────────────────────────────────
 *   法術抗性：法術技能打銀的傷害 × 0.7（常駐）。
 *   翅音（四連擊）；反擊兩下（閃避反擊）；舉盾（閃避 ×3 ＋ 100、反擊點數 +60、承受傷害 × 0.8；舉著時普攻不攻擊、技能只會放下盾牌；
 *   每次輪到她有 30% 放下，放下後多行動一次）；冰盾（50% 以下；生命上限 15% 的護盾並多行動一次，冷卻 3 回合；
 *   被打破時對打破的人造成攻擊 150%）。
 */

const { Skill } = require('../src');
const { pickMonsterAction } = require('./monsters');

const FIELD = { min: -60, max: 100, gain: 4, perPoint: 0.01, silverLoss: 2, otherLoss: 1, cranelanceStart: 50, notice: 50 };
const SILVER = {
  melodyAfterLoss: 60, melodyRounds: 2, melodyBoost: { points: 100, power: 1.5 },
  halfAt: 0.5, aoeEvery: 20,
  shield: { evaMult: 3, evaFlat: 100, points: 60, lowerChance: 0.3, damageTaken: 0.8 },   // 減傷 20%（2026-11-22 使用者：舉盾也要減傷；加了減傷後閃避 +150 → +100，旋風斬維持約 40%）
  spellWard: 0.7,   // 法術技能的傷害 × 0.7（2026-11-22 使用者：法術太強，銀身上 30% 法術減傷）   // evaFlat 30 → 150（2026-11-22 使用者：舉盾閃避提高，旋風斬第 4 階約 40%）
  ice: { ratio: 0.15, cooldown: 3, burst: 1.5 },
  wing: { hits: 4, power: 0.35, spCost: 15 },
  grand: { power: 0.8, echo: 0.3 },
  quake: { power: 0.6 }
};
// 玩家的勝利的旋律（場景版，同撥弦槍）
const PLAYER_MELODY = { rounds: 3, heal: 0.25, spdInc: 1 };

// 佔位文本（使用者之後替換）。{caster} 換成說話的人、{player} 換成玩家名字、{target} 換成目標。
const TEXTS = {   // 2026-11-22 使用者提供（{player} 換成玩家名字、{target} 換成被打的人）
  opening: [
    '離開音樂廳的大門前，站著一位老婦人。她的表情如寒冬一般嚴峻，五彩的山茶花點綴著深藍色的和服。雖然她只是站著，但迴盪在大廳的壯烈音色好似要將萬物全部凍結一般。',
    '銀：「為了我的故友，可不能讓你從這裡過去。」',
    '她舉起手上的長著笛子的盾牌——氣鳴楯，向{player}這麼宣告。'
  ],
  openingCranelance: [
    '{player}手中的撥弦槍宛如不甘示弱一般，將那莊嚴的音色蓋了過去！',
    '銀：「原來如此……」',
    '她似乎想到了過去的事，臉上浮現一絲懷念的笑容。',
    '銀：「……不過我還是不會放水的，上吧。」'
  ],
  notice: '大廳開始響起澎湃的旋律，逐漸將冷冽的音色蓋過。',
  playerMelody: { full: '{player}：「我要奏響『勝利的旋律』來阻止你！」', start: '一陣激昂的樂聲迴盪在整個戰場，{player}的腳步隨著樂聲加快了！', shout: '「BreakNight」！', end: '歌曲結束了，戰場回復原先的平靜。' },
  silverMelody: {
    start: ['銀：「沒用的，我們之間心意（音色）的差距太大了。」', '淒絕的旋律從銀的身上爆發！', '「Foiltach」!'],
    end: ['歌曲結束了，戰場回復原先的平靜。', '銀：「可惜，差一點嗎。」']
  },
  half: ['銀：「……還不夠。」', '大廳的溫度驟降了好幾度，銀的身周出現了好幾塊冰晶。'],
  idle: '銀沒有動，但是眼神從未從{player}的身上移開。',
  raise: '銀舉起了氣鳴楯，準備從{player}的行動中抓出破綻。',
  guard: '銀維持著防禦姿態。',
  lower: '銀放下了氣鳴楯，再度發起進攻！',
  ice: '翅音圍繞在銀的身邊，化為一片片護甲，銀獲得了{value}點護盾！',
  iceBurst: '被擊碎的護甲承受了一部份衝擊，',
  grand: '銀詠唱殘滅大魔術，冷冽的空氣化為冰針刺穿了對手——', grandHit: '冰針刺穿了肌膚，', grandEcho: '殘滅大魔術留下的迴響再度襲來，',
  quake: '{target}逐漸被銀的音色給吞噬，',
  wing: '銀使出翅音，冰柱狀的翅音朝{player}飛去——',   // 每一擊用預設（第 2 擊……）
  normal: '銀揮動手上的盾，',
  counter: ['銀趁機抓住了{target}的肩，', '反手一甩，將{target}摔到了牆上，'],
  death: ['銀：「是你的心意（音色）贏了啊……」', '她重新站了起來，身上一點灰都沒有沾上。', '銀：「過去吧。順便幫我跟我的故友打聲招呼。」'],
  victory: '銀：「好好休息吧——如果能休息到永遠就好了。」'
};

const MAX_TURNS_GUARD = 1e6;

/** 王的定義（bosses.js 用）。stats 是基準怪倍率（難度 12）。 */
const SILVER_DEF = {
  id: 'silver', name: '銀',
  // 模擬後（node gem/boss-check.js silver，TIERS=3,4,5）：第 4 階整套約一半、第 5 階穩贏、第 3 階打不贏
  stats: { hp: 0.75, atk: 0.35, int: 0.4, def: 100, spd: 130, sp: 2000, eva: 20 },
  skillCastRate: 0.4,
  normalAttackText: TEXTS.normal,
  evadeCounter: { points: 80, hits: 2, text: TEXTS.counter },
  texts: { opening: TEXTS.opening, death: TEXTS.death, victory: TEXTS.victory },
  skills: [
    { kind: 'attack', id: 'wing', name: '翅音', from: 1, spCost: SILVER.wing.spCost, target: 'single', hits: SILVER.wing.hits, power: SILVER.wing.power,
      intro: TEXTS.wing, text: '' }
  ],
  setup: 'silver'
};
// 翅音蟲（2026-11-22 使用者改名，原「音翅蟲」）
// 捨身連擊（2026-11-22 使用者設計；倍率、反噬比例、文本我擬）：三連擊，打完自己受到造成傷害 30% 的反噬（直接扣血，可能把自己打死）
const WINGBUG_DEF = { id: 'wingbug', name: '翅音蟲', stats: { hp: 0.15, atk: 0.2, def: 40, spd: 180 },
  skills: [{ kind: 'attack', id: 'reckless', name: '捨身連擊', from: 1, spCost: 10, target: 'single', hits: 3, power: 0.6, recoil: 0.3,
    text: '{caster}不顧一切地撞向{target}，', recoilText: '{caster}被反作用力震傷，損失了 {value} 點生命！' }] };

const fillText = (str, map) => Object.entries(map).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str);

/**
 * 開打前接好場景和弦與銀的機制。engine 已建好、還沒 start。
 * @param {{ engine, hero, monsters, cranelance: boolean }} battle
 */
function setupSilver({ engine, hero, monsters, cranelance }) {
  const silver = monsters.find(m => m.monsterId === 'silver');
  if (!silver) throw new Error('setupSilver：找不到銀');
  const player = hero.name;
  const log = (logger, lines, extra = {}) => { for (const message of [].concat(lines)) logger?.addLog({ type: 'TEXT', message: fillText(message, { player }), ...extra }); };
  // 招式文字：{target} 換成被打的人、{player} 換成玩家
  const tf = line => ctx => fillText(line, { player, target: ctx.target?.name ?? '' });
  const all = () => [...engine.teamA, ...engine.teamB];
  const enemiesOf = self => (self.team === 'A' ? engine.teamB : engine.teamA);
  const alliesOf = self => (self.team === 'A' ? engine.teamA : engine.teamB);

  // ── 場景和弦 ──
  const F = { value: 0, lock: null, lost60: 0, lost20: 0, noticed: false, playerLeft: 0, silverLeft: 0 };
  engine.fieldChord = F;
  const set = (value, logger) => {
    F.value = Math.max(FIELD.min, Math.min(FIELD.max, value));
    hero.gemChord = F.value;
    hero.gemChordBonus = F.lock === 'silver' ? 0 : F.value * FIELD.perPoint;
    if (!F.lock && !F.noticed && F.value >= FIELD.notice) { F.noticed = true; log(logger, TEXTS.notice); }
    if (!F.lock && F.value >= FIELD.max) beginPlayerMelody(logger);
  };
  const VICTORY_ID = 'gem_victory_melody';
  function beginPlayerMelody(logger) {
    F.lock = 'player'; F.playerLeft = PLAYER_MELODY.rounds; F.noticed = false;
    const t = TEXTS.playerMelody;
    for (const line of [t.full, t.start, t.shout]) log(logger, fillText(line, { player }), { actorId: hero.id });
    const healed = hero.heal(Math.floor(hero.stats.maxHp * PLAYER_MELODY.heal), logger, { engine });
    if (healed > 0) logger?.addLog({ type: 'HEAL', actorId: hero.id, targetId: hero.id, value: healed, message: `${hero.name} 回復了 ${healed} 點生命！` });
    hero.removeBuffs('negative');
    hero.addBuff({ id: VICTORY_ID, name: '勝利的旋律', type: 'STAT', duration: MAX_TURNS_GUARD, polarity: 'positive', dispellable: false, stackPolicy: 'refresh',
      effect: stats => { stats.spd *= 1 + PLAYER_MELODY.spdInc; } }, engine);
  }
  function endPlayerMelody(logger) {
    hero.buffs = hero.buffs.filter(b => b.id !== VICTORY_ID);
    F.lock = null; F.lost60 = 0;
    set(0, logger);
    log(logger, TEXTS.playerMelody.end);
  }
  const lose = (amount, logger, bySilver = false) => {
    if (F.lock || amount <= 0) return;
    // 累計用名目扣值：和弦已經在下限 −60 時照樣算，不然停在下限就永遠觸發不了
    set(F.value - amount, logger);
    if (bySilver) F.lost60 += amount;   // 被動 1 只算銀扣的
    if (S.phase2 && silver.isAlive) {
      F.lost20 += amount;
      while (F.lost20 >= SILVER.aoeEvery) { F.lost20 -= SILVER.aoeEvery; engine.insertAction(silver, quakeSkill); }
    }
    if (F.lost60 >= SILVER.melodyAfterLoss && silver.isAlive && !F.lock) beginSilverMelody(logger);
  };
  // 玩家身上的和弦被動（id 與撥弦槍相同，召喚物的 linkChordSummon 才找得到 gem_chord_loss）
  hero.passives = hero.passives.filter(p => !String(p.id ?? '').startsWith('gem_chord'));
  hero.passives.push(
    { id: 'gem_chord_gain', trigger: 'AFTER_DAMAGE_DEALT', enabled: (self, hit) => hit?.source === 'ATTACK' && !F.lock,
      action: (self, hit, logger) => set(F.value + FIELD.gain, logger) },
    { id: 'gem_chord_loss', trigger: 'AFTER_DAMAGE_RECEIVED', enabled: (self, hit) => hit?.source === 'ATTACK' && !F.lock,
      action: (self, hit, logger) => { const bySilver = hit?.caster?.monsterId === 'silver'; lose(bySilver ? FIELD.silverLoss : FIELD.otherLoss, logger, bySilver); } },
    { id: 'gem_field_round', trigger: 'ROUND_START', enabled: () => F.playerLeft > 0,
      action: (self, round, logger) => { F.playerLeft -= 1; if (F.playerLeft <= 0) endPlayerMelody(logger); } }
  );

  // ── 銀 ──
  const S = { phase2: false, pendingRaise: false, shieldUp: false, melody: false, lastIce: -Infinity, grandDone: false };
  const refreshBoost = () => {
    silver.counterBoost = {
      points: (S.melody ? SILVER.melodyBoost.points : 0) + (S.shieldUp ? SILVER.shield.points : 0),
      power: S.melody ? SILVER.melodyBoost.power : 1
    };
  };
  function beginSilverMelody(logger) {
    F.lock = 'silver'; F.silverLeft = SILVER.melodyRounds; F.noticed = false; F.lost60 = 0;
    F.value = FIELD.min; hero.gemChord = F.value; hero.gemChordBonus = 0;   // 顯示 −60，但玩家傷害不減
    S.melody = true; refreshBoost();
    silver.addBuff({ id: 'silver_melody', name: '勝利的旋律', type: 'STAT', duration: MAX_TURNS_GUARD, polarity: 'positive', dispellable: false, untouchable: true, effect: () => {} }, engine);
    log(logger, TEXTS.silverMelody.start, { actorId: silver.id });
  }
  function endSilverMelody(logger) {
    silver.buffs = silver.buffs.filter(b => b.id !== 'silver_melody');
    S.melody = false; refreshBoost();
    F.lock = null; F.lost60 = 0;
    set(0, logger);
    log(logger, TEXTS.silverMelody.end, { actorId: silver.id });
  }

  const textAction = text => ({ type: 'TEXT', text: { action: text } });
  const veil = { id: 'silver_veil', name: '無敵', type: 'STAT', duration: MAX_TURNS_GUARD, polarity: 'positive', dispellable: false, invincible: true, effect: () => {} };
  const extraTurn = new Skill({ id: 'silver_extra', name: '額外行動', actions: [textAction('')] });
  // 放下盾牌、冰盾給的額外行動不會選到舉盾（2026-11-22 使用者：放下盾牌的那一動不會再舉盾）
  extraTurn.execute = function execute(caster, allies, enemies, logger, eng) {
    const chosen = pickMonsterAction(caster, eng, { exclude: 'raise' });
    return chosen.execute(caster, allies, enemies, logger, eng);
  };
  const insertExtra = () => engine.insertAction(silver, extraTurn);

  const grandSkill = new Skill({ id: 'silver_grand', name: '殘滅大魔術', uncounterable: true,
    actions: [textAction(TEXTS.grand), { type: 'DAMAGE', targetType: 'ENEMY_ALL', stat: 'int', power: SILVER.grand.power, uncritable: true, text: { action: tf(TEXTS.grandHit) } }] });
  const grandEcho = new Skill({ id: 'silver_grand_echo', name: '殘滅大魔術', uncounterable: true,
    actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL', stat: 'int', power: SILVER.grand.echo, uncritable: true, text: { action: tf(TEXTS.grandEcho) } }] });
  const quakeSkill = new Skill({ id: 'silver_quake', name: '音爆', uncounterable: true,
    actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL', stat: 'int', power: SILVER.quake.power, uncritable: true, text: { action: tf(TEXTS.quake) } }] });
  const guardSkill = new Skill({ id: 'silver_guard', name: '舉盾', actions: [textAction(TEXTS.guard)] });
  const raiseSkill = new Skill({ id: 'silver_raise', name: '舉盾', actions: [{ type: 'BUFF', targetType: 'SELF', text: { action: fillText(TEXTS.raise, { player }), buff: '' },
    buffs: [{ id: 'silver_shield', name: '舉盾', type: 'STAT', duration: MAX_TURNS_GUARD, polarity: 'positive', dispellable: false, stackPolicy: 'refresh',
      damageTaken: { multiplier: SILVER.shield.damageTaken },
      effect: stats => { stats.eva = (stats.eva ?? 0) * SILVER.shield.evaMult + SILVER.shield.evaFlat; } }] }] });
  const raiseExecute = raiseSkill.execute;
  raiseSkill.execute = function execute(...args) { const r = raiseExecute.apply(this, args); S.shieldUp = true; refreshBoost(); return r; };
  raiseSkill.canCast = () => !S.shieldUp;
  const lowerSkill = new Skill({ id: 'silver_lower', name: '舉盾', actions: [textAction(TEXTS.lower)] });
  // 第 1 回合不行動的那一動
  const idleSkill = new Skill({ id: 'silver_idle', name: '觀察', actions: [textAction(fillText(TEXTS.idle, { player }))] });
  const lowerExecute = lowerSkill.execute;
  lowerSkill.execute = function execute(...args) {
    const r = lowerExecute.apply(this, args);
    silver.buffs = silver.buffs.filter(b => b.id !== 'silver_shield');
    S.shieldUp = false; refreshBoost();
    insertExtra();
    return r;
  };
  const iceAmount = Math.max(1, Math.floor(silver.stats.maxHp * SILVER.ice.ratio));
  const iceSkill = new Skill({ id: 'silver_ice', name: '冰盾', actions: [{ type: 'BUFF', targetType: 'SELF', text: { action: fillText(TEXTS.ice, { value: String(iceAmount) }), buff: '' },
    buffs: [{ id: 'silver_ice', name: '冰盾', type: 'STAT', duration: MAX_TURNS_GUARD, polarity: 'positive', dispellable: false, stackPolicy: 'refresh',
      effect: () => {}, shield: iceAmount }] }] });
  const iceExecute = iceSkill.execute;
  iceSkill.execute = function execute(...args) { S.lastIce = engine.currentTurn; const r = iceExecute.apply(this, args); insertExtra(); return r; };
  iceSkill.canCast = () => !S.shieldUp && engine.currentTurn - S.lastIce >= SILVER.ice.cooldown && !silver.buffs.some(b => b.id === 'silver_ice');
  const iceBurst = new Skill({ id: 'silver_ice_burst', name: '冰盾', actions: [{ type: 'DAMAGE', stat: 'atk', power: SILVER.ice.burst, text: { action: tf(TEXTS.iceBurst) } }] });

  silver.gemResolver = ({ caster }) => {
    if (caster !== silver) return undefined;
    if (!S.grandDone) return idleSkill;   // 第 1 回合不行動（使用者的文本取代框架的「銀沒有動。」）
    if (S.pendingRaise) {
      S.pendingRaise = false;
      silver.buffs = silver.buffs.filter(b => b.id !== 'silver_veil');
      return raiseSkill;
    }
    if (S.shieldUp) return (engine.rng ?? Math.random)() < SILVER.shield.lowerChance ? lowerSkill : guardSkill;
    return undefined;
  };

  // 被動 2：鎖血在 50%
  const half = () => Math.ceil(silver.stats.maxHp * SILVER.halfAt);
  silver.passives.push({
    id: 'silver_half_lock', trigger: 'BEFORE_DAMAGE', enabled: () => !S.phase2,
    action: (self, hit) => { hit.damage = Math.max(0, Math.min(hit.damage, self.stats.hp - half())); }
  });
  const baseFinish = silver.finishDamage;
  silver.finishDamage = function finishDamage(hit, logger, eng) {
    const fresh = !this.settledDamage?.has(hit);   // 同一擊只結算一次（框架可能對同一擊呼叫兩次）
    const result = baseFinish.call(this, hit, logger, eng);
    if (!fresh) return result;
    // 冰盾被打破：對打破的人造成傷害
    if (hit?.shieldsBroken?.some(b => b.id === 'silver_ice') && hit.caster?.isAlive && this.isAlive && !engine.result) {
      engine.withCounterSource({ actorId: this.id, targetId: hit.caster.id, incomingSkillId: hit.skill?.id },
        () => iceBurst.execute(this, alliesOf(this), enemiesOf(this), logger, engine, { targets: [hit.caster], ignoreSp: true }));
    }
    if (!S.phase2 && this.isAlive && this.stats.hp <= half()) {
      S.phase2 = true; S.pendingRaise = true;
      this.addBuff({ ...veil }, engine);
      this.skills = [...this.skills, raiseSkill, iceSkill];
      log(logger, TEXTS.half, { actorId: this.id });
    }
    return result;
  };

  // 被動 4：第 1 回合無敵、不行動；第 2 回合開始解除並發動殘滅大魔術；之後每回合開始餘響
  silver.passives.push(
    { id: 'silver_round1', trigger: 'BATTLE_START', action: (self, _b, logger) => {
      self.addBuff({ ...veil }, engine);
      if (cranelance) log(logger, TEXTS.openingCranelance);
    } },
    { id: 'silver_rounds', trigger: 'ROUND_START', action: (self, { round }, logger) => {
      if (F.silverLeft > 0) { F.silverLeft -= 1; if (F.silverLeft <= 0) endSilverMelody(logger); }
      if (engine.result) return;
      if (round === 2 && !S.grandDone) {
        S.grandDone = true;
        if (!S.phase2) self.buffs = self.buffs.filter(b => b.id !== 'silver_veil');
        grandSkill.execute(self, alliesOf(self), enemiesOf(self), logger, engine, { ignoreSp: true });
      } else if (S.grandDone && round > 2) {
        grandEcho.execute(self, alliesOf(self), enemiesOf(self), logger, engine, { ignoreSp: true });
      }
    } }
  );
  refreshBoost();
  // 翅音開頭一行有 {player}：定義時還不知道玩家名字，這裡補上
  const wing = silver.skills.find(skill => skill.id === 'silver_wing');
  if (wing?.actions[0]?.type === 'TEXT') wing.actions[0] = { ...wing.actions[0], text: { action: fillText(TEXTS.wing, { player }) } };
  // 法術減傷：帶 spell 標籤的技能打銀 × 0.7（普攻不算，即使是智力普攻）
  silver.addBuff({ id: 'silver_spell_ward', name: '法術抗性', type: 'STAT', duration: MAX_TURNS_GUARD, polarity: 'positive', dispellable: false, effect: () => {},
    damageTaken: { multiplier: SILVER.spellWard, filter: hit => hit.source === 'ATTACK' && Boolean(hit.skill?.tags?.includes('spell')) } }, engine);

  // 起始和弦
  set(cranelance ? FIELD.cranelanceStart : 0, null);
  F.noticed = F.value >= FIELD.notice;
  void all;
  return { field: F, state: S, silver };
}

module.exports = { setupSilver, SILVER_DEF, WINGBUG_DEF, FIELD, SILVER, TEXTS };
