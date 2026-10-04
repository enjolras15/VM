// =========================================================
// アセンブラ（2パス）
// ---------------------------------------------------------
// 構文:  [label:] MNEMONIC [operand]   ; コメント
// operand: 10進 / 0x1F / $1F / 'c' / ラベル / LO(式) / HI(式)
// DB     : カンマ区切りの数値・文字・"文字列"
// 全命令 3 バイト固定（opcode + 16bit オペランド, リトルエンディアン）
// =========================================================
const INSTRUCTION_SIZE = 3;
const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

function assemble(source) {
  const { statements, labels } = pass1(source);
  return pass2(statements, labels);
}

// --- Pass 1: 構文解析 + ラベルのアドレス確定 ---------------
function pass1(source) {
  const labels = new Map();
  const statements = [];
  let addr = 0;

  source.split("\n").forEach((rawLine, index) => {
    const lineNo = index + 1;
    let rest = stripComment(rawLine).trim();
    if (!rest) return;

    const lm = rest.match(LABEL_RE);
    if (lm) {
      if (labels.has(lm[1])) throw lineError(lineNo, "Duplicate label: " + lm[1]);
      labels.set(lm[1], addr);
      rest = lm[2];
      if (!rest) return;
    }

    const m = rest.match(/^(\S+)\s*(.*)$/);
    const mnemonic   = m[1].toUpperCase();
    const operandStr = m[2];

    if (mnemonic === "DB") {
      const items = splitOperands(operandStr);
      statements.push({ lineNo, mnemonic, items });
      addr += items.reduce((n, item) => n + dbItemSize(item), 0);
    } else {
      if (!Object.prototype.hasOwnProperty.call(OP, mnemonic)) {
        throw lineError(lineNo, "Unknown mnemonic: " + mnemonic);
      }
      statements.push({ lineNo, mnemonic, operandStr });
      addr += INSTRUCTION_SIZE;
    }
  });

  return { statements, labels };
}

// --- Pass 2: バイト列生成 ---------------------------------
function pass2(statements, labels) {
  const bytes = [];

  for (const st of statements) {
    try {
      if (st.mnemonic === "DB") {
        for (const item of st.items) emitDbItem(item, labels, bytes);
      } else {
        const operand = parseOperand(st.operandStr, labels);
        bytes.push(OP[st.mnemonic], operand & 0xFF, (operand >> 8) & 0xFF);
      }
    } catch (e) {
      throw lineError(st.lineNo, e.message);
    }
  }
  return new Uint8Array(bytes);
}

function lineError(lineNo, message) {
  return new Error(`Line ${lineNo}: ${message}`);
}

// =========================================================
// 字句処理
// =========================================================

// 引用符の外にある ';' 以降を取り除く（"a;b" や ';' を壊さない）
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ";") {
      return line.slice(0, i);
    }
  }
  return line;
}

// 引用符の外にあるカンマで分割（',' や "a,b" を壊さない）
function splitOperands(s) {
  if (!s.trim()) return [];
  const out = [];
  let cur = "", quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// =========================================================
// オペランドの解釈
// =========================================================
function parseOperand(s, labels) {
  s = (s || "").trim();
  if (!s) return 0;

  // LO(式) / HI(式): 16bit値の下位・上位バイト
  const fn = s.match(/^(LO|HI)\((.*)\)$/i);
  if (fn) {
    const v = parseOperand(fn[2], labels);
    return fn[1].toUpperCase() === "LO" ? v & 0xFF : (v >> 8) & 0xFF;
  }

  if (labels.has(s)) return labels.get(s) & 0xFFFF;

  let m;
  if ((m = s.match(/^(?:0x|\$)([0-9a-f]+)$/i))) return parseInt(m[1], 16) & 0xFFFF;
  if (/^-?\d+$/.test(s))                         return parseInt(s, 10) & 0xFFFF;
  if ((m = s.match(/^'(.)'$/)))                  return m[1].charCodeAt(0) & 0xFF;

  throw new Error("Invalid operand: " + s);
}

// =========================================================
// DB ディレクティブ
// =========================================================
function isStringLiteral(t) {
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"');
}

function dbItemSize(item) {
  return isStringLiteral(item) ? item.length - 2 : 1;
}

function emitDbItem(item, labels, out) {
  if (isStringLiteral(item)) {
    for (let i = 1; i < item.length - 1; i++) out.push(item.charCodeAt(i) & 0xFF);
  } else {
    out.push(parseOperand(item, labels) & 0xFF);
  }
}
