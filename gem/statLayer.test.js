'use strict';

// 數值加成層的測試。執行：node --test gems/statLayer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { STAT_DEFS, validateBonuses, validateBuffBonuses, statModifier, explainStatBonuses, applyStatBonuses, describeStatBonus } = require('./statLayer');
const { compileSkill, compileLoadout, describeSupport, validateGemData } = require('./gemCompiler');
const { SUPPORT_GEMS, GROUPS } = require('./gems');

const flat = (stat, value, source) => ({ stat, op: 'flat', value, ...(source ? { source } : {}) });
const inc = (stat, value, source) => ({ stat, op: 'inc', value, ...(source ? { source } : {}) });
const more = (stat, value, source) => ({ stat, op: 'more', value, ...(source ? { source } : {}) });
const baseStats = { hp: 2000, sp: 120, atk: 150, def: 50, spd: 120, cri: 0.2 };

// ── 公式 ────────────────────────────────────────────────────

test('公式：(基礎 + Σ固定) × (1 + Σ加算) × Π(1 + 乘算)，整數四捨五入', () => {
  // (100 + 20) × (1 + 0.2 + 0.3) × 1.1 × 1.1 = 217.8
  const stats = applyStatBonuses({ ...baseStats, atk: 100 },
    [flat('atk', 20), inc('atk', 0.2), inc('atk', 0.3), more('atk', 0.1), more('atk', 0.1)]);
  assert.equal(stats.atk, 218);
});

test('加算先相加、乘算各自相乘：兩筆 +20% 的結果不同', () => {
  const asInc = applyStatBonuses({ ...baseStats, atk: 100 }, [inc('atk', 0.2), inc('atk', 0.2)]);
  const asMore = applyStatBonuses({ ...baseStats, atk: 100 }, [more('atk', 0.2), more('atk', 0.2)]);
  assert.equal(asInc.atk, 140);
  assert.equal(asMore.atk, 144);
});

test('加成順序不影響結果', () => {
  const list = [flat('atk', 20), inc('atk', 0.2), more('atk', 0.1), inc('atk', 0.1), flat('atk', 5)];
  const a = applyStatBonuses(baseStats, list);
  const b = applyStatBonuses(baseStats, [...list].reverse());
  assert.deepEqual(a, b);
});

test('不修改傳入的屬性；沒有加成時回傳內容相同的副本', () => {
  const input = { ...baseStats };
  const out = applyStatBonuses(input, [flat('atk', 10)]);
  assert.deepEqual(input, baseStats);
  assert.notEqual(out, input);
  assert.deepEqual(applyStatBonuses(input, []), input);
  assert.notEqual(applyStatBonuses(input, []), input);
});

test('沒有加成的屬性不會被動到，也不會憑空多出欄位', () => {
  const out = applyStatBonuses(baseStats, [flat('atk', 10)]);
  assert.equal(out.def, 50);
  assert.equal(out.criDmg, undefined);
  assert.equal(out.maxHp, undefined);
});

// ── 夾範圍與預設值 ───────────────────────────────────────────

test('暴擊率與技能施放率夾在 0～1，Entity 不會因此丟錯', () => {
  const out = applyStatBonuses({ ...baseStats, cri: 0.9, skillCastRate: 0.9 }, [flat('cri', 0.5), flat('skillCastRate', 0.5)]);
  assert.equal(out.cri, 1);
  assert.equal(out.skillCastRate, 1);
  const low = applyStatBonuses({ ...baseStats, cri: 0.1, skillCastRate: 0.1 }, [flat('cri', -0.5), flat('skillCastRate', -0.5)]);
  assert.equal(low.cri, 0);
  assert.equal(low.skillCastRate, 0);
  const plain = new Skill({ id: 'p', name: 'p', actions: [{ type: 'DAMAGE' }] });
  assert.doesNotThrow(() => new Entity({ id: 'h', name: 'h', team: 'A', normalAttack: plain, stats: out }));
});

test('防禦等屬性不會被扣成負數；暴擊傷害最低是 1', () => {
  const out = applyStatBonuses({ ...baseStats, criDmg: 1.5 }, [flat('def', -999), flat('criDmg', -9)]);
  assert.equal(out.def, 0);
  assert.equal(out.criDmg, 1);
});

test('加算降到 -100% 以下時，結果是 0 而不是負數', () => {
  const out = applyStatBonuses(baseStats, [inc('atk', -3)]);
  assert.equal(out.atk, 0);
});

test('基礎屬性沒給的欄位採框架預設：暴擊傷害 1.5、暴擊率 0、智力 0', () => {
  const noCri = applyStatBonuses({ hp: 100, atk: 10 }, [flat('cri', 0.1), flat('criDmg', 0.3), flat('int', 5), flat('skillCastRate', 0.1)]);
  assert.equal(noCri.cri, 0.1);
  assert.equal(noCri.criDmg, 1.8);
  assert.equal(noCri.int, 5);
  assert.equal(noCri.skillCastRate, 0.45);
});

test('小數結果不會出現浮點尾巴', () => {
  const out = applyStatBonuses({ ...baseStats, cri: 0.1 }, [flat('cri', 0.2)]);
  assert.equal(out.cri, 0.3);
});

// ── 生命與 SP ───────────────────────────────────────────────

test('生命：沒給 maxHp 時，加成後上限與目前值一起增加（開場仍是滿血）', () => {
  const out = applyStatBonuses({ hp: 2000, sp: 10 }, [inc('hp', 0.1)]);
  assert.equal(out.maxHp, 2200);
  assert.equal(out.hp, 2200);
});

test('生命：目前值跟著上限的變化量移動，受傷的角色不會被補滿', () => {
  const out = applyStatBonuses({ hp: 1000, maxHp: 2000, sp: 10 }, [flat('hp', 500)]);
  assert.equal(out.maxHp, 2500);
  assert.equal(out.hp, 1500);
});

test('生命：減少上限時目前值不會超過新上限，也不會低於 1', () => {
  const cut = applyStatBonuses({ hp: 2000, sp: 10 }, [flat('hp', -500)]);
  assert.equal(cut.maxHp, 1500);
  assert.equal(cut.hp, 1500);
  const floor = applyStatBonuses({ hp: 100, sp: 10 }, [flat('hp', -9999)]);
  assert.equal(floor.maxHp, 1);
  assert.equal(floor.hp, 1);
});

test('SP：上限與目前值同步，maxSp 沒給時以 sp 為準', () => {
  const out = applyStatBonuses({ ...baseStats }, [flat('sp', 30)]);
  assert.equal(out.maxSp, 150);
  assert.equal(out.sp, 150);
  const spent = applyStatBonuses({ ...baseStats, sp: 40, maxSp: 120 }, [flat('sp', 30)]);
  assert.equal(spent.maxSp, 150);
  assert.equal(spent.sp, 70);
});

test('基礎屬性缺少生命時明確報錯，不是算出 NaN', () => {
  assert.throws(() => applyStatBonuses({ atk: 10 }, [flat('hp', 10)]), /缺少 hp/);
});

// ── 驗證 ────────────────────────────────────────────────────

test('驗證：未知屬性、未知 op、非數字、more ≤ -1、source 型別都會被指出', () => {
  assert.deepEqual(validateBonuses([flat('atk', 1), more('atk', -0.5), inc('atk', -2)]), []);
  assert.match(validateBonuses([{ stat: 'luckyness', op: 'flat', value: 1 }])[0], /未知的屬性「luckyness」/);
  assert.match(validateBonuses([{ stat: 'atk', op: 'add', value: 1 }])[0], /未知的 op「add」/);
  assert.match(validateBonuses([flat('atk', NaN)])[0], /有限數字/);
  assert.match(validateBonuses([flat('atk', '5')])[0], /有限數字/);
  assert.match(validateBonuses([more('atk', -1)])[0], /大於 -1/);
  assert.match(validateBonuses([{ ...flat('atk', 1), source: 5 }])[0], /source/);
  assert.match(validateBonuses('x')[0], /陣列/);
  assert.match(validateBonuses([null])[0], /不是物件/);
});

test('驗證：問題會指出是第幾筆', () => {
  const problems = validateBonuses([flat('atk', 1), flat('nope', 1)]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /第 2 筆/);
});

test('applyStatBonuses 與 explainStatBonuses 遇到不合法的加成會丟錯而不是靜默略過', () => {
  assert.throws(() => applyStatBonuses(baseStats, [flat('nope', 1)]), /屬性加成有誤/);
  assert.throws(() => explainStatBonuses(baseStats, [more('atk', -2)]), /屬性加成有誤/);
});

// ── 明細與說明文字 ───────────────────────────────────────────

test('explainStatBonuses：給出基礎、各類加成、最終值與來源', () => {
  const rows = explainStatBonuses({ ...baseStats, atk: 100 },
    [flat('atk', 20, 'gemA'), inc('atk', 0.5, undefined), more('atk', 0.1, 'sword'), flat('cri', 0.1, 'gemA')]);
  const atk = rows.find(row => row.stat === 'atk');
  assert.deepEqual(atk, { stat: 'atk', name: '攻擊力', base: 100, flat: 20, inc: 0.5, more: 1.1, final: 198, sources: ['gemA', 'sword'] });
  assert.equal(rows.find(row => row.stat === 'cri').final, 0.3);
  assert.equal(rows.length, 2);
});

test('describeStatBonus：百分比類與數值類的措辭，加算與乘算分開標註', () => {
  assert.equal(describeStatBonus(flat('cri', 0.1)).text, '暴擊率 +10%');
  assert.equal(describeStatBonus(flat('criDmg', 0.3)).text, '暴擊傷害 +30%');
  assert.equal(describeStatBonus(flat('atk', 25)).text, '攻擊力 +25');
  assert.equal(describeStatBonus(flat('def', -10)).text, '防禦 -10');
  assert.equal(describeStatBonus(inc('hp', 0.2)).text, '生命提高 20%（加算）');
  assert.equal(describeStatBonus(inc('hp', -0.2)).text, '生命降低 20%（加算）');
  assert.equal(describeStatBonus(more('spd', 0.15)).text, '速度額外增加 15%（乘算）');
  assert.equal(describeStatBonus(more('spd', -0.15)).text, '速度額外減少 15%（乘算）');
  assert.equal(describeStatBonus(flat('cri', 0.1)).kind, 'stat');
});

test('每個支援的屬性都有名稱、顯示方式與範圍', () => {
  for (const [stat, def] of Object.entries(STAT_DEFS)) {
    assert.ok(def.name, `${stat} 缺名稱`);
    assert.ok(['percent', 'number'].includes(def.display), `${stat} display 不合法`);
    assert.equal(typeof def.min, 'number', `${stat} 缺 min`);
  }
});

// ── 暫時 Buff 的數值修改（statModifier）────────────────────────

test('statModifier：固定值加在有效屬性上，其他屬性不動', () => {
  const stats = { cri: 0.2, atk: 100 };
  statModifier([flat('cri', 0.15)])(stats);
  assert.equal(stats.cri, 0.35);
  assert.equal(stats.atk, 100);
});

test('statModifier：與 applyStatBonuses 同一套公式，但不取整', () => {
  const stats = { atk: 100 };
  statModifier([flat('atk', 20), inc('atk', 0.2), inc('atk', 0.3), more('atk', 0.1), more('atk', 0.1)])(stats);
  assert.equal(stats.atk, 217.8);
});

test('statModifier：不夾範圍，所以對立的 Buff 能互相抵銷（框架要求先全套用、最後才夾限）', () => {
  const stats = { cri: 0.95 };
  statModifier([flat('cri', 0.15)])(stats);
  assert.equal(stats.cri, 1.1);
  statModifier([flat('cri', -0.15)])(stats);
  assert.equal(stats.cri, 0.95);
});

test('statModifier：沒有該欄位時採框架預設（暴擊傷害 1.5）', () => {
  const stats = {};
  statModifier([flat('criDmg', 0.3), flat('cri', 0.1)])(stats);
  assert.equal(stats.criDmg, 1.8);
  assert.equal(stats.cri, 0.1);
});

test('statModifier：暫時 Buff 不能改生命與 SP，也不能是空清單；寫錯會報錯', () => {
  assert.match(validateBuffBonuses([flat('hp', 10)])[0], /不能修改 hp/);
  assert.match(validateBuffBonuses([flat('sp', 10)])[0], /不能修改 sp/);
  assert.match(validateBuffBonuses([])[0], /不可為空/);
  assert.deepEqual(validateBuffBonuses([flat('cri', 0.1)]), []);
  assert.throws(() => statModifier([flat('hp', 10)]), /屬性加成有誤/);
  assert.throws(() => statModifier([flat('nope', 1)]), /屬性加成有誤/);
});

// ── 爆擊強化（critup）：資料與編譯 ───────────────────────────

test('爆擊強化：寶石資料整體合法', () => {
  assert.deepEqual(validateGemData(SUPPORT_GEMS, GROUPS), []);
});

test('爆擊強化：statBonuses 的資料錯誤在編譯前被指出（type 不是 STAT、同時有 effect、空清單）', () => {
  const variant = patch => ({
    ...SUPPORT_GEMS,
    critup: {
      ...SUPPORT_GEMS.critup,
      effects: [{ ...SUPPORT_GEMS.critup.effects[0], action: {
        ...SUPPORT_GEMS.critup.effects[0].action,
        buffs: [{ ...SUPPORT_GEMS.critup.effects[0].action.buffs[0], ...patch }]
      } }]
    }
  });
  assert.match(validateGemData(variant({ type: 'HOT' }), GROUPS).join('\n'), /type 必須是 STAT/);
  assert.match(validateGemData(variant({ effect() {} }), GROUPS).join('\n'), /不能同時有 statBonuses 與 effect/);
  assert.match(validateGemData(variant({ statBonuses: [] }), GROUPS).join('\n'), /不可為空/);
  assert.match(validateGemData(variant({ statBonuses: [flat('hp', 5)] }), GROUPS).join('\n'), /不能修改 hp/);
});

test('爆擊強化：動作串是「對自己的 BUFF → 原本的傷害」，傷害仍打敵人；SP 與倍率不變', () => {
  const withGem = compileSkill('magicmissile', ['critup']);
  const without = compileSkill('magicmissile', []);
  const [first, second] = withGem.skill.actions;
  assert.equal(first.type, 'BUFF');
  assert.equal(first.targetType, 'SELF');
  assert.equal(second.type, 'DAMAGE');
  assert.equal(second.inheritTarget, false, '傷害必須重新挑目標，不然會沿用「自己」');
  assert.equal(withGem.spCost, without.spCost);
  assert.equal(withGem.damageFactor, without.damageFactor);
  assert.equal(withGem.skill.id, 'magicmissile+critup');
});

test('爆擊強化：Buff 只撐一個行動槽，編譯後 statBonuses 已轉成框架的 effect 函式', () => {
  const buff = compileSkill('magicmissile', ['critup']).skill.actions[0].buffs[0];
  assert.equal(buff.duration, 1);
  assert.equal(buff.type, 'STAT');
  assert.equal(buff.dispellable, false);
  assert.equal(typeof buff.effect, 'function');
  assert.equal(buff.statBonuses, undefined);
  const stats = { cri: 0 };
  buff.effect(stats);
  assert.equal(stats.cri, 0.15);
});

test('爆擊強化：玩家說明一行，不歸在加算或乘算', () => {
  const info = describeSupport(SUPPORT_GEMS.critup);
  assert.equal(info.lines.length, 1);
  assert.match(info.lines[0].text, /爆擊率 \+15%/);
  assert.deepEqual(info.badges, []);
});

test('爆擊強化：可以和其他輔助寶石一起連結，互不改變對方的數值', () => {
  const heavy = compileSkill('magicmissile', ['heavy']);
  const both = compileSkill('magicmissile', ['heavy', 'critup']);
  assert.equal(both.damageFactor, heavy.damageFactor);
  assert.equal(both.spCost, heavy.spCost);
});

// ── 爆擊強化：實際戰鬥 ───────────────────────────────────────

const plainSkill = id => new Skill({ id, name: id, actions: [{ type: 'DAMAGE' }] });
function fight(supports, seed, { active = 'magicmissile', heroStats = {}, foe = {}, maxTurns } = {}) {
  const loadout = compileLoadout([{ active, supports }]);
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plainSkill('slash'), skills: loadout.skills, passives: loadout.passives,
    stats: { hp: 9000, sp: 900, atk: 150, def: 50, spd: 120, cri: 0, skillCastRate: 1, ...heroStats }
  });
  const boss = new Entity({
    id: 'boss', name: '魔王', team: 'B', normalAttack: plainSkill('claw'),
    stats: { hp: 3000, sp: 0, atk: 1, def: 0, spd: 1, ...foe }
  });
  const engine = new BattleEngine([hero], [boss], { rng: createSeededRandom(seed), skillSelectionResolver: loadout.resolver, ...(maxTurns ? { maxTurns } : {}) });
  return { hero, logs: engine.start().logs };
}
const heroHits = logs => logs.filter(log => log.actorId === 'hero' && typeof log.isCrit === 'boolean');
const critRate = hits => hits.filter(log => log.isCrit).length / hits.length;

test('戰報：「{caster}的爆擊率提升了。」排在技能那一行的前一條', () => {
  const { logs } = fight(['critup'], 1, { foe: { hp: 600 } });
  const index = logs.findIndex(log => log.message === '勇者的爆擊率提升了。');
  assert.ok(index >= 0, '找不到提示文字');
  assert.equal(logs[index].type, 'BUFF_APPLY');
  assert.equal(logs[index + 1].type, 'DAMAGE');
  assert.match(logs[index + 1].message, /詠唱魔法飛彈/);
  assert.equal(logs[index + 1].skillId, 'magicmissile+critup');
});

test('戰報：每次施放各出現一次提示，提示不會多印', () => {
  const { logs } = fight(['critup'], 2, { foe: { hp: 100000 }, maxTurns: 6 });
  const casts = logs.filter(log => log.type === 'DAMAGE' && log.skillId === 'magicmissile+critup').length;
  const notices = logs.filter(log => log.message === '勇者的爆擊率提升了。').length;
  assert.ok(casts > 0);
  assert.equal(notices, casts);
});

test('效果：基礎暴擊率 0 的角色，施放時每擊暴擊率約 15%；沒連結時完全不暴擊', () => {
  const withGem = [];
  const without = [];
  for (let seed = 1; seed <= 150; seed++) {
    withGem.push(...heroHits(fight(['critup'], seed).logs));
    without.push(...heroHits(fight([], seed).logs));
  }
  assert.ok(withGem.length > 1500, `樣本太少：${withGem.length}`);
  const rate = critRate(withGem);
  assert.ok(rate > 0.13 && rate < 0.17, `暴擊率 ${rate}`);
  assert.equal(without.filter(log => log.isCrit).length, 0);
});

test('效果：加成疊在原本的暴擊率上（基礎 20% → 施放時約 35%）', () => {
  const hits = [];
  for (let seed = 1; seed <= 150; seed++) hits.push(...heroHits(fight(['critup'], seed, { heroStats: { cri: 0.2 } }).logs));
  const rate = critRate(hits);
  assert.ok(rate > 0.32 && rate < 0.38, `暴擊率 ${rate}`);
});

test('效果：只持續這次施放，普攻與其他行動不受影響（施放率 50%）', () => {
  const stray = [];
  for (let seed = 1; seed <= 100; seed++) {
    stray.push(...heroHits(fight(['critup'], seed, { heroStats: { skillCastRate: 0.5 }, foe: { hp: 100000 }, maxTurns: 10 }).logs)
      .filter(log => !/critup/.test(log.skillId || '')));
  }
  assert.ok(stray.length > 300, `普攻樣本太少：${stray.length}`);
  assert.equal(stray.filter(log => log.isCrit).length, 0);
});

test('效果：每個行動槽結束後，爆擊強化已經從身上消失', () => {
  const loadout = compileLoadout([{ active: 'magicmissile', supports: ['critup'] }]);
  const hero = new Entity({ id: 'hero', name: '勇者', team: 'A', normalAttack: plainSkill('slash'), skills: loadout.skills,
    stats: { hp: 9000, sp: 900, atk: 150, def: 50, spd: 120, cri: 0, skillCastRate: 1 } });
  const boss = new Entity({ id: 'boss', name: '魔王', team: 'B', normalAttack: plainSkill('claw'), stats: { hp: 3000, sp: 0, atk: 1, def: 0, spd: 1 } });
  let leftover = 0;
  let ticks = 0;
  const tick = hero.tickBuffs.bind(hero);
  hero.tickBuffs = () => { tick(); ticks++; if (hero.buffs.some(buff => buff.id === 'critup')) leftover++; };
  new BattleEngine([hero], [boss], { rng: createSeededRandom(5) }).start();
  assert.ok(ticks > 0);
  assert.equal(leftover, 0);
});

test('搭配蓄力：掛標記那一槽沒有加成與提示，釋放那一槽才有，且提示仍在技能那一行之前', () => {
  const { logs } = fight(['charge', 'critup'], 3);
  const charge = logs.findIndex(log => /開始蓄力/.test(log.message));
  const notice = logs.findIndex(log => log.message === '勇者的爆擊率提升了。');
  assert.ok(charge >= 0 && notice > charge, '提示應該出現在蓄力之後的釋放槽');
  assert.equal(logs[notice + 1].type, 'DAMAGE');
  assert.equal(logs.slice(charge, notice).filter(log => log.type === 'DAMAGE').length, 0, '蓄力那一槽不該有傷害');
});

test('搭配佈局：開頭「第一動，」接在技能那一行，不會接到爆擊提示上', () => {
  const { logs } = fight(['layout', 'critup'], 4);
  const notice = logs.findIndex(log => log.message === '勇者的爆擊率提升了。');
  assert.ok(notice >= 0, '提示文字被改壞了');
  assert.equal(logs[notice + 1].type, 'DAMAGE');
  assert.match(logs[notice + 1].message, /^勇者的第一動，詠唱魔法飛彈/);
  assert.ok(!logs.some(log => /第一動，的/.test(log.message || '')));
});

test('搭配撒手鐧：插隊行動槽結束時加成也會消失，不會讓下一次攻擊多吃到', () => {
  const stray = [];
  let triggered = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const { logs } = fight(['trump', 'critup'], seed, {
      heroStats: { hp: 6000, skillCastRate: 0.5 }, foe: { hp: 100000, atk: 700, spd: 100 }, maxTurns: 12
    });
    const at = logs.findIndex(log => /拚死一搏/.test(log.message || ''));
    if (at >= 0) {
      triggered++;
      assert.equal(logs[at + 1].message, '勇者的爆擊率提升了。', '插隊那一槽也要先印提示');
      assert.equal(logs[at + 2].type, 'DAMAGE');
    }
    stray.push(...heroHits(logs).filter(log => !/critup/.test(log.skillId || '')));
  }
  assert.ok(triggered > 40, `撒手鐧只觸發 ${triggered} 次`);
  assert.ok(stray.length > 300, `普攻樣本太少：${stray.length}`);
  assert.equal(stray.filter(log => log.isCrit).length, 0);
});

// ── 實際戰鬥 ────────────────────────────────────────────────

test('戰鬥：套用暴擊加成的角色，每一擊都暴擊；沒套用的不會', () => {
  const run = statBonuses => {
    const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });
    const hero = new Entity({
      id: 'hero', name: '勇者', team: 'A', normalAttack: plain,
      stats: applyStatBonuses({ hp: 5000, sp: 0, atk: 100, def: 0, spd: 100, cri: 0 }, statBonuses)
    });
    const foe = new Entity({ id: 'foe', name: '敵人', team: 'B', normalAttack: plain, stats: { hp: 3000, sp: 0, atk: 1, def: 0, spd: 1 } });
    const result = new BattleEngine([hero], [foe], { rng: createSeededRandom(7) }).start();
    return result.logs.filter(log => log.actorId === 'hero' && typeof log.isCrit === 'boolean');
  };
  const withBonus = run([flat('cri', 1)]);
  const without = run([]);
  assert.ok(withBonus.length > 0);
  assert.ok(withBonus.every(log => log.isCrit), '暴擊率 100% 時每一擊都應該暴擊');
  assert.ok(without.length > 0);
  assert.ok(without.every(log => !log.isCrit), '暴擊率 0 時不應該暴擊');
});
