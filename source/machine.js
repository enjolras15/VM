// =========================================================
// メモリマップ
// =========================================================
const MEM_SIZE      = 0x10000;            // 64 KB
const VRAM_BASE     = 0x8000;
const VRAM_COLS     = 80;
const VRAM_ROWS     = 25;
const VRAM_SIZE     = VRAM_COLS * VRAM_ROWS;   // 2000 バイト

const MMIO_CURSOR_X = 0xC000;
const MMIO_CURSOR_Y = 0xC001;
const MMIO_FG       = 0xC002;
const MMIO_BG       = 0xC003;
// =========================================================
// リセットベクタ
// ---------------------------------------------------------
// リセット時に PC が設定されるアドレス。Z80/8080 方式の
// 固定 0x0000 を採用（6502 の 0xFFFC/0xFFFD 間接ベクタでは
// ない）。
// =========================================================
const RESET_VECTOR = 0x0000;

// =========================================================
// パレット（VGA 16 色相当）
// =========================================================
const PALETTE = [
  "#000000", "#0000AA", "#00AA00", "#00AAAA",
  "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
  "#555555", "#5555FF", "#55FF55", "#55FFFF",
  "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF",
];

// =========================================================
// オペコード
// =========================================================
const OP = {
  NOP:   0x00,
  HLT:   0x01,
  LDI:   0x02,
  LDX:   0x03,
  LDA:   0x04,
  STA:   0x05,
  LDA_X: 0x06,
  STA_X: 0x07,
  ADD:   0x08,
  SUB:   0x09,
  CMP:   0x0A,
  INC:   0x0B,
  DEC:   0x0C,
  INX:   0x0D,
  DEX:   0x0E,
  CPX:   0x0F,
  JMP:   0x10,
  JZ:    0x11,
  JNZ:   0x12,
};

// =========================================================
// CPU
// =========================================================
class CPU {
  constructor(memory) {
    this.mem = memory;
    this.reset();
  }

  reset() {
    this.A = 0;         // 8bit アキュムレータ
    this.X = 0;         // 16bit インデックス
    this.PC = RESET_VECTOR;        // 16bit プログラムカウンタ
    this.Z = false;     // ゼロフラグ
    this.halted = false;
  }

  rd8(a)      { return this.mem[a & 0xFFFF]; }
  wr8(a, v)   { this.mem[a & 0xFFFF] = v & 0xFF; }
  rd16(a)     { return this.rd8(a) | (this.rd8(a + 1) << 8); }

  step() {
    if (this.halted) return false;

    // fetch
    const op      = this.rd8(this.PC);
    const operand = this.rd16(this.PC + 1);
    this.PC = (this.PC + 3) & 0xFFFF;

    // execute
    switch (op) {
      case OP.NOP:   break;
      case OP.HLT:   this.halted = true; break;

      case OP.LDI:   this.A = operand & 0xFF; this.Z = this.A === 0; break;
      case OP.LDX:   this.X = operand & 0xFFFF; this.Z = this.X === 0; break;

      case OP.LDA:   this.A = this.rd8(operand); this.Z = this.A === 0; break;
      case OP.STA:   this.wr8(operand, this.A); break;

      case OP.LDA_X: this.A = this.rd8(operand + this.X); this.Z = this.A === 0; break;
      case OP.STA_X: this.wr8(operand + this.X, this.A); break;

      case OP.ADD:   this.A = (this.A + this.rd8(operand)) & 0xFF; this.Z = this.A === 0; break;
      case OP.SUB:   this.A = (this.A - this.rd8(operand)) & 0xFF; this.Z = this.A === 0; break;
      case OP.CMP:   this.Z = (this.A === this.rd8(operand)); break;

      case OP.INC:   this.A = (this.A + 1) & 0xFF; this.Z = this.A === 0; break;
      case OP.DEC:   this.A = (this.A - 1) & 0xFF; this.Z = this.A === 0; break;
      case OP.INX:   this.X = (this.X + 1) & 0xFFFF; this.Z = this.X === 0; break;
      case OP.DEX:   this.X = (this.X - 1) & 0xFFFF; this.Z = this.X === 0; break;
      case OP.CPX:   this.Z = (this.X === (operand & 0xFFFF)); break;

      case OP.JMP:   this.PC = operand; break;
      case OP.JZ:    if (this.Z)  this.PC = operand; break;
      case OP.JNZ:   if (!this.Z) this.PC = operand; break;

      default:
        throw new Error(
          `Unknown opcode 0x${op.toString(16)} at 0x${(this.PC - 3).toString(16)}`
        );
    }

    if (this.PC+3>=MEM_SIZE) this.halted = true;

    return true;
  }

// 指定サイクル数だけ実行（halted になったら途中で抜ける）
  runSlice(maxSteps) {
    let n = 0;
    while (!this.halted && n < maxSteps) {
      this.step();
      n++;
    }
    return n;
  }

}

// =========================================================
// ビデオチップ（VRAM を走査して描く）
// =========================================================
class VideoChip {
  constructor(canvas, memory) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");
    this.mem    = memory;
    this.cellW  = 8;
    this.cellH  = 16;
    canvas.width  = VRAM_COLS * this.cellW;
    canvas.height = VRAM_ROWS * this.cellH;
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    const bg = PALETTE[this.mem[MMIO_BG] & 0x0F];
    const fg = PALETTE[this.mem[MMIO_FG] & 0x0F];

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.font = "13px monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = fg;

    for (let row = 0; row < VRAM_ROWS; row++) {
      for (let col = 0; col < VRAM_COLS; col++) {
        const ch = this.mem[VRAM_BASE + row * VRAM_COLS + col];
        if (ch === 0 || ch === 32) continue;
        ctx.fillText(String.fromCharCode(ch), col * this.cellW, row * this.cellH);
      }
    }

    // ハードウェアカーソル
    const cx = this.mem[MMIO_CURSOR_X];
    const cy = this.mem[MMIO_CURSOR_Y];
    if (cx < VRAM_COLS && cy < VRAM_ROWS) {
      ctx.fillStyle = fg;
      ctx.fillRect(cx * this.cellW, cy * this.cellH + this.cellH - 3, this.cellW, 2);
    }
  }
}