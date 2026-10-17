// Tests for: notepad merging, notepad history, shared counter history, saving to disk
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a temporary file so tests never touch your real saved data
const TMP_FILE = path.join(os.tmpdir(), 'syncspace-test-' + process.pid + '.json');
process.env.DATA_FILE = TMP_FILE;

const srv = require('../server/server');
const SyncSpace = require('../web/syncspace.js');
const OT = require('../web/ot.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, ms = 5000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error('Timed out waiting for: ' + label);
};

let passed = 0, failed = 0;
async function runTest(name, fn) {
  try { await fn(); passed++; console.log('  ✓ PASS: ' + name); }
  catch (e) { failed++; console.error('  ✗ FAIL: ' + name + ' - ' + e.message); }
}

// A tiny "page" = library connection + notepad logic, same as index.html does
function makePage(url, room, name, clientId) {
  const page = { text: '', docClient: null, history: [], counter: { value: 0, history: [] } };
  page.room = SyncSpace.connect({ url, room, name, clientId, connectTimeout: 1500 });
  page.room.joinExtra = () => (page.docClient ? { docRev: page.docClient.rev } : null);
  const send = (rev, op, opId, resend) => page.room.send('doc-op', { rev, op, opId, resend: !!resend });
  page.room.on('welcome', msg => {
    const d = msg.doc;
    if (!page.docClient) { page.docClient = new OT.DocClient(d.rev, d.text, send); page.text = d.text; }
    else {
      let ok = Array.isArray(msg.docOps);
      if (ok) for (const o of msg.docOps) {
        const r = page.docClient.receive(o.rev, o.op, o.opId);
        if (r === false) { ok = false; break; }
      }
      const clean = !page.docClient.pending && !page.docClient.buffer;
      if (!ok || page.docClient.rev !== d.rev || (clean && page.docClient.text !== d.text)) page.docClient.reset(d.rev, d.text);
      else page.docClient.resend();
      page.text = page.docClient.text;
    }
    page.history = msg.docHistory.slice();
    page.counter = { value: msg.counter.value, history: msg.counter.history.slice() };
  });
  page.room.on('message', msg => {
    const c = page.docClient;
    if (msg.t === 'counter') { page.counter.value = msg.value; page.counter.history.push(msg.entry); }
    else if (msg.t === 'doc-ack') { c.ack(msg.rev); }
    else if (msg.t === 'doc-op') { c.receive(msg.rev, msg.op, msg.opId); }
    else if (msg.t === 'doc-resync') { c.reset(msg.rev, msg.text); }
    page.text = c ? c.text : '';
  });
  page.type = newText => { page.docClient.setLocalText(newText); page.text = newText; };
  return page;
}

(async () => {
  console.log('\n========================================');
  console.log('🧪 Notepad / Counter / History tests');
  console.log('========================================\n');

  await new Promise(r => srv.server.listen(0, r));
  const url = 'ws://127.0.0.1:' + srv.server.address().port;
  const pages = [];
  const page = (room, name, id) => { const p = makePage(url, room, name, id); pages.push(p); return p; };
  const settle = async (...ps) => {
    await waitUntil(() => ps.every(p => p.docClient && !p.docClient.pending && !p.docClient.buffer), 5000, 'edits confirmed');
    await sleep(150);
  };

  await runTest('Two people typing at the same time: BOTH edits are kept', async () => {
    const a = page('t1', 'Asha', 'asha1'), b = page('t1', 'Ben', 'ben1');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    a.type('Hello');
    await settle(a, b);
    assert.strictEqual(b.text, 'Hello');
    // both type at once, before seeing each other's change
    a.type('Hello Asha');
    b.type('Big Hello');
    await settle(a, b);
    assert.strictEqual(a.text, b.text, 'Both screens must show the same text');
    assert.ok(a.text.includes('Asha') && a.text.includes('Big'), 'Both edits must survive, got: ' + a.text);
  });

  await runTest('One person erasing while another types: both screens match', async () => {
    const a = page('t2', 'Asha', 'asha2'), b = page('t2', 'Ben', 'ben2');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    a.type('one two three');
    await settle(a, b);
    a.type('one three');           // Asha erases "two "
    b.type('one two three four');  // Ben adds at the end at the same time
    await settle(a, b);
    assert.strictEqual(a.text, b.text);
    assert.strictEqual(a.text, 'one three four');
  });

  await runTest('Both erase the same words at once: no damage', async () => {
    const a = page('t3', 'Asha', 'asha3'), b = page('t3', 'Ben', 'ben3');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    a.type('abcdefghij');
    await settle(a, b);
    a.type('abchij');   // erase def g
    b.type('abcdefj');  // erase ghi
    await settle(a, b);
    assert.strictEqual(a.text, b.text);
    assert.strictEqual(a.text, 'abcj');
  });

  await runTest('Many random simultaneous edits from 3 people always end identical', async () => {
    const ps = [page('t4', 'A', 'r1'), page('t4', 'B', 'r2'), page('t4', 'C', 'r3')];
    await waitUntil(() => ps.every(p => p.docClient), 3000, 'joined');
    const rnd = n => Math.floor(Math.random() * n);
    for (let round = 0; round < 40; round++) {
      for (const p of ps) {
        if (rnd(2)) continue;
        const t = p.text, pos = rnd(t.length + 1), del = rnd(Math.min(3, t.length - pos) + 1);
        p.type(t.slice(0, pos) + (rnd(3) ? 'xyz'.slice(0, 1 + rnd(3)) : '') + t.slice(pos + del));
      }
      if (rnd(3) === 0) await sleep(rnd(15));
    }
    await settle(...ps);
    assert.strictEqual(ps[0].text, ps[1].text);
    assert.strictEqual(ps[1].text, ps[2].text);
  });

  await runTest('Notepad history records WHICH USER edited', async () => {
    const a = page('t5', 'Asha', 'asha5'), b = page('t5', 'Ben', 'ben5');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    a.type('from asha');
    await settle(a, b);
    await sleep(8300); // typing by someone else after the merge window = a new history line
    b.type('from asha + ben');
    await settle(a, b);
    const c = page('t5', 'Cara', 'cara5'); // late joiner sees the full history
    await waitUntil(() => c.docClient, 3000, 'late join');
    const names = c.history.map(h => h.user);
    assert.deepStrictEqual(names, ['Asha', 'Ben']);
    assert.ok(c.history[0].addedText.includes('from asha'));
    assert.ok(c.history.every(h => typeof h.ts === 'number'));
    assert.strictEqual(c.text, 'from asha + ben');
  });

  await runTest('Counter: two people click at once, BOTH clicks count', async () => {
    const a = page('t6', 'Asha', 'asha6'), b = page('t6', 'Ben', 'ben6');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    for (let i = 0; i < 5; i++) { a.room.send('counter', { action: 'inc' }); b.room.send('counter', { action: 'inc' }); }
    await waitUntil(() => a.counter.value === 10 && b.counter.value === 10, 4000, 'counter = 10');
  });

  await runTest('Counter history shows who increased, decreased and reset', async () => {
    const a = page('t7', 'Asha', 'asha7'), b = page('t7', 'Ben', 'ben7');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    a.room.send('counter', { action: 'inc' });
    await waitUntil(() => b.counter.value === 1, 3000, 'inc seen');
    b.room.send('counter', { action: 'dec' });
    await waitUntil(() => a.counter.value === 0, 3000, 'dec seen');
    a.room.send('counter', { action: 'inc' });
    await waitUntil(() => b.counter.value === 1, 3000, 'inc2 seen');
    b.room.send('counter', { action: 'reset' });
    await waitUntil(() => a.counter.value === 0 && a.counter.history.length === 4, 3000, 'reset seen');
    const h = a.counter.history.map(e => e.user + ':' + e.action);
    assert.deepStrictEqual(h, ['Asha:inc', 'Ben:dec', 'Asha:inc', 'Ben:reset']);
    const late = page('t7', 'Cara', 'cara7');
    await waitUntil(() => late.docClient, 3000, 'late join');
    assert.strictEqual(late.counter.history.length, 4, 'late joiner sees full counter history');
  });

  await runTest('Typing while disconnected is kept and merged after reconnect', async () => {
    const a = page('t8', 'Asha', 'asha8'), b = page('t8', 'Ben', 'ben8');
    await waitUntil(() => a.docClient && b.docClient, 3000, 'joined');
    a.type('start');
    await settle(a, b);
    a.room.simulateDisconnect();
    a.type('start A');          // typed while offline
    b.type('B start');          // Ben types meanwhile
    await sleep(100);
    await waitUntil(() => a.room.status === 'open', 8000, 'reconnected');
    await settle(a, b);
    assert.strictEqual(a.text, b.text);
    assert.ok(a.text.includes('A') && a.text.includes('B'), 'got: ' + a.text);
  });

  await runTest('Bad notepad messages cannot crash the server', async () => {
    const a = page('t9', 'Asha', 'asha9');
    await waitUntil(() => a.docClient, 3000, 'joined');
    a.room.send('doc-op', { rev: 'x', op: 'nope', opId: 5 });
    a.room.send('doc-op', { rev: 0, op: [999999], opId: 'z' });
    a.room.send('counter', { action: 'explode' });
    await sleep(400); // let the server answer the bad messages first
    a.type('still works');
    await settle(a);
    assert.strictEqual(a.text, 'still works');
  });

  await runTest('Room data (text + both histories) is saved to a file and restored', async () => {
    srv.enablePersistence();
    const a = page('t10', 'Asha', 'asha10');
    await waitUntil(() => a.docClient, 3000, 'joined');
    a.type('remember me');
    a.room.send('counter', { action: 'inc' });
    await settle(a);
    await waitUntil(() => a.counter.value === 1, 3000, 'counter');
    srv.saveToDisk();
    const onDisk = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
    assert.strictEqual(onDisk.rooms.t10.doc.text, 'remember me');
    assert.strictEqual(onDisk.rooms.t10.docHistory[0].user, 'Asha');
    assert.strictEqual(onDisk.rooms.t10.counter.history[0].user, 'Asha');
    // simulate a server restart: forget everything in memory, then load the file
    a.room.close();
    await sleep(100);
    srv.rooms.delete('t10');
    srv.saved.clear();
    srv.loadFromDisk();
    const b = page('t10', 'Ben', 'ben10');
    await waitUntil(() => b.docClient, 3000, 'joined after restart');
    assert.strictEqual(b.text, 'remember me');
    assert.strictEqual(b.history[0].user, 'Asha');
    assert.strictEqual(b.counter.value, 1);
  });

  pages.forEach(p => { try { p.room.close(); } catch (e) {} });
  try { fs.unlinkSync(TMP_FILE); } catch (e) {}
  console.log('\n========================================');
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');
  srv.wss.close();
  srv.server.close();
  process.exit(failed ? 1 : 0);
})();
