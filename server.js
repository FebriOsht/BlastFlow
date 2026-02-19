const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware untuk file statis di folder 'public'
app.use(express.static('public'));

// --- CONFIGURATION ---
const APP_NAME = "BlastFlow";
const SESSION_ID = "blastflow_session";

// --- STATE MANAGEMENT SISTEM ---
let sessionConfig = {
    isInitialized: false, // Menandai apakah sesi harian sudah dimulai/disetup
    mode: null,           // 'individual' atau 'team'
    password: null,       // Password yang dibuat oleh user pertama
    connectedUsers: []    // Array Socket ID untuk pembatasan (limit)
};

let client = null; 
let isResetting = false; 

/**
 * Inisialisasi Engine WhatsApp Web
 */
function initializeClient() {
    console.log("System: Memulai Inisialisasi WhatsApp Engine...");
    
    if (client) {
        try { client.removeAllListeners(); } catch (e) {}
    }

    client = new Client({
        authStrategy: new LocalAuth({ clientId: SESSION_ID }),
        puppeteer: { 
            headless: true,
            // ARGUMEN WAJIB UNTUK DEPLOY DI RENDER/LINUX (Mencegah Crash)
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', 
                '--no-first-run', 
                '--no-zygote',
                '--single-process', 
                '--disable-gpu'
            ]
        }
    });

    /**
     * Helper: Kirim event hanya ke client yang sudah login di aplikasi
     */
    const emitToAuthenticated = (event, data) => {
        io.fetchSockets().then(sockets => {
            sockets.forEach(socket => {
                if (socket.data.authenticated) socket.emit(event, data);
            });
        });
    };

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            emitToAuthenticated('qr', url);
            emitToAuthenticated('log', 'System: Menunggu Scan QR Code...');
            emitToAuthenticated('status', 'scan');
        });
    });

    client.on('ready', () => {
        emitToAuthenticated('log', `✅ WhatsApp Connected! Ready to blast.`);
        emitToAuthenticated('status', 'ready');
    });

    client.on('authenticated', () => {
        emitToAuthenticated('status', 'authenticated');
    });

    client.on('auth_failure', () => {
        emitToAuthenticated('log', '❌ Sesi kadaluarsa/gagal. Silakan scan ulang.');
        // Hanya panggil initialize tanpa menghapus data sesi fisik agar tidak loop
        setTimeout(() => initializeClient(), 5000);
    });

    client.on('disconnected', () => {
        emitToAuthenticated('log', '⚠️ WhatsApp Terputus.');
        emitToAuthenticated('status', 'scan');
    });

    client.initialize().catch(err => {
        console.error("Init Catch Error:", err.message);
        // JANGAN panggil resetClient/force_reload di sini untuk mencegah looping reload browser
    });
}

/**
 * Fungsi Reset Total: Menghapus Sesi WA dan Sesi Aplikasi
 */
async function resetClient(triggerUser = null, deleteSession = false) {
    if (isResetting) return;
    isResetting = true;

    // Paksa reload browser HANYA saat aksi reset manual/terjadwal dilakukan
    io.emit('force_reload'); 

    // Reset State Sesi Aplikasi
    sessionConfig = {
        isInitialized: false,
        mode: null,
        password: null,
        connectedUsers: []
    };

    try {
        if(client) {
            try { await client.destroy(); } catch (err) {}
            client = null; 
        }
        
        // Jeda agar proses browser benar-benar mati
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (deleteSession) {
            const authPath = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(authPath)) {
                try { 
                    fs.rmSync(authPath, { recursive: true, force: true }); 
                    console.log("System: Session folders deleted.");
                } catch (err) {
                    console.error("Pembersihan file gagal, sedang digunakan sistem.");
                }
            }
        }
        
        isResetting = false;
        initializeClient();
    } catch (e) {
        console.error("Reset Error:", e);
        isResetting = false; 
    }
}

// Start Engine pertama kali
initializeClient();

// --- SOCKET.IO COMMUNICATION ---
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
                return socket.emit('login_result', { success: false, message: 'Ruang penuh (Maksimal 3 User).' });
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
        console.log(`User ${socket.data.username} melakukan Reset System.`);
        await resetClient(socket.data.username, true); 
    });

    socket.on('blast', async (data) => {
        if(!socket.data.authenticated) return;
        const { targets } = data;
        const sender = socket.data.username;
        const emitLog = (msg) => io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('log', msg) }));

        emitLog(`🚀 ${sender}: Menjalankan pengiriman ke ${targets.length} target...`);
        
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            let num = t.nomor.replace(/\D/g, '');
            if (num.startsWith('0')) num = '62' + num.slice(1);
            const chatId = num + '@c.us';

            let msg = t.pesan.replace(/\[Name\]/gi, t.nama);
            msg = msg.replace(/\[Address\]/gi, t.alamat || "");
            msg = msg.replace(/\[enter\]/g, "\n"); 

            try {
                if (client) {
                    await client.sendMessage(chatId, msg);
                    io.fetchSockets().then(s => s.forEach(so => { 
                        if(so.data.authenticated) so.emit('sent_success', { id: t.id });
                    }));
                    emitLog(`✅ Terkirim ke: ${t.nama}`);
                }
            } catch (err) { emitLog(`❌ Gagal ke ${t.nama}: ${err.message}`); }

            if (i < targets.length - 1) {
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 4000) + 3000));
            }
        }
        emitLog(`🎉 ${sender}: Pengiriman massal selesai.`);
        socket.emit('finished', true);
    });

    socket.on('disconnect', () => {
        sessionConfig.connectedUsers = sessionConfig.connectedUsers.filter(id => id !== socket.id);
    });
});

/**
 * Penjadwalan Reset Otomatis Pukul 00:00
 */
function scheduleMidnightReset() {
    const now = new Date();
    const night = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const msToMidnight = night.getTime() - now.getTime();
    
    setTimeout(() => {
        resetClient('Auto-Scheduler', true); 
        setInterval(() => {
            resetClient('Auto-Scheduler', true);
        }, 24 * 60 * 60 * 1000);
    }, msToMidnight);
}
scheduleMidnightReset();

server.listen(3000, () => console.log(`🚀 Server aktif di port 3000`));