'use strict';

// 區域專屬掉落（2026-11-20 使用者）：第一區是基準，第 N 區掉「第一區＋第 N 區專屬」；寶石轉換只出玩家已經有的區域的寶石
const test = require('node:test');
const assert = require('node:assert/strict');
const { inArea, rollDrops } = require('./dropTable');
const { ENGRAVING_TYPES } = require('./affixTable');
const { SUPPORT_GEMS } = require('./gems');
const { LEGENDARIES, pickLegendary } = require('./legendaryTable');
const { REGIONS } = require('./monsters');
const save = require('./saveLayer');

// 暫時把現有資料標成其他區，測完還原
function withAreas(marks, fn) {
  const saved = marks.map(([table, id]) => [table, id, table[id].area]);
  try { for (const [table, id, area] of marks) table[id].area = area; return fn(); }
  finally { for (const [table, id, area] of saved) { if (area === undefined) delete table[id].area; else table[id].area = area; } }
}

test('inArea：沒寫 area 是第一區，每一區都掉；其他區的只在自己區掉', () => {
  assert.equal(inArea({}, 1), true);
  assert.equal(inArea({}, 2), true);
  assert.equal(inArea({ area: 2 }, 1), false);
  assert.equal(inArea({ area: 2 }, 2), true);
  assert.equal(inArea({ area: 2 }, 3), false);
  assert.deepEqual(Object.values(REGIONS).map(r => r.area), [1, 1, 2]);
});

test('掉落池：第一區打不到第二區專屬的刻印與輔助寶石；第二區兩種都打得到', () => {
  withAreas([[ENGRAVING_TYPES, 'gale', 2], [SUPPORT_GEMS, 'heavy', 2]], () => {
    const seen = area => {
      const types = new Set(), gems = new Set();
      for (let i = 0; i < 4000; i++) {
        let s = i * 7919 + 13;
        const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
        const d = rollDrops(15, rng, { area });
        d.engravings.forEach(e => types.add(e.type));
        d.supportGems.forEach(g => gems.add(g));
        assert.equal(d.area, area);
      }
      return { types, gems };
    };
    const one = seen(1), two = seen(2);
    assert.ok(!one.types.has('gale') && !one.gems.has('heavy'));
    assert.ok(two.types.has('gale') && two.gems.has('heavy'));
    assert.ok(two.types.has('fury') && two.gems.has('amp'));                 // 第一區的東西在第二區照樣掉
  });
});

test('傳說裝備：第一區抽不到第二區專屬的；grantDrops 照掉落的 area 抽', () => {
  withAreas([[LEGENDARIES, 'omen', 2]], () => {
    const ids = n => new Set(Array.from({ length: n }, (_, i) => pickLegendary(() => (i + 0.5) / n, 1)));
    assert.ok(!ids(200).has('omen'));
    assert.ok(new Set(Array.from({ length: 200 }, (_, i) => pickLegendary(() => (i + 0.5) / 200, 2))).has('omen'));
    let got = new Set();
    for (let i = 0; i < 40; i++) {
      const r = save.grantDrops(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), { engravings: [], supportGems: [], legendary: 1, area: 1 }, { difficulty: 7, rng: () => (i + 0.5) / 40 });
      got.add(r.equipment[0].legendaryId);
    }
    assert.ok(!got.has('omen'));
  });
});

test('寶石轉換：沒有任何第二區寶石時不會轉出第二區的；有了以後才會', () => {
  withAreas([[SUPPORT_GEMS, 'heavy', 2]], () => {
    let state = save.addGems(save.createEmptySave({ now: '2026-11-20T00:00:00Z' }), 'amp', 3);
    for (let i = 0; i < 60; i++) assert.notEqual(save.convertGems(state, ['amp', 'amp', 'amp'], () => i / 60).gemId, 'heavy');
    const others = Object.keys(SUPPORT_GEMS).filter(id => id !== 'heavy' && id !== 'amp');
    state = save.addGems(state, 'heavy', 1);
    for (const id of others) state = save.addGems(state, id, 1);
    // 全部都有了：從投入以外的種類抽，第二區的 heavy 也在池裡
    const outs = new Set(Array.from({ length: 200 }, (_, i) => save.convertGems(state, ['amp', 'amp', 'amp'], () => (i + 0.5) / 200).gemId));
    assert.ok(outs.has('heavy'));
  });
});
