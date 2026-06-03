import cors from "cors"
import express from "express"
import { createServer } from "http"
import { randomBytes } from "crypto"
import { WebSocketServer, WebSocket } from "ws"
import { IncomingMessage } from "http"

const app = express()
app.use(cors())
app.use(express.json())

const server = createServer(app)
const wss = new WebSocketServer({ server, path: "/ws" })

// ── Types ──────────────────────────────────────────────────────────────────

interface User {
  ws: WebSocket
  name: string
  socketId: string
  color: string
  emoji: string
}

const COLORS = ["#534AB7", "#1D9E75", "#E84D8A", "#F59E0B"]

// roomId → (socketId → User)
const rooms = new Map<string, Map<string, User>>()

// ── HTTP ───────────────────────────────────────────────────────────────────

app.post("/rooms", (req, res) => {
  const roomId = randomBytes(4).toString("hex")
  rooms.set(roomId, new Map())
  const host = req.get("host") ?? `localhost:${PORT}`
  const proto = req.get("x-forwarded-proto") ?? req.protocol
  res.json({ roomId, joinUrl: `${proto}://${host}/r/${roomId}` })
})

app.get("/r/:roomId", (req, res) => {
  const { roomId } = req.params
  if (!rooms.has(roomId)) {
    res.status(404).send("Room not found or expired.")
    return
  }
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Cursor Chat — Join Room</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #FAFAF7; display: flex;
      align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; max-width: 400px; padding: 2rem; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px;
      background: #534AB7; margin-right: 8px; }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 1rem 0 0.5rem; letter-spacing: -0.02em; }
    p { color: #5F5E5A; font-size: 14px; line-height: 1.6; }
    code { background: #EEEDFE; color: #26215C; padding: 2px 8px; border-radius: 4px;
      font-family: monospace; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div><span class="dot"></span><strong>cursor chat</strong></div>
    <h1>You've been invited to a session</h1>
    <p>Room code: <code>${roomId}</code></p>
    <p>Open the <strong>Cursor Chat</strong> extension, enter your name,
    click <em>Join existing</em>, and paste the code above.</p>
  </div>
</body>
</html>`)
})

app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }))

// ── WebSocket ──────────────────────────────────────────────────────────────

// Keep WebSocket connections alive on Render (drops idle sockets after ~60s)
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.ping()
  })
}, 25_000)

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const roomId = url.searchParams.get("room") ?? ""
  const name = url.searchParams.get("name") ?? "anon"
  const emoji = url.searchParams.get("emoji") ?? "🦊"

  if (!rooms.has(roomId)) {
    ws.close(4004, "Room not found")
    return
  }

  const room = rooms.get(roomId)!

  if (room.size >= 2) {
    ws.close(4005, "Room is full")
    return
  }

  const socketId = randomBytes(4).toString("hex")
  const color = COLORS[room.size % COLORS.length]
  const user: User = { ws, name, socketId, color, emoji }
  room.set(socketId, user)

  // Tell the new user their identity
  send(ws, { type: "connected", socketId, color })

  // Tell new user about everyone already in the room
  room.forEach((u, id) => {
    if (id !== socketId) {
      send(ws, { type: "presence:join", name: u.name, socketId: id, color: u.color, emoji: u.emoji })
    }
  })

  // Tell everyone else about the new user
  broadcast(room, socketId, { type: "presence:join", name, socketId, color, emoji })

  ws.on("message", (data) => {
    let msg: any
    try { msg = JSON.parse(data.toString()) } catch { return }

    // Directed messages (WebRTC) go to a specific user
    if (msg.to) {
      const target = room.get(msg.to)
      if (target?.ws.readyState === WebSocket.OPEN) {
        send(target.ws, { ...msg, from: socketId })
      }
    } else {
      // Broadcast to all others
      broadcast(room, socketId, { ...msg, from: socketId })
    }
  })

  ws.on("close", () => {
    room.delete(socketId)
    broadcast(room, socketId, { type: "presence:leave", socketId })
    if (room.size === 0) {
      setTimeout(() => {
        if (rooms.get(roomId)?.size === 0) rooms.delete(roomId)
      }, 60_000)
    }
  })
})

// ── Helpers ────────────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(room: Map<string, User>, excludeId: string, msg: object) {
  const data = JSON.stringify(msg)
  room.forEach((user, id) => {
    if (id !== excludeId && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(data)
    }
  })
}

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001)
server.listen(PORT, () => {
  console.log(`[cursor-chat] server ready on http://localhost:${PORT}`)
})
