const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Mengizinkan akses dari domain mana pun (penting untuk cloud)
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// --- CONFIGURATION ---
const APP_NAME = "BlastFlow";
const SESSION_ID = "blastflow_session";

// --- STATE MANAGEMENT SISTEM ---
let sessionConfig = {
    isInitialized: false,
    mode: null,
    password: null,
    connectedUsers: []
};

let client = null; 
let isResetting = false; 

/**
 * Inisialisasi Engine WhatsApp Web dengan Optimasi Render/Cloud
 */
function initializeClient() {
    console.log("System: Memulai Inisialisasi WhatsApp Engine di Cloud...");
    
    if (client) {
        try { client.removeAllListeners(); } catch (e) {}
    }

    client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: SESSION_ID,
            dataPath: './.wwebjs_auth' // Pastikan path eksplisit
        }),
        puppeteer: { 
            headless: true,
            // ARGUMEN WAJIB UNTUK DEPLOY DI RENDER/HEROKU/LINUX
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', 
                '--no-first-run', 
                '--no-zygote',
                '--disable-gpu',
                // --- PENGHEMAT MEMORI UNTUK RENDER (MENCEGAH STUCK LOGGING IN) ---
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--js-flags="--max-old-space-size=400"' // Membatasi RAM V8 Engine maks ~400MB
            ],
            // Jika Render lambat menjalankan Chromium, tambahkan timeout
            handleSIGINT: false,
        }
    });

    const emitToAuthenticated = (event, data) => {
        io.fetchSockets().then(sockets => {
            sockets.forEach(socket => {
                if (socket.data.authenticated) socket.emit(event, data);
            });
        });
    };

    client.on('qr', (qr) => {
        console.log("System: QR Code diterima, mengirim ke frontend...");
        qrcode.toDataURL(qr, (err, url) => {
            emitToAuthenticated('qr', url);
            emitToAuthenticated('status', 'scan');
            // Log ke semua user (bahkan yang belum auth app) untuk debug awal jika perlu
            io.emit('log', 'System: QR Code siap di-scan.');
        });
    });

    client.on('ready', () => {
        console.log("System: WhatsApp Ready!");
        emitToAuthenticated('log', `✅ System: WhatsApp Connected!`);
        emitToAuthenticated('status', 'ready');
    });

    client.on('authenticated', () => {
        console.log("System: Authenticated!");
        emitToAuthenticated('status', 'authenticated');
    });

    client.on('auth_failure', (msg) => {
        console.error("System: Auth Failure:", msg);
        emitToAuthenticated('log', '❌ Sesi gagal. Menghapus cache dan mencoba lagi...');
        resetClient(null, true); // Hapus sesi jika gagal total
    });

    client.on('disconnected', (reason) => {
        console.log("System: WhatsApp Disconnected:", reason);
        emitToAuthenticated('log', '⚠️ WhatsApp Terputus.');
        emitToAuthenticated('status', 'scan');
    });

    client.initialize().catch(err => {
        console.error("System: Gagal Initialize:", err.message);
        // Jangan resetClient di sini agar tidak looping reload
    });
}

/**
 * Fungsi Reset Total
 */
async function resetClient(triggerUser = null, deleteSession = false) {
    if (isResetting) return;
    isResetting = true;

    if (sessionConfig.isInitialized) {
        io.emit('force_reload'); 
    }

    sessionConfig = { isInitialized: false, mode: null, password: null, connectedUsers: [] };

    try {
        if(client) {
            try { await client.destroy(); } catch (err) {}
            client = null; 
        }
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (deleteSession) {
            const authPath = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(authPath)) {
                try { 
                    fs.rmSync(authPath, { recursive: true, force: true }); 
                    console.log("System: Cache sesi dihapus.");
                } catch (err) {}
            }
        }
        
        isResetting = false;
        initializeClient();
    } catch (e) {
        isResetting = false; 
    }
}

initializeClient();

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    socket.data.authenticated = false;

    socket.on('check_session_status', () => {
        socket.emit('session_status', {
            isInitialized: sessionConfig.isInitialized,
            mode: sessionConfig.mode
        });
    });

    socket.on('create_session', (data) => {
        if (sessionConfig.isInitialized) return;
        sessionConfig.isInitialized = true;
        sessionConfig.mode = data.mode;
        sessionConfig.password = data.password;
        loginSocket(socket, data.username);
        socket.broadcast.emit('session_created', { mode: data.mode });
    });

    socket.on('login_session', (data) => {
        if (sessionConfig.mode === 'team') {
            sessionConfig.connectedUsers = sessionConfig.connectedUsers.filter(id => io.sockets.sockets.has(id));
            if (sessionConfig.connectedUsers.length >= 3) {
                return socket.emit('login_result', { success: false, message: 'Ruang penuh.' });
            }
        }
        if (data.password === sessionConfig.password) loginSocket(socket, data.username);
        else socket.emit('login_result', { success: false, message: 'Password salah!' });
    });

    function loginSocket(sock, user) {
        sock.data.authenticated = true;
        sock.data.username = user;
        if (!sessionConfig.connectedUsers.includes(sock.id)) sessionConfig.connectedUsers.push(sock.id);
        sock.emit('login_result', { success: true, username: user, mode: sessionConfig.mode });
        
        if(client && client.info) sock.emit('status', 'ready');
        else sock.emit('status', 'scan');
    }

    socket.on('logout', async () => {
        if(!socket.data.authenticated) return;
        await resetClient(socket.data.username, true); 
    });

    socket.on('blast', async (data) => {
        if(!socket.data.authenticated) return;
        const { targets } = data;
        const sender = socket.data.username;
        const emitLog = (msg) => io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('log', msg) }));

        emitLog(`🚀 ${sender}: Memulai pengiriman...`);
        
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            let num = t.nomor.replace(/\D/g, '');
            if (num.startsWith('0')) num = '62' + num.slice(1);
            const chatId = num + '@c.us';

            let msg = t.pesan.replace(/\[Name\]/gi, t.nama).replace(/\[Address\]/gi, t.alamat || "").replace(/\[enter\]/g, "\n"); 

            try {
                if (client) {
                    await client.sendMessage(chatId, msg);
                    io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('sent_success', { id: t.id }); }));
                    emitLog(`✅ Terkirim ke: ${t.nama}`);
                }
            } catch (err) { emitLog(`❌ Gagal ke ${t.nama}: ${err.message}`); }

            if (i < targets.length - 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 4000) + 3000));
        }
        emitLog(`🎉 ${sender}: Selesai.`);
        socket.emit('finished', true);
    });

    socket.on('disconnect', () => {
        sessionConfig.connectedUsers = sessionConfig.connectedUsers.filter(id => id !== socket.id);
    });
});

function scheduleMidnightReset() {
    const now = new Date();
    const night = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const msToMidnight = night.getTime() - now.getTime();
    setTimeout(() => {
        resetClient('Auto-Scheduler', true); 
        setInterval(() => resetClient('Auto-Scheduler', true), 24 * 60 * 60 * 1000);
    }, msToMidnight);
}
scheduleMidnightReset();

// --- PERBAIKAN PORT UNTUK RENDER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ${APP_NAME} berjalan di port ${PORT}`);
});