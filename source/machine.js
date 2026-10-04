// =========================================================
// ユーティリティ
// =========================================================
const hex = (n, width = 4) => n.toString(16).padStart(width, "0");

// =========================================================
// メモリマップ
// =========================================================
const MEM_SIZE  = 0x10000;            // 64 KB
const VRAM_BASE = 0x8000;
const VRAM_COLS = 80;
const VRAM_ROWS = 25;
const VRAM_SIZE = VRAM_COLS * VRAM_ROWS * 2;   // 4000 バイト（文字 + 属性）

const MMIO_BASE     = 0xC000;
const MMIO_END      = 0xC0FF;
const MMIO_CURSOR_X = 0xC000;
const MMIO_CURSOR_Y = 0xC001;
const MMIO_BG       = 0xC003;

// リセット時の PC（Z80/8080 方式の固定 0x0000。6502 の間接ベクタではない）
const RESET_VECTOR = 0x0000;

// =========================================================
// 仮想NIC MMIO レジスタ
// ---------------------------------------------------------
// 専用命令ではなく MMIO で制御する。CPU は通常の STA / LDA で叩く。
// =========================================================
const MMIO_NIC_CMD       = 0xC010;  // コマンド（0=reset, 1=HTTP GET）
const MMIO_NIC_STATUS    = 0xC011;  // ステータス
const MMIO_NIC_TX_ADDR   = 0xC012;  // 送信データアドレス（下位）
const MMIO_NIC_TX_ADDR_H = 0xC013;  // 送信データアドレス（上位）
const MMIO_NIC_TX_LEN    = 0xC014;  // 送信データ長
const MMIO_NIC_RX_ADDR   = 0xC015;  // 受信バッファアドレス（下位）
const MMIO_NIC_RX_ADDR_H = 0xC016;  // 受信バッファアドレス（上位）
const MMIO_NIC_RX_LEN    = 0xC017;  // 受信データ長（NICが書き込む）

const NIC_CMD_RESET    = 0;
const NIC_CMD_GET      = 1;
const NIC_STATUS_IDLE  = 0;   // reset 後 / busy と同値（0=busy）
const NIC_STATUS_BUSY  = 0;
const NIC_STATUS_DONE  = 1;
const NIC_STATUS_ERROR = 2;
const NIC_MAX_RX       = 255;

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
    this.mmioWriteHook = null;
    this.reset();
  }

  reset() {
    this.A = 0;               // 8bit アキュムレータ
    this.X = 0;               // 16bit インデックス
    this.PC = RESET_VECTOR;   // 16bit プログラムカウンタ
    this.Z = false;           // ゼロ
    this.C = false;           // キャリー / ボロー
    this.N = false;           // ネガティブ
    this.V = false;           // オーバーフロー（未実装）
    this.halted = false;
  }

  rd8(a)  { return this.mem[a & 0xFFFF]; }
  rd16(a) { return this.rd8(a) | (this.rd8(a + 1) << 8); }

  wr8(a, v) {
    const addr = a & 0xFFFF;
    this.mem[addr] = v & 0xFF;
    // MMIO 領域への書き込みならデバイス側へ通知
    if (this.mmioWriteHook && addr >= MMIO_BASE && addr <= MMIO_END) {
      this.mmioWriteHook(addr, v & 0xFF);
    }
  }

  setA(v) { this.A = v & 0xFF;   this.Z = this.A === 0; }
  setX(v) { this.X = v & 0xFFFF; this.Z = this.X === 0; }

  // ADD / SUB の結果反映（result は 8bit を超える/負になりうる生の値）
  calc(result) {
    this.A = result & 0xFF;
    this.C = result > 0xFF || result < 0;   // キャリー or ボロー
    this.N = (this.A & 0x80) !== 0;
    this.Z = this.A === 0;
  }

  step() {
    if (this.halted) return false;

    // fetch
    const pc      = this.PC;
    const op      = this.rd8(pc);
    const operand = this.rd16(pc + 1);
    this.PC = (pc + 3) & 0xFFFF;

    // execute
    switch (op) {
      case OP.NOP:   break;
      case OP.HLT:   this.halted = true; break;

      case OP.LDI:   this.setA(operand); break;
      case OP.LDX:   this.setX(operand); break;
      case OP.LDA:   this.setA(this.rd8(operand)); break;
      case OP.STA:   this.wr8(operand, this.A); break;
      case OP.LDA_X: this.setA(this.rd8(operand + this.X)); break;
      case OP.STA_X: this.wr8(operand + this.X, this.A); break;

      case OP.ADD:   this.calc(this.A + this.rd8(operand)); break;
      case OP.SUB:   this.calc(this.A - this.rd8(operand)); break;
      case OP.CMP:   this.Z = this.A === this.rd8(operand); break;

      case OP.INC:   this.setA(this.A + 1); break;
      case OP.DEC:   this.setA(this.A - 1); break;
      case OP.INX:   this.setX(this.X + 1); break;
      case OP.DEX:   this.setX(this.X - 1); break;
      case OP.CPX:   this.Z = this.X === (operand & 0xFFFF); break;

      case OP.JMP:   this.PC = operand; break;
      case OP.JZ:    if (this.Z)  this.PC = operand; break;
      case OP.JNZ:   if (!this.Z) this.PC = operand; break;

      default:
        this.PC = pc;   // 不正命令の位置で止める
        throw new Error(`Unknown opcode 0x${hex(op, 2)} at 0x${hex(pc)}`);
    }

    // 次の命令がメモリ末尾に収まらないなら停止
    if (this.PC > MEM_SIZE - 3) this.halted = true;
    return true;
  }

  // 最大 maxSteps 命令実行（halted になったら途中で抜ける）。実行数を返す
  runSlice(maxSteps) {
    let n = 0;
    while (n < maxSteps && this.step()) n++;
    return n;
  }
}

// =========================================================
// ビデオチップ（VRAM を走査して描く）
// =========================================================
const GLYPHS = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));

class VideoChip {
  constructor(canvas, memory) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");
    this.mem    = memory;
    this.cellW  = 8;
    this.cellH  = 16;

    // canvas のサイズ変更でコンテキスト状態がリセットされるため、その後に設定する
    canvas.width  = VRAM_COLS * this.cellW;
    canvas.height = VRAM_ROWS * this.cellH;
    this.ctx.font = "13px monospace";
    this.ctx.textBaseline = "top";
  }

  clear(color = "#000") {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render() {
    const { ctx, mem, cellW, cellH } = this;

    this.clear(PALETTE[mem[MMIO_BG] & 0x0F]);

    let lastColor = null;   // fillStyle の再設定を減らす
    for (let row = 0; row < VRAM_ROWS; row++) {
      for (let col = 0; col < VRAM_COLS; col++) {
        const offset = VRAM_BASE + (row * VRAM_COLS + col) * 2;
        const ch = mem[offset];
        if (ch <= 32) continue;   // 空白・制御文字は描かない

        const color = PALETTE[mem[offset + 1] & 0x0F];
        if (color !== lastColor) {
          ctx.fillStyle = color;
          lastColor = color;
        }
        ctx.fillText(GLYPHS[ch], col * cellW, row * cellH);
      }
    }

    // ハードウェアカーソル
    const cx = mem[MMIO_CURSOR_X];
    const cy = mem[MMIO_CURSOR_Y];
    if (cx < VRAM_COLS && cy < VRAM_ROWS) {
      ctx.fillStyle = PALETTE[0x0F];
      ctx.fillRect(cx * cellW, cy * cellH + cellH - 3, cellW, 2);
    }
  }
}

// =========================================================
// 仮想NIC（HTTP GET のみ）
// ---------------------------------------------------------
// MMIO への書き込みを監視し、CMD=1 で fetch() を発行。
// 結果は RX_ADDR の指すメモリに書かれ、STATUS が 1(done) / 2(error) になる。
// CPU は LDA 0xC011 でポーリングして完了を待つ。
// ---------------------------------------------------------
// epoch: 新しいコマンドや reset() で加算され、古い通信の結果は破棄される
// （電源OFF/リセット後にメモリへ書き込まれるのを防ぐ）。
// =========================================================
class NIC {
  constructor(memory) {
    this.mem   = memory;
    this.epoch = 0;
    this.logFn = () => {};
  }

  setLogger(fn) { this.logFn = fn; }

  // 実行中の通信を無効化する
  reset() { this.epoch++; }

  // CPU の wr8 から呼ばれる
  onWrite(addr, value) {
    if (addr === MMIO_NIC_CMD) this.handleCommand(value);   // 非同期。await しない
  }

  async handleCommand(cmd) {
    const mem   = this.mem;
    const epoch = ++this.epoch;

    if (cmd === NIC_CMD_RESET) {
      mem[MMIO_NIC_STATUS] = NIC_STATUS_IDLE;
      this.logFn("[NIC] reset");
      return;
    }
    if (cmd !== NIC_CMD_GET) {
      mem[MMIO_NIC_STATUS] = NIC_STATUS_ERROR;
      this.logFn("[NIC] unknown command: " + cmd);
      return;
    }

    mem[MMIO_NIC_STATUS] = NIC_STATUS_BUSY;   // await 前に同期で立てる
    const url = this.readString(
      mem[MMIO_NIC_TX_ADDR] | (mem[MMIO_NIC_TX_ADDR_H] << 8),
      mem[MMIO_NIC_TX_LEN]
    );
    this.logFn("[NIC] GET " + url);

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const text = await resp.text();
      if (epoch !== this.epoch) return;   // 取り消された

      const rxAddr = mem[MMIO_NIC_RX_ADDR] | (mem[MMIO_NIC_RX_ADDR_H] << 8);
      const n = Math.min(text.length, NIC_MAX_RX);
      for (let i = 0; i < n; i++) {
        mem[(rxAddr + i) & 0xFFFF] = text.charCodeAt(i) & 0xFF;
      }
      mem[(rxAddr + n) & 0xFFFF] = 0;     // ヌル終端
      mem[MMIO_NIC_RX_LEN] = n;
      mem[MMIO_NIC_STATUS] = NIC_STATUS_DONE;
      this.logFn(`[NIC] done: ${n} bytes`);
    } catch (e) {
      if (epoch !== this.epoch) return;
      mem[MMIO_NIC_STATUS] = NIC_STATUS_ERROR;
      this.logFn("[NIC] error: " + e.message);
    }
  }

  // addr から最大 len バイト（ヌルまで）を文字列として読む
  readString(addr, len) {
    let s = "";
    for (let i = 0; i < len; i++) {
      const c = this.mem[(addr + i) & 0xFFFF];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}
