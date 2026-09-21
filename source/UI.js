// =========================================================
// タブ管理
// =========================================================
const tabs = new Map();      // id -> { id, text, element }
let currentId = -1;
let nextId = 1;

const tabsDom = document.querySelector(".tabs");
const addBtn  = document.querySelector(".add");
const editor  = document.getElementById("source");
const $log    = document.getElementById("log");

function log(msg)   { $log.textContent += msg + "\n"; $log.scrollTop = $log.scrollHeight; }
function resetLog() { $log.textContent = ""; }

function createTab(content = "", title = null) {
  const id = nextId++;
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = id;

  const titleEl = document.createElement("span");
  titleEl.className = "title";
  titleEl.textContent = title || ("tab " + id);
  el.appendChild(titleEl);

  const closeBtn = document.createElement("button");
  closeBtn.className = "close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  el.appendChild(closeBtn);

  tabs.set(id, { id, text: content, element: el });
  tabsDom.insertBefore(el, addBtn);

  switchTab(id);
  updateCloseButtons();
  return id;
}

function switchTab(id) {
  if (!tabs.has(id)) return;

  // 現在タブの内容を保存
  if (tabs.has(currentId)) {
    tabs.get(currentId).text = editor.value;
  }

  currentId = id;
  editor.value = tabs.get(id).text;

  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  tabs.get(id).element.classList.add("active");
}

function closeTab(id) {
  if (tabs.size <= 1) return;    // 最後の1枚は閉じさせない
  const t = tabs.get(id);
  if (!t) return;

  t.element.remove();
  tabs.delete(id);

  if (currentId === id) {
    // 削除済みタブに保存しないよう、直接切替
    const newId = tabs.keys().next().value;
    currentId = newId;
    editor.value = tabs.get(newId).text;
    document.querySelectorAll(".tab").forEach(el => el.classList.remove("active"));
    tabs.get(newId).element.classList.add("active");
  }
  updateCloseButtons();
}

function updateCloseButtons() {
  const onlyOne = tabs.size <= 1;
  document.querySelectorAll(".tab .close").forEach(b => {
    b.style.visibility = onlyOne ? "hidden" : "";
  });
}

// --- タブバーのイベント ---
addBtn.addEventListener("click", () => createTab(""));

tabsDom.addEventListener("click", (e) => {
  const tabEl = e.target.closest(".tab");
  if (!tabEl) return;
  const id = Number(tabEl.dataset.id);

  if (e.target.classList.contains("close")) {
    closeTab(id);
    return;
  }
  switchTab(id);
});

// =========================================================
// マシン本体
// =========================================================
const memory = new Uint8Array(MEM_SIZE);
const video  = new VideoChip(document.getElementById("screen"), memory);
const cpu    = new CPU(memory);

// =========================================================
// 実行制御
// ---------------------------------------------------------
// Boot & Run   … 電源投入 → リセット → ロード → 実行（主操作）
// Load & Run   … カートリッジ差し替え（CPU 状態は保持、ホットスワップ）
// Stop / Resume… 一時停止 / 続きから再開
// Reset        … リセット回路（PC ← 0、メモリ保持）
// Power Cycle  … 電源再投入（メモリもクリア）
// =========================================================
const CLOCK_HZ         = 1_000_000;
const FRAME_MS         = 1000 / 60;
const CYCLES_PER_FRAME = Math.round(CLOCK_HZ * FRAME_MS / 1000);

let isRunning     = false;
let isPaused      = false;
let stopRequested = false;
let currentRunPromise = null;   // 走行ループの Promise（Boot 時に待つ）

const btnBoot = document.getElementById("btn-boot");
const btnRun  = document.getElementById("btn-run");
const btnStop = document.getElementById("btn-stop");

function refreshButtons() {
  btnBoot.disabled = isRunning;      // 走行中は Boot 不可
  btnRun.disabled  = false;          // Load&Run は走行中でも可（= hot-swap）
  btnStop.disabled = !(isRunning || isPaused);
  btnStop.textContent = isPaused ? "▶ Resume" : "■ Stop";
}

function setRunningState(running) {
  isRunning = running;
  refreshButtons();
}

// ---------------------------------------------------------
// Boot & Run（主操作）
// ---------------------------------------------------------
// 走行中なら一旦停止 → 電源再投入 → ロード → 実行。
async function bootAndRun() {
  if (isRunning) {
    stopRequested = true;
    try { await currentRunPromise; } catch (_) { /* ignore */ }
  }
  rebootMachine();       // メモリクリア + CPU リセット（PC ← 0）
  await runProgram();    // カートリッジをロードして走行開始
}

// ---------------------------------------------------------
// Stop / Resume（統合ハンドラ）
// ---------------------------------------------------------
function onStopResume() {
  if (isRunning) {
    stopRequested = true;
    log("⏹ Stop requested (PC preserved)");
  } else if (isPaused) {
    isPaused = false;
    refreshButtons();
    resumeExecution();
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
        `Program too large: ${binary.length} bytes > ${MEM_SIZE} (0x${MEM_SIZE.toString(16)}) available`
      );
    }
  } catch (e) {
    log("Assemble error: " + e.message);
    return;
  }

  const savedPC    = cpu.PC;
  const savedA     = cpu.A;
  const savedX     = cpu.X;
  const savedZ     = cpu.Z;
  const wasHalted  = cpu.halted;
  const wasRunning = isRunning;

  memory.set(binary, 0);
  cpu.halted = false;   // 実機 6502 に HLT は無い（動き続けている扱い）

  log(`🔌 Load ${binary.length} bytes @ 0x0000`);
  log(`   PC=0x${savedPC.toString(16).padStart(4, "0")}  A=${savedA}  X=${savedX}  Z=${savedZ}  (preserved)`);
  if (wasHalted) log(`   halted → false (HLT is not a real 6502 instruction)`);

  if (wasRunning) {
    log(`   ⚠ Hot-swap: CPU continues from current PC — boundaries may be misaligned`);
    return;
  }

  if (savedPC !== 0) {
    log(`   ⚠ CPU continues from PC=0x${savedPC.toString(16).padStart(4, "0")} — not from 0x0000`);
  } else {
    log(`   PC=0x0000 — starting from entry point`);
  }

  await runLoop();
}

async function resumeExecution() {
  log("▶ Resuming from stopped state...");
  await runLoop();
}

// ---------------------------------------------------------
// 走行ループ本体（runProgram / resumeExecution / bootAndRun から共通利用）
// ---------------------------------------------------------
async function runLoop() {
  isPaused = false;
  setRunningState(true);
  stopRequested = false;

  const promise = (async () => {
    const startWall  = performance.now();
    let   totalSteps = 0;
    let   runtimeError = null;
    let   lastSec    = 0;

    while (!cpu.halted && !stopRequested) {
      try {
        const executed = cpu.runSlice(CYCLES_PER_FRAME);
        totalSteps += executed;
        if (executed === 0) break;
      } catch (e) {
        runtimeError = e;
        break;
      }

      video.render();

      const sec = Math.floor((performance.now() - startWall) / 1000);
      if (sec > lastSec) {
        lastSec = sec;
        const eff = totalSteps / sec / 1000;
        log(`  t=${sec}s   cycles=${totalSteps.toLocaleString()}   eff=${eff.toFixed(1)} kHz`);
      }

      await new Promise(r => requestAnimationFrame(r));
    }

    video.render();

    const elapsedSec = (performance.now() - startWall) / 1000;
    const effKhz     = elapsedSec > 0 ? totalSteps / elapsedSec / 1000 : 0;

    if (runtimeError) log("Runtime error: " + runtimeError.message);
    log(`Executed ${totalSteps.toLocaleString()} cycles in ${elapsedSec.toFixed(2)}s`);
    log(`  Effective clock: ${effKhz.toFixed(1)} kHz`);
    log(`A=${cpu.A}  X=${cpu.X}  PC=0x${cpu.PC.toString(16)}  Z=${cpu.Z}  HLT=${cpu.halted}`);

    if (stopRequested && !cpu.halted) {
      isPaused = true;
      log("⏸ Paused — press Resume to continue");
    }
  })();

  currentRunPromise = promise;
  try {
    await promise;
  } finally {
    if (currentRunPromise === promise) currentRunPromise = null;
    setRunningState(false);
  }
}

// ---------------------------------------------------------
// Reset（リセット回路）
// ---------------------------------------------------------
function resetMachine() {
  isPaused = false;
  cpu.reset();
  video.render();
  resetLog();
  log(`⟲ Reset (PC ← 0x0000, memory preserved)`);
  refreshButtons();
}

// ---------------------------------------------------------
// Power Cycle（電源再投入）
// ---------------------------------------------------------
function rebootMachine() {
  memory.fill(0);
  cpu.reset();
  video.render();
  resetLog();
  isPaused = false;
  log("⏻ Power cycle (memory cleared, CPU reset)");
  refreshButtons();
}

// =========================================================
// デモプログラム
// =========================================================
const DEMOS = {
  hello: `; Hello, World!
; VRAM(0x8000) に1文字ずつ書き込む
    LDI 15
    STA 0xC002      ; fg = white
    LDI 1
    STA 0xC003      ; bg = blue

    LDX 0
loop:
    LDA_X msg
    CMP zero
    JZ  done
    STA_X 0x8000    ; VRAM[X] = A
    INX
    JMP loop
done:
    HLT

zero:   DB 0
msg:    DB "Hello, World!", 0
`,

  fill: `; 画面全体を 'X' で埋める
    LDI 15
    STA 0xC002
    LDI 4
    STA 0xC003

    LDI 88          ; 'X'
    LDX 0
loop:
    STA_X 0x8000
    INX
    CPX 2000        ; 80 * 25
    JNZ loop
    HLT
`,

  lines: `; 上端と下端を '*' で描く
    LDI 15
    STA 0xC002
    LDI 0
    STA 0xC003

    LDI 42          ; '*'

    LDX 0
top:
    STA_X 0x8000
    INX
    CPX 80
    JNZ top

    LDX 1920
bot:
    STA_X 0x8000
    INX
    CPX 2000
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
    CPX 10
    JNZ loop
    HLT

msg:    DB "0123456789"
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
    CMP zero
    JZ  wait_i_done
    JMP wait_i
wait_i_done:
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

zero:     DB 0
waitmax:  DB 60
outer:    DB 0
pal:      DB 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
`,
};

function loadDemo(name) {
  const src = DEMOS[name];
  if (!src) return;
  editor.value = src;
  if (tabs.has(currentId)) tabs.get(currentId).text = src;
  // タブ名を先頭コメントから拾う（あれば）
  const m = src.match(/;\s*(.+)/);
  if (m && tabs.has(currentId)) {
    const titleEl = tabs.get(currentId).element.querySelector(".title");
    titleEl.textContent = m[1].slice(0, 18);
  }
}

// =========================================================
// 初期化
// =========================================================
createTab(DEMOS.hello);
video.render();