// vm.js - deterministic VM + syscall set for Snake
// Goal: keep the execution model aligned with "PPU-in-JPEG": bounded cycles, fail-closed on bad blocks.
// This VM is deliberately tiny: bytecode is just enough to dispatch syscalls & halt.

export const Opcode = Object.freeze({
  HALT: 0x01,
  SYSCALL: 0x40,   // 0x40, id(u8)
});

export const Sys = Object.freeze({
  SNAKE_INIT: 0x01,
  SNAKE_TICK: 0x02,
});

function clampU32(x){ return (x>>>0); }

export class PPUVM {
  constructor({header, bytecode, truthTable, strings, onDraw}){
    this.header = header;
    this.code = bytecode;
    this.truthTable = truthTable; // Map key->cmd
    this.strings = strings || {};
    this.onDraw = onDraw; // (renderState)=>void

    this.ram = new Uint8Array(64*1024);
    this.pc = header.entryPoint >>> 0;
    this.cycleBudget = 50_000;
    this.halted = false;

    // IO regs (host writes)
    this.ioCmd = 0;   // u16
    this.ioTick = 0;  // u32
    this.modeBits = 0;

    // Deterministic PRNG state
    this.prng = 0xC0FFEE01;

    // Render state (host consumes)
    this.render = {
      gameOver: false,
      score: 0,
      high: 0,
      boardW: 20,
      boardH: 20,
      cellPx: 18,
      boardX: 40,
      boardY: 72,
      apple: {x: 10, y: 10},
      snake: [{x:10,y:12},{x:10,y:13},{x:10,y:14}],
      dir: 0, // 0 up,1 right,2 down,3 left
      pendingDir: 0,
      lastTick: 0xFFFFFFFF>>>0,
      paused: false,
    };
  }

  reset(){
    this.ram.fill(0);
    this.pc = this.header.entryPoint >>> 0;
    this.halted = false;
    this.prng = 0xC0FFEE01;
  }

  setIO({cmd, tick, modeBits=0}){
    this.ioCmd = cmd & 0xFFFF;
    this.ioTick = clampU32(tick);
    this.modeBits = modeBits & 0xFF;
  }

  runFrame(cycleBudget){
    const budget = (cycleBudget ?? this.cycleBudget) >>> 0;
    let cycles = 0;
    this.halted = false;

    while(!this.halted && cycles < budget){
      const op = this.code[this.pc++];
      cycles++;

      if(op === Opcode.HALT){
        this.halted = true;
        break;
      }

      if(op === Opcode.SYSCALL){
        const id = this.code[this.pc++];
        cycles++;
        this.syscall(id);
        continue;
      }

      // Unknown opcode => fail-closed: halt
      this.halted = true;
      break;
    }

    // Safety: if cycles exhausted, stop (cooperative scheduling)
    this.halted = true;
    return cycles;
  }

  // --- deterministic utilities ---
  randU32(){
    // xorshift32
    let x = this.prng >>> 0;
    x ^= (x << 13) >>> 0;
    x ^= (x >>> 17) >>> 0;
    x ^= (x << 5) >>> 0;
    this.prng = x >>> 0;
    return this.prng;
  }

  // --- syscalls ---
  syscall(id){
    switch(id){
      case Sys.SNAKE_INIT: return this.snakeInit();
      case Sys.SNAKE_TICK: return this.snakeTick();
      default:
        // Unknown syscall => fail-closed
        this.halted = true;
        return;
    }
  }

  snakeInit(){
    this.render.boardW = 20;
    this.render.boardH = 20;
    this.render.dir = 0;
    this.render.pendingDir = 0;
    this.render.paused = true;
    this.render.gameOver = false;
    this.render.score = 0;
    this.render.snake = [{x:10,y:12},{x:10,y:13},{x:10,y:14}];
    this.prng = 0xA5A5A5A5 ^ (this.header.osId>>>0);

    this.spawnApple();
    this.onDraw?.(this.render);
  }

  spawnApple(){
    const W = this.render.boardW, H = this.render.boardH;
    const occ = new Set(this.render.snake.map(p=>p.x + p.y*W));
    for(let tries=0; tries<2048; tries++){
      const r = this.randU32();
      const x = r % W;
      const y = ((r>>>16) % H);
      const k = x + y*W;
      if(!occ.has(k)){
        this.render.apple = {x,y};
        return;
      }
    }
    for(let y=0;y<H;y++){
      for(let x=0;x<W;x++){
        const k = x+y*W;
        if(!occ.has(k)){
          this.render.apple = {x,y};
          return;
        }
      }
    }
  }

  snakeTick(){
    const t = this.ioTick>>>0;
    if(t === (this.render.lastTick>>>0)){
      return; // no-op
    }
    this.render.lastTick = t;

    const cmd = this.ioCmd & 0xFFFF;

    if(cmd === 5){ // start/pause toggle
      if(!this.render.gameOver){
        this.render.paused = !this.render.paused;
      }
    } else if(cmd === 6){ // restart
      this.snakeInit();
      this.render.paused = false;
      return;
    } else if(cmd >= 1 && cmd <= 4){
      const want = ({1:0,4:1,2:2,3:3})[cmd] ?? this.render.pendingDir;
      const cur = this.render.dir;
      if(((want + 2) & 3) !== cur){
        this.render.pendingDir = want;
      }
    }

    if(this.render.paused || this.render.gameOver){
      this.onDraw?.(this.render);
      return;
    }

    const W = this.render.boardW, H = this.render.boardH;
    const head = this.render.snake[0];
    const dir = this.render.pendingDir;
    this.render.dir = dir;

    const dx = [0,1,0,-1][dir];
    const dy = [-1,0,1,0][dir];
    const nx = head.x + dx;
    const ny = head.y + dy;

    if(nx < 0 || ny < 0 || nx >= W || ny >= H){
      this.render.gameOver = true;
      this.onDraw?.(this.render);
      return;
    }

    const apple = this.render.apple;
    const willGrow = (nx === apple.x && ny === apple.y);

    const bodySet = new Set(this.render.snake.map(p=>p.x + p.y*W));
    if(!willGrow){
      const tail = this.render.snake[this.render.snake.length-1];
      bodySet.delete(tail.x + tail.y*W);
    }
    if(bodySet.has(nx + ny*W)){
      this.render.gameOver = true;
      this.onDraw?.(this.render);
      return;
    }

    this.render.snake.unshift({x:nx,y:ny});

    if(willGrow){
      this.render.score++;
      if(this.render.score > this.render.high) this.render.high = this.render.score;
      this.spawnApple();
    } else {
      this.render.snake.pop();
    }

    this.onDraw?.(this.render);
  }
}
