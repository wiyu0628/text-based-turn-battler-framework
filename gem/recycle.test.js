'use strict';

// 能量回收（2026-11-25 使用者設計，第三區掉落）。執行：node --test gem/recycle.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout, describePlayer, GemLinkError } = require('./gemCompiler');
const { SUPPORT_GEMS, ACTIVE_GEMS } = require('./gems');

const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });
const RC = SUPPORT_GEMS.recycle.effects[0];

function battle(links, { sp = 300, maxSp = sp, turns = 9 } = {}) {
  const loadout = compileLoadout(links);
  const hero = new Entity({ id: 'hero', name: '勇者', team: 'A', normalAttack: plain, normalAttackSpCost: 0, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 1e6, maxHp: 1e6, sp, maxSp, atk: 100, def: 100, spd: 200, cri: 0, skillCastRate: 1 } });
  const foe = new Entity({ id: 'foe', name: '野犬', team: 'B', normalAttack: plain, stats: { hp: 1e9, maxHp: 1e9, sp: 0, atk: 50, def: 0, spd: 150 } });
  const result = new BattleEngine([hero], [foe], { rng: createSeededRandom(3), maxTurns: turns, skillSelectionResolver: loadout.resolver }).start();
  return { hero, logs: result.logs.filter(log => log.message) };
}
const recycled = logs => logs.filter(log => log.message.includes('散逸的魔力裡回收了'));

test('能量回收：資料與說明（第三區掉落、只能連光環、兩顆光環的白名單都有它）', () => {
  assert.equal(SUPPORT_GEMS.recycle.area, 3);
  assert.deepEqual(describePlayer(SUPPORT_GEMS.recycle), ['與光環技能連結。', `每消耗${RC.per}點SP，獲得${RC.gain}點SP。`]);
  assert.ok(ACTIVE_GEMS.endure.supportWhitelist.includes('recycle') && ACTIVE_GEMS.thorns.supportWhitelist.includes('recycle'));
  assert.throws(() => compileLoadout([{ active: 'rend', supports: ['recycle'] }]), GemLinkError);
});

test('能量回收：維持費累計滿 per 點回復 gain 點，零頭跨回合保留', () => {
  // 忍耐每回合 8：開啟後第 2～9 回合各付一次（共 8 次 = 64），累計到 per 時回一次
  const { hero, logs } = battle([{ active: 'endure', supports: ['recycle'] }]);
  const paid = 8 * 8;
  const times = Math.floor(paid / RC.per);
  assert.equal(recycled(logs).length, times);
  assert.equal(recycled(logs)[0].message, `勇者從忍耐散逸的魔力裡回收了${RC.gain}點SP。`);
  assert.equal(hero.stats.sp, 300 - paid + times * RC.gain);
});

test('能量回收：SP 不超過上限；付不起維持費的回合不累計', () => {
  // SP 上限 = 現有 SP：每次回收時都因為上限只回到滿（剛扣完維持費，最多回 spCost）
  const full = battle([{ active: 'thorns', supports: ['recycle'] }], { sp: 300, maxSp: 300, turns: 25 });
  for (const log of recycled(full.logs)) assert.ok(log.value <= RC.gain);
  assert.ok(full.hero.stats.sp <= 300);
  // SP 只夠付一次：之後付不起，不會再累計、不會回收
  const poor = battle([{ active: 'thorns', supports: ['recycle'] }], { sp: 6, maxSp: 300, turns: 25 });
  assert.equal(recycled(poor.logs).length, 0);
});

test('能量回收：沒連的光環不回收；被連續光環連結的光環共用主光環的能量回收，各自累計', () => {
  const none = battle([{ active: 'endure', supports: [] }]);
  assert.equal(recycled(none.logs).length, 0);
  // 荊棘（5）連能量回收＋被連結的忍耐（8）：兩顆各自累計、戰報各寫自己的名稱
  const turns = 21;
  const chained = battle([{ active: 'thorns', supports: ['chainaura', 'endure', 'recycle'] }], { turns });
  const thorns = recycled(chained.logs).filter(log => log.message.includes('從荊棘散逸'));
  const endure = recycled(chained.logs).filter(log => log.message.includes('從忍耐散逸'));
  assert.equal(thorns.length, Math.floor(5 * (turns - 1) / RC.per));
  assert.equal(endure.length, Math.floor(8 * (turns - 1) / RC.per));
});

test('能量回收：兩個光環各連一顆，分開計算', () => {
  const { logs } = battle([{ active: 'endure', supports: ['recycle'] }, { active: 'thorns', supports: ['recycle'] }], { turns: 21 });
  const endure = recycled(logs).filter(log => log.message.includes('從忍耐'));
  const thorns = recycled(logs).filter(log => log.message.includes('從荊棘'));
  assert.ok(endure.length > 0 && thorns.length > 0);
  assert.ok(endure.length >= thorns.length, '忍耐維持費較高，回收次數不少於荊棘');
});
