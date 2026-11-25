'use strict';

// 連續光環（2026-11-24 使用者設計，第三區掉落）。執行：node --test gem/chainaura.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout, GemLinkError } = require('./gemCompiler');
const { SUPPORT_GEMS, ACTIVE_GEMS } = require('./gems');
const S = require('./saveLayer');

const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });

function battle(links, { sp = 200, turns = 4, seed = 5, foeAtk = 100, hp = 1e6 } = {}) {
  const loadout = compileLoadout(links);
  const hero = new Entity({ id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp, maxHp: 1e6, sp, maxSp: Math.max(sp, 1), atk: 100, def: 100, spd: 200, cri: 0, skillCastRate: 1 } });
  const foe = new Entity({ id: 'foe', name: '野犬', team: 'B', normalAttack: plain, stats: { hp: 1e9, maxHp: 1e9, sp: 0, atk: foeAtk, def: 0, spd: 150 } });
  const result = new BattleEngine([hero], [foe], { rng: createSeededRandom(seed), maxTurns: turns, skillSelectionResolver: loadout.resolver }).start();
  return { loadout, hero, logs: result.logs.filter(log => log.message) };
}
const open = (hero, id) => hero.buffs.some(buff => buff.id === `gem_aura:${id}`);

test('連續光環：資料（第三區掉落、佔輔助槽；兩顆光環的白名單都有它）', () => {
  assert.equal(SUPPORT_GEMS.chainaura.area, 3);
  assert.ok(ACTIVE_GEMS.thorns.supportWhitelist.includes('chainaura'));
  assert.ok(ACTIVE_GEMS.endure.supportWhitelist.includes('chainaura'));
});

test('連續光環：被連結的光環不會自己開啟；主光環開啟時一起開啟，只多一次行動', () => {
  const { loadout, hero, logs } = battle([{ active: 'thorns', supports: ['chainaura', 'endure'] }]);
  assert.deepEqual(loadout.skills.map(skill => skill.id), ['thorns+chainaura'], '被連結的忍耐不進技能清單');
  assert.ok(open(hero, 'thorns+chainaura') && open(hero, 'endure'));
  const thornsOpen = logs.findIndex(log => log.message === '勇者開啟了荊棘！');
  assert.equal(logs[thornsOpen + 1].message, '勇者 開啟了忍耐！', '緊接著開啟忍耐（照忍耐自己的文本）');
  assert.equal(logs.filter(log => log.message.includes('開啟了')).length, 2, '各開啟一次');
  // 開啟後只多行動一次：開啟荊棘那一槽之後、野犬行動之前，勇者只有一個行動
  const after = logs.slice(thornsOpen + 2);
  const nextFoe = after.findIndex(log => log.actorId === 'foe');
  const heroActs = after.slice(0, nextFoe).filter(log => log.actorId === 'hero' && log.type === 'DAMAGE');
  assert.ok(heroActs.length >= 1 && heroActs.length <= 3, '多行動一次（普攻可能連擊）');
  assert.equal(after.slice(0, nextFoe).filter(log => log.message.includes('開啟了')).length, 0);
});

test('連續光環：SP 各自扣、各自判斷（荊棘 5、忍耐 8；第 2 回合開始剩 6）', () => {
  const { logs } = battle([{ active: 'thorns', supports: ['chainaura', 'endure'] }], { sp: 10, turns: 2 });
  assert.ok(logs.some(log => log.message === '勇者 的 SP 不足，忍耐沒有發動。'), '忍耐付不起');
  assert.ok(!logs.some(log => log.message === '勇者 的 SP 不足，荊棘沒有發動。'), '荊棘付得起');
});

test('連續光環：佈局開啟主光環時也一起開啟', () => {
  const { hero, logs } = battle([{ active: 'endure', supports: ['chainaura', 'layout', 'thorns'] }], { turns: 1 });
  assert.ok(open(hero, 'thorns'));
  assert.ok(logs.some(log => log.message === '勇者開啟了荊棘！'));
});

test('連續光環：連到不是光環的主動寶石沒有效果、不報錯', () => {
  const plainMm = compileLoadout([{ active: 'magicmissile', supports: [] }]).compiled[0];
  const withChain = compileLoadout([{ active: 'magicmissile', supports: ['chainaura'] }]).compiled[0];
  assert.equal(JSON.stringify(withChain.skill.actions), JSON.stringify(plainMm.skill.actions));
  assert.equal(withChain.spCost, plainMm.spCost);
});

test('連續光環：輔助槽放主動寶石的限制', () => {
  // 沒有連續光環、主動寶石不是光環、放的不是光環、放自己、重複、超過 3 格
  assert.throws(() => compileLoadout([{ active: 'thorns', supports: ['endure'] }]), GemLinkError);
  assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: ['chainaura', 'endure'] }]), GemLinkError);
  assert.throws(() => compileLoadout([{ active: 'thorns', supports: ['chainaura', 'magicmissile'] }]), GemLinkError);
  assert.throws(() => compileLoadout([{ active: 'thorns', supports: ['chainaura', 'thorns'] }]), GemLinkError);
  assert.throws(() => compileLoadout([{ active: 'thorns', supports: ['chainaura', 'endure', 'endure'] }]), GemLinkError);
  assert.throws(() => compileLoadout([{ active: 'thorns', supports: ['chainaura', 'endure', 'layout', 'trump'] }]), GemLinkError);
  assert.doesNotThrow(() => compileLoadout([{ active: 'thorns', supports: ['chainaura', 'endure', 'layout'] }]));
});

test('連續光環：同一顆光環只能開一個，重複的那顆沒有效果（不報錯）', () => {
  const links = [{ active: 'endure', supports: [] }, { active: 'thorns', supports: ['chainaura', 'endure'] }];
  const { loadout } = battle(links, { turns: 1 });
  assert.equal(loadout.passives.filter(p => p.id.startsWith('gem_aura_round:endure')).length, 1);
  assert.deepEqual(loadout.compiled[1].linkedAuras, undefined);
});

test('連續光環：存檔——光環主動寶石放進輔助槽不從背包扣、要已擁有', () => {
  let save = S.addEngraving(S.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 5, 10);
  const crafted = S.craftEquipment(save, 'weapon', Array.from({ length: 10 }, () => ({ type: 'fury', tier: 5 })));
  save = S.equip(crafted.save, crafted.id);
  const give = (s, id) => S.addGems(s, id, 1);
  save = give(save, 'chainaura');
  save = give(save, 'thorns');
  const weaponId = crafted.id;
  assert.throws(() => S.setLinks(save, weaponId, [{ active: 'thorns', supports: ['chainaura', 'endure'] }]), /還沒有主動寶石/);
  save = give(save, 'endure');
  save = S.setLinks(save, weaponId, [{ active: 'thorns', supports: ['chainaura', 'endure'] }]);
  assert.equal(save.gems.endure, 1, '主動寶石擁有制，不扣');
  assert.equal(save.gems.chainaura ?? 0, 0, '輔助寶石照常從背包扣');
  assert.deepEqual(S.validateSave(save), []);
  save = S.setLinks(save, weaponId, []);
  assert.equal(save.gems.endure, 1, '卸下也不會多出主動寶石');
  assert.equal(save.gems.chainaura, 1);
  // 沒有連續光環時輔助槽不能放光環
  assert.throws(() => S.setLinks(save, weaponId, [{ active: 'thorns', supports: ['endure'] }]));
});

test('同一顆光環只能開一個：兩件裝備都直接裝，照裝備順序第一個有效，第二個沒有效果（不報錯）', () => {
  const links = [{ active: 'thorns', supports: [] }, { active: 'thorns', supports: ['layout'] }];
  const { loadout, logs } = battle(links, { turns: 3 });
  assert.deepEqual(loadout.skills.map(skill => skill.id), ['thorns']);
  assert.equal(loadout.compiled[1].inert, true);
  assert.ok(!loadout.passives.some(p => p.id.includes('thorns+layout')), '第二組的被動、佈局都不掛');
  // 每次被打最多反彈一次
  for (let i = 1; i < logs.length; i++) if (logs[i].skillId?.startsWith('thorns') && logs[i].type === 'DAMAGE') assert.ok(!(logs[i - 1].skillId?.startsWith('thorns') && logs[i - 1].type === 'DAMAGE'));
  // 非光環的主動寶石照舊可以重複
  assert.equal(compileLoadout([{ active: 'rend', supports: [] }, { active: 'rend', supports: [] }]).skills.length, 2);
});

test('被連結的光環共用主光環的輔助寶石：觸發型（佈局、撒手鐧）與不合法的不套用，不報錯', () => {
  const { inheritedSupports } = require('./gemCompiler');
  assert.deepEqual(inheritedSupports('endure', ['chainaura', 'layout', 'recycle']), ['recycle']);
  assert.deepEqual(inheritedSupports('endure', ['trump', 'amp']), [], '撒手鐧是觸發型、增幅對光環不合法');
  const { loadout } = battle([{ active: 'thorns', supports: ['chainaura', 'endure', 'recycle'] }], { turns: 1 });
  assert.deepEqual(loadout.compiled[0].linkedAuras.map(sub => sub.skill.id), ['endure+recycle']);
  assert.deepEqual(loadout.compiled[0].linkedAuras[0].inheritedSupports, ['recycle']);
  // 主光環連撒手鐧：被連結的光環不會因為撒手鐧自己開啟（沒有它自己的觸發被動）
  const trump = compileLoadout([{ active: 'thorns', supports: ['chainaura', 'endure', 'trump'] }]);
  assert.deepEqual(trump.compiled[0].linkedAuras[0].inheritedSupports, []);
  assert.ok(!trump.passives.some(p => String(p.id).includes('endure') && String(p.id).includes('trump')));
});
