'use strict';

/**
 * 寶石平衡模擬：把每個「主動寶石 + 輔助寶石」組合放進固定的對戰情境，比較它們彼此之間的相對強度。
 *
 * 這個腳本能回答的（相對的、結構上的問題）：
 *   - 哪些組合遠高於或遠低於「不連結任何輔助寶石」的基準？（離群組合）
 *   - 每顆輔助寶石平均讓傷害與 SP 效率上升還是下降？（平均貢獻；兩項都低於 1 的是「拖累」寶石）
 *   - 同一組寶石在單體與群體情境下差多少？（擴散、聚焦這類寶石的價值會隨情境翻轉）
 *
 * 它不能回答的：絕對數值對不對、遊戲整體難度、尚未實作的寶石、等級／裝備／敵人種類等遊戲的其他部分。
 * 所有數字都建立在下面 CONFIG 的假設上，而寶石數值本身也只是佔位——請把輸出當成「找出明顯離譜的組合」的工具，
 * 不要當成最終平衡的答案。
 *
 * 執行：node gem/gems-balance.js [選項]
 *   --battles=40         每個組合、每個情境的場數（所有組合共用同一批種子，比較時雜訊較小）
 *   --turns=12           每場回合數上限
 *   --cast=1             勇者的 skillCastRate。1 = 每個行動槽只要付得起就放技能，量的是「技能本身」的強度；
 *                        想看接近實戰的出招頻率就改成 0.35
 *   --sp=240             勇者起始 SP（影響消耗類寶石與疲勞）
 *   --attack-sp=2        雙方普攻每擊扣的 SP（與技能共用 SP，所以會影響技能能放幾次）
 *   --active=magicmissile,whirlwind   要測的主動寶石（治癒術沒有傷害，不在預設裡）
 *   --max-supports=3     最多連結幾顆輔助寶石（預設 MAX_SUPPORTS）
 *   --exclude-active=a,b   剔除這些主動寶石（先套用 --active，再剔除）
 *   --exclude-support=a,b  剔除這些輔助寶石：不會出現在任何組合裡，也不列在平均貢獻表
 *   --lock=a,b             鎖定這些輔助寶石：每個組合都一定連結它們，其餘的位置才從剩下的寶石裡挑。
 *                          用來回答「已經決定要用強力 + 感電，第三顆放什麼最好？」。
 *                          鎖定時，排行與倍率改以「只連結鎖定寶石」為基準（基準段會同時列出無輔助的數字）；
 *                          鎖定寶石彼此互斥、或鎖定寶石與某個主動寶石不相容時，會說明原因並略過那個主動寶石。
 *   --top=12             排行榜列出幾個組合
 *   --csv=balance.csv    把所有結果寫成 CSV，方便用試算表看
 * 每個組合都用 compileLoadout 重新編譯（被動帶有戰鬥狀態），並傳入 loadout.resolver，所以蓄力也能正確釋放。
 */
const fs = require('fs');
const { Entity, Skill, BattleEngine, createSeededRandom } = require('../src');
const { ACTIVE_GEMS, SUPPORT_GEMS, MAX_SUPPORTS } = require('./gems');
const { compileLoadout, GemLinkError } = require('./gemCompiler');

// ── 假設（可以直接改）────────────────────────────────────────

const CONFIG = {
  hero: { hp: 6000, sp: 240, atk: 150, int: 150, def: 50, spd: 100, cri: 0.1, skillCastRate: 1 },
  foe: { hp: 1e7, sp: 200, atk: 90, def: 50, spd: 100, cri: 0 },   // 血量極大：量的是輸出，不是擊殺時間
  attackSpCost: 2,   // 雙方普攻每擊扣的 SP（框架預設是 1；初始 SP 也已經是舊預設的 2 倍）
  scenarios: [
    { id: 'duel', name: '單體（1 隻）', foes: 1 },
    { id: 'pack', name: '群體（3 隻）', foes: 3 }
  ],
  battles: 40,
  turns: 12,
  top: 12,
  flag: { high: 2.0, low: 0.6, drag: 0.97 }   // 離群門檻（相對基準的倍數）與「拖累」門檻（平均貢獻）
};

// ── 參數 ─────────────────────────────────────────────────────

const argv = Object.fromEntries(process.argv.slice(2)
  .filter(arg => arg.startsWith('--'))
  .map(arg => { const [key, ...rest] = arg.slice(2).split('='); return [key, rest.join('=') || 'true']; }));
const num = (key, fallback) => (argv[key] !== undefined && Number.isFinite(Number(argv[key]))) ? Number(argv[key]) : fallback;

CONFIG.battles = num('battles', CONFIG.battles);
CONFIG.turns = num('turns', CONFIG.turns);
CONFIG.top = num('top', CONFIG.top);
CONFIG.hero = { ...CONFIG.hero, skillCastRate: num('cast', CONFIG.hero.skillCastRate), sp: num('sp', CONFIG.hero.sp) };
CONFIG.attackSpCost = num('attack-sp', CONFIG.attackSpCost);
const MAX_LINKS = num('max-supports', MAX_SUPPORTS);
const list = text => (text || '').split(',').map(id => id.trim()).filter(Boolean);
const fail = message => { console.error(message); process.exit(1); };
const checkIds = (ids, table, kind) => {
  for (const id of ids) if (!table[id]) fail(`找不到${kind}「${id}」。可用：${Object.keys(table).join('、')}`);
};

const EXCLUDE_ACTIVE = list(argv['exclude-active']);
const EXCLUDE_SUPPORT = list(argv['exclude-support']);
const LOCK = [...new Set(list(argv.lock))].sort();
const requestedActives = list(argv.active || 'magicmissile,whirlwind');
checkIds(requestedActives, ACTIVE_GEMS, '主動寶石');
checkIds(EXCLUDE_ACTIVE, ACTIVE_GEMS, '主動寶石');
checkIds(EXCLUDE_SUPPORT, SUPPORT_GEMS, '輔助寶石');
checkIds(LOCK, SUPPORT_GEMS, '輔助寶石');
const lockedAndExcluded = LOCK.filter(id => EXCLUDE_SUPPORT.includes(id));
if (lockedAndExcluded.length) fail(`「${lockedAndExcluded.join('、')}」同時被鎖定與剔除，請擇一。`);
if (LOCK.length > MAX_LINKS) fail(`鎖定了 ${LOCK.length} 顆輔助寶石，超過連結上限 ${MAX_LINKS}。`);
const ACTIVES = requestedActives.filter(id => !EXCLUDE_ACTIVE.includes(id));
if (!ACTIVES.length) fail('剔除之後沒有剩下任何主動寶石可以測。');

const plain = new Skill({ id: 'plain', name: '普攻', actions: [{ type: 'DAMAGE' }] });

// ── 列舉合法組合 ─────────────────────────────────────────────

const supportIds = Object.keys(SUPPORT_GEMS).sort().filter(id => !EXCLUDE_SUPPORT.includes(id));
const freeIds = supportIds.filter(id => !LOCK.includes(id));   // 鎖定以外、可以自由挑的

function* subsets(items, size, start = 0, chosen = []) {
  if (chosen.length === size) { yield [...chosen]; return; }
  for (let i = start; i < items.length; i++) {
    chosen.push(items[i]);
    yield* subsets(items, size, i + 1, chosen);
    chosen.pop();
  }
}

const key = (active, supports) => `${active}|${supports.join('+')}`;
const makeCombo = (active, supports) => {
  const { compiled: [result] } = compileLoadout([{ active, supports }]);   // 不合法會丟 GemLinkError
  return { active, supports, spCost: result.spCost, damageFactor: result.damageFactor };
};
const combos = [];                // 要排名的組合（有鎖定時，每個都包含鎖定寶石）
const comboByKey = new Map();     // 含「無輔助」的對照組，平均貢獻要用
const skipped = [];               // 因為鎖定而無法測的主動寶石與原因
let rejected = 0;
const addCombo = (combo, ranked) => { comboByKey.set(key(combo.active, combo.supports), combo); if (ranked) combos.push(combo); };

for (const active of ACTIVES) {
  addCombo(makeCombo(active, []), !LOCK.length);          // 無輔助的對照組；沒鎖定時它也是排名裡的基準
  if (LOCK.length) {
    try { makeCombo(active, LOCK); } catch (error) {
      if (!(error instanceof GemLinkError)) throw error;
      skipped.push({ active, reason: error.message });
      continue;
    }
  }
  for (let extra = 0; extra <= MAX_LINKS - LOCK.length; extra++) {
    for (const chosen of subsets(freeIds, extra)) {
      const supports = [...LOCK, ...chosen].sort();
      if (!supports.length) continue;                     // 無輔助的組合上面已經加過
      try { addCombo(makeCombo(active, supports), true); } catch (error) {
        if (!(error instanceof GemLinkError)) throw error;
        rejected++;
      }
    }
  }
}
const testedActives = ACTIVES.filter(id => !skipped.some(item => item.active === id));
if (!testedActives.length) fail(`鎖定「${LOCK.map(id => SUPPORT_GEMS[id].name).join(' + ')}」後，沒有任何主動寶石可以連結：\n${skipped.map(item => `  ${ACTIVE_GEMS[item.active].name}：${item.reason}`).join('\n')}`);

// ── 跑戰鬥 ───────────────────────────────────────────────────

function runBattle(combo, scenario, seed) {
  const loadout = compileLoadout([{ active: combo.active, supports: combo.supports }]);
  const hero = new Entity({
    id: 'hero', name: '勇者', team: 'A', normalAttack: plain, normalAttackSpCost: CONFIG.attackSpCost,
    skills: loadout.skills, passives: loadout.passives, stats: { ...CONFIG.hero }
  });
  const foes = Array.from({ length: scenario.foes }, (_, index) => new Entity({
    id: `foe${index}`, name: `魔物${index + 1}`, team: 'B', normalAttack: plain, normalAttackSpCost: CONFIG.attackSpCost, stats: { ...CONFIG.foe }
  }));
  const engine = new BattleEngine([hero], foes, {
    rng: createSeededRandom(seed), maxTurns: CONFIG.turns, skillSelectionResolver: loadout.resolver
  });
  const { logs } = engine.start();
  const shellId = loadout.skills[0].id;
  let damage = 0, heal = 0, turns = 0;
  for (const log of logs) {
    if (log.type === 'TURN_START') turns++;
    else if (log.type === 'DAMAGE' && log.actorId === 'hero') damage += log.value;
    else if (log.type === 'HEAL' && log.actorId === 'hero' && log.targetId === 'hero') heal += log.value;
  }
  const casts = engine.actionSlots.filter(slot => slot.actor === hero && slot.skill.id === shellId).length;
  return { damage, heal, turns, spent: casts * combo.spCost, alive: hero.isAlive ? 1 : 0 };
}

function evaluate(combo, scenario) {
  const total = { damage: 0, heal: 0, turns: 0, spent: 0, alive: 0 };
  for (let seed = 1; seed <= CONFIG.battles; seed++) {
    const one = runBattle(combo, scenario, seed);
    for (const field of Object.keys(total)) total[field] += one[field];
  }
  return {
    dmg: total.damage / Math.max(1, total.turns),                 // 每回合傷害
    eff: total.spent > 0 ? total.damage / total.spent : NaN,      // 每 1 SP（只算技能的消耗）造成的傷害
    heal: total.heal / Math.max(1, total.turns),                  // 每回合回血
    alive: total.alive / CONFIG.battles                           // 撐到最後的比例
  };
}

for (const item of skipped) console.error(`略過 ${ACTIVE_GEMS[item.active].name}：${item.reason}`);
const toEvaluate = [...comboByKey.values()].filter(combo => testedActives.includes(combo.active));
console.error(`組合 ${combos.length} 個（另有 ${rejected} 個被連結規則拒絕）× 情境 ${CONFIG.scenarios.length} × ${CONFIG.battles} 場，執行中…`);
const started = Date.now();
const results = new Map();    // `${scenario}|${key}` → metrics
for (const scenario of CONFIG.scenarios) {
  for (const combo of toEvaluate) results.set(`${scenario.id}|${key(combo.active, combo.supports)}`, evaluate(combo, scenario));
}
console.error(`完成，用了 ${((Date.now() - started) / 1000).toFixed(1)} 秒。\n`);

const metric = (scenario, combo) => results.get(`${scenario.id}|${key(combo.active, combo.supports)}`);
const plainOf = (scenario, active) => metric(scenario, comboByKey.get(key(active, [])));      // 完全不連結
const baselineOf = (scenario, active) => metric(scenario, comboByKey.get(key(active, LOCK)));  // 排名用的基準：有鎖定就是「只連結鎖定寶石」

// ── 報表 ─────────────────────────────────────────────────────

const pad = (text, width) => { const s = String(text); const w = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, width - w)); };
const fx = value => Number.isFinite(value) ? `×${value.toFixed(2)}` : '   - ';
const geoMean = values => values.length ? Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length) : NaN;
const label = combo => `${ACTIVE_GEMS[combo.active].name}${combo.supports.length ? ' + ' + combo.supports.map(id => SUPPORT_GEMS[id].name).join(' + ') : '（無輔助）'}`;
const names0 = ids => ids.map(id => ACTIVE_GEMS[id].name).join('、');
const heading = text => console.log(`\n== ${text} ==`);

console.log('寶石平衡模擬（所有數值皆為佔位；請當成找離群組合的工具，不是最終平衡）');
console.log(`勇者 ${JSON.stringify(CONFIG.hero)}；敵人 ${JSON.stringify(CONFIG.foe)}；普攻每擊 ${CONFIG.attackSpCost} SP；${CONFIG.battles} 場 × ${CONFIG.turns} 回合；固定種子可重現`);
const names = ids => ids.map(id => SUPPORT_GEMS[id].name).join('、');
console.log(`測試的主動寶石：${names0(testedActives)}`);
if (EXCLUDE_ACTIVE.length) console.log(`剔除的主動寶石：${names0(EXCLUDE_ACTIVE)}`);
if (EXCLUDE_SUPPORT.length) console.log(`剔除的輔助寶石：${names(EXCLUDE_SUPPORT)}`);
if (LOCK.length) console.log(`鎖定的輔助寶石：${names(LOCK)}（每個組合都包含；其餘 ${MAX_LINKS - LOCK.length} 個位置從 ${freeIds.length} 顆裡挑）`);

heading(LOCK.length ? '基準（排名用的是「只連結鎖定寶石」；括號是完全不連結）' : '基準（不連結輔助寶石）');
for (const active of testedActives) {
  for (const scenario of CONFIG.scenarios) {
    const base = baselineOf(scenario, active), plainBase = plainOf(scenario, active);
    const lockNote = LOCK.length ? `（無輔助 ${plainBase.dmg.toFixed(0)}，鎖定後 ${fx(base.dmg / plainBase.dmg)}）` : '';
    console.log(`${pad(ACTIVE_GEMS[active].name, 10)} ${pad(scenario.name, 14)} 每回合傷害 ${base.dmg.toFixed(0).padStart(6)}  每 SP 傷害 ${base.eff.toFixed(1).padStart(6)}  撐到最後 ${(base.alive * 100).toFixed(0)}% ${lockNote}`);
  }
}

heading(`每顆輔助寶石的平均貢獻（有它 ÷ 沒它，同一組其他寶石不變；×1.00 = 沒影響）${LOCK.length ? '——鎖定的寶石不列，以下都是「鎖定之外」的第 N 顆' : ''}`);
console.log('兩項都低於 ' + CONFIG.flag.drag + ' 且沒有額外回血才標「拖累」；條件型寶石（擴散、聚焦…）請同時看兩個情境。');
console.log('佈局、撒手鐧這類「時機型」寶石的價值不在傷害數字裡（勇者出招率預設 1，佈局幾乎不會有差），看到 ×1.00 是正常的。');
for (const active of testedActives) {
  console.log(`\n【${ACTIVE_GEMS[active].name}】                    ${CONFIG.scenarios.map(s => pad(s.name + ' 傷害/SP效率', 28)).join('')}`);
  const rows = [];
  for (const id of freeIds) {
    const cells = CONFIG.scenarios.map(scenario => {
      const dmg = [], eff = [], heal = [];
      for (const combo of combos) {
        if (combo.active !== active || !combo.supports.includes(id)) continue;
        const without = comboByKey.get(key(active, combo.supports.filter(other => other !== id)));
        if (!without) continue;
        const a = metric(scenario, combo), b = metric(scenario, without);
        heal.push(a.heal - b.heal);
        if (b.dmg > 0) dmg.push(a.dmg / b.dmg);
        if (Number.isFinite(a.eff) && Number.isFinite(b.eff) && b.eff > 0) eff.push(a.eff / b.eff);
      }
      return { dmg: geoMean(dmg), eff: geoMean(eff), heal: heal.reduce((sum, v) => sum + v, 0) / Math.max(1, heal.length), n: dmg.length };
    });
    if (!cells[0].n) { rows.push(`${pad(SUPPORT_GEMS[id].name, 10)} （無法與此主動寶石或鎖定的寶石一起連結）`); continue; }
    const drag = cells.every(cell => cell.dmg < CONFIG.flag.drag && cell.eff < CONFIG.flag.drag && cell.heal < 1);
    const healNote = cells.some(cell => cell.heal >= 1) ? `  回血 +${cells.map(cell => cell.heal.toFixed(0)).join('/')}/回合` : '';
    rows.push(`${pad(SUPPORT_GEMS[id].name, 10)} ${cells.map(cell => pad(`${fx(cell.dmg)} / ${fx(cell.eff)}`, 28)).join('')}${drag ? ' ← 拖累' : ''}${healNote}`);
  }
  console.log(rows.join('\n'));
}

for (const scenario of CONFIG.scenarios) {
  const rows = combos.filter(combo => testedActives.includes(combo.active)).map(combo => {
    const base = baselineOf(scenario, combo.active);
    const m = metric(scenario, combo);
    return { combo, m, rDmg: m.dmg / base.dmg, rEff: m.eff / base.eff };
  }).filter(row => row.combo.supports.length > LOCK.length);
  const show = list => list.forEach(({ combo, m, rDmg, rEff }) => console.log(
    `${pad(label(combo), 44)} 傷害 ${fx(rDmg)}  效率 ${fx(rEff)}  回血 ${m.heal.toFixed(0).padStart(4)}/回合  撐到最後 ${(m.alive * 100).toFixed(0).padStart(3)}%`));
  heading(`${scenario.name}：相對${LOCK.length ? '鎖定基準' : '基準'}最強的 ${CONFIG.top} 個組合`);
  show([...rows].sort((a, b) => b.rDmg - a.rDmg).slice(0, CONFIG.top));
  heading(`${scenario.name}：相對${LOCK.length ? '鎖定基準' : '基準'}最弱的 ${CONFIG.top} 個組合`);
  show([...rows].sort((a, b) => a.rDmg - b.rDmg).slice(0, CONFIG.top));
  const high = rows.filter(row => row.rDmg > CONFIG.flag.high).length;
  const low = rows.filter(row => row.rDmg < CONFIG.flag.low).length;
  console.log(`\n離群：傷害高於基準 ${CONFIG.flag.high} 倍的有 ${high} 個、低於 ${CONFIG.flag.low} 倍的有 ${low} 個（共 ${rows.length} 個組合）`);
  // 同一組合相比，輔助越多是否越強：幫忙看「連結上限是不是太寬或太緊」
  const bySize = Array.from({ length: MAX_LINKS - LOCK.length }, (_, index) => index + 1).map(extra => {
    const values = rows.filter(row => row.combo.supports.length === LOCK.length + extra).map(row => row.rDmg);
    return values.length ? `${LOCK.length ? '再加 ' : ''}${extra} 顆平均 ${fx(geoMean(values))}（最高 ${fx(Math.max(...values))}）` : null;
  }).filter(Boolean);
  console.log(`依${LOCK.length ? '鎖定之外的' : ''}連結數量：${bySize.join('；')}`);
}

if (argv.csv) {
  const lines = ['active,supports,scenario,spCost,damageFactor,dmgPerTurn,dmgPerSp,healPerTurn,alive,ratioDmg,ratioEff,ratioDmgVsPlain'];
  for (const scenario of CONFIG.scenarios) {
    for (const combo of toEvaluate) {
      const m = metric(scenario, combo), base = baselineOf(scenario, combo.active), plainBase = plainOf(scenario, combo.active);
      lines.push([combo.active, combo.supports.join('+'), scenario.id, combo.spCost, combo.damageFactor,
        m.dmg.toFixed(2), m.eff.toFixed(3), m.heal.toFixed(2), m.alive.toFixed(3), (m.dmg / base.dmg).toFixed(3), (m.eff / base.eff).toFixed(3), (m.dmg / plainBase.dmg).toFixed(3)].join(','));
    }
  }
  fs.writeFileSync(argv.csv, lines.join('\n') + '\n');
  console.log(`\n已寫入 ${argv.csv}（${lines.length - 1} 列）`);
}
