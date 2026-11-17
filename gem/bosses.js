'use strict';

/**
 * 王（第四階段第 10 項）。**王本身是佔位**：使用者要自己設計，之後會整個換掉，所以這裡只做換王也不用改的架構。
 *
 * ── 規則（使用者決定）──────────────────────────────────────────
 *   王有**獨立按鈕**，不用進地區就能直接打；所有地區共用同一串王。
 *   王的**難度固定**；**擊敗後出現下一隻王**（BOSSES 的順序），**舊王可以回頭再打**。
 *   第一隻王大約抓「**難度 6 有機會過**」。
 *   額外獎勵還沒想好，目前考慮**開啟新地區**：首次擊敗的 rewards 支援 unlockRegions 與 gems。
 *
 * ── 資料格式 ──────────────────────────────────────────────────
 *   { id, name, difficulty, placeholder?, monsters: [怪物定義…], rewards: { gems?: [主動寶石 id], unlockRegions?: [地區 id] } }
 *   monsters 的每一隻用 monsters.js 的同一套格式（stats 是基準怪倍率、skills、traits），用 buildFromDef 建；
 *   難度縮放（difficulty.scaleMonster）照樣套用，所以王的倍率是「在它的難度下」相對基準怪的強度。
 *   王戰不套強度預算（王是單獨設計的關卡）。
 *
 * ── 佔位王「廢都守門者」的數值怎麼定的（node gem/boss-check.js）──────────
 *   目標：難度 6、拿第 2 階整套（講究配方）「有機會過」；只拿第 1 階整套很難贏。
 *   生命 1.6、攻擊 0.8 倍時（各約 150 場）：物理（旋風斬）第 1／2／3 階 0%／29%／99%；法術（魔法飛彈）3%／93%／100%。
 *   流派差距大：旋風斬是群攻，對單體只有 0.9 倍，魔法飛彈單體 1.5 倍；單隻王特別偏向單體技能。屬於技能平衡（第 12 項）。
 */

const { buildFromDef } = require('./monsters');

const BOSSES = [
  {
    id: 'gatekeeper',
    name: '廢都守門者',
    difficulty: 6,
    placeholder: true,
    monsters: [{
      id: 'gatekeeper', name: '廢都守門者',
      stats: { hp: 1.6, atk: 0.8, def: 80, spd: 85 },
      skillCastRate: 0.4,
      skills: [
        { kind: 'attack', id: 'cleave', name: '重劈', from: 1, spCost: 15, power: 1.8, target: 'single' },
        { kind: 'attack', id: 'sweep', name: '橫掃', from: 1, spCost: 15, power: 1.1, target: 'all' },
        { kind: 'buff', id: 'roar', name: '戰吼', from: 1, spCost: 10, target: 'enemy', stat: 'atk', mult: 0.8, duration: 2 }
      ],
      traits: [{ kind: 'enrage', at: 0.3, stat: 'atk', mult: 1.3, text: '{caster} 的眼中燃起紅光，攻勢變得更加猛烈！' }]
    }],
    rewards: { gems: ['pursuit'], unlockRegions: [] }
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
