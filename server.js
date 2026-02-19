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
let isResetting = false; // Flag untuk mencegah tabrakan proses reset

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
            // Argumen optimasi agar browser berjalan ringan dan stabil di VPS/PC
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--single-process', '--disable-gpu', '--disable-extensions', 
                '--mute-audio', '--no-default-browser-check'
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

    // Event: QR Code Muncul
    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            emitToAuthenticated('qr', url);
            emitToAuthenticated('log', 'System: Menunggu Scan QR Code...');
            emitToAuthenticated('status', 'scan');
        });
    });

    // Event: WhatsApp Siap Digunakan
    client.on('ready', () => {
        emitToAuthenticated('log', `✅ WhatsApp Connected! Ready to blast.`);
        emitToAuthenticated('status', 'ready');
    });

    // Event: Berhasil Authenticated (Scan Berhasil)
    client.on('authenticated', () => {
        emitToAuthenticated('log', 'System: Login berhasil, memproses dashboard...');
        emitToAuthenticated('status', 'authenticated');
    });

    // Event: Login Gagal
    client.on('auth_failure', () => {
        emitToAuthenticated('log', '❌ Login Gagal. Mencoba restart engine...');
        resetClient(null, false);
    });

    // Event: WhatsApp Terputus
    client.on('disconnected', () => {
        emitToAuthenticated('log', '⚠️ WhatsApp Terputus.');
        emitToAuthenticated('status', 'scan');
    });

    client.initialize().catch(err => {
        if (isResetting) return;
        console.error("Init Error:", err.message);
        setTimeout(() => resetClient(null, false), 10000);
    });
}

/**
 * Fungsi Reset Total: Menghapus Sesi WA dan Sesi Aplikasi
 */
async function resetClient(triggerUser = null, deleteSession = false) {
    if (isResetting) return;
    isResetting = true;

    // Reset State Sesi Aplikasi
    sessionConfig = {
        isInitialized: false,
        mode: null,
        password: null,
        connectedUsers: []
    };

    // Paksa semua browser reload ke halaman pemilihan mode
    io.emit('force_reload'); 

    try {
        if(client) {
            try { await client.destroy(); } catch (err) {}
            client = null; 
        }
        
        // Jeda agar proses Chrome benar-benar mati sebelum menghapus folder
        console.log("System: Menunggu pembersihan cache (5s)...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        if (deleteSession) {
            const authPath = path.join(__dirname, '.wwebjs_auth');
            const cachePath = path.join(__dirname, '.wwebjs_cache');
            
            const safeDelete = (p) => {
                if (fs.existsSync(p)) {
                    try { fs.rmSync(p, { recursive: true, force: true }); return true; } 
                    catch (err) { return false; }
                }
                return true;
            };

            safeDelete(authPath);
            safeDelete(cachePath);
            console.log("System: Session folders deleted.");
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
    socket.data.authenticated = false; // Status awal: Belum login aplikasi

    // 1. Cek apakah sesi sudah dibuat hari ini
    socket.on('check_session_status', () => {
        socket.emit('session_status', {
            isInitialized: sessionConfig.isInitialized,
            mode: sessionConfig.mode
        });
    });

    // 2. Setup Sesi Baru (Pendaftar pertama hari ini)
    socket.on('create_session', (data) => {
        if (sessionConfig.isInitialized) return;

        sessionConfig.isInitialized = true;
        sessionConfig.mode = data.mode;
        sessionConfig.password = data.password;
        
        loginSocket(socket, data.username);
        socket.broadcast.emit('session_created', { mode: data.mode });
    });

    // 3. Login ke Sesi yang sudah ada
    socket.on('login_session', (data) => {
        // Cek Limit untuk mode tim
        if (sessionConfig.mode === 'team') {
            sessionConfig.connectedUsers = sessionConfig.connectedUsers.filter(id => io.sockets.sockets.has(id));
            if (sessionConfig.connectedUsers.length >= 3) {
                return socket.emit('login_result', { success: false, message: 'Ruang penuh (Maksimal 3 User).' });
            }
        }

        if (data.password === sessionConfig.password) {
            loginSocket(socket, data.username);
        } else {
            socket.emit('login_result', { success: false, message: 'Password salah!' });
        }
    });

    // Helper: Login internal socket
    function loginSocket(sock, user) {
        sock.data.authenticated = true;
        sock.data.username = user;
        if (!sessionConfig.connectedUsers.includes(sock.id)) {
            sessionConfig.connectedUsers.push(sock.id);
        }
        sock.emit('login_result', { success: true, username: user, mode: sessionConfig.mode });
        
        // Kirim status WA terkini ke user yang baru login
        if(client && client.info) sock.emit('status', 'ready');
        else sock.emit('status', 'scan');
    }

    // EVENT: Logout/Reset Manual
    socket.on('logout', async () => {
        if(!socket.data.authenticated) return;
        console.log(`User ${socket.data.username} melakukan Reset System.`);
        await resetClient(socket.data.username, true); 
    });

    // EVENT: Proses Blast WhatsApp
    socket.on('blast', async (data) => {
        if(!socket.data.authenticated) return;
        const { targets } = data;
        const sender = socket.data.username;
        
        const emitLog = (msg) => {
             io.fetchSockets().then(s => s.forEach(so => { if(so.data.authenticated) so.emit('log', msg) }));
        }

        emitLog(`🚀 ${sender}: Menjalankan pengiriman ke ${targets.length} target...`);
        
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            let num = t.nomor.replace(/\D/g, '');
            if (num.startsWith('0')) num = '62' + num.slice(1);
            const chatId = num + '@c.us';

            // Logika Placeholder: Mengganti tag dengan data dari GMap Scout
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
            } catch (err) {
                emitLog(`❌ Gagal ke ${t.nama}: ${err.message}`);
            }

            // Jeda acak (Human Simulation) 3-7 detik
            if (i < targets.length - 1) {
                const delay = Math.floor(Math.random() * 4000) + 3000;
                await new Promise(r => setTimeout(r, delay));
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
    
    console.log(`System: Auto-Reset dijadwalkan dalam ${Math.floor(msToMidnight/1000/60)} menit.`);

    setTimeout(() => {
        console.log('🕛 Midnight! Melakukan Auto-Reset System...');
        resetClient('Auto-Scheduler', true); 
        // Set interval harian setelah reset pertama
        setInterval(() => {
            console.log('🕛 Daily Reset...');
            resetClient('Auto-Scheduler', true);
        }, 24 * 60 * 60 * 1000);
    }, msToMidnight);
}
scheduleMidnightReset();

server.listen(3000, () => {
    console.log(`🚀 ${APP_NAME} Server aktif di http://localhost:3000`);
});