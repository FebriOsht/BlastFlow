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
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

// --- CONFIGURATION ---
const APP_NAME = "BlastFlow";

// [BLUEPRINT UNTUK SAAS/DIJUAL]
// Jika Anda menjadikan ini SaaS multi-user, SESSION_ID tidak boleh statis.
// Harus dibuat dinamis berdasarkan ID User di Database (misal: "session_" + userId).
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
 * Menangkap Error Global agar server tidak mati diam-diam
 */
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught Exception):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
});

/**
 * Inisialisasi Engine WhatsApp Web
 * [BLUEPRINT UNTUK SAAS] Ubah fungsi ini menerima parameter `userId` untuk multi-device
 */
function initializeClient() {
    console.log("System: Memulai Inisialisasi WhatsApp Engine...");
    
    if (client) {
        try { client.removeAllListeners(); } catch (e) {}
    }

    // KONFIGURASI EKSTENSI CHROME (Diatur via Environment Variables)
    // Jangan aktifkan USE_EXTENSIONS="true" jika masih pakai Render Gratisan (512MB RAM)!
    const useExtensions = process.env.USE_EXTENSIONS === "true";
    const extensionPath = process.env.EXTENSION_PATH || ""; // Contoh: "/path/to/extension"

    let puppeteerArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', 
        '--no-first-run', 
        '--no-zygote',
        '--disable-gpu',
        '--disable-features=site-per-process', 
        '--disable-software-rasterizer',
        '--mute-audio'
    ];

    // Jika fitur extensions dimatikan (mode hemat RAM - default cloud)
    if (!useExtensions) {
        puppeteerArgs.push('--disable-extensions');
    } else if (extensionPath) {
        // Jika fitur extensions dinyalakan dan path tersedia (untuk server VPS/Desktop)
        puppeteerArgs.push(`--disable-extensions-except=${extensionPath}`);
        puppeteerArgs.push(`--load-extension=${extensionPath}`);
        console.log(`System: 🧩 Mode Extensions Aktif memuat dari: ${extensionPath}`);
    }

    client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: SESSION_ID,
            dataPath: './.wwebjs_auth' 
        }),
        puppeteer: { 
            // Beberapa ekstensi butuh headless: false (atau 'new') agar bisa jalan
            headless: useExtensions ? 'new' : true,
            args: puppeteerArgs,
            handleSIGINT: false,
            timeout: 120000, 
            protocolTimeout: 300000 
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
            io.emit('log', 'System: QR Code siap di-scan.');
        });
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`System: WA Loading ${percent}% - ${message}`);
        emitToAuthenticated('log', `⏳ Sinkronisasi Data WA: ${percent}%`);
        io.emit('auth_progress', { percent, message });
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
        resetClient(null, true); 
    });

    client.on('disconnected', (reason) => {
        console.log("System: WhatsApp Disconnected:", reason);
        emitToAuthenticated('log', '⚠️ WhatsApp Terputus.');
        emitToAuthenticated('status', 'scan');
    });

    client.initialize().catch(err => {
        console.error("System: Gagal Initialize:", err.message);
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
                    const isRegistered = await client.isRegisteredUser(chatId);
                    
                    if (isRegistered) {
                        await client.sendMessage(chatId, msg);
                        io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('sent_success', { id: t.id }); }));
                        emitLog(`✅ Terkirim ke: ${t.nama}`);
                    } else {
                        emitLog(`❌ Gagal ke ${t.nama}: Nomor tidak terdaftar di WA`);
                        io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('sent_failed', { id: t.id, reason: 'Not Registered' }); }));
                    }
                }
            } catch (err) { 
                emitLog(`❌ Gagal ke ${t.nama}: ${err.message}`); 
                io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('sent_failed', { id: t.id, reason: 'Error' }); }));
            }

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ${APP_NAME} berjalan di port ${PORT}`);
    
    // Tunda jalannya Chromium selama 2 detik agar platform cloud mengenali port sudah terbuka
    setTimeout(() => {
        initializeClient();
    }, 2000);
});