'use strict';

/**
 * 技能串接寶石資料 v18（6 顆主動寶石 + 17 顆輔助寶石 + 互斥組 + 連結上限）
 *
 * v18（2026-11-19）：新增主動寶石火焰風暴 firestorm（critEcho：依爆擊率額外釋放 50%，打 Boss 取得）、
 *   輔助寶石迴響 echo（wrap kind 'echo'：開啟後每回合開始自動釋放），使用者設計。
 *
 * v17（2026-11-19）：新增追擊 followup（grant kind comboCast：普攻 3 連擊以上時免費施放），使用者設計。
 *
 * v16（2026-11-19）：新增法術會心 spellcrit（op critAsDamage）、暴怒 rage（op condInc）、吸魔 drain（reaction drainSp），使用者設計。
 *
 * v15（2026-11-19）：連擊改名迅擊（id multistrike 不變）；移除乘勢 oncrit（存檔 v4 → v5 刪除）；
 *   每顆寶石加上 desc（背包說明第二行，使用者指定句子；{佔位} 由 effects 算出，見 gemCompiler.describePlayer）。
 *
 * v14（2026-11-19）：新增連擊 multistrike（使用者設計：原本與追加的一擊都是 45%，全部附加異常與感電）、
 *   乘勢 oncrit（暴擊時 30% 機率免費施放；觸發時機使用者沒有指定，用我建議的「暴擊時」）。
 *
 * v13（2026-11-18）：移除擴散 wide（使用者決定）。存檔 v3 → v4 的遷移會刪掉背包與裝備上的擴散（saveLayer.js MIGRATIONS[3]）。
 * 移除寶石時一定要同時寫存檔遷移：讀檔遇到不認得的寶石會報錯、不會自動丟掉。
 *
 * 純資料、不含函式，可直接 JSON 序列化。
 * 這份檔案只定義「寶石是什麼」；怎麼編譯成 Skill 見 gemCompiler.js。
 * 所有數值都是佔位，需要用模擬調整。
 *
 * ── 輔助寶石沒有順序（與 PoE 相同）─────────────────────────────
 * 同一組輔助寶石不論插槽怎麼排，編譯出的技能（合法與否、技能 id、動作串、數值）完全相同。
 * 為了做到這點，編譯器遵守下面五條規則；新增寶石時請一併遵守：
 *   1. 條件（requires）只看「主動寶石原本的樣子」，不看其他輔助寶石改了什麼。
 *      所以「需要另一顆輔助寶石加上的標籤」這種寫法無效；要表達相依或排斥，請用互斥組或 requires.gems。
 *   2. 所有效果同時作用在主動寶石原本的動作上，彼此不看對方的結果。
 *   3. 兩顆寶石對同一個東西寫入「不同的值」是衝突，整組拒絕（見 scope、actionFlag）；寫入相同的值不算衝突。
 *   4. 追加段落（appendAction）與前置段落（prependAction）的先後，依寶石 id 的字母順序決定；技能 id 也用同樣順序組成。
 *      所以寶石 id 請用穩定的英數字，改 id 等於改技能 id（存檔、已註冊的技能都會對不上）。
 *   5. addTags / removeTags 只會寫進編譯出的技能（給執行期的被動與戰報用），不會影響其他寶石的條件。
 *      一顆寶石加上的標籤被另一顆移除（或反過來）算衝突，整組拒絕。
 * 衝突的錯誤（GemLinkError）一律同時帶 gemId 與 conflictsWith，UI 請把雙方都標出來，
 * 不要只標 gemId：被指出哪一顆是固定的（依 id 字母順序），但不代表另一顆沒有責任。
 *
 * ── 物理與法術 ───────────────────────────────────────────────────
 * 標籤有 'spell' 的主動寶石是法術，其餘是物理（攻擊）。差別直接寫在寶石的動作上，編譯器原樣帶走：
 *   法術  stat: 'int'（吃智力）、uncritable: true（不可暴擊）、uncounterable: true（不可反擊）；一樣被防禦（def）減傷
 *   物理  不寫任何額外欄位：吃 atk、可暴擊
 * 治癒術的回復量讀智力。使用法術的單位一定要有 int（沒有會直接報錯）。沒有魔防：物理與法術都吃防禦。
 * 新增法術寶石時，記得這三個欄位一起寫。爆擊強化連到法術沒有效果（法術本來就不擲爆擊）。
 *
 * ── 傷害加成：加算（inc）與乘算（more）是兩個獨立的 op ─────────────
 * 玩家看到的是兩種不同的措辭，資料裡也是兩個不同的 op，不要混用：
 *
 *   inc   加算（「提高 / 降低 X% 傷害」）
 *         同為加算的寶石先相加，所以不會滾雪球。
 *         兩顆各 +20% → 1 + 0.2 + 0.2 = 1.4 倍
 *   more  乘算（「額外增加 / 額外減少 X% 傷害」）
 *         每一顆都獨立相乘。
 *         兩顆各 +20% → 1.2 × 1.2 = 1.44 倍
 *
 *   最終傷害倍率 = (1 + Σinc) × Π(1 + more)
 *
 * 兩者的 value 寫法一致，都是「增量」：0.3 代表 +30%，-0.15 代表 -15%。
 * 倍率最終必須大於 0（框架把 power 0 當成 1，所以編譯器會直接拒絕）。
 * 背包說明：第一行「與○○技能連結。」依 requires 自動產生，第二行是 desc（可用 {more}{inc}{cost}{ignoreDefense}{leech}{threshold}{chance}{cri} 等佔位）。
 * 逐條規則說明由 describeSupport() 依 effects 自動產生，
 * 數字改了說明就跟著改，不會對不上。
 *
 * ── 編譯流程（約定）──────────────────────────────────────────────
 * 1. 先檢查連結數量：輔助寶石超過 MAX_SUPPORTS 顆就整組拒絕，錯誤指向第一顆放不下的寶石。
 * 2. 同一顆不能連結兩次。之後依寶石 id 字母順序逐顆處理（只是固定順序，不是插槽順序）：
 *    a. 檢查互斥組：同組已經有別顆了，就拒絕。
 *    b. 檢查 requires（對主動寶石原本的樣子）。
 *    c. 通過就併入 addTags，並收集 effects。衝突在這一步被發現。
 * 3. 全部處理完才結算：
 *      原本的傷害段先套用 scope 與 actionFlag
 *      每個 DAMAGE 段的 power = 原 power × 最終傷害倍率（追加的傷害段也算）
 *      總 SP 消耗 = ceil(spCost × Πcost)，原本大於 0 時至少為 1，寫在第一段 action 上
 * 4. 編譯出的技能 id = 主動寶石 id + 排序後的輔助寶石 id，以 '+' 相連，例如 'fireball+heavy+shock'。
 *
 * ── 施放權重（weight）──────────────────────────────────────────
 * compileLoadout 的每一組可以多寫 weight：{ active, supports, weight: 250 }，沒寫就是 DEFAULT_WEIGHT（100）。
 * 引擎先照 skillCastRate 決定「這一槽要不要放技能」，決定放了之後，才輪到權重決定「放哪一個」，所以權重不改變施放頻率。
 * 從「當下可施放」的技能（SP 夠、施放條件成立、沒被沉默）裡，把權重相加後抽數字，權重 ÷ 總和就是機率。
 * 這是相對值：某招 SP 不夠時被排除，其餘招式的機率會跟著等比例變大。
 * 細節與限制見 gemCompiler.js 的 buildWeightResolver。
 *
 * ── 連結上限（MAX_SUPPORTS）───────────────────────────────────
 * 每顆主動寶石最多連結 MAX_SUPPORTS（3）顆輔助寶石。這是整個系統的第二道平衡防線：
 * 每多連結一顆，就少一個位置給別的寶石，所以不必靠互斥把每種「兩邊好處都拿」的組合擋掉。
 * 要改數字只改這個常數；測試或特殊情況也可以在 compileSkill 的 options 傳入 maxSupports 覆寫。
 *
 * ── 互斥組（exclusiveGroup）─────────────────────────────────────
 * 寶石上寫 exclusiveGroup: '組 id'，同一個技能上同組最多連結一顆。
 * 寶石彼此不需要認識：新增一顆寶石只要標上組，就自動與同組互斥，不必修改任何既有寶石。
 * 組的 id 必須先登錄在下面的 GROUPS，拼錯會在載入時被 validateGemData 抓到。
 *
 * ── requires（全部條件都要成立；都是對「主動寶石原本的樣子」判斷）──
 *   tags:   { all: [標籤...], none: [標籤...] }   主動寶石的標籤須包含 all、且不含 none
 *   action: { type, targetType? }                 主動寶石中至少有一段 action 符合
 *                                                 （targetType 省略時，action 未寫的視為框架預設 ENEMY_SINGLE）
 *   gems:   { none: [寶石 id...] }                同一技能上不得連結這些輔助寶石
 *                                                 （會寫死寶石 id，一般互斥請用互斥組，這個只給一次性的特殊規則）
 *
 * ── effects ───────────────────────────────────────────────────────
 *   { op: 'inc',  value }                 加算區增量，作用於所有 DAMAGE 段
 *   { op: 'more', value }                 乘算區增量，作用於所有 DAMAGE 段
 *   { op: 'cost', value }                 SP 消耗增量，與 inc / more 的寫法一致：0.25 = +25%、-0.4 = -40%。
 *                                         多顆彼此相乘：總消耗 = 原消耗 × Π(1 + value)，進位後至少 1（原本大於 0 時）。
 *                                         value 必須大於 -1（-1 代表消耗歸零）。
 *   { op: 'scope', from, to }             把「原本」targetType 等於 from 的傷害段改成 to。
 *                                         兩顆寶石把同一段改成不同的 to 會衝突。
 *   { op: 'actionFlag', flag, value }     在原本的每個 DAMAGE 段上設定旗標（目前只用 ignoreDefense，值是 0～1 的比例）。
 *                                         同一個旗標被兩顆寶石設成不同的值會衝突。
 *   { op: 'appendAction', action, text? } 在動作串尾端追加一段框架 action，格式照框架原樣；
 *                                         text 是給玩家看的說明（編譯器不會送進框架）。
 *                                         追加的 DAMAGE 段吃得到 inc / more，但不受 scope 與 actionFlag 影響
 *                                         （它是獨立的一段；若要它也無視防禦，請在 action 上直接寫）。
 *   { op: 'prependAction', action, text? } 在動作串最前面放一段框架 action（使用技能「之前」發動，戰報也排在技能那一行之前）。
 *                                         其餘規則同 appendAction。前置的是「對自己」的動作時，編譯器會讓原本的第一個動作重新挑目標
 *                                         （框架預設沿用上一個動作的目標，不處理的話傷害會打到自己）。
 *                                         SP 消耗仍算在整個技能上（寫在第一個動作，框架逐動作加總）。
 *   BUFF 動作的 buff 可以寫 statBonuses: [{ stat, op: 'flat'|'inc'|'more', value }]（格式與公式見 statLayer.js；type 必須是 STAT）。
 *   寶石資料是純資料、不能放函式，編譯器會把它轉成框架 STAT Buff 需要的 effect。暫時 Buff 不能改生命與 SP。
 *   Buff 的 duration 以「持有者自己的行動槽」計算（行動槽結束時 -1），不是回合：在施放中掛上 duration 1，
 *   會在這次施放的行動槽結束時消失，剛好涵蓋這次施放的每一擊。框架沒有「整個回合」的 Buff。
 *   寶石沒有常駐的效果：常駐的數值加成只來自裝備與詞綴（statLayer.js 的 applyStatBonuses）。
 *   { op: 'reaction', trigger, scope, do } 在施放者身上掛被動
 *        scope 'thisSkill'：只對這個技能打出的攻擊起反應
 *        do.kind 'leech'：把這次施放對每個目標造成的實際傷害 × ratio，回復給施放者
 *   { op: 'grant', kind, ... }            「角色層級」的效果：它不改這個技能本身，而是讓持有者在特定時機放這個技能。
 *        同一個角色身上，連結了同類 grant 的技能會合併成一個被動，觸發時從「當下付得起」的技能裡隨機挑一個
 *        （這是 compileLoadout 的工作；單獨呼叫 compileSkill 只會在 grants 欄位拿到資料）。
 *        kind 'opening'    戰鬥開始後的第一次行動必定施放（框架的 openingSkill；會蓋掉手寫的 openingSkill）。
 *                          SP 不夠時機會作廢，照一般流程行動。
 *        kind 'comboCast'  自己的普攻這一槽打出 minHits 擊以上時（以第一次打中時判斷），插隊多一個行動槽免費施放；
 *                          每槽最多一次；同類 grant 的 minHits 必須一致。
 *        kind 'onCrit'     自己的任何一擊暴擊時（普攻、技能都算），有 chance 的機率插隊多一個行動槽，免費（不耗 SP）施放。
 *                          每個自己的行動槽最多觸發一次；觸發出來的那次不會再觸發；同類 grant 的 chance 必須一致。
 *        kind 'lastResort' HP 第一次降到 threshold（例如 0.5 = 50%）以下時，立刻額外行動一次並施放。
 *                          額外的是一個「行動槽」，不是整個回合；觸發時若沒有付得起或沒被沉默的技能，這次機會作廢。
 *                          同類 grant 的 threshold 必須一致（validateGemData 會檢查）。
 *   { op: 'condInc', value, when: { hpBelow } }  施放當下生命比例低於 hpBelow 時，value 加進這段的加算區（與 inc 同區）。
 *   { op: 'critAsDamage' }               施放當下傷害 × (1 + 爆擊率 × (爆擊傷害 − 1))，乘算；爆擊率夾在 0～1。
 *   reaction do.kind 'drainSp'（trigger AFTER_DAMAGE_DEALT）每一擊命中、目標還活著時，扣目標 ratio × SP 上限的 SP。
 *   { op: 'repeat', times, text? }       把原本的傷害段（套用 scope、旗標之後）整段複製 times 次，接在原本動作之後、追加段之前。
 *                                         複本沿用上一段的目標（打同一個目標；目標倒下就不再追擊），各自判定命中、暴擊，
 *                                         異常與機率效果也各自觸發；吃得到 inc／more。text 是複本的開頭句（例如「{caster} 連擊，」）。
 *   { op: 'wrap', kind: 'charge' }        把技能拆成「外殼 + 本體」：玩家選到的是外殼，使用時只扣 SP 並掛上「蓄力中」標記；
 *                                         下一次輪到這個角色行動時，引擎的 skillSelectionResolver 把那一槽換成本體釋放。
 *                                         所以 2 個行動槽換一次釋放（比一般技能多花一槽），釋放那一槽不會再多行動一次。
 *                                         本體保有原本所有的動作（含其他寶石追加的段落與 inc / more），但不再扣 SP。
 *                                         需要在建立 BattleEngine 時傳入 skillSelectionResolver: loadout.resolver。
 *   { op: 'proc', per, chance, buff, summary, message? } 機率附加效果：打中時有 chance 的機率，對被打中的目標施加 buff。
 *        框架的 BUFF 動作沒有機率欄位，所以做成施放者身上的被動，用框架的 random() 擲骰（種子可重現）。
 *        per 'hit'     每一擊各擲一次（多段攻擊的段數越多，整招觸發的機率越高：3 段 × 30% 約 66%）。
 *                      只有打完仍活著的目標會擲；致死的那一擊不會。
 *        per 'target'  整次施放中，每個被打中的目標只擲一次（機率與段數無關）。目標在施放結束時已倒下就不擲。
 *        buff          框架的 Buff 設定，原樣交給 addBuff。duration 以「持有者的行動槽」計。
 *        summary       給玩家看的效果說明（例如「受到的攻擊傷害增加 15%，持續 2 個行動槽」），前面的機率句由編譯器補。
 *        message       戰報句子，可用 {caster} {target} {skill}；省略時用預設句。
 *        這是被動，要靠 compileLoadout 給的 passives 掛到 Entity 上（和汲取一樣），沒傳就不會生效。
 *        多顆 proc 寶石各自獨立擲骰，互不影響，與連結順序無關。
 *   { op: 'castCondition', of, min?, max? } 施放條件：只有條件成立時，這個技能才「出現在可施放的名單裡」。
 *        不成立時引擎抽技能就不會抽到它，行動槽不會落空（沒有別的技能時改用普攻）。
 *        of 'selfHp'      自身生命比例（0～1）。max: 0.5 代表 ≤ 50% 才能放；min 代表 ≥ 才能放。
 *        of 'enemyCount'  存活的敵人數量（整數）。min: 3 代表至少 3 名才能放；max 代表至多。
 *        多顆寶石的條件是「全部都要成立」，同一個量取最嚴格的上下界，與連結順序無關。
 *        合起來不可能成立（例如一顆要求生命 ≤ 30%、另一顆要求 ≥ 60%）時整組拒絕，錯誤同時指出雙方。
 *        只影響「能不能被選到」；蓄力已經掛上標記後的釋放不再檢查條件。
 *        沒有引擎可看（例如單獨呼叫 skill.canCast(entity, null)）時，敵人數量的條件視為成立。
 * 另外，寶石可以寫 removeTags: [...]，把主動寶石原本的標籤移除（例如聚焦把 aoe 拿掉）。
 *
 * ── 異常效果（ailments，寫在主動寶石的 DAMAGE 動作上）──────────────────
 * action.ailments: [{ kind, basis, power, duration }]：這一段每一次**命中**（造成傷害、目標還活著），對該目標附加一層異常。
 *   kind      AILMENTS 的鍵（例如 bleed 裂傷）
 *   basis     每次發作的傷害怎麼算，命中當下結算、之後固定不變；都不暴擊、沒有 ±10% 浮動、不多擲骰：
 *               'stat'  施放者的有效能力值（同這一段的 stat，預設 atk；含疲勞與 Buff）× power。
 *                       **不吃**寶石 inc／more、裝備物理／法術傷害提高，也**不看目標防禦**。（裂傷）
 *               'hit'   這一擊造成的傷害（戰報上那個數字，已含暴擊、浮動、防禦、寶石與裝備加成）× power。（殘刃）
 *   power     倍率（0.2 = 20%）。編譯時乘上裝備的異常傷害增加：power × (1 + ailmentDmg)（異常自己的加算區，
 *             與寶石 inc／more、物理／法術傷害提高分開；兩種 basis 都吃，所以殘刃同時吃命中加成與異常加成）。
 *   duration  持續幾個行動槽；編譯時加上裝備的異常持續時間（ailmentDuration，AILMENTS 標 extendable: false 的除外）。發作在**目標自己的行動槽開始時**（框架的 DOT），槽結束時倒數，所以 3 = 發作 3 次。
 * 每一層是獨立的 Buff：重複命中就疊加，持續時間各自計算（框架不加 stackPolicy 時同 id 的 Buff 會並存）。
 * 持續傷害不吃目標的 damageTaken（例如裝備減傷），會被護盾吸收（框架預設）。
 * 這是被動（施放者身上的 AFTER_DAMAGE_DEALT），要靠 compileLoadout 給的 passives 掛到 Entity 上，沒傳就不會生效。
 * 異常種類登錄在 AILMENTS（名稱、標籤）；新增一種異常只要在那裡加一行，寶石用 kind 引用。
 *
 * ── 文字 ──────────────────────────────────────────────────────────
 * action.text 的字串可以使用 {caster} {target} {value} {skill}，
 * 由編譯層展開成框架要的函式（框架本身不會替字串做替換）。
 */

// 每顆主動寶石最多能連結幾顆輔助寶石。
const MAX_SUPPORTS = 3;

// 施放權重：每個技能（主動寶石 + 輔助寶石的組合）一個正整數，抽技能時把所有「當下可施放」的權重相加後抽數字，
// 機率 = 該技能的權重 ÷ 總和。沒寫就是 DEFAULT_WEIGHT；全部相等就是原本的均等抽籤。
// 範圍是二到三位數的整數：想改範圍只改這兩個常數。
const DEFAULT_WEIGHT = 100;
const MIN_WEIGHT = 10;
const MAX_WEIGHT = 999;

// 互斥組登錄表。name 會顯示在玩家看到的說明與錯誤訊息裡。
const GROUPS = {
  economy: {
    name: '消耗取捨',
    desc: '用傷害換消耗（或反過來）的寶石。同時連結會兩邊的好處都拿到，所以同組只能連結一顆。'
  }
};

// 異常效果登錄表（見檔頭「異常效果」）。目前都是持續傷害（DOT），每次命中獨立疊一層。
const AILMENTS = {
  bleed:     { id: 'bleed',     name: '裂傷', tags: ['bleed'] },
  // extendable: false 可讓異常不吃「異常持續時間」加成（編譯器支援）；殘刃 2026-11-20 起改成可延長（使用者）
  lingering: { id: 'lingering', name: '殘刃', tags: ['lingering'] }
};

const ACTIVE_GEMS = {
  magicmissile: {
    id: 'magicmissile',
    name: '魔法飛彈',
    tags: ['spell'],
    spCost: 10,
    uncounterable: true,
    actions: [
      {
        type: 'DAMAGE',
        targetType: 'ENEMY_SINGLE',
        power: 1.5,
        stat: 'int',
        uncritable: true,
        text: { action: '{caster} 詠唱魔法飛彈，' }
      }
    ]
  },

  // 火焰風暴（使用者設計，2026-11-19；數值是我擬的初版）：群體法術。施放後依爆擊率有機率在同一個行動槽
  // 再打一次 50% 的火焰風暴（額外那次不再擲，不連鎖）。打 Boss 取得。
  firestorm: {
    id: 'firestorm',
    name: '火焰風暴',
    tags: ['spell', 'aoe'],
    spCost: 15,
    uncounterable: true,
    critEcho: { power: 0.5, text: '火焰風暴再次席捲，' },
    actions: [
      {
        type: 'DAMAGE',
        targetType: 'ENEMY_ALL',
        power: 0.9,
        stat: 'int',
        uncritable: true,
        text: { action: '{caster} 召喚火焰風暴，' }
      }
    ]
  },

  whirlwind: {
    id: 'whirlwind',
    name: '旋風斬',
    tags: ['attack', 'aoe'],
    spCost: 12,
    uncounterable: false,
    actions: [
      {
        type: 'DAMAGE',
        targetType: 'ENEMY_ALL',
        power: 1.0,
        text: { action: '{caster} 揮出旋風斬，' }
      }
    ]
  },

  // 撕裂：物理單體，命中時附加可疊加的裂傷。
  rend: {
    id: 'rend',
    name: '撕裂',
    tags: ['attack'],
    spCost: 14,
    uncounterable: false,
    actions: [
      {
        type: 'DAMAGE',
        targetType: 'ENEMY_SINGLE',
        power: 1.2,
        ailments: [{ kind: 'bleed', basis: 'stat', power: 0.2, duration: 2 }],   // 2026-11-20 使用者：3 → 2 槽
        text: { action: '{caster} 使出撕裂，' }
      }
    ]
  },

  // 追刃：物理單體，命中時附加殘刃（目標的行動槽開始時，再受到這一擊傷害的 60%；吃異常持續時間）。
  pursuit: {
    id: 'pursuit',
    name: '追刃',
    tags: ['attack'],
    spCost: 15,
    uncounterable: false,
    actions: [
      {
        type: 'DAMAGE',
        targetType: 'ENEMY_SINGLE',
        power: 1.0,   // 2026-11-20 使用者：0.9 → 1.0；殘刃 100% → 60%、改成可延長
        ailments: [{ kind: 'lingering', basis: 'hit', power: 0.6, duration: 1 }],
        text: { action: '{caster} 使出追刃，' }
      }
    ]
  },

  mend: {
    id: 'mend',
    name: '治癒術',
    tags: ['spell', 'heal'],
    spCost: 8,
    uncounterable: true,
    actions: [
      {
        type: 'HEAL',
        targetType: 'ALLY_SINGLE',
        power: 1.3,
        stat: 'int',
        text: { action: '{caster} 施放治癒術，' }
      }
    ]
  }
};

const SUPPORT_GEMS = {
  // 強力：乘算加傷害、消耗增加。與同組的節能互斥。
  heavy: {
    id: 'heavy',
    name: '強力',
    desc: '傷害變為{more}，消耗SP提升{cost}。',
    exclusiveGroup: 'economy',
    requires: { action: { type: 'DAMAGE' } },
    addTags: [],
    effects: [
      { op: 'more', value: 0.3 },
      { op: 'cost', value: 0.2 }
    ]
  },

  // 節能：降低消耗，傷害乘算略降。
  lean: {
    id: 'lean',
    name: '節能',
    desc: '傷害變為{more}，消耗SP減少{cost}。',
    exclusiveGroup: 'economy',
    requires: { action: { type: 'DAMAGE' } },
    addTags: [],
    effects: [
      { op: 'cost', value: -0.4 },
      { op: 'more', value: -0.15 }
    ]
  },

  // 增幅：加算略為提高傷害。本批唯一一顆走加算區的寶石。
  amp: {
    id: 'amp',
    name: '增幅',
    desc: '傷害增加{inc}。',
    requires: { action: { type: 'DAMAGE' } },
    addTags: [],
    effects: [
      { op: 'inc', value: 0.2 },
    ]
  },

  // 穿甲：無視一半的防禦（ignoreDefense: 0.5 = 目標的防禦 × 0.5 再進公式）。
  // 對高防禦目標的收益遠大於對低防禦目標；比例與減傷數值都是佔位，用 gems-balance.js 調整。
  pierce: {
    id: 'pierce',
    name: '穿甲',
    desc: '無視目標{ignoreDefense}防禦。',
    requires: { action: { type: 'DAMAGE' } },
    addTags: ['pierce'],
    effects: [
      // 平衡第一輪：拿掉原本的傷害 −10%（多數怪防禦只有 20～80，穿甲反而變弱）
      { op: 'actionFlag', flag: 'ignoreDefense', value: 0.5 }
    ]
  },

  // 感電：只能連結法術。打中的目標必定附加易傷。
  // requiresDamage 讓這段只對「前面的段落真的造成傷害」的目標生效。
  shock: {
    id: 'shock',
    name: '感電',
    desc: '命中的敵人受到的攻擊傷害增加{damageTaken}，持續{duration}個行動槽。',   // 使用者清單沒列，照同樣語氣寫
    requires: {
      action: { type: 'DAMAGE' },
      tags: { all: ['spell'] }
    },
    addTags: ['shock'],
    effects: [
      {
        op: 'appendAction',
        text: '命中的敵人受到的攻擊傷害增加 25%，持續 2 個行動槽',
        action: {
          type: 'BUFF',
          requiresDamage: true,
          buffs: [
            {
              id: 'shock',
              name: '感電',
              type: 'STAT',
              polarity: 'negative',
              dispellable: true,
              duration: 2,
              stackPolicy: 'refresh',
              damageTaken: { multiplier: 1.25 }
            }
          ]
        }
      }
    ]
  },

  // 聚焦：全體傷害改成單體，單體傷害乘算 +80%（即 180%）。只能連結有全體傷害段的技能。
  // 注意：對只有一個敵人的戰鬥，這是純增益（全體本來就只打到那一個）；數值是佔位，之後視模擬結果調整。
  focus: {
    id: 'focus',
    name: '聚焦',
    desc: '攻擊目標變為單體；傷害變為{more}。',
    requires: { action: { type: 'DAMAGE', targetType: 'ENEMY_ALL' } },
    addTags: [],
    removeTags: ['aoe'],
    effects: [
      { op: 'scope', from: 'ENEMY_ALL', to: 'ENEMY_SINGLE' },
      { op: 'more', value: 0.8 }
    ]
  },

  // 蓄力：下次行動才釋放，傷害乘算 +125%（225%）。使用當下只扣 SP 與掛標記；
  // 下一個行動槽自動釋放本體，釋放不會多出一次行動。需要 skillSelectionResolver（見 compileLoadout）。
  charge: {
    id: 'charge',
    name: '蓄力',
    desc: '傷害變為{more}，消耗SP提升{cost}，使用技能前蓄力一回合。',
    requires: { action: { type: 'DAMAGE' } },
    addTags: ['charge'],
    effects: [
      { op: 'cost', value: 0.5 },    // 平衡第二輪（使用者決定）：改回 +125%，改成 SP 消耗 +50%
      { op: 'more', value: 1.25 },
      { op: 'wrap', kind: 'charge' }
    ]
  },

  // 佈局：戰鬥開始後的第一次行動必定施放這個技能。
  // 多個技能都連結佈局時，開場從付得起的技能裡隨機一個。
  layout: {
    id: 'layout',
    name: '佈局',
    desc: '戰鬥開始後的第一次行動必定施放此技能。多個技能連結佈局時，隨機選一個。',
    addTags: ['opening'],
    effects: [{ op: 'grant', kind: 'opening', text: '{caster}的第一動，' }]
  },

  // 撒手鐧：HP 第一次降到 50% 以下時，立刻額外行動一次並施放這個技能（多個時隨機一個）。
  trump: {
    id: 'trump',
    name: '撒手鐧',
    desc: '生命第一次降到 {threshold} 以下時，立刻額外行動一次並施放此技能。多個技能連結撒手鐧時，隨機選一個。',
    addTags: ['lastResort'],
    effects: [{ op: 'grant', kind: 'lastResort', threshold: 0.5 }]
  },

  // 汲取：只能連結非法術的攻擊。依「整次施放」的實際傷害回血，
  // 用 AFTER_ATTACK_DEALT（整招彙總），目標被打死時也會觸發。
  leech: {
    id: 'leech',
    name: '汲取',
    desc: '消耗SP提升{cost}。回復造成傷害的{leech}生命。',
    requires: {
      action: { type: 'DAMAGE' },
      tags: { none: ['spell'] }
    },
    addTags: ['leech'],
    effects: [
      { op: 'cost', value: 0.1 },
      {
        op: 'reaction',
        trigger: 'AFTER_ATTACK_DEALT',
        scope: 'thisSkill',
        do: { kind: 'leech', ratio: 0.2 }
      }
    ]
  },

  // 迅擊（使用者設計，2026-11-19；原名連擊，同日改名，id 不變）：原本的一擊與追加的一擊都是 45%（合計 90%），兩擊都附加異常與感電；沒有 SP 代價。
  // 只能連單體技能（追加的那一擊打同一個目標）。
  multistrike: {
    id: 'multistrike',
    name: '迅擊',
    desc: '傷害變為{more}，額外釋放一次技能。',
    requires: { action: { type: 'DAMAGE', targetType: 'ENEMY_SINGLE' }, tags: { none: ['aoe'] } },
    addTags: [],
    effects: [
      { op: 'repeat', times: 1, text: '{caster} 迅擊，' },
      { op: 'more', value: -0.55 }
    ]
  },

  // 法術會心（使用者設計，2026-11-19）：讓爆擊率與爆擊傷害在法術上有作用。
  // 倍率用爆擊的實際平均收益 1 + 爆擊率 × (爆擊傷害 − 1)（使用者選；原案 1 + 爆擊率 × 爆擊傷害），施放當下讀取。
  spellcrit: {
    id: 'spellcrit',
    name: '法術會心',
    desc: '傷害變為（1＋爆擊率×（爆擊傷害−1））倍。',
    requires: { action: { type: 'DAMAGE' }, tags: { all: ['spell'] } },
    addTags: [],
    effects: [{ op: 'critAsDamage' }]
  },

  // 暴怒（使用者設計，2026-11-19）：施放當下生命低於 50% 時，傷害 +50%（加算，跟增幅同一區）。
  rage: {
    id: 'rage',
    name: '暴怒',
    desc: '血量低於{hpBelow}時，傷害增加{condInc}。',
    requires: { action: { type: 'DAMAGE' } },
    addTags: [],
    effects: [{ op: 'condInc', value: 0.5, when: { hpBelow: 0.5 } }]
  },

  // 吸魔（使用者設計，2026-11-19）：物理限定；每一擊命中時減少目標 5% SP 上限的 SP。
  drain: {
    id: 'drain',
    name: '吸魔',
    desc: '命中時減少對方{drain}SP上限的SP。',
    requires: { action: { type: 'DAMAGE' }, tags: { none: ['spell'] } },
    addTags: [],
    effects: [{ op: 'reaction', trigger: 'AFTER_DAMAGE_DEALT', scope: 'thisSkill', do: { kind: 'drainSp', ratio: 0.05 } }]
  },

  // 追擊（使用者設計，2026-11-19）：普攻一次打出 3 連擊以上時，免費施放一次這個技能（每槽最多一次）。
  // 連擊數取決於自己與目標的速度差（差 > 80 才可能 3 連擊），所以是速度流派的寶石；速度同日加倍就是為了它。
  followup: {
    id: 'followup',
    name: '追擊',
    desc: '普攻{minHits}連擊以上時釋放一次此技能。',
    requires: {},
    addTags: [],
    effects: [{ op: 'grant', kind: 'comboCast', minHits: 3 }]
  },

  // 迴響（使用者設計，2026-11-19）：群體法術限定。使用時只開啟迴響（付 200% SP、不造成傷害），
  // 之後這個技能不再被選用，每回合開始時自動免費釋放一次 40% 傷害；佈局、追擊等觸發仍可施放（開啟後施放的是傷害版）。
  echo: {
    id: 'echo',
    name: '迴響',
    desc: '傷害變為{more}，消耗SP提升{cost}。使用技能開啟迴響，自身不再使用技能，而是回合開始時自動釋放。',
    requires: { action: { type: 'DAMAGE', targetType: 'ENEMY_ALL' }, tags: { all: ['spell'] }, gems: { none: ['charge'] } },
    addTags: [],
    effects: [{ op: 'more', value: -0.6 }, { op: 'cost', value: 1.0 }, { op: 'wrap', kind: 'echo' }]
  },

  // 爆擊強化：使用時先替自己加上爆擊率 +15%，只持續這次施放的行動槽（duration 1 = 行動槽結束就消失），
  // 所以這次施放的每一擊都吃得到，之後的普攻與其他技能不受影響。
  // 沒有提示文字（text 留空）：BUFF 動作仍會產生一行訊息為空字串的戰報（BUFF_APPLY），顯示端要過濾空訊息。
  // 蓄力時，加成發生在釋放的那一槽（本體的第一個動作），不是掛標記的那一槽。
  critup: {
    id: 'critup',
    name: '爆擊強化',
    desc: '爆擊率提升{cri}。',
    // 平衡第一輪：禁止連到法術（使用者決定；法術不擲爆擊骰，連了也沒有效果）
    requires: { action: { type: 'DAMAGE' }, tags: { none: ['spell'] } },
    addTags: [],
    effects: [
      {
        op: 'prependAction',
        text: '使用時爆擊率 +15%（只在這次施放期間）',
        action: {
          type: 'BUFF',
          targetType: 'SELF',
          text: { action: '', buff: '' },
          buffs: [
            {
              id: 'critup',
              name: '爆擊強化',
              type: 'STAT',
              polarity: 'positive',
              dispellable: false,
              duration: 1,
              stackPolicy: 'refresh',
              statBonuses: [{ stat: 'cri', op: 'flat', value: 0.15 }]
            }
          ]
        }
      }
    ]
  }
};

// 主動寶石的取得（使用者決定）：大部分開局就有，一部分打王獲得。掉落只掉輔助寶石。
// 名單是我擬的佔位：追刃留給打王。王的獎勵還沒做，BOSS_REWARD_GEMS 只是記錄。
// 治癒術暫時不給（使用者：還沒有配套的輔助寶石），列在 UNOBTAINABLE_ACTIVE_GEMS，之後再決定來源。
const STARTING_ACTIVE_GEMS = ['magicmissile', 'whirlwind', 'rend'];
const BOSS_REWARD_GEMS = ['pursuit', 'firestorm'];   // 火焰風暴 2026-11-19 加入（使用者）
const UNOBTAINABLE_ACTIVE_GEMS = ['mend'];

module.exports = { STARTING_ACTIVE_GEMS, BOSS_REWARD_GEMS, UNOBTAINABLE_ACTIVE_GEMS, ACTIVE_GEMS, SUPPORT_GEMS, AILMENTS, GROUPS, MAX_SUPPORTS, DEFAULT_WEIGHT, MIN_WEIGHT, MAX_WEIGHT };
