
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var activeConnections = /* @__PURE__ */ new Set();
var onlineCount = 0;
var aiWeights = {
  attackKing: 70,
  limitKingMob: 35,
  approach: 30,
  mobility: 5,
  rookNotMoved: 5,
  rookCrossed: 110,
  rookDeveloped: 90,
  horseDeveloped: 25,
  cannonDeveloped: 15,
  pieceSafety: 80,
  hangingPenalty: 80,
  tradeAccuracy: 120,
  pawnPromotion: 50,
  checkBonus: 130,
  centerControl: 20,
  rookCoordination: 60,
  kingSafety: 40
};
var aiTotalStats = { games: 0, redWins: 0, blkWins: 0, draws: 0 };
function broadcastOnlineCount() {
  const msg = JSON.stringify({ event: "online_count", data: onlineCount });
  for (const ws of activeConnections) {
    try {
      ws.send(msg);
    } catch (e) {
    }
  }
}
__name(broadcastOnlineCount, "broadcastOnlineCount");
var ChessRoom = class {
  static {
    __name(this, "ChessRoom");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.disconnected = {};
    this._cleanupTimer = null;
  }
  async initRoom(roomId) {
    if (!this.room) {
      this.room = {
        id: roomId,
        players: /* @__PURE__ */ new Map(),
        spectators: /* @__PURE__ */ new Set(),
        currentTurn: "red",
        gameOver: false,
        winner: null,
        redTime: 900,
        blkTime: 900,
        moveHistory: [],
        capturedRed: [],
        capturedBlack: [],
        playerTokens: null,
        gameStarted: false,
        createdAt: Date.now()
      };
      try {
        if (this.env.CHESS_DB) {
          const saved = await this.env.CHESS_DB.prepare(
            "SELECT state FROM room_state WHERE room_id = ?"
          ).bind(roomId).first();
          if (saved && saved.state) {
            const s = JSON.parse(saved.state);
            if (s && s.createdAt && Date.now() - s.createdAt < 36e5) {
              this.room.currentTurn = s.currentTurn || "red";
              this.room.gameOver = s.gameOver || false;
              this.room.winner = s.winner || null;
              this.room.redTime = s.redTime != null ? s.redTime : 900;
              this.room.blkTime = s.blkTime != null ? s.blkTime : 900;
              this.room.moveHistory = s.moveHistory || [];
              this.room.capturedRed = s.capturedRed || [];
              this.room.capturedBlack = s.capturedBlack || [];
              this.room.createdAt = s.createdAt;
              this.room.playerTokens = s.playerTokens || null;
              this.room.gameStarted = !!s.gameStarted;
              this.room._restoredFromDb = true;
            }
          }
        }
      } catch (e) {
      }
    }
  }
  async _saveRoomState() {
    if (!this.room || !this.env.CHESS_DB) return;
    try {
      await this.env.CHESS_DB.exec(
        "CREATE TABLE IF NOT EXISTS room_state (room_id TEXT PRIMARY KEY, state TEXT, updated_at INTEGER)"
      );
      const state = JSON.stringify({
        currentTurn: this.room.currentTurn,
        gameOver: this.room.gameOver,
        winner: this.room.winner,
        redTime: this.room.redTime,
        blkTime: this.room.blkTime,
        moveHistory: this.room.moveHistory.slice(-200),
        capturedRed: this.room.capturedRed || [],
        capturedBlack: this.room.capturedBlack || [],
        playerTokens: this.room.playerTokens || null,
        gameStarted: !!this.room.gameStarted,
        createdAt: this.room.createdAt
      });
      await this.env.CHESS_DB.prepare(
        "INSERT OR REPLACE INTO room_state (room_id, state, updated_at) VALUES (?, ?, ?)"
      ).bind(this.room.id, state, Date.now()).run();
    } catch (e) {
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const roomId2 = url.searchParams.get("roomId") || this.ctx.id.toString().split("-").pop();
      await this.initRoom(roomId2);
      server.accept();
      this.handleRoomWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const roomId = url.searchParams.get("roomId") || this.ctx.id.toString().split("-").pop();
    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.action === "init-room") {
          await this.initRoom(roomId);
          return new Response(JSON.stringify({ success: true, roomId }), { headers: { "Content-Type": "application/json" } });
        }
      } catch (e) {
      }
    }
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        roomId,
        playerCount: this.room ? this.room.players.size : 0,
        exists: !!this.room
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  }
  handleRoomWebSocket(ws) {
    const socketData = { color: null, spectator: false, replaced: false };
    ws._socketData = socketData;
    ws._lastSeen = Date.now();
    let heartbeatTimer = null;
    let heartbeatTimeout = null;
    const startHeartbeat = /* @__PURE__ */ __name(() => {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
        try {
          ws.send(JSON.stringify({ event: "ping" }));
        } catch (e) {
        }
        heartbeatTimeout = setTimeout(() => {
          try {
            ws.close();
          } catch (e) {
          }
        }, 6e4);
      }, 3e4);
    }, "startHeartbeat");
    const stopHeartbeat = /* @__PURE__ */ __name(() => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
    }, "stopHeartbeat");
    startHeartbeat();
    ws.onmessage = async (event) => {
      try {
        ws._lastSeen = Date.now();
        const data = JSON.parse(event.data);
        const eventName = data.event || data[0];
        const payload = data.payload || data[1];
        if (eventName === "pong") {
          if (heartbeatTimeout) {
            clearTimeout(heartbeatTimeout);
            heartbeatTimeout = null;
          }
        } else if (eventName === "ping") {
          try {
            ws.send(JSON.stringify({ event: "pong" }));
          } catch (e) {
          }
        } else if (eventName === "create_room") {
          if (this._cleanupTimer) {
            clearTimeout(this._cleanupTimer);
            this._cleanupTimer = null;
          }
          // 清扫僵尸座位：已关闭/半关闭/已被替换的旧连接不再占用颜色，
          // 防止"离开后同房间号重进"产生同色双座位（卡死根源）
          for (const [pws, p] of [...this.room.players]) {
            const st = pws.readyState;
            const rep = pws._socketData && pws._socketData.replaced;
            if (st === 2 || st === 3 || rep) this.room.players.delete(pws);
          }
          let lastColor = null;
          if (payload && typeof payload === "object" && payload.lastColor) {
            lastColor = payload.lastColor;
          }
          if (this.room.players.size > 0) {
            let existingColor = [...this.room.players.values()][0].color;
            let myColor = existingColor === "red" ? "black" : "red";
            // 最终保险：若目标颜色仍被其他存活连接占用（半开僵尸未被清扫），则取反色；双方都被占则拒绝
            const takenByLive = [...this.room.players.entries()].some(([pws2, p2]) => p2.color === myColor && pws2 !== ws && !(pws2._socketData && pws2._socketData.replaced));
            if (takenByLive) myColor = myColor === "red" ? "black" : "red";
            const stillTaken = [...this.room.players.values()].some((p2) => p2.color === myColor);
            if (stillTaken) {
              ws.send(JSON.stringify({ event: "error", data: "\u623F\u95F4\u5DF2\u6EE1" }));
              return;
            }
            const myPid = Math.random().toString(36).slice(2) + Date.now().toString(36);
            if (!this.room.playerTokens) this.room.playerTokens = {};
            this.room.playerTokens[myColor] = myPid;
            this.room.players.set(ws, { id: Math.random().toString(36).slice(2), color: myColor, assignedAt: Date.now() });
            socketData.color = myColor;
            ws.send(JSON.stringify({ event: "room_created", data: { roomId: this.room.id, color: myColor, pid: myPid } }));
          } else {
            let myColor;
            if (lastColor === "red") {
              myColor = "black";
            } else if (lastColor === "black") {
              myColor = "red";
            } else {
              myColor = Math.random() < 0.5 ? "red" : "black";
            }
            const myPid = Math.random().toString(36).slice(2) + Date.now().toString(36);
            if (!this.room.playerTokens) this.room.playerTokens = {};
            this.room.playerTokens[myColor] = myPid;
            this.room.players.set(ws, { id: Math.random().toString(36).slice(2), color: myColor, assignedAt: Date.now() });
            socketData.color = myColor;
            ws.send(JSON.stringify({ event: "room_created", data: { roomId: this.room.id, color: myColor, pid: myPid } }));
          }
        } else if (eventName === "join_room") {
          if (this._cleanupTimer) {
            clearTimeout(this._cleanupTimer);
            this._cleanupTimer = null;
          }
          // 同上：先清扫僵尸座位再判断房间是否满员
          for (const [pws, p] of [...this.room.players]) {
            const st = pws.readyState;
            const rep = pws._socketData && pws._socketData.replaced;
            if (st === 2 || st === 3 || rep) this.room.players.delete(pws);
          }
          if (this.room.players.size === 0) {
            ws.send(JSON.stringify({ event: "error", data: "\u623F\u95F4\u4E0D\u5B58\u5728" }));
            return;
          }
          if (this.room.players.size >= 2) {
            this.room.spectators.add(ws);
            socketData.spectator = true;
            ws.send(JSON.stringify({ event: "spectator_joined", data: { roomId: this.room.id, moveHistory: this.room.moveHistory } }));
            return;
          }
          let color = [...this.room.players.values()][0].color === "red" ? "black" : "red";
          const joinPid = Math.random().toString(36).slice(2) + Date.now().toString(36);
          if (!this.room.playerTokens) this.room.playerTokens = {};
          this.room.playerTokens[color] = joinPid;
          this.room.players.set(ws, { id: Math.random().toString(36).slice(2), color, assignedAt: Date.now() });
          socketData.color = color;
          if (this.room.players.size >= 2) this.room.gameStarted = true;
          ws.send(JSON.stringify({ event: "room_joined", data: { roomId: this.room.id, color, pid: joinPid } }));
          this.broadcastRoomState();
          this.broadcastToPlayers(JSON.stringify({ event: "game_start", data: { currentTurn: this.room.currentTurn } }));
          this.startRoomTimer();
        } else if (eventName === "make_move") {
          if (!this.room || this.room.gameOver) {
            ws.send(JSON.stringify({ event: "move_rejected", data: { reason: "invalid_state" } }));
            return;
          }
          if (this.room.players.size < 2 && this.room.moveHistory.length === 0 && !this.room.gameStarted) {
            ws.send(JSON.stringify({ event: "move_rejected", data: { reason: "invalid_state" } }));
            return;
          }
          if (!socketData.color) {
            for (const [pws, player] of this.room.players) {
              if (pws === ws) {
                socketData.color = player.color;
                break;
              }
            }
          }
          if (!socketData.color) {
            ws.send(JSON.stringify({ event: "move_rejected", data: { reason: "no_color" } }));
            return;
          }
          const histLen = this.room.moveHistory.length;
          const lastMv = this.room.moveHistory[histLen - 1];
          if (lastMv && payload && lastMv.fromRow === payload.fromRow && lastMv.fromCol === payload.fromCol && lastMv.toRow === payload.toRow && lastMv.toCol === payload.toCol) {
            try {
              ws.send(JSON.stringify({ event: "move_ack", data: { moveHistoryLen: this.room.moveHistory.length, lastMove: { fromRow: lastMv.fromRow, fromCol: lastMv.fromCol, toRow: lastMv.toRow, toCol: lastMv.toCol }, currentTurn: this.room.currentTurn } }));
            } catch (e) {
            }
            return;
          }
          if (this.room.currentTurn !== socketData.color) {
            ws.send(JSON.stringify({ event: "move_rejected", data: { reason: "not_your_turn" } }));
            return;
          }
          const move = { ...payload, timestamp: Date.now() };
          this.room.moveHistory.push(move);
          if (move.captured) {
            if (!this.room.capturedRed) this.room.capturedRed = [];
            if (!this.room.capturedBlack) this.room.capturedBlack = [];
            if (move.captured.color === "red") this.room.capturedRed.push(move.captured);
            else this.room.capturedBlack.push(move.captured);
          }
          this.room.currentTurn = socketData.color === "red" ? "black" : "red";
          if (move.redLeft !== void 0) this.room.redTime = move.redLeft;
          if (move.blkLeft !== void 0) this.room.blkTime = move.blkLeft;
          if (move.gameOver) {
            this.room.gameOver = true;
            this.room._gameEndedAt = Date.now();
            this.room.winner = move.winner;
            if (this.room._timer) {
              clearInterval(this.room._timer);
              this.room._timer = null;
            }
          }
          const opponentMove = { ...move, redLeft: this.room.redTime, blkLeft: this.room.blkTime };
          const ackData = { moveHistoryLen: this.room.moveHistory.length, lastMove: { fromRow: move.fromRow, fromCol: move.fromCol, toRow: move.toRow, toCol: move.toCol }, currentTurn: this.room.currentTurn };
          try {
            ws.send(JSON.stringify({ event: "move_ack", data: ackData }));
          } catch (e) {
          }
          this.broadcastToOpponent(ws, JSON.stringify({ event: "opponent_move", data: opponentMove }));
          this.broadcastRoomStateToOpponent(ws);
          this.broadcastToSpectators(JSON.stringify({ event: "opponent_move", data: opponentMove }));
          await this._saveRoomState();
        } else if (eventName === "resign") {
          if (!this.room) return;
          this.room.gameOver = true;
          this.room._gameEndedAt = Date.now();
          this.room.winner = socketData.color === "red" ? "black" : "red";
          if (this.room._timer) {
            clearInterval(this.room._timer);
            this.room._timer = null;
          }
          this.broadcastToRoom(JSON.stringify({ event: "game_over", data: { winner: this.room.winner, reason: "resign" } }));
          await this._saveRoomState();
        } else if (eventName === "request_draw") {
          if (!this.room) return;
          this.broadcastToOpponent(ws, JSON.stringify({ event: "draw_requested", data: { from: socketData.color } }));
        } else if (eventName === "accept_draw") {
          if (!this.room) return;
          this.room.gameOver = true;
          this.room._gameEndedAt = Date.now();
          this.room.winner = "draw";
          if (this.room._timer) {
            clearInterval(this.room._timer);
            this.room._timer = null;
          }
          this.broadcastToRoom(JSON.stringify({ event: "game_over", data: { winner: "draw", reason: "draw" } }));
          await this._saveRoomState();
        } else if (eventName === "reject_draw") {
          if (!this.room) return;
          this.broadcastToOpponent(ws, JSON.stringify({ event: "draw_rejected", data: {} }));
        } else if (eventName === "chat") {
          if (!this.room) return;
          const msg = { from: socketData.color || "spectator", color: socketData.color, message: payload, timestamp: Date.now() };
          this.broadcastToRoom(JSON.stringify({ event: "chat", data: msg }));
        } else if (eventName === "rematch_request") {
          if (!this.room || this.room.players.size < 2) return;
          this.broadcastToOpponent(ws, JSON.stringify({ event: "rematch_requested", data: {} }));
        } else if (eventName === "accept_rematch") {
          if (!this.room || this.room.players.size < 2) return;
          const playerEntries = [...this.room.players.entries()];
          if (playerEntries.length === 2) {
            const [wsA, dataA] = playerEntries[0];
            const [wsB, dataB] = playerEntries[1];
            const tmpColor = dataA.color;
            dataA.color = dataB.color;
            dataB.color = tmpColor;
            if (wsA._socketData) wsA._socketData.color = dataA.color;
            if (wsB._socketData) wsB._socketData.color = dataB.color;
          }
          if (this.room.playerTokens && this.room.playerTokens.red && this.room.playerTokens.black) {
            const tmpTok = this.room.playerTokens.red;
            this.room.playerTokens.red = this.room.playerTokens.black;
            this.room.playerTokens.black = tmpTok;
          }
          this.room.gameOver = false;
          this.room._gameEndedAt = null;
          this.room.winner = null;
          this.room.currentTurn = "red";
          this.room.redTime = 900;
          this.room.blkTime = 900;
          this.room.moveHistory = [];
          this.room.capturedRed = [];
          this.room.capturedBlack = [];
          this.room.createdAt = Date.now();
          this.startRoomTimer();
          this.broadcastToRoom(JSON.stringify({ event: "rematch_start", data: {} }));
          this.broadcastRoomState();
          await this._saveRoomState();
        } else if (eventName === "request_undo") {
          if (!this.room || this.room.moveHistory.length === 0 || this.room.gameOver) return;
          this.broadcastToOpponent(ws, JSON.stringify({ event: "undo_requested", data: {} }));
        } else if (eventName === "accept_undo") {
          if (!this.room || this.room.moveHistory.length === 0) return;
          const lastMove = this.room.moveHistory.pop();
          this.room.gameOver = false;
          this.room.winner = null;
          this.room.currentTurn = lastMove.currentTurn === "red" ? "black" : "red";
          if (lastMove.captured) {
            if (lastMove.captured.color === "red" && this.room.capturedRed && this.room.capturedRed.length > 0) {
              this.room.capturedRed.pop();
            } else if (lastMove.captured.color === "black" && this.room.capturedBlack && this.room.capturedBlack.length > 0) {
              this.room.capturedBlack.pop();
            }
          }
          this.broadcastToOpponent(ws, JSON.stringify({ event: "undo_accepted", data: {} }));
          this.broadcastRoomState();
          await this._saveRoomState();
        } else if (eventName === "reject_undo") {
          if (!this.room) return;
          this.broadcastToOpponent(ws, JSON.stringify({ event: "undo_rejected", data: {} }));
        } else if (eventName === "reconnect_room") {
          // 自愈：房间对象已被销毁（如对手离开重建）时，从D1或全新状态恢复，避免静默失败
          if (!this.room) {
            try { await this.initRoom(this.room.id); } catch (e2) {}
          }
          if (!this.room) return;
          const otherEntries = [...this.room.players.entries()].filter(([pws]) => pws !== ws);
          const isReplaceable = /* @__PURE__ */ __name((c) => otherEntries.some(([pws, p]) => p.color === c && (pws.readyState === WebSocket.CLOSED || pws.readyState === WebSocket.CLOSING || pws.readyState === WebSocket.CONNECTING || this.disconnected && this.disconnected[c])), "isReplaceable");
          const isFree = /* @__PURE__ */ __name((c) => !otherEntries.some(([, p]) => p.color === c), "isFree");
          if (payload && payload.pid && this.room.playerTokens) {
            const tokColor = this.room.playerTokens.red === payload.pid ? "red" : this.room.playerTokens.black === payload.pid ? "black" : null;
            if (tokColor) {
              payload.color = tokColor;
            }
          }
          let color = payload.color;
          if (color) {
            if (isFree(color)) {
            } else {
              const sameColorEntry = otherEntries.find(([, p]) => p.color === color);
              if (sameColorEntry) {
                // 同色座位占用裁决：
                //  允许接管 = pid匹配(本人) | 持有者已死/被替换 | 持有者闲置>25s(僵尸) | 座位早于该色离开标记(旧主人回归)
                //  其余（离开重建后新客人合法占座）→ 不抢，改反色或拒绝
                const [hws, seat] = sameColorEntry;
                const pidMatches = !!(payload.pid && this.room.playerTokens && this.room.playerTokens[color] === payload.pid);
                const holderDead = hws.readyState !== 1 || (hws._socketData && hws._socketData.replaced);
                const holderIdle = !hws._lastSeen || Date.now() - hws._lastSeen > 25e3;
                const preDiscSeat = !!(this.disconnected && this.disconnected[color] && seat.assignedAt && this.disconnected[color] > seat.assignedAt);
                if (!pidMatches && !holderDead && !holderIdle && !preDiscSeat) {
                  const alt2 = color === "red" ? "black" : "red";
                  if (isFree(alt2) || isReplaceable(alt2)) {
                    color = alt2;
                  } else {
                    ws.send(JSON.stringify({ event: "error", data: "\u623F\u95F4\u5DF2\u6EE1\uFF0C\u65E0\u6CD5\u91CD\u8FDE" }));
                    try { ws.close(); } catch (e2) {}
                    return;
                  }
                }
              } else {
                const alt = color === "red" ? "black" : "red";
                if (isFree(alt) || isReplaceable(alt)) {
                  color = alt;
                } else {
                  ws.send(JSON.stringify({ event: "error", data: "\u623F\u95F4\u5DF2\u6EE1\uFF0C\u65E0\u6CD5\u91CD\u8FDE" }));
                  try {
                    ws.close();
                  } catch (e) {
                  }
                  return;
                }
              }
            }
          }
          if (!color) {
            const existingColors = [...this.room.players.values()].map((p) => p.color);
            if (existingColors.includes("red")) color = "black";
            else if (existingColors.includes("black")) color = "red";
            else if (this.disconnected.red) color = "red";
            else if (this.disconnected.black) color = "black";
          }
          if (!color) {
            ws.send(JSON.stringify({ event: "error", data: "\u65E0\u6CD5\u91CD\u8FDE" }));
            return;
          }
          if (this.disconnected[color]) delete this.disconnected[color];
          if (this.room._disconnectTimer) {
            clearTimeout(this.room._disconnectTimer);
            this.room._disconnectTimer = null;
          }
          // 身份自愈：若来者 pid 与该座位令牌不符（换先后本地过期），接管座位时轮换令牌，
          // 并在 room_state 中下发新 pid（附加字段，旧前端忽略，无兼容性影响）
          let rotatedPid = null;
          const pidMatches = !!(payload.pid && this.room.playerTokens && this.room.playerTokens[color] === payload.pid);
          if (!pidMatches) {
            rotatedPid = Math.random().toString(36).slice(2) + Date.now().toString(36);
            if (!this.room.playerTokens) this.room.playerTokens = {};
            this.room.playerTokens[color] = rotatedPid;
          }
          for (const [pws, player] of this.room.players) {
            if (player.color === color && pws !== ws) {
              if (pws._socketData) pws._socketData.replaced = true;
              this.room.players.delete(pws);
              break;
            }
          }
          this.room.players.set(ws, { id: Math.random().toString(36).slice(2), color, assignedAt: Date.now() });
          socketData.color = color;
          if (this.room.players.size >= 2) this.room.gameStarted = true;
          const gameInProgress = !this.room.gameOver && this.room.moveHistory.length > 0;
          try {
            ws.send(JSON.stringify({ event: "room_state", data: {
              roomId: this.room.id,
              color,
              moveHistory: this.room.moveHistory,
              currentTurn: this.room.currentTurn,
              gameOver: this.room.gameOver,
              winner: this.room.winner,
              redTime: this.room.redTime,
              blkTime: this.room.blkTime,
              capturedRed: this.room.capturedRed,
              capturedBlack: this.room.capturedBlack,
              gameStarted: true,
              pid: rotatedPid || payload.pid || undefined
            } }));
          } catch (e) {
          }
          this.broadcastRoomState();
          if (!this.room.gameOver && this.room.players.size >= 2) {
            this.startRoomTimer();
          }
          this.broadcastToOpponent(ws, JSON.stringify({ event: "player_reconnected", data: { color } }));
        } else if (eventName === "leave_room") {
          if (!this.room) return;
          if (socketData.spectator) {
            this.room.spectators.delete(ws);
            return;
          }
          const room = this.room;
          this.room = null;
          if (room._timer) {
            clearInterval(room._timer);
            room._timer = null;
          }
          room.players.delete(ws);
          for (const [pws] of room.players) {
            try {
              pws.send(JSON.stringify({ event: "opponent_left", data: {} }));
            } catch (e) {
            }
          }
          room.players.forEach((p, pws) => {
            try {
              pws.close();
            } catch (e) {
            }
          });
          room.spectators.forEach((s) => {
            try {
              s.close();
            } catch (e) {
            }
          });
          try {
            ws.close();
          } catch (e) {
          }
          try {
            if (this.env.CHESS_DB) this.env.CHESS_DB.prepare("DELETE FROM room_state WHERE room_id = ?").bind(room.id).run();
          } catch (e) {
          }
          if (this._cleanupTimer) {
            clearTimeout(this._cleanupTimer);
            this._cleanupTimer = null;
          }
          this.disconnected = {};
        }
      } catch (e) {
        console.error("Room WebSocket message error:", e);
      }
    };
    ws.onclose = () => {
      stopHeartbeat();
      if (socketData.spectator) {
        if (this.room) this.room.spectators.delete(ws);
        return;
      }
      if (!this.room || !socketData.color) return;
      if (socketData.replaced) return;
      this.room.players.delete(ws);
      if (this.room._timer) {
        clearInterval(this.room._timer);
        this.room._timer = null;
      }
      this.disconnected[socketData.color] = Date.now();
      this.broadcastToOpponent(ws, JSON.stringify({ event: "player_disconnected", data: { color: socketData.color } }));
      this._saveRoomState();
      if (!this.room._disconnectTimer) {
        this.room._disconnectTimer = setTimeout(() => {
          if (!this.room || this.room.gameOver) return;
          const now = Date.now();
          for (const color of ["red", "black"]) {
            if (this.disconnected[color] && now - this.disconnected[color] > 18e4) {
              this.room.gameOver = true;
              this.room._gameEndedAt = now;
              this.room.winner = color === "red" ? "black" : "red";
              this.broadcastToRoom(JSON.stringify({ event: "game_over", data: { winner: this.room.winner, reason: "disconnect_timeout" } }));
              this.broadcastToRoom(JSON.stringify({ event: "room_timeout", data: {} }));
              if (this.room._timer) {
                clearInterval(this.room._timer);
                this.room._timer = null;
              }
              this._saveRoomState();
              break;
            }
          }
          this.room._disconnectTimer = null;
        }, 183e3);
      }
    };
    ws.onerror = () => {
      stopHeartbeat();
    };
  }
  broadcastToRoom(msg) {
    if (!this.room) return;
    for (const ws of this.room.players.keys()) {
      try {
        ws.send(msg);
      } catch (e) {
      }
    }
    for (const ws of this.room.spectators) {
      try {
        ws.send(msg);
      } catch (e) {
      }
    }
  }
  broadcastRoomState() {
    if (!this.room) return;
    const baseState = this.getRoomState();
    for (const [ws, player] of this.room.players) {
      try {
        ws.send(JSON.stringify({ event: "room_state", data: { ...baseState, color: player.color } }));
      } catch (e) {
      }
    }
    for (const ws of this.room.spectators) {
      try {
        ws.send(JSON.stringify({ event: "room_state", data: baseState }));
      } catch (e) {
      }
    }
  }
  broadcastToPlayers(msg) {
    if (!this.room) return;
    for (const ws of this.room.players.keys()) {
      try {
        ws.send(msg);
      } catch (e) {
      }
    }
  }
  broadcastToSpectators(msg) {
    if (!this.room) return;
    for (const ws of this.room.spectators) {
      try {
        ws.send(msg);
      } catch (e) {
      }
    }
  }
  broadcastToOpponent(ws, msg) {
    if (!this.room) return;
    for (const [pws, player] of this.room.players) {
      if (pws !== ws) {
        try {
          pws.send(msg);
        } catch (e) {
        }
      }
    }
  }
  broadcastRoomStateToOpponent(ws) {
    if (!this.room) return;
    const baseState = this.getRoomState();
    for (const [pws, player] of this.room.players) {
      if (pws !== ws) {
        try {
          pws.send(JSON.stringify({ event: "room_state", data: { ...baseState, color: player.color } }));
        } catch (e) {
        }
      }
    }
  }
  getRoomState() {
    return {
      roomId: this.room.id,
      playerCount: this.room.players.size,
      currentTurn: this.room.currentTurn,
      gameOver: this.room.gameOver,
      winner: this.room.winner,
      moveHistory: this.room.moveHistory,
      redTime: this.room.redTime,
      blkTime: this.room.blkTime,
      capturedRed: this.room.capturedRed,
      capturedBlack: this.room.capturedBlack,
      gameStarted: this.room.players.size >= 2
    };
  }
  startRoomTimer() {
    if (!this.room) return;
    if (this.room._timer) clearInterval(this.room._timer);
    this.room._timerLastTick = Date.now();
    this.room._timer = setInterval(() => {
      if (!this.room) return;
      if (this.room.gameOver) {
        clearInterval(this.room._timer);
        this.room._timer = null;
        return;
      }
      const now = Date.now();
      const elapsed = Math.max(1, Math.round((now - this.room._timerLastTick) / 1e3));
      this.room._timerLastTick = now;
      if (this.room.currentTurn === "red") {
        this.room.redTime = Math.max(0, this.room.redTime - elapsed);
        if (this.room.redTime <= 0) {
          this.room.gameOver = true;
          this.room.winner = "black";
          this.room._gameEndedAt = Date.now();
          clearInterval(this.room._timer);
          this.room._timer = null;
          this.broadcastToRoom(JSON.stringify({ event: "timeout", data: { winner: "black" } }));
          this.broadcastToRoom(JSON.stringify({ event: "game_over", data: { winner: "black", reason: "timeout" } }));
          this._saveRoomState();
        }
      } else {
        this.room.blkTime = Math.max(0, this.room.blkTime - elapsed);
        if (this.room.blkTime <= 0) {
          this.room.gameOver = true;
          this.room.winner = "red";
          this.room._gameEndedAt = Date.now();
          clearInterval(this.room._timer);
          this.room._timer = null;
          this.broadcastToRoom(JSON.stringify({ event: "timeout", data: { winner: "red" } }));
          this.broadcastToRoom(JSON.stringify({ event: "game_over", data: { winner: "red", reason: "timeout" } }));
          this._saveRoomState();
        }
      }
    }, 1e3);
  }
};
async function initAiDb(db) {
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS ai_weights (id INTEGER PRIMARY KEY, weights TEXT, stats TEXT, updated_at INTEGER)`);
  } catch (e) {
    console.error("initAiDb error:", e.message);
  }
}
__name(initAiDb, "initAiDb");
async function loadAiFromDb(db) {
  try {
    const result = await db.prepare("SELECT weights, stats FROM ai_weights WHERE id = 1").first();
    if (result) {
      if (result.weights) {
        try {
          const w = JSON.parse(result.weights);
          for (const k in w) {
            if (aiWeights[k] !== void 0 && typeof w[k] === "number") aiWeights[k] = w[k];
          }
        } catch (e) {
        }
      }
      if (result.stats) {
        try {
          const s = JSON.parse(result.stats);
          if (s && typeof s === "object") {
            if (typeof s.games === "number") aiTotalStats.games = s.games;
            if (typeof s.redWins === "number") aiTotalStats.redWins = s.redWins;
            if (typeof s.blkWins === "number") aiTotalStats.blkWins = s.blkWins;
            if (typeof s.draws === "number") aiTotalStats.draws = s.draws;
          }
        } catch (e) {
        }
      }
    }
  } catch (e) {
    console.error("loadAiFromDb error:", e.message);
  }
}
__name(loadAiFromDb, "loadAiFromDb");
async function saveAiToDb(db) {
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS ai_weights (id INTEGER PRIMARY KEY, weights TEXT, stats TEXT, updated_at INTEGER)`);
    await db.prepare(`INSERT OR REPLACE INTO ai_weights (id, weights, stats, updated_at) VALUES (1, ?, ?, ?)`).bind(JSON.stringify(aiWeights), JSON.stringify(aiTotalStats), Date.now()).run();
    return true;
  } catch (e) {
    console.error("saveAiToDb error:", e.message);
    return false;
  }
}
__name(saveAiToDb, "saveAiToDb");
async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (env.CHESS_DB) {
    await initAiDb(env.CHESS_DB);
    await loadAiFromDb(env.CHESS_DB);
  }
  if (path === "/api/ai/db-check") {
    if (env.CHESS_DB) {
      const raw = await env.CHESS_DB.prepare("SELECT * FROM ai_weights WHERE id = 1").first();
      return new Response(JSON.stringify({ raw, aiTotalStats }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "no db" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (path === "/api/train/start") {
    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (path === "/api/train/stop") {
    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (path === "/api/train/status") {
    if (env.CHESS_DB) {
      await loadAiFromDb(env.CHESS_DB);
    }
    return new Response(JSON.stringify({
      training: false,
      session: { games: 0, redWins: 0, blkWins: 0, draws: 0 },
      total: aiTotalStats,
      weights: aiWeights
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (path === "/api/ai/data") {
    if (request.method === "GET") {
      if (env.CHESS_DB) {
        await loadAiFromDb(env.CHESS_DB);
      }
      return new Response(JSON.stringify({ weights: aiWeights, trainStats: aiTotalStats }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (request.method === "POST") {
      try {
        if (env.CHESS_DB) {
          await loadAiFromDb(env.CHESS_DB);
        }
        const data = await request.json();
        if (data.weights) {
          const mergeFactor = data.isDelta ? 0.3 : 0.5;
          for (const k in data.weights) {
            if (aiWeights[k] !== void 0) {
              const newValue = data.weights[k];
              aiWeights[k] = aiWeights[k] * (1 - mergeFactor) + newValue * mergeFactor;
            }
          }
        }
        if (data.stats) {
          for (const k in data.stats) {
            if (aiTotalStats[k] !== void 0) {
              aiTotalStats[k] += data.stats[k] || 0;
            }
          }
        }
        let saved = false;
        if (env.CHESS_DB) {
          saved = await saveAiToDb(env.CHESS_DB);
        }
        return new Response(JSON.stringify({ success: true, weights: aiWeights, total: aiTotalStats, saved }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
      }
    }
  }
  if (path === "/api/rooms") {
    return new Response(JSON.stringify({ rooms: [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (path === "/api/online") {
    return new Response(JSON.stringify({ count: onlineCount }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (path === "/api/create-room") {
    const customId = url.searchParams.get("id");
    const roomId = customId || Math.random().toString(36).slice(2, 8).toUpperCase();
    return new Response(JSON.stringify({ roomId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "Not found" }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 });
}
__name(handleApiRequest, "handleApiRequest");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      return await handleApiRequest(request, env);
    }
    if (request.headers.get("Upgrade") === "websocket") {
      const roomId = url.searchParams.get("roomId");
      if (!roomId) {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        handleWebSocket(server, env);
        return new Response(null, { status: 101, webSocket: client });
      }
      const roomDO = env.CHESS_ROOM.idFromName(roomId);
      const roomStub = env.CHESS_ROOM.get(roomDO);
      return roomStub.fetch(request);
    }
    if (env.ASSETS) {
      if (path === "/" || path.endsWith(".html")) {
        const assetReq = new Request(request.url.replace(/\/[^\/]*$/, "/index.html"), request);
        const assetResp = await env.ASSETS.fetch(assetReq);
        const body = await assetResp.text();
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
          }
        });
      }
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
async function handleWebSocket(ws, env) {
  onlineCount++;
  activeConnections.add(ws);
  ws.send(JSON.stringify({ event: "online_count", data: onlineCount }));
  broadcastOnlineCount();
  let socketData = { roomId: null, color: null, spectator: false };
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      const eventName = data.event || data[0];
      const payload = data.payload || data[1];
      if (eventName === "create_room") {
        let lastColor = null;
        let requestedRoomId = null;
        if (payload && typeof payload === "object") {
          requestedRoomId = payload.roomId;
          lastColor = payload.lastColor;
        } else {
          requestedRoomId = payload;
        }
        const roomId = requestedRoomId || Math.random().toString(36).slice(2, 8).toUpperCase();
        ws.send(JSON.stringify({ event: "redirect_room", data: { roomId, action: "create", lastColor } }));
      } else if (eventName === "ping") {
        try {
          ws.send(JSON.stringify({ event: "pong" }));
        } catch (e) {
        }
      } else if (eventName === "join_room") {
        const roomId = payload;
        ws.send(JSON.stringify({ event: "redirect_room", data: { roomId, action: "join" } }));
      } else if (eventName === "reconnect_room") {
        const roomId = payload.roomId;
        if (!roomId) return;
        ws.send(JSON.stringify({ event: "redirect_room", data: { roomId, action: "reconnect", color: payload.color } }));
      }
    } catch (e) {
      console.error("WebSocket message error:", e);
    }
  };
  ws.onclose = () => {
    onlineCount--;
    activeConnections.delete(ws);
    broadcastOnlineCount();
  };
  ws.onerror = () => {
    onlineCount--;
    activeConnections.delete(ws);
    broadcastOnlineCount();
  };
}
__name(handleWebSocket, "handleWebSocket");
export {
  ChessRoom,
  index_default as default
};
//# sourceMappingURL=index.js.map
