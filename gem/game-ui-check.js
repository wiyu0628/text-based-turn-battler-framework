'use strict';
// 遊戲介面的流程檢查（jsdom）：載入 gem/game.html，模擬點擊跑一遍主要流程，印出每一步的結果與錯誤。
// jsdom 不是本 repo 的依賴（維持零依賴）：先在別處安裝，例如
//   mkdir /tmp/jsd && cd /tmp/jsd && npm init -y && npm install jsdom
// 再執行（repo 根目錄）：JSDOM_DIR=/tmp/jsd node gem/game-ui-check.js [gem/game.html]
// 沒有在真正的瀏覽器裡看過版面；這裡只檢查流程與資料。
const path = require('path');
const jsdomDir = process.env.JSDOM_DIR || '/tmp/jsd';
const { JSDOM } = require(path.join(jsdomDir, 'node_modules', 'jsdom'));
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, 'game.html'), 'utf8');
const errors = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.addEventListener('error', e => errors.push(e.message)); w.addEventListener('unhandledrejection', e => errors.push('reject: ' + (e.reason && e.reason.stack || e.reason)));
w.confirm = () => { errors.push('不應該呼叫 confirm()'); return true; };
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => w.document.querySelector(s);
const $$ = s => [...w.document.querySelectorAll(s)];
const text = () => w.document.getElementById('main').textContent;
const btn = label => $$('button').find(b => b.textContent.trim().startsWith(label));
const noCd = () => w.localStorage.setItem('tbtf-game-battle-cd', '0');
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const setSelect = (sel, value) => { sel.value = value; sel.dispatchEvent(new w.Event('change', { bubbles: true })); };
(async () => {
  await sleep(300);
  const ui = w.GameUI;
  console.log('初始：能量', ui.state.energy, '寶石', JSON.stringify(ui.state.gems), '裝備', ui.state.equipment.length);
  console.log('冒險頁：', text().slice(0, 160));
  // 寶石頁：把旋風斬連到武器
  click($$('#nav button').find(b => b.textContent === '寶石')); await sleep(50);
  const editor = $$('.link-editor')[0];
  setSelect(editor.querySelectorAll('select')[0], 'whirlwind');
  click([...editor.querySelectorAll('button')].find(b => b.textContent === '套用')); await sleep(100);
  console.log('連結後技能：', ui.state.equipment[0].links.map(l => l.active).join(','), '側欄：', w.document.getElementById('hero').textContent.includes('旋風斬'));
  // 冒險：打 25 場難度 1
  click($$('#nav button').find(b => b.textContent === '冒險')); await sleep(50);
  let wins = 0;
  // 冷卻：打一場之後 10 秒內不能再打
  click(btn('出發'));
  for (let k = 0; k < 50 && !$('#battle-modal').classList.contains('open'); k++) await sleep(20);
  console.log('開場敵人血量：', $('#battle-sub').textContent);
  await sleep(300);
  const again = $$('#battle-footer button').find(b => b.textContent.startsWith('再打一場'));
  console.log('播放中的速度選項：', $$('#battle-footer button').slice(0, 4).map(b => b.textContent).join('/'));
  click($$('#battle-footer button').find(b => b.textContent === '跳到結尾')); await sleep(10);
  const cdBtn = $$('#battle-footer button').find(b => b.textContent.startsWith('再打一場'));
  console.log('結束後速度選項：', $$('#battle-footer button').slice(0, 4).map(b => b.textContent).join('/'), '再打一場：', cdBtn.textContent, '停用', cdBtn.disabled);
  const lastLine = $$('#battle-log div').pop();
  console.log('最後一行：', lastLine.textContent, lastLine.className, '有獲勝方字樣：', $('#battle-log').textContent.includes('獲勝方'));
  const classes = {}; for (const d of $$('#battle-log div')) classes[d.className] = (classes[d.className] || 0) + 1;
  console.log('戰報顏色分類：', JSON.stringify(classes));
  console.log('會心加粗：', $$('#battle-log div.crit').length, $$('#battle-log div.crit').every(d => d.textContent.includes('會心')));
  const missLine = $$('#battle-log div.miss')[0], skillLine = $$('#battle-log div.skill')[0];
  console.log('例：', missLine && missLine.textContent, '|', skillLine && skillLine.textContent);
  await ui.startBattle({ kind: 'region', id: 'ruins', difficulty: 1 }); await sleep(10);
  console.log('冷卻中再打：', $('#toast').textContent);
  // 掉落可以點
  const chip = $$('#battle-result .chip.drop')[0];
  if (chip) { click(chip); await sleep(10); console.log('點掉落：', $('#info-title').textContent, '|', $('#info-body').textContent.slice(0, 40)); click($('#info-close')); }
  // 立即：不捲到底
  click($$('#battle-footer button').find(b => b.textContent === '立即')); await sleep(10);
  click($$('#battle-footer button').find(b => b.textContent === '重播')); await sleep(30);
  console.log('立即重播：結果已顯示', !!$('#battle-result').textContent, '捲動位置', $('#battle-modal .body').scrollTop, '速度選項還在', $$('#battle-footer button').some(b => b.textContent === '慢'));
  click($$('#battle-footer button').find(b => b.textContent === '中')); await sleep(10);
  click($$('#battle-footer button').find(b => b.textContent === '關閉'));
  for (let i = 0; i < 24; i++) {
    noCd(); await sleep(260);
    click(btn('出發'));
    for (let k = 0; k < 50 && !$('#battle-modal').classList.contains('open'); k++) await sleep(20);
    if (!$('#battle-modal').classList.contains('open')) { console.log('彈窗沒出現', errors); process.exit(1); }
    const jump = $$('#battle-footer button').find(b => b.textContent === '跳到結尾');
    if (!jump) { console.log('第', i + 1, '場 footer:', $$('#battle-footer button').map(b => b.textContent), 'log lines', $$('#battle-log div').length, errors); process.exit(1); }
    click(jump);
    await sleep(10);
    if ($('#battle-result').textContent.includes('勝利')) wins++;
    click($$('#battle-footer button').find(b => b.textContent === '關閉'));
  }
  const engr = Object.values(ui.state.engravings).reduce((a, b) => a + b, 0);
  noCd();
  console.log('25 場：勝', wins, '刻印', engr, '能量', ui.state.energy, '紀錄', JSON.parse(w.localStorage.getItem('tbtf-game-history')).length);
  // 重播第一筆紀錄
  click(btn('重播')); await sleep(30);
  if (!$('#battle-modal').classList.contains('open')) console.log('重播彈窗沒打開');
  click($$('#battle-footer button').find(b => b.textContent === '跳到結尾')); await sleep(10);
  console.log('重播彈窗：', $('#battle-title').textContent, '|', $('#battle-result').textContent.slice(0, 30));
  click($$('#battle-footer button').find(b => b.textContent === '關閉'));
  const yes = async () => { await sleep(10); if ($('#ask-modal').classList.contains('open')) click($('#ask-yes')); await sleep(50); };
  const sub = async label => { click($$('.subtabs button').find(b => b.textContent === label)); await sleep(20); };
  // 工坊：側欄隱藏、第二層分頁
  click($$('#nav button').find(b => b.textContent === '工坊')); await sleep(50);
  console.log('工坊側欄隱藏：', $('.layout').classList.contains('no-side'), '分頁：', $$('.subtabs button').map(b => b.textContent).join('/'));
  // 右鍵看刻印數值
  $$('table.bag td')[1].dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await sleep(10);
  console.log('右鍵數值：', $('#info-modal').classList.contains('open'), $('#info-title').textContent, '|', $('#info-body').textContent.slice(0, 60));
  click($('#info-close'));
  // 換分頁會清掉選擇，不會出現負數
  for (let i = 0; i < 10; i++) { const cell = $$('table.bag td.pick')[0]; if (!cell) break; click(cell); await sleep(5); }
  await sub('刻印合成');
  for (let i = 0; i < 3; i++) { const c = $$('table.bag td.pick')[0]; if (c) { click(c); await sleep(5); } }
  await sub('製作裝備');
  console.log('換分頁後：製作材料', $$('.chips')[0].children.length, '負數格', $$('table.bag td').filter(td => td.textContent.startsWith('-')).length);
  await sub('刻印合成');
  console.log('換回合成：已選', $$('.chips')[0].children.length);
  await sub('製作裝備');
  // 製作 1 件武器
  for (let i = 0; i < 10; i++) { const cell = $$('table.bag td.pick')[0]; if (!cell) break; click(cell); await sleep(5); }
  console.log('材料數：', $$('.chips')[0].children.length, '沒有預覽：', !text().includes('預覽'));
  $('#craft-name').value = '堅韌布甲'; $('#craft-name').dispatchEvent(new w.Event('input', { bubbles: true }));
  click($$('button').find(b => b.textContent === '製作')); await sleep(50);
  console.log('製作後裝備數：', ui.state.equipment.length, '提示：', $('#toast').textContent);
  // 分解刻印
  await sub('分解刻印');
  const before = ui.state.energy;
  click($$('table.bag td.pick')[0]); await sleep(10);
  click(btn('全部')); await sleep(10);
  click($$('button').find(b => b.textContent === '分解')); await sleep(50);
  console.log('分解刻印：能量', before, '→', ui.state.energy, $('#toast').textContent);
  // 合成：不同階不能混
  await sub('刻印合成');
  const firstPick = $$('table.bag td.pick')[0]; click(firstPick); await sleep(10);
  const tierCol = [...firstPick.parentElement.children].indexOf(firstPick);
  const otherCols = $$('table.bag tr').slice(1).flatMap(tr => [...tr.children].filter((td, i) => i !== tierCol && i > 0 && td.classList.contains('pick')));
  console.log('合成：選第一個後其他階可點的格數', otherCols.length);
  for (let i = 0; i < 2; i++) { const c = $$('table.bag td.pick')[0]; if (c) { click(c); await sleep(5); } }
  const combineBtn = $$('button').find(b => b.textContent === '合成');
  if (!combineBtn.disabled) { click(combineBtn); await sleep(50); }
  console.log('合成：', $('#toast').textContent);
  // 刻印到裝備（新做的那件）
  await sub('刻印到裝備');
  setSelect($('main select'), ui.state.equipment[ui.state.equipment.length - 1].id); await sleep(10);
  console.log('灰色列：', $$('table.bag tr.off').map(tr => tr.firstChild.textContent).join('、'));
  click($$('table.bag td.pick')[0]); await sleep(10);
  const engraveBtn = $$('button').find(b => b.textContent.startsWith('刻印（'));
  if (engraveBtn) { click(engraveBtn); await sleep(50); }
  console.log('刻印：', $('#toast').textContent);
  const clearBtn = $$('button').find(b => b.textContent.startsWith('清除（'));
  if (clearBtn) { const e0 = ui.state.energy; click(clearBtn); await yes(); console.log('清除：', $('#toast').textContent, '能量', e0, '→', ui.state.energy); }
  // 寶石頁也沒有側欄；不合法的連結只提示一次
  click($$('#nav button').find(b => b.textContent === '寶石')); await sleep(30);
  console.log('寶石側欄隱藏：', $('.layout').classList.contains('no-side'));
  ui.state.gems.critup || (await (async () => { const S = w.Game.save; const st = S.addGems(ui.state, 'critup', 1); w.GameUI.ui.__inject = st; })());
  if (w.GameUI.ui.__inject) { w.GameUI.forceState(w.GameUI.ui.__inject); await sleep(30); }
  const ed = $$('.link-editor')[0];
  setSelect(ed.querySelectorAll('select')[0], 'magicmissile'); setSelect(ed.querySelectorAll('select')[1], 'critup');
  $('#toast').textContent = '';
  click([...ed.querySelectorAll('button')].find(b => b.textContent === '套用')); await sleep(50);
  const errText = $$('.link-editor .error').map(e => e.textContent).join('|');
  console.log('連結錯誤：', JSON.stringify(errText), '出現次數', errText.split('無法連結').length - 1, 'toast：', JSON.stringify($('#toast').textContent));
  // 帶著不合法的修改離開：按「儲存」會留在寶石頁並顯示錯誤；再按「不儲存」才離開
  click($$('#nav button').find(b => b.textContent === '裝備')); await sleep(30);
  click($('#ask-yes')); await sleep(50);
  console.log('不合法時儲存：留在', $$('#nav button').find(b => b.classList.contains('active')).textContent, 'toast：', $('#toast').textContent);
  // 裝備頁：穿上新武器、分解模式
  click($$('#nav button').find(b => b.textContent === '裝備')); await sleep(30);
  click($('#ask-no')); await sleep(50);
  const wear = $$('.item button').find(b => b.textContent === '穿上');
  if (wear) { click(wear); await sleep(50); }
  console.log('穿著武器：', ui.state.equipped.weapon, '件數', ui.state.equipment.length);
  click(btn('分解模式')); await sleep(30);
  // 批量分解：勾選 → 頂端列（可獲得刻印數、黑骰數）→ 取消／確認分解（兩次確認）
  const picks = $$('.item .salvage-pick input[type=checkbox]');
  console.log('分解勾選框：', picks.length, '新手武器：', $$('.item .salvage-pick').some(e => e.textContent === '不能分解'), '列隱藏：', $('#batch-bar').hidden);
  if (picks.length) {
    const check = el => { el.checked = true; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
    check(picks[0]); await sleep(20);
    console.log('勾選後：', $('#batch-bar').hidden ? '列隱藏' : $('#batch-bar').textContent);
    click([...$('#batch-bar').querySelectorAll('button')].find(b => b.textContent === '取消')); await sleep(30);
    console.log('取消後：列隱藏', $('#batch-bar').hidden, '勾選', $$('.item .salvage-pick input:checked').length);
    const count = ui.state.equipment.length;
    check($$('.item .salvage-pick input[type=checkbox]')[0]); await sleep(20);
    click([...$('#batch-bar').querySelectorAll('button')].find(b => b.textContent === '確認分解')); await sleep(20);
    const first = $('#ask-text').textContent;
    click($('#ask-yes')); await sleep(20);
    const second = $('#ask-modal').classList.contains('open') ? $('#ask-text').textContent : '（沒有第二次確認）';
    console.log('第一次確認：', first); console.log('第二次確認：', second);
    await yes();
    console.log('分解裝備：', $('#toast').textContent, '件數', count, '→', ui.state.equipment.length, '列隱藏', $('#batch-bar').hidden);
  }
  // 單件分解按鈕（保留，2026-11-22 使用者）
  const salv = $$('.item button').find(b => b.textContent.startsWith('分解（'));
  console.log('單件分解按鈕：', salv ? salv.textContent : '無');
  if (salv) { const n = ui.state.equipment.length; click(salv); await yes(); console.log('單件分解：', $('#toast').textContent, '件數', n, '→', ui.state.equipment.length); }
  // 王
  click($$('#nav button').find(b => b.textContent === '冒險')); await sleep(50);
  noCd(); await sleep(260);
  click(btn('挑戰'));
  for (let k = 0; k < 50 && !$('#battle-modal').classList.contains('open'); k++) await sleep(20);
  click($$('#battle-footer button').find(b => b.textContent === '跳到結尾')); await sleep(10);
  console.log('王戰：', $('#battle-title').textContent, $('#battle-result').textContent.slice(0, 40));
  click($$('#battle-footer button').find(b => b.textContent === '關閉'));
  // 難度 +／−
  for (let i = 0; i < 6; i++) { click($$('.stepper button')[1]); await sleep(20); }
  click($$('.stepper button')[0]); await sleep(20);
  console.log('難度：', ui.state.settings.difficulty, '|', $('.stepper').parentElement.textContent);
  // 改名
  $('#player-name').value = '   '; click(btn('確認')); await sleep(30);
  console.log('空名字：', $('#toast').textContent, $('#toast').className, ui.state.settings.playerName);
  $('#player-name').value = ' 阿明 '; click(btn('確認')); await sleep(30);
  console.log('改名：', $('#toast').textContent, ui.state.settings.playerName);
  noCd(); await sleep(260);
  click(btn('出發'));
  for (let k = 0; k < 50 && !$('#battle-modal').classList.contains('open'); k++) await sleep(20);
  click($$('#battle-footer button').find(b => b.textContent === '跳到結尾')); await sleep(10);
  console.log('戰報用新名字：', $('#battle-log').textContent.includes('阿明'), '舊名字：', $('#battle-log').textContent.includes('玩家'));
  click($$('#battle-footer button').find(b => b.textContent === '關閉'));
  // 重新載入頁面：存檔還在
  // 深色模式切換
  const t0 = w.document.documentElement.dataset.theme, b0 = $('#theme-toggle').textContent;
  click($('#theme-toggle')); await sleep(10);
  console.log('主題：', t0, b0, '→', w.document.documentElement.dataset.theme, $('#theme-toggle').textContent, '記住：', w.localStorage.getItem('tbtf-game-theme'));
  click($('#theme-toggle')); await sleep(10);
  console.log('再切回：', w.document.documentElement.dataset.theme, w.localStorage.getItem('tbtf-game-theme'), '存檔沒有主題：', !w.localStorage.getItem('tbtf-game-save').includes('theme'));
  // 寶石頁有未套用的修改時離開：點外面留下、不儲存、儲存（2026-11-22 使用者）
  {
    const nav = label => click($$('#nav button').find(b => b.textContent === label));
    nav('寶石'); await sleep(40);
    const sel = () => $$('.link-editor')[0].querySelectorAll('select')[0];
    const before = JSON.stringify(ui.state.equipment.find(e => e.id === ui.state.equipped.weapon).links);
    const other = [...sel().options].map(o => o.value).find(v => v && v !== sel().value) ?? '';
    setSelect(sel(), other);
    nav('冒險'); await sleep(30);
    console.log('離開寶石頁的彈窗：', $('#ask-modal').classList.contains('open') ? $('#ask-text').textContent : '沒有', '按鈕：', $('#ask-yes').textContent, '/', $('#ask-no').textContent);
    click($('#ask-modal')); await sleep(30);
    console.log('點外面：留在', w.GameUI.ui && $$('#nav button').find(b => b.classList.contains('active')).textContent, '還原取消鍵文字：', $('#ask-no').textContent);
    nav('工坊'); await sleep(30); click($('#ask-no')); await sleep(40);
    const afterNo = JSON.stringify(ui.state.equipment.find(e => e.id === ui.state.equipped.weapon).links);
    console.log('不儲存：到', $$('#nav button').find(b => b.classList.contains('active')).textContent, '連結不變', afterNo === before);
    nav('寶石'); await sleep(40);
    console.log('回到寶石頁：選單顯示已存的值', sel().value === (JSON.parse(before)[0]?.active ?? ''));
    setSelect(sel(), other);
    nav('裝備'); await sleep(30); click($('#ask-yes')); await sleep(60);
    const afterYes = ui.state.equipment.find(e => e.id === ui.state.equipped.weapon).links;
    console.log('儲存：到', $$('#nav button').find(b => b.classList.contains('active')).textContent, '主動寶石', JSON.stringify(afterYes), 'toast', $('#toast').textContent);
    nav('寶石'); await sleep(40); nav('冒險'); await sleep(30);
    console.log('沒修改直接離開：彈窗', $('#ask-modal').classList.contains('open'), '到', $$('#nav button').find(b => b.classList.contains('active')).textContent);
  }
  // 連續光環（2026-11-24）：主動寶石是光環且輔助槽有連續光環時，輔助槽才列出其他光環主動寶石
  {
    const S = w.Game.save;
    let st = ui.state;
    for (const g of ['thorns', 'endure', 'chainaura']) if (!(st.gems[g] > 0)) st = S.addGems(st, g, 1);
    w.GameUI.forceState(st); await sleep(30);
    click($$('#nav button').find(b => b.textContent === '寶石')); await sleep(40);
    const sels = () => $$('.link-editor')[0].querySelectorAll('select');
    const opts = i => [...sels()[i].options].map(o => o.value);
    setSelect(sels()[0], 'thorns'); await sleep(20);
    for (let i = 1; i < sels().length; i++) setSelect(sels()[i], '');
    await sleep(20);
    console.log('連續光環：沒連時輔助槽有忍耐', opts(1).includes('endure'));
    setSelect(sels()[1], 'chainaura'); await sleep(20);
    console.log('連續光環：連了之後輔助槽有忍耐', opts(2).includes('endure'), '沒有荊棘自己', !opts(2).includes('thorns'));
    setSelect(sels()[2], 'endure'); await sleep(20);
    click([...$$('.link-editor')[0].querySelectorAll('button')].find(b => b.textContent === '套用')); await sleep(60);
    console.log('連續光環：套用', JSON.stringify(ui.state.equipment.find(e => e.id === ui.state.equipped.weapon).links), '忍耐仍擁有', ui.state.gems.endure);
    console.log('連續光環：被連結的光環也吃的提示', ($$('.link-editor')[0].textContent.match(/被連結的忍耐也吃：[^被套還]*/) || ['沒有'])[0]);
    setSelect(sels()[0], 'magicmissile'); await sleep(20);
    console.log('連續光環：連到魔法飛彈的提示', $$('.link-editor')[0].textContent.includes('目前沒有效果'));
    click([...$$('.link-editor')[0].querySelectorAll('button')].find(b => b.textContent === '還原')); await sleep(30);
  }
  const saved = w.localStorage.getItem('tbtf-game-save');
  console.log('存檔有寫入：', !!saved, '錯誤：', errors.length ? errors : '無');
  process.exit(0);
})();
