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

app.use(express.static('public'));

// --- CONFIGURATION ---
const APP_NAME = "BlastFlow";
const SESSION_ID = "blastflow_session";

// Initialize Client
let client;

function initializeClient() {
    console.log("Initializing WhatsApp Client...");
    
    client = new Client({
        authStrategy: new LocalAuth({ clientId: SESSION_ID }),
        puppeteer: { 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu']
        }
    });

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            io.emit('qr', url);
            io.emit('log', 'Please Scan QR Code to Login.');
            io.emit('status', 'scan');
        });
    });

    client.on('ready', () => {
        io.emit('ready', `${APP_NAME} Ready!`);
        io.emit('log', `✅ ${APP_NAME} Connected!`);
        io.emit('status', 'ready');
    });

    client.on('authenticated', () => {
        io.emit('log', 'Authenticated successfully...');
    });

    client.on('auth_failure', () => {
        io.emit('log', '❌ Login Failed. Restarting...');
        resetClient();
    });

    client.on('disconnected', () => {
        io.emit('log', '⚠️ WhatsApp Disconnected.');
        io.emit('status', 'scan');
    });

    client.initialize();
}

// Helper: Reset / Logout Function
async function resetClient(deleteSession = false) {
    io.emit('log', '🔄 Resetting Session...');
    io.emit('status', 'reset');

    try {
        if(client) await client.destroy();
        
        if (deleteSession) {
            // Hapus folder Auth agar benar-benar Logout
            const authPath = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log("Session folder deleted.");
            }
        }
        
        // Re-initialize
        initializeClient();
    } catch (e) {
        console.error("Reset Error:", e);
    }
}

// Start First Time
initializeClient();

// --- SOCKET IO LOGIC ---
io.on('connection', (socket) => {
    // Check status on connect
    if(client && client.info) {
        socket.emit('ready', `${APP_NAME} Ready!`);
        socket.emit('status', 'ready');
    } else {
        socket.emit('status', 'scan');
    }

    // EVENT: MANUAL LOGOUT
    socket.on('logout', async () => {
        console.log("User requested manual logout.");
        await resetClient(true); // True = Hapus sesi file
    });

    // EVENT: SEND MESSAGES
    socket.on('blast', async (data) => {
        const { targets } = data;
        io.emit('log', `🚀 Starting blast to ${targets.length} contacts...`);
        
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const { id, nama, nomor, pesan } = target;

            let formattedNomor = nomor.replace(/\D/g, '');
            if (formattedNomor.startsWith('0')) formattedNomor = '62' + formattedNomor.slice(1);
            const chatId = formattedNomor + '@c.us';

            let finalMessage = pesan.replace(/\[Name\]/gi, nama);
            finalMessage = finalMessage.replace(/\[enter\]/g, "\n"); 

            try {
                await client.sendMessage(chatId, finalMessage);
                io.emit('sent_success', { id: id, nama: nama });
                io.emit('log', `✅ Sent to ${nama} (${formattedNomor})`);
            } catch (err) {
                io.emit('log', `❌ Failed to ${nama}: ${err.message}`);
            }

            const delay = Math.floor(Math.random() * 4000) + 3000; 
            if (i < targets.length - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        }

        io.emit('log', '🎉 Finished! All tasks processed.');
        io.emit('finished', true);
    });
});

// --- SCHEDULE DAILY RESET AT 00:00 ---
function scheduleMidnightReset() {
    const now = new Date();
    const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1, // Besok
        0, 0, 0 // Jam 00:00:00
    );
    
    const msToMidnight = night.getTime() - now.getTime();
    
    console.log(`⏱️ Auto-Reset scheduled in ${Math.floor(msToMidnight/1000/60)} minutes (at 00:00).`);

    setTimeout(() => {
        console.log('🕛 Midnight! Performing Auto-Reset...');
        resetClient(true); // Force Logout & New QR
        
        // Set interval 24 jam setelah reset pertama
        setInterval(() => {
            console.log('🕛 Daily Reset...');
            resetClient(true);
        }, 24 * 60 * 60 * 1000);
        
    }, msToMidnight);
}

scheduleMidnightReset();

server.listen(3000, () => {
    console.log(`Server ${APP_NAME} running at http://localhost:3000`);
});