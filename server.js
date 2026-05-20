const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Matchmaking State ───────────────────────────────────────────────────────
const waitingQueue = []; // { socketId, name }
const activePairs = new Map(); // socketId → partnerSocketId
const userNames = new Map(); // socketId → name
const onlineCount = { value: 0 };

function broadcastOnlineCount() {
  io.emit('online_count', onlineCount.value);
}

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const userA = waitingQueue.shift();
    const userB = waitingQueue.shift();

    // Make sure both are still connected
    const socketA = io.sockets.sockets.get(userA.socketId);
    const socketB = io.sockets.sockets.get(userB.socketId);

    if (!socketA || !socketB) {
      // Re-queue the valid one
      if (socketA) waitingQueue.unshift(userA);
      if (socketB) waitingQueue.unshift(userB);
      continue;
    }

    activePairs.set(userA.socketId, userB.socketId);
    activePairs.set(userB.socketId, userA.socketId);

    // userA initiates (creates offer)
    socketA.emit('matched', {
      partnerName: userB.name,
      initiator: true
    });
    socketB.emit('matched', {
      partnerName: userA.name,
      initiator: false
    });

    console.log(`[MATCH] ${userA.name} ↔ ${userB.name}`);
  }
}

// ─── Socket Events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount.value++;
  broadcastOnlineCount();
  console.log(`[CONNECT] ${socket.id} | Online: ${onlineCount.value}`);

  // User registers name and enters queue
  socket.on('join_queue', ({ name }) => {
    const safeName = String(name).trim().slice(0, 24) || 'Stranger';
    userNames.set(socket.id, safeName);

    // Remove from any existing state
    const existingIdx = waitingQueue.findIndex(u => u.socketId === socket.id);
    if (existingIdx !== -1) waitingQueue.splice(existingIdx, 1);

    waitingQueue.push({ socketId: socket.id, name: safeName });
    socket.emit('waiting');
    console.log(`[QUEUE] ${safeName} waiting | Queue: ${waitingQueue.length}`);
    tryMatch();
  });

  // WebRTC signaling relay
  socket.on('webrtc_offer', ({ offer }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_offer', { offer });
    }
  });

  socket.on('webrtc_answer', ({ answer }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_answer', { answer });
    }
  });

  socket.on('webrtc_ice', ({ candidate }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_ice', { candidate });
    }
  });

  // Chat messages
  socket.on('chat_message', ({ text }) => {
    const partnerId = activePairs.get(socket.id);
    const senderName = userNames.get(socket.id) || 'Stranger';
    if (partnerId && text && String(text).trim().length > 0) {
      const safeText = String(text).trim().slice(0, 500);
      io.to(partnerId).emit('chat_message', {
        from: senderName,
        text: safeText,
        timestamp: Date.now()
      });
    }
  });

  // Skip / disconnect from current partner
  socket.on('skip', () => {
    handleDisconnectFromPair(socket, true);
  });

  socket.on('disconnect', () => {
    onlineCount.value = Math.max(0, onlineCount.value - 1);
    broadcastOnlineCount();
    handleDisconnectFromPair(socket, false);
    userNames.delete(socket.id);
    console.log(`[DISCONNECT] ${socket.id} | Online: ${onlineCount.value}`);
  });
});

function handleDisconnectFromPair(socket, requeue) {
  const partnerId = activePairs.get(socket.id);
  if (partnerId) {
    activePairs.delete(socket.id);
    activePairs.delete(partnerId);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('partner_left');
    }
  }

  // Remove from waiting queue
  const idx = waitingQueue.findIndex(u => u.socketId === socket.id);
  if (idx !== -1) waitingQueue.splice(idx, 1);

  if (requeue) {
    const name = userNames.get(socket.id) || 'Stranger';
    waitingQueue.push({ socketId: socket.id, name });
    socket.emit('waiting');
    tryMatch();
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  CHAT-RIX SERVER  :${PORT}     ║`);
  console.log(`╚══════════════════════════════╝\n`);
});
