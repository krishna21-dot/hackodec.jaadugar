/*!
 * ot.js — shared text-editing logic for the SyncSpace notepad.
 * Used by BOTH the server (Node.js) and the browser, so they always agree.
 *
 * Why this exists: if two people type or erase at the same time, simply sending
 * "the whole text" lets the last sender overwrite the other person. Instead we
 * send small EDIT OPERATIONS and "transform" them so both edits survive.
 *
 * An operation is a plain array (easy to send as JSON) made of:
 *   - a positive number  -> keep that many characters
 *   - a negative number  -> delete that many characters
 *   - a string           -> insert that text
 * Example: [5, "hi", -2, 10] = keep 5 chars, insert "hi", delete 2, keep 10.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SyncOT = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var isRetain = function (c) { return typeof c === 'number' && c > 0; };
  var isDelete = function (c) { return typeof c === 'number' && c < 0; };
  var isInsert = function (c) { return typeof c === 'string'; };

  // Builds a clean (merged) operation
  function Builder() { this.ops = []; }
  Builder.prototype.retain = function (n) {
    if (n <= 0) return this;
    var l = this.ops.length;
    if (l && isRetain(this.ops[l - 1])) this.ops[l - 1] += n; else this.ops.push(n);
    return this;
  };
  Builder.prototype.insert = function (s) {
    if (!s) return this;
    var o = this.ops, l = o.length;
    if (l && isInsert(o[l - 1])) {
      o[l - 1] += s;
    } else if (l && isDelete(o[l - 1])) {
      // keep "insert" before "delete" so equal operations look identical
      if (l >= 2 && isInsert(o[l - 2])) o[l - 2] += s;
      else { o[l] = o[l - 1]; o[l - 1] = s; }
    } else {
      o.push(s);
    }
    return this;
  };
  Builder.prototype.del = function (n) {
    if (n <= 0) return this;
    var l = this.ops.length;
    if (l && isDelete(this.ops[l - 1])) this.ops[l - 1] -= n; else this.ops.push(-n);
    return this;
  };

  // Is this array a valid operation? (used by the server on untrusted input)
  function isValid(op) {
    if (!Array.isArray(op) || op.length > 5000) return false;
    for (var i = 0; i < op.length; i++) {
      var c = op[i];
      if (typeof c === 'number') {
        if (!Number.isInteger(c) || c === 0) return false;
      } else if (typeof c !== 'string' || c.length === 0) {
        return false;
      }
    }
    return true;
  }

  // Length of text this operation expects to start from
  function baseLength(op) {
    var n = 0;
    for (var i = 0; i < op.length; i++) {
      if (isRetain(op[i])) n += op[i]; else if (isDelete(op[i])) n -= op[i];
    }
    return n;
  }

  // Length of text after the operation is applied
  function targetLength(op) {
    var n = 0;
    for (var i = 0; i < op.length; i++) {
      if (isRetain(op[i])) n += op[i]; else if (isInsert(op[i])) n += op[i].length;
    }
    return n;
  }

  // Apply an operation to text and return the new text
  function apply(text, op) {
    if (baseLength(op) !== text.length) {
      throw new Error('apply: operation does not match text length');
    }
    var out = [], pos = 0;
    for (var i = 0; i < op.length; i++) {
      var c = op[i];
      if (isRetain(c)) { out.push(text.slice(pos, pos + c)); pos += c; }
      else if (isInsert(c)) { out.push(c); }
      else { pos -= c; }
    }
    return out.join('');
  }

  // What did this operation add and remove? (for the history list)
  function describe(text, op) {
    var added = '', removed = '', pos = 0;
    for (var i = 0; i < op.length; i++) {
      var c = op[i];
      if (isRetain(c)) pos += c;
      else if (isInsert(c)) added += c;
      else { removed += text.slice(pos, pos - c); pos -= c; }
    }
    return { added: added, removed: removed };
  }

  // Turn "old text -> new text" into one operation (finds the changed middle part)
  function fromDiff(oldText, newText) {
    var max = Math.min(oldText.length, newText.length), pre = 0;
    while (pre < max && oldText.charCodeAt(pre) === newText.charCodeAt(pre)) pre++;
    var suf = 0;
    while (suf < max - pre &&
           oldText.charCodeAt(oldText.length - 1 - suf) === newText.charCodeAt(newText.length - 1 - suf)) suf++;
    var b = new Builder();
    b.retain(pre);
    b.del(oldText.length - pre - suf);
    b.insert(newText.slice(pre, newText.length - suf));
    b.retain(suf);
    return b.ops;
  }

  // Combine two operations (a then b) into one
  function compose(a, b) {
    var res = new Builder(), i1 = 0, i2 = 0, o1 = a[0], o2 = b[0];
    while (o1 !== undefined || o2 !== undefined) {
      if (isDelete(o1)) { res.del(-o1); o1 = a[++i1]; continue; }
      if (isInsert(o2)) { res.insert(o2); o2 = b[++i2]; continue; }
      if (o1 === undefined) throw new Error('compose: first operation is too short');
      if (o2 === undefined) throw new Error('compose: first operation is too long');
      if (isRetain(o1) && isRetain(o2)) {
        if (o1 > o2) { res.retain(o2); o1 -= o2; o2 = b[++i2]; }
        else if (o1 === o2) { res.retain(o1); o1 = a[++i1]; o2 = b[++i2]; }
        else { res.retain(o1); o2 -= o1; o1 = a[++i1]; }
      } else if (isInsert(o1) && isDelete(o2)) {
        if (o1.length > -o2) { o1 = o1.slice(-o2); o2 = b[++i2]; }
        else if (o1.length === -o2) { o1 = a[++i1]; o2 = b[++i2]; }
        else { o2 += o1.length; o1 = a[++i1]; }
      } else if (isInsert(o1) && isRetain(o2)) {
        if (o1.length > o2) { res.insert(o1.slice(0, o2)); o1 = o1.slice(o2); o2 = b[++i2]; }
        else if (o1.length === o2) { res.insert(o1); o1 = a[++i1]; o2 = b[++i2]; }
        else { res.insert(o1); o2 -= o1.length; o1 = a[++i1]; }
      } else if (isRetain(o1) && isDelete(o2)) {
        if (o1 > -o2) { res.del(-o2); o1 += o2; o2 = b[++i2]; }
        else if (o1 === -o2) { res.del(-o2); o1 = a[++i1]; o2 = b[++i2]; }
        else { res.del(o1); o2 += o1; o1 = a[++i1]; }
      } else {
        throw new Error('compose: unexpected operation parts');
      }
    }
    return res.ops;
  }

  // THE KEY FUNCTION. Two people edited the same starting text at the same time
  // (a and b). Returns [a2, b2] so that:  start + a + b2  ==  start + b + a2.
  // If both insert at the very same spot, "a" goes first.
  function transform(a, b) {
    var a2 = new Builder(), b2 = new Builder();
    var i1 = 0, i2 = 0, o1 = a[0], o2 = b[0], m;
    while (o1 !== undefined || o2 !== undefined) {
      if (isInsert(o1)) { a2.insert(o1); b2.retain(o1.length); o1 = a[++i1]; continue; }
      if (isInsert(o2)) { a2.retain(o2.length); b2.insert(o2); o2 = b[++i2]; continue; }
      if (o1 === undefined) throw new Error('transform: first operation is too short');
      if (o2 === undefined) throw new Error('transform: first operation is too long');
      if (isRetain(o1) && isRetain(o2)) {
        if (o1 > o2) { m = o2; o1 -= o2; o2 = b[++i2]; }
        else if (o1 === o2) { m = o1; o1 = a[++i1]; o2 = b[++i2]; }
        else { m = o1; o2 -= o1; o1 = a[++i1]; }
        a2.retain(m); b2.retain(m);
      } else if (isDelete(o1) && isDelete(o2)) {
        if (-o1 > -o2) { o1 -= o2; o2 = b[++i2]; }
        else if (o1 === o2) { o1 = a[++i1]; o2 = b[++i2]; }
        else { o2 -= o1; o1 = a[++i1]; }
      } else if (isDelete(o1) && isRetain(o2)) {
        if (-o1 > o2) { m = o2; o1 += o2; o2 = b[++i2]; }
        else if (-o1 === o2) { m = o2; o1 = a[++i1]; o2 = b[++i2]; }
        else { m = -o1; o2 += o1; o1 = a[++i1]; }
        a2.del(m);
      } else if (isRetain(o1) && isDelete(o2)) {
        if (o1 > -o2) { m = -o2; o1 += o2; o2 = b[++i2]; }
        else if (o1 === -o2) { m = o1; o1 = a[++i1]; o2 = b[++i2]; }
        else { m = o1; o2 += o1; o1 = a[++i1]; }
        b2.del(m);
      } else {
        throw new Error('transform: unexpected operation parts');
      }
    }
    return [a2.ops, b2.ops];
  }

  // Where does a cursor position end up after an operation is applied?
  function transformCursor(index, op) {
    var rest = index, out = index;
    for (var i = 0; i < op.length; i++) {
      var c = op[i];
      if (isRetain(c)) rest -= c;
      else if (isInsert(c)) out += c.length;
      else { out -= Math.min(rest, -c); rest += c; }
      if (rest < 0) break;
    }
    return out;
  }

  /*
   * DocClient — keeps ONE user's copy of the shared document correct.
   * It remembers what was sent but not yet confirmed (pending) and what was typed
   * after that (buffer), and transforms incoming edits against both.
   *
   * send(rev, op, opId, isResend) is a function you provide that sends to the server.
   */
  function DocClient(rev, text, send) {
    this.rev = rev;
    this.text = text;
    this.send = send;
    this.pending = null; // { op, id } sent, waiting for confirmation
    this.buffer = null;  // operation typed while waiting
    this.counter = 0;
    this.prefix = Math.random().toString(36).slice(2, 8);
  }

  DocClient.prototype.nextId = function () {
    return this.prefix + '-' + (++this.counter);
  };

  // User changed their text box
  DocClient.prototype.setLocalText = function (newText) {
    if (newText === this.text) return;
    var op = fromDiff(this.text, newText);
    this.text = newText;
    if (!this.pending) {
      this.pending = { op: op, id: this.nextId() };
      this.send(this.rev, op, this.pending.id, false);
    } else {
      this.buffer = this.buffer ? compose(this.buffer, op) : op;
    }
  };

  // Server confirmed OUR pending edit. Returns false if something looks wrong.
  DocClient.prototype.ack = function (rev) {
    if (!this.pending || rev !== this.rev + 1) return false;
    this.rev = rev;
    this.pending = null;
    if (this.buffer) {
      this.pending = { op: this.buffer, id: this.nextId() };
      this.buffer = null;
      this.send(this.rev, this.pending.op, this.pending.id, false);
    }
    return true;
  };

  // Someone else's edit arrived. Returns the operation to apply to the text box,
  // or null if it was a duplicate, or false if we missed something (need resync).
  DocClient.prototype.receive = function (rev, op, opId) {
    if (rev <= this.rev) return null;
    if (rev !== this.rev + 1) return false;
    if (this.pending && opId && this.pending.id === opId) {
      return this.ack(rev) ? null : false; // it was our own edit coming back
    }
    try {
      var t;
      if (this.pending) {
        t = transform(this.pending.op, op);
        this.pending.op = t[0];
        op = t[1];
        if (this.buffer) {
          t = transform(this.buffer, op);
          this.buffer = t[0];
          op = t[1];
        }
      }
      this.text = apply(this.text, op);
    } catch (e) {
      return false;
    }
    this.rev = rev;
    return op;
  };

  // Throw away local state and use the server's text
  DocClient.prototype.reset = function (rev, text) {
    this.rev = rev;
    this.text = text;
    this.pending = null;
    this.buffer = null;
  };

  // After reconnecting, send the unconfirmed edit again
  DocClient.prototype.resend = function () {
    if (this.pending) this.send(this.rev, this.pending.op, this.pending.id, true);
  };

  return {
    Builder: Builder,
    isValid: isValid,
    baseLength: baseLength,
    targetLength: targetLength,
    apply: apply,
    describe: describe,
    fromDiff: fromDiff,
    compose: compose,
    transform: transform,
    transformCursor: transformCursor,
    DocClient: DocClient
  };
});
