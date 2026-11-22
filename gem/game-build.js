'use strict';

/**
 * 正式遊戲介面的打包：把框架（src/）與遊戲層模組包進 game.template.html，產生單一檔案 game.html。
 * 產生的 HTML 不需要網路、不需要 Node，用瀏覽器直接開啟；存檔放在瀏覽器的 localStorage。
 *
 * 執行：node gem/game-build.js [輸出路徑]      （預設輸出到 gem/game.html）
 * 遊戲資料（寶石、刻印、怪物、王…）或邏輯改了之後，重新執行一次。
 * 與舊的測試版 gems-ui（gems-ui-build.js）無關，兩者各自打包。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function listJs(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return listJs(relative);
    return entry.name.endsWith('.js') ? [relative] : [];
  });
}

// 遊戲層用到的模組（不含測試、模擬與打包腳本）
const GAME_MODULES = ['statLayer', 'gems', 'gemCompiler', 'affixTable', 'craftTable', 'dropTable', 'energyTable',
  'legendaryTable', 'accessoryTable', 'difficulty', 'resonance', 'chord', 'monsters', 'silver', 'bosses', 'saveLayer', 'game'].map(name => `gem/${name}.js`);
const files = [...listJs('src'), ...GAME_MODULES];

const modules = files.map(file => {
  const code = read(file).replace(/<\/script/gi, '<\\/script');
  return `${JSON.stringify(file)}: function (module, exports, require) {\n${code}\n}`;
}).join(',\n');

const bundle = `(function () {
  var modules = {
${modules}
  };
  var cache = {};
  function dirname(file) { var i = file.lastIndexOf('/'); return i < 0 ? '' : file.slice(0, i); }
  function normalize(parts) {
    var out = [];
    parts.forEach(function (part) {
      if (part === '' || part === '.') return;
      if (part === '..') out.pop(); else out.push(part);
    });
    return out.join('/');
  }
  function resolve(from, request) {
    var base = normalize((dirname(from) + '/' + request).split('/'));
    var candidates = [base, base + '.js', base + '/index.js'];
    for (var i = 0; i < candidates.length; i++) if (modules[candidates[i]]) return candidates[i];
    throw new Error('找不到模組：' + request + '（從 ' + from + '）');
  }
  function load(file) {
    if (cache[file]) return cache[file].exports;
    var module = { exports: {} };
    cache[file] = module;
    modules[file](module, module.exports, function (request) { return load(resolve(file, request)); });
    return module.exports;
  }
  window.Game = {
    framework: load('src/index.js'),
    game: load('gem/game.js'), save: load('gem/saveLayer.js'), gems: load('gem/gems.js'), compiler: load('gem/gemCompiler.js'),
    stats: load('gem/statLayer.js'), affix: load('gem/affixTable.js'), craft: load('gem/craftTable.js'), drops: load('gem/dropTable.js'),
    energy: load('gem/energyTable.js'), legendary: load('gem/legendaryTable.js'), accessories: load('gem/accessoryTable.js'), monsters: load('gem/monsters.js'), bosses: load('gem/bosses.js'),
    difficulty: load('gem/difficulty.js')
  };
})();`;

const template = read('gem/game.template.html');
if (!template.includes('/*__BUNDLE__*/')) throw new Error('模板裡找不到 /*__BUNDLE__*/ 標記');
const output = process.argv[2] || path.join(__dirname, 'game.html');
fs.writeFileSync(output, template.replace('/*__BUNDLE__*/', () => bundle));
console.log(`已產生 ${path.relative(process.cwd(), output)}（${(fs.statSync(output).size / 1024).toFixed(0)} KB，包含 ${files.length} 個模組）`);
