'use strict';

// 寶石系統的可行性測試。執行：node --test gem/gems.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, Buff, BattleEngine, createSeededRandom } = require('../src');
const { compileSkill, compileLoadout, buildGrantPassives, buildChargeResolver, combineResolvers, describeSupport, validateGemData, GemLinkError } = require('./gemCompiler');
const { ACTIVE_GEMS, SUPPORT_GEMS, GROUPS, MAX_SUPPORTS } = require('./gems');

const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });
const logger = () => ({ logs: [], addLog(entry) { this.logs.push(entry); } });

const makeHero = (skills, passives = [], stats = {}) => new Entity({
  id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills, passives,
  stats: { hp: 3000, maxHp: 4000, sp: 200, atk: 150, def: 50, spd: 120, cri: 0, skillCastRate: 1, ...stats }
});
const makeFoe = (id, stats = {}) => new Entity({
  id, name: id, team: 'B', normalAttack: plain,
  stats: { hp: 100000, sp: 0, atk: 1, def: 0, spd: 1, ...stats }
});

// 測試用的小寶石：只放一個效果，方便驗證加算與乘算。
const round = value => Math.round(value * 1e4) / 1e4;
const mkGem = (id, effects, extra = {}) => ({
  id, name: id, requires: { action: { type: 'DAMAGE' } }, addTags: [], effects, ...extra
});
const stackGems = {
  inc1: mkGem('inc1', [{ op: 'inc', value: 0.2 }]),
  inc2: mkGem('inc2', [{ op: 'inc', value: 0.2 }]),
  more1: mkGem('more1', [{ op: 'more', value: 0.2 }]),
  more2: mkGem('more2', [{ op: 'more', value: 0.2 }])
};
const compileWith = (links, supportGems, extra = {}) => compileSkill('magicmissile', links, { supportGems, ...extra });
const powerOf = result => result.skill.actions[0].power;
// 加算與乘算的算術測試要同時疊 4 顆小寶石，這跟連結上限無關，所以明確放寬到 4。
const STACK_OPTIONS = { maxSupports: 4 };

// ── 編譯結果 ────────────────────────────────────────────────

test('沒有輔助寶石時，與手寫魔法飛彈等價（power 1.5、SP 10）', () => {
  const { skill, spCost, damageFactor } = compileSkill('magicmissile');
  assert.equal(skill.id, 'magicmissile');
  assert.equal(skill.actions[0].power, 1.5);
  assert.equal(spCost, 10);
  assert.equal(skill.actions[0].spCost, 10);
  assert.equal(damageFactor, 1);
});

test('數值結算：乘算相乘、cost 相乘後進位、SP 只寫在第一段', () => {
  const heavy = compileSkill('magicmissile', ['heavy']);
  assert.equal(heavy.skill.actions[0].power, 1.95);   // 1.5 × (1 + 0.3)
  assert.equal(heavy.spCost, 12);                      // 10 × (1 + 0.2)
  const lean = compileSkill('magicmissile', ['lean']);
  assert.equal(lean.skill.actions[0].power, 1.275);   // 1.5 × (1 - 0.15)
  assert.equal(lean.spCost, 6);
  const both = compileSkill('magicmissile', ['heavy', 'shock']);
  assert.equal(both.skill.actions[0].power, 1.95);    // 1.5 × 1.3（感電不再減傷害）
  assert.equal(both.skill.id, 'magicmissile+heavy+shock');
  assert.equal(both.skill.actions.length, 2);          // DAMAGE + 感電 BUFF
  assert.equal(both.skill.actions[1].spCost, undefined);
});

test('編譯不會改到寶石定義本身', () => {
  const before = JSON.stringify([ACTIVE_GEMS, SUPPORT_GEMS, GROUPS]);
  compileSkill('magicmissile', ['wide', 'pierce']);
  compileSkill('whirlwind', ['heavy', 'amp']);
  assert.equal(JSON.stringify([ACTIVE_GEMS, SUPPORT_GEMS, GROUPS]), before);
});

// ── 加算（inc）與乘算（more）──────────────────────────────────

test('加算：兩顆 +20% 相加成 1.4 倍', () => {
  const result = compileWith(['inc1', 'inc2'], stackGems);
  assert.equal(result.damageFactor, 1.4);
  assert.equal(powerOf(result), 2.1);                  // 1.5 × 1.4
});

test('乘算：兩顆 +20% 相乘成 1.44 倍', () => {
  const result = compileWith(['more1', 'more2'], stackGems);
  assert.equal(result.damageFactor, 1.44);
  assert.equal(powerOf(result), 2.16);                 // 1.5 × 1.44
});

test('加算與乘算同時存在：兩區各自結算後再相乘，且與插槽順序無關', () => {
  const ordered = compileWith(['inc1', 'inc2', 'more1', 'more2'], stackGems, STACK_OPTIONS);
  const mixed = compileWith(['more1', 'inc1', 'more2', 'inc2'], stackGems, STACK_OPTIONS);
  assert.equal(ordered.damageFactor, 2.016);           // 1.4 × 1.44
  assert.equal(powerOf(ordered), 3.024);
  assert.equal(mixed.damageFactor, ordered.damageFactor);
  assert.equal(powerOf(mixed), powerOf(ordered));
});

test('負值：加算降低是相減、乘算減少是相乘', () => {
  const gems = {
    dec1: mkGem('dec1', [{ op: 'inc', value: -0.2 }]),
    dec2: mkGem('dec2', [{ op: 'inc', value: -0.2 }]),
    less1: mkGem('less1', [{ op: 'more', value: -0.2 }]),
    less2: mkGem('less2', [{ op: 'more', value: -0.2 }])
  };
  assert.equal(compileWith(['dec1', 'dec2'], gems).damageFactor, 0.6);     // 1 - 0.2 - 0.2
  assert.equal(compileWith(['less1', 'less2'], gems).damageFactor, 0.64);  // 0.8 × 0.8
});

test('倍率歸零或為負會被拒絕（框架把 power 0 當成 1，不能放行）', () => {
  const gems = { wipe: mkGem('wipe', [{ op: 'inc', value: -1 }]) };
  assert.throws(() => compileWith(['wipe'], gems), error =>
    error instanceof GemLinkError && error.reason.includes('小於或等於 0'));
});

test('正式資料：增幅走加算、強力走乘算，兩者同時連結時兩區相乘', () => {
  assert.equal(compileSkill('magicmissile', ['amp']).damageFactor, 1.2);             // 1 + 0.2
  assert.equal(powerOf(compileSkill('magicmissile', ['amp'])), 1.8);
  const both = compileSkill('magicmissile', ['heavy', 'amp']);
  assert.equal(both.damageFactor, 1.56);                                         // 1.2 × 1.3
  assert.equal(powerOf(both), 2.34);
  assert.equal(both.spCost, 12);                                                 // 10 × 1.2（增幅沒有消耗變化）
});

test('實戰：加算與乘算打出來的平均傷害，確實分別是 1.4 倍與 1.44 倍', () => {
  // 換掉 Math.random：框架每次擲骰都讀當下的 Math.random，所以這段統計是可重現的。
  const original = Math.random;
  const meanDamage = links => {
    Math.random = createSeededRandom(20260101);
    const { skill } = compileWith(links, stackGems, STACK_OPTIONS);
    const rounds = 2000;
    let total = 0;
    for (let i = 0; i < rounds; i++) {
      const hero = makeHero([skill]);
      const dummy = makeFoe('dummy', { def: 0 });
      skill.execute(hero, [hero], [dummy], logger(), null);
      total += 100000 - dummy.stats.hp;
    }
    return total / rounds;
  };
  try {
    const base = meanDamage([]);
    const near = (actual, expected) => Math.abs(actual - expected) / expected < 0.01;
    assert.ok(near(meanDamage(['inc1', 'inc2']) / base, 1.4), '加算應約為 1.4 倍');
    assert.ok(near(meanDamage(['more1', 'more2']) / base, 1.44), '乘算應約為 1.44 倍');
    assert.ok(near(meanDamage(['inc1', 'inc2', 'more1', 'more2']) / base, 2.016), '合併應約為 2.016 倍');
  } finally {
    Math.random = original;
  }
});

// ── 互斥組 ──────────────────────────────────────────────────

test('同組互斥：不論順序都被擋下，兩種順序的錯誤完全相同，且同時指出雙方與組名', () => {
  const errors = [['heavy', 'lean'], ['lean', 'heavy']].map(links => {
    try { compileSkill('magicmissile', links); } catch (error) { return error; }
    return null;
  });
  for (const error of errors) {
    assert.ok(error instanceof GemLinkError);
    assert.deepEqual(new Set([error.gemId, error.conflictsWith]), new Set(['heavy', 'lean']));
    assert.match(error.reason, /消耗取捨/);
  }
  assert.equal(errors[0].message, errors[1].message);
});

test('不同組、沒有組的寶石不受互斥影響', () => {
  assert.doesNotThrow(() => compileSkill('magicmissile', ['heavy', 'amp']));
  assert.doesNotThrow(() => compileSkill('magicmissile', ['lean', 'pierce', 'shock']));
});

test('新增同組寶石不必修改任何既有寶石，就自動與同組互斥', () => {
  const gems = {
    ...SUPPORT_GEMS,
    frugal: mkGem('frugal', [{ op: 'cost', value: -0.5 }], { name: '儉省', exclusiveGroup: 'economy' })
  };
  const conflictPair = (links, pair) => assert.throws(() => compileWith(links, gems), error =>
    error instanceof GemLinkError && new Set([error.gemId, error.conflictsWith]).size === 2 &&
    pair.every(id => error.gemId === id || error.conflictsWith === id));
  for (const order of [['heavy', 'frugal'], ['frugal', 'heavy']]) conflictPair(order, ['heavy', 'frugal']);
  for (const order of [['lean', 'frugal'], ['frugal', 'lean']]) conflictPair(order, ['lean', 'frugal']);
  assert.doesNotThrow(() => compileWith(['frugal', 'pierce'], gems));
  // 既有寶石的資料裡完全沒有出現新寶石的名字。
  assert.ok(!JSON.stringify(SUPPORT_GEMS.heavy).includes('frugal'));
  assert.ok(!JSON.stringify(SUPPORT_GEMS.lean).includes('frugal'));
});

test('requires.gems.none 仍可用於一次性的特殊規則，不論順序都成立', () => {
  const gems = { ...SUPPORT_GEMS, odd: mkGem('odd', [{ op: 'more', value: 0.1 }], { requires: { action: { type: 'DAMAGE' }, gems: { none: ['pierce'] } } }) };
  for (const links of [['pierce', 'odd'], ['odd', 'pierce']]) {
    assert.throws(() => compileWith(links, gems), error =>
      error.gemId === 'odd' && error.conflictsWith === 'pierce');
  }
  assert.doesNotThrow(() => compileWith(['odd', 'heavy'], gems));
});

// ── 資料驗證 ────────────────────────────────────────────────

test('正式的寶石資料沒有任何問題', () => {
  assert.deepEqual(validateGemData(SUPPORT_GEMS, GROUPS), []);
});

test('資料寫錯會被抓到：拼錯互斥組、未知的 op、引用不存在的寶石、id 對不上', () => {
  const bad = {
    a: mkGem('a', [{ op: 'more', value: 0.1 }], { exclusiveGroup: 'ecomony' }),
    b: mkGem('b', [{ op: 'moar', value: 0.1 }]),
    c: mkGem('c', [{ op: 'more', value: 0.1 }], { requires: { gems: { none: ['ghost'] } } }),
    d: mkGem('wrong', [{ op: 'inc', value: 'lots' }])
  };
  const problems = validateGemData(bad, GROUPS).join('\n');
  assert.match(problems, /ecomony/);
  assert.match(problems, /moar/);
  assert.match(problems, /ghost/);
  assert.match(problems, /id（wrong）/);
  assert.match(problems, /inc 需要有限數字/);
  assert.throws(() => compileWith([], bad), /寶石資料有誤/);
});

// ── 連結上限 ────────────────────────────────────────────────

test('連結上限：每顆主動寶石最多 3 顆輔助寶石', () => {
  assert.equal(MAX_SUPPORTS, 3);
});

test('連結上限：剛好 3 顆可以，第 4 顆被擋下，錯誤指向第 4 顆並說明上限', () => {
  assert.doesNotThrow(() => compileSkill('magicmissile', ['heavy', 'amp', 'pierce']));
  assert.throws(() => compileSkill('magicmissile', ['heavy', 'amp', 'pierce', 'shock']), error => {
    assert.ok(error instanceof GemLinkError);
    assert.equal(error.gemId, 'shock');                 // 第 4 顆
    assert.match(error.reason, /最多連結 3 顆/);
    assert.match(error.reason, /這組有 4 顆/);
    return true;
  });
});

test('連結上限：每顆主動寶石各自計算，不是整個角色共用', () => {
  assert.doesNotThrow(() => compileSkill('magicmissile', ['heavy', 'amp', 'pierce']));
  assert.doesNotThrow(() => compileSkill('whirlwind', ['heavy', 'amp', 'pierce']));
});

test('連結上限：即使每一顆都合法，超過數量一樣整組拒絕', () => {
  const ids = Object.keys(SUPPORT_GEMS);
  // 這 4 顆彼此都不衝突，拿掉任一顆都能編譯成功。
  const four = ['heavy', 'amp', 'pierce', 'shock'];
  for (const dropped of four) {
    assert.doesNotThrow(() => compileSkill('magicmissile', four.filter(id => id !== dropped)));
  }
  assert.throws(() => compileSkill('magicmissile', four), GemLinkError);
  assert.ok(ids.length > MAX_SUPPORTS, '寶石總數要比上限多，上限才有意義');
});

test('連結上限：可以用 options.maxSupports 覆寫，且必須是不小於 0 的整數', () => {
  assert.doesNotThrow(() => compileSkill('magicmissile', ['heavy', 'amp', 'pierce', 'shock'], { maxSupports: 4 }));
  assert.throws(() => compileSkill('magicmissile', ['heavy', 'amp'], { maxSupports: 1 }), error => error.gemId === 'amp');
  assert.throws(() => compileSkill('magicmissile', ['heavy'], { maxSupports: 0 }), GemLinkError);
  assert.doesNotThrow(() => compileSkill('magicmissile', [], { maxSupports: 0 }));
  for (const bad of [-1, 1.5, NaN, '3']) {
    assert.throws(() => compileSkill('magicmissile', [], { maxSupports: bad }), /maxSupports 必須是不小於 0 的整數/);
  }
});

// ── 條件 ────────────────────────────────────────────────────

test('條件會擋下不合法的連結，且錯誤帶有寶石 id 與原因', () => {
  const rejects = (active, supports, gemId) => assert.throws(
    () => compileSkill(active, supports),
    error => error instanceof GemLinkError && error.gemId === gemId && error.reason.length > 0);
  rejects('magicmissile', ['leech'], 'leech');           // 汲取：僅限非法術
  rejects('whirlwind', ['shock'], 'shock');          // 感電：僅限法術
  rejects('whirlwind', ['wide'], 'wide');            // 擴散：已是 aoe
  rejects('mend', ['heavy'], 'heavy');               // 治療沒有傷害段
  rejects('mend', ['amp'], 'amp');
  rejects('magicmissile', ['heavy', 'heavy'], 'heavy');  // 不能連結兩次
  rejects('magicmissile', ['nope'], 'nope');             // 不存在
});

test('條件只看主動寶石原本的樣子，其他輔助寶石改了什麼都不影響它', () => {
  const gems = {
    ...SUPPORT_GEMS,
    needAoe: mkGem('needAoe', [{ op: 'more', value: 0.1 }], { requires: { tags: { all: ['aoe'] } } })
  };
  // 擴散會讓魔法飛彈多一個 aoe 標籤，但 needAoe 看的是魔法飛彈原本的標籤，所以不論順序都不成立。
  for (const links of [['wide', 'needAoe'], ['needAoe', 'wide']]) {
    assert.throws(() => compileWith(links, gems), error => error.gemId === 'needAoe');
  }
  // 同樣的條件對本來就有 aoe 的旋風斬成立。
  assert.doesNotThrow(() => compileSkill('whirlwind', ['needAoe'], { supportGems: gems }));
  // addTags 仍會寫進編譯出的技能（給執行期用），只是不會被其他寶石的條件看到。
  assert.ok(compileSkill('magicmissile', ['wide']).skill.tags.includes('aoe'));
});

// ── 順序無關 ────────────────────────────────────────────────

const combinations = (items, size) => size === 0 ? [[]] : items.flatMap(
  (item, i) => combinations(items.slice(i + 1), size - 1).map(rest => [item, ...rest]));
const permutationsOf = items => items.length <= 1 ? [items] : items.flatMap(
  (item, i) => permutationsOf([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));

// 編譯結果的指紋：合法時是技能的全部可觀察內容；不合法時是完整的錯誤訊息與衝突對象。
const signature = (active, links, options) => {
  try {
    const compiled = compileSkill(active, links, options);
    return JSON.stringify({
      id: compiled.skill.id, spCost: compiled.spCost, factor: compiled.damageFactor,
      tags: [...compiled.skill.tags].sort(), actions: compiled.skill.actions,
      passives: compiled.passives.length, links: compiled.links
    });
  } catch (error) {
    if (!(error instanceof GemLinkError)) throw error;
    return `REJECT ${error.message} | ${error.gemId} | ${error.conflictsWith}`;
  }
};

test('順序無關：正式資料中每個組合的每一種排列，結果（含錯誤訊息）完全相同', () => {
  const ids = Object.keys(SUPPORT_GEMS);
  let sets = 0;
  for (const active of Object.keys(ACTIVE_GEMS)) {
    for (let size = 0; size <= MAX_SUPPORTS; size++) {
      for (const set of combinations(ids, size)) {
        sets++;
        const signatures = new Set(permutationsOf(set).map(links => signature(active, links)));
        assert.equal(signatures.size, 1, `${active} + [${set.join(', ')}] 換順序結果不同`);
      }
    }
  }
  assert.ok(sets > 100);
});

test('順序無關：技能 id 與 links 都用固定順序，同一組寶石只會有同一個 id', () => {
  const a = compileSkill('magicmissile', ['shock', 'heavy', 'pierce']);
  const b = compileSkill('magicmissile', ['pierce', 'heavy', 'shock']);
  assert.equal(a.skill.id, 'magicmissile+heavy+pierce+shock');
  assert.equal(b.skill.id, a.skill.id);
  assert.deepEqual(a.links, ['heavy', 'pierce', 'shock']);
});

test('順序無關：超過上限一定被拒絕，不論怎麼排', () => {
  const four = ['heavy', 'amp', 'pierce', 'shock'];
  for (const links of permutationsOf(four)) {
    assert.throws(() => compileSkill('magicmissile', links), GemLinkError);
  }
});

test('順序無關：scope 衝突（把同一段改成不同對象）不論順序都被擋下；改成相同對象不算衝突', () => {
  const retarget = (id, to) => mkGem(id, [{ op: 'scope', from: 'ENEMY_ALL', to }],
    { requires: { action: { type: 'DAMAGE', targetType: 'ENEMY_ALL' } } });
  const gems = { toSingle: retarget('toSingle', 'ENEMY_SINGLE'), toSelf: retarget('toSelf', 'SELF'),
    toSingleToo: retarget('toSingleToo', 'ENEMY_SINGLE') };
  const options = { supportGems: gems };
  assert.equal(new Set(permutationsOf(['toSingle', 'toSelf']).map(l => signature('whirlwind', l, options))).size, 1);
  assert.throws(() => compileSkill('whirlwind', ['toSelf', 'toSingle'], options), error =>
    new Set([error.gemId, error.conflictsWith]).size === 2 && /攻擊對象/.test(error.reason));
  for (const links of permutationsOf(['toSingle', 'toSingleToo'])) {
    const { skill } = compileSkill('whirlwind', links, options);
    assert.equal(skill.actions[0].targetType, 'ENEMY_SINGLE');
  }
});

test('順序無關：同一個旗標被設成不同值才衝突；設成相同值不衝突', () => {
  const flag = (id, value) => mkGem(id, [{ op: 'actionFlag', flag: 'ignoreDefense', value }]);
  const gems = { ...SUPPORT_GEMS, pierceOn: flag('pierceOn', true), pierceOff: flag('pierceOff', false) };
  const options = { supportGems: gems };
  assert.equal(new Set(permutationsOf(['pierceOn', 'pierceOff']).map(l => signature('magicmissile', l, options))).size, 1);
  assert.throws(() => compileSkill('magicmissile', ['pierceOff', 'pierceOn'], options), error =>
    new Set([error.gemId, error.conflictsWith]).size === 2 && /ignoreDefense/.test(error.reason));
  for (const links of permutationsOf(['pierceOn', 'pierce'])) {
    assert.equal(compileSkill('magicmissile', links, options).skill.actions[0].ignoreDefense, true);
  }
});

test('順序無關：追加段落的先後依寶石 id 字母順序，與插槽順序無關', () => {
  const append = (id) => mkGem(id, [{ op: 'appendAction', action: { type: 'BUFF', requiresDamage: true,
    buffs: [{ id: `${id}-buff`, name: id, type: 'STAT', duration: 1 }] } }]);
  const gems = { zeta: append('zeta'), alpha: append('alpha') };
  for (const links of permutationsOf(['zeta', 'alpha'])) {
    const { skill } = compileSkill('magicmissile', links, { supportGems: gems });
    assert.deepEqual(skill.actions.slice(1).map(action => action.buffs[0].id), ['alpha-buff', 'zeta-buff']);
  }
});

test('追加的傷害段：吃到加算與乘算的數值加成，但不受 scope 與旗標影響', () => {
  const extra = mkGem('extra', [{ op: 'appendAction', action: { type: 'DAMAGE', power: 0.5, targetType: 'ENEMY_SINGLE' } }]);
  const gems = { ...SUPPORT_GEMS, extra };
  for (const links of permutationsOf(['extra', 'heavy', 'pierce'])) {
    const { skill } = compileWith(links, gems);
    assert.equal(skill.actions[0].ignoreDefense, true);        // 原本的傷害段吃到穿甲
    assert.equal(skill.actions[1].ignoreDefense, undefined);   // 追加的不吃旗標
    assert.equal(skill.actions[0].power, 1.6575);              // 原本的傷害段：1.5 × 強力 1.3 × 穿甲 0.85
    assert.equal(skill.actions[1].power, 0.5525);              // 追加的：0.5 × 1.3 × 0.85
  }
  assert.equal(compileWith(['extra', 'wide'], gems).skill.actions[1].targetType, 'ENEMY_SINGLE'); // 擴散改不到它
});

// ── 玩家看的說明 ────────────────────────────────────────────

test('說明：乘算與加算措辭不同，並標出這顆寶石屬於哪一區', () => {
  const heavy = describeSupport(SUPPORT_GEMS.heavy);
  assert.deepEqual(heavy.badges, ['乘算']);
  assert.deepEqual(heavy.lines[0], { kind: 'more', text: '額外增加 30% 傷害（乘算）' });
  assert.deepEqual(heavy.lines[1], { kind: 'cost', text: 'SP 消耗增加 20%' });

  const amp = describeSupport(SUPPORT_GEMS.amp);
  assert.deepEqual(amp.badges, ['加算']);
  assert.deepEqual(amp.lines[0], { kind: 'inc', text: '提高 20% 傷害（加算）' });
  assert.equal(amp.lines.length, 1, '增幅沒有消耗變化');

  const lean = describeSupport(SUPPORT_GEMS.lean);
  assert.deepEqual(lean.lines.map(line => line.text),
    ['SP 消耗減少 40%', '額外減少 15% 傷害（乘算）', '互斥組：消耗取捨（同組只能連結一顆）']);
});

test('說明：同時含加算與乘算的寶石兩個標記都有；沒有傷害加成的寶石沒有標記', () => {
  const both = describeSupport(mkGem('both', [{ op: 'more', value: 0.1 }, { op: 'inc', value: -0.05 }]));
  assert.deepEqual(both.badges, ['加算', '乘算']);
  assert.equal(both.lines.find(line => line.kind === 'inc').text, '降低 5% 傷害（加算）');
  assert.deepEqual(describeSupport(SUPPORT_GEMS.leech).badges, []);          // 汲取不減傷害，只多 10% SP 消耗
  assert.deepEqual(describeSupport(SUPPORT_GEMS.shock).badges, []);          // 感電不減傷害
  assert.deepEqual(describeSupport(mkGem('none', [{ op: 'cost', value: -0.1 }])).badges, []);
});

test('說明：每一顆正式寶石都能產生說明，且文字由數值自動帶出', () => {
  for (const gem of Object.values(SUPPORT_GEMS)) {
    const { lines } = describeSupport(gem);
    assert.ok(lines.length >= gem.effects.length, gem.id);
    assert.ok(lines.every(line => line.text && !line.text.includes('undefined')), gem.id);
  }
  assert.ok(describeSupport(SUPPORT_GEMS.wide).lines.some(line => line.text === '攻擊對象由單一敵人改為全體敵人'));
  assert.ok(describeSupport(SUPPORT_GEMS.pierce).lines.some(line => line.text === '無視目標防禦'));
  assert.ok(describeSupport(SUPPORT_GEMS.leech).lines.some(line => line.text === '造成實際傷害的 20% 回復自身生命'));
});

// ── 各寶石在真實執行下的效果 ──────────────────────────────────

test('擴散：單體技能一次打到全部敵人', () => {
  const { skill } = compileSkill('magicmissile', ['wide']);
  const hero = makeHero([skill]);
  const foes = [makeFoe('a'), makeFoe('b'), makeFoe('c')];
  skill.execute(hero, [hero], foes, logger(), null);
  for (const foe of foes) assert.ok(foe.stats.hp < 100000, `${foe.id} 應該受傷`);
  assert.ok(skill.tags.includes('aoe'));
});

test('穿甲：對高防禦目標的傷害明顯高於一般施放', () => {
  const average = supports => {
    const { skill } = compileSkill('magicmissile', supports);
    let total = 0;
    const rounds = 200;
    for (let i = 0; i < rounds; i++) {
      const hero = makeHero([skill]);
      const foe = makeFoe('tank', { def: 300 });
      skill.execute(hero, [hero], [foe], logger(), null);
      total += 100000 - foe.stats.hp;
    }
    return total / rounds;
  };
  const normal = average([]);
  const pierce = average(['pierce']);
  // def 300 時減傷 50%：穿甲的 ×0.85 仍然約是一般的 1.7 倍。
  assert.ok(pierce > normal * 1.5, `pierce=${pierce} normal=${normal}`);
});

test('感電：打中的目標掛上易傷，之後承受的攻擊傷害變成 1.15 倍', () => {
  const { skill } = compileSkill('magicmissile', ['shock']);
  const hero = makeHero([skill]);
  const foe = makeFoe('a');
  skill.execute(hero, [hero], [foe], logger(), null);
  const shock = foe.buffs.find(buff => buff.id === 'shock');
  assert.ok(shock, '應該掛上感電');
  assert.equal(shock.damageTaken.multiplier, 1.15);
  const hit = foe.takeDamage(1000, logger(), { action: { type: 'DAMAGE' }, caster: hero });
  assert.equal(hit.damage, 1150);
});

test('感電：沒打到傷害的目標不會被掛上（requiresDamage）', () => {
  const { skill } = compileSkill('magicmissile', ['shock']);
  const hero = makeHero([skill]);
  const foe = makeFoe('ghost');
  foe.buffs.push(new Buff({ id: 'inv', name: '無敵', type: 'STAT', duration: 9, invincible: true }));
  skill.execute(hero, [hero], [foe], logger(), null);
  assert.equal(foe.buffs.some(buff => buff.id === 'shock'), false);
});

test('汲取：依整次施放的實際傷害回血，且只對這個技能起反應', () => {
  const { skill, passives } = compileSkill('whirlwind', ['leech']);
  assert.equal(passives.length, 1);
  const hero = makeHero([skill], passives);
  const foes = [makeFoe('a'), makeFoe('b')];
  const before = hero.stats.hp;
  skill.execute(hero, [hero], foes, logger(), null);
  const dealt = foes.reduce((sum, foe) => sum + (100000 - foe.stats.hp), 0);
  const healed = hero.stats.hp - before;
  // 每個目標各自 floor(傷害 × 0.2)，所以總和最多差 1 個單位。
  assert.ok(Math.abs(healed - Math.floor(dealt * 0.2)) <= foes.length, `healed=${healed} dealt=${dealt}`);
  assert.ok(healed > 0);

  // 別的技能造成的傷害不會觸發這個被動。
  const other = new Skill({ id: 'other', name: '別招', actions: [{ type: 'DAMAGE' }] });
  const hp = hero.stats.hp;
  other.execute(hero, [hero], [makeFoe('c')], logger(), null);
  assert.equal(hero.stats.hp, hp);
});

test('強力與節能改變消耗：SP 不足時整招不會施放', () => {
  const heavy = compileSkill('magicmissile', ['heavy']).skill;       // 13 SP
  const lean = compileSkill('magicmissile', ['lean']).skill;         // 6 SP
  const hero = makeHero([], [], { sp: 10 });
  assert.equal(heavy.canCast(hero), false);
  assert.equal(lean.canCast(hero), true);
});

// ── 整場戰鬥 ────────────────────────────────────────────────

const fight = (skill, passives, seed, foeCount = 1) => {
  const hero = makeHero([skill], passives, { hp: 2000, maxHp: 2000 });
  const foes = Array.from({ length: foeCount }, (_, i) => new Entity({
    id: `foe${i}`, name: `魔物${i}`, team: 'B', normalAttack: plain,
    stats: { hp: 1500, sp: 60, atk: 130, def: 80, spd: 90, cri: 0.1 }
  }));
  return new BattleEngine([hero], foes, { rng: createSeededRandom(seed) }).start();
};

test('固定種子時，同一組連結跑出完全相同的戰報', () => {
  const run = () => {
    const { skill, passives } = compileSkill('magicmissile', ['heavy', 'shock', 'pierce']);
    return fight(skill, passives, 42).logs.map(log => log.message).join('\n');
  };
  assert.equal(run(), run());
});

test('組合掃描：所有合法的組合（以集合計，不計排列）都能跑完整場戰鬥，且每一招都真的被用到', () => {
  const ids = Object.keys(SUPPORT_GEMS);
  let legal = 0;
  let rejected = 0;
  for (const active of Object.keys(ACTIVE_GEMS)) {
    for (let size = 0; size <= MAX_SUPPORTS; size++) {
      for (const links of combinations(ids, size)) {
        let compiled;
        try { compiled = compileSkill(active, links); } catch (error) {
          assert.ok(error instanceof GemLinkError);
          rejected++;
          continue;
        }
        legal++;
        const result = fight(compiled.skill, compiled.passives, 7, 2);
        assert.ok(['TEAM_A', 'TEAM_B', 'DRAW'].includes(result.winner));
        const used = result.logs.some(log => log.skillId === compiled.skill.id);
        assert.ok(used, `${compiled.skill.id} 整場都沒有被施放`);
      }
    }
  }
  console.log(`      組合掃描：合法 ${legal} 種、被條件或互斥擋下 ${rejected} 種（以集合計）`);
  assert.ok(legal > 0 && rejected > 0);
});

// ── 配置（loadout）：接到 Entity ─────────────────────────────

test('compileLoadout：多組寶石合併成 skills 與 passives，並保留各組編譯結果', () => {
  const loadout = compileLoadout([
    { active: 'magicmissile', supports: ['shock'] },
    { active: 'whirlwind', supports: ['leech'] },
    { active: 'mend' }
  ]);
  assert.deepEqual(loadout.skills.map(skill => skill.id), ['magicmissile+shock', 'whirlwind+leech', 'mend']);
  assert.equal(loadout.passives.length, 1);
  assert.equal(loadout.compiled.length, 3);
  assert.deepEqual(loadout.compiled[1].links, ['leech']);
});

test('compileLoadout：同一個技能 id 出現兩次會被拒絕；不合法的連結照常丟 GemLinkError', () => {
  assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: ['amp', 'heavy'] }, { active: 'magicmissile', supports: ['heavy', 'amp'] }]),
    error => error instanceof GemLinkError && error.gemId === 'magicmissile');
  assert.throws(() => compileLoadout([{ active: 'magicmissile', supports: ['heavy', 'lean'] }]), GemLinkError);
});

test('compileLoadout：每次呼叫都是全新的被動物件（不可跨場共用）', () => {
  const first = compileLoadout([{ active: 'whirlwind', supports: ['leech'] }]);
  const second = compileLoadout([{ active: 'whirlwind', supports: ['leech'] }]);
  assert.notEqual(first.passives[0], second.passives[0]);
});

test('整場戰鬥：汲取被動掛在 Entity 上，真的會在戰鬥中回血', () => {
  const run = seed => {
    const loadout = compileLoadout([{ active: 'whirlwind', supports: ['leech'] }]);
    const hero = new Entity({
      id: 'hero', name: '勇者', team: 'A',
      stats: { hp: 3000, sp: 200, atk: 200, def: 50, spd: 120, cri: 0.1, skillCastRate: 1 },
      normalAttack: plain, skills: loadout.skills, passives: loadout.passives
    });
    const foe = new Entity({
      id: 'foe', name: '木樁', team: 'B',
      stats: { hp: 4000, sp: 100, atk: 10, def: 50, spd: 60, cri: 0 }, normalAttack: plain
    });
    const original = Math.random;
    Math.random = createSeededRandom(seed);
    try { return new BattleEngine([hero], [foe]).start(); } finally { Math.random = original; }
  };
  const result = run(7);
  assert.ok(result.logs.some(log => log.type === 'HEAL' && log.skillId === 'whirlwind+leech'),
    '戰報裡應該出現汲取的回血紀錄');
  // 同一個種子重跑，結果一致（沒有殘留狀態）。
  assert.equal(run(7).logs.length, result.logs.length);
});

// ── 聚焦 ────────────────────────────────────────────────────

test('聚焦：全體改單體，傷害乘算 +80%（180%），並拿掉 aoe 標籤', () => {
  const result = compileSkill('whirlwind', ['focus']);
  assert.equal(result.skill.id, 'whirlwind+focus');
  assert.equal(result.damageFactor, 1.8);
  assert.equal(result.skill.actions[0].targetType, 'ENEMY_SINGLE');
  assert.equal(result.skill.actions[0].power, 1.62);         // 0.9 × 1.8
  assert.equal(result.skill.tags.includes('aoe'), false);
  assert.ok(result.skill.tags.includes('attack'));
  assert.deepEqual(describeSupport(SUPPORT_GEMS.focus).badges, ['乘算']);
});

test('聚焦：只能連結有全體傷害段的技能；與加算分區結算；可與汲取並存', () => {
  assert.throws(() => compileSkill('magicmissile', ['focus']), error => error instanceof GemLinkError && error.gemId === 'focus');
  const combo = compileSkill('whirlwind', ['amp', 'focus', 'leech']);
  // (1 + 0.2) × 1.8（汲取不再減傷害）
  assert.equal(combo.damageFactor, round(1.2 * 1.8));
  assert.equal(combo.passives.length, 1);
});

test('聚焦：真的只打一個敵人', () => {
  const { skill } = compileSkill('whirlwind', ['focus']);
  const hero = makeHero([skill]);
  const foes = [makeFoe('a'), makeFoe('b'), makeFoe('c')];
  skill.execute(hero, [hero], foes, logger(), null);
  assert.equal(foes.filter(foe => foe.stats.hp < 100000).length, 1);
});

test('標籤衝突：一顆加上、一顆移除同一個標籤，整組拒絕且雙方都被指出', () => {
  const active = {
    mix: { id: 'mix', name: '混合', tags: ['attack'], spCost: 5, actions: [
      { type: 'DAMAGE', targetType: 'ENEMY_SINGLE' }, { type: 'DAMAGE', targetType: 'ENEMY_ALL' }
    ] }
  };
  const gems = { wide: SUPPORT_GEMS.wide, focus: SUPPORT_GEMS.focus };
  // wide 要求技能原本沒有 aoe，mix 沒有，所以兩顆條件都過；wide 加 aoe、focus 移除 aoe → 衝突。
  for (const order of [['wide', 'focus'], ['focus', 'wide']]) {
    assert.throws(() => compileSkill('mix', order, { activeGems: active, supportGems: gems }),
      error => error instanceof GemLinkError && [error.gemId, error.conflictsWith].sort().join() === 'focus,wide');
  }
});

// ── 資料驗證：grant ─────────────────────────────────────────

test('grant 資料寫錯會被抓到：未知 kind、門檻不合理、同類門檻不一致、removeTags 不是陣列', () => {
  const grant = (id, effect, extra) => ({ id, name: id, addTags: [], effects: [effect], ...extra });
  const bad = {
    a: grant('a', { op: 'grant', kind: 'nope' }),
    b: grant('b', { op: 'grant', kind: 'lastResort', threshold: 1.5 }),
    c: grant('c', { op: 'grant', kind: 'lastResort', threshold: 0.5 }),
    d: grant('d', { op: 'grant', kind: 'lastResort', threshold: 0.3 }),
    e: grant('e', { op: 'grant', kind: 'opening' }, { removeTags: 'aoe' })
  };
  const problems = validateGemData(bad, GROUPS).join('\n');
  assert.match(problems, /未知的 kind「nope」/);
  assert.match(problems, /介於 0 與 1 之間/);
  assert.match(problems, /不一致/);
  assert.match(problems, /removeTags 必須是字串陣列/);
});

test('佈局與撒手鐧：說明文字依資料產生，門檻改了說明跟著改', () => {
  assert.match(describeSupport(SUPPORT_GEMS.layout).lines[0].text, /第一次行動必定施放/);
  assert.match(describeSupport(SUPPORT_GEMS.trump).lines[0].text, /50% 以下/);
  const custom = { ...SUPPORT_GEMS.trump, effects: [{ op: 'grant', kind: 'lastResort', threshold: 0.3 }] };
  assert.match(describeSupport(custom).lines[0].text, /30% 以下/);
});

// ── 佈局（opening）──────────────────────────────────────────

const stubEngine = () => ({
  result: null, inserted: [],
  canSummon: () => false, getCastableSkills: () => [], settleDeaths() {}, checkWinCondition() {},
  insertAction(entity, skill, options) { this.inserted.push({ entity, skill, options }); }
});

test('佈局：compileSkill 只給 grants 資料，被動由 compileLoadout 合併', () => {
  const single = compileSkill('magicmissile', ['layout']);
  assert.deepEqual(single.grants, [{ op: 'grant', kind: 'opening', text: '{caster}的第一動，' }]);
  assert.equal(single.passives.length, 0);
  const loadout = compileLoadout([
    { active: 'magicmissile', supports: ['layout'] },
    { active: 'whirlwind', supports: ['layout'] },
    { active: 'mend' }
  ]);
  assert.equal(loadout.passives.filter(passive => passive.trigger === 'BATTLE_START').length, 1);
  assert.deepEqual(buildGrantPassives([compileSkill('mend')]), []);
});

test('佈局：開場時把 openingSkill 設成其中一個付得起的技能', () => {
  const loadout = compileLoadout([
    { active: 'magicmissile', supports: ['layout'] },   // 10 SP
    { active: 'whirlwind', supports: ['layout'] }   // 12 SP
  ]);
  const [fire, whirl] = loadout.skills;
  const passive = loadout.passives[0];

  // SP 只夠火球：必定選火球，不會選付不起的旋風斬。
  const poor = makeHero(loadout.skills, loadout.passives, { sp: 11 });
  passive.action(poor, {}, logger(), stubEngine());
  assert.equal(poor.openingSkill.id, fire.id);   // 實際放出去的是加了開頭文字的複本，id 相同

  // 兩個都付得起：多次抽選兩邊都會出現，且都是這兩個之一。
  const seen = new Set();
  const original = Math.random;
  Math.random = createSeededRandom(11);
  try {
    for (let i = 0; i < 40; i++) {
      const rich = makeHero(loadout.skills, loadout.passives);
      passive.action(rich, {}, logger(), stubEngine());
      seen.add(rich.openingSkill.id);
    }
  } finally { Math.random = original; }
  assert.deepEqual([...seen].sort(), [fire.id, whirl.id].sort());

  // 都付不起：不動 openingSkill。
  const broke = makeHero(loadout.skills, loadout.passives, { sp: 1 });
  passive.action(broke, {}, logger(), stubEngine());
  assert.equal(broke.openingSkill, null);
});

test('佈局：整場戰鬥第一個行動槽必定是這個技能', () => {
  const run = seed => {
    const loadout = compileLoadout([
      { active: 'magicmissile', supports: ['layout'] },
      { active: 'mend' }
    ]);
    const hero = new Entity({
      id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
      stats: { hp: 3000, sp: 100, atk: 150, def: 50, spd: 120, cri: 0, skillCastRate: 0 } // 平常完全不放技能
    });
    const foe = makeFoe('dummy', { hp: 50000, spd: 1 });
    const engine = new BattleEngine([hero], [foe], { rng: createSeededRandom(seed) });
    engine.start();
    return engine.actionSlots.find(slot => slot.actor === hero);
  };
  for (const seed of [1, 2, 3]) assert.equal(run(seed).skill.id, 'magicmissile+layout');
});

// ── 撒手鐧（lastResort）─────────────────────────────────────

test('撒手鐧：HP 第一次降到門檻以下才插隊，之後不再觸發', () => {
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['trump'] }]);
  const engine = stubEngine();
  const hero = makeHero(loadout.skills, loadout.passives, { hp: 4000, maxHp: 4000 });
  const log = logger();

  hero.takeDamage(1000, log, { engine });          // 4000 → 3000（75%）
  assert.equal(engine.inserted.length, 0);
  hero.takeDamage(800, log, { engine });           // 2200（55%），仍高於 50%
  assert.equal(engine.inserted.length, 0);
  hero.takeDamage(400, log, { engine });           // 1800（45%）
  assert.equal(engine.inserted.length, 1);
  assert.equal(engine.inserted[0].skill.id, 'magicmissile+trump');
  hero.takeDamage(500, log, { engine });           // 已經觸發過
  assert.equal(engine.inserted.length, 1);
});

test('撒手鐧：SP 不足或被沉默的技能不會被選，全部不能用就作廢', () => {
  const loadout = compileLoadout([
    { active: 'magicmissile', supports: ['trump'] },    // 10 SP，法術
    { active: 'whirlwind', supports: ['trump'] }    // 12 SP
  ]);
  const passive = loadout.passives[0];

  // SP 只夠火球。
  const engine = stubEngine();
  const poor = makeHero(loadout.skills, loadout.passives, { sp: 11 });
  passive.action(poor, logger(), engine);
  assert.equal(engine.inserted.length, 1);
  assert.equal(engine.inserted[0].skill.id, 'magicmissile+trump');

  // 沉默法術：只剩旋風斬（技能被擋，普攻不擋）。
  const silenced = makeHero(loadout.skills, [], {});
  silenced.buffs.push(new Buff({ id: 'silence', name: '沉默', type: 'STAT', duration: 9, silence: true }));
  const engine2 = stubEngine();
  passive.action(silenced, logger(), engine2);
  assert.equal(engine2.inserted.length, 0); // 沉默擋住所有技能

  const engine3 = stubEngine();
  const broke = makeHero(loadout.skills, [], { sp: 1 });
  passive.action(broke, logger(), engine3);
  assert.equal(engine3.inserted.length, 0);
});

test('撒手鐧：只呼叫 skill.execute、沒有引擎時安靜略過', () => {
  const loadout = compileLoadout([{ active: 'whirlwind', supports: ['trump'] }]);
  const hero = makeHero(loadout.skills, loadout.passives, { hp: 4000, maxHp: 4000 });
  assert.doesNotThrow(() => hero.takeDamage(3000, logger(), {}));
});

test('撒手鐧：整場戰鬥中，HP 降到一半以下後馬上多出一個行動槽', () => {
  const loadout = compileLoadout([{ active: 'whirlwind', supports: ['trump'] }]);
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 1000, sp: 200, atk: 300, def: 50, spd: 60, cri: 0, skillCastRate: 0 }
  });
  const foe = new Entity({
    id: 'foe', name: '魔物', team: 'B', normalAttack: plain,
    stats: { hp: 100000, sp: 100, atk: 130, def: 50, spd: 200, cri: 0 }
  });
  const engine = new BattleEngine([hero], [foe], { rng: createSeededRandom(5), maxTurns: 12 });
  const result = engine.start();
  const extra = engine.actionSlots.filter(slot => slot.inserted && slot.actor === hero);
  assert.equal(extra.length, 1, '只會觸發一次');
  assert.equal(extra[0].skill.id, 'whirlwind+trump');
  assert.ok(extra[0].end > extra[0].start, '額外行動有自己的戰報');
  assert.equal(result.logs.filter(log => /拚死一搏，獲得額外的行動！/.test(log.message)).length, 1, '額外行動前印一行宣告');
});

test('佈局與撒手鐧可以同時存在：各自合併成一個被動', () => {
  const loadout = compileLoadout([
    { active: 'magicmissile', supports: ['layout', 'trump'] },
    { active: 'whirlwind', supports: ['layout', 'trump'] }
  ]);
  assert.equal(loadout.passives.length, 2);
  assert.deepEqual(loadout.passives.map(passive => passive.id).sort(), ['gem_lastResort', 'gem_opening']);
});

// ── 蓄力（charge）──────────────────────────────────────────

const chargeBattle = (loadout, { seed = 1, maxTurns = 20, heroStats = {}, foeStats = {}, heroBuffs = [], options = {} } = {}) => {
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives, buffs: heroBuffs,
    stats: { hp: 900000, sp: 400, atk: 200, def: 50, spd: 60 + seed % 120, cri: 0, skillCastRate: 0.6, ...heroStats }
  });
  const foe = new Entity({
    id: 'foe', name: '木樁', team: 'B', normalAttack: plain,
    stats: { hp: 900000, sp: 100, atk: 50, def: 50, spd: 140 - seed % 100, cri: 0, ...foeStats }
  });
  const engine = new BattleEngine([hero], [foe], { rng: createSeededRandom(seed), maxTurns, skillSelectionResolver: loadout.resolver, ...options });
  const result = engine.start();
  return { engine, result, hero, foe };
};

test('蓄力：外殼只扣 SP 並掛標記，本體保有全部動作、傷害 225%、不再扣 SP', () => {
  const result = compileSkill('magicmissile', ['charge']);
  assert.equal(result.skill.id, 'magicmissile+charge');
  assert.equal(result.release.id, 'magicmissile+charge#release');
  assert.equal(result.damageFactor, 2.25);
  assert.equal(result.spCost, 10);
  assert.deepEqual(result.skill.actions.map(action => action.type), ['BUFF']);
  assert.equal(result.skill.actions[0].spCost, 10);
  assert.equal(result.release.actions[0].power, 3.375);           // 1.5 × 2.25
  assert.equal(result.release.actions[0].spCost, undefined);
  assert.ok(result.skill.tags.includes('charge') && result.release.tags.includes('spell'));
  assert.deepEqual(describeSupport(SUPPORT_GEMS.charge).badges, ['乘算']);
});

test('蓄力：與其他寶石疊加（強力的 SP 與傷害、感電的追加段、汲取綁在本體上）', () => {
  const heavy = compileSkill('magicmissile', ['charge', 'heavy', 'shock']);
  assert.equal(heavy.spCost, 12);                                 // 10 × 1.2，只寫在外殼
  assert.equal(heavy.damageFactor, round(2.25 * 1.3));            // 感電不再減傷害
  assert.deepEqual(heavy.release.actions.map(action => action.type), ['DAMAGE', 'BUFF']);

  const leech = compileSkill('whirlwind', ['charge', 'leech']);
  const hero = makeHero([leech.skill]);
  const foe = makeFoe('a');
  const log = logger();
  const enemies = [foe];
  leech.release.execute(hero, [hero], enemies, log, null);
  assert.equal(leech.passives.length, 1);
  assert.equal(leech.passives[0].enabled(hero, { skill: leech.release }), true);
  assert.equal(leech.passives[0].enabled(hero, { skill: leech.skill }), false);
});

test('蓄力：resolver 把有標記的那一槽換成本體並移除標記；沒標記時不介入', () => {
  const result = compileSkill('magicmissile', ['charge']);
  const resolver = buildChargeResolver([result]);
  const hero = makeHero([result.skill]);
  assert.equal(resolver({ caster: hero }), undefined);
  hero.addBuff(result.skill.actions[0].buffs[0]);
  assert.equal(resolver({ caster: hero }), result.release);
  assert.equal(hero.buffs.length, 0);
  assert.equal(resolver({ caster: hero }), undefined);

  const mine = () => 'mine';
  assert.equal(combineResolvers(null, () => undefined, mine, () => 'late')({}), 'mine');
  assert.equal(combineResolvers(() => undefined)({}), undefined);
});

test('蓄力：compileLoadout 給出 resolver 與本體清單，skills 裡只有外殼', () => {
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['charge'] }, { active: 'mend' }]);
  assert.deepEqual(loadout.skills.map(skill => skill.id), ['magicmissile+charge', 'mend']);
  assert.deepEqual(loadout.releaseSkills.map(skill => skill.id), ['magicmissile+charge#release']);
  assert.equal(typeof loadout.resolver, 'function');
  assert.ok(loadout.passives.some(passive => passive.id === 'gem_charge_guard'));
  // 沒有蓄力時不掛檢查被動，resolver 也無害。
  const plainLoadout = compileLoadout([{ active: 'magicmissile', supports: ['heavy'] }]);
  assert.equal(plainLoadout.passives.some(passive => passive.id === 'gem_charge_guard'), false);
  assert.equal(plainLoadout.resolver({ caster: makeHero([]) }), undefined);
});

test('蓄力：整場戰鬥，每次釋放前一個勇者行動槽一定是蓄力，且釋放那一槽不會再多行動一次', () => {
  const loadout = () => compileLoadout([{ active: 'magicmissile', supports: ['charge'] }]);
  let releases = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { engine, hero } = chargeBattle(loadout(), { seed });
    const mine = engine.actionSlots.filter(slot => slot.actor === hero);
    mine.forEach((slot, index) => {
      if (slot.skill.id !== 'magicmissile+charge#release') return;
      releases++;
      assert.equal(mine[index - 1]?.skill.id, 'magicmissile+charge', `seed ${seed}：釋放前一槽應是蓄力`);
      const own = engine.logger.logs.slice(slot.start, slot.end).filter(log => log.actorId === 'hero' && ['DAMAGE', 'BUFF_APPLY'].includes(log.type));
      assert.ok(own.every(log => log.skillId === 'magicmissile+charge#release'), `seed ${seed}：釋放那一槽不該還有別的動作`);
    });
  }
  assert.ok(releases > 100, `應有大量釋放（實際 ${releases}）`);
});

test('蓄力：釋放的傷害確實約為一般魔法飛彈的 2.25 倍', () => {
  const average = (active, supports, pickSkillId) => {
    const damages = [];
    for (let seed = 1; seed <= 20; seed++) {
      const loadout = compileLoadout([{ active, supports }]);
      const { result } = chargeBattle(loadout, { seed, maxTurns: 10, heroStats: { skillCastRate: 1, cri: 0 } });
      for (const log of result.logs) if (log.type === 'DAMAGE' && log.actorId === 'hero' && log.skillId === pickSkillId) damages.push(log.value ?? log.damage);
    }
    return damages.reduce((sum, value) => sum + value, 0) / damages.length;
  };
  const normal = average('magicmissile', [], 'magicmissile');
  const charged = average('magicmissile', ['charge'], 'magicmissile+charge#release');
  assert.ok(Math.abs(charged / normal - 2.25) < 0.08, `倍率 ${charged / normal}`);
});

test('蓄力：被敵人暈眩的槽不會釋放，標記保留到下一個能行動的槽', () => {
  const result = compileSkill('magicmissile', ['charge']);
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['charge'] }]);
  const marker = loadout.compiled[0].skill.actions[0].buffs[0];
  const stun = { id: 'stun', name: '暈眩', type: 'STUN', duration: 2, message: () => '勇者被打暈了。' };
  const { engine, hero, result: battle } = chargeBattle(loadout, { seed: 3, maxTurns: 4, heroBuffs: [marker, stun], heroStats: { spd: 100 }, foeStats: { spd: 100 } });
  const mine = engine.actionSlots.filter(slot => slot.actor === hero);
  assert.equal(mine[0].skill.id, 'magicmissile+charge#release');
  const firstRelease = battle.logs.findIndex(log => log.skillId === 'magicmissile+charge#release');
  const firstStun = battle.logs.findIndex(log => /被打暈/.test(log.message));
  assert.ok(firstStun >= 0 && firstStun < firstRelease, '暈眩的槽在釋放之前');
  assert.equal(result.release.id, 'magicmissile+charge#release');
});

test('蓄力：沒傳 skillSelectionResolver 時開場就報錯，不會靜默失效', () => {
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['charge'] }]);
  assert.throws(() => chargeBattle(loadout, { options: { skillSelectionResolver: undefined } }), /skillSelectionResolver/);
});

test('蓄力：與佈局、撒手鐧並存時，外殼是被選中的那個技能', () => {
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['charge', 'layout', 'trump'] }]);
  const { engine, hero } = chargeBattle(loadout, { seed: 2, heroStats: { skillCastRate: 0 } });
  assert.equal(engine.actionSlots.find(slot => slot.actor === hero).skill.id, 'magicmissile+charge+layout+trump');
});

test('蓄力：wrap 資料寫錯會被抓到；只能連結有傷害段的技能', () => {
  const bad = { w: mkGem('w', [{ op: 'wrap', kind: 'teleport' }]) };
  assert.match(validateGemData(bad, GROUPS).join('\n'), /wrap 使用了未知的 kind「teleport」/);
  assert.throws(() => compileSkill('mend', ['charge']), error => error instanceof GemLinkError && error.gemId === 'charge');
});

// ── cost 寫成增量 ───────────────────────────────────────────

test('cost 是增量：0.2 代表 +20%、-0.4 代表 -40%，彼此相乘；小於等於 -1 會被資料驗證擋下', () => {
  assert.equal(compileSkill('magicmissile', ['heavy']).spCost, 12);          // 10 × 1.2
  assert.equal(compileSkill('magicmissile', ['lean']).spCost, 6);            // 10 × 0.6
  assert.equal(compileSkill('magicmissile', ['amp', 'heavy']).spCost, 12);   // 增幅沒有消耗變化
  assert.equal(compileSkill('whirlwind', ['heavy', 'leech']).spCost, 16);    // 12 × 1.2 × 1.1 = 15.84 → 16
  const bad = { free: mkGem('free', [{ op: 'cost', value: -1 }]), old: mkGem('old', [{ op: 'cost', value: 'x' }]) };
  assert.equal(validateGemData(bad, GROUPS).filter(text => /cost 需要大於 -1/.test(text)).length, 2);
});

// ── 施放條件（castCondition）────────────────────────────────

const condGems = {
  lowhp:  mkGem('lowhp',  [{ op: 'castCondition', of: 'selfHp', max: 0.5 }]),
  highhp: mkGem('highhp', [{ op: 'castCondition', of: 'selfHp', min: 0.8 }]),
  midhp:  mkGem('midhp',  [{ op: 'castCondition', of: 'selfHp', min: 0.3, max: 0.6 }]),
  crowd:  mkGem('crowd',  [{ op: 'castCondition', of: 'enemyCount', min: 2 }]),
  duel:   mkGem('duel',   [{ op: 'castCondition', of: 'enemyCount', max: 1 }]),
  boost:  mkGem('boost',  [{ op: 'more', value: 0.2 }])
};
const compileCond = (supports, active = 'magicmissile') => compileSkill(active, supports, { supportGems: condGems });

test('施放條件：說明文字依資料產生，kind 是 condition', () => {
  const text = id => describeSupport(condGems[id]).lines[0];
  assert.deepEqual(text('lowhp'), { kind: 'condition', text: '自身生命 50% 以下時才能施放' });
  assert.equal(text('highhp').text, '自身生命 80% 以上時才能施放');
  assert.equal(text('midhp').text, '自身生命 30% 以上且 60% 以下時才能施放');
  assert.equal(text('crowd').text, '存活敵人 至少 2 名時才能施放');
  assert.equal(text('duel').text, '存活敵人 至多 1 名時才能施放');
});

test('施放條件：沒有條件的技能仍是一般 Skill；有條件的才換成會判斷 canCast 的版本', () => {
  assert.deepEqual(compileCond(['boost']).conditions, {});
  assert.equal(compileCond(['boost']).skill.constructor, Skill);
  const result = compileCond(['lowhp']);
  assert.deepEqual(result.conditions, { selfHp: { max: 0.5 } });
  assert.ok(result.skill instanceof Skill);
});

test('施放條件：自身生命比例（含邊界）決定 canCast', () => {
  const skill = compileCond(['lowhp']).skill;
  const at = hp => makeHero([skill], [], { hp, maxHp: 1000 });
  assert.equal(skill.canCast(at(500), null), true);   // 剛好 50% 算成立
  assert.equal(skill.canCast(at(501), null), false);
  assert.equal(skill.canCast(at(100), null), true);
  // 條件之外的檢查照舊：SP 不夠仍然不能放。
  assert.equal(skill.canCast(makeHero([skill], [], { hp: 100, maxHp: 1000, sp: 1 }), null), false);
});

test('施放條件：敵人數量只算存活的；沒有引擎時視為成立', () => {
  const skill = compileCond(['crowd']).skill;
  const hero = makeHero([skill]);
  const a = makeFoe('a'), b = makeFoe('b');
  assert.equal(skill.canCast(hero, { teamA: [hero], teamB: [a] }), false);
  assert.equal(skill.canCast(hero, { teamA: [hero], teamB: [a, b] }), true);
  b.isAlive = false;
  assert.equal(skill.canCast(hero, { teamA: [hero], teamB: [a, b] }), false);
  assert.equal(skill.canCast(hero, null), true);
});

test('施放條件：多顆寶石全部都要成立，取最嚴格的上下界，與連結順序無關', () => {
  const a = compileCond(['lowhp', 'midhp']);
  const b = compileCond(['midhp', 'lowhp']);
  assert.deepEqual(a.conditions, { selfHp: { min: 0.3, max: 0.5 } });
  assert.deepEqual(a.conditions, b.conditions);
  assert.equal(a.skill.id, b.skill.id);
  assert.deepEqual(compileCond(['crowd', 'lowhp']).conditions, { selfHp: { max: 0.5 }, enemyCount: { min: 2 } });
});

test('施放條件：合起來不可能成立就整組拒絕，雙方都被指出且與順序無關', () => {
  for (const [x, y] of [['lowhp', 'highhp'], ['crowd', 'duel']]) {
    for (const order of [[x, y], [y, x]]) {
      assert.throws(() => compileCond(order),
        error => error instanceof GemLinkError && [error.gemId, error.conflictsWith].sort().join() === [x, y].sort().join());
    }
  }
  assert.doesNotThrow(() => compileCond(['lowhp', 'midhp', 'boost']));
});

test('施放條件：資料驗證抓出未知的量、缺上下界、不合理的數值', () => {
  const bad = {
    a: mkGem('a', [{ op: 'castCondition', of: 'mood', max: 1 }]),
    b: mkGem('b', [{ op: 'castCondition', of: 'selfHp' }]),
    c: mkGem('c', [{ op: 'castCondition', of: 'selfHp', max: 50 }]),
    d: mkGem('d', [{ op: 'castCondition', of: 'enemyCount', min: 1.5 }]),
    e: mkGem('e', [{ op: 'castCondition', of: 'selfHp', min: 0.8, max: 0.2 }])
  };
  const problems = validateGemData(bad, GROUPS).join('\n');
  assert.match(problems, /未知的 of「mood」/);
  assert.match(problems, /需要 min 或 max/);
  assert.match(problems, /需要 0～1 的比例/);
  assert.match(problems, /不小於 0 的整數/);
  assert.match(problems, /永遠不會成立/);
});

test('施放條件：整場戰鬥，技能只在條件成立時被抽到，其他時候用別的技能或普攻', () => {
  const heroHpAtCast = [];
  const run = (supports, foeCount, seed) => {
    const loadout = compileLoadout([{ active: 'magicmissile', supports }], { supportGems: condGems });
    const record = { trigger: 'AFTER_ACTION', action(self, a) { if (a.actor === self && a.skill.id.startsWith('magicmissile')) heroHpAtCast.push(self.stats.hp / self.stats.maxHp); } };
    const hero = new Entity({
      id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: [...loadout.passives, record],
      stats: { hp: 6000, sp: 1000, atk: 150, def: 50, spd: 100, cri: 0, skillCastRate: 1 }
    });
    const foes = Array.from({ length: foeCount }, (_, i) => new Entity({
      id: `foe${i}`, name: `魔物${i}`, team: 'B', normalAttack: plain, stats: { hp: 20000, sp: 100, atk: 330, def: 50, spd: 80, cri: 0 }
    }));
    const engine = new BattleEngine([hero], foes, { rng: createSeededRandom(seed), maxTurns: 25 });
    engine.start();
    return engine.actionSlots.filter(slot => slot.actor === hero && slot.skill.id.startsWith('magicmissile')).length;
  };
  let casts = 0;
  for (let seed = 1; seed <= 15; seed++) casts += run(['lowhp'], 1, seed);
  assert.ok(casts > 0, '血量夠低時會放');
  assert.ok(heroHpAtCast.every(ratio => ratio <= 0.5 + 1e-9), `放招時血量都在 50% 以下：${Math.max(...heroHpAtCast)}`);
  // 1 對 1 時，要求至少 2 名敵人的技能完全不會被抽到；2 名敵人時會。
  let solo = 0, pair = 0;
  for (let seed = 1; seed <= 10; seed++) { solo += run(['crowd'], 1, seed); pair += run(['crowd'], 2, seed); }
  assert.equal(solo, 0);
  assert.ok(pair > 0);
});

test('施放條件：與佈局、蓄力、撒手鐧並存（不成立時佈局與撒手鐧都不會選它；已掛標記的蓄力照常釋放）', () => {
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['layout', 'trump', 'lowhp'] }], { supportGems: { ...SUPPORT_GEMS, ...condGems } });
  const hero = makeHero(loadout.skills, loadout.passives, { hp: 4000, maxHp: 4000 });   // 滿血，條件不成立
  const [opening, lastResort] = [loadout.passives.find(p => p.id === 'gem_opening'), loadout.passives.find(p => p.id === 'gem_lastResort')];
  opening.action(hero, {}, logger(), stubEngine());
  assert.equal(hero.openingSkill, null);
  const engine = stubEngine();
  lastResort.action(hero, logger(), engine);
  assert.equal(engine.inserted.length, 0);
  // 血量降到條件內，兩者才會選到它。
  hero.stats.hp = 1500;
  opening.action(hero, {}, logger(), stubEngine());
  assert.equal(hero.openingSkill?.id, loadout.skills[0].id);
  lastResort.action(hero, logger(), engine);
  assert.equal(engine.inserted.length, 1);

  // 蓄力：標記掛上後，釋放不再看條件。
  const charge = compileSkill('magicmissile', ['charge', 'lowhp'], { supportGems: { ...SUPPORT_GEMS, ...condGems } });
  const resolver = buildChargeResolver([charge]);
  const healthy = makeHero([charge.skill], [], { hp: 4000, maxHp: 4000 });
  healthy.addBuff(charge.skill.actions[0].buffs[0]);
  assert.equal(resolver({ caster: healthy }), charge.release);
});

// ── 機率附加效果（proc）─────────────────────────────────────

const procBuff = (id, name) => ({ id, name, type: 'STAT', polarity: 'negative', duration: 3, stackPolicy: 'refresh', dispellable: true });
const procGem = (id, per, chance, extra = {}) => mkGem(id, [{
  op: 'proc', per, chance, buff: procBuff(id, id), summary: `${id} 效果`, ...extra
}]);
const procGems = {
  chill: procGem('chill', 'hit', 0.3),          // 每一擊各擲一次
  freeze: procGem('freeze', 'target', 0.3),     // 每個目標整招只擲一次
  sure: procGem('sure', 'target', 1),
  sureHit: procGem('sureHit', 'hit', 1, { message: '{caster} 的 {skill} 讓 {target} 中招了！' })
};
const multiActive = {
  multi: { id: 'multi', name: '三連斬', tags: ['attack'], spCost: 0, actions: [{ type: 'DAMAGE', targetType: 'ENEMY_SINGLE', power: 0.5, hits: 3 }] },
  sweep: { id: 'sweep', name: '橫掃', tags: ['attack', 'aoe'], spCost: 0, actions: [{ type: 'DAMAGE', targetType: 'ENEMY_ALL', power: 0.5 }] }
};
const compileProc = (supports, active = 'multi') => compileSkill(active, supports, { activeGems: multiActive, supportGems: procGems });

// 對一個血量夠多的目標施放 trials 次，回傳「這次施放後目標身上有 buff」的比例。
const procRate = (supports, buffId, trials = 3000, seed = 21) => {
  const original = Math.random;
  Math.random = createSeededRandom(seed);
  let applied = 0;
  try {
    for (let i = 0; i < trials; i++) {
      const { skill, passives } = compileProc(supports);
      const hero = makeHero([skill], passives, { luk: 0 });
      const foe = makeFoe('dummy', { hp: 1e9 });
      skill.execute(hero, [hero], [foe], logger(), null);
      if (foe.buffs.some(buff => buff.id === buffId)) applied++;
    }
  } finally { Math.random = original; }
  return applied / trials;
};

test('機率附加：說明文字依 per 與 chance 產生，kind 是 proc', () => {
  assert.deepEqual(describeSupport(procGems.chill).lines[0], { kind: 'proc', text: '每一擊有 30% 機率：chill 效果' });
  assert.equal(describeSupport(procGems.freeze).lines[0].text, '每個被打中的敵人有 30% 機率：freeze 效果');
});

test('機率附加：粒度由寶石決定，編譯成不同的被動；多顆互相獨立', () => {
  const hit = compileProc(['chill']);
  const target = compileProc(['freeze']);
  assert.equal(hit.passives[0].trigger, 'AFTER_DAMAGE_DEALT');
  assert.equal(target.passives[0].trigger, 'AFTER_ATTACK_DEALT');
  assert.equal(hit.skill.actions.length, 1, '技能本身的動作不變');
  const both = compileProc(['chill', 'freeze']);
  assert.deepEqual(both.passives.map(passive => passive.trigger).sort(), ['AFTER_ATTACK_DEALT', 'AFTER_DAMAGE_DEALT']);
  assert.equal(compileProc(['freeze', 'chill']).skill.id, both.skill.id);
});

test('機率附加：每一擊各擲一次 vs 每個目標一次，機率符合預期（三段攻擊、30%）', () => {
  const landed = procRate(['sure'], 'sure');                  // 整招至少打到一次的機率 L
  const h = 1 - Math.pow(1 - landed, 1 / 3);                  // 反推單擊命中率
  const perTarget = procRate(['freeze'], 'freeze');
  const perHit = procRate(['chill'], 'chill');
  assert.ok(Math.abs(perTarget - 0.3 * landed) < 0.035, `每目標一次：${perTarget} vs ${0.3 * landed}`);
  const expectedHit = 1 - Math.pow(1 - 0.3 * h, 3);
  assert.ok(Math.abs(perHit - expectedHit) < 0.035, `每擊一次：${perHit} vs ${expectedHit}`);
  assert.ok(perHit > perTarget + 0.15, '段數越多，逐擊的整招觸發率越高');
});

test('機率附加：全體技能對每個被打中的目標各自判定；打不死的目標才會被附加', () => {
  const { skill, passives } = compileProc(['sure'], 'sweep');
  const hero = makeHero([skill], passives);
  const foes = [makeFoe('a'), makeFoe('b'), makeFoe('c')];
  skill.execute(hero, [hero], foes, logger(), null);
  assert.ok(foes.filter(foe => foe.buffs.some(buff => buff.id === 'sure')).length >= 2);

  // 一擊就倒下的目標不會被附加（逐擊與整招兩種粒度都一樣）。
  for (const gem of ['sure', 'sureHit']) {
    const result = compileProc([gem]);
    const killer = makeHero([result.skill], result.passives, { atk: 99999 });
    const weak = makeFoe('weak', { hp: 1 });
    const log = logger();
    result.skill.execute(killer, [killer], [weak], log, null);
    assert.equal(weak.isAlive, false);
    assert.equal(weak.buffs.length, 0);
    assert.equal(log.logs.some(entry => entry.type === 'BUFF_APPLY'), false);
  }
});

test('機率附加：戰報句子可以自訂（{caster} {target} {skill}），沒寫時用預設句', () => {
  const custom = compileProc(['sureHit']);
  const hero = makeHero([custom.skill], custom.passives);
  const log = logger();
  custom.skill.execute(hero, [hero], [makeFoe('木樁', { hp: 1e9 })], log, null);
  assert.ok(log.logs.some(entry => entry.type === 'BUFF_APPLY' && /勇者 的 三連斬 讓 木樁 中招了！/.test(entry.message)));

  const fallback = compileProc(['sure']);
  const hero2 = makeHero([fallback.skill], fallback.passives);
  const log2 = logger();
  const target = makeFoe('木樁', { hp: 1e9 });
  fallback.skill.execute(hero2, [hero2], [target], log2, null);
  const line = log2.logs.find(entry => entry.type === 'BUFF_APPLY');
  assert.equal(line.message, '勇者 使 木樁 陷入「sure」！');
  assert.equal(line.skillId, fallback.skill.id);
});

test('機率附加：資料驗證抓出 per、chance、summary、Buff 設定的錯誤', () => {
  const bad = {
    a: mkGem('a', [{ op: 'proc', per: 'swing', chance: 0.3, buff: procBuff('a', 'a'), summary: 'x' }]),
    b: mkGem('b', [{ op: 'proc', per: 'hit', chance: 0, buff: procBuff('b', 'b'), summary: 'x' }]),
    c: mkGem('c', [{ op: 'proc', per: 'hit', chance: 1.5, buff: procBuff('c', 'c'), summary: 'x' }]),
    d: mkGem('d', [{ op: 'proc', per: 'hit', chance: 0.3, buff: procBuff('d', 'd') }]),
    e: mkGem('e', [{ op: 'proc', per: 'hit', chance: 0.3, buff: { id: 'e', name: 'e', type: 'STUN', duration: 1, chance: 5 }, summary: 'x' }])
  };
  const problems = validateGemData(bad, GROUPS).join('\n');
  assert.match(problems, /per 是 'hit' 或 'target'/);
  assert.equal((problems.match(/需要 0 到 1 之間/g) || []).length, 2);
  assert.match(problems, /需要 summary/);
  assert.match(problems, /不是合法的 Buff 設定/);
});

test('機率附加：連結蓄力時，被動綁在本體（實際造成傷害的技能）上', () => {
  const result = compileSkill('multi', ['sure', 'charge'], { activeGems: multiActive, supportGems: { ...SUPPORT_GEMS, ...procGems } });
  const hero = makeHero([result.skill], result.passives);
  const passive = result.passives[0];
  assert.equal(passive.enabled(hero, { skill: result.release }), true);
  assert.equal(passive.enabled(hero, { skill: result.skill }), false);
});

test('機率附加：整場戰鬥中被動確實掛在 Entity 上並產生戰報與 Buff', () => {
  const loadout = compileLoadout([{ active: 'multi', supports: ['sureHit'] }], { activeGems: multiActive, supportGems: procGems });
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 9000, sp: 100, atk: 150, def: 50, spd: 100, cri: 0, skillCastRate: 1 }
  });
  const foe = makeFoe('foe', { hp: 9e8, spd: 50 });
  const engine = new BattleEngine([hero], [foe], { rng: createSeededRandom(4), maxTurns: 6 });
  const result = engine.start();
  assert.ok(result.logs.some(log => log.type === 'BUFF_APPLY' && log.skillId === 'multi+sureHit' && /中招了/.test(log.message)));
});

// ── 佈局、撒手鐧的額外文字 ───────────────────────────────────

const heroLines = result => result.logs.filter(log => log.actorId === 'hero' && log.message).map(log => log.message);
const openingBattle = (active, supports, { foes = 1, seed = 3, maxTurns = 3, heroStats = {} } = {}) => {
  const loadout = compileLoadout([{ active, supports }]);
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 99999, sp: 400, atk: 150, def: 50, spd: 200, cri: 0, skillCastRate: 0, ...heroStats }   // 平常完全不放技能，只有佈局那一次
  });
  const enemies = Array.from({ length: foes }, (_, i) => makeFoe(`foe${i}`, { hp: 1e9, spd: 1 }));
  const engine = new BattleEngine([hero], enemies, { rng: createSeededRandom(seed), maxTurns, skillSelectionResolver: loadout.resolver });
  return { engine, result: engine.start() };
};

test('額外文字：佈局的第一次行動戰報帶有開頭，並拿掉重複的施放者名字；之後不再出現', () => {
  const { result } = openingBattle('magicmissile', ['layout']);
  const lines = heroLines(result);
  assert.ok(lines[0].startsWith('勇者的第一動，詠唱魔法飛彈，對 foe0'), lines[0]);
  assert.equal(lines.filter(line => line.includes('第一動')).length, 1, '整場只有第一次行動帶開頭');
  assert.ok(lines.slice(1).every(line => /^(勇者 攻擊|第 \d+ 擊)/.test(line)), '之後只剩普攻（施放率 0；連擊的後續擊數也算普攻）');
});

test('額外文字：全體攻擊整次施放只出現一次，不會每個目標都重複', () => {
  const { result } = openingBattle('whirlwind', ['layout'], { foes: 3 });
  const lines = heroLines(result);
  assert.equal(lines.filter(line => line.includes('第一動')).length, 1);
  assert.equal(lines.filter(line => line.includes('揮出旋風斬')).length, 3, '三個目標各一行，只有第一行帶開頭');
});

test('額外文字：佈局複本與原技能 id 相同、原技能的戰報不受影響；汲取仍照常觸發', () => {
  const loadout = compileLoadout([{ active: 'whirlwind', supports: ['layout', 'leech'] }]);
  const original = loadout.skills[0];
  const hero = makeHero(loadout.skills, loadout.passives);
  const engine = stubEngine();
  loadout.passives.find(passive => passive.id === 'gem_opening').action(hero, {}, logger(), engine);
  assert.equal(hero.openingSkill.id, original.id);
  assert.notEqual(hero.openingSkill, original);
  assert.ok(hero.openingSkill instanceof Skill);

  const plainLog = logger();
  original.execute(hero, [hero], [makeFoe('a')], plainLog, null);
  assert.ok(plainLog.logs.every(entry => !/第一動/.test(entry.message || '')), '平常施放沒有開頭');

  const { result } = openingBattle('whirlwind', ['layout', 'leech'], { heroStats: { hp: 50000, maxHp: 99999 } });   // 要缺血才補得到
  assert.ok(result.logs.some(log => log.type === 'HEAL' && log.skillId === 'whirlwind+layout+leech'), '佈局那一次也會汲取');
});

test('額外文字：蓄力外殼配佈局，第一次行動的戰報帶開頭', () => {
  const { result } = openingBattle('magicmissile', ['layout', 'charge']);
  assert.equal(heroLines(result)[0], '勇者的第一動，開始蓄力 魔法飛彈！');
});

test('撒手鐧：額外行動前印出「拚死一搏，獲得額外的行動！」，技能本身的戰報不加開頭', () => {
  const loadout = compileLoadout([{ active: 'whirlwind', supports: ['trump'] }]);
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain, skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 1000, sp: 200, atk: 300, def: 50, spd: 60, cri: 0, skillCastRate: 0 }
  });
  const foe = new Entity({ id: 'foe', name: '魔物', team: 'B', normalAttack: plain, stats: { hp: 1e8, sp: 100, atk: 130, def: 50, spd: 200, cri: 0 } });
  const engine = new BattleEngine([hero], [foe], { rng: createSeededRandom(5), maxTurns: 12 });
  const lines = heroLines(engine.start());
  const at = lines.findIndex(line => line === '勇者 拚死一搏，獲得額外的行動！');
  assert.ok(at >= 0, '宣告有出現');
  assert.ok(lines[at + 1].startsWith('勇者 揮出旋風斬，對 魔物'), lines[at + 1]);
  assert.equal(lines.some(line => /感受到危機/.test(line)), false, '撒手鐧沒有額外開頭文字');
  assert.equal(lines.filter(line => /拚死一搏/.test(line)).length, 1);
  assert.equal(SUPPORT_GEMS.trump.effects[0].text, undefined);
});

test('額外文字：沒有寫 text 的 grant 不產生複本；text 不是字串會被資料驗證擋下', () => {
  const noText = { silent: { id: 'silent', name: 'silent', addTags: [], effects: [{ op: 'grant', kind: 'opening' }] } };
  const result = compileSkill('magicmissile', ['silent'], { supportGems: noText });
  const [passive] = buildGrantPassives([result]);
  const hero = makeHero([result.skill]);
  passive.action(hero, {}, logger(), stubEngine());
  assert.equal(hero.openingSkill, result.skill, '沒有 text 時直接用原技能');
  const bad = { bad: { id: 'bad', name: 'bad', addTags: [], effects: [{ op: 'grant', kind: 'opening', text: 5 }] } };
  assert.match(validateGemData(bad, GROUPS).join('\n'), /grant text 必須是字串/);
});

test('主動寶石的 id 必須與登錄的鍵一致（技能 id 是用鍵組出來的）', () => {
  const broken = { fireball: { ...ACTIVE_GEMS.magicmissile, id: 'magicmissile' } };
  assert.throws(() => compileSkill('fireball', [], { activeGems: broken }), /與登錄的鍵不一致/);
  for (const [key, gem] of Object.entries(ACTIVE_GEMS)) assert.equal(gem.id, key);
});
