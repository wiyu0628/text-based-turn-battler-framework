/**
 * 撥弦槍【鶴之聲援】的機制「妖精的和弦」（2026-11-21 使用者設計）。
 *
 *   和弦值 0～max（100）：自己的攻擊每一擊造成傷害 +gain（4；持續傷害不算），被攻擊擊中而受到傷害 −loss（1；
 *   持續傷害、共鳴爆發這類直接扣血不算——2026-11-21 晚使用者改：只有被攻擊擊中才扣）。
 *   每 1 點和弦值，物理與法術傷害 +perPoint（1%；2026-11-22 使用者把「法術」改成「物理與法術」，第二區王也會帶和弦）。
 *   寶石技能進加算區（gemCompiler 的 withDynamicDamage 讀 entity.gemChordBonus）；普攻與其他技能由 applyChordDamage 乘上 1 + 加成。
 *   我方召喚物（summonerId 指向帶和弦的單位）被攻擊擊中而受傷，主人一樣 −loss（linkChordSummon）。
 *   集滿 max 時和弦值鎖住不再增減，獲得「勝利的旋律」：回復最大生命 heal（25%）、清除可驅散的減益、
 *   速度 +spdInc（100%），持續 rounds（3；2026-11-21 使用者延長一回合）回合——取得的那個回合算第 1 回合，第 rounds 次回合開始時結束；
 *   結束時和弦值歸零，重新累積。和弦值不寫進戰報。
 */

const VICTORY_ID = 'gem_victory_melody';

function buildChordPassives(mechanic) {
  const { gain, loss, max, perPoint, rounds, heal, spdInc } = mechanic;
  const text = mechanic.text ?? {};
  const fill = (template, self) => template.replaceAll('{caster}', self.name);
  const set = (self, value) => {
    self.gemChord = Math.max(0, Math.min(max, value));
    self.gemChordBonus = self.gemChord * perPoint;
  };
  const begin = (self, logger, engine) => {
    self.gemChordLeft = rounds;
    for (const line of [text.full, text.start, text.shout]) if (line) logger?.addLog({ type: 'TEXT', actorId: self.id, message: fill(line, self) });
    const healed = self.heal(Math.floor(self.stats.maxHp * heal), logger, { engine });
    if (healed > 0) logger?.addLog({ type: 'HEAL', actorId: self.id, targetId: self.id, value: healed, message: `${self.name} 回復了 ${healed} 點生命！` });
    self.removeBuffs('negative');
    self.addBuff({ id: VICTORY_ID, name: '勝利的旋律', type: 'STAT', duration: Infinity, polarity: 'positive', dispellable: false,
      stackPolicy: 'refresh', effect: stats => { stats.spd *= 1 + spdInc; } }, engine);
  };
  return [
    {
      id: 'gem_chord_gain',
      trigger: 'AFTER_DAMAGE_DEALT',
      enabled: (self, hit) => hit?.source === 'ATTACK' && !self.gemChordLeft,
      action(self, hit, logger, engine) {
        set(self, (self.gemChord ?? 0) + gain);
        if (self.gemChord >= max) begin(self, logger, engine);
      }
    },
    {
      id: 'gem_chord_loss',
      trigger: 'AFTER_DAMAGE_RECEIVED',
      enabled: (self, hit) => hit?.source === 'ATTACK' && !self.gemChordLeft,
      action(self) { set(self, (self.gemChord ?? 0) - loss); }
    },
    {
      id: 'gem_chord_round',
      trigger: 'ROUND_START',
      enabled: self => self.gemChordLeft > 0,
      action(self, round, logger) {
        self.gemChordLeft -= 1;
        if (self.gemChordLeft > 0) return;
        self.buffs = self.buffs.filter(buff => buff.id !== VICTORY_ID);
        set(self, 0);
        if (text.end) logger?.addLog({ type: 'TEXT', actorId: self.id, message: fill(text.end, self) });
      }
    }
  ];
}

/**
 * 寶石以外的技能（普攻、怪物技能）也吃和弦加成：施放當下把傷害段倍率乘上 1 + gemChordBonus。
 * 寶石技能已經在加算區處理（gemChordAware），不重複包。
 */
function applyChordDamage(entity) {
  for (const skill of [entity.normalAttack, ...(entity.skills ?? [])]) {
    if (!skill || skill.gemChordAware || skill.gemChordWrapped) continue;
    skill.gemChordWrapped = true;
    const base = skill.execute;
    skill.execute = function execute(caster, ...rest) {
      const bonus = caster.gemChordBonus || 0;
      if (bonus <= 0) return base.call(this, caster, ...rest);
      // 不能用 Object.create 做變體：框架靠「this === caster.normalAttack」判斷普攻連擊，所以就地改倍率、施放完還原
      const saved = this.actions;
      // 保留屬性描述（「相對機動」的碎片把 damageDecay 做成 getter，展開運算子會把它凍成定值）
      this.actions = saved.map(action => action.type === 'DAMAGE'
        ? Object.defineProperty(Object.defineProperties({}, Object.getOwnPropertyDescriptors(action)), 'power', { value: (action.power ?? 1) * (1 + bonus), enumerable: true, writable: true, configurable: true })
        : action);
      try { return base.call(this, caster, ...rest); } finally { this.actions = saved; }
    };
  }
  return entity;
}

/**
 * 召喚物被攻擊擊中而受傷時，主人（summonerId）的和弦一樣 −1。掛在每個召喚物上，觸發時才找主人，
 * 所以引擎召喚（summonerId 在召喚之後才寫）也適用；主人沒有和弦或集滿鎖住時什麼都不做。
 */
function linkChordSummon(summon, engine) {
  if (!summon || summon.passives?.some(p => p.id === 'gem_chord_summon_loss')) return;
  const ownerOf = self => [...(engine?.teamA ?? []), ...(engine?.teamB ?? [])].find(e => e.id === self.summonerId && e !== self);
  summon.passives = [...(summon.passives ?? []), {
    id: 'gem_chord_summon_loss',
    trigger: 'AFTER_DAMAGE_RECEIVED',
    enabled: (self, hit) => hit?.source === 'ATTACK' && !!self.summonerId,
    action(self, hit, logger) {
      const owner = ownerOf(self);
      const loss = owner?.passives?.find(p => p.id === 'gem_chord_loss');
      if (owner?.isAlive && loss?.enabled(owner, hit)) loss.action(owner, hit, logger);
    }
  }];
}

module.exports = { buildChordPassives, applyChordDamage, linkChordSummon, VICTORY_ID };
