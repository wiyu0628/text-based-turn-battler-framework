const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TIER_WEIGHTS, dropRates, rollDrops } = require('./dropTable');
const { ENGRAVING_TYPES } = require('./affixTable');
const { SUPPORT_GEMS } = require('./gems');
const save = require('./saveLayer');
const { createSeededRandom } = require('../src');

const DIFFS = Array.from({ length: 15 }, (_, i) => i + 1);
const maxTier = d => TIER_WEIGHTS[d].findLastIndex(w => w > 0) + 1;
const scripted = (...values) => () => (values.length ? values.shift() : 0.999);

// ── 資料表 ────────────────────────────────────────────────

test('every tier row sums to 100 and every count distribution sums to 1', () => {
  for (const d of DIFFS) {
    assert.equal(TIER_WEIGHTS[d].reduce((a, b) => a + b, 0), 100, `difficulty ${d}`);
    const { count } = dropRates(d);
    assert.ok(Math.abs(count[1] + count[2] + count[3] - 1) < 1e-9);
    assert.ok(count[1] > 0 && count[2] >= 0 && count[3] >= 0);
  }
});

test('tier unlocks follow 1-2 / 3-6 / 7-9 / 10-12 / 13-15, with a 3% preview at 6, 9 and 12', () => {
  const expected = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 4, 10: 4, 11: 4, 12: 5, 13: 5, 14: 5, 15: 5 };
  for (const d of DIFFS) assert.equal(maxTier(d), expected[d], `difficulty ${d}`);
  assert.equal(TIER_WEIGHTS[6][2], 3);
  assert.equal(TIER_WEIGHTS[9][3], 3);
  assert.equal(TIER_WEIGHTS[12][4], 3);
  assert.deepEqual(TIER_WEIGHTS[2], [100, 0, 0, 0, 0]);   // 難度 1、2 不可能掉第 2 階以上
});

test('three engravings only from difficulty 13; legendary goes 0.5% → 4%; gem 13% (2026-11-21)', () => {
  assert.equal(dropRates(12).count[3], 0);
  assert.ok(dropRates(13).count[3] > 0);
  assert.equal(dropRates(15).count[3], 0.24);
  assert.equal(dropRates(15).count[2], 0.51);
  assert.equal(dropRates(1).count[2], 0.3);
  assert.equal(dropRates(1).legendary, 0.005);
  assert.equal(dropRates(15).legendary, 0.04);
  for (const d of DIFFS) assert.equal(dropRates(d).gem, 0.13);
});

test('輔助寶石掉率（2026-11-21）：一般 13%，有稀有怪 100%，有菁英怪 75%', () => {
  const { GEM_CHANCE_RARE, GEM_CHANCE_ELITE } = require('./dropTable');
  assert.deepEqual([GEM_CHANCE_RARE, GEM_CHANCE_ELITE], [1, 0.75]);
  // 亂數順序：數量、（每個刻印：階級、種類）、寶石；1 個刻印時寶石是第 4 個
  const at = (r, opts) => { const seq = [0, 0, 0, r, 0, 0, 0, 0, 0, 0]; let i = 0; return rollDrops(1, () => seq[i++] ?? 0, opts).supportGems.length; };
  assert.equal(at(0.12), 1);
  assert.equal(at(0.14), 0);
  assert.equal(at(0.74, { elite: true }), 1);
  assert.equal(at(0.76, { elite: true }), 0);
  assert.equal(at(0.9999, { rare: true }), 1);
});

test('bad difficulty is rejected', () => {
  for (const bad of [0, 16, 1.5, '3', undefined]) assert.throws(() => rollDrops(bad), /難度/);
});

// ── 擲骰 ──────────────────────────────────────────────────

test('rng order: count, then tier and type per engraving, then gem (and which), then legendary', () => {
  // 難度 15：count r=0.95 → 3 個；階級 0/0.3/0.99 → 3/4/5 階；種類 0 → 第一種、0.99 → 最後一種
  const drops = rollDrops(15, scripted(0.95, 0, 0, 0.3, 0.5, 0.99, 0.99, 0.1, 0.99, 0.01));
  const types = Object.keys(ENGRAVING_TYPES).filter(id => (ENGRAVING_TYPES[id].area ?? 1) === 1);
  assert.deepEqual(drops.engravings, [{ type: types[0], tier: 3 }, { type: types[Math.floor(0.5 * types.length)], tier: 4 }, { type: types.at(-1), tier: 5 }]);
  assert.deepEqual(drops.supportGems, [Object.keys(SUPPORT_GEMS).at(-1)]);
  assert.equal(drops.legendary, 1);
});

test('rng returning 1 never picks a zero-weight tier', () => {
  const drops = rollDrops(2, () => 0.9999999);
  assert.ok(drops.engravings.every(e => e.tier === 1));
});

test('low difficulty never drops above its tier; distributions match the table', () => {
  const rng = createSeededRandom(42);
  const n = 40000;
  for (const d of [1, 6, 15]) {
    const rates = dropRates(d);
    const tiers = [0, 0, 0, 0, 0];
    let engr = 0, gems = 0, legend = 0, three = 0;
    for (let i = 0; i < n; i++) {
      const drops = rollDrops(d, rng);
      engr += drops.engravings.length;
      if (drops.engravings.length === 3) three++;
      for (const e of drops.engravings) tiers[e.tier - 1]++;
      gems += drops.supportGems.length;
      legend += drops.legendary;
    }
    rates.tiers.forEach((p, i) => {
      if (p === 0) assert.equal(tiers[i], 0, `d${d} tier ${i + 1}`);
      else assert.ok(Math.abs(tiers[i] / engr - p) < 0.012, `d${d} tier ${i + 1}: ${tiers[i] / engr} vs ${p}`);
    });
    assert.ok(Math.abs(engr / n - (rates.count[1] + 2 * rates.count[2] + 3 * rates.count[3])) < 0.02);
    assert.ok(Math.abs(three / n - rates.count[3]) < 0.006);
    assert.ok(Math.abs(gems / n - 0.13) < 0.012);
    assert.ok(Math.abs(legend / n - rates.legendary) < 0.004);
  }
});

// ── 存檔層：grantDrops ─────────────────────────────────────

test('grantDrops adds engravings and gems to the bag and leaves the old save untouched', () => {
  const start = save.addEngraving(save.createEmptySave({ now: '2026-01-01T00:00:00Z' }), 'fury', 1, 1);
  const next = save.grantDrops(start, { engravings: [{ type: 'fury', tier: 1 }, { type: 'vital', tier: 3 }], supportGems: ['amp'], legendary: 0 });
  assert.deepEqual(next.engravings, { 'fury@1': 2, 'vital@3': 1 });
  assert.deepEqual(next.gems, { amp: 1 });
  assert.deepEqual(start.engravings, { 'fury@1': 1 });
  assert.throws(() => save.grantDrops(start, { engravings: [], supportGems: ['nope'] }), save.SaveError);
  assert.throws(() => save.grantDrops(start, { engravings: [{ type: 'fury', tier: 9 }] }), save.SaveError);
  assert.throws(() => save.grantDrops(start, null), save.SaveError);
});

const LEGENDARY_IDS = require('./legendaryTable').LEGENDARIES;
test('grantDrops adds legendary items scaled by difficulty, and refuses legendary drops without a difficulty', () => {
  const start = save.createEmptySave({ now: '2026-01-01T00:00:00Z' });
  assert.throws(() => save.grantDrops(start, { engravings: [], supportGems: [], legendary: 1 }), /difficulty/);
  const next = save.grantDrops(start, { engravings: [], supportGems: [], legendary: 2 }, { difficulty: 15, rng: () => 0.9999999 });
  assert.equal(next.equipment.length, 2);
  assert.ok(next.equipment.every(item => item.origin === 'drop' && Object.hasOwn(LEGENDARY_IDS, item.legendaryId) && item.links.length === 0));
  assert.notEqual(next.equipment[0].id, next.equipment[1].id);
  assert.equal(start.equipment.length, 0);
});
