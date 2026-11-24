import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Tiny stack VM (make.fun ISA v1): 32-bit wrapping ints, a 256-value stack,
// a 64-deep call stack, 256 words of memory, ten traps with their own codes.
// run(prog, input) -> [stdout Buffer, exit code 0..255]
function run(p, inp) {
  const n = p.length;
  const s = new Int32Array(257);
  const c = new Int32Array(65);
  const m = new Int32Array(256);
  let sp = 0, cp = 0, pc = 0, steps = 0, ip = 0, o = '';
  const done = (code) => [Buffer.from(o, 'latin1'), code];
  for (;;) {
    if (steps >= 1000000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = p[pc];
    const known = op <= 7 || (op >= 16 && op <= 30) || (op >= 32 && op <= 34) ||
      (op >= 48 && op <= 52) || (op >= 64 && op <= 65) || (op >= 80 && op <= 83);
    if (!known) return done(5);
    const il = op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
    if (pc + 1 + il > n) return done(9);
    steps++;
    // binary ops: 0x10-0x16, 0x18-0x1A, 0x1C-0x1E, 0x20-0x22
    if ((op >= 16 && op <= 22) || op === 24 || op === 25 || op === 26 ||
        (op >= 28 && op <= 30) || (op >= 32 && op <= 34)) {
      if (sp < 2) return done(2);
      const b = s[--sp], a = s[--sp];
      let r;
      if (op === 16) r = (a + b) | 0;
      else if (op === 17) r = (a - b) | 0;
      else if (op === 18) r = Math.imul(a, b);
      else if (op === 19) { if (b === 0) return done(4); r = (a / b) | 0; }
      else if (op === 20) { if (b === 0) return done(4); r = (a % b) | 0; }
      else if (op === 21) { if (b === 0) return done(4); r = ((a >>> 0) / (b >>> 0)) | 0; }
      else if (op === 22) { if (b === 0) return done(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
      else if (op === 24) r = a & b;
      else if (op === 25) r = a | b;
      else if (op === 26) r = a ^ b;
      else if (op === 28) r = a << (b & 31);
      else if (op === 29) r = a >> (b & 31);
      else if (op === 30) r = (a >>> (b & 31)) | 0;
      else if (op === 32) r = a === b ? 1 : 0;
      else if (op === 33) r = a < b ? 1 : 0;
      else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
      s[sp++] = r;
      pc++;
      continue;
    }
    switch (op) {
      case 0: return done(0); // HALT
      case 1: // PUSH8, sign-extended
        if (sp >= 256) return done(3);
        s[sp++] = (p[pc + 1] << 24) >> 24;
        pc += 2;
        break;
      case 2: // PUSH32
        if (sp >= 256) return done(3);
        s[sp++] = p.readInt32LE(pc + 1);
        pc += 5;
        break;
      case 3: // POP
        if (sp < 1) return done(2);
        sp--;
        pc++;
        break;
      case 4: // DUP
        if (sp < 1) return done(2);
        if (sp >= 256) return done(3);
        s[sp] = s[sp - 1];
        sp++;
        pc++;
        break;
      case 5: { // SWAP
        if (sp < 2) return done(2);
        const t = s[sp - 1];
        s[sp - 1] = s[sp - 2];
        s[sp - 2] = t;
        pc++;
        break;
      }
      case 6: // OVER
        if (sp < 2) return done(2);
        if (sp >= 256) return done(3);
        s[sp] = s[sp - 2];
        sp++;
        pc++;
        break;
      case 7: { // ROT (a b c -- b c a)
        if (sp < 3) return done(2);
        const t = s[sp - 3];
        s[sp - 3] = s[sp - 2];
        s[sp - 2] = s[sp - 1];
        s[sp - 1] = t;
        pc++;
        break;
      }
      case 23: // NEG
        if (sp < 1) return done(2);
        s[sp - 1] = (-s[sp - 1]) | 0;
        pc++;
        break;
      case 27: // NOT
        if (sp < 1) return done(2);
        s[sp - 1] = ~s[sp - 1];
        pc++;
        break;
      case 48: // JMP
        pc = pc + 3 + p.readInt16LE(pc + 1);
        break;
      case 49: { // JZ
        if (sp < 1) return done(2);
        const v = s[--sp];
        pc = v === 0 ? pc + 3 + p.readInt16LE(pc + 1) : pc + 3;
        break;
      }
      case 50: { // JNZ
        if (sp < 1) return done(2);
        const v = s[--sp];
        pc = v !== 0 ? pc + 3 + p.readInt16LE(pc + 1) : pc + 3;
        break;
      }
      case 51: // CALL
        if (cp >= 64) return done(7);
        c[cp++] = pc + 3;
        pc = p.readUInt16LE(pc + 1);
        break;
      case 52: // RET
        if (cp === 0) return done(8);
        pc = c[--cp];
        break;
      case 64: { // LOAD
        if (sp < 1) return done(2);
        const a = s[--sp];
        if (a < 0 || a > 255) return done(6);
        s[sp++] = m[a];
        pc++;
        break;
      }
      case 65: { // STORE (v addr --)
        if (sp < 2) return done(2);
        const a = s[--sp], v = s[--sp];
        if (a < 0 || a > 255) return done(6);
        m[a] = v;
        pc++;
        break;
      }
      case 80: { // PRINT, decimal, no newline
        if (sp < 1) return done(2);
        const str = String(s[--sp]);
        if (o.length + str.length > 65536) return done(11);
        o += str;
        pc++;
        break;
      }
      case 81: { // PUTC, one byte
        if (sp < 1) return done(2);
        const v = s[--sp];
        if (o.length + 1 > 65536) return done(11);
        o += String.fromCharCode(v & 255);
        pc++;
        break;
      }
      case 82: // IN, -1 past the end of the input
        if (sp >= 256) return done(3);
        s[sp++] = ip < inp.length ? inp[ip++] : -1;
        pc++;
        break;
      case 83: { // EXIT, low byte
        if (sp < 1) return done(2);
        return done(s[--sp] & 255);
      }
    }
  }
}

// Answer every instance of the set in one run.
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (let i = 1; i <= 40; i++) {
  const id = 'i' + String(i).padStart(3, '0');
  let out = Buffer.alloc(0), code = 0;
  try {
    [out, code] = run(readFileSync(`${I}/${id}/program.bin`), readFileSync(`${I}/${id}/input.bin`));
  } catch { /* an unreadable instance still gets an answer file */ }
  mkdirSync(`${O}/${id}`, { recursive: true });
  writeFileSync(`${O}/${id}/stdout.bin`, out);
  writeFileSync(`${O}/${id}/exit.txt`, String(code));
}
