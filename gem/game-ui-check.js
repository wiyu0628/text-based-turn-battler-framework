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
  for (let i = 0; i < 25; i++) {
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
  // 裝備頁：穿上新武器、分解模式
  click($$('#nav button').find(b => b.textContent === '裝備')); await sleep(50);
  const wear = $$('.item button').find(b => b.textContent === '穿上');
  if (wear) { click(wear); await sleep(50); }
  console.log('穿著武器：', ui.state.equipped.weapon, '件數', ui.state.equipment.length);
  click(btn('分解模式')); await sleep(30);
  const salv = $$('.item button').find(b => b.textContent.startsWith('分解（'));
  console.log('分解按鈕：', salv ? salv.textContent : '無', '新手武器：', $$('.item button').some(b => b.textContent === '不能分解'));
  if (salv) { click(salv); await yes(); console.log('分解裝備：', $('#toast').textContent, '件數', ui.state.equipment.length); }
  // 王
  click($$('#nav button').find(b => b.textContent === '冒險')); await sleep(50);
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
  const saved = w.localStorage.getItem('tbtf-game-save');
  console.log('存檔有寫入：', !!saved, '錯誤：', errors.length ? errors : '無');
  process.exit(0);
})();
