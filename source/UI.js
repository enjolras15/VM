// =========================================================
// DOM / ログ
// =========================================================
const tabsDom = document.querySelector(".tabs");
const addBtn  = document.querySelector(".add");
const editor  = document.getElementById("source");
const $log    = document.getElementById("log");

function log(msg) {
  $log.append(msg + "\n");
  $log.scrollTop = $log.scrollHeight;
}
function resetLog() { $log.textContent = ""; }

// =========================================================
// タブ管理
// =========================================================
const tabs = new Map();      // id -> { id, text, element }
let currentId = -1;
let nextId = 1;

function createTab(content = "", title = null) {
  const id = nextId++;
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = id;

  const titleEl = document.createElement("span");
  titleEl.className = "title";
  titleEl.textContent = title || "tab " + id;

  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";

  el.append(titleEl, closeBtn);
  tabs.set(id, { id, text: content, element: el });
  tabsDom.insertBefore(el, addBtn);

  switchTab(id);
  updateCloseButtons();
  return id;
}

function setTabTitle(id, title) {
  const tab = tabs.get(id);
  if (tab) tab.element.querySelector(".title").textContent = title;
}

function switchTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  currentId = id;
  editor.value = tab.text;
  for (const t of tabs.values()) {
    t.element.classList.toggle("active", t.id === id);
  }
}

function closeTab(id) {
  if (tabs.size <= 1) return;    // 最後の1枚は閉じさせない
  const tab = tabs.get(id);
  if (!tab) return;

  tab.element.remove();
  tabs.delete(id);
  if (currentId === id) switchTab(tabs.keys().next().value);
  updateCloseButtons();
}

function updateCloseButtons() {
  const onlyOne = tabs.size <= 1;
  document.querySelectorAll(".tab .close").forEach(b => {
    b.style.visibility = onlyOne ? "hidden" : "";
  });
}

// エディタの内容は常に現在タブへ同期
editor.addEventListener("input", () => {
  const tab = tabs.get(currentId);
  if (tab) tab.text = editor.value;
});

addBtn.addEventListener("click", () => createTab(""));

tabsDom.addEventListener("click", (e) => {
  const tabEl = e.target.closest(".tab");
  if (!tabEl) return;
  const id = Number(tabEl.dataset.id);

  if (e.target.classList.contains("close")) closeTab(id);
  else switchTab(id);
});

// =========================================================
// マシン本体
// =========================================================
const memory = new Uint8Array(MEM_SIZE);
const video  = new VideoChip(document.getElementById("screen"), memory);
const cpu    = new CPU(memory);
const nic    = new NIC(memory);

nic.setLogger(log);
cpu.mmioWriteHook = (addr, value) => nic.onWrite(addr, value);

// =========================================================
// 実行制御
// ---------------------------------------------------------
// Boot & Run   … 電源投入 → リセット → ロード → 実行（主操作）
// Load & Run   … カートリッジ差し替え（CPU 状態は保持、ホットスワップ）
// Stop / Resume… 一時停止 / 続きから再開
// Reset        … リセット回路（PC ← 0、メモリ保持。走行中なら再開）
// Power Cycle  … 電源再投入（メモリもクリア）
// Power ON/OFF … 電源スイッチ
// =========================================================
const CLOCK_HZ     = 1_000_000;
const FRAME_MS     = 1000 / 60;
const MAX_FRAME_MS = 100;        // タブ非表示などで間が空いても、これ以上は一度に進めない

let isRunning     = false;
let isPaused      = false;
let isPowerOn     = false;
let stopRequested = false;
let currentRunPromise = null;    // 走行ループ全体（終了処理込み）

const btnStop  = document.getElementById("btn-stop");
const btnPower = document.getElementById("btn-power");
const ledEl    = document.getElementById("power-led");
const ledLabel = document.getElementById("power-label");

function refreshButtons() {
  btnStop.disabled = !(isRunning || isPaused);
  btnStop.textContent = isPaused ? "▶ Resume" : "■ Stop";
  btnPower.textContent = isPowerOn ? "⏻ Power OFF" : "⏻ Power ON";
  ledEl.classList.toggle("is-off", !isPowerOn);
  ledLabel.textContent = isPowerOn ? "POWER ON" : "POWER OFF";
}

function setRunningState(running) {
  isRunning = running;
  refreshButtons();
}

// 走行中なら停止要求を出し、ループが終わるまで待つ
async function stopRunning() {
  if (!currentRunPromise) return;
  stopRequested = true;
  try { await currentRunPromise; } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------
// Boot & Run（主操作）
// ---------------------------------------------------------
async function bootAndRun() {
  await rebootMachine();   // 停止 + メモリクリア + CPU リセット
  await runProgram();
}

// ---------------------------------------------------------
// Stop / Resume
// ---------------------------------------------------------
function onStopResume() {
  if (isRunning) {
    stopRequested = true;
    log("⏹ Stop requested (PC preserved)");
  } else if (isPaused) {
    log("▶ Resuming from stopped state...");
    runLoop();
  }
}

// ---------------------------------------------------------
// Load & Run（カートリッジ差し替え / ホットスワップ）
// ---------------------------------------------------------
async function runProgram() {
  let binary;
  try {
    binary = assemble(editor.value);
    if (binary.length > MEM_SIZE) {
      throw new Error(
        `Program too large: ${binary.length} bytes > ${MEM_SIZE} (0x${hex(MEM_SIZE)}) available`
      );
    }
  } catch (e) {
    log("Assemble error: " + e.message);
    return;
  }

  isPowerOn = true;
  refreshButtons();

  const wasHalted = cpu.halted;
  memory.set(binary, 0);
  cpu.halted = false;   // 実機 6502 に HLT は無い（動き続けている扱い）

  log(`🔌 Load ${binary.length} bytes @ 0x0000`);
  log(`   PC=0x${hex(cpu.PC)}  A=${cpu.A}  X=${cpu.X}  Z=${cpu.Z}  (preserved)`);
  if (wasHalted) log("   halted → false (HLT is not a real 6502 instruction)");

  if (isRunning) {
    log("   ⚠ Hot-swap: CPU continues from current PC — boundaries may be misaligned");
    return;
  }
  if (cpu.PC !== 0) log(`   ⚠ CPU continues from PC=0x${hex(cpu.PC)} — not from 0x0000`);
  else              log("   PC=0x0000 — starting from entry point");

  await runLoop();
}

// ---------------------------------------------------------
// 走行ループ
// ---------------------------------------------------------
function runLoop() {
  isPaused = false;
  stopRequested = false;
  setRunningState(true);

  const task = executeLoop().finally(() => {
    currentRunPromise = null;
    setRunningState(false);
  });
  currentRunPromise = task;
  return task;
}

async function executeLoop() {
  const startWall = performance.now();
  let last         = startWall - FRAME_MS;   // 初回フレームから 1 フレーム分進める
  let totalSteps   = 0;
  let lastSec      = 0;
  let runtimeError = null;

  while (!cpu.halted && !stopRequested) {
    // 実時間に応じて実行数を決める（リフレッシュレートに依存しない）
    const now    = performance.now();
    const budget = Math.round(CLOCK_HZ * Math.min(now - last, MAX_FRAME_MS) / 1000);
    last = now;

    try {
      totalSteps += cpu.runSlice(budget);
    } catch (e) {
      runtimeError = e;
      break;
    }

    video.render();

    const sec = Math.floor((now - startWall) / 1000);
    if (sec > lastSec) {
      lastSec = sec;
      log(`  t=${sec}s   cycles=${totalSteps.toLocaleString()}   eff=${(totalSteps / sec / 1000).toFixed(1)} kHz`);
    }

    await new Promise(r => requestAnimationFrame(r));
  }

  video.render();

  const elapsedSec = (performance.now() - startWall) / 1000;
  const effKhz     = totalSteps / elapsedSec / 1000;

  if (runtimeError) log("Runtime error: " + runtimeError.message);
  log(`Executed ${totalSteps.toLocaleString()} cycles in ${elapsedSec.toFixed(2)}s`);
  log(`  Effective clock: ${effKhz.toFixed(1)} kHz`);
  log(`A=${cpu.A}  X=${cpu.X}  PC=0x${hex(cpu.PC)}  Z=${cpu.Z}  HLT=${cpu.halted}`);

  if (stopRequested && !cpu.halted) {
    isPaused = true;
    log("⏸ Paused — press Resume to continue");
  }
}

// =========================================================
// Reset / Power Cycle / Power
// =========================================================

// リセット回路: PC ← 0、メモリ保持。走行中だった場合は 0 から再開する
async function resetMachine() {
  if (!isPowerOn) return;
  const wasRunning = isRunning;
  await stopRunning();

  cpu.reset();
  nic.reset();
  isPaused = false;
  log("⟲ Reset (PC ← 0x0000, memory kept)");
  refreshButtons();

  if (wasRunning) await runLoop();
}

// 電源再投入: メモリクリア + CPU リセット（走行中なら先に停止）
async function rebootMachine() {
  await stopRunning();

  memory.fill(0);
  cpu.reset();
  nic.reset();
  video.render();
  resetLog();
  isPaused = false;
  isPowerOn = true;
  log("⏻ Power cycle (memory cleared, CPU reset)");
  refreshButtons();
}

async function togglePower() {
  if (isPowerOn) {
    await stopRunning();
    isPowerOn = false;
    isPaused = false;

    video.clear();
    memory.fill(0);
    cpu.reset();
    nic.reset();

    resetLog();
    log("⏻ Power off");
  } else {
    isPowerOn = true;
    resetLog();
    log("⏻ Power on");
    video.render();
  }
  refreshButtons();
}

// =========================================================
// デモプログラム
// =========================================================
const DEMOS = {
  hello: `loop:
    LDA_X msg
    CMP zero
    JZ  done
    STA_X 0x8000    ; VRAM[0x8000 + X] = A
    INX
    JMP loop
done:
    HLT

zero: DB 0

; 文字と属性を交互に並べたテーブル
msg:
    DB 'H', 15      ; 'H' を白で
    DB 'e', 12      ; 'e' を明るい赤で
    DB 'l', 10      ; 'l' を明るい緑で
    DB 'l', 14      ; 'l' を黄色で
    DB 'o', 11      ; 'o' を明るい水色で
    DB 0, 0         ; 終端
`,

  fill: `; 画面全体を 'X' で埋める
    LDI 4
    STA 0xC003

    LDX 0
loop:
    LDI 88          ; 'X'
    STA_X 0x8000
    INX
    LDI 15
    STA_X 0x8000
    INX
    CPX 4000        ; 80 * 25 * 2
    JNZ loop
    HLT
`,

  lines: `; 上端と下端を '*' で描く
    LDI 15
    STA 0xC002
    LDI 0
    STA 0xC003

    LDX 0           ; 最上行
top:
    LDI 42          ; '*'
    STA_X 0x8000
    INX
    LDI 15          ; 属性（白）
    STA_X 0x8000
    INX
    CPX 160         ; 80 桁 * 2 バイト
    JNZ top

    LDX 3840        ; 最下行 (24 * 80 * 2)
bot:
    LDI 42
    STA_X 0x8000
    INX
    LDI 15
    STA_X 0x8000
    INX
    CPX 4000
    JNZ bot

    HLT
`,

  counter: `; '0'〜'9' を横一列に表示
    LDI 14
    STA 0xC002
    LDI 0
    STA 0xC003

    LDX 0
loop:
    LDA_X msg
    STA_X 0x8000
    INX
    CPX 20          ; 10 文字 * 2 バイト
    JNZ loop
    HLT

; 文字と属性（14=黄）を交互に並べる
msg:
    DB '0', 14, '1', 14, '2', 14, '3', 14, '4', 14
    DB '5', 14, '6', 14, '7', 14, '8', 14, '9', 14
`,

  colors: `; 16色を順番に背景色として切り替える（無限ループ、Stopで停止）
; ※ fg/bg はハードウェア上 1画面につき1色ずつしか持てないため
;    「1行ずつ別の色」は不可能。代わりに全画面の色を巡回させる。
    LDX 0
cycle:
    LDA_X pal        ; A = pal[X]
    STA 0xC002       ; fg = 色
    STA 0xC003       ; bg = 色（画面全体を塗りつぶす）

    LDI 0
    STA outer
wait_o:
    LDI 0
wait_i:
    INC
    JNZ wait_i       ; A が 256 で 0 に戻るまで
    LDA outer
    INC
    STA outer
    CMP waitmax
    JNZ wait_o

    INX
    CPX 16
    JNZ cycle
    LDX 0
    JMP cycle

waitmax:  DB 60
outer:    DB 0
pal:      DB 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
`,
};

function loadDemo(name) {
  const src = DEMOS[name];
  if (!src) return;

  editor.value = src;
  tabs.get(currentId).text = src;

  // タブ名は 1 行目がコメントならそれ、なければデモ名
  const m = src.match(/^;\s*(.+)/);
  setTabTitle(currentId, (m ? m[1] : name).slice(0, 18));
}

// =========================================================
// 初期化
// =========================================================
createTab(DEMOS.hello, "hello");
refreshButtons();
video.render();
