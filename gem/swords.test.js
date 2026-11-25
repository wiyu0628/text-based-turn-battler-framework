'use strict';

// 喚劍（2026-11-23 使用者設計，第三區王的獎勵）。執行：node --test gem/swords.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout, GemLinkError } = require('./gemCompiler');
const { ACTIVE_GEMS, BOSS_REWARD_GEMS } = require('./gems');
const { buildPlayerEvadeCounterPassive } = require('./monsters');
const { BOSSES } = require('./bosses');

const SW = ACTIVE_GEMS.summonsword;
const T = SW.swords.texts;
const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });

function battle(supports = [], { turns = 5, seed = 4, spd = 200, castRate = 0.5, foeStats = {}, foePassives = [] } = {}) {
  const loadout = compileLoadout([{ active: 'summonsword', supports }]);
  const hero = new Entity({ id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 3000, maxHp: 4000, sp: 200, maxSp: 200, atk: 150, int: 150, def: 50, spd, cri: 0, skillCastRate: castRate } });
  const foes = ['a', 'b'].map(id => new Entity({ id, name: id, team: 'B', normalAttack: plain, passives: foePassives.map(f => f()),
    stats: { hp: 1e6, sp: 0, atk: 1, def: 0, spd: 150, ...foeStats } }));
  const result = new BattleEngine([hero], foes, { rng: createSeededRandom(seed), maxTurns: turns, skillSelectionResolver: loadout.resolver }).start();
  return { result, hero, logs: result.logs.filter(log => log.message) };
}
const isChase = log => log.message.startsWith(T.chase);
const FINAL_HIT = /^第[一二三四五]擊，/;
const isFinal = log => log.skillId === 'summonsword#sword' && FINAL_HIT.test(log.message);

test('喚劍：召喚 1 把、每個行動槽 +1（上限 3），普攻後只有 1 把追擊，第 2 次回合開始時每把再攻擊一次後消散', () => {
  const { logs } = battle();
  const summon = logs.findIndex(log => log.message === '勇者 召喚了一把飛劍！');
  assert.ok(summon >= 0);
  let count = SW.swords.initial, chases = 0, slot = null, rounds = 0, ended = false;
  for (const log of logs.slice(summon + 1)) {
    if (ended) break;
    if (log.message.startsWith('--- 第')) { rounds++; continue; }
    if (log.actorId === 'hero' && log.message.startsWith('勇者 攻擊')) { if (slot !== null) assert.equal(slot, 0); slot = 0; }
    if (isChase(log)) { chases++; slot++; assert.ok(slot <= SW.swords.chase, '普攻那槽只有 chase 把追擊'); }
    const grow = log.message.match(/飛劍增加到(\d)把/);
    if (grow) { if (slot !== null) assert.equal(slot, Math.min(SW.swords.chase, count), '普攻那槽追擊 chase 把'); count = Number(grow[1]); slot = null; }
    if (log.message === T.finalIntro) { assert.equal(rounds, SW.swords.rounds, '施放的回合算第 1 回合，第 2 次回合開始時結束'); ended = true; }
  }
  assert.ok(ended);
  assert.ok(chases > 0);
  assert.ok(count <= SW.swords.max);
  assert.ok(count > SW.swords.chase, '飛劍會長到比追擊把數多，多的只在結束時用到');
  const finals = logs.filter(isFinal).length;
  assert.equal(finals, count, '結束時每把各攻擊一次');
  // 戰報照連音：先一行開頭，再依序「第一擊，」「第二擊，」…
  const intro = logs.findIndex(log => log.message === T.finalIntro);
  assert.ok(intro >= 0);
  const hits = logs.slice(intro + 1, intro + 1 + count).map(log => log.message.slice(0, 4));
  assert.deepEqual(hits, ['第一擊，', '第二擊，', '第三擊，'].slice(0, count));
  // 持續期間不會再施放喚劍
  const end = logs.findIndex(log => log.message === T.finalIntro);
  assert.ok(!logs.some(log => log.message.includes('飛劍消散了')), '結束不另寫一句');
  assert.equal(logs.slice(summon + 1, end).filter(log => log.message.includes('召喚了一把飛劍')).length, 0);
});

test('喚劍：飛劍一擊的倍率＝每擊倍率（30%）乘連結輔助寶石的加成', () => {
  const { logs } = battle([], { seed: 4 });
  const normal = logs.find(log => log.actorId === 'hero' && log.message.startsWith('勇者 攻擊') && !log.isCombo);
  const chase = logs.find(isChase);
  assert.ok(Math.abs(chase.value / normal.value - SW.actions[0].power) < 0.08, `${chase.value} / ${normal.value}`);
  const heavy = battle(['heavy'], { seed: 4 }).logs.find(isChase);
  assert.ok(heavy.value > chase.value * 1.2, '強力讓飛劍一擊變重');
});

test('喚劍：觸發類在飛劍不在時召喚、在場時 volley 把（1）攻擊一次（佈局的第一動召喚，追擊在場時齊射）', () => {
  const layout = battle(['layout']).logs;
  assert.ok(layout.some(log => log.message === '勇者的第一動，召喚了一把飛劍！'), layout.map(l => l.message).slice(0, 6).join('\n'));
  // 速度很高：普攻 3 連擊以上觸發追擊；飛劍在場時就是齊射
  const fast = battle(['followup'], { spd: 900, castRate: 1, turns: 4 }).logs;
  assert.ok(fast.some(log => log.message.startsWith(T.volley)), '在場時觸發＝飛劍齊射');
  // 每次齊射只有 volley 把：兩行齊射之間一定隔著別的戰報
  const volleys = fast.map((log, i) => [log, i]).filter(([log]) => log.message.startsWith(T.volley)).map(([, i]) => i);
  for (let k = 1; k < volleys.length; k++) assert.ok(volleys[k] - volleys[k - 1] > SW.swords.volley, '一次齊射只有 1 把');
});

test('喚劍：插隊的行動槽（觸發出來的齊射）不增加飛劍', () => {
  const { logs } = battle(['followup'], { spd: 900, castRate: 1, turns: 4 });
  let grows = 0, own = 0, open = false;
  for (const log of logs) {
    if (log.message.includes('召喚了一把飛劍')) { open = true; continue; }
    if (log.message === T.finalIntro) open = false;
    if (!open) continue;
    if (log.message.match(/飛劍增加到/)) grows++;
    if (log.actorId === 'hero' && log.message.startsWith('勇者 攻擊')) own++;
  }
  assert.ok(grows <= own, `增加 ${grows} 次，自己的普攻槽 ${own} 次`);
});

test('喚劍：反擊率 × 1 / 一起出手的把數（框架 counterChanceMultiplier，gem 的閃避反擊也照算）：追擊 1 把照常、結束時 3 把各 1/3', () => {
  // 敵人一定閃避、反擊點數很高（基本反擊率約 40%）；分開數普攻、追擊、結束攻擊被閃避後的反擊
  const tally = { plain: [0, 0], chase: [0, 0], final: [0, 0] };
  for (let seed = 1; seed <= 80; seed++) {
    const { result } = battle([], { seed, turns: 8, foeStats: { eva: 1e6, evadeCounter: 400 },
      foePassives: [() => buildPlayerEvadeCounterPassive({ name: '敵' })] });
    const logs = result.logs;
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (log.type !== 'MISS') continue;
      const kind = log.skillId === 'plain' ? 'plain' : log.skillId !== 'summonsword#sword' ? null
        : FINAL_HIT.test(log.message) ? 'final' : log.message.startsWith(T.chase) ? 'chase' : null;
      if (!kind) continue;
      tally[kind][0]++;
      if (logs[i + 1]?.skillId === 'hero_evade_counter') tally[kind][1]++;
    }
  }
  const rate = ([n, c]) => c / n;
  const info = JSON.stringify(tally);
  if (process.env.SHOW) console.log(info);
  for (const kind of Object.keys(tally)) assert.ok(tally[kind][0] >= 40, info);
  assert.ok(rate(tally.plain) > 0.3, info);
  assert.ok(Math.abs(rate(tally.chase) - rate(tally.plain)) < 0.12, '追擊只有 1 把：反擊率和普攻差不多 ' + info);
  assert.ok(rate(tally.final) < rate(tally.plain) * 0.6, '結束時 3 把一起出手：約 1/3 ' + info);
});

test('喚劍：不能連蓄力；是 Boss 獎勵名單裡的寶石，但目前沒有王給（第三區王還沒做）', () => {
  assert.throws(() => compileLoadout([{ active: 'summonsword', supports: ['charge'] }]), GemLinkError);
  assert.ok(BOSS_REWARD_GEMS.includes('summonsword'));
  assert.ok(!BOSSES.some(boss => boss.rewards?.gems?.includes('summonsword')));
});
