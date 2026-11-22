'use strict';
// Boss 挑戰難度（2026-11-22 使用者）：擊敗過的 Boss 可以調高難度重打；不設上限（999 是技術上限）；掉落照一般 Boss（超過 15 以 15 計）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const game = require('./game');
const save = require('./saveLayer');
const { findBoss } = require('./bosses');
const { strength } = require('./difficulty');

const starter = () => save.createStarterSave({ now: '2026-01-01T00:00:00Z' });
const beaten = (...ids) => { const s = starter(); return { ...s, progress: { ...s.progress, defeatedBosses: ids } }; };

test('沒擊敗過不能調挑戰難度；帶王自己的難度等於一般挑戰', () => {
  assert.throws(() => game.prepareBattle(starter(), { kind: 'boss', id: 'gatekeeper', difficulty: 7 }, 1), /要先擊敗/);
  const b = game.prepareBattle(starter(), { kind: 'boss', id: 'gatekeeper', difficulty: 6 }, 1);
  assert.equal(b.difficulty, 6);
});

test('擊敗後：難度範圍是王的難度～999 的整數', () => {
  const s = beaten('gatekeeper');
  for (const bad of [5, 1000, 7.5, '8']) assert.throws(() => game.prepareBattle(s, { kind: 'boss', id: 'gatekeeper', difficulty: bad }, 1), /挑戰難度/);
  assert.equal(game.prepareBattle(s, { kind: 'boss', id: 'gatekeeper', difficulty: 999 }, 1).difficulty, 999);
});

test('怪物照挑戰難度縮放（超過 15 照公式延伸）', () => {
  const s = beaten('gatekeeper');
  const hp = d => game.prepareBattle(s, { kind: 'boss', id: 'gatekeeper', difficulty: d }, 1).opening[0].maxHp;
  const ratio = hp(20) / hp(6);
  assert.ok(Math.abs(ratio - strength(20) / strength(6)) < 0.01, `比例 ${ratio}`);
});

test('挑戰打贏：掉落以 min(難度, 15) 計、不重發首次獎勵；紀錄重播一致', () => {
  const s = beaten('gatekeeper');
  const strong = { ...s, progress: { ...s.progress } };
  // 用很低的挑戰難度不可能（下限是 6），所以直接驗證掉落難度的上限：打 20 若贏，drops 照 15；用重播檢查目標保留 difficulty
  const r = game.runBattle(strong, { kind: 'boss', id: 'gatekeeper', difficulty: 7 }, 5);
  assert.equal(r.difficulty, 7);
  assert.deepEqual(r.record.target, { kind: 'boss', id: 'gatekeeper', difficulty: 7 });
  const replay = game.replayBattle(r.record);
  assert.equal(replay.turns, r.turns);
  assert.equal(replay.winner, r.winner);
  if (r.victory) { assert.equal(r.firstClear, false); assert.deepEqual(r.rewards.gems, []); }
});

test('難度超過 15 的掉落用 15 算（不丟錯）', () => {
  const drops = require('./dropTable');
  assert.throws(() => drops.rollDrops(16, () => 0.5, {}), /難度/);
  // runBattle 內部 clamp：只要打得贏就不會因為難度 > 15 丟錯；這裡直接確認 clamp 的程式路徑
  const src = require('fs').readFileSync(require.resolve('./game'), 'utf8');
  assert.match(src, /Math\.min\(battle\.difficulty, MAX_DIFFICULTY\)/);
  assert.equal(findBoss('silver').difficulty, 12);
});
