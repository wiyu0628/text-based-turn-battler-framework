const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine } = require('../src');
const { compileSkill, compileLoadout, GemLinkError } = require('./gemCompiler');

// 第二區王的獎勵寶石（2026-11-22，使用者設計）：連音（依速度 2～4 連擊）、忍耐（新類型「光環」）

const quiet = () => { const logs = []; return { logs, addLog: l => logs.push(l) }; };
const text = logs => logs.map(l => l.message).filter(Boolean).join('\n');
const unit = (id, team, stats = {}) => new Entity({ id, name: id === 'hero' ? '玩家' : id, team,
  stats: { hp: 5000, maxHp: 5000, atk: 100, int: 100, def: 0, spd: 100, sp: 100, maxSp: 100, eva: 0, hit: 1000, cri: 0, skillCastRate: 0, ...stats },
  normalAttack: new Skill({ id: `${id}_atk`, name: '攻擊', actions: [{ type: 'DAMAGE', power: 1 }] }) });

test('連音：基礎 2 連擊；速度差帶來的連擊數 + 1，最多 4 擊；開頭「N連音」、每擊「第 N 道音符，」', () => {
  const cast = spd => {
    const hero = unit('hero', 'A', { spd });
    const foe = unit('foe', 'B', { spd: 100 });
    const engine = new BattleEngine([hero], [foe], { rng: () => 0.5 });
    const logger = quiet();
    compileSkill('tuplet').skill.execute(hero, [hero], [foe], logger, engine, {});
    return text(logger.logs);
  };
  const slow = cast(100);   // 沒有速度差：連擊數 1 → 2 擊
  assert.match(slow, /^如子彈般的連音從玩家的武器傳出——二連音！\n第一道音符，對 foe 造成了 \d+ 點傷害！\n第二道音符，對 foe 造成了 \d+ 點傷害！$/);
  const fast = cast(5000);  // 速度差很大：上限 4 擊
  assert.match(fast, /——四連音！/);
  assert.equal((fast.match(/道音符/g) ?? []).length, 4);
  assert.match(fast, /第四道音符，/);
});

test('連音：目標在連擊途中倒下就停；連結迅擊時複製段也照同樣擊數', () => {
  const hero = unit('hero', 'A', { int: 100000 });
  const foe = unit('foe', 'B', { hp: 10, maxHp: 10 });
  const engine = new BattleEngine([hero], [foe], { rng: () => 0.5 });
  const logger = quiet();
  compileSkill('tuplet').skill.execute(hero, [hero], [foe], logger, engine, {});
  assert.equal((text(logger.logs).match(/道音符/g) ?? []).length, 1);
  const multi = compileSkill('tuplet', ['multistrike']).skill;
  assert.equal(multi.actions.filter(a => a.type === 'DAMAGE').length, 2);
});

test('忍耐：只能連結佈局、撒手鐧（錯誤訊息與順序無關）', () => {
  assert.ok(compileSkill('endure', ['layout', 'trump']));
  assert.throws(() => compileSkill('endure', ['heavy']), error => error instanceof GemLinkError && /只能連結佈局、撒手鐧/.test(error.message));
  assert.throws(() => compileSkill('endure', ['lean', 'heavy']), error => error.gemId === 'heavy');
  assert.throws(() => compileSkill('endure', ['heavy', 'lean']), error => error.gemId === 'heavy');
});

test('忍耐：使用後開啟（不能再選）並插隊多行動一次；每回合開始扣 SP、回復上一回合受到傷害的 20%', () => {
  const loadout = compileLoadout([{ active: 'endure' }]);
  const hero = unit('hero', 'A');
  hero.skills = loadout.skills;
  hero.passives = loadout.passives;
  const foe = unit('foe', 'B');
  const engine = new BattleEngine([hero], [foe], { rng: () => 0.5, skillSelectionResolver: loadout.resolver });
  const inserted = [];
  engine.insertAction = (entity, skill) => inserted.push([entity, skill]);
  const shell = hero.skills[0];
  const logger = quiet();
  shell.execute(hero, [hero], [foe], logger, engine, {});
  assert.match(text(logger.logs), /玩家 開啟了忍耐！/);
  assert.equal(hero.stats.sp, 100);                       // 開啟不扣 SP
  assert.equal(shell.canCast(hero, engine), false);       // 開啟後不會再選到
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], hero);
  // 額外行動照平常選招（施放率 0 → 普攻）
  const extra = quiet();
  inserted[0][1].execute(hero, [hero], [foe], extra, engine);
  assert.match(text(extra.logs), /^玩家 攻擊，對 foe 造成了/);
  // 受到 500 傷害 → 下回合開始回復 100、扣 8 SP
  const [taken, round] = ['gem_aura_taken', 'gem_aura_round'].map(prefix => hero.passives.find(p => p.id.startsWith(prefix)));
  hero.stats.hp -= 500;
  taken.action(hero, { actualDamage: 500 });
  const heal = quiet();
  const sp = hero.stats.sp;
  round.action(hero, 2, heal, engine);
  assert.equal(hero.stats.hp, 4600);
  assert.equal(hero.stats.sp, sp - 8);
  assert.match(text(heal.logs), /玩家 忍耐著傷痛，回復了 100 點生命！/);
  // 結算後歸零：下一回合沒受傷就不回
  round.action(hero, 3, quiet(), engine);
  assert.equal(hero.stats.sp, sp - 16);
  assert.equal(hero.stats.hp, 4600);
  // SP 不夠：不扣、不發動
  hero.stats.sp = 5;
  taken.action(hero, { actualDamage: 500 });
  const low = quiet();
  round.action(hero, 4, low, engine);
  assert.deepEqual([hero.stats.sp, hero.stats.hp], [5, 4600]);
  assert.equal(text(low.logs), '玩家 的 SP 不足，忍耐沒有發動。');
});

test('忍耐＋佈局：第一動開啟（戰報「玩家的第一動，開啟了忍耐！」），然後再行動一次', () => {
  const loadout = compileLoadout([{ active: 'endure', supports: ['layout'] }]);
  const hero = unit('hero', 'A', { spd: 1000 });
  hero.skills = loadout.skills;
  hero.passives = loadout.passives;
  const foe = unit('foe', 'B', { atk: 1, spd: 1 });
  const engine = new BattleEngine([hero], [foe], { rng: () => 0.5, skillSelectionResolver: loadout.resolver, maxTurns: 1 });
  engine.start();
  const lines = text(engine.logger.logs).split('\n');
  const at = lines.findIndex(line => line === '玩家的第一動，開啟了忍耐！');
  assert.ok(at >= 0, lines.join('\n'));
  assert.match(lines[at + 1], /^玩家 攻擊，/);
});

// ── 第二區輔助寶石（2026-11-22，使用者設計）──────────────────────

test('反覆：這組以外每多一組相同的主動寶石，傷害 +35%（加算）；只算主動寶石相同的組', () => {
  const power = loadout => loadout.skills[0].actions.find(a => a.type === 'DAMAGE').power;
  const alone = compileLoadout([{ active: 'rend', supports: ['reprise'] }]);
  const plain = compileLoadout([{ active: 'rend' }]);
  assert.equal(power(alone), power(plain));                                    // 沒有其他組：沒加成
  const two = compileLoadout([{ active: 'rend', supports: ['reprise'] }, { active: 'rend' }]);
  const three = compileLoadout([{ active: 'rend', supports: ['reprise'] }, { active: 'rend', supports: ['amp'] }, { active: 'rend' }, { active: 'whirlwind' }]);
  assert.ok(Math.abs(power(two) - power(plain) * 1.35) < 1e-3);
  assert.ok(Math.abs(power(three) - power(plain) * 1.7) < 1e-3);               // 2 組相同（旋風斬不算）
  assert.equal(power({ skills: [two.skills[1]] }), power(plain));               // 沒連反覆的那組不受影響
  assert.throws(() => compileSkill('endure', ['reprise']), GemLinkError);       // 沒有傷害的技能不能連
});

test('混沌爆擊：物理單體限定；暴擊時 50% 機率追加目標生命上限 10% 的傷害（吃防禦、不會暴擊），沒暴擊不追加', () => {
  assert.ok(compileSkill('rend', ['chaoscrit']));
  assert.throws(() => compileSkill('whirlwind', ['chaoscrit']), GemLinkError);
  assert.throws(() => compileSkill('magicmissile', ['chaoscrit']), GemLinkError);
  const run = (cri, def) => {
    const loadout = compileLoadout([{ active: 'pursuit', supports: ['chaoscrit'] }]);
    const hero = unit('hero', 'A', { cri, atk: 1 });
    hero.passives = loadout.passives;
    const foe = unit('foe', 'B', { hp: 100000, maxHp: 100000, def });
    const engine = new BattleEngine([hero], [foe], { rng: () => 0.5 });
    const logger = quiet();
    loadout.skills[0].execute(hero, [hero], [foe], logger, engine, { targets: [foe] });
    return text(logger.logs);
  };
  let procs = 0;
  for (let i = 0; i < 200; i++) if (/混沌/.test(run(1, 0))) procs++;
  assert.ok(procs > 60 && procs < 140, `200 次暴擊觸發 ${procs} 次`);           // 約一半
  const hits = Array.from({ length: 40 }, () => run(1, 0)).find(log => /混沌/.test(log));
  assert.match(hits, /混沌的裂痕撕開了 foe，追加 10000 點傷害！/);
  const halved = Array.from({ length: 40 }, () => run(1, 300)).find(log => /混沌/.test(log));
  assert.match(halved, /追加 5000 點傷害！/);                                    // 防禦 300 → 減半
  assert.doesNotMatch(run(0, 0), /混沌/);
});

test('第二區輔助寶石只在第二區掉落', () => {
  const { rollDrops } = require('./dropTable');
  const { createSeededRandom } = require('../src');
  const rng = createSeededRandom(5);
  const seen = { 1: new Set(), 2: new Set() };
  for (let i = 0; i < 3000; i++) for (const area of [1, 2]) for (const gem of rollDrops(10, rng, { area, rare: true }).supportGems ?? []) seen[area].add(gem);
  assert.ok(!seen[1].has('reprise') && !seen[1].has('chaoscrit'));
  assert.ok(seen[2].has('reprise') && seen[2].has('chaoscrit'));
});
