// Pikafish WASM Engine Wrapper
// v165: 跳过 NNUE 加载，测试引擎裸跑能否走棋

class PikafishEngine {
  constructor() {
    this.ready = false;
    this.worker = null;
    this._pendingResolve = null;
    this._pendingReject = null;
    this._pendingTimeout = null;
  }

  async init() {
    if (this.ready) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      // 等待 WASM + NNUE 二进制加载完成
      var maxWait = 180000;
      var start = Date.now();
      while (!window._pikaWasmBinary || window._pikaWasmBinary.byteLength === 0 ||
             !window._pikaNnueBinary || window._pikaNnueBinary.byteLength === 0) {
        if (Date.now() - start > maxWait) {
          throw new Error('WASM/NNUE binary not available after ' + (maxWait/1000) + 's');
        }
        await new Promise(function(r) { setTimeout(r, 500); });
      }
      var wasmBinary = window._pikaWasmBinary;
      var nnueBinary = window._pikaNnueBinary;
      console.log('[PikafishEngine] WASM ready, size:', wasmBinary.byteLength, 'NNUE ready, size:', nnueBinary.byteLength);

      // 获取 worker.js 和 pikafish.js，合并为一个 Blob
      var ts = Date.now();
      console.log('[PikafishEngine] Fetching worker.js and pikafish.js...');
      var [workerResp, pikaResp] = await Promise.all([
        fetch('/js/pikafish-worker.js?v=' + ts, { cache: 'no-store' }),
        fetch('/js/pikafish.js?v=' + ts, { cache: 'no-store' })
      ]);
      if (!workerResp.ok) throw new Error('Failed to fetch pikafish-worker.js: ' + workerResp.status);
      if (!pikaResp.ok) throw new Error('Failed to fetch pikafish.js: ' + pikaResp.status);
      var workerCode = await workerResp.text();
      var pikaCode = await pikaResp.text();
      console.log('[PikafishEngine] worker.js size:', workerCode.length, 'pikafish.js size:', pikaCode.length);

      // v159: 移除 FS.staticInit() — 避免 Worker 初始化时阻塞
      // 移除 createWasm().then(run) — 等收到 init 消息后手动触发
      pikaCode = pikaCode.replace('FS.staticInit()', '/*FS.staticInit removed by v159*/0');
      pikaCode = pikaCode.replace('createWasm().then(()=>run())', '/*createWasm deferred by v159*/0');

      // 合并：worker.js 在前，pikafish.js 在后
      // pikafish.js 在 Worker 全局作用域执行，所有 var 声明自然挂到全局
      var mergedCode = workerCode + '\n;/* === pikafish.js below === */;\n' + pikaCode;
      console.log('[PikafishEngine] Merged code size:', mergedCode.length);

      var workerBlob = new Blob([mergedCode], { type: 'application/javascript' });
      var workerBlobUrl = URL.createObjectURL(workerBlob);

      var transferBinary = wasmBinary.slice(0);
      var nnueTransfer = nnueBinary.slice(0);

      return new Promise((resolve, reject) => {
        try {
          this.worker = new Worker(workerBlobUrl);
          console.log('[PikafishEngine] Worker created via Blob URL (v165)');
          URL.revokeObjectURL(workerBlobUrl);
        } catch (e) {
          reject(new Error('Failed to create Pikafish worker: ' + e.message));
          return;
        }

        this.worker.onmessage = (e) => {
          var data = e.data;
          if (data.type === 'log') {
            console.log('[PikafishWorker]', data.message);
            if (typeof window !== 'undefined') {
              window.__pikaLogs = window.__pikaLogs || [];
              window.__pikaLogs.push(data.message);
            }
          } else if (data.type === 'ready') {
            this.ready = true;
            console.log('[PikafishEngine] Worker engine ready');
            resolve();
          } else if (data.type === 'error') {
            if (!this.ready) {
              this.stop();
              reject(new Error(data.message));
              return;
            }
            if (this._pendingTimeout) clearTimeout(this._pendingTimeout);
            if (this._pendingReject) {
              this._pendingReject(new Error(data.message));
              this._pendingResolve = null;
              this._pendingReject = null;
            }
          } else if (data.type === 'bestmove') {
            if (this._pendingTimeout) clearTimeout(this._pendingTimeout);
            if (this._pendingResolve) {
              this._pendingResolve(data.move || null);
              this._pendingResolve = null;
              this._pendingReject = null;
            }
          }
        };

        this.worker.onerror = (e) => {
          console.error('[PikafishEngine] Worker onerror fired:', e.message || 'no message');
          this.stop();
          reject(new Error('Pikafish worker error: ' + (e.message || 'unknown')));
        };

        // 发送 WASM + NNUE 二进制（不再发送 pikaCode，因为已在 Blob 中执行）
        console.log('[PikafishEngine] Sending WASM + NNUE to Worker...');
        this.worker.postMessage({
          type: 'init',
          origin: window.location.origin,
          wasmBinary: transferBinary,
          nnueBinary: nnueTransfer
        }, [transferBinary, nnueTransfer]);
        console.log('[PikafishEngine] postMessage sent, waiting for Worker response...');
      });
    })();

    return this._initPromise;
  }

  boardToFen(board, currentTurn) {
    var pieceMap = {
      'king': 'k', 'advisor': 'a', 'elephant': 'b',
      'horse': 'n', 'rook': 'r', 'cannon': 'c', 'pawn': 'p'
    };

    var fen = '';
    for (var row = 0; row < 10; row++) {
      var emptyCount = 0;
      for (var col = 0; col < 9; col++) {
        var piece = board[row][col];
        if (piece) {
          if (emptyCount > 0) {
            fen += emptyCount;
            emptyCount = 0;
          }
          var ch = pieceMap[piece.type] || 'p';
          if (piece.color === 'red') ch = ch.toUpperCase();
          fen += ch;
        } else {
          emptyCount++;
        }
      }
      if (emptyCount > 0) fen += emptyCount;
      if (row < 9) fen += '/';
    }

    fen += ' ' + (currentTurn === 'red' ? 'w' : 'b');
    fen += ' - - 0 1';
    return fen;
  }

  async findBestMove(board, currentTurn, depth, moveTime) {
    depth = depth || 10;
    moveTime = moveTime || 5000;

    if (!this.ready) {
      await this.init();
    }

    var fen = this.boardToFen(board, currentTurn);
    console.log('[PikafishEngine] FEN:', fen, 'depth:', depth, 'moveTime:', moveTime);

    return new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;

      this._pendingTimeout = setTimeout(() => {
        console.warn('[PikafishEngine] Search timeout after ' + (moveTime+90000) + 'ms, terminating worker');
        this.stop();
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(new Error('Pikafish search timeout'));
      }, moveTime + 90000);

      this.worker.postMessage({
        type: 'findBestMove',
        fen: fen,
        depth: depth,
        moveTime: moveTime
      });
    });
  }

  stop() {
    if (this._pendingTimeout) {
      clearTimeout(this._pendingTimeout);
      this._pendingTimeout = null;
    }
    if (this._pendingReject) {
      this._pendingReject(new Error('Engine stopped'));
      this._pendingResolve = null;
      this._pendingReject = null;
    }
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
    }
    this.ready = false;
    this._initPromise = null;
    this._pendingResolve = null;
    this._pendingReject = null;
  }

  quit() {
    this.stop();
  }
}

var pikafishEngine = null;

async function getPikafishEngine() {
  if (!pikafishEngine) {
    pikafishEngine = new PikafishEngine();
    await pikafishEngine.init();
  }
  return pikafishEngine;
}