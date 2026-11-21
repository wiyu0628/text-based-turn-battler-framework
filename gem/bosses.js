'use strict';

/**
 * 王（第四階段第 10 項）。第一隻王「廢都中央廳」是使用者設計的（2026-11-20），取代佔位的「廢都守門者」（id 沿用 gatekeeper）。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   王有**獨立按鈕**，不用進地區就能直接打；所有地區共用同一串王。
 *   王的**難度固定**；**擊敗後出現下一隻王**（BOSSES 的順序），**舊王可以回頭再打**。
 *   第一隻王大約抓「**難度 6 有機會過**」。
 *   額外獎勵還沒想好，目前考慮**開啟新地區**：首次擊敗的 rewards 支援 unlockRegions 與 gems。
 *
 * ── 資料格式 ──────────────────────────────────────────────────
 *   { id, name, difficulty, placeholder?, monsters: [怪物定義…], rewards: { gems?: [主動寶石 id], unlockRegions?: [地區 id], accessories?: [飾品 id] }, area?: 第幾區（掉落池用，沒寫＝1） }
 *   monsters 的每一隻用 monsters.js 的同一套格式（stats 是基準怪倍率、skills、traits），用 buildFromDef 建；
 *   難度縮放（difficulty.scaleMonster）照樣套用，所以王的倍率是「在它的難度下」相對基準怪的強度。
 *   王戰不套強度預算（王是單獨設計的關卡）。
 *
 * ── 「廢都中央廳」的數值怎麼定的（node gem/boss-check.js gatekeeper 240）──────────
 *   目標：難度 6、拿第 2 階整套（講究配方）「有機會打贏」；第 1 階打不贏、第 3 階穩贏。
 *   生命 1.7、攻擊 0.65、智力 0.65、速度 160、SP 1000（2026-11-20 技能開始扣 SP 後調整）；電光 80%＋麻痺（速度 ×0.75，2 槽）；五重魔法飛彈每發 30%；
 *   半血：速度 ×1.5、攻擊與智力 ×1.15，召喚應急動力源（使用者：18% 生命、同防禦、減傷 40%，打倒後中央廳受 30%）。
 *   第 2 階：物理旋風斬 60%、物理撕裂 63%、法術魔法飛彈 76%；第 1 階都是 0%、第 3 階都是 100%（240 場；動力源改扣 SP、技能扣 SP 之後）。
 *   （減傷 60% 時生命 1.4 是 53%／75%／82%；改成 40% 後同生命變成 84%／92%／98%，所以生命調到 1.7。）
 *   （舊的守門者：旋風斬 34%、法術 89%。動力源讓群攻有發揮空間，旋風斬比較打得動。）
 */

const { buildFromDef } = require('./monsters');

const BOSSES = [
  {
    // 第一區王「廢都中央廳」（使用者設計，2026-11-20）。id 沿用 gatekeeper：存檔的 defeatedBosses 與 v6／v7 遷移都記這個 id。
    // 數值是我擬的初版（用 boss-check.js 調）；旁白是使用者寫的（電光落空句是我寫、使用者確認）。
    id: 'gatekeeper',
    name: '廢都中央廳',
    difficulty: 6,
    monsters: [{
      id: 'centralhall', name: '中央廳',
      stats: { hp: 1.7, atk: 0.65, int: 0.65, def: 80, spd: 160, sp: 1000 },   // sp 1000：技能開始扣 SP 後，讓勝率維持修正前的水準
      skillCastRate: 0.4,
      normalAttackText: '中央廳的雕像揮出長矛，',
      // 旁白（使用者寫，2026-11-20）。death＝中央廳倒下（玩家獲勝）、victory＝中央廳打贏（玩家戰敗）；{player} 是玩家的名字
      texts: {
        opening: [
          '廢都的正中央，有座格格不入的建築。與周圍的斷垣殘壁相比，這座殿堂顯得過於華麗。',
          '{player}走進殿堂的那一刻，燈光一齊亮了起來，空曠的大廳、持矛的雕像以及無數精細的魔力刻痕映入眼簾。',
          '{player}的腦中浮現一段地名，如同本就從未忘記過一般：',
          '哲人之城，尤絲菲婭。'
        ],
        death: '隨著所有魔法陣一同熄滅，雕像也停下了動作。在一片漆黑之中，浮現了一個傳送魔法陣。',
        victory: '中央廳回歸黑暗，不知何處傳來了輕聲的嘆息。'
      },
      skills: [
        { kind: 'attack', id: 'lightning', name: '電光', from: 1, spCost: 15, spell: true, target: 'all', power: 0.8,
          intro: '中央廳地板上的魔法陣高速運轉，無數道雷光從魔法陣竄出——', text: '雷光穿過', hitText: '{target}，造成了 {value} 點傷害！', missText: '空氣，{target}閃開了！',
          debuff: { name: '麻痺', stat: 'spd', mult: 0.75, duration: 2, text: '{target}的手腳一陣麻痺！' } },
        { kind: 'attack', id: 'fivemissiles', name: '五重魔法飛彈', from: 1, spCost: 20, spell: true, target: 'random', hits: 5, power: 0.3,
          intro: '牆邊的魔法陣亮起，同時生成了五發魔法飛彈——', hitTexts: ['第一發，', '第二發，', '第三發，', '第四發，', '第五發，'] }
      ],
      traits: [{
        kind: 'phase', at: 0.5, mults: { spd: 1.5, atk: 1.15, int: 1.15 },
        text: '強烈的魔力瞬間湧入牆上的魔法陣，刺眼的紅光籠罩著整個中央廳！',
        // 應急動力源：中央廳最大生命 18%、同防禦、減傷 40%（使用者 2026-11-20：60% → 40%，打它和打本體收益持平）；打倒後對中央廳造成其最大生命 30%
        summon: { name: '應急動力源', hpRatio: 0.18, reduction: 0.4, spd: 50, breakRatio: 0.3,
          summonText: '隱藏於天花板的應急動力源啟動了。', breakText: '從應急動力源傾瀉而出的魔力反噬了中央廳的線路！',
          // 使用者 2026-11-20：動力源只會用「扣玩家 6 點 SP」的招式（原本規劃的半血第三招移到這裡）
          drain: { sp: 6, name: '魔力汲取', text: '{caster}吸收了{target}的{value}點SP。' } }
      }]
    }],
    rewards: { gems: ['pursuit', 'firestorm'], unlockRegions: ['hall'], accessories: ['hourglass'] }   // 「烈風爪痕」的碎片 2026-11-20（使用者：首次打王固定掉飾品）
  }
];

function findBoss(bossId) {
  const boss = BOSSES.find(b => b.id === bossId);
  if (!boss) throw new Error(`找不到王「${bossId}」`);
  return boss;
}

/** 建一場王戰：回傳 { monsters: Entity[], difficulty }。 */
function buildBossEncounter(bossId) {
  const boss = findBoss(bossId);
  const monsters = boss.monsters.map((def, i) => buildFromDef(def, boss.difficulty, { id: `boss_${def.id}_${i + 1}` }));
  return { monsters, difficulty: boss.difficulty };
}

module.exports = { BOSSES, findBoss, buildBossEncounter };
