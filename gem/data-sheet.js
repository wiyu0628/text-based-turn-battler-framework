'use strict';
/**
 * 數值表匯出（後台核對用，不放進遊戲網頁）：把怪物、Boss、難度、掉落、刻印、製作、寶石、傳說裝備、能量等資料表
 * 直接從程式裡的資料算出來，輸出 JSON：[{ sheet, title, note, header: [...], rows: [[...], ...] }]。
 * 用法（repo 根目錄）：node gem/data-sheet.js > data-sheet.json
 * 數字都是程式現在用的值；改了資料表重新執行即可。
 */
const M = require('./monsters');
const B = require('./bosses');
const G = require('./gems');
const A = require('./affixTable');
const C = require('./craftTable');
const D = require('./dropTable');
const E = require('./energyTable');
const L = require('./legendaryTable');
const AC = require('./accessoryTable');
const { describeMechanic } = L;
const S = require('./statLayer');
const { describeSupport, describePlayer } = require('./gemCompiler');
const DIFF = require('./difficulty');
const { strength } = DIFF;
const game = require('./game');

const SHOW_DIFFS = [1, 4, 7, 10, 13, 15];
const SLOT = { weapon: '武器', helmet: '頭盔', armor: '護甲', boots: '鞋子' };
const TARGET = { single: '敵方單體', all: '敵方全體', self: '自己', enemy: '敵方單體', allySingle: '我方單體', allyAll: '我方全體', random: '敵方隨機（每發）' };
const EFFECT = { physDmg: '物理傷害提高', spellDmg: '法術傷害提高', reduction: '減傷', ailmentDmg: '異常傷害增加', ailmentDuration: '異常持續時間', spRegen: '行動回復 SP' };
const statName = key => S.STAT_DEFS[key]?.name ?? key;
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 10000) / 10000;
const pct = x => `${r2(x * 100)}%`;
const sheets = [];
const add = (sheet, title, note, header, rows) => sheets.push({ sheet, title, note, header, rows });

// ── 角色 ──
add('角色', '角色基礎屬性與新手武器', '角色沒有等級，成長全靠裝備。普攻每擊 2 SP；命中公式 contest；最多 40 回合。',
  ['項目', '數值', '說明'],
  [
    ...Object.entries(game.HERO_BASE).map(([k, v]) => [statName(k) === k ? k : statName(k), v, k === 'skillCastRate' ? '每個行動槽嘗試放技能的機率' : '']),
    ['戰鬥回合上限', game.MAX_TURNS, '超過算平手'],
    ...game.STARTER_WEAPONS.map(w => [w.name, `普攻屬性：${w.attackStat === 'int' ? '智力' : '攻擊'}`, `沒有加成、施放權重 ${w.castWeight}、不能分解、可刻刻印`])
  ]);

// ── 難度 ──
add('難度', '難度縮放與掉落', `怪物 HP／攻擊／智力 × 倍率；命中 +${DIFF.HIT_PER_LEVEL} × (難度 − 1)、防禦 +${DIFF.DEF_PER_LEVEL} × (難度 − 1)。刻印數量與階級只在勝利時擲；稀有怪 +2 個（兩次擲階取高）、菁英怪與 Boss +1 個。`,
  ['難度', '怪物強度等級', '屬性倍率', '怪物命中加成', '怪物防禦加成', '最高刻印階', '1 階', '2 階', '3 階', '4 階', '5 階', '1 個刻印', '2 個刻印', '3 個刻印', '期望刻印數', '輔助寶石機率', '傳說裝備機率', '勝利能量'],
  Array.from({ length: D.MAX_DIFFICULTY }, (_, i) => i + 1).map(d => {
    const rates = D.dropRates(d);
    const count = [1, 2, 3].map(n => rates.count[n] ?? 0);
    return [d, game.strengthLevel(d), r4(strength(d)), DIFF.HIT_PER_LEVEL * (d - 1), DIFF.DEF_PER_LEVEL * (d - 1), D.openTier(d), ...rates.tiers.map(pct), ...count.map(pct),
      r2(count[0] + 2 * count[1] + 3 * count[2]), pct(rates.gem), pct(rates.legendary), D.energyForWin(d)];
  }));

// ── 地區 ──
add('地區', '地區', `每場隻數在範圍內；稀有怪 ${pct(M.RARE_CHANCE)}、沒出稀有時菁英 ${pct(M.ELITE_CHANCE)}（各最多一隻、不同時出現），其餘依預算補普通怪。`,
  ['地區 id', '名稱', '每場隻數', '強度預算', '怪物（依出現難度）'],
  Object.values(M.REGIONS).map(r => [r.id, r.name, `${r.count[0]}～${r.count[1]}`, r.budget,
    r.monsters.map(id => `${M.MONSTERS[id].name}（難度 ${M.MONSTERS[id].from}～${M.MONSTERS[id].maxPerEncounter ? `，每場最多 ${M.MONSTERS[id].maxPerEncounter} 隻` : ''}）`).join('、')]));

// ── 怪物 ──
const rarity = def => def.rarity === 'rare' ? '稀有' : def.rarity === 'elite' ? '菁英' : '普通';
const regionOf = id => Object.values(M.REGIONS).filter(r => r.monsters.includes(id)).map(r => r.name).join('、');
const statsAt = (def, d) => M.buildFromDef(def, d, { id: 'x' }).stats;
add('怪物', '怪物屬性', `倍率欄以基準怪（HP ${M.BASE_MONSTER.hp}、攻擊 ${M.BASE_MONSTER.atk}、智力 ${M.BASE_MONSTER.int}）為 1；防禦是難度 1 的值（每級 +${DIFF.DEF_PER_LEVEL}），速度／閃避是固定值。後面各難度欄是單隻、預算縮放前的實際值（遭遇戰會再依預算縮放 HP 與攻擊／智力）。`,
  ['地區', 'id', '名稱', '稀有度', '出現難度', '預算成本', '傷害類型', 'HP 倍率', '攻擊倍率', '智力倍率', '防禦', '速度', '閃避', 'SP', '施放率',
    ...SHOW_DIFFS.flatMap(d => [`難度${d} HP`, `難度${d} 攻擊/智力`])],
  Object.values(M.MONSTERS).map(def => [regionOf(def.id), def.id, def.name, rarity(def), def.from, def.cost, def.spell ? '法術（智力）' : '物理（攻擊）',
    def.stats.hp, def.stats.atk ?? 0, def.stats.int ?? 0, def.stats.def ?? M.BASE_MONSTER.def, def.stats.spd ?? M.BASE_MONSTER.spd, def.stats.eva ?? 0,
    def.stats.sp ?? M.BASE_MONSTER.sp, def.skillCastRate ?? 0.35,
    ...SHOW_DIFFS.flatMap(d => { const s = statsAt(def, d); return [s.maxHp, def.spell ? s.int : s.atk]; })]));

// ── 怪物技能與特性（Boss 一起列） ──
function skillEffect(s) {
  if (s.kind === 'attack') return [`${Math.round(s.power * 100)}%${s.hits ? ` × ${s.hits} ${s.target === 'random' ? '發' : '段'}` : ''}`, [
    s.spell !== undefined ? (s.spell ? '法術（智力，不可暴擊、不可反擊）' : '物理（攻擊）') : '',
    s.target === 'random' ? '每一發各自隨機挑目標' : '',
    s.dot ? `命中附加「${s.dot.name}」：每槽 攻擊/智力 × ${Math.round(s.dot.power * 100)}%，${s.dot.duration} 槽` : '',
    s.debuff ? `命中附加「${s.debuff.name}」：${statName(s.debuff.stat)} × ${s.debuff.mult}，${s.debuff.duration} 槽` : ''].filter(Boolean).join('；')];
  if (s.kind === 'buff') return ['', `${statName(s.stat)} × ${s.mult}，${s.duration} 槽`];
  if (s.kind === 'shield') return ['', s.power != null ? `護盾 = 施放者攻擊/智力 × ${Math.round(s.power * 100)}%，${s.duration} 槽` : `護盾 = 施放者最大 HP × ${Math.round(s.ratio * 100)}%，${s.duration} 槽`];
  if (s.kind === 'heal') return [`${Math.round(s.power * 100)}%`, '治療（讀施放者的攻擊/智力）'];
  return ['', JSON.stringify(s)];
}
const KIND = { attack: '攻擊', buff: '增減益', shield: '護盾', heal: '治療' };
const bossDefs = B.BOSSES.flatMap(b => b.monsters.map(m => ({ ...m, boss: b })));
add('怪物技能', '怪物技能', '「解鎖難度」起才會使用；倍率是攻擊或智力（法術怪）的百分比。',
  ['怪物', '技能 id', '技能', '種類', '解鎖難度', 'SP', '目標', '倍率', '效果'],
  [...Object.values(M.MONSTERS), ...bossDefs].flatMap(def => def.skills.map(s => {
    const [power, effect] = skillEffect(s);
    return [def.boss ? `Boss：${def.name}` : def.name, s.id, s.name, KIND[s.kind] ?? s.kind, s.from, s.spCost ?? 0, TARGET[s.target] ?? s.target, power, effect];
  })));
function traitText(t) {
  if (t.kind === 'split') return `HP 第一次低於 ${pct(t.at)} 時分裂出 ${t.count} 隻「${t.name}」（HP ${pct(t.hpRatio)}、攻擊/智力 ${pct(t.statRatio)}）`;
  if (t.kind === 'ambush') return `伏擊：戰鬥開始時攻擊力 × ${t.mult}，持續 1 個行動槽（第一次行動）`;
  if (t.kind === 'enrage') return `HP 低於 ${pct(t.at)} 時 ${statName(t.stat)} × ${t.mult}`;
  if (t.kind === 'phase') return `HP 第一次低於 ${pct(t.at)} 時轉階段：${Object.entries(t.mults ?? {}).map(([k, m]) => `${statName(k)} × ${m}`).join('、')}` +
    (t.summon ? `；召喚「${t.summon.name}」（本體最大 HP ${pct(t.summon.hpRatio)}、同防禦、攻擊傷害減 ${pct(t.summon.reduction)}、${t.summon.drain ? `只會用「${t.summon.drain.name}」讓玩家失去 ${t.summon.drain.sp} 點 SP` : '不行動'}；打倒後本體受到本體最大 HP ${pct(t.summon.breakRatio)} 的傷害）` : '');
  return JSON.stringify(t);
}
add('怪物特性', '怪物特性', '', ['怪物', '特性', '解鎖難度', '內容'],
  [...Object.values(M.MONSTERS), ...bossDefs].flatMap(def => (def.traits ?? []).map(t => [def.boss ? `Boss：${def.name}` : def.name, t.kind, t.from ?? 1, traitText(t)])));

// ── Boss ──
add('Boss', 'Boss', 'Boss 難度固定；勝利掉落比照菁英（+1 個刻印），首次擊敗另有獎勵。', ['id', '名稱', '難度', 'HP', '攻擊', '智力', '防禦', '速度', '施放率', '首次擊敗獎勵', '備註'],
  B.BOSSES.flatMap(b => b.monsters.map(m => {
    const s = M.buildFromDef(m, b.difficulty, { id: 'x' }).stats;
    return [b.id, m.name, b.difficulty, s.maxHp, s.atk, s.int, s.def, s.spd, m.skillCastRate ?? 0.35,
      [b.rewards.gems.length ? '主動寶石：' + b.rewards.gems.map(g => G.ACTIVE_GEMS[g]?.name ?? g).join('、') : '', b.rewards.unlockRegions.length ? '開放地區：' + b.rewards.unlockRegions.join('、') : '', b.rewards.accessories?.length ? '飾品：' + b.rewards.accessories.map(a => AC.ACCESSORIES[a]?.name ?? a).join('、') : ''].filter(Boolean).join('；'),
      b.placeholder ? '佔位，待重新設計' : '普攻物理；技能法術'];
  })));

// ── 刻印 ──
const lineName = l => l.kind === 'stat' ? `${statName(l.stat)}${l.op === 'inc' ? '提高' : ''}` : EFFECT[l.kind] ?? l.kind;
const fmt = (l, v) => {
  if (l.kind !== 'stat' || l.op === 'inc' || S.STAT_DEFS[l.stat]?.display === 'percent') return pct(v);
  return ['hp', 'sp', 'atk', 'int', 'def', 'spd', 'hit', 'eva'].includes(l.stat) ? String(Math.round(v)) : String(r2(v));
};
add('刻印詞綴', '刻印：刻到裝備時的詞綴', `每個刻印 3 行，刻到裝備時隨機取 2 行；每行數值 = 上限 × 階級縮放 × ${A.ROLL_MIN}～1。階級縮放：${Object.entries(A.TIER_SCALE).map(([t, s]) => `${t} 階 ${s}`).join('、')}。每件裝備最多 ${A.ENGRAVINGS_PER_ITEM} 個刻印；減傷合計上限 ${pct(A.REDUCTION_CAP)}、異常持續合計上限 +${A.AILMENT_DURATION_CAP} 槽。`,
  ['種類 id', '刻印', '詞綴', '運算', '上限（5 階滿骰）', '1 階', '2 階', '3 階', '4 階', '5 階', '可刻部位'],
  Object.entries(A.ENGRAVING_TYPES).flatMap(([id, def]) => def.lines.map((l, i) => [i === 0 ? id : '', i === 0 ? def.name : '', lineName(l),
    l.kind === 'stat' ? (l.op === 'inc' ? '百分比（加算）' : '固定值') : '裝備效果', fmt(l, l.max),
    ...[1, 2, 3, 4, 5].map(t => `${fmt(l, l.max * A.TIER_SCALE[t] * A.ROLL_MIN)}～${fmt(l, l.max * A.TIER_SCALE[t])}`),
    i === 0 ? A.ENGRAVING_SLOTS[id].map(s => SLOT[s]).join('、') : ''])));

add('刻印製作', '刻印：製作裝備時每個刻印貢獻的基底', `一件裝備投入 ${C.CRAFT_INPUTS} 個刻印；基底 = Σ（屬性單位 × 種類比重 × 階級縮放）× 品質倍率 × 部位倍率，四捨五入。屬性單位：${C.CRAFT_STATS.map(s => `${statName(s)} ${C.STAT_UNIT[s]}`).join('、')}。下表是「1 個刻印、品質 ×1、部位倍率 1」的貢獻。`,
  ['刻印', '階級', ...C.CRAFT_STATS.map(statName), '施放權重加成'],
  Object.entries(C.KIND_SHARES).flatMap(([id, shares]) => [1, 2, 3, 4, 5].map(t => [t === 1 ? A.ENGRAVING_TYPES[id].name : '', t,
    ...C.CRAFT_STATS.map(s => shares[s] ? r2(C.STAT_UNIT[s] * shares[s] * A.TIER_SCALE[t]) : ''), C.WEIGHT.bonus[id] ? r2(C.WEIGHT.bonus[id] * A.TIER_SCALE[t]) : ''])));

add('製作', '製作：品質、部位倍率、製作詞綴', `施放權重 = round(${C.WEIGHT.low}～${C.WEIGHT.high} 隨機) + Σ 刻印權重加成，夾在 ${C.WEIGHT.min}～${C.WEIGHT.cap}。製作詞綴 ${C.CRAFT_AFFIX_SLOTS} 條，數值 = 上限 × 投入刻印平均階級縮放 × ${A.ROLL_MIN}～1（品質不影響）。分解製作裝備隨機退回 ${C.SALVAGE_RETURN} 個當初投入的刻印。`,
  ['類別', '項目', ...C.CRAFT_STATS.map(statName), '機率／權重', '說明'],
  [
    ...C.QUALITIES.map(q => ['品質', q.name, ...C.CRAFT_STATS.map(() => `×${q.mult}`), pct(q.chance), '']),
    ...Object.entries(C.SLOT_MULT).map(([slot, m]) => ['部位倍率', SLOT[slot], ...C.CRAFT_STATS.map(s => m[s]), '', '']),
    ...C.CRAFT_AFFIXES.map(a => ['製作詞綴', a.name, ...C.CRAFT_STATS.map(() => ''), a.weight, a.fixed ? `固定 +${a.max} 槽` : `上限 ${a.kind === 'spRegen' ? a.max + ' 點' : pct(a.max)}`])
  ]);

// ── 寶石 ──
const AIL = G.AILMENTS;
function activeRow(id, gem) {
  const dmg = gem.actions.filter(a => a.type === 'DAMAGE');
  const source = G.STARTING_ACTIVE_GEMS.includes(id) ? '開局' : G.BOSS_REWARD_GEMS.includes(id) ? 'Boss 首次擊敗' : G.UNOBTAINABLE_ACTIVE_GEMS.includes(id) ? '暫不可取得' : '';
  return [id, gem.name, gem.tags.includes('spell') ? '法術（智力，不可暴擊、不可反擊）' : '物理（攻擊）', gem.spCost,
    dmg.map(a => a.targetType === 'ENEMY_ALL' ? '敵方全體' : '敵方單體').join('、') || (gem.actions.some(a => a.type === 'HEAL') ? '治療' : ''),
    dmg.map(a => `${Math.round((a.power ?? 1) * 100)}%`).join('、') || gem.actions.filter(a => a.type === 'HEAL').map(a => `${Math.round((a.power ?? 1) * 100)}%`).join('、'),
    dmg.flatMap(a => (a.ailments ?? []).map(x => `${AIL[x.kind]?.name ?? x.kind}：${x.basis === 'hit' ? '命中傷害' : '攻擊力'} × ${Math.round(x.power * 100)}%，${x.duration} 槽`)).join('；'),
    gem.critEcho ? `施放後依爆擊率再打一次 ${Math.round(gem.critEcho.power * 100)}%（不連鎖）` : '',
    gem.tags.join('、'), source];
}
add('主動寶石', '主動寶石', '倍率是攻擊或智力的百分比；異常傷害吃裝備的「異常傷害增加」，持續時間吃「異常持續時間」。',
  ['id', '名稱', '類型', 'SP', '目標', '倍率', '附加異常', '特殊效果', '標籤', '取得'],
  Object.entries(G.ACTIVE_GEMS).map(([id, gem]) => activeRow(id, gem)));
const reqText = req => {
  if (!req) return '';
  const parts = [];
  if (req.action?.targetType) parts.push(req.action.targetType === 'ENEMY_SINGLE' ? '只能連單體技能' : '只能連全體技能');
  else if (req.action?.type === 'DAMAGE') parts.push('要有傷害');
  if (req.tags?.all) parts.push(`必須是：${req.tags.all.join('、')}`);
  if (req.tags?.none) parts.push(`不能是：${req.tags.none.join('、')}`);
  return parts.join('；');
};
add('輔助寶石', '輔助寶石', `每個主動寶石最多連 ${G.MAX_SUPPORTS} 顆輔助；勝利時有機率掉 1 顆（各種等機率），見「難度」頁。`,
  ['id', '名稱', '背包說明', '效果（詳細規則）', '連結限制', '互斥組'],
  Object.entries(G.SUPPORT_GEMS).map(([id, gem]) => {
    const lines = describeSupport(gem).lines.map(l => l.text);
    return [id, gem.name, describePlayer(gem).join(''), lines.filter(t => !t.startsWith('互斥組')).join('；'), reqText(gem.requires), lines.find(t => t.startsWith('互斥組'))?.replace(/^互斥組：/, '').replace(/（.*$/, '') ?? ''];
  }));
add('異常', '異常狀態', '持續時間以中招者的行動槽計；重複獲得可疊加，持續時間分別計算；不會暴擊、沒有浮動。',
  ['id', '名稱', '可延長', '說明'],
  [['bleed', AIL.bleed.name, '是', '命中時以施放者攻擊力 × 比例算出每次傷害，之後固定；不吃增幅、強力等傷害提高'],
   ['lingering', AIL.lingering.name, AIL.lingering.extendable === false ? '否' : '是', '命中時以這次命中傷害 × 比例算出每次傷害，之後固定']]);

// ── 傳說裝備 ──
add('傳說裝備', '傳說裝備', '只能掉落，不能刻刻印、沒有製作詞綴。分解得 1 顆黑骰；黑骰可依掉落時的階級重置一件傳說裝備的數值（施放權重不變）。數值依掉落難度的最高刻印階縮放，再擲 0.7～1（標「固定區間」的不縮放）。施放權重 60～120。',
  ['id', '名稱', '部位', '普攻屬性', '基底（上限）', '獨有詞綴（上限）', '機制'],
  Object.values(L.LEGENDARIES).map(l => [l.id, l.name, SLOT[l.slot], l.attackStat === 'int' ? '智力' : '攻擊',
    l.base.map(b => `${statName(b.stat)} +${b.max}`).join('、'), l.unique.map(u => u.scope === 'effect' ? `${{ summonHp: '召喚物生命', physDmg: '物理傷害提高', spellDmg: '法術傷害提高', reduction: '減傷' }[u.kind] ?? u.kind} +${pct(u.max)}` : u.range ? `${statName(u.stat)} ${pct(u.range[0])}～${pct(u.range[1])}（固定區間）` : ['cri', 'criDmg'].includes(u.stat) ? `${statName(u.stat)} +${pct(u.max)}` : `${statName(u.stat)}${u.op === 'inc' ? '提高 ' + pct(u.max) : ' +' + u.max}`).join('、'),
    l.mechanics.map(m => describeMechanic(m, id => G.SUPPORT_GEMS[id]?.name ?? id).replace('獲得護盾', m.type === 'spShield' ? `獲得護盾（智力 × SP × ${m.ratio}）` : '獲得護盾') + (m.type === 'phantom' ? `（幻影屬性 × 玩家：${['hp', 'spd', 'atk', 'int', 'def'].map(k => `${statName(k)} ${m.ratios?.[k] ?? (k === 'spd' ? 1 : m.ratio)}`).join('、')}；生命再乘 1 + 召喚物生命）` : '')).join('；')]));   // 後台多寫護盾倍率；玩家說明不寫

// ── 飾品 ──
const accessoryLine = a => a.scope === 'effect'
  ? (a.kind === 'ailmentDuration' ? `異常持續時間 +${a.value} 槽` : `${a.kind} +${a.value}`)
  : (['cri', 'criDmg', 'skillCastRate'].includes(a.stat) ? `${statName(a.stat)} +${pct(a.value)}` : `${statName(a.stat)} +${a.value}`);
const accessorySource = id => (AC.STARTING_ACCESSORIES.includes(id) ? '開局' : B.BOSSES.filter(b => b.rewards.accessories?.includes(id)).map(b => `${b.name}首次擊敗`).join('、') || '暫不可取得');
add('飾品', '飾品', `玩家看到的類別名是${AC.ACCESSORY_LABEL}。飾品欄只有 1 個；飾品沒有基礎數值、刻印與寶石，只有固定的特殊詞綴（擁有制，每種最多 1 個）。`,
  ['id', '名稱', '特殊詞綴', '取得'],
  Object.values(AC.ACCESSORIES).map(a => [a.id, a.name, a.affixes.map(accessoryLine).join('、'), accessorySource(a.id)]));

// ── 能量 ──
add('能量', '能量', `上限 ${E.ENERGY_CAP}，超過的部分作廢。勝利能量依該難度的最高刻印階。`,
  ['刻印階級', '分解 1 個刻印得到', '清除裝備上 1 個刻印消耗', '勝利能量（最高刻印階 = 此階時）'],
  [1, 2, 3, 4, 5].map(t => [t, E.SALVAGE_ENERGY[t], E.CLEAR_COST[t], E.WIN_ENERGY[t]]));

if (require.main === module) process.stdout.write(JSON.stringify(sheets, null, 1));
module.exports = { sheets };
