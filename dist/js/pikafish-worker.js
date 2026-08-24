// Pikafish WASM Engine Web Worker
// v167: 适配新版单线程同步搜索引擎 (Pikafish 2026-01-02 wasm rebuild)
//       - NNUE 文件在运行时就绪后写入 MEMFS（新 glue 的 createDataFile 需要堆视图）
//       - 引擎为单线程构建，go 命令同步阻塞至 bestmove 后返回

// Heartbeat: 确认 Worker 代码已开始执行
self.postMessage({ type: 'log', message: '[v166] Worker STARTED' });

self.addEventListener('error', function(e) {
  self.postMessage({ type: 'error', message: 'Worker err: ' + (e.message || (e.error && e.error.message) || e) });
  e.preventDefault();
});
self.addEventListener('unhandledrejection', function(e) {
  self.postMessage({ type: 'error', message: 'Promise reject: ' + ((e.reason && e.reason.message) || e.reason) });
  e.preventDefault();
});

var _wasmBinary = null;
var _nnueBinary = null;
var _outputLines = [];
var _runtimeReady = false;
var _printCount = 0;

// stdin buffer - 供 Module.stdin 和 FS_stdin_getChar 共同使用
var _stdinBytes = [];
var _stdinPos = 0;
var _stdinCallCount = 0;
var _getcharCallCount = 0;
function setStdin(cmds) {
  _stdinBytes = []; _stdinPos = 0; _stdinCallCount = 0; _getcharCallCount = 0;
  for (var i = 0; i < cmds.length; i++) {
    _stdinBytes.push(cmds.charCodeAt(i) & 0xff);
  }
}

function _readStdinChar() {
  if (_stdinPos >= _stdinBytes.length) return null;
  return _stdinBytes[_stdinPos++];
}

function log(msg) {
  self.postMessage({ type: 'log', message: '[v166] ' + msg });
}

var Module = {
  noInitialRun: true,
  noExitRuntime: true,
  noFSInit: false,
  locateFile: function(p) { return p; },

  // v166: 移除 Module.stdin，改用 TTY 路径（FS_stdin_getChar）
  // 关键发现：Module.stdin 在 v165 中从未被调用，说明引擎可能不走这个路径
  // 移除后，FS.createStandardStreams 会创建 /dev/stdin -> /dev/tty 的符号链接
  // stdin 读取将通过 TTY.default_tty_ops.get_char -> FS_stdin_getChar

  print: function(t) {
    var s = String(t);
    _outputLines.push(s);
    _printCount++;
    // v164: 打印所有引擎输出，不限制前50行
    self.postMessage({ type: 'log', message: '[v166] engine: ' + s.substring(0, 200) });
  },
  printErr: function(t) {
    var s = String(t);
    _outputLines.push('[err] ' + s);
    self.postMessage({ type: 'log', message: '[v166] engine(err): ' + s.substring(0, 200) });
  },

  instantiateWasm: function(imports, cb) {
    log('instantiateWasm called, compiling WASM (' + (_wasmBinary ? _wasmBinary.byteLength : 0) + ' bytes)...');
    var t0 = Date.now();
    WebAssembly.instantiate(_wasmBinary, imports).then(
      function(r) {
        log('instantiateWasm done in ' + (Date.now() - t0) + 'ms');
        cb(r.instance);
      },
      function(err) {
        log('instantiateWasm ERROR: ' + (err && err.message ? err.message : String(err)));
        self.postMessage({ type: 'error', message: 'WASM fail: ' + (err.message || err) });
      }
    );
  },

  onRuntimeInitialized: function() {
    log('onRuntimeInitialized fired');
    _runtimeReady = true;
  },

  onAbort: function(w) {
    self.postMessage({ type: 'error', message: 'ABORT: ' + ((w && w.message) || w) });
  }
};

// ============================================================
// onmessage handler
// pikafish.js 已在 Blob 中执行完毕，FS/createWasm/run 等全局可用
// ============================================================
self.onmessage = async function(e) {
  var data = e.data;

  if (data.type === 'init') {
    if (!data.wasmBinary) return;
    _wasmBinary = new Uint8Array(data.wasmBinary);
    _nnueBinary = data.nnueBinary ? new Uint8Array(data.nnueBinary) : null;
    log('init received: wasmBinary=' + _wasmBinary.byteLength + ' nnueBinary=' + (_nnueBinary ? _nnueBinary.byteLength : 'none'));
    log('FS=' + (typeof FS) + ' createWasm=' + (typeof createWasm) + ' run=' + (typeof run));

    // v166: 提前覆盖 FS_stdin_getChar，在 FS.staticInit() 之前
    // 确保 TTY 设备注册时就能读取我们的 buffer
    if (typeof FS_stdin_getChar !== 'undefined') {
      var _origFS_stdin_getChar = FS_stdin_getChar;
      FS_stdin_getChar = function() {
        _getcharCallCount++;
        var ch = _readStdinChar();
        if (_getcharCallCount <= 10 || ch === null) {
          log('FS_stdin_getChar: call #' + _getcharCallCount + ' ch=' + (ch !== null ? String.fromCharCode(ch) + '(' + ch + ')' : 'EOF'));
        }
        if (ch !== null) return ch;
        return _origFS_stdin_getChar();
      };
      log('FS_stdin_getChar overridden EARLY');
    }

    // v166: 全局 FS I/O 调试 - 追踪所有 read/write
    var _fsReadCount = 0;
    var _origFSread = FS.read;
    FS.read = function(stream, buffer, offset, length, position) {
      _fsReadCount++;
      if (_fsReadCount <= 20) {
        log('FS.read #' + _fsReadCount + ' fd=' + (stream.fd) + ' len=' + length + ' node=' + (stream.node ? stream.node.name : '?'));
      }
      return _origFSread.call(this, stream, buffer, offset, length, position);
    };
    log('FS.read debug installed');

    // v166: 检查 FS 中是否存在 pikafish.nnue
    try {
      var nnueStat = FS.stat('/pikafish.nnue');
      log('FS CHECK: /pikafish.nnue EXISTS, size=' + nnueStat.size + ' mode=' + nnueStat.mode.toString(8));
    } catch (e) {
      log('FS CHECK: /pikafish.nnue NOT FOUND');
    }
    // 列出根目录文件
    try {
      var rootFiles = FS.readdir('/');
      log('FS root dir: ' + rootFiles.join(', '));
    } catch (e) {
      log('FS root dir error: ' + e.message);
    }

    // pikafish.js 已在 Blob 中执行，直接触发 WASM 编译
    if (typeof createWasm !== 'function') {
      self.postMessage({ type: 'error', message: 'createWasm not defined after pikafish.js loaded' });
      return;
    }

    // 手动初始化 FS（因为 engine.js 移除了 pikafish.js 末尾的 FS.staticInit()）
    log('calling FS.staticInit()...');
    try {
      FS.staticInit();
      log('FS.staticInit() done');
    } catch (e) {
      log('FS.staticInit() ERROR: ' + (e && e.message ? e.message : String(e)));
    }

    // v167: NNUE 文件改到运行时就绪后再创建（见下方 v167 块），
    // 新版 glue 的 createDataFile 依赖已初始化的堆视图。

    log('triggering createWasm()...');
    try {
      await createWasm();
      log('createWasm resolved, calling run()');
      run();
    } catch (err) {
      log('createWasm/run ERROR: ' + (err && err.message ? err.message : String(err)));
      self.postMessage({ type: 'error', message: 'createWasm/run failed: ' + (err && err.message ? err.message : String(err)) });
      return;
    }

    // Wait for WASM runtime
    log('Waiting for _runtimeReady...');
    var waitStart = Date.now();
    var waitCount = 0;
    while (!_runtimeReady) {
      if (Date.now() - waitStart > 60000) {
        self.postMessage({ type: 'error', message: 'WASM runtime init timeout after 60s' });
        return;
      }
      waitCount++;
      if (waitCount % 50 === 1) {
        log('Still waiting... ' + ((Date.now() - waitStart) / 1000).toFixed(1) + 's');
      }
      await new Promise(function(r) { setTimeout(r, 100); });
    }
    log('WASM runtime ready, heap=' + (wasmMemory.buffer.byteLength / 1048576).toFixed(1) + 'MB');

    // v167: 在运行时就绪后创建 NNUE 文件（新 glue 的 createDataFile 需要堆就绪）
    if (_nnueBinary && _nnueBinary.byteLength > 0) {
      try {
        try { FS.unlink('/pikafish.nnue'); } catch (_) {}
        var t0 = Date.now();
        FS.createDataFile('/', 'pikafish.nnue', _nnueBinary, true, false);
        var stat = FS.stat('/pikafish.nnue');
        log('NNUE file created in ' + (Date.now() - t0) + 'ms, size=' + stat.size + ', mode=' + stat.mode.toString(8));
      } catch (e) {
        var errDetail = 'unknown';
        try { errDetail = e.message || String(e); } catch (_) {}
        log('NNUE file creation ERROR: ' + errDetail);
      }
    } else {
      log('No NNUE binary provided');
    }

    // v166: FS_stdin_getChar 已在前面提前覆盖，此处不再重复

    // 覆盖 out/err 确保输出捕获
    if (typeof out !== 'undefined') {
      var _origOut = out;
      out = function(t) {
        if (Module.print) Module.print(t);
        else _origOut(t);
      };
      log('out overridden');
    }
    if (typeof err !== 'undefined') {
      var _origErr = err;
      err = function(t) {
        if (Module.printErr) Module.printErr(t);
        else _origErr(t);
      };
      log('err overridden');
    }

    // Override mmapAlloc
    mmapAlloc = function(size) {
      if (typeof _malloc === 'function') {
        return _malloc(size);
      }
      return 0;
    };

    // Grow heap
    var currentMem = wasmMemory.buffer.byteLength;
    var neededMem = currentMem + 256 * 1024 * 1024;
    if (typeof _emscripten_resize_heap === 'function') {
      _emscripten_resize_heap(neededMem);
      log('Heap grown to ' + (wasmMemory.buffer.byteLength / 1048576).toFixed(1) + 'MB');
    }

    // Ensure extra directories
    try {
      var dirs = ['/tmp', '/dev/shm', '/dev/shm/tmp'];
      for (var di = 0; di < dirs.length; di++) {
        try { FS.mkdir(dirs[di]); } catch (_) {}
      }
    } catch (_) {}

    // Override FS.mmap (v159: 引擎使用 read_compressed_nnue 通过 std::ifstream 读取，不依赖 mmap)
    var _mmapCallCount = 0;
    FS.mmap = function(stream, length, position, prot, flags) {
      _mmapCallCount++;
      var nodeName = stream.node ? stream.node.name : '?';
      log('FS.mmap #' + _mmapCallCount + ' node=' + nodeName + ' len=' + length + ' pos=' + position + ' prot=' + prot + ' flags=' + flags);
      if (!FS.isFile(stream.node.mode)) {
        log('FS.mmap ERROR: not a file');
        throw new FS.ErrnoError(43);
      }
      if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) {
        log('FS.mmap ERROR: permission denied');
        throw new FS.ErrnoError(2);
      }
      if (!length) {
        log('FS.mmap ERROR: invalid length');
        throw new FS.ErrnoError(28);
      }
      if (FS.forceLoadFile) {
        FS.forceLoadFile(stream.node);
      }
      var ptr = mmapAlloc(length);
      if (!ptr) {
        log('FS.mmap ERROR: mmapAlloc returned 0 for ' + length + ' bytes');
        throw new FS.ErrnoError(48);
      }
      var contents = stream.node.contents;
      if (contents && contents.subarray) {
        HEAPU8.set(contents.subarray(position, position + length), ptr);
      } else if (contents) {
        for (var i = 0; i < length; i++) {
          HEAP8[ptr + i] = contents[position + i];
        }
      }
      log('FS.mmap OK: ptr=' + ptr + ' len=' + length);
      return { ptr: ptr, allocated: true };
    };

    // Override MEMFS.stream_ops.mmap
    if (MEMFS && MEMFS.ops_table && MEMFS.ops_table.file && MEMFS.ops_table.file.stream) {
      MEMFS.ops_table.file.stream.mmap = function(stream, length, position, prot, flags) {
        var ptr = mmapAlloc(length);
        if (!ptr) {
          throw new FS.ErrnoError(48);
        }
        var contents = stream.node.contents;
        if (contents && contents.subarray) {
          HEAPU8.set(contents.subarray(position, position + length), ptr);
        } else if (contents) {
          for (var i = 0; i < length; i++) {
            HEAP8[ptr + i] = contents[position + i];
          }
        }
        return { ptr: ptr, allocated: true };
      };
    }

    // Override exitJS
    exitJS = function(status) {
      EXITSTATUS = status;
    };
    log('exitJS overridden');

    // Ready
    log('=== READY ===');
    self.postMessage({ type: 'ready' });

  } else if (data.type === 'findBestMove') {
    var result = _doSearch(data.fen, data.depth, data.moveTime);
    self.postMessage({ type: 'bestmove', move: result });
  } else if (data.type === 'shutdown') {
    log('Shutdown');
  }
};

// ============================================================
// pikafish.js 在 Blob 中紧随 worker.js 之后执行
// 它会检测到已存在的 Module 对象并复用，定义 FS/createWasm/run 等
// FS.staticInit() 和 createWasm().then(run) 已在 engine.js 中被移除
// ============================================================

function _doSearch(fen, depth, moveTime) {
  _outputLines = [];
  _printCount = 0;
  var t0 = Date.now();

  var cmds = 'uci\n' +
    // v165: 跳过 NNUE，不发送 setoption
    'isready\n' +
    'position fen ' + fen + '\n' +
    'go movetime ' + moveTime + '\n' +
    'quit\n';
  setStdin(cmds);

  log('Search: movetime=' + moveTime + ' fen=' + fen.substring(0, 60));
  log('Stdin buffer size: ' + _stdinBytes.length + ' bytes');

  if (typeof _main !== 'function') {
    log('ERROR: _main is not a function!');
    return null;
  }

  try {
    log('>>> Calling callMain([]) ...');
    callMain([]);
    log('callMain returned in ' + (Date.now() - t0) + 'ms, ' + _outputLines.length + ' output lines');
  } catch (e) {
    if (e && e.name === 'ExitStatus') {
      log('Engine exited normally (ExitStatus)');
    } else {
      log('callMain error: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Find bestmove
  for (var j = _outputLines.length - 1; j >= 0; j--) {
    var line = _outputLines[j].trim();
    if (line.indexOf('bestmove') === 0) {
      var p = line.split(/\s+/);
      log('Found bestmove: ' + line);
      if (p.length >= 2 && p[1].length >= 4 && p[1] !== '(none)') {
        return {
          fromRow: 9 - (p[1].charCodeAt(1) - 48),
          fromCol: p[1].charCodeAt(0) - 97,
          toRow: 9 - (p[1].charCodeAt(3) - 48),
          toCol: p[1].charCodeAt(2) - 97
        };
      }
    }
  }

  // Log first/last output for debugging
  for (var i = 0; i < Math.min(_outputLines.length, 5); i++) {
    log('  out[' + i + ']: ' + _outputLines[i].substring(0, 200));
  }
  if (_outputLines.length > 10) {
    log('  ... (' + (_outputLines.length - 10) + ' more lines) ...');
    for (var i = _outputLines.length - 5; i < _outputLines.length; i++) {
      log('  out[' + i + ']: ' + _outputLines[i].substring(0, 200));
    }
  }

  log('No bestmove found in ' + _outputLines.length + ' lines');
  return null;
}