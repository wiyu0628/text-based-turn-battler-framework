'use strict';

/**
 * 把框架（src/）與寶石檔（gems.js、gemCompiler.js）打包進 gems-ui.template.html，產生單一檔案 gems-ui.html。
 * 產生的 HTML 不需要網路、不需要 Node，用瀏覽器直接開啟即可。
 *
 * 執行：node gems/gems-ui-build.js [輸出路徑]      （預設輸出到 gems/gems-ui.html）
 * 寶石資料或編譯器改了之後，重新執行一次就會同步到 UI。
 *
 * 這是測試用的小工具：沒有用到打包工具，只是把 CommonJS 檔案包進一個極簡的 require 外殼。
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

const files = [...listJs('src'), 'gems/statLayer.js', 'gems/gems.js', 'gems/gemCompiler.js'];

// 每個檔案包成 function (module, exports, require)；require 依檔案位置解析相對路徑。
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
  window.GemLab = Object.assign({}, load('src/index.js'), load('gems/statLayer.js'), load('gems/gems.js'), load('gems/gemCompiler.js'));
})();`;

const template = read('gems/gems-ui.template.html');
if (!template.includes('/*__BUNDLE__*/')) throw new Error('模板裡找不到 /*__BUNDLE__*/ 標記');
const output = process.argv[2] || path.join(__dirname, 'gems-ui.html');
fs.writeFileSync(output, template.replace('/*__BUNDLE__*/', () => bundle));
console.log(`已產生 ${path.relative(process.cwd(), output)}（${(fs.statSync(output).size / 1024).toFixed(0)} KB，包含 ${files.length} 個模組）`);
