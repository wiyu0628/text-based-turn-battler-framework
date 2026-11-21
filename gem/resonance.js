'use strict';

/**
 * 共鳴（第二區「和聲音樂廳」的地區特色，2026-11-21 使用者設計；數值是我擬的初版）。純規則 + 被動，不依賴框架以外的東西。
 *
 *   在有共鳴的戰鬥裡（REGIONS[id].resonance），每一擊**沒被閃避的攻擊**（追擊、反擊、多段的每一段都算；
 *   打在護盾上、被防禦壓成 0 也算；持續傷害與直接扣血不算）替被打的單位疊 1 層，玩家和怪物都會被疊。層數不會隨時間消退。
 *   疊到 stacks 層爆發：層數歸零，受到 自己最大生命 × burstRatio × 防禦減傷（300 ÷ (防禦 + 300)，同框架傷害公式）的傷害；
 *   不擲浮動、不吃護盾以外的減傷。（2026-11-21 使用者：共鳴傷害受防禦影響；沒閃避就疊層、打在護盾上也算）
 *   怪物（B 隊）爆發時：身上有減傷（承傷倍率 < 1 的狀態）就解除減傷；沒有就給易傷（承傷 ×(1 + vulnerable)，vulnerableDuration 槽）。
 *   管風琴魔像的場地特效用 addResonance 每回合替全場疊層。
 *
 *   層數記在 entity.resonance；另外掛一個顯示用的狀態「共鳴 ×N」（不能被驅散，指揮家的「整頓」清不掉）。
 */

const { Buff } = require('../src');

const RESONANCE = { stacks: 5, burstRatio: 0.04, vulnerable: 0.2, vulnerableDuration: 2 };

const BADGE_ID = 'resonance_badge';
const DEF_CONST = 300;   // 框架 Formulas.calculateDamage 的防禦常數（防禦 300 = 減傷 50%）

function showStacks(entity) {
  const stacks = entity.resonance ?? 0;
  const badge = entity.buffs.find(b => b.id === BADGE_ID);
  if (!stacks) { if (badge) entity.buffs.splice(entity.buffs.indexOf(badge), 1); return; }
  if (badge) { badge.name = `共鳴 ×${stacks}`; badge.value = stacks; return; }
  entity.buffs.push(new Buff({ id: BADGE_ID, name: `共鳴 ×${stacks}`, type: 'STAT', duration: Infinity, value: stacks,
    effect: () => {}, polarity: 'negative', dispellable: false }));
}

/** 替 entity 疊 n 層；到上限就爆發。回傳這次有沒有爆發。 */
function addResonance(entity, n, logger, engine, config = RESONANCE) {
  if (!entity?.isAlive || !(n > 0)) return false;
  entity.resonance = (entity.resonance ?? 0) + n;
  if (entity.resonance < config.stacks) { showStacks(entity); return false; }
  entity.resonance = 0;
  showStacks(entity);
  const def = Math.max(0, (entity.getEffectiveStats?.() ?? entity.stats).def ?? 0);
  const amount = Math.max(1, Math.round((entity.stats.maxHp ?? entity.stats.hp) * config.burstRatio * DEF_CONST / (def + DEF_CONST)));
  logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name}身上的共鳴爆發了！` });
  const hit = entity.takeDamage(amount, logger, { source: 'DIRECT', tags: ['resonance'] });
  logger.addLog({ type: 'DAMAGE', actorId: entity.id, targetId: entity.id, value: hit.actualDamage, message: `${entity.name} 受到了 ${hit.actualDamage} 點傷害！` });
  if (entity.team === 'B' && entity.isAlive) {
    const guards = entity.buffs.filter(b => b.damageTaken && b.damageTaken.multiplier < 1);
    if (guards.length) {
      for (const guard of guards) entity.buffs.splice(entity.buffs.indexOf(guard), 1);
      logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name}的減傷被震散了！` });
    } else {
      entity.addBuff({ id: 'resonance_vulnerable', name: '易傷', type: 'STAT', duration: config.vulnerableDuration, effect: () => {}, stackPolicy: 'refresh',
        polarity: 'negative', dispellable: true, damageTaken: { multiplier: 1 + config.vulnerable } }, engine);
      logger.addLog({ type: 'TEXT', actorId: entity.id, message: `${entity.name}陷入了易傷狀態！` });
    }
  }
  entity.finishDamage?.(hit, logger, engine);
  return true;
}

/**
 * 替整場戰鬥的單位加上共鳴。
 * 框架的 AFTER_DAMAGE_RECEIVED 只在扣到血時才響，打在護盾上的不會；所以改包每個單位的 finishDamage
 * （框架對每一擊命中——包括被護盾吃光、被無敵擋下的——都會呼叫一次，落空則不會），攻擊來源的那一擊就疊 1 層。
 */
function applyResonance(entities, config = RESONANCE) {
  for (const entity of entities) {
    if (entity.hasResonance) continue;
    entity.hasResonance = true;
    const baseFinish = entity.finishDamage;
    entity.finishDamage = function finishDamage(hit, logger, engine) {
      const fresh = !this.settledDamage?.has(hit);
      const result = baseFinish.call(this, hit, logger, engine);
      if (fresh && hit?.source === 'ATTACK' && this.isAlive && !engine?.result) addResonance(this, 1, logger, engine, config);
      return result;
    };
  }
}

module.exports = { RESONANCE, addResonance, applyResonance };
