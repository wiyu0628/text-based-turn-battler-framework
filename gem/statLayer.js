'use strict';

/**
 * 數值加成層：把一串「屬性加成」套用到角色的基礎屬性上，回傳新的屬性物件。
 *
 * 這是寶石、裝備詞綴、刻印共用的底層，不依賴框架與寶石系統（純函式、純資料）：
 *   - 裝備與刻印詞綴：產生這種格式的加成，串在一起交給 applyStatBonuses（常駐）
 *   - 暫時效果：寶石的 BUFF 動作寫 statBonuses，編譯器用 statModifier 轉成 STAT Buff 的 effect（只在 Buff 持續期間）
 *   輔助寶石沒有常駐的效果：寶石只有「施放時」的暫時效果，常駐的數值只來自裝備與詞綴。
 *   - 介面：背包畫面想預覽最終數值，用 explainStatBonuses / applyStatBonuses 即可，不需要開戰鬥
 *
 * ── 加成的格式 ─────────────────────────────────────────────────
 *   { stat: 'cri', op: 'flat', value: 0.1, source?: 'critgem' }
 *   stat    見 STAT_DEFS
 *   op      flat  固定值：直接加在基礎值上（cri 的 0.1 = +10 個百分點）
 *           inc   加算百分比：同為 inc 的先相加，所以不會滾雪球（0.2 = +20%）
 *           more  乘算百分比：每一筆獨立相乘（0.2 = ×1.2），value 必須大於 -1
 *   source  選填，來源說明（寶石 id、裝備名稱…），只給 UI 與除錯看，不影響計算
 *
 * ── 公式（與寶石的傷害加成同一套慣例）────────────────────────────
 *   最終值 = (基礎 + Σflat) × max(0, 1 + Σinc) × Π(1 + more)
 *   再依屬性夾在合理範圍內（見 STAT_DEFS），整數屬性四捨五入。
 *
 * ── 生命與 SP ──────────────────────────────────────────────────
 *   加成算在「上限」（maxHp / maxSp，沒給就用 hp / sp）上，目前值跟著上限的增減同步移動，
 *   所以開場滿血的角色加成後仍是滿血，不會出現「上限變高、血量沒跟上」。
 *
 * ── 使用 ──────────────────────────────────────────────────────
 *   const stats = applyStatBonuses({ hp: 2000, sp: 120, atk: 150, def: 50, spd: 120, cri: 0.2 }, equipmentBonuses);
 *   new Entity({ ..., stats });
 *   忘了套用不會報錯，只是加成沒有效果（與被動沒傳給 Entity 同類的風險）。
 *
 * 要支援新的屬性：只在 STAT_DEFS 加一行。
 */

// display: 'percent' 表示固定值與百分比都以百分比顯示（0.1 → 10%）；'number' 以數字顯示。
// min / max：最終值的範圍。integer：四捨五入成整數。fallback：基礎屬性沒有這個欄位時採用的值（與框架預設一致）。
const STAT_DEFS = {
  hp:            { name: '生命',       display: 'number',  integer: true,  min: 1, fallback: null },
  sp:            { name: 'SP',        display: 'number',  integer: true,  min: 0, fallback: 0 },
  atk:           { name: '攻擊力',     display: 'number',  integer: true,  min: 0, fallback: 0 },
  def:           { name: '防禦',       display: 'number',  integer: true,  min: 0, fallback: 0 },
  int:           { name: '智力',       display: 'number',  integer: true,  min: 0, fallback: 0 },
  spd:           { name: '速度',       display: 'number',  integer: true,  min: 0, fallback: 0 },
  // 命中與閃避（框架 1.0.59 的 hitFormula: 'contest'：命中 = 200 + hit；見 docs/MECHANICS.md）
  hit:           { name: '命中',       display: 'number',  integer: true,  min: 0, fallback: 0 },
  eva:           { name: '閃避',       display: 'number',  integer: true,  min: 0, fallback: 0 },
  cri:           { name: '暴擊率',     display: 'percent', integer: false, min: 0, max: 1, fallback: 0 },
  criDmg:        { name: '暴擊傷害',   display: 'percent', integer: false, min: 1, fallback: 1.5 },
  skillCastRate: { name: '技能施放率', display: 'percent', integer: false, min: 0, max: 1, fallback: 0.35 },
  // 閃避反擊的點數（2026-11-21，第二區專屬刻印與傳說）：閃避成功後依點數擲反擊，見 monsters.evadeCounterChance
  evadeCounter:  { name: '反擊點數',   display: 'number',  integer: true,  min: 0, fallback: 0 }
};
const BONUS_OPS = new Set(['flat', 'inc', 'more']);

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round4 = value => Math.round(value * 10000) / 10000;
// 三類加成合成最終值（還沒夾範圍與取整）：固定值先加，再乘加算區，再乘各筆乘算。
const combine = (base, flat, inc, more) => (base + flat) * Math.max(0, 1 + inc) * more;

/**
 * 檢查加成資料有沒有寫錯。回傳問題清單；空陣列代表沒問題。
 * @param {object[]} bonuses
 */
function validateBonuses(bonuses) {
  if (!Array.isArray(bonuses)) return ['bonuses 必須是陣列'];
  const problems = [];
  bonuses.forEach((bonus, index) => {
    const where = `第 ${index + 1} 筆加成`;
    if (!bonus || typeof bonus !== 'object') { problems.push(`${where}不是物件`); return; }
    if (!Object.hasOwn(STAT_DEFS, bonus.stat)) problems.push(`${where}使用了未知的屬性「${bonus.stat}」（支援：${Object.keys(STAT_DEFS).join('、')}）`);
    if (!BONUS_OPS.has(bonus.op)) problems.push(`${where}使用了未知的 op「${bonus.op}」（支援：flat、inc、more）`);
    if (!finite(bonus.value)) problems.push(`${where}的 value 必須是有限數字`);
    else if (bonus.op === 'more' && bonus.value <= -1) problems.push(`${where}的 more 必須大於 -1（-0.2 代表 ×0.8）`);
    if (bonus.source !== undefined && typeof bonus.source !== 'string') problems.push(`${where}的 source 必須是字串`);
  });
  return problems;
}

function assertValidBonuses(bonuses) {
  const problems = validateBonuses(bonuses);
  if (problems.length) throw new Error(`屬性加成有誤：\n- ${problems.join('\n- ')}`);
}

// 取出該屬性的「基礎值」：生命與 SP 以上限為準。
function baseOf(baseStats, stat) {
  const def = STAT_DEFS[stat];
  const raw = stat === 'hp' ? (baseStats.maxHp ?? baseStats.hp)
    : stat === 'sp' ? (baseStats.maxSp ?? baseStats.sp)
    : baseStats[stat];
  const value = raw ?? def.fallback;
  if (!finite(value)) throw new Error(`基礎屬性缺少 ${stat}（${def.name}），無法套用加成`);
  return value;
}

/**
 * 逐項算出每個有加成的屬性：基礎值、各類加成合計、最終值。給 UI 顯示「來源明細」用。
 * 沒有加成的屬性不會出現在結果裡。
 * @returns {{ stat, name, base, flat, inc, more, final, sources: string[] }[]}
 */
function explainStatBonuses(baseStats, bonuses = []) {
  assertValidBonuses(bonuses);
  const rows = [];
  for (const [stat, def] of Object.entries(STAT_DEFS)) {
    const mine = bonuses.filter(bonus => bonus.stat === stat);
    if (!mine.length) continue;
    const base = baseOf(baseStats, stat);
    const sum = op => mine.filter(bonus => bonus.op === op).reduce((total, bonus) => total + bonus.value, 0);
    const flat = sum('flat');
    const inc = sum('inc');
    const more = mine.filter(bonus => bonus.op === 'more').reduce((product, bonus) => product * (1 + bonus.value), 1);
    let final = combine(base, flat, inc, more);
    if (def.integer) final = Math.round(final);
    final = Math.max(def.min, def.max === undefined ? final : Math.min(def.max, final));
    rows.push({
      stat, name: def.name, base, flat: round4(flat), inc: round4(inc), more: round4(more),
      final: round4(final), sources: [...new Set(mine.map(bonus => bonus.source).filter(Boolean))]
    });
  }
  return rows;
}

/**
 * 把加成套用到基礎屬性，回傳新的屬性物件（不修改傳入的物件）。
 * 沒有任何加成時，回傳內容相同的副本。
 */
function applyStatBonuses(baseStats, bonuses = []) {
  const stats = { ...baseStats };
  for (const row of explainStatBonuses(baseStats, bonuses)) {
    if (row.stat === 'hp') {
      stats.maxHp = row.final;
      stats.hp = Math.max(1, Math.min(row.final, baseStats.hp + (row.final - row.base)));
    } else if (row.stat === 'sp') {
      stats.maxSp = row.final;
      stats.sp = Math.max(0, Math.min(row.final, (baseStats.sp ?? row.base) + (row.final - row.base)));
    } else {
      stats[row.stat] = row.final;
    }
  }
  return stats;
}

// 暫時的 STAT Buff 不能改生命與 SP：它們的上限與目前值要一起動，Buff 的 effect 只改「當下的有效屬性」。
const BUFF_FORBIDDEN = new Set(['hp', 'sp']);

/** 暫時 Buff 用的加成檢查：格式同 validateBonuses，另外不允許 hp、sp。 */
function validateBuffBonuses(bonuses) {
  const problems = validateBonuses(bonuses);
  if (Array.isArray(bonuses) && !bonuses.length) problems.push('statBonuses 不可為空陣列');
  if (Array.isArray(bonuses)) {
    bonuses.forEach((bonus, index) => {
      if (bonus && BUFF_FORBIDDEN.has(bonus.stat)) problems.push(`第 ${index + 1} 筆加成：暫時的 Buff 不能修改 ${bonus.stat}（${STAT_DEFS[bonus.stat].name}）`);
    });
  }
  return problems;
}

/**
 * 把加成變成框架 STAT Buff 的 effect 函式（Buff 設定裡的 effect：收到有效屬性並直接修改）。
 * 寶石資料必須是純資料，不能放函式，所以資料裡寫 statBonuses，由編譯器呼叫這裡轉成函式。
 * 與 applyStatBonuses 同一套公式，差別是：不夾範圍、不取整。框架說明 STAT 效果要「先全部套用、最後才夾限」，
 * 這樣互相對立的 Buff 才能抵銷；暴擊率的上下限不影響判定（超過 1 一定暴擊，小於 0 一定不暴擊）。
 */
function statModifier(bonuses) {
  const problems = validateBuffBonuses(bonuses);
  if (problems.length) throw new Error(`屬性加成有誤：\n- ${problems.join('\n- ')}`);
  const list = bonuses.map(bonus => ({ ...bonus }));
  const stats = [...new Set(list.map(bonus => bonus.stat))];
  return effective => {
    for (const stat of stats) {
      const mine = list.filter(bonus => bonus.stat === stat);
      const sum = op => mine.filter(bonus => bonus.op === op).reduce((total, bonus) => total + bonus.value, 0);
      const more = mine.filter(bonus => bonus.op === 'more').reduce((product, bonus) => product * (1 + bonus.value), 1);
      effective[stat] = round4(combine(effective[stat] ?? STAT_DEFS[stat].fallback, sum('flat'), sum('inc'), more));
    }
  };
}

const pct = value => `${+(Math.abs(value) * 100).toFixed(2)}%`;
const signed = value => (value >= 0 ? '+' : '-');

/**
 * 一筆加成給玩家看的說明。措辭與寶石一致：加算與乘算用不同說法並標註。
 * @returns {{ kind: 'stat', text: string }}
 */
function describeStatBonus(bonus) {
  assertValidBonuses([bonus]);
  const def = STAT_DEFS[bonus.stat];
  const up = bonus.value >= 0;
  switch (bonus.op) {
    case 'flat':
      return { kind: 'stat', text: `${def.name} ${signed(bonus.value)}${def.display === 'percent' ? pct(bonus.value) : +Math.abs(bonus.value).toFixed(2)}` };
    case 'inc':
      return { kind: 'stat', text: `${def.name}${up ? '提高' : '降低'} ${pct(bonus.value)}（加算）` };
    default:
      return { kind: 'stat', text: `${def.name}額外${up ? '增加' : '減少'} ${pct(bonus.value)}（乘算）` };
  }
}

module.exports = { STAT_DEFS, BONUS_OPS, validateBonuses, validateBuffBonuses, statModifier, explainStatBonuses, applyStatBonuses, describeStatBonus };
