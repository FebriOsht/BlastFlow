const socket = io();
let rawData = []; 
let currentMode = 'broadcast'; 
let isConnected = false;
let selectedMode = null; // 'individual' or 'team'
let isLogPanelOpen = true; // Status toggle log panel

// --- TOAST NOTIFICATION ---
const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 3000,
    timerProgressBar: true,
    didOpen: (toast) => {
        toast.addEventListener('mouseenter', Swal.stopTimer)
        toast.addEventListener('mouseleave', Swal.resumeTimer)
    }
});

// ==========================================
// 0. INITIAL CHECK (STARTUP)
// ==========================================

socket.on('connect', () => {
    socket.emit('check_session_status');
});

socket.on('session_status', (data) => {
    document.getElementById('mode-selection-screen').classList.add('hidden');
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('login-form-screen').classList.add('hidden');
    document.getElementById('main-app').classList.add('hidden');
    document.getElementById('login-screen').classList.add('hidden');
    
    if (data.isInitialized) {
        document.getElementById('login-mode-badge').innerText = `Mode: ${data.mode === 'individual' ? 'Privacy (Individual)' : 'Team Collaboration'}`;
        document.getElementById('login-form-screen').classList.remove('hidden');
    } else {
        document.getElementById('mode-selection-screen').classList.remove('hidden');
    }
});

// ==========================================
// 1. SESSION SETUP FLOW (NEW SESSION)
// ==========================================

function selectMode(mode) {
    selectedMode = mode;
    document.getElementById('mode-selection-screen').classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
    
    const title = mode === 'individual' ? 'Privacy Setup' : 'Create Team Session';
    const desc = mode === 'individual' ? 'Set a password to lock your private session.' : 'Set a team password. Share it with your team (max 3 users).';
    document.getElementById('setup-title').innerText = title;
    document.getElementById('setup-desc').innerText = desc;
}

function backToSelection() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('mode-selection-screen').classList.remove('hidden');
}

function submitSetup(e) {
    e.preventDefault();
    const user = document.getElementById('setup-username').value;
    const pass = document.getElementById('setup-pass').value;
    
    if(!user || !pass) return;

    socket.emit('create_session', {
        mode: selectedMode,
        password: pass,
        username: user
    });
}

// ==========================================
// 2. SESSION LOGIN FLOW (EXISTING SESSION)
// ==========================================

function submitLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-username').value;
    const pass = document.getElementById('login-pass').value;
    
    socket.emit('login_session', {
        password: pass,
        username: user
    });
}

// ==========================================
// 3. AUTH RESULT HANDLER
// ==========================================

socket.on('login_result', (data) => {
    if(data.success) {
        document.getElementById('display-username').innerText = data.username;
        document.getElementById('display-mode').innerText = data.mode === 'individual' ? 'Private Mode' : 'Team Mode';
        
        document.getElementById('setup-screen').classList.add('hidden');
        document.getElementById('login-form-screen').classList.add('hidden');
        document.getElementById('mode-selection-screen').classList.add('hidden');
        
        document.getElementById('main-app').classList.remove('hidden');
        document.getElementById('main-app').classList.add('flex');
        
        Swal.fire({
            icon: 'success',
            title: `Welcome, ${data.username}!`,
            text: 'Access Granted.',
            timer: 1500,
            showConfirmButton: false
        });
    } else {
        Swal.fire('Login Failed', data.message, 'error');
        const loginPass = document.getElementById('login-pass');
        if(loginPass) loginPass.value = '';
    }
});

socket.on('session_created', (data) => {
    socket.emit('check_session_status');
    Swal.fire('Session Created', `A ${data.mode} session has just been started. Please login.`, 'info');
});

socket.on('force_reload', () => {
    Swal.fire({
        title: 'System Reset',
        text: 'The session has been reset by an admin or scheduled maintenance. Reloading...',
        icon: 'warning',
        showConfirmButton: false,
        timer: 3000
    }).then(() => {
        location.reload();
    });
});

// ==========================================
// 4. MAIN APP LOGIC (RESET SYSTEM)
// ==========================================

function manualLogout() {
    Swal.fire({
        title: 'RESET SYSTEM?',
        html: "This will disconnect WhatsApp and <b>delete the session for EVERYONE</b>.<br>Users will need to setup mode again.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Yes, Reset System'
    }).then((result) => {
        if (result.isConfirmed) {
            socket.emit('logout');
        }
    });
}

// ==========================================
// 5. WHATSAPP CONNECTION & UI LOGIC
// ==========================================

function showQrModal() {
    if(isConnected) {
        Swal.fire('Already Connected', 'You are logged in.', 'info');
        return;
    }
    document.getElementById('qr-content').classList.remove('hidden');
    document.getElementById('qr-success').classList.add('hidden');
    document.getElementById('qr-title').innerText = "Link Device";
    document.getElementById('qr-subtitle').innerText = "Open WA > Linked Devices > Scan";
    
    document.getElementById('qr-modal').classList.remove('hidden');
    
    const qrImg = document.getElementById('qr-image');
    if(!qrImg.getAttribute('src')) {
        document.getElementById('qr-loading').classList.remove('hidden');
    }
}

function closeQrModal() {
    document.getElementById('qr-modal').classList.add('hidden');
}

// --- SOCKET EVENTS (STATUS WA) ---

socket.on('status', (status) => {
    const dot = document.getElementById('connection-dot');
    const txt = document.getElementById('connection-text');
    const loginScreen = document.getElementById('login-screen');
    const qrModal = document.getElementById('qr-modal');

    if(status === 'ready') {
        isConnected = true;
        loginScreen.classList.add('hidden');
        qrModal.classList.add('hidden');

        if(dot && txt) {
            dot.className = "w-2 h-2 bg-emerald-500 rounded-full shadow-[0_0_10px_#10b981]";
            txt.innerText = "ONLINE";
            txt.className = "text-[10px] font-mono text-emerald-500 uppercase tracking-widest font-bold";
        }
        Toast.fire({ icon: 'success', title: 'WhatsApp Connected!' });
    } 
    else if (status === 'authenticated') {
        qrModal.classList.remove('hidden');
        document.getElementById('qr-content').classList.add('hidden');
        document.getElementById('qr-success').classList.remove('hidden');
        
        document.getElementById('qr-title').innerText = "Logging In...";
        document.getElementById('qr-subtitle').innerText = "Please wait a moment";
    }
    else if (status === 'scan') {
        isConnected = false;
        if(!document.getElementById('main-app').classList.contains('hidden')){
             loginScreen.classList.remove('hidden');
        }
        
        document.getElementById('qr-content').classList.remove('hidden');
        document.getElementById('qr-success').classList.add('hidden');
        document.getElementById('qr-title').innerText = "Link Device";
        document.getElementById('qr-subtitle').innerText = "Open WA > Linked Devices > Scan";

        if(dot && txt) {
            dot.className = "w-2 h-2 bg-yellow-500 rounded-full animate-pulse";
            txt.innerText = "WAITING SCAN";
            txt.className = "text-[10px] font-mono text-yellow-500 uppercase tracking-widest font-bold";
        }
    } 
    else if (status === 'reset') {
        const logoutOverlay = document.getElementById('logout-overlay');
        if(logoutOverlay) logoutOverlay.classList.remove('hidden');

        isConnected = false;
        
        rawData = [];
        document.getElementById('total-data').innerText = 0;
        const qrImg = document.getElementById('qr-image');
        if(qrImg) qrImg.removeAttribute('src'); 
        
        if(qrModal) qrModal.classList.add('hidden');
        
        // Bersihkan dan sembunyikan log panel secara penuh
        document.getElementById('log-panel').innerHTML = ''; 
        document.getElementById('log-panel-container').classList.add('hidden');
        document.getElementById('log-panel-container').classList.remove('flex');
        document.getElementById('log-toggle-btn').classList.add('hidden');

        document.getElementById('broadcast-list').innerHTML = '';
        document.getElementById('custom-grid').innerHTML = '';
        
        if(dot && txt) {
            dot.className = "w-2 h-2 bg-red-500 rounded-full";
            txt.innerText = "OFFLINE";
            txt.className = "text-[10px] font-mono text-red-500 uppercase tracking-widest font-bold";
        }

        setTimeout(() => {
            if(logoutOverlay) logoutOverlay.classList.add('hidden');
            if(!document.getElementById('main-app').classList.contains('hidden')) {
                loginScreen.classList.remove('hidden');
            }
            switchMode('broadcast'); 
        }, 2500);
    }
});

socket.on('qr', (url) => {
    const qrImg = document.getElementById('qr-image');
    if(qrImg) qrImg.src = url;
    const qrLoad = document.getElementById('qr-loading');
    if(qrLoad) qrLoad.classList.add('hidden');
});

// LOGIKA TOGGLE & UPDATE LOG PANEL
socket.on('log', (msg) => {
    const container = document.getElementById('log-panel-container');
    const toggleBtn = document.getElementById('log-toggle-btn');
    const panel = document.getElementById('log-panel');
    
    // Tampilkan container/toggle jika keduanya masih tersembunyi
    if(container.classList.contains('hidden') && toggleBtn.classList.contains('hidden')) {
        if(isLogPanelOpen) {
            container.classList.remove('hidden');
            container.classList.add('flex');
        } else {
            toggleBtn.classList.remove('hidden');
        }
    }
    
    // Cetak log ke dalam panel
    const d = document.createElement('div');
    d.innerHTML = `<span class="opacity-50 mr-2">[${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}]</span>${msg}`;
    panel.appendChild(d);
    panel.scrollTop = panel.scrollHeight;

    // Tambahkan animasi berkedip pada tombol jika panel sedang disembunyikan
    if(!isLogPanelOpen) {
        toggleBtn.classList.add('animate-pulse', 'text-white');
        setTimeout(() => toggleBtn.classList.remove('animate-pulse', 'text-white'), 1000);
    }
});

function toggleLogPanel() {
    isLogPanelOpen = !isLogPanelOpen;
    const container = document.getElementById('log-panel-container');
    const toggleBtn = document.getElementById('log-toggle-btn');
    
    if(isLogPanelOpen) {
        // Tampilkan Box Log
        container.classList.remove('hidden');
        container.classList.add('flex');
        toggleBtn.classList.add('hidden');
    } else {
        // Sembunyikan Box Log dan tampilkan Tombol melayang
        container.classList.add('hidden');
        container.classList.remove('flex');
        toggleBtn.classList.remove('hidden');
    }
}

// ==========================================
// 6. BROADCAST LOGIC
// ==========================================

socket.on('sent_success', (data) => {
    rawData = rawData.filter(item => item.id !== data.id);
    document.getElementById('total-data').innerText = rawData.length;

    if(currentMode === 'broadcast') {
        const el = document.getElementById(`row-${data.id}`);
        if(el) { 
            el.style.opacity = '0'; 
            el.style.transform = 'translateX(50px)'; 
            setTimeout(() => el.remove(), 300); 
        }
    } else {
        const el = document.getElementById(`card-${data.id}`);
        if(el) { el.classList.add('slide-out'); setTimeout(() => el.remove(), 500); }
    }
});

socket.on('sent_failed', (data) => {
    if(currentMode === 'broadcast') {
        const badge = document.getElementById(`badge-${data.id}`);
        if(badge) {
            badge.className = "text-[10px] font-bold text-white bg-red-500 px-2 py-1 rounded shadow-sm";
            badge.innerText = data.reason === 'Not Registered' ? 'UNREGISTERED WA' : 'FAILED';
        }
    } else {
        const card = document.getElementById(`card-${data.id}`);
        if(card) {
            // Ubah gaya kartu menjadi peringatan (merah)
            card.classList.remove('border-indigo-400', 'ring-1', 'ring-indigo-400', 'border-slate-100');
            card.classList.add('border-red-400', 'ring-2', 'ring-red-400', 'bg-red-50');
            
            // Tambahkan label UNREGISTERED WA jika belum ada
            if(!document.getElementById(`fail-badge-${data.id}`)) {
                const headerInfo = card.querySelector('.flex.justify-between.mb-4');
                const badge = document.createElement('div');
                badge.id = `fail-badge-${data.id}`;
                badge.className = "text-[9px] font-bold text-white bg-red-500 px-2 py-1 rounded shadow-sm mb-3 w-fit tracking-wider";
                badge.innerText = data.reason === 'Not Registered' ? 'UNREGISTERED WA' : 'FAILED';
                headerInfo.parentNode.insertBefore(badge, headerInfo.nextSibling);
            }
        }
    }
});

socket.on('finished', () => {
    enableButtons();
    Swal.fire('Done!', 'All messages sent.', 'success');
});

function kirimBroadcast() {
    const msg = document.getElementById('broadcast-msg').value;
    if(!msg) return Swal.fire('Oops', 'Please write a broadcast message first!', 'warning');

    Swal.fire({
        title: 'Start Broadcast?',
        text: `Sending to ${rawData.length} contacts. This may take a while.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#4f46e5',
        confirmButtonText: 'Yes, Start Sending'
    }).then((result) => {
        if (result.isConfirmed) {
            disableButtons();
            const payload = rawData.map(item => ({ id: item.id, nama: item.nama, nomor: item.nomor, pesan: msg }));
            socket.emit('blast', { targets: payload });
        }
    });
}

function kirimCustomReady() {
    const targets = rawData.filter(item => item.pesanKhusus && item.pesanKhusus.trim() !== '').map(item => ({ id: item.id, nama: item.nama, nomor: item.nomor, pesan: item.pesanKhusus }));
    
    if(targets.length === 0) return Swal.fire('Info', 'Please fill at least one message card.', 'info');

    Swal.fire({
        title: 'Send Personal Messages?',
        text: `Sending ${targets.length} custom messages.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#4f46e5',
        confirmButtonText: 'Send Now'
    }).then((result) => {
        if (result.isConfirmed) {
            disableButtons();
            socket.emit('blast', { targets });
        }
    });
}

// ==========================================
// 7. DATA HANDLING (EXCEL & UI)
// ==========================================

function insertTag(tag) {
    const area = document.getElementById('broadcast-msg');
    area.value += tag;
    area.focus();
}

const fileInput = document.getElementById('fileExcel');
if(fileInput) {
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if(!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const wb = XLSX.read(new Uint8Array(event.target.result), {type: 'array'});
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1});
                parsingExcel(rows);
            } catch(err) {
                Swal.fire('Error', 'Invalid Excel File', 'error');
            }
            e.target.value = '';
        };
        reader.readAsArrayBuffer(file);
    });
}

function parsingExcel(rows) {
    let idxNama = -1, idxHP = -1, idxPesan = -1;
    
    // 1. Cek Header (Baris 0 sampai 2) untuk cari kata kunci (termasuk "massage")
    const keywords = ['pesan', 'message', 'massage', 'msg', 'teks', 'text', 'chat', 'keterangan'];
    for (let r = 0; r < Math.min(rows.length, 3); r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
            const cellText = String(row[c] || "").toLowerCase().trim();
            if (keywords.some(kw => cellText.includes(kw))) {
                idxPesan = c;
                break;
            }
        }
        if (idxPesan !== -1) break; // Berhenti jika sudah ketemu
    }

    // 2. Auto deteksi kolom Nama dan HP (Dan pesan jika header tidak ditemukan)
    // Ambil sampel beberapa baris awal data
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
            const cell = String(row[c] || "");
            const cleanNum = cell.replace(/\D/g, '');
            
            // Cari Nomor HP
            if (idxHP === -1 && cleanNum.length >= 9 && (cleanNum.startsWith('62') || cleanNum.startsWith('08') || cleanNum.startsWith('8'))) {
                idxHP = c;
            }
            
            // Cari Nama (teks pendek, bukan angka murni, bukan kolom pesan)
            if (idxNama === -1 && cell.length > 2 && cell.length <= 30 && isNaN(cell) && c !== idxPesan && c !== idxHP) {
                idxNama = c;
            }

            // Fallback Cari Pesan: Jika belum ketemu kolomnya, anggap teks yang panjang (>40 karakter) otomatis sebagai pesan
            if (idxPesan === -1 && cell.length > 40 && c !== idxNama && c !== idxHP) {
                idxPesan = c;
            }
        }
    }

    // Default fallback jika format sangat berantakan
    if (idxHP === -1) idxHP = 1; 
    if (idxNama === -1) idxNama = 0;

    let count = 0;
    rows.forEach((row, i) => {
        let cellHP = String(row[idxHP] || "");
        let cleanHP = cellHP.replace(/\D/g, '');
        
        // Lewati baris header atau baris kosong yang tidak punya no HP valid
        if (i < 3 && cleanHP.length < 8) return; 
        if (cleanHP.length < 8) return;

        let nama = row[idxNama] ? String(row[idxNama]) : "Partner";
        let hp = cleanHP;
        let pesan = (idxPesan !== -1 && row[idxPesan]) ? String(row[idxPesan]) : "";
        
        // Standarisasi awalan nomor HP
        if (hp.startsWith('0')) hp = '62' + hp.slice(1);
        else if (hp.startsWith('8')) hp = '62' + hp;

        if (hp.length > 9) {
            rawData.push({ 
                id: Date.now() + Math.random().toString(36).substr(2, 9), 
                nama: nama, 
                nomor: hp, 
                pesanKhusus: pesan // Pesan otomatis masuk ke kartu
            });
            count++;
        }
    });
    
    document.getElementById('total-data').innerText = rawData.length;
    switchMode(currentMode);
    Toast.fire({ icon: 'success', title: `Imported ${count} Contacts` });
}

function renderBroadcastList() {
    const list = document.getElementById('broadcast-list');
    list.innerHTML = '';
    rawData.forEach(item => {
        const div = document.createElement('div');
        div.id = `row-${item.id}`;
        div.className = "flex justify-between items-center p-3 px-4 hover:bg-slate-50 border-b border-slate-50 transition duration-300 group";
        div.innerHTML = `
            <div class="flex items-center gap-4">
                <div class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-bold border border-indigo-100 group-hover:bg-indigo-600 group-hover:text-white transition">
                    ${item.nama.charAt(0).toUpperCase()}
                </div>
                <div>
                    <div class="text-sm font-bold text-slate-700">${item.nama}</div>
                    <div class="text-[10px] text-slate-400 font-mono tracking-wide">${item.nomor}</div>
                </div>
            </div>
            <div id="badge-${item.id}" class="text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-1 rounded border border-slate-200">WAITING</div>
        `;
        list.appendChild(div);
    });
    checkButtonState();
}

function renderCustomGrid() {
    const grid = document.getElementById('custom-grid');
    grid.innerHTML = '';
    rawData.forEach(item => {
        const div = document.createElement('div');
        div.id = `card-${item.id}`;
        
        // Cek apakah pesan khusus sudah ada nilainya dari excel (untuk styling warna)
        let borderClass = 'border-slate-100';
        let ringClass = '';
        if(item.pesanKhusus && item.pesanKhusus.trim() !== '') {
            borderClass = 'border-indigo-400';
            ringClass = 'ring-1 ring-indigo-400';
        }

        div.className = `custom-card bg-white p-5 rounded-2xl shadow-sm border ${borderClass} ${ringClass} hover:shadow-xl hover:border-indigo-200 transition relative group scale-in`;
        div.setAttribute('data-nama', item.nama.toLowerCase());
        div.setAttribute('data-hp', item.nomor);
        
        div.innerHTML = `
            <div class="flex justify-between mb-4 items-start">
                <div class="flex gap-3 items-center">
                    <div class="w-8 h-8 rounded-full bg-slate-50 text-slate-500 flex items-center justify-center text-xs font-bold border border-slate-200">
                        ${item.nama.charAt(0)}
                    </div>
                    <div>
                        <div class="font-bold text-sm text-slate-700 leading-tight">${item.nama}</div>
                        <div class="text-[10px] font-mono text-slate-400 mt-0.5">${item.nomor}</div>
                    </div>
                </div>
                <button onclick="hapusSatu('${item.id}')" class="text-slate-300 hover:text-red-500 transition p-1 hover:bg-red-50 rounded"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <textarea class="custom-msg-input w-full bg-slate-50/50 border border-slate-100 rounded-xl p-3 text-xs outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none h-24 text-slate-600 placeholder:text-slate-300" 
            placeholder="Type custom message for ${item.nama}..." oninput="updateCustomData('${item.id}', this.value)">${item.pesanKhusus || ''}</textarea>
        `;
        grid.appendChild(div);
    });
}

function hapusSemuaData() {
    if(rawData.length === 0) return;
    Swal.fire({
        title: 'Clear All Data?',
        text: "This will remove all imported contacts.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Yes, Clear All'
    }).then((result) => {
        if (result.isConfirmed) {
            rawData = [];
            document.getElementById('total-data').innerText = 0;
            switchMode(currentMode);
            Toast.fire({ icon: 'success', title: 'Data Cleared' });
        }
    });
}

function hapusSatu(id) {
    rawData = rawData.filter(x => x.id !== id);
    document.getElementById('total-data').innerText = rawData.length;
    document.getElementById(`card-${id}`).remove();
}

function updateCustomData(id, val) {
    const idx = rawData.findIndex(x => x.id === id);
    if(idx > -1) {
        rawData[idx].pesanKhusus = val;
        const card = document.getElementById(`card-${id}`);
        if(val.trim()) { card.classList.add('border-indigo-400', 'ring-1', 'ring-indigo-400'); card.classList.remove('border-slate-100'); }
        else { card.classList.remove('border-indigo-400', 'ring-1', 'ring-indigo-400'); card.classList.add('border-slate-100'); }
    }
    checkButtonState();
}

function filterCustomCards() {
    const term = document.getElementById('search-custom').value.toLowerCase();
    document.querySelectorAll('.custom-card').forEach(card => {
        const txt = card.getAttribute('data-nama') + card.getAttribute('data-hp');
        card.style.display = txt.includes(term) ? 'block' : 'none';
    });
}

function checkButtonState() {
    const btnBroad = document.getElementById('btn-broadcast');
    const btnCust = document.getElementById('btn-custom');
    
    if(rawData.length > 0) {
        btnBroad.disabled = false;
        btnBroad.className = "w-full bg-indigo-600 text-white font-bold py-4 rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition flex items-center justify-center gap-2 transform active:scale-[0.98]";
    } else {
        btnBroad.disabled = true;
        btnBroad.className = "w-full bg-slate-200 text-slate-400 font-bold py-4 rounded-xl transition flex items-center justify-center gap-2 cursor-not-allowed";
    }

    const readyCount = rawData.filter(x => x.pesanKhusus && x.pesanKhusus.trim()).length;
    if(readyCount > 0) {
        btnCust.disabled = false;
        btnCust.innerHTML = `<i class="fa-solid fa-paper-plane mr-2"></i> Send ${readyCount} Messages`;
        btnCust.className = "px-8 py-3 bg-emerald-500 text-white font-bold rounded-xl text-sm shadow-lg shadow-emerald-200 hover:bg-emerald-600 transition transform active:scale-[0.98]";
    } else {
        btnCust.disabled = true;
        btnCust.innerHTML = "Fill Message First";
        btnCust.className = "px-8 py-3 bg-slate-100 text-slate-400 font-bold rounded-xl text-sm transition cursor-not-allowed";
    }
}

function disableButtons() {
    const btnBroad = document.getElementById('btn-broadcast');
    const btnCust = document.getElementById('btn-custom');
    btnBroad.disabled = true;
    btnBroad.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Sending...';
    btnCust.disabled = true;
    btnCust.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
}

function enableButtons() {
    checkButtonState();
    document.getElementById('btn-broadcast').innerHTML = '<span>Send Broadcast</span>';
}

function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.className = "nav-btn w-full flex items-center gap-4 px-4 py-3.5 rounded-xl transition text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5";
    });
    document.getElementById(`nav-${mode}`).className = "nav-btn w-full flex items-center gap-4 px-4 py-3.5 rounded-xl transition text-sm font-medium bg-indigo-600 text-white shadow-lg shadow-indigo-500/30";
    document.getElementById('view-broadcast').classList.add('hidden');
    document.getElementById('view-custom').classList.add('hidden');
    if(rawData.length > 0) {
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById(`view-${mode}`).classList.remove('hidden');
    } else {
        document.getElementById('empty-state').classList.remove('hidden');
    }
    document.getElementById('page-title').innerText = mode === 'broadcast' ? 'Bulk Broadcast' : 'Personal Chat';
    if(mode === 'broadcast') renderBroadcastList();
    if(mode === 'custom') renderCustomGrid();
}