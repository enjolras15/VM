// =========================================================
// アセンブラ（2パス）
// =========================================================
function assemble(source) {
  const rawLines = source
    .split("\n")
    .map(l => l.replace(/\r$/, "").replace(/;.*/, "").trim())
    .filter(l => l);

  // --- Pass 1: ラベル解決 ---
  const labels = {};
  const stmts  = [];
  let addr = 0;

  for (const line of rawLines) {
    let rest = line;
    const lm = rest.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (lm) {
      labels[lm[1]] = addr;
      rest = lm[2];
      if (!rest) continue;
    }

    let mnemonic, operandStr;
    const sp = rest.search(/\s/);
    if (sp < 0) {
      mnemonic   = rest.toUpperCase();
      operandStr = "";
    } else {
      mnemonic   = rest.slice(0, sp).toUpperCase();
      operandStr = rest.slice(sp + 1).trim();
    }

    stmts.push({ mnemonic, operandStr });
    addr += (mnemonic === "DB") ? dbLen(operandStr) : 3;
  }

  // --- Pass 2: バイト列生成 ---
  const bytes = [];
  for (const { mnemonic, operandStr } of stmts) {
    if (mnemonic === "DB") {
      for (const b of dbData(operandStr, labels)) bytes.push(b & 0xFF);
      continue;
    }
    const op = OP[mnemonic];
    if (op === undefined) throw new Error("Unknown mnemonic: " + mnemonic);
    const operand = parseOperand(operandStr, labels);
    bytes.push(op & 0xFF, operand & 0xFF, (operand >> 8) & 0xFF);
  }
  return new Uint8Array(bytes);
}

// =========================================================
// オペランドの解釈
// =========================================================
function parseOperand(s, labels) {
  s = (s || "").trim();
  if (!s) return 0;
  if (Object.prototype.hasOwnProperty.call(labels, s)) return labels[s] & 0xFFFF;
  if (s.startsWith("0x") || s.startsWith("0X")) return parseInt(s.slice(2), 16) & 0xFFFF;
  if (s.startsWith("$"))                        return parseInt(s.slice(1), 16) & 0xFFFF;
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 3) return s.charCodeAt(1) & 0xFF;
  if (/^-?\d+$/.test(s))                        return parseInt(s, 10) & 0xFFFF;
  throw new Error("Invalid operand: " + s);
}

// =========================================================
// DB ディレクティブ
// =========================================================
function dbLen(s) {
  const items = splitComma(s);
  let n = 0;
  for (const raw of items) {
    const t = raw.trim();
    if (t.startsWith('"') && t.endsWith('"')) n += t.length - 2;
    else                                      n += 1;
  }
  return n;
}

function dbData(s, labels) {
  const items = splitComma(s);
  const out = [];
  for (const raw of items) {
    const t = raw.trim();
    if (t.startsWith('"') && t.endsWith('"')) {
      for (let i = 1; i < t.length - 1; i++) out.push(t.charCodeAt(i));
    } else {
      out.push(parseOperand(t, labels) & 0xFF);
    }
  }
  return out;
}

function splitComma(s) {
  const out = [];
  let cur = "", inQ = false;
  for (const ch of s) {
    if (ch === '"') inQ = !inQ;
    if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}