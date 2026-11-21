/**
 * 撥弦槍【鶴之聲援】的機制「妖精的和弦」（2026-11-21 使用者設計）。
 *
 *   和弦值 0～max（100）：自己的攻擊每一擊造成傷害 +gain（4；持續傷害不算），被攻擊擊中而受到傷害 −loss（1；
 *   持續傷害、共鳴爆發這類直接扣血不算——2026-11-21 晚使用者改：只有被攻擊擊中才扣）。
 *   每 1 點和弦值，法術傷害 +perPoint（1%），進加算區（gemCompiler 的 withDynamicDamage 讀 entity.gemChordBonus）。
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

module.exports = { buildChordPassives, VICTORY_ID };
