const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatui/app.js'), 'utf8');
const slice = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const code = source.match(/const defaults = [^\n]+/)[0] + '\n' +
  slice('settingsState.settings = undefined;', 'chatState.sessions = new Map();') +
  slice('function applySettings()', 'settingsState.runtimeSnapshot = null;') +
  source.match(/for \(const \[id, key\] of \[\["selectThemeMode"[^\n]+/)[0] +
  '\nglobalThis.ui = { applySettings, settings: settingsState.settings };';
function harness(saved) {
  let storage=saved===undefined?null:JSON.stringify(saved);
  const nodes=new Map(), calls=[], classes=new Set();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',classList:{toggle(){}},setAttribute(){},addEventListener(event,fn){this.listener=fn;}});return nodes.get(id);};
  const context=vm.createContext({settingsState:{}, localStorage:{getItem(){return storage;},setItem(key,value){assert.equal(key,'real-ui-settings-1');storage=value;}},
    document:{body:{classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}},documentElement:{classList:{toggle(){}},style:{setProperty(){}}}},
    window:{desktopHost:{setTheme(...args){calls.push(args);}}},byId:node,refreshLabels(){},renderAnalysisOverview(){}});
  vm.runInContext(code,context);context.ui.applySettings();
  return {ui:context.ui,node,classes,calls,get stored(){return JSON.parse(storage);},change(id,value){node(id).listener({target:{value}});}};
}
test('old and malformed palette preferences retain the existing soft theme',()=>{
  for(const saved of [undefined,{theme:'light',zoom:'1.25',intent:false},{palette:'invalid'},{palette:null}]){
    const h=harness(saved);assert.equal(h.ui.settings.palette,'soft');assert.equal(h.classes.has('palette-standard'),false);
    if(saved?.theme){assert.equal(h.ui.settings.theme,'light');assert.equal(h.ui.settings.zoom,'1.25');assert.equal(h.ui.settings.intent,false);}
  }
});
test('palette selection saves immediately without altering independent preferences and restores after restart',()=>{
  const h=harness({theme:'light',zoom:'1.5',intent:false,backgroundAnalyze:true});
  h.change('selectColorPalette','standard');assert.ok(h.classes.has('palette-standard'));assert.ok(h.classes.has('theme-light'));
  assert.equal(h.node('selectColorPalette').value,'standard');assert.deepEqual(h.calls.at(-1),['light','standard']);
  assert.deepEqual(h.stored,{theme:'light',palette:'standard',zoom:'1.5',intent:false,backgroundAnalyze:true});
  const reopened=harness(h.stored);assert.ok(reopened.classes.has('palette-standard'));
  reopened.change('selectThemeMode','dark');assert.ok(reopened.classes.has('palette-standard'));assert.equal(reopened.classes.has('theme-light'),false);
  assert.deepEqual(reopened.calls.at(-1),['dark','standard']);
});
test('returning to soft restores the old theme class while retaining dark/light and zoom choices',()=>{
  const h=harness({theme:'dark',palette:'standard',zoom:'1.25'});
  h.change('selectColorPalette','soft');assert.equal(h.classes.has('palette-standard'),false);assert.equal(h.stored.palette,'soft');
  assert.equal(h.ui.settings.zoom,'1.25');assert.deepEqual(h.calls.at(-1),['dark','soft']);
});
