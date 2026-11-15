# 交接文件：刷怪打王遊戲 ＋ PoE 式技能串接寶石（第四版）

本文件取代第三版交接文件。放在 `gem/HANDOFF.md`，提交進 repo 後，新對話 clone 就能直接讀到；也可以直接貼進或上傳到新對話。

## 0. 新對話開始時請先做（Claude 用 bash 執行）

```
cd /home/claude
git clone https://github.com/wiyu0628/text-based-turn-battler-framework.git
cd text-based-turn-battler-framework
git log --oneline -3 && grep '"version"' package.json    # 框架版本 1.0.58
ls gem
npm test
for f in gem/*.test.js tests/uncritable.test.js tests/ignoreDefenseRatio.test.js; do echo "$f: $(node --test $f 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ')"; done
node gem/gems-quickstart.js | tail -2
node gem/gems-ui-build.js
```

**預期**：`npm test` 519 項全過；`gem/` 內 `castWeight.test.js` 22、`gems.test.js` 94、`statLayer.test.js` 42、`spell.test.js` 12、`saveLayer.test.js` 47；`tests/uncritable.test.js` 8、`tests/ignoreDefenseRatio.test.js` 5；UI 打包成功（15 個模組）。

**如果結果不同，先判斷是哪一種情況：**

| 現象 | 原因 | 處理 |
|---|---|---|
| `package.json` 版本還是 1.0.56、`CHANGELOG.md` 最上面沒有 1.0.57／1.0.58、`node gem/gems-ui-build.js` 報錯（路徑被寫成 `gems/`） | 使用者還沒匯入最後一批修正（2026-11-15 當天遠端曾缺這三個檔案） | 請使用者上傳這三個檔案覆蓋；注意資料夾實際叫 `gem/`，打包腳本裡的路徑不能是 `gems/` |
| clone 失敗（需要登入、找不到 repo） | repo 被改成私有或網址變了 | 請使用者上傳 `gem/` 資料夾與 `src/` 需要的版本資訊，或改公開 |
| 測試數量不同但全過 | 使用者之後又新增了東西 | 以最新 `main` 與測試為準，不用硬套預期數字 |

**環境注意事項（都實測過）：**
- 只有 bash 的 `git clone` 可行；`web_fetch` 讀 GitHub 會被 robots 擋。沙盒網路允許 github.com 與 npm registry。
- **沙盒不能 `git push`**：proxy 回 403（session 沒有該 repo 的寫入授權），`add_repo` 要求先連結 GitHub 帳號。本機 `git commit` 可以。交付方式是把檔案放到 `/mnt/user-data/outputs/` 並用 `SendUserFile` 送出，由使用者自己複製、提交、推送。
- **檔案多時**：另外產生 `git format-patch -1 HEAD --stdout > changes.patch`，先用 `git apply --check` 驗證能套用，並給「檔案 → 資料夾」對照表。`changes.patch` 不能留在 repo 裡。使用者匯入後，`git fetch` 遠端、逐檔 diff 核對（曾發現使用者漏匯入 3 個檔案、一個檔案是舊版）；核對無誤後使用者說不必再讀匯出檔案。
- 沙盒 shell 是 sh：不能用 `<( )`，需要時改用暫存檔或 `bash -c '...'`。框架檔是 CRLF，讀檔或比對前先 `tr -d '\r'`。Node v22。`cut -c` 會把中文字截壞，要截斷請用別的方法。
- 上傳目錄 `/mnt/user-data/uploads` 是唯讀，要修改先 `cp`。舊對話的 outputs 在新對話看不到。**沙盒曾在對話中途重置**（工作目錄消失）：重新 clone，再從 outputs 還原已交付的檔案。
- **上一輪對話裡，沙盒的檔案曾兩次在我沒有動手的情況下變得不一樣**。結論：不要憑記憶判斷檔案狀態，以 repo 與測試結果為準，每次先驗證再動手。
- 驗證 UI 的方法：`mkdir /tmp/jsd && cd /tmp/jsd && npm install jsdom`，用 jsdom 載入 `gems-ui.html`；jsdom 沒有 structuredClone，UI 已內建替代版。也可以用 node 的 `vm` 載入打包後的 bundle，確認匯出函式。
- **驗證「沒用到新機制的戰鬥不變」的方法**：`git archive HEAD | tar -x -C /tmp/orig` 取出原版，用同一支固定種子腳本（`createSeededRandom`）跑兩份，比對戰報 md5；範例裡 `boss-fight`、`control`、`party-support`、`replay` 可重現，其餘用了未固定種子的亂數。

## 1. 現有檔案（repo 的 `gem/` 資料夾，不要重貼內容）

資料夾叫 **`gem/`**（不是 `gems/`），與 `src/` 同一層，所以 `require('../src')` 與 `require('./gems')` 都成立。

| 檔案 | 作用 |
|---|---|
| `gems.js` | 資料與規則說明（v10）：3 顆主動寶石、12 顆輔助寶石、GROUPS、MAX_SUPPORTS = 3、權重常數。**檔頭註解是寶石規則的權威來源（含「物理與法術」一節），設計新寶石前先讀。** |
| `gemCompiler.js` | 編譯器：compileSkill、compileLoadout、buildGrantPassives、buildChargeResolver、buildWeightResolver、combineResolvers、describeSupport、validateGemData、GemLinkError |
| `statLayer.js` | 數值加成層（純函式）：applyStatBonuses、explainStatBonuses、describeStatBonus、statModifier、validateBonuses、validateBuffBonuses、STAT_DEFS |
| `saveLayer.js` | **存檔層**（見第 3-C 節）：存檔結構與驗證、版本遷移、背包與裝備操作、匯出匯入、儲存介面 |
| `gems.test.js`、`statLayer.test.js`、`castWeight.test.js`、`spell.test.js`、`saveLayer.test.js` | 94／42／22／12／47 項測試 |
| `gems-quickstart.js` | `node gem/gems-quickstart.js [主動寶石] [輔助寶石…]`（會印出空訊息的 BUFF_APPLY 行，使用者說不用處理） |
| `gems-balance.js` | 平衡模擬腳本（選項：`--battles --turns --cast --sp --attack-sp --active --exclude-active --exclude-support --lock --max-supports --top --csv`） |
| `gems-ui.template.html`、`gems-ui-build.js` | 產生 `gems-ui.html`（單一檔案，瀏覽器直接開）。寶石或編譯器改了就重新 `node gem/gems-ui-build.js` |
| `gems-ui.html` | 打包產物 |
| `../tests/uncritable.test.js`、`../tests/ignoreDefenseRatio.test.js` | 框架層新機制的測試（8 項、5 項） |

**目前的寶石**（數值皆為佔位）：
- 主動：magicmissile 魔法飛彈（**法術**：吃智力、不可暴擊、不可反擊；SP 10、單體）、whirlwind 旋風斬（**物理**：吃攻擊力、可暴擊；全體、SP 12）、mend 治癒術（法術、治療，回復量讀智力；SP 8）。治癒術沒有傷害段，所以只能連佈局與撒手鐧。
- 輔助：heavy 強力、lean 節能（互斥組 economy）、amp 增幅、wide 擴散、**pierce 穿甲**（`ignoreDefense: 0.5`，無視一半防禦，傷害 −10%）、shock 感電（限法術）、focus 聚焦（限全體）、charge 蓄力、layout 佈局、trump 撒手鐧、leech 汲取（限非法術）、critup 爆擊強化（使用時爆擊率 +15%，只撐這次施放；**沒有提示文字**）。連到法術沒有效果（法術不擲爆擊骰）。
- 機制已實作但沒有正式寶石使用：`proc`（機率附加）、`castCondition`（施放條件）。

## 2. 目標

- 在回合制文字戰鬥框架（`text-based-turn-battler-framework`，Node.js，零依賴）上做一個**刷怪→打王**的遊戲，寶石系統只是其中一項玩法。
- 玩法構想（使用者已回答的部分）：
  - 戰鬥**全自動**，每場獨立（不跨場消耗）。
  - 多個地區有不同怪物；玩家自行設定難度 **1～15**，數值隨難度增加；到固定難度會出新怪、舊怪學新技能。
  - **王**有獨立按鈕；難度固定；擊敗後出現新王；舊王可以回頭再打。王的額外獎勵不一定是掉落（待定）。
  - 刷怪掉落：**寶石、武器、刻印**（類似 PoE 精髓）。難度對掉落有「門檻 + 機率」兩種影響：難度 1 不可能掉 5 階刻印。
  - **刻印**階級 1～5，同一種刻印固定有 3 種詞綴。三種用法：①賦予裝備詞綴（隨機取 2 種詞綴，數值在範圍內隨機）；②合成裝備（影響基礎數值如攻擊、防禦，以及裝備的寶石施放權重；詞綴待定）；③3 顆合成 1 顆高一階的刻印。
  - **合成**：3 同種合出高 1 階的同種（如果有），不同種隨機；所有合成都不會失敗；有隨機成分（倍率隨機），但投入的刻印會影響結果。
  - **裝備**：武器、頭盔、衣服、鞋子；各部位可用刻印不同，也有共用刻印；飾品之後加入（提供不同被動）。
  - **武器**：掉落的是類似 PoE 傳奇武器的獨有效果，不限制寶石、沒有隨機詞綴，但數值隨機；可合成的武器是另一種。若拆分物理／法術，武器決定普攻參照攻擊力還是智力。
  - **寶石沒有個體差異**，重複掉落可堆疊。
  - **存檔**：存在玩家本機，目前先用瀏覽器儲存，之後可能更換。
  - 法術**不可反擊也不可暴擊**。
- 交付方式：只交付 js 與 html 檔，使用者手動複製、提交。

## 3. 已確定的決策（含理由）

### A. 寶石系統（延續自前幾版，仍有效）

1. **不改框架，寫編譯層**：技能本來就是資料；作者建議不要為機制改框架。
2. **寶石是純資料、可 JSON 序列化**：方便存檔與維護。
3. **加算（inc）與乘算（more）是兩個獨立 op**：公式 `(1 + Σinc) × Π(1 + more)`，value 一律寫「增量」；玩家說明由 `describeSupport` 依數值自動產生，數字改了不會對不上。`cost` 也是增量（`0.25` = +25%）。
4. **互斥用 `exclusiveGroup`**（需登錄在 GROUPS），不寫死寶石名稱；拼錯組名由 `validateGemData` 在編譯前抓到。
5. **連結上限 `MAX_SUPPORTS = 3`**：第二道平衡防線；沒有上限時 heavy + lean 同時連結嚴格優於不連結。
6. **輔助寶石沒有順序**（與 PoE 相同）：內部依 id 字母序處理；條件只看主動寶石原本的樣子；效果同時作用在原本動作上；兩顆寶石對同一東西寫入不同值才算衝突。理由：同一組結果一致，玩家不用理解順序。
7. **技能 id = `主動id+排序後的輔助id`**；改寶石 id 等於改技能 id，資料的鍵必須與內部 id 一致。
8. **錯誤 `GemLinkError` 帶 `gemId` 與 `conflictsWith`**，UI 要把雙方都標出來。
9. **蓄力用「標記 + `skillSelectionResolver`」**，不用暈眩或 BEFORE_ACTION Buff：前兩者實測做不到在被擋那一槽放招，或釋放後同槽還會再行動一次（變成 3 槽換 2 次行動）。外殼 `X+charge`、本體 `X+charge#release`；沒傳 resolver 開場就報錯。
10. **佈局與撒手鐧是角色層級效果（grants）**：同類 grant 在 `compileLoadout` 合併成一個被動，從「當下付得起且沒被沉默」的候選裡隨機挑一個。撒手鐧用 `engine.insertAction` 多一個**行動槽**（不是整回合）。
11. **機率附加 `proc` 用被動擲骰**（不用 CAST_SKILL 抽籤，那只能是 k/N 機率、子技能會自己重抽目標）。per `hit` 或 `target` 由寶石決定。
12. **施放條件 `castCondition` 用覆寫 `canCast`**（ConditionalSkill），條件不成立的技能不在抽技能的名單裡，行動槽不會落空。
13. **觸發保護是可選模組 `gemTriggers.js`**（核心不引用；**目前不在 repo 裡**，要做觸發類寶石時再請使用者提供，或依設計重寫）。設計：maxDepth 1、perSlot 6、maxInsertChain 1。
14. **普攻消耗與初始 SP 預設 2 倍**只改工具預設（`normalAttackSpCost: 2`）；框架本身預設仍是 1。

### B. 第三版新增（數值加成層、暴擊率、施放權重）

1. **數值加成層 `statLayer.js` 是獨立的純函式模組，不綁在寶石上。**
   - 格式 `{ stat, op: 'flat'|'inc'|'more', value, source? }`；公式 `(基礎 + Σflat) × max(0, 1 + Σinc) × Π(1 + more)`，與寶石傷害同一套慣例。
   - 支援的屬性：hp、sp、atk、def、int、spd、cri、criDmg、skillCastRate。要加屬性只在 `STAT_DEFS` 加一行。**這就是設計刻印詞綴時的範圍。**
   - 生命與 SP 的加成算在上限（maxHp／maxSp）上，目前值跟著上限增減（滿血維持滿血、受傷的不會被補滿）。
   - 夾範圍：cri、skillCastRate 夾 0～1（**超出會讓 Entity 建構直接丟錯**）、criDmg 最低 1、其餘不低於 0；整數屬性四捨五入。
   - 用法：`new Entity({ stats: applyStatBonuses(基礎屬性, 加成清單) })`。裝備詞綴與寶石之後都產生同樣格式的加成再串起來；背包畫面可用 `explainStatBonuses` 預覽最終數值與來源明細。
   - **忘了呼叫 `applyStatBonuses` 會靜默失效**（與被動沒傳給 Entity 同類風險）。
2. **輔助寶石沒有常駐效果**（使用者決定）：常駐數值只來自裝備與詞綴。我曾做過「常駐式屬性寶石」（stats grant）驗證加成層，確認可運作後已移除。
3. **爆擊強化（critup）用 Buff 式實作**：施放時先對自己掛 `cri +0.15`（flat，即 +15 個百分點），再執行傷害。
   - 新增 op `prependAction`（在技能之前放一段動作）；BUFF 的 `statBonuses` 由編譯器轉成框架 STAT Buff 需要的 `effect` 函式（寶石資料不能放函式）。暫時 Buff 的數值修改**不夾範圍**（框架要求先全部套用再夾限，對立的 Buff 才能互相抵銷），也不能改生命與 SP。
   - 戰報：**沒有提示文字**（使用者要求移除，`text` 為 `{ action: '', buff: '' }`）。BUFF 動作仍會產生一行訊息為空的 `BUFF_APPLY`，測試靠它定位「加成掛上」的時間點；UI 會過濾空訊息。
   - **「本回合」實作成「這次施放的行動槽」**：框架的 Buff 在持有者自己的行動槽結束時倒數，沒有「整回合」的單位。
4. **施放權重**（實測機率 = 權重 ÷ 總和，100/200/300 → 17.0/33.1/49.9%）：
   - 範圍 10～999 的整數（二到三位數），預設 100；寫在 `compileLoadout` 每一組的選填 `weight`（不放在寶石資料上，使用者先前明確不要）。
   - 引擎先用 `skillCastRate` 決定這一槽放不放技能，之後權重只決定放哪一招，**不改變施放頻率**。
   - 候選 = 當下可施放（SP 夠、條件成立）且沒被沉默的技能。理由：不可用的技能不該佔機率、也不該讓這一槽落空。所以名義權重不等於實際頻率。
   - 候選權重全相等、只有一個候選、引擎抽到普攻或手寫技能時**不介入**，保持亂數序列不變（全相等時戰報與沒寫權重逐字相同）。
   - 開場槽（佈局）不動；權重不全相等卻沒傳 resolver，**開場報錯**（守衛）。
   - 與蓄力並存：`combineResolvers` 蓄力在前，已投入的蓄力優先。
5. **佈局的開頭文字接在「技能那一行」**（`gemLeadIndex`），不接在前置動作上。原本會印成「勇者的第一動，的爆擊率提升了。」。
6. **撒手鐧插隊結束時移除單一行動槽 Buff**（`withSlotCleanup`）。框架的插隊行動（`runInsertedActions`）結束時**不倒數 Buff**，否則爆擊強化會多撐到下一次行動（實測 8/812 次普攻暴擊，修正後 0/812）。
7. **存檔層**：已實作，見第 3-C 節。
8. **實作順序（使用者核定）**：
   - 第一階段 ✅：數值加成層、暴擊率輔助寶石（Buff 式）。
   - 第二階段 ✅：施放權重、存檔層、`uncritable`、穿甲比例、物理與法術拆分（都已完成並由使用者匯入）。
   - 第三階段（**下一步**）：刻印 → 裝備 → 掉落表。先定物品資料結構與詞綴（存檔層的裝備欄位已預留，見 3-C）。
   - 第四階段：地區與怪物（難度 1～15 縮放，需先算防禦曲線）→ 新怪與新技能解鎖 → 王。
   - 第五階段：介面 → 整體平衡。

### C. 第四版新增（本輪）

1. **爆擊強化的 Buff 時機（實測確認）**：選招 → 技能開始執行，**第一個動作才掛上 Buff** → 傷害段都吃到 +15% → 行動槽結束 `tickBuffs` 倒數、Buff 移除。普攻槽全程沒有 Buff；撒手鐧插隊槽由 `withSlotCleanup` 手動移除。
2. **`uncritable`（src 1.0.57，使用者同意動 src）**：`Skill` 與 `DAMAGE` 段可寫 `uncritable: true`，在**擲爆擊骰之前**排除（不是壓低機率），所以 Buff 把 `cri` 加到 100% 也蓋不掉。沒用到時照常擲骰、亂數序列不變（固定種子 60 場戰報與原版逐行相同）。反擊招式看自己的旗標。不是布林、或寫在非 `DAMAGE` 段會在建構時拋錯。實作只在 `Skill.js` 的爆擊判定處（整個 `src/` 只有這一處）。
3. **`ignoreDefense` 比例（src 1.0.58）採做法 B**：防禦先乘上 `(1 − 比例)` 再進公式（0.4 = 用 60% 的防禦計算）；`true` 等於 1、`false` 等於 0；不合法拋錯。理由：保留漸進的減傷曲線，高防禦目標不會被補償過頭（做法 A「線性混合」在防禦 900 時補償過強）。**釐清**：`ignoreShield` 是「護盾吸收」的比例（那一成傷害不碰護盾直接落 HP），與防禦無關。穿甲寶石改成 `ignoreDefense: 0.5` ＋ 傷害 −10%（佔位；原本無視全部防禦時 −15%，只無視一半還扣 15% 會讓低防禦目標變負收益）。防禦 300 的目標約是一般傷害的 1.2 倍。
4. **物理與法術拆分（使用者決定：不做魔防，物法皆吃防禦）**：
   - 法術 = `stat: 'int'`（吃智力）＋ `uncritable: true` ＋ `uncounterable: true`；物理不寫額外欄位（吃 `atk`、可暴擊）。治癒術的回復量讀智力。寫在寶石的動作資料上，編譯器原樣帶走，連輔助寶石也不會弄丟。
   - **使用法術的單位一定要有 `int`**，沒有會直接報錯。測試、UI、quickstart、balance 腳本的角色都補了 `int`。
   - **量爆擊的測試要用旋風斬**：魔法飛彈不擲爆擊骰，用它量爆擊率永遠是 0，看似通過其實什麼都沒測到。
   - 武器決定普攻吃 `atk` 或 `int`：框架已支援（普攻 Skill 的傷害段寫 `stat: 'int'`），不用改 `src/`，留待遊戲層設計。
   - 做過 `res`（魔防）與 `defenseStat` 欄位，使用者決定不要後已全部移除（框架、屬性層、寶石、UI、文件）。
5. **存檔層 `saveLayer.js`（已實作，尚未接上任何 UI）**：
   - **存檔結構**：`version`（`SAVE_VERSION` = 1）、`meta { gameVersion, createdAt, savedAt, nextId }`、`gems { 寶石id: 數量 }`、`engravings { "種類@階級": 數量 }`、`equipment []`、`equipped { weapon, helmet, armor, boots }`（裝備 id 或 null）、`progress { defeatedBosses, unlockedRegions, unlockedMonsters }`、`settings { difficulty 1～15 }`。編譯後的技能、最終屬性、戰報、掉落表都不存。
   - **裝備**：`{ id: 'eqN', slot, origin: 'drop'|'craft', base [只能 flat], affixes [], castWeight, links }`。詞綴兩種：`scope: 'wearer'`（影響穿戴者，格式 = 加成層的 `{stat, op, value, source?}`，`equippedBonuses` 可直接餵 `applyStatBonuses`）、`scope: 'gems'`（影響這件裝備上的寶石，`kind` 目前只檢查格式、**沒有實際效果**，等設計刻印詞綴時補）。
   - **寶石鑲在裝備上**（使用者決定）；詞綴可影響裝備上的寶石，但寶石槽與連結數量不因裝備而異。每個部位一組連結（1 主動 + 3 輔助），所以槽數**不存在裝備裡**，由 `SLOT_RULES`（`maxLinks`、`supportSlotCount`、`canFillSupportSlot`）決定。將來「主動寶石能放進輔助槽」時改這三處＋編譯器，存檔格式不用動。
   - **施放權重在裝備上（`castWeight`，10～999、預設 100），不在連結上**（使用者決定做法 B，因為主動寶石進輔助槽後併入主技能，不需要每組連結各自的權重）。連結上寫 `weight` 會報錯；`setLinks` 不動權重；穿戴時 `equippedLinks` 才把裝備的 `castWeight` 帶進每組連結，輸出格式可直接給 `compileLoadout`。將來若一件裝備要有多個獨立技能，用版本遷移把權重搬進連結。
   - **操作都回傳新存檔、失敗丟 `SaveError`、原存檔不變**：`addGems`／`removeGems`／`addEngraving`／`removeEngraving`／`addEquipment`（配發 id；不能自己指定 id、不能帶寶石）／`removeEquipment`（鑲著的寶石退回背包、穿著的脫下）／`setLinks`（舊寶石先退回、再從背包扣新的，背包不夠就失敗）／`equip`／`unequip`／`setDifficulty`／`addProgress`。寶石不會憑空出現或消失。穿戴中所有連結合併後會整體再編譯檢查（兩件裝備不能有同一個技能 id）。
   - **讀檔**：未知寶石直接報錯、不動存檔（我曾說「丟棄並回報」，改成報錯，因為自動刪玩家的東西風險較大；要丟棄可日後加選項）。版本遷移表 `MIGRATIONS`（每步升一版）；比遊戲新的存檔拒絕。物品 id 由 `meta.nextId` 配發、不重用。
   - **儲存介面**：adapter `{ read, write, remove }`（可同步或 async），現有 memory 版與 localStorage 版（空間不足轉成 `SaveError` 並提醒匯出）；`createSaveStore` 提供 `load / save / clear / create / loadOrCreate`；另有 `exportSave` / `importSave`（JSON 文字）。之後換 IndexedDB 只需寫新 adapter。
   - **效能**：每次操作都會整份重新驗證，所以編譯檢查結果有快取（200 件裝備 400 次操作 2.3 秒 → 0.24 秒）。

## 4. 被否決或放棄的方案

**本輪：**
- **魔防 `res` 與 `defenseStat`**：做完又移除（使用者決定物法皆吃防禦）。
- **穿甲比例做法 A（線性混合：X% 傷害無視防禦）**：高防禦目標補償過強，採 B。
- **施放權重放在每組連結上**：改放裝備（`castWeight`）；一件裝備只有一組連結，兩者等價，放裝備比較貼合「裝備影響權重」。
- **讀檔時自動丟棄不存在的寶石**：改為報錯、不動存檔。
- **用 Buff 把技能爆擊率「取代」（set）成技能自己的值**：實測可行，但「取代」與「加算」互相看順序，違反無序規則；若要做需讓編譯器保證取代永遠排第一。
- **爆擊強化提示文字「{caster}的爆擊率提升了。」**：使用者要求移除。
- **常駐式屬性寶石（stats grant）**：使用者指出輔助寶石理論上沒有常駐效果；它只是用來驗證加成層，已移除。順帶否決的設計：「同一顆寶石連結在多個技能只算一次」的去重規則（常駐寶石不存在，這條自然作廢）。
- **用 Buff 把暴擊率壓到 0 來做「法術不可暴擊」**：已評估為可行（Buff 在該行動槽結束就消失，我先前說會撐到回合結束是錯的，已更正），但使用者決定把 `uncritable` 旗標（動 `src/`）排在後面處理；兩種做法尚未最終選定。**（結論：最後改用 `uncritable` 旗標，已實作，見 3-C）**
- **把「本回合」做成整個回合**：框架沒有整回合的 Buff 單位，做不到。
- **權重加總包含不可施放的技能**：會浪費擲骰、讓一槽落空；改為只算當下可施放的。
- **權重放在寶石資料上**：使用者明確不要（沿用第二版結論）。
- **對所有 grants 都記錄來源寶石 id**：會改變既有佈局資料的形狀、弄壞既有測試；改為只在需要時記錄（隨 stats grant 移除後已無此需求）。

**更早的版本（沿用）：** 在框架原始碼內加寶石系統；輔助寶石依插槽順序處理；priority 折衷方案；互斥寫死寶石 id；移除互斥且不設上限；每顆寶石手寫說明文字；`more` 寫倍率；用 `castSkill` 呼叫自己做 Echo／連擊（同一施放者同一 skill.id 重入會被靜默擋掉）；子類別覆寫 `Skill.execute`；蓄力用 STUN 或 BEFORE_ACTION Buff；機率附加用 CAST_SKILL 抽籤；把撒手鐧接上觸發守門函式；`maxInsertChain` 設 2；把觸發保護放進核心；用改寫 resolver 過濾技能（改用 `canCast` 覆寫）；投射物、連鎖、傷害類型、抗性、穿透比例暫不做。

**已考慮但還沒和使用者討論**：把普攻也放進權重池（會取代 `skillCastRate`，並與「用屬性加成調施放率」重複）。目前維持 `skillCastRate` 當閘門。

## 5. 尚未解決的問題

**需要使用者決定或補充：**
1. **玩家等級**：要不要有、怎麼運作（使用者要求之後由我協助分析）。
2. **爆擊強化連到法術**：目前連得上但沒有效果（有測試記錄這個行為）。要禁止連結（像汲取限非法術那樣），還是保留？
3. **各主動技能有獨立爆擊率**：可行性已確認（尚未決定要不要做）。不動 `src/` 的做法：在技能開頭掛一個只撐這次施放的 STAT Buff；**加算**與現有規則相容（實測：角色 10% ＋ 技能 25% → 36.2%），**取代**也做得到（實測 25.5%）但會違反無序規則；限制是整招共用一個值、多段無法各自不同。要動 `src/` 的做法：`DAMAGE` 段加 `critBonus`，`Formulas.isCritical` 多收一個參數（約三行、不多擲骰）。
4. **合成裝備的詞綴、飾品的被動、各部位的專用刻印**：使用者設計中；之後不足的由我協助設計。
5. **刻印細節**：詞綴種類（受 `STAT_DEFS` 範圍限制：hp、sp、atk、def、int、spd、cri、criDmg、skillCastRate）、各階數值範圍、合成倍率的隨機範圍、不同種合成的隨機規則；以及存檔裡 `scope: 'gems'` 詞綴的 `kind`（影響裝備上寶石的詞綴有哪些種類）。
6. **難度 1～15 的縮放公式**：防禦減傷是 `300/(def+300)`，縮放過陡會讓曲線失控，要先算過。
7. **怪物如何選招與新技能**：框架預設每個行動槽先抽 `skillCastRate`（35%），再從可用技能均等抽。怪物若用法術要有 `int`。
8. **掉落表數值、王的額外獎勵、存檔最終位置**（目前暫定瀏覽器 localStorage，adapter 可換）。
9. **輔助寶石是否也能改權重**，以及**主動寶石放進輔助槽時的編譯行為**（存檔層已留好 `SLOT_RULES`，編譯器端等設計）。
10. **武器如何決定普攻吃 `atk` 或 `int`**、怪物的物理與法術數值怎麼配（框架已支援，是遊戲層設計）。
11. **版本與 tag**：`CHANGELOG.md` 有 1.0.57（`uncritable`）與 1.0.58（穿甲比例）兩條，依 `AGENTS.md` 流程 commit 後要各打 tag `v1.0.N`；目前還沒打，也沒補 `examples/`。


**技術上已知的限制與風險：**
- 權重或蓄力換招的那一槽，**隊友的 `ALLY_SKILL_SELECT` 被動不會被詢問**（引擎在換招時跳過它）。單角色戰鬥不受影響，做隊伍玩法時要回頭看。
- 被動沒傳給 Entity（汲取、機率附加）、`loadout.resolver` 沒傳（蓄力與權重有守衛會報錯；其他無法偵測）、`applyStatBonuses` 沒套用，都會失效。
- 邊角情況（未處理）：蓄力標記被消耗後角色恐慌，釋放那次浪費；撒手鐧插隊與蓄力並存時同顆外殼重複放只有一次釋放；HP 起始就低於門檻時，撒手鐧在第一次 HP 變動時觸發。
- 所有數值都是佔位；使用者改過數值後**還沒重跑平衡模擬**（需用 `--cast=0.35` 與更多場數）。
- UI 只用 jsdom 驗證過，沒在真正的瀏覽器看過（手機寬度、深色模式未確認）；UI 目前沒有權重欄位。UI 是測試版，不要投入過多。
- 尚未做、設計已保留：**連擊寶石**（單體技能額外釋放兩次、各 30% 傷害；無序規則下需重新設計，目前沒有「複製傷害段」的 op）、**觸發類寶石**（暴擊時施放；形式是施放者身上的被動 + `triggerCast`，被觸發的技能不扣 SP、傷害降低）。正式寶石也尚未使用 `proc` 與 `castCondition`。

## 6. 重要限制與偏好

**必須遵守的規則：**
- **不要修改 `src/`，除非使用者明確同意。** 需要動的時候，先說明要改哪裡、為什麼做不到，等同意再做。已同意並完成的兩項：`uncritable`（1.0.57）與 `ignoreDefense` 比例（1.0.58）；物理與法術拆分沒有再動 `src/`。之後任何新的 `src/` 改動仍要先取得同意。
- **repo 的 `AGENTS.md` 是改框架時的規則**，動 `src/` 前必讀：
  1. 亂數序列不變：既有戰鬥在同一串亂數下要一字不差；新機制一律可選（opt-in），沒用到時不能多擲或少擲一次骰；擲骰一律用 `src/utils/Random.js` 的 `random()`，不要用 `Math.random()`。
  2. 戰報文字不變：下游會比對字串，預設句連空格都不能改；新文案用新的片段或選項。
  3. 零依賴：`dependencies` 保持空，測試只用 `node:test`。
  4. 加機制的流程：程式寫 `src/`（中文註解說明為什麼）→ `tests/` 加測試（預設行為不變 + 新行為）→ 更新 `docs/`、`docs/REFERENCE.md`、必要時 `examples/` 與 `tests/examples.test.js` → `package.json` 版本 +1、`CHANGELOG.md` 最上面寫一條（**已發出的版本號不能重用**）→ commit 後打 tag `v1.0.N` 再 push。
  5. CommonJS；設定錯誤要在建構時拋錯，不要默默退回預設；被動 `action` 收 `(self, ctx, logger, engine)`（少數例外維持原簽名）；文件寫繁體中文。
- 新檔案放 `gem/`，不要和框架原有的 `examples/` 混在一起（使用者特別要求）。
- 寶石資料必須是純資料（不放函式）；新增寶石前先讀 `gem/gems.js` 檔頭的規則與 effects 速查。
- 每次改動後跑相關測試與 `npm test`；改了 `gems.js` 或 `gemCompiler.js` 就重新 `node gem/gems-ui-build.js`。

**溝通偏好：**
- 回覆使用**繁體中文**；使用者在手機 Claude App 上閱讀，回覆要精簡、先給答案，長篇用短段落或短表。
- **先驗證再下結論**，用實際執行的結果說話；不確定的事要明說（沒在真瀏覽器看過就要講）。發現自己先前說錯要直接更正。
- **重大決定先討論再實作**；使用者會明確說「請使用 A」或「先不要…」，不要擅自擴充範圍。
- 設計偏好：資料驅動、不寫死寶石名稱、無順序（PoE 式）、玩家容易理解（加算與乘算分開描述）、新機制優先做成可選模組、核心保持乾淨。
- 交付：使用者手動複製、提交（沙盒 push 不了，已實測）；檔案多時給 patch ＋「檔案 → 資料夾」對照表，使用者匯入後用 `git fetch` 逐檔核對；不要重貼已完成的檔案內容。使用者確認匯入無誤後，不必再讀匯出檔案。

## 7. 框架的關鍵事實（實作時要記得）

- 技能是 `actions` 陣列；每一擊獨立判定命中、暴擊、反擊；`AFTER_DAMAGE_DEALT` 每擊一次（打完仍活著才通知）、`AFTER_ATTACK_DEALT` 整招彙總（每個被打中的目標一次）；hit 帶 `isCrit`、`skill`、`target`、`actualDamage`。
- 傷害 = 能力值 × power × 減傷（`300/(def+300)`）× 0.9～1.1 變異；暴擊倍率預設 1.5。暴擊只看施放者的有效 `cri`（基礎屬性加上 Buff 後）；技能與 `DAMAGE` 段可寫 `uncritable`（1.0.57，擲骰前排除）。**反擊**有 `skill.uncounterable` 與 `action.uncounterable`。`ignoreDefense` 是布林或 0～1 比例（1.0.58，防禦 × (1 − 比例)）；`ignoreShield` 是護盾吸收的比例，與防禦無關。能力值預設讀 `atk`，傷害段寫 `stat: 'int'` 改讀智力；沒有魔防。
- Buff 的 `duration` 以「持有者自己的行動槽」計，**在持有者每個行動槽結束時倒數**，不是回合；插隊行動不倒數。STAT Buff 靠 `effect(effectiveStats)` 函式改屬性。BUFF 動作用 `buffs: [...]`（寫成 `buff:` 不報錯但無效），沒有 chance 欄位。
- 疲勞：SP 低於 50% 時能力值 ×0.8、施放率 −10%；低於 10% 時 ×0.6、−15%。普攻每擊扣 `normalAttackSpCost`，與技能共用 SP。普攻會吃速度連擊（一次普攻可能多行傷害）。
- 引擎選招：先 `skillCastRate` 閘門，再從 `canCast` 的技能均等抽、檢查沉默；`skillSelectionResolver` 在選好招後詢問（普攻也會被問；只有一個位置，換招時會跳過 `allySkillSelection`）。引擎選項：`maxTurns`、`rng`（`createSeededRandom(seed)`）、`skillResolver`。
- `insertAction` 沒有迴圈保護，在目前行動槽結束後、下一槽開始前執行，要求 `canAct()`，不檢查沉默、SP 不足不會被擋。
- 每場戰鬥都要重新建立 Entity 與被動（被動帶戰鬥狀態）；`compileLoadout` 每場重呼叫；`BATTLE_START` 被動只在 `engine.start()` 時執行。
- 框架的 `random()` 可被 `Math.random` 替換（測試固定種子就是這樣做）。字串 `text` 框架原樣使用，`{caster}` `{target}` `{skill}` 由編譯器展開。
- 結果物件：`{ winner, logs, finalTeamA, finalTeamB }`；log 欄位 `type`、`actorId`、`skillId`、`targetId`、`value`、`message`、`isCrit`。隱藏用的 Buff 會產生空訊息行，UI 要過濾。
- 框架目前版本 1.0.58（寶石是在 1.0.51 開發的，之後升級測試全數通過；1.0.57 加 `uncritable`、1.0.58 加穿甲比例）。README 與 llms.txt 寫的安裝版本可能落後，以 `package.json` 為準。

## 8. 新對話建議的第一步

1. 完成第 0 節的 clone 與驗證，確認狀態。
2. 讀 `gem/gems.js` 檔頭註解與 `AGENTS.md`；要碰存檔時再讀 `gem/saveLayer.js` 檔頭。
3. 向使用者回報驗證結果，確認下一步（依第 3-B-8 節，是第三階段：**刻印 → 裝備 → 掉落表**）。開始前先和使用者定物品資料結構：刻印的詞綴種類與數值範圍、各部位專用刻印、合成裝備的詞綴（見第 5 節 4、5 項）。存檔層的裝備欄位已預留，物品設計定案後再回頭調整即可。
4. 若使用者想先處理小項目：爆擊強化連到法術要不要禁止（第 5 節 2）、各技能獨立爆擊率（第 5 節 3）、補打 tag（第 5 節 11）。
