'use strict';

// 施放權重的測試。執行：node --test gems/castWeight.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { compileLoadout, buildWeightResolver, GemLinkError } = require('./gemCompiler');
const { DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT } = require('./gems');

const plain = id => new Skill({ id, name: id, actions: [{ type: 'DAMAGE' }] });
// 三個互不相同的技能：同一顆主動寶石搭不同的輔助寶石。
const trio = (w1, w2, w3) => [
  { active: 'magicmissile', supports: ['heavy'], ...(w1 === undefined ? {} : { weight: w1 }) },
  { active: 'magicmissile', supports: ['lean'], ...(w2 === undefined ? {} : { weight: w2 }) },
  { active: 'magicmissile', supports: [], ...(w3 === undefined ? {} : { weight: w3 }) }
];
const HEAVY = 'magicmissile+heavy';
const LEAN = 'magicmissile+lean';
const BASE = 'magicmissile';

function battle(entries, seed, { sp = 99999, castRate = 1, maxTurns = 30, resolver = true, extraSkills = [], heroHp = 999999 } = {}) {
  const loadout = compileLoadout(entries);
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain('slash'),
    skills: [...loadout.skills, ...extraSkills], passives: loadout.passives,
    stats: { hp: heroHp, sp, atk: 150, def: 50, spd: 120, cri: 0, skillCastRate: castRate }
  });
  const foe = new Entity({ id: 'boss', name: '魔王', team: 'B', normalAttack: plain('claw'), stats: { hp: 999999, sp: 0, atk: 1, def: 0, spd: 1 } });
  const engine = new BattleEngine([hero], [foe], {
    rng: createSeededRandom(seed), maxTurns, ...(resolver ? { skillSelectionResolver: loadout.resolver } : {})
  });
  return { loadout, logs: engine.start().logs };
}
function tally(entries, seeds, options) {
  const counts = {};
  let total = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    for (const log of battle(entries, seed, options).logs) {
      if (log.type === 'DAMAGE' && log.actorId === 'hero') { counts[log.skillId] = (counts[log.skillId] || 0) + 1; total++; }
    }
  }
  return { counts, total, share: id => (counts[id] || 0) / total };
}

// ── 範圍與資料 ──────────────────────────────────────────────

test('範圍是二到三位數：預設 100，最小 10，最大 999', () => {
  assert.equal(MIN_WEIGHT, 10);
  assert.equal(MAX_WEIGHT, 999);
  assert.ok(DEFAULT_WEIGHT >= MIN_WEIGHT && DEFAULT_WEIGHT <= MAX_WEIGHT);
});

test('loadout.weights 以技能 id 列出每個技能的權重，沒寫就是預設值', () => {
  const loadout = compileLoadout(trio(250, undefined, 999));
  assert.deepEqual(loadout.weights, { [HEAVY]: 250, [LEAN]: DEFAULT_WEIGHT, [BASE]: 999 });
  assert.equal(loadout.compiled[0].weight, 250);
});

test('邊界值 10 與 999 合法', () => {
  assert.doesNotThrow(() => compileLoadout(trio(MIN_WEIGHT, MAX_WEIGHT, 100)));
});

test('權重不合法會在編譯時被指出：太小、太大、非整數、非數字、零與負數', () => {
  for (const bad of [9, 1000, 0, -50, 100.5, '100', NaN, Infinity, null]) {
    assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: [], weight: bad }]), error => {
      assert.ok(error instanceof GemLinkError, `${String(bad)} 應丟 GemLinkError`);
      assert.match(error.message, /施放權重必須是 10～999 的整數/);
      assert.equal(error.gemId, 'magicmissile');
      return true;
    }, `權重 ${String(bad)} 應該被拒絕`);
  }
});

// ── 機率 ────────────────────────────────────────────────────

test('機率 = 權重 ÷ 總和（100/200/300 → 約 16.7% / 33.3% / 50%）', () => {
  const result = tally(trio(100, 200, 300), 100);
  assert.ok(result.total > 8000, `樣本太少：${result.total}`);
  assert.ok(Math.abs(result.share(HEAVY) - 1 / 6) < 0.02, `heavy ${result.share(HEAVY)}`);
  assert.ok(Math.abs(result.share(LEAN) - 2 / 6) < 0.02, `lean ${result.share(LEAN)}`);
  assert.ok(Math.abs(result.share(BASE) - 3 / 6) < 0.02, `base ${result.share(BASE)}`);
});

test('極端比例（10 / 10 / 980）：小的仍會被抽到，約各 1%', () => {
  const result = tally(trio(10, 10, 980), 100);
  assert.ok(result.share(BASE) > 0.96, `base ${result.share(BASE)}`);
  for (const id of [HEAVY, LEAN]) {
    assert.ok(result.share(id) > 0.003 && result.share(id) < 0.025, `${id} ${result.share(id)}`);
  }
});

test('權重只決定放哪一招，不改變「放不放技能」的頻率（施放率 50%）', () => {
  const skillShare = entries => {
    let skills = 0;
    let all = 0;
    for (let seed = 1; seed <= 80; seed++) {
      for (const log of battle(entries, seed, { castRate: 0.5, maxTurns: 20 }).logs) {
        if (log.type !== 'DAMAGE' || log.actorId !== 'hero') continue;
        all++;
        if (log.skillId !== 'slash') skills++;
      }
    }
    return skills / all;
  };
  // 普攻會吃速度連擊（一次普攻打出多行傷害），所以不比絕對占比，只比「加權」與「均等」是否一致。
  const weighted = skillShare(trio(100, 200, 700));
  const even = skillShare(trio());
  assert.ok(Math.abs(weighted - even) < 0.03, `加權 ${weighted} vs 均等 ${even}`);
});

// ── 權重全相等時完全不介入 ───────────────────────────────────

test('權重全相等（預設或同一個數字）：戰報與沒寫權重時逐字相同，亂數序列不變', () => {
  const messages = entries => battle(entries, 7).logs.map(log => log.message).join('\n');
  const baseline = messages(trio());
  assert.equal(messages(trio(100, 100, 100)), baseline);
  assert.equal(messages(trio(250, 250, 250)), baseline);
});

test('只有一個技能時，權重沒有影響', () => {
  const single = weight => battle([{ active: 'magicmissile', supports: [], ...(weight ? { weight } : {}) }], 3).logs.map(log => log.message).join('\n');
  assert.equal(single(900), single());
});

test('同一個種子結果可重現', () => {
  const run = () => battle(trio(100, 200, 300), 11).logs.map(log => log.message).join('\n');
  assert.equal(run(), run());
});

// ── resolver 單元：候選、排除與不介入 ────────────────────────

// 直接呼叫 resolver：用 Math.random 的替身固定亂數（框架的 random() 每次都讀當下的 Math.random）。
function withSeed(seed, run) {
  const original = Math.random;
  Math.random = createSeededRandom(seed);
  try { return run(); } finally { Math.random = original; }
}
function fakeCaster(skills, { opening = null, silenced = () => false } = {}) {
  const caster = new Entity({
    id: 'c', name: '勇者', team: 'A', normalAttack: plain('slash'), skills,
    stats: { hp: 1000, sp: 99999, atk: 100, def: 0, spd: 100 }
  });
  caster.openingSkill = opening;
  caster.silencedBy = skill => (silenced(skill) ? { id: 'silence' } : null);
  return caster;
}
function setup(weights) {
  const loadout = compileLoadout(trio(...weights));
  const [heavy, lean, base] = loadout.skills;
  const resolver = buildWeightResolver(loadout.compiled);
  return { loadout, heavy, lean, base, resolver };
}
const effective = (resolver, caster, picked) => resolver({ caster, skill: picked, engine: {} }) ?? picked;
function frequencies(resolver, caster, picked, runs = 6000, seed = 1) {
  const counts = new Map();
  withSeed(seed, () => {
    for (let i = 0; i < runs; i++) {
      const result = effective(resolver, caster, picked);
      counts.set(result, (counts.get(result) || 0) + 1);
    }
  });
  return skill => (counts.get(skill) || 0) / runs;
}

test('權重只在「當下可施放」的技能之間分配：SP 不夠或條件不成立的技能不佔機率', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 300]);
  base.canCast = () => false;
  const share = frequencies(resolver, fakeCaster([heavy, lean, base]), heavy);
  assert.equal(share(base), 0);
  assert.ok(Math.abs(share(heavy) - 1 / 3) < 0.03, `heavy ${share(heavy)}`);
  assert.ok(Math.abs(share(lean) - 2 / 3) < 0.03, `lean ${share(lean)}`);
});

test('被沉默的技能不會被選出來（換出來的招不會再被引擎檢查沉默）', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 300]);
  const caster = fakeCaster([heavy, lean, base], { silenced: skill => skill === base });
  const share = frequencies(resolver, caster, heavy);
  assert.equal(share(base), 0);
  assert.ok(Math.abs(share(heavy) - 1 / 3) < 0.03);
});

test('可選的技能少於兩個時不介入，保留引擎抽到的那一招', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 300]);
  lean.canCast = () => false;
  base.canCast = () => false;
  assert.equal(resolver({ caster: fakeCaster([heavy, lean, base]), skill: heavy, engine: {} }), undefined);
});

test('候選的權重都相等時不介入（沒有消耗亂數）', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 100]);
  lean.canCast = () => false;
  let calls = 0;
  const original = Math.random;
  Math.random = () => { calls++; return 0.5; };
  try {
    assert.equal(resolver({ caster: fakeCaster([heavy, lean, base]), skill: heavy, engine: {} }), undefined);
  } finally { Math.random = original; }
  assert.equal(calls, 0);
});

test('引擎抽到普攻或不屬於這組配置的技能時不介入，手寫技能也不會被權重抽出來', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 300]);
  const handmade = plain('handmade');
  const normal = plain('slash');
  const caster = fakeCaster([heavy, lean, base, handmade]);
  assert.equal(resolver({ caster, skill: normal, engine: {} }), undefined);
  assert.equal(resolver({ caster, skill: handmade, engine: {} }), undefined);
  withSeed(2, () => {
    for (let i = 0; i < 2000; i++) assert.notEqual(effective(resolver, caster, heavy), handmade);
  });
});

test('抽中的和引擎抽到的是同一招時回傳 undefined，不算換招', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 300]);
  const original = Math.random;
  Math.random = () => 0; // roll 0 → 第一個候選
  try {
    assert.equal(resolver({ caster: fakeCaster([heavy, lean, base]), skill: heavy, engine: {} }), undefined);
    assert.equal(resolver({ caster: fakeCaster([heavy, lean, base]), skill: base, engine: {} }), heavy);
  } finally { Math.random = original; }
});

test('開場的第一槽不動（佈局承諾第一動必定是它），之後才開始依權重抽', () => {
  const { heavy, lean, base, resolver } = setup([100, 200, 300]);
  const caster = fakeCaster([heavy, lean, base], { opening: heavy });
  const original = Math.random;
  Math.random = () => 0.99; // 若介入，一定抽到最後一個候選 base
  try {
    assert.equal(resolver({ caster, skill: heavy, engine: {} }), undefined, '第一槽是開場技能，不能換掉');
    assert.equal(resolver({ caster, skill: heavy, engine: {} }), base, '第二槽起正常加權');
  } finally { Math.random = original; }
});

// ── 與其他機制搭配 ───────────────────────────────────────────

test('搭配佈局：不管權重多懸殊，第一動一定是佈局的技能', () => {
  const entries = [
    { active: 'magicmissile', supports: ['layout'], weight: 10 },
    { active: 'magicmissile', supports: ['heavy'], weight: 990 }
  ];
  for (let seed = 1; seed <= 40; seed++) {
    const first = battle(entries, seed).logs.find(log => log.type === 'DAMAGE' && log.actorId === 'hero');
    assert.equal(first.skillId, 'magicmissile+layout', `seed ${seed}`);
    assert.match(first.message, /第一動/);
  }
});

test('搭配蓄力：權重照常決定要放哪一招，蓄力的釋放不受影響、不會卡住', () => {
  const entries = [
    { active: 'magicmissile', supports: ['charge'], weight: 500 },
    { active: 'magicmissile', supports: [], weight: 100 }
  ];
  let shells = 0;
  let releases = 0;
  let others = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const logs = battle(entries, seed, { maxTurns: 25 }).logs;
    const shellCount = logs.filter(log => /開始蓄力/.test(log.message)).length;
    const releaseCount = logs.filter(log => log.type === 'DAMAGE' && /#release$/.test(log.skillId || '')).length;
    assert.ok(shellCount - releaseCount <= 1 && shellCount >= releaseCount, `seed ${seed}：蓄力 ${shellCount} 次、釋放 ${releaseCount} 次`);
    shells += shellCount;
    releases += releaseCount;
    others += logs.filter(log => log.type === 'DAMAGE' && log.skillId === BASE).length;
  }
  assert.ok(releases > 0);
  const share = shells / (shells + others);
  assert.ok(Math.abs(share - 500 / 600) < 0.04, `蓄力占選招 ${share}`);
});

// ── 守衛：忘了傳 resolver ───────────────────────────────────

test('權重不全相等卻沒傳 skillSelectionResolver：開場就報錯，不是靜默失效', () => {
  assert.throws(() => battle(trio(100, 200, 300), 1, { resolver: false }), /施放權重不全相等時，需要.*skillSelectionResolver/);
});

test('權重不全相等且有傳 resolver：正常進行；全相等時不傳也沒事', () => {
  assert.doesNotThrow(() => battle(trio(100, 200, 300), 1));
  assert.doesNotThrow(() => battle(trio(), 1, { resolver: false }));
  assert.doesNotThrow(() => battle(trio(250, 250, 250), 1, { resolver: false }));
});

test('守衛只在權重不全相等時加進被動', () => {
  assert.ok(compileLoadout(trio(100, 200, 300)).passives.some(passive => passive.id === 'gem_weight_guard'));
  assert.ok(!compileLoadout(trio()).passives.some(passive => passive.id === 'gem_weight_guard'));
});
