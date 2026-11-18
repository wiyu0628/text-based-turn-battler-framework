// 寶石版快速開始：與 quickstart.js 完全相同，只有「new Skill 的部分」改成由寶石編譯。
// 執行：node gem/gems-quickstart.js                     （預設：魔法飛彈 連結 強力 + 感電）
//       node gem/gems-quickstart.js pierce lean        （自訂輔助寶石，預設主動寶石是魔法飛彈）
//       node gem/gems-quickstart.js whirlwind leech     （第一個參數若是主動寶石 id，就改用它）
const { Entity, Skill, BattleEngine } = require('../src'); // 你的專案裡寫 require('text-based-turn-battler-framework')
const { compileLoadout, GemLinkError } = require('./gemCompiler');
const { ACTIVE_GEMS, SUPPORT_GEMS, MAX_SUPPORTS } = require('./gems');

// 技能是一串 actions，引擎依序執行。DAMAGE 預設打一個敵人，傷害 = atk × power（再扣防禦）。
const slash = new Skill({ id: 'slash', name: '斬擊', actions: [{ type: 'DAMAGE' }] });
// ↓ 這是唯一的改動：魔法飛彈不再手寫 new Skill，而是用「主動寶石 + 輔助寶石」編譯出來。
const args = require.main === module ? process.argv.slice(2) : [];
const ACTIVE = ACTIVE_GEMS[args[0]] ? args.shift() : 'magicmissile';
const LINKS = args.length ? args : ['heavy', 'shock'];
// compileLoadout 同時給出 skills 與 passives（例如汲取的回血被動），兩者都要交給 Entity。
// 被動帶有戰鬥狀態，每場戰鬥都要重新編譯一次。
function compileOrExit() {
  try {
    return compileLoadout([{ active: ACTIVE, supports: LINKS }]);
  } catch (error) {
    // 從命令列執行時，連結不合法只印一行中文原因與可用的寶石，不顯示堆疊追蹤。
    // 被別的檔案 require 時照常丟出錯誤，讓呼叫端自己處理。
    if (!(error instanceof GemLinkError) || require.main !== module) throw error;
    const list = gems => Object.entries(gems).map(([id, gem]) => `${id}（${gem.name}）`).join('、');
    console.error(error.message);
    console.error(`用法：node gem/gems-quickstart.js [主動寶石] [輔助寶石…]（最多 ${MAX_SUPPORTS} 顆）`);
    console.error(`主動寶石：${list(ACTIVE_GEMS)}`);
    console.error(`輔助寶石：${list(SUPPORT_GEMS)}`);
    process.exit(1);
  }
}
const loadout = compileOrExit();
const claw = new Skill({ id: 'claw', name: '利爪', actions: [{ type: 'DAMAGE' }] });

const hero = new Entity({
  id: 'hero', name: '勇者', team: 'A',
  stats: { hp: 2000, sp: 120, atk: 150, int: 150, def: 50, spd: 120, cri: 0.2 }, // int：法術吃智力
  normalAttackSpCost: 2, // 普攻每擊扣 2 SP（框架預設是 1）
  normalAttack: slash,
  skills: loadout.skills, // 寶石編譯出的技能；每個行動槽預設 35% 機率從這裡抽一招（stats.skillCastRate）
  passives: loadout.passives, // 寶石附帶的被動（沒有 reaction 類寶石時是空陣列）
});
const boss = new Entity({
  id: 'boss', name: '魔王', team: 'B',
  stats: { hp: 2100, sp: 120, atk: 130, int: 130, def: 80, spd: 90, cri: 0.1 },
  normalAttackSpCost: 2,
  normalAttack: claw,
  dialogues: { opening: '區區人類。', death: '不可能……' }
});

// 一次跑完整場戰鬥，回傳勝負與完整戰報。
// 蓄力寶石靠 skillSelectionResolver 在下一個行動槽釋放；沒有蓄力時傳了也無害。
const result = new BattleEngine([hero], [boss], { skillSelectionResolver: loadout.resolver }).start();

if (require.main === module) {
  for (const log of result.logs) console.log(log.message);
  console.log(`\n獲勝方：${result.winner}（TEAM_A / TEAM_B / DRAW）`);
}

module.exports = result;
