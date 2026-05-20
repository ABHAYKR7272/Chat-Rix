/* ═══════════════════════════════════════════════════════
   CHAT-RIX — MAIN APP JS
   WebRTC P2P Video + Socket.io Signaling
   ═══════════════════════════════════════════════════════ */

'use strict';

// ─── CONFIG ──────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// ─── STATE ───────────────────────────────────────────────
let socket = null;
let localStream = null;
let peerConnection = null;
let myName = '';
let isMuted = false;
let isCamOff = false;
let isConnectedToPeer = false;

// ─── DOM REFS ─────────────────────────────────────────────
const screens = {
  landing: document.getElementById('screen-landing'),
  waiting: document.getElementById('screen-waiting'),
  chat:    document.getElementById('screen-chat')
};

const $ = id => document.getElementById(id);

const nameInput        = $('name-input');
const btnStart         = $('btn-start');
const btnCancelWait    = $('btn-cancel-wait');
const btnMute          = $('btn-mute');
const btnVideoToggle   = $('btn-video-toggle');
const btnSkip          = $('btn-skip');
const btnEnd           = $('btn-end');
const btnSend          = $('btn-send');
const chatInput        = $('chat-input');
const messagesContainer= $('messages-container');
const localVideo       = $('localVideo');
const remoteVideo      = $('remoteVideo');
const remoteStatus     = $('remote-status');
const partnerNameDisplay = $('partner-name-display');
const modalLeft        = $('modal-left');
const modalNext        = $('modal-next');
const modalHome        = $('modal-home');
const toastEl          = $('toast');
const onlineCountEls   = {
  landing: $('online-count-landing'),
  wait:    $('online-count-wait'),
  chat:    $('online-count-chat')
};

// ─── SCREEN MANAGER ──────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.remove('active', 'fade-in');
    el.style.display = 'none';
  });
  const target = screens[name];
  target.style.display = 'flex';
  requestAnimationFrame(() => {
    target.classList.add('active', 'fade-in');
  });
}

// ─── TOAST ────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ─── PARTICLES ────────────────────────────────────────────
(function initParticles() {
  const canvas = $('particleCanvas');
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  const COLORS = ['#00ffff','#ff00aa','#00ff88','#ffffff'];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function randomParticle() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.2 + 0.3,
      dx: (Math.random() - 0.5) * 0.35,
      dy: (Math.random() - 0.5) * 0.35,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: Math.random() * 0.4 + 0.1
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: 90 }, randomParticle);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
      ctx.globalAlpha = 1;

      p.x += p.dx; p.y += p.dy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
    });

    // Draw connecting lines between nearby particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = 'rgba(0,255,255,' + (0.06 * (1 - dist / 100)) + ')';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();

// ─── MEDIA ───────────────────────────────────────────────
async function getLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    localVideo.srcObject = localStream;
    return true;
  } catch (err) {
    console.warn('[MEDIA] Camera/mic error:', err.name);
    // Try audio only
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localVideo.srcObject = null;
      showToast('⚠ Camera unavailable — audio only');
      return true;
    } catch (e) {
      showToast('⚠ No media access — text only');
      localStream = null;
      return true; // Still allow text chat
    }
  }
}

function stopLocalMedia() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
}

// ─── WEBRTC ──────────────────────────────────────────────
function createPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Remote stream
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteStatus.classList.add('hidden');
    }
  };

  // ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc_ice', { candidate: event.candidate });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('[WebRTC] Connection state:', state);
    if (state === 'connected') {
      remoteStatus.classList.add('hidden');
      isConnectedToPeer = true;
    } else if (state === 'failed' || state === 'disconnected') {
      remoteStatus.textContent = 'Connection lost...';
      remoteStatus.classList.remove('hidden');
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection.iceConnectionState === 'connected') {
      remoteStatus.classList.add('hidden');
    }
  };

  return peerConnection;
}

async function startCall(initiator) {
  createPeerConnection();

  if (initiator) {
    try {
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc_offer', { offer });
    } catch (err) {
      console.error('[WebRTC] Offer error:', err);
    }
  }
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  remoteStatus.textContent = 'Connecting...';
  remoteStatus.classList.remove('hidden');
  isConnectedToPeer = false;
}

// ─── SOCKET.IO ───────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('[SOCKET] Connected:', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('[SOCKET] Disconnected');
    showToast('⚠ Server connection lost');
  });

  socket.on('online_count', (count) => {
    Object.values(onlineCountEls).forEach(el => {
      if (el) el.textContent = count;
    });
  });

  socket.on('waiting', () => {
    console.log('[SOCKET] In queue');
  });

  socket.on('matched', async ({ partnerName, initiator }) => {
    console.log('[SOCKET] Matched with:', partnerName, '| Initiator:', initiator);
    partnerNameDisplay.textContent = partnerName.toUpperCase();
    clearMessages();
    addSysMessage(`Connected to ${partnerName}. Say hello!`);
    showScreen('chat');
    await startCall(initiator);
  });

  socket.on('webrtc_offer', async ({ offer }) => {
    if (!peerConnection) createPeerConnection();
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc_answer', { answer });
    } catch (err) {
      console.error('[WebRTC] Answer error:', err);
    }
  });

  socket.on('webrtc_answer', async ({ answer }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error('[WebRTC] Set answer error:', err);
    }
  });

  socket.on('webrtc_ice', async ({ candidate }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] ICE error:', err);
    }
  });

  socket.on('chat_message', ({ from, text, timestamp }) => {
    addMessage(text, 'received', from);
  });

  socket.on('partner_left', () => {
    closePeerConnection();
    addSysMessage('Stranger has disconnected.');
    showModal();
  });
}

// ─── CHAT MESSAGES ───────────────────────────────────────
function clearMessages() {
  messagesContainer.innerHTML = '';
}

function addSysMessage(text) {
  const div = document.createElement('div');
  div.className = 'sys-msg';
  div.textContent = text;
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function addMessage(text, type, from) {
  const wrap = document.createElement('div');
  wrap.className = `msg-bubble ${type}`;

  if (from && type === 'received') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = from;
    wrap.appendChild(meta);
  }

  const body = document.createElement('div');
  body.textContent = text;
  wrap.appendChild(body);

  messagesContainer.appendChild(wrap);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Animate
  wrap.style.opacity = '0';
  wrap.style.transform = type === 'sent' ? 'translateX(10px)' : 'translateX(-10px)';
  requestAnimationFrame(() => {
    wrap.style.transition = 'opacity 0.2s, transform 0.2s';
    wrap.style.opacity = '1';
    wrap.style.transform = 'none';
  });
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!socket || !socket.connected) { showToast('Not connected'); return; }
  socket.emit('chat_message', { text });
  addMessage(text, 'sent', null);
  chatInput.value = '';
}

// ─── MODAL ───────────────────────────────────────────────
function showModal() {
  modalLeft.style.display = 'flex';
}
function hideModal() {
  modalLeft.style.display = 'none';
}

// ─── CONTROLS ────────────────────────────────────────────
function toggleMute() {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }
  btnMute.classList.toggle('active', isMuted);
  btnMute.querySelector('.icon-unmuted').style.display = isMuted ? 'none' : 'block';
  btnMute.querySelector('.icon-muted').style.display   = isMuted ? 'block' : 'none';
  showToast(isMuted ? '🎤 Mic muted' : '🎤 Mic on');
}

function toggleCamera() {
  isCamOff = !isCamOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  }
  btnVideoToggle.classList.toggle('active', isCamOff);
  btnVideoToggle.querySelector('.icon-cam-on').style.display  = isCamOff ? 'none' : 'block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display = isCamOff ? 'block' : 'none';
  showToast(isCamOff ? '📷 Camera off' : '📷 Camera on');
}

function skipStranger() {
  closePeerConnection();
  addSysMessage('Searching for next stranger...');
  socket.emit('skip');
  showScreen('waiting');
}

function endSession() {
  closePeerConnection();
  stopLocalMedia();
  if (socket) socket.disconnect();
  socket = null;
  isMuted = false; isCamOff = false;
  // Reset button states
  btnMute.classList.remove('active');
  btnMute.querySelector('.icon-unmuted').style.display = 'block';
  btnMute.querySelector('.icon-muted').style.display   = 'none';
  btnVideoToggle.classList.remove('active');
  btnVideoToggle.querySelector('.icon-cam-on').style.display  = 'block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display = 'none';
  showScreen('landing');
}

// ─── START FLOW ──────────────────────────────────────────
async function startApp() {
  const rawName = nameInput.value.trim();
  myName = rawName.length > 0 ? rawName.slice(0, 24) : 'Stranger';

  showScreen('waiting');

  // Get media first
  await getLocalMedia();

  // Init socket after media
  if (!socket || !socket.connected) {
    initSocket();
    // Wait for socket to connect then join queue
    socket.on('connect', () => {
      socket.emit('join_queue', { name: myName });
    });
    // If already connected (race condition), emit immediately
    if (socket.connected) {
      socket.emit('join_queue', { name: myName });
    }
  } else {
    socket.emit('join_queue', { name: myName });
  }
}

// ─── EVENT LISTENERS ─────────────────────────────────────
btnStart.addEventListener('click', startApp);

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startApp();
});

btnCancelWait.addEventListener('click', () => {
  endSession();
  showScreen('landing');
});

btnMute.addEventListener('click', toggleMute);
btnVideoToggle.addEventListener('click', toggleCamera);
btnSkip.addEventListener('click', skipStranger);
btnEnd.addEventListener('click', endSession);

btnSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

modalNext.addEventListener('click', () => {
  hideModal();
  closePeerConnection();
  showScreen('waiting');
  if (socket && socket.connected) {
    socket.emit('join_queue', { name: myName });
  } else {
    initSocket();
    socket.on('connect', () => socket.emit('join_queue', { name: myName }));
  }
});

modalHome.addEventListener('click', () => {
  hideModal();
  endSession();
});

// Prevent accidental back navigation
window.addEventListener('popstate', (e) => { e.preventDefault(); });

// ─── INIT ────────────────────────────────────────────────
showScreen('landing');
