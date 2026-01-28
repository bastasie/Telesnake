import {buildApp15Block, injectBeforeSOS, parseCartridge, BlockType} from './ppujpeg.js';
import {PPUVM, Sys} from './vm.js';

// --- Telegram Mini App integration (graceful fallback) ---
const TG = window.Telegram?.WebApp;
try { TG?.ready?.(); } catch {}
// Note: fullscreen is user-gesture gated; we request it when the user presses Start on the image.

// --- Canvas setup ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', {alpha:false, desynchronized:true});
const pillStatus = document.getElementById('pillStatus');
const pillGradient = document.getElementById('pillGradient');
const pillScore = document.getElementById('pillScore');
const toast = document.getElementById('toast');
const fileInput = document.getElementById('file');

let W=0,H=0, DPR=1;
function resize(){
  DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  W = Math.floor(window.innerWidth * DPR);
  H = Math.floor(window.innerHeight * DPR);
  canvas.width = W; canvas.height = H;
}
window.addEventListener('resize', resize, {passive:true});
resize();

// --- UI geometry in "cartridge pixels" (we render to 512x512 virtual, then scale) ---
const V = {w:512, h:512};
const ioGridX = 64, ioGridY = 64;

const UI = {
  board: {x: 40, y: 72, w: 360, h: 360},
  // Buttons live in the JPEG raster. These rectangles define their hit regions.
  btnUp:    {x: 90,  y: 420, w: 52,  h: 52},
  btnLeft:  {x: 38,  y: 472, w: 52,  h: 52},
  btnDown:  {x: 90,  y: 472, w: 52,  h: 52},
  btnRight: {x: 142, y: 472, w: 52,  h: 52},
  btnStart: {x: 360, y: 420, w: 132, h: 52},
  btnRestart:{x:360, y: 472, w: 132, h: 52},
  btnDownload:{x:360, y: 524, w: 132, h: 52},
  btnCapture:{x:360, y: 576, w: 132, h: 52},
  btnLoad:{x:360, y: 628, w: 132, h: 52},
};

const CMD = Object.freeze({
  UP: 1,
  DOWN: 2,
  LEFT: 3,
  RIGHT: 4,
  START_PAUSE: 5,
  RESTART: 6,
  DOWNLOAD: 7,
  CAPTURE: 8,
  LOAD: 9,
});

// --- Cartridge bytes (generated in-browser) ---
let cartridgeBytes = null;
let cartridgeBlobUrl = null;

// --- Truth table encoding ---
function packKey({modeBits=0,touchType=1,regionId=0,gestureId=0,timeBucket=0}){
  // 6 bytes packed: u8,u8,u16,u8,u8 (big-endian for regionId)
  const u8 = new Uint8Array(6);
  u8[0]=modeBits&255;
  u8[1]=touchType&255;
  u8[2]=(regionId>>>8)&255; u8[3]=regionId&255;
  u8[4]=gestureId&255;
  u8[5]=timeBucket&255;
  return u8;
}
function keyToStr(keyU8){
  return String.fromCharCode(...keyU8);
}

function rectToRegionIds(rect, vw=V.w, vh=V.h){
  const ids = [];
  const cellW = vw / ioGridX;
  const cellH = vh / ioGridY;
  const x0 = Math.floor(rect.x / cellW);
  const x1 = Math.floor((rect.x + rect.w - 1) / cellW);
  const y0 = Math.floor(rect.y / cellH);
  const y1 = Math.floor((rect.y + rect.h - 1) / cellH);
  for(let gy=y0; gy<=y1; gy++){
    for(let gx=x0; gx<=x1; gx++){
      if(gx<0||gy<0||gx>=ioGridX||gy>=ioGridY) continue;
      ids.push(gx + gy*ioGridX);
    }
  }
  return ids;
}

function buildTruthTable(vw, vh){
  const entries = [];
  function addRect(rect, cmd){
    for(const regionId of rectToRegionIds(rect, vw, vh)){
      const key = packKey({modeBits:0,touchType:1,regionId,gestureId:0,timeBucket:0});
      entries.push({key, cmd});
    }
  }
  addRect(UI.btnUp, CMD.UP);
  addRect(UI.btnDown, CMD.DOWN);
  addRect(UI.btnLeft, CMD.LEFT);
  addRect(UI.btnRight, CMD.RIGHT);
  addRect(UI.btnStart, CMD.START_PAUSE);
  addRect(UI.btnRestart, CMD.RESTART);
  addRect(UI.btnDownload, CMD.DOWNLOAD);
  addRect(UI.btnCapture, CMD.CAPTURE);
  addRect(UI.btnLoad, CMD.LOAD);

  const map = new Map();
  for(const e of entries){
    map.set(keyToStr(e.key), e.cmd);
  }

  const recordCount = map.size;
  const payload = new Uint8Array(4 + recordCount*(1+6+2));
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, recordCount>>>0, false);
  let off = 4;
  for(const [k, cmd] of map){
    payload[off++] = 6; // keyLen
    for(let i=0;i<6;i++) payload[off++] = k.charCodeAt(i) & 255;
    dv.setUint16(off, cmd & 0xFFFF, false); off += 2;
  }
  return {payload, recordCount};
}

function decodeTruthTable(payload){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const n = dv.getUint32(0, false);
  let off = 4;
  const out = new Map();
  for(let i=0;i<n;i++){
    const keyLen = payload[off++];
    const k = payload.subarray(off, off+keyLen); off += keyLen;
    const cmd = dv.getUint16(off, false); off += 2;
    out.set(keyToStr(k), cmd);
  }
  return out;
}

// --- Header encoding ---
function buildHeader({osId=0x534E414B /* 'SNAK' */, entryPoint=0, fbWidth=V.w, fbHeight=V.h, targetFPS=30, featureFlags=1}){
  // HEADER payload: see docs. We append osId u32 as a tiny extension.
  const payload = new Uint8Array(4+2+2+2+2+2 + 4+4 + 1+1+2 + 4);
  const dv = new DataView(payload.buffer);
  let off = 0;
  dv.setUint32(off, entryPoint>>>0, false); off += 4;
  dv.setUint16(off, fbWidth & 0xFFFF, false); off += 2;
  dv.setUint16(off, fbHeight & 0xFFFF, false); off += 2;
  dv.setUint16(off, targetFPS & 0xFFFF, false); off += 2;
  dv.setUint16(off, ioGridX & 0xFFFF, false); off += 2;
  dv.setUint16(off, ioGridY & 0xFFFF, false); off += 2;
  dv.setUint32(off, featureFlags>>>0, false); off += 4;
  dv.setUint32(off, 0, false); off += 4;
  payload[off++] = 0; // gradientPreferred (G0)
  payload[off++] = 0; // gradientMinExact (G0)
  dv.setUint16(off, 0, false); off += 2;
  dv.setUint32(off, osId>>>0, false); off += 4;
  return payload;
}

function parseHeader(payload){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off=0;
  const entryPoint = dv.getUint32(off,false); off+=4;
  const fbWidth = dv.getUint16(off,false); off+=2;
  const fbHeight = dv.getUint16(off,false); off+=2;
  const targetFPS = dv.getUint16(off,false); off+=2;
  const ioGX = dv.getUint16(off,false); off+=2;
  const ioGY = dv.getUint16(off,false); off+=2;
  const featureFlags = dv.getUint32(off,false); off+=4;
  off += 4; // reserved
  const gradPref = payload[off++];
  const gradMin = payload[off++];
  off += 2;
  const osId = (payload.byteLength >= off+4) ? dv.getUint32(off,false) : 0;
  return {entryPoint, fbWidth, fbHeight, targetFPS, ioGX, ioGY, featureFlags, gradPref, gradMin, osId};
}

// --- String table ---
function buildStringTable(obj){
  const enc = new TextEncoder();
  const entries = Object.entries(obj);
  let total = 2;
  const parts = [];
  for(const [k,v] of entries){
    const kb = enc.encode(k), vb = enc.encode(String(v));
    const seg = new Uint8Array(2+kb.length+2+vb.length);
    const dv = new DataView(seg.buffer);
    dv.setUint16(0, kb.length, false);
    seg.set(kb, 2);
    dv.setUint16(2+kb.length, vb.length, false);
    seg.set(vb, 2+kb.length+2);
    parts.push(seg);
    total += seg.length;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, entries.length, false);
  let off=2;
  for(const seg of parts){ out.set(seg, off); off += seg.length; }
  return out;
}

function decodeStringTable(payload){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const dec = new TextDecoder();
  const n = dv.getUint16(0,false);
  let off=2;
  const out = {};
  for(let i=0;i<n;i++){
    const kLen = dv.getUint16(off,false); off+=2;
    const key = dec.decode(payload.subarray(off, off+kLen)); off+=kLen;
    const vLen = dv.getUint16(off,false); off+=2;
    const val = dec.decode(payload.subarray(off, off+vLen)); off+=vLen;
    out[key]=val;
  }
  return out;
}

// --- Build base UI JPEG then inject blocks ---
async function buildCartridge(){
  pillStatus.textContent = 'building cartridge…';
  const base = document.createElement('canvas');
  base.width = V.w; base.height = V.h;
  const b = base.getContext('2d', {alpha:false});

  drawBaseUI(b, V.w, V.h);

  const jpegBlob = await new Promise((res)=> base.toBlob(res, 'image/jpeg', 0.92));
  const jpegBuf = await jpegBlob.arrayBuffer();
  const jpegU8 = new Uint8Array(jpegBuf);

  const headerPayload = buildHeader({osId:0x534E414B, entryPoint:0, fbWidth:V.w, fbHeight:V.h, targetFPS:30, featureFlags:1});
  const {payload: ttPayload} = buildTruthTable(V.w, V.h);

  // Minimal bytecode: SYSCALL INIT; SYSCALL TICK; HALT
  const bytecode = new Uint8Array([0x40, 0x01, 0x40, 0x02, 0x01]);

  const strPayload = buildStringTable({
    title: "PPU Snake",
    help: "D-Pad: move. Start: pause. Restart resets. Download saves cartridge. Capture grabs frame.",
  });

  const blocks = [
    buildApp15Block({blockType: BlockType.HEADER, payloadU8: headerPayload, flags:{crc:true,compressed:false}}),
    buildApp15Block({blockType: BlockType.TRUTH_TABLE, payloadU8: ttPayload, flags:{crc:true,compressed:false}}),
    buildApp15Block({blockType: BlockType.BYTECODE, payloadU8: bytecode, flags:{crc:true,compressed:false}}),
    buildApp15Block({blockType: BlockType.STRING_TABLE, payloadU8: strPayload, flags:{crc:true,compressed:false}}),
  ];

  const outU8 = injectBeforeSOS(jpegU8, blocks);
  cartridgeBytes = outU8;
  if(cartridgeBlobUrl) URL.revokeObjectURL(cartridgeBlobUrl);
  cartridgeBlobUrl = URL.createObjectURL(new Blob([outU8], {type:'image/jpeg'}));

  toastMsg('Cartridge built (APP15 blocks injected before SOS).');
  pillStatus.textContent = 'cartridge ready';
  return outU8;
}

// --- Drawing base UI ---
function roundedRect(g,x,y,w,h,r){
  g.beginPath();
  g.moveTo(x+r,y);
  g.arcTo(x+w,y,x+w,y+h,r);
  g.arcTo(x+w,y+h,x,y+h,r);
  g.arcTo(x,y+h,x,y,r);
  g.arcTo(x,y,x+w,y,r);
  g.closePath();
}

function drawButton(g, rect, label){
  roundedRect(g, rect.x, rect.y, rect.w, rect.h, 12);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.20)';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = 'bold 18px system-ui, sans-serif';
  g.textAlign='center'; g.textBaseline='middle';
  g.fillText(label, rect.x + rect.w/2, rect.y + rect.h/2);
}

function drawBaseUI(g, vw, vh){
  g.fillStyle = '#070912';
  g.fillRect(0,0,vw,vh);

  g.strokeStyle = 'rgba(255,255,255,0.04)';
  for(let i=0;i<=vw;i+=32){ g.beginPath(); g.moveTo(i,0); g.lineTo(i,vh); g.stroke(); }
  for(let j=0;j<=vh;j+=32){ g.beginPath(); g.moveTo(0,j); g.lineTo(vw,j); g.stroke(); }

  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(0,0,vw,56);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = 'bold 22px system-ui, sans-serif';
  g.textAlign='left'; g.textBaseline='middle';
  g.fillText('PPU Snake (JPEG Cartridge)', 16, 28);

  roundedRect(g, UI.board.x-8, UI.board.y-8, UI.board.w+16, UI.board.h+16, 18);
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fill(); g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth=2; g.stroke();

  drawButton(g, UI.btnUp, '▲');
  drawButton(g, UI.btnDown, '▼');
  drawButton(g, UI.btnLeft, '◀');
  drawButton(g, UI.btnRight, '▶');
  drawButton(g, UI.btnStart, 'Start/Pause');
  drawButton(g, UI.btnRestart, 'Restart');
  drawButton(g, UI.btnDownload, 'Download');
  drawButton(g, UI.btnCapture, 'Capture');
  drawButton(g, UI.btnLoad, 'Load');

  g.fillStyle = 'rgba(255,255,255,0.70)';
  g.font = '14px system-ui, sans-serif';
  g.textAlign='left'; g.textBaseline='top';
  g.fillText('Touch the buttons that are drawn INSIDE this JPEG.', 16, vh-22);
}

// --- Base bitmap ---
let baseBitmap = null;
async function setBaseFromCartridgeBytes(u8){
  const blob = new Blob([u8], {type:'image/jpeg'});
  baseBitmap = await createImageBitmap(blob);
}

// --- Input mapping: screen -> virtual -> regionId -> truth table ---
function screenToVirtual(px, py){
  const s = Math.min(W/V.w, H/V.h);
  const drawW = V.w * s;
  const drawH = V.h * s;
  const ox = (W - drawW)/2;
  const oy = (H - drawH)/2;
  const x = (px*DPR - ox) / s;
  const y = (py*DPR - oy) / s;
  return {x, y, inside: x>=0 && y>=0 && x<V.w && y<V.h};
}

function quantizeRegionId(vx, vy){
  const gx = Math.max(0, Math.min(ioGridX-1, Math.floor(vx * ioGridX / V.w)));
  const gy = Math.max(0, Math.min(ioGridY-1, Math.floor(vy * ioGridY / V.h)));
  return (gx + gy*ioGridX) & 0xFFFF;
}

function lookupCmdFromPoint(px, py){
  const v = screenToVirtual(px, py);
  if(!v.inside) return 0;
  const regionId = quantizeRegionId(v.x, v.y);
  const key = packKey({modeBits:0,touchType:1,regionId,gestureId:0,timeBucket:0});
  return truth.get(keyToStr(key)) ?? 0;
}

// --- Runtime state ---
let vm = null;
let truth = new Map();
let strings = {};
let gradientUsed = 3; // default G3 until verified
let frameTick = 0;
let lastCmd = 0;

function toastMsg(s){
  toast.textContent = s;
  toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'), 1300);
}

// --- Boot: build cartridge locally, then load+verify+run ---
async function boot(){
  try { if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js'); } catch {}

  const bytes = await buildCartridge();
  await loadCartridge(bytes);
  startLoop();
}

async function loadCartridge(bytes){
  pillStatus.textContent = 'loading cartridge…';

  let blocks;
  try{
    blocks = parseCartridge(bytes);
  } catch (e){
    console.error(e);
    gradientUsed = 3;
    pillGradient.textContent = 'G3';
    toastMsg('Verification failed: view-only.');
    await setBaseFromCartridgeBytes(bytes);
    pillStatus.textContent = 'view-only (G3)';
    return;
  }

  let headerP=null, bytecodeP=null, truthP=null, strP=null;
  for(const b of blocks){
    if(b.blockType === BlockType.HEADER) headerP = b.payload;
    else if(b.blockType === BlockType.BYTECODE) bytecodeP = b.payload;
    else if(b.blockType === BlockType.TRUTH_TABLE) truthP = b.payload;
    else if(b.blockType === BlockType.STRING_TABLE) strP = b.payload;
  }

  if(!headerP || !bytecodeP){
    gradientUsed = 3;
    pillGradient.textContent = 'G3';
    toastMsg('Missing required blocks: view-only.');
    await setBaseFromCartridgeBytes(bytes);
    pillStatus.textContent = 'view-only (G3)';
    return;
  }

  gradientUsed = 0;
  pillGradient.textContent = 'G0';

  const header = parseHeader(headerP);
  truth = truthP ? decodeTruthTable(truthP) : new Map();
  strings = strP ? decodeStringTable(strP) : {};

  await setBaseFromCartridgeBytes(bytes);

  vm = new PPUVM({
    header: {entryPoint: 0, osId: header.osId ?? 0},
    bytecode: bytecodeP,
    truthTable: truth,
    strings,
    onDraw: (st)=>{
      pillScore.textContent = `score: ${st.score}  best: ${st.high}` + (st.gameOver ? '  (GAME OVER)' : (st.paused ? '  (PAUSED)' : ''));
    }
  });

  // init once
  vm.pc = 0;
  vm.setIO({cmd:0, tick:0, modeBits:0});
  vm.runFrame(10_000);
  // tick entry for subsequent frames (after SYSCALL INIT)
  vm.pc = 2;

  pillStatus.textContent = 'running';
  toastMsg(strings.title ? `${strings.title} loaded.` : 'Cartridge loaded.');
}

// --- Host-level commands ---
async function handleHostCommand(cmd){
  if(cmd === CMD.DOWNLOAD){
    if(!cartridgeBytes){ toastMsg('No cartridge in memory.'); return; }
    const blob = new Blob([cartridgeBytes], {type:'image/jpeg'});
    downloadBlob(blob, 'ppu-snake-cartridge.jpg');
    toastMsg('Downloaded cartridge.');
  }
  if(cmd === CMD.CAPTURE){
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    downloadBlob(blob, `ppu-snake-capture-${Date.now()}.png`);
    toastMsg('Captured frame.');
  }
  if(cmd === CMD.LOAD){
    fileInput.value = '';
    fileInput.click();
  }
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

// --- Event loop ---
let rafId = null;
let lastStepTime = 0;
const STEP_MS = 120;

function startLoop(){
  if(rafId) cancelAnimationFrame(rafId);
  lastStepTime = performance.now();
  const loop = (t)=>{
    rafId = requestAnimationFrame(loop);
    if(t - lastStepTime >= STEP_MS){
      lastStepTime += STEP_MS;
      frameTick = (frameTick + 1)>>>0;
      step(frameTick);
    }
    render();
  };
  rafId = requestAnimationFrame(loop);
}

function step(tick){
  if(!vm) return;
  vm.setIO({cmd:lastCmd, tick, modeBits:0});
  vm.runFrame(10_000);
  lastCmd = 0;
}

function render(){
  ctx.fillStyle = '#070912';
  ctx.fillRect(0,0,W,H);

  const s = Math.min(W/V.w, H/V.h);
  const drawW = V.w * s;
  const drawH = V.h * s;
  const ox = (W - drawW)/2;
  const oy = (H - drawH)/2;

  if(baseBitmap){
    ctx.drawImage(baseBitmap, ox, oy, drawW, drawH);
  }

  if(vm){
    drawSnakeOverlay(ctx, ox, oy, s, drawW, vm.render);
  }
}

function drawSnakeOverlay(g, ox, oy, s, drawW, st){
  const cell = st.cellPx * s;
  const x0 = (st.boardX) * s + ox;
  const y0 = (st.boardY) * s + oy;

  g.fillStyle = 'rgba(0,0,0,0.20)';
  g.fillRect(x0, y0, st.boardW*cell, st.boardH*cell);

  g.fillStyle = 'rgba(255,80,110,0.95)';
  g.fillRect(x0 + st.apple.x*cell, y0 + st.apple.y*cell, cell, cell);

  g.fillStyle = 'rgba(120,240,180,0.95)';
  for(const p of st.snake){
    g.fillRect(x0 + p.x*cell, y0 + p.y*cell, cell, cell);
  }

  if(st.paused){
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = `${Math.floor(26*s)}px system-ui, sans-serif`;
    g.textAlign='center'; g.textBaseline='middle';
    g.fillText('PAUSED', ox + drawW/2, oy + (56*s));
  }
  if(st.gameOver){
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = `bold ${Math.floor(28*s)}px system-ui, sans-serif`;
    g.textAlign='center'; g.textBaseline='middle';
    g.fillText('GAME OVER', ox + drawW/2, oy + (56*s));
  }
}

// --- Input ---
canvas.addEventListener('pointerdown', async (e)=>{
  canvas.setPointerCapture(e.pointerId);
  const cmd = lookupCmdFromPoint(e.clientX, e.clientY);
  if(cmd){
    if(cmd === CMD.START_PAUSE){
      try{ TG?.requestFullscreen?.(); } catch {}
    }
    if(cmd === CMD.DOWNLOAD || cmd === CMD.CAPTURE || cmd === CMD.LOAD){
      await handleHostCommand(cmd);
      if(cmd === CMD.DOWNLOAD || cmd === CMD.CAPTURE || cmd === CMD.LOAD) return;
    }
    lastCmd = cmd;
  }
}, {passive:true});

window.addEventListener('keydown', (e)=>{
  const m = {
    ArrowUp: CMD.UP, ArrowDown: CMD.DOWN, ArrowLeft: CMD.LEFT, ArrowRight: CMD.RIGHT,
    ' ': CMD.START_PAUSE, Enter: CMD.START_PAUSE,
    r: CMD.RESTART, R: CMD.RESTART,
  };
  const cmd = m[e.key];
  if(cmd){ e.preventDefault(); lastCmd = cmd; }
}, {passive:false});

fileInput.addEventListener('change', async ()=>{
  const f = fileInput.files?.[0];
  if(!f) return;
  const buf = await f.arrayBuffer();
  cartridgeBytes = new Uint8Array(buf);
  await loadCartridge(cartridgeBytes);
});

// Start
boot().catch(err=>{
  console.error(err);
  pillStatus.textContent = 'error';
  toastMsg(String(err?.message || err));
});
