const { test } = require('node:test');
const assert = require('node:assert/strict');
const { strength, scaleMonster, HIT_PER_LEVEL, DEF_PER_LEVEL, DIFFICULTY_SCALE } = require('./difficulty');

test('strength grows 15.3% per level from 1.07 at difficulty 1', () => {
  assert.deepEqual(DIFFICULTY_SCALE, { base: 1.07, growth: 1.153 });
  assert.ok(Math.abs(strength(1) - 1.07) < 1e-12);
  assert.ok(Math.abs(strength(15) - 1.07 * 1.153 ** 14) < 1e-12);
  for (let d = 2; d <= 15; d++) assert.ok(strength(d) > strength(d - 1));
  assert.ok(strength(15) > 7.7 && strength(15) < 8);
  for (const bad of [0, 1000, 2.5, '3']) assert.throws(() => strength(bad), /難度/);
  // Boss 挑戰難度（2026-11-22）：超過 15 照公式延伸，999 是技術上限
  assert.ok(Math.abs(strength(20) - 1.07 * 1.153 ** 19) < 1e-9);
  assert.ok(Number.isFinite(strength(999)));
});

test('scaleMonster multiplies hp, atk, int; adds hit and def; leaves spd, sp, eva, cri alone', () => {
  const base = { hp: 3000, maxHp: 3000, atk: 90, int: 80, def: 50, spd: 90, sp: 200, eva: 30, cri: 0.05 };
  const scaled = scaleMonster(base, 15);
  const m = strength(15);
  assert.equal(scaled.hp, Math.round(3000 * m));
  assert.equal(scaled.maxHp, scaled.hp);
  assert.equal(scaled.atk, Math.round(90 * m));
  assert.equal(scaled.int, Math.round(80 * m));
  assert.equal(scaled.hit, HIT_PER_LEVEL * 14);
  assert.equal(DEF_PER_LEVEL, 18);
  assert.equal(scaled.def, 50 + DEF_PER_LEVEL * 14);                 // 防禦用加法：50 → 302
  assert.equal(scaleMonster(base, 1).def, 50);                         // 難度 1 不加防禦
  for (const key of ['spd', 'sp', 'eva', 'cri']) assert.equal(scaled[key], base[key], key);
  assert.equal(base.hp, 3000);                                        // 不改傳入的
  assert.equal(scaleMonster({ hp: 100, hit: 5 }, 1).hit, 5);          // 難度 1 不加命中
  assert.equal(scaleMonster({ hp: 100 }, 3).maxHp, Math.round(100 * strength(3)));
  assert.equal(scaleMonster({ hp: 100 }, 3).int, undefined);           // 沒有的屬性不補
  assert.equal(scaleMonster({ hp: 100 }, 3).def, undefined);
});
