// =========================================================
// Opcode 定義（8bit）
// =========================================================
const OPCODES = {
  HALT: 0, MOVI: 1, MOVR: 2, ADDI: 3, ADDR: 4,
  SUBI: 5, SUBR: 6, MULI: 7, MULR: 8, JMP: 9,
  LOAD: 10, STORE: 11, JZ: 12, JNZ: 13, LF: 14,
  PRINT: 15, PRINTC: 16, CLS: 17,
};

const REGISTERS = { R0: 0, R1: 1, R2: 2, R3: 3 };

// 固定長：opcode(1) + operandA(1) + operandB(1) = 3 bytes
const INSTRUCTION_SIZE = 3;

// =========================================================
// VM
// =========================================================
class VM {
  constructor(display) {
    this.reg = new Int16Array(4);   // 符号付き（負の演算結果も保持できるように）
    this.ir = 0;
    this.pc = 0;
    this.out = display;
    this.memory = new Uint8Array(1024);
    this.memory.fill(0);
  }

  run() {
    this.pc = 0;
    this.running = true;

    while (this.running) {
      if (this.pc + INSTRUCTION_SIZE > this.memory.length) break;

      // fetch
      const op = this.memory[this.pc];
      const a  = this.memory[this.pc + 1];
      const b  = this.memory[this.pc + 2];
      this.ir = op;
      this.pc += INSTRUCTION_SIZE;

      // execute
      this.exec(op, a, b);
    }
  }

  loadProgram(bytes) {
    this.memory.fill(0);
    for (let i = 0; i < bytes.length && i < this.memory.length; i++) {
      this.memory[i] = bytes[i] & 0xff;
    }
    console.log("loaded bytes:", Array.from(this.memory.slice(0, bytes.length)));
  }

  exec(op, a, b) {
    switch (op) {
      case OPCODES.HALT:   this.running = false; break;
      case OPCODES.MOVI:   this.reg[a] = b; break;
      case OPCODES.MOVR:   this.reg[a] = this.reg[b]; break;
      case OPCODES.ADDI:   this.reg[a] += b; break;
      case OPCODES.ADDR:   this.reg[a] += this.reg[b]; break;
      case OPCODES.SUBI:   this.reg[a] -= b; break;
      case OPCODES.SUBR:   this.reg[a] -= this.reg[b]; break;
      case OPCODES.MULI:   this.reg[a] *= b; break;
      case OPCODES.MULR:   this.reg[a] *= this.reg[b]; break;
      case OPCODES.JMP:    this.pc = a; break;
      case OPCODES.LOAD:   this.reg[a] = this.memory[b]; break;
      case OPCODES.STORE:  this.memory[a] = this.reg[b] & 0xff; break;
      case OPCODES.JZ:     if (this.reg[a] === 0) this.pc = b; break;
      case OPCODES.JNZ:    if (this.reg[a] !== 0) this.pc = b; break;
      case OPCODES.LF:     this.out.lf(); break;
      case OPCODES.PRINT:  this.out.print(this.reg[a].toString()); break;
      case OPCODES.PRINTC: this.out.printChar(this.reg[a]); break;
      case OPCODES.CLS:    this.out.clear(); break;
      default:
        throw new Error("Unknown opcode: " + op);
    }
  }
}

// =========================================================
// Display
// =========================================================
class Display {
  constructor(canvas) {
    this.ctx = canvas.getContext("2d");
    this.ctx.font = "16px monospace";
    this.ctx.fillStyle = "white";
    this.x = 0;
    this.y = 16;
  }
  print(text)        { this.ctx.fillText(text, this.x, this.y); this.x += 20; }
  printChar(code)    { this.ctx.fillText(String.fromCharCode(code), this.x, this.y); this.x += 10; }
  lf()               { this.x = 0; this.y += 16; }
  clear()            { this.ctx.clearRect(0, 0, 500, 500); this.x = 0; this.y = 16; }
}

// =========================================================
// Setup
// =========================================================
const canvas = document.getElementById("screen");
const display = new Display(canvas);
let vm = new VM(display);

function reboot() {
  vm = new VM(display);
  display.clear();
}

// =========================================================
// Assembler: アセンブリ → バイト列
// =========================================================
function isRegister(tok) {
  return tok !== undefined && tok in REGISTERS;
}

function encodeOperand(tok) {
  if (tok === undefined) return 0;
  if (tok in REGISTERS) return REGISTERS[tok];
  const n = Number(tok);
  if (Number.isNaN(n)) throw new Error("Invalid operand: " + tok);
  return n & 0xff;
}

function assemble(code) {
  const lines = code
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith(";"));

  const bytes = [];

  for (const line of lines) {
    const parts = line.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    const mnemonic = parts[0];
    const operands = parts.slice(1);

    // ORG : 指定アドレスまで 0 埋め
    if (mnemonic === "ORG") {
      const origin = Number(operands[0]) | 0;
      while (bytes.length < origin) bytes.push(0);
      continue;
    }

    // ---- エイリアス解決（オペランドの型で I/R を自動判定）----
    let opName = mnemonic;
    if (mnemonic === "MOV") {
      opName = isRegister(operands[1]) ? "MOVR" : "MOVI";
    } else if (mnemonic === "ADD") {
      opName = isRegister(operands[1]) ? "ADDR" : "ADDI";
    } else if (mnemonic === "SUB") {
      opName = isRegister(operands[1]) ? "SUBR" : "SUBI";
    } else if (mnemonic === "MUL") {
      opName = isRegister(operands[1]) ? "MULR" : "MULI";
    }

    const opcode = OPCODES[opName];
    if (opcode === undefined) {
      throw new Error("Unknown instruction: " + mnemonic);
    }

    // 固定長 3 バイトで出力
    bytes.push(opcode & 0xff);
    bytes.push(encodeOperand(operands[0]));
    bytes.push(encodeOperand(operands[1]));
  }

  return bytes;
}

// =========================================================
// Binary loader: 既に二進数で書かれていた場合
// =========================================================
function isBinaryCode(code) {
  const lines = code
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith(";"));

  if (lines.length === 0) return false;

  let hasBinary = false;

  for (const line of lines) {
    // カンマ区切りも許容
    const tokens = line.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      // アセンブリっぽいトークンが1つでもあればアセンブリ扱い
      if (OPCODES[t] !== undefined) return false;
      if (t in REGISTERS) return false;
      if (t === "ORG") return false;
      if (["MOV", "ADD", "SUB", "MUL"].includes(t)) return false;

      // 0/1 以外が含まれていたらバイナリではない
      if (!/^[01]+$/.test(t)) return false;

      hasBinary = true;
    }
  }
  return hasBinary;
}

function loadFromBinary(code) {
  const bytes = [];
  const lines = code
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith(";"));

  for (const line of lines) {
    const tokens = line.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      bytes.push(parseInt(t, 2) & 0xff);
    }
  }
  return bytes;
}

// =========================================================
// Entry point
// =========================================================
function run() {
  const src = document.getElementById("source").value;

  let bytes;
  if (isBinaryCode(src)) {
    console.log(">> 二進数入力として直接ロード");
    bytes = loadFromBinary(src);
  } else {
    console.log(">> アセンブルしてバイトコードに変換");
    bytes = assemble(src);
  }

  vm.loadProgram(bytes);
  vm.run();
}