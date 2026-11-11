import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, FunctionComponent, createDOM } from '../src/mini-react/index.js';

function mount(render, props) {
  const root = new JSDOM('<body></body>').window.document.body;
  return { root, instance: new FunctionComponent(render, root, props).mount() };
}
function Bar({ id, width, onClick }) {
  return h('button', { 'data-id': id, style: `width:${width}px`, onClick }, id + ':' + width);
}
const bars = ({ rows }) => h('section', {}, rows.map(row => h(Bar, { key: row.id, ...row })));

test('keyed stateless children preserve DOM/text nodes on middle removal, reorder and insertion', () => {
  const row = (id, width = 10) => ({ id, width });
  const { root, instance } = mount(bars, { rows: [row('a'), row('b'), row('c')] });
  const [a, b, c] = root.querySelectorAll('button');
  const textC = c.firstChild;
  instance.update({ rows: [row('c', 30), row('a', 20), row('d', 40)] });
  const result = [...root.querySelectorAll('button')];
  assert.equal(result[0], c);
  assert.equal(result[1], a);
  assert.equal(b.isConnected, false);
  assert.equal(c.firstChild, textC);
  assert.equal(c.textContent, 'c:30');
  assert.equal(c.style.width, '30px');
  assert.equal(a.style.width, '20px');
  assert.equal(result[2].dataset.id, 'd');
  assert.equal(root.querySelector('[key]'), null);
});

test('moving keys replaces event closures; removed/replaced nodes release handlers', () => {
  const calls = [];
  const { root, instance } = mount(bars, { rows: [
    {id:'a',width:1,onClick:()=>calls.push('old-a')},
    {id:'b',width:2,onClick:()=>calls.push('old-b')},
  ] });
  const [a,b] = root.querySelectorAll('button');
  instance.update({rows:[{id:'b',width:3,onClick:()=>calls.push('new-b')}]});
  b.click(); a.click();
  assert.deepEqual(calls, ['new-b']);
  instance.unmount(); b.click();
  assert.deepEqual(calls, ['new-b']);
});

test('same key with different type replaces only that DOM node after moving', () => {
  const render = ({ change }) => h('div', {}, change
    ? [h('p',{key:'b'},'new'),h('span',{key:'a'},'a')]
    : [h('span',{key:'a'},'a'),h('button',{key:'b'},'old')]);
  const {root,instance}=mount(render,{change:false});
  const [a,b]=root.firstChild.children;
  instance.update({change:true});
  assert.equal(root.firstChild.lastChild,a);
  assert.equal(root.firstChild.firstChild.localName,'p');
  assert.equal(b.isConnected,false);
});

test('nested keyed reorders resolve descendant patch targets against the original tree', () => {
  const render=({groups})=>h('main',{},groups.map(([id,items])=>h('section',{key:id},items.map(value=>h('i',{key:value},id+value)))));
  const {root,instance}=mount(render,{groups:[['a',['1','2']],['b',['3','4']]]});
  const [a,b]=root.firstChild.children;
  const [one,two]=a.children;
  const [three,four]=b.children;
  instance.update({groups:[['b',['4','3','5']],['a',['2','1']]]});
  assert.equal(root.firstChild.firstChild,b);
  assert.deepEqual([...a.children],[two,one]);
  assert.deepEqual([...b.children].slice(0,2),[four,three]);
  assert.equal(b.lastChild.textContent,'b5');
});

test('mixed children match unkeyed nodes only at the same absolute unkeyed index', () => {
  const render=({change})=>h('div',{},change
    ? [h('p',{key:'b'},'b'),h('p',{},'new unkeyed'),h('p',{key:'a'},'a')]
    : [h('p',{key:'a'},'a'),h('p',{},'old unkeyed'),h('p',{key:'b'},'b')]);
  const {root,instance}=mount(render,{change:false});
  const [a,unkeyed,b]=root.firstChild.children;
  instance.update({change:true});
  assert.deepEqual([...root.firstChild.children],[b,unkeyed,a]);
  assert.equal(unkeyed.textContent,'new unkeyed');
});

test('duplicate/invalid keys and keyed multi-root components fail before mutating DOM', () => {
  const render=({keys})=>h('div',{},keys.map(key=>h('p',{key},String(key))));
  const {root,instance}=mount(render,{keys:['a','b']});
  const a=root.querySelector('p'),before=root.innerHTML;
  for(const keys of [['a','a'],[{}],[NaN],[Infinity]]) {
    assert.throws(()=>instance.update({keys}),/key/i);
    assert.equal(root.innerHTML,before);
    assert.equal(root.querySelector('p'),a);
  }
  instance.update({keys:['b','a']});
  assert.equal(root.querySelector('p:last-child'),a);
  assert.throws(()=>createDOM(h('div',{},h('i',{key:1}),h('b',{key:1})),root.ownerDocument),/Duplicate/);
  const Fragment=()=>[h('span'),h('span')];
  assert.throws(()=>mount(()=>h(Fragment,{key:'x'})),/exactly one/);
});

test('key changes remount; numeric and string keys are distinct; unchanged keyed trees do not mutate', () => {
  const render=({keys})=>h('div',{},keys.map(key=>h('p',{key},String(key))));
  const {root,instance}=mount(render,{keys:[1,'1']});
  const [number,string]=root.firstChild.children;
  const observer=new root.ownerDocument.defaultView.MutationObserver(()=>{});
  observer.observe(root,{subtree:true,childList:true,attributes:true,characterData:true});
  instance.update({keys:[1,'1']});
  assert.deepEqual(observer.takeRecords(),[]);
  instance.update({keys:['1',1]});
  assert.deepEqual([...root.firstChild.children],[string,number]);
  instance.update({keys:['new',1]});
  assert.equal(string.isConnected,false);
  assert.equal(root.firstChild.lastChild,number);
  observer.disconnect();
});
