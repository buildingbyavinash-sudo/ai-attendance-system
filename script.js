// AI-Pro Attendance System Core Logic
lucide.createIcons();

const API_URL = window.location.origin;

// Face API Configuration
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
let faceMatcher = null;
let modelsLoaded = false;

// App State
const state = {
    org: JSON.parse(localStorage.getItem('attendance_org')) || null,
    users: [],
    classes: [],
    selectedClass: 'all',
    currentView: 'overview',
    cameraActive: false,
    charts: {},
    regStream: null,
    capturedBlob: null,
    pendingRecognition: null,
    labeledDescriptors: []
};

// --- AI ENGINE LOADER ---
async function loadModels() {
    if (modelsLoaded) return;
    try {
        const msg = document.getElementById('detection-msg');
        if (msg) msg.innerText = "Loading High-Accuracy AI...";

        await Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);

        modelsLoaded = true;
        if (msg) msg.innerText = "AI Systems Online";
    } catch (err) {
        console.error("Model loading failed:", err);
        showToast("AI initialization failed.", "error");
    }
}

async function indexFaces() {
    if (!modelsLoaded || state.users.length === 0) return;

    const msg = document.getElementById('detection-msg');
    if (msg) msg.innerText = "Indexing Member Biometrics...";

    state.labeledDescriptors = [];
    console.log("Starting biometric indexing for", state.users.length, "users");

    for (const user of state.users) {
        try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = user.image;
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
            });

            const detections = await faceapi.detectSingleFace(img)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (detections) {
                state.labeledDescriptors.push(
                    new faceapi.LabeledFaceDescriptors(user.id, [detections.descriptor])
                );
                console.log(`Indexed biometrics for: ${user.name}`);
            } else {
                console.warn(`Could not find face in profile photo for: ${user.name}`);
            }
        } catch (e) {
            console.error(`Failed to index face for ${user.name}:`, e);
        }
    }

    if (state.labeledDescriptors.length > 0) {
        // Threshold 0.35 is VERY strict (Highest accuracy)
        faceMatcher = new faceapi.FaceMatcher(state.labeledDescriptors, 0.35);
        if (msg) msg.innerText = "Biometric Indexing Complete";
    }
}

// --- AUTH & NAVIGATION ---
function showAuth(type) {
    document.getElementById('auth-overlay').classList.remove('hidden');
    switchAuth(type);
}

function hideAuth() {
    document.getElementById('auth-overlay').classList.add('hidden');
}

function switchAuth(type) {
    document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${type}`).classList.add('active');

    if (type === 'login') {
        document.getElementById('login-form-container').classList.remove('hidden');
        document.getElementById('signup-form-container').classList.add('hidden');
    } else {
        document.getElementById('login-form-container').classList.add('hidden');
        document.getElementById('signup-form-container').classList.remove('hidden');
    }
}

function scrollToId(id) {
    document.getElementById(id).scrollIntoView({ behavior: 'smooth' });
}

// --- API ACTIONS ---
document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
        name: document.getElementById('signup-name').value,
        email: document.getElementById('signup-email').value,
        password: document.getElementById('signup-password').value,
        type: document.getElementById('signup-type').value
    };
    try {
        const resp = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (resp.ok) {
            showToast('Institution Registered! Please Login.', 'success');
            switchAuth('login');
        } else {
            const err = await resp.json();
            showToast(err.detail, 'error');
        }
    } catch (err) { showToast('Server connection failed', 'error'); }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
    };
    try {
        const resp = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await resp.json();
        if (resp.ok) {
            state.org = result;
            localStorage.setItem('attendance_org', JSON.stringify(result));
            hideAuth();
            initializeDashboard();
        } else {
            showToast(result.detail || 'Invalid login', 'error');
        }
    } catch (err) { showToast('Authentication failed', 'error'); }
});

function logout() {
    localStorage.removeItem('attendance_org');
    location.reload();
}

// --- DASHBOARD CONTROLLER ---
async function initializeDashboard() {
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('dashboard-view').classList.remove('hidden');

    document.getElementById('org-display-name').innerText = state.org.name;
    document.getElementById('org-display-type').innerText = state.org.type;
    document.getElementById('org-avatar').innerText = state.org.name[0].toUpperCase();

    await loadModels();
    await loadAllData();
    initCharts();
}

async function loadDailyReport() {
    const date = document.getElementById('daily-date-picker').value;
    if (!date) return showToast('Please select a date first', 'error');

    try {
        const resp = await fetch(`${API_URL}/reports/daily/${state.org.org_id}?date=${date}`);
        const data = await resp.json();

        // Calculate Summary
        const total = data.length;
        const present = data.filter(r => r.status === 'Present').length;
        const late = data.filter(r => r.status === 'Late').length;
        const absent = state.users.length - total; // Simplistic assumption
        const rate = total > 0 ? Math.round((present / state.users.length) * 100) : 0;

        const summaryBar = document.getElementById('report-summary-bar');
        summaryBar.classList.remove('hidden');
        summaryBar.innerHTML = `
            <div class="r-stat"><strong>${present}</strong><span>Present</span></div>
            <div class="r-stat text-warning"><strong>${late}</strong><span>Late</span></div>
            <div class="r-stat text-danger"><strong>${absent}</strong><span>Absent</span></div>
            <div class="r-stat"><strong>${rate}%</strong><span>Attendance</span></div>
        `;

        const table = document.getElementById('daily-table');
        table.innerHTML = `<thead><tr><th>Member Name</th><th>Enrollment ID</th><th>Check-in Time</th><th>Status</th></tr></thead>
                           <tbody>${data.map(r => `<tr>
                                <td><strong>${r.name}</strong></td>
                                <td>${r.id}</td>
                                <td>${r.time}</td>
                                <td><span class="status-tag ${r.status === 'Late' ? 'l' : 'p'}">${r.status}</span></td>
                           </tr>`).join('')}</tbody>`;
        if (data.length === 0) table.innerHTML += '<tr><td colspan="4" style="text-align:center; padding: 2rem;">No records found for this date</td></tr>';

    } catch (err) { showToast('Failed to fetch daily report', 'error'); }
}

async function loadIndividualReport() {
    const userId = document.getElementById('individual-user-select').value;
    if (!userId) return showToast('Please select a member', 'error');

    try {
        const resp = await fetch(`${API_URL}/reports/individual/${userId}`);
        const data = await resp.json();

        // Calculate Analytics
        const total = data.length;
        const presentCount = data.filter(r => r.status === 'Present').length;
        const punctuality = total > 0 ? Math.round((presentCount / total) * 100) : 0;

        document.getElementById('ind-summary').classList.remove('hidden');
        document.getElementById('ind-total-present').innerText = total;
        document.getElementById('ind-punctuality').innerText = punctuality + '%';

        const table = document.getElementById('ind-table');
        table.innerHTML = `<thead><tr><th>Date</th><th>Logged Time</th><th>Attendance Status</th></tr></thead>
                           <tbody>${data.map(r => `<tr>
                                <td>${r.date}</td>
                                <td>${r.time}</td>
                                <td><span class="status-tag ${r.status === 'Late' ? 'l' : 'p'}">${r.status}</span></td>
                           </tr>`).join('')}</tbody>`;
    } catch (e) { showToast('Analytics fetch failed', 'error'); }
}

function exportReport(format) {
    if (format === 'print') {
        window.print();
    } else {
        showToast(`Exporting as ${format.toUpperCase()}...`, 'success');
        // CSV logic could be added here
    }
}

async function loadAllData() {
    await loadClasses();
    await loadUsers();
    await indexFaces();
    updateStats();
}

async function loadClasses() {
    try {
        const resp = await fetch(`${API_URL}/classes/${state.org.org_id}`);
        state.classes = await resp.json();
        renderClassNav();
        updateClassSelects();
    } catch (e) { console.error('Class sync failed'); }
}

async function loadUsers() {
    try {
        const url = `${API_URL}/users/${state.org.org_id}?class_id=${state.selectedClass}`;
        const resp = await fetch(url);
        state.users = await resp.json();
        renderUserTable();
    } catch (err) { console.error('User sync failed'); }
}

function updateStats() {
    document.getElementById('ov-total-users').innerText = state.users.length;
}

function navTo(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[onclick="navTo('${viewId}')"]`).classList.add('active');

    if (viewId !== 'attendance') stopCamera();
    state.currentView = viewId;
}

// --- CLASS MANAGEMENT ---
function openClassSettings() {
    document.getElementById('class-settings-modal').classList.remove('hidden');
    renderManageClassList();
}

function closeClassSettings() {
    document.getElementById('class-settings-modal').classList.add('hidden');
}

async function addNewClass() {
    const input = document.getElementById('new-class-name');
    const name = input.value.trim();
    if (!name) return;

    try {
        const resp = await fetch(`${API_URL}/classes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ org_id: state.org.org_id, name })
        });
        if (resp.ok) {
            input.value = '';
            showToast('Class added', 'success');
            await loadClasses();
            renderManageClassList();
        }
    } catch (e) { showToast('Failed to add class', 'error'); }
}

async function deleteClass(id) {
    if (!confirm('Are you sure? Members in this class will become unassigned.')) return;
    try {
        const resp = await fetch(`${API_URL}/classes/${id}`, { method: 'DELETE' });
        if (resp.ok) {
            await loadClasses();
            renderManageClassList();
        }
    } catch (e) { showToast('Delete failed', 'error'); }
}

function renderClassNav() {
    const nav = document.getElementById('class-list-nav');
    let html = `<button class="class-item ${state.selectedClass === 'all' ? 'active' : ''}" onclick="selectClass('all')">All Records</button>`;

    state.classes.forEach(c => {
        html += `<button class="class-item ${state.selectedClass === c.id ? 'active' : ''}" onclick="selectClass('${c.id}')">${c.name}</button>`;
    });
    nav.innerHTML = html;
}

function renderManageClassList() {
    const list = document.getElementById('manage-class-list');
    list.innerHTML = state.classes.map(c => `
        <li>
            <span>${c.name}</span>
            <button class="delete-class-btn" onclick="deleteClass('${c.id}')"><i data-lucide="trash-2"></i></button>
        </li>
    `).join('');
    lucide.createIcons();
}

function updateClassSelects() {
    const selects = ['add-class'];
    selects.forEach(sid => {
        const el = document.getElementById(sid);
        if (el) {
            el.innerHTML = '<option value="">Select Class</option>' +
                state.classes.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        }
    });
}

function selectClass(classId) {
    state.selectedClass = classId;
    renderClassNav();
    loadUsers();
}

// --- REGISTRATION CAMERA ---
document.getElementById('start-reg-cam').addEventListener('click', async () => {
    try {
        state.regStream = await navigator.mediaDevices.getUserMedia({ video: { aspectRatio: 1 } });
        const video = document.getElementById('reg-video');
        video.srcObject = state.regStream;
        document.getElementById('reg-placeholder').classList.add('hidden');
        document.getElementById('start-reg-cam').classList.add('hidden');
        document.getElementById('capture-reg-btn').classList.remove('hidden');
    } catch (err) { showToast('Camera access denied', 'error'); }
});

document.getElementById('capture-reg-btn').addEventListener('click', () => {
    const video = document.getElementById('reg-video');
    const canvas = document.getElementById('reg-canvas');
    const preview = document.getElementById('reg-preview');

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    canvas.toBlob((blob) => {
        state.capturedBlob = blob;
        const url = URL.createObjectURL(blob);
        preview.src = url;
        preview.classList.remove('hidden');
        video.classList.add('hidden');
        document.getElementById('capture-reg-btn').classList.add('hidden');
        document.getElementById('retake-reg-btn').classList.remove('hidden');
    }, 'image/jpeg');
});

document.getElementById('retake-reg-btn').addEventListener('click', () => {
    const video = document.getElementById('reg-video');
    const preview = document.getElementById('reg-preview');
    preview.classList.add('hidden');
    video.classList.remove('hidden');
    document.getElementById('capture-reg-btn').classList.remove('hidden');
    document.getElementById('retake-reg-btn').classList.add('hidden');
    state.capturedBlob = null;
});

// --- ENROLLMENT ---
function openAddUser() { document.getElementById('add-user-modal').classList.remove('hidden'); }
function closeAddUser() {
    if (state.regStream) {
        state.regStream.getTracks().forEach(t => t.stop());
        state.regStream = null;
    }
    document.getElementById('add-user-modal').classList.add('hidden');
    document.getElementById('add-user-form').reset();
    document.getElementById('reg-preview').classList.add('hidden');
    document.getElementById('reg-video').classList.remove('hidden');
    document.getElementById('reg-placeholder').classList.remove('hidden');
    document.getElementById('start-reg-cam').classList.remove('hidden');
    document.getElementById('capture-reg-btn').classList.add('hidden');
    document.getElementById('retake-reg-btn').classList.add('hidden');
    state.capturedBlob = null;
}

document.getElementById('add-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.capturedBlob) return showToast('Please capture a face image first', 'error');

    const formData = new FormData();
    formData.append('name', document.getElementById('add-name').value);
    formData.append('enrollment_id', document.getElementById('add-id').value);
    formData.append('roll_no', document.getElementById('add-roll').value);
    formData.append('class_id', document.getElementById('add-class').value);
    formData.append('org_id', state.org.org_id);
    formData.append('image', state.capturedBlob, 'capture.jpg');

    try {
        const resp = await fetch(`${API_URL}/register-user`, { method: 'POST', body: formData });
        if (resp.ok) {
            showToast('Member Enrolled successfully', 'success');
            closeAddUser();
            loadAllData();
        }
    } catch (err) { showToast('Enrollment failed', 'error'); }
});

// --- EDIT & DELETE ---
function openEditUser(user) {
    document.getElementById('edit-user-modal').classList.remove('hidden');
    document.getElementById('edit-user-id').value = user.id;
    document.getElementById('edit-name').value = user.name;
    document.getElementById('edit-id').value = user.enrollment_id;
    // We don't have roll_no in current get_users response explicitly, but let's assume it's there or handle it
    document.getElementById('edit-roll').value = user.roll_no || '';
    document.getElementById('edit-class').value = state.classes.find(c => c.name === user.class_name)?.id || '';
    document.getElementById('edit-reg-preview').src = user.image;
    document.getElementById('edit-reg-preview').classList.remove('hidden');
}

function closeEditUser() {
    if (state.editStream) {
        state.editStream.getTracks().forEach(t => t.stop());
        state.editStream = null;
    }
    document.getElementById('edit-user-modal').classList.add('hidden');
    state.editBlob = null;
}

document.getElementById('start-edit-cam').addEventListener('click', async () => {
    try {
        state.editStream = await navigator.mediaDevices.getUserMedia({ video: { aspectRatio: 1 } });
        const video = document.getElementById('edit-reg-video');
        video.srcObject = state.editStream;
        document.getElementById('edit-reg-preview').classList.add('hidden');
        document.getElementById('start-edit-cam').classList.add('hidden');
        document.getElementById('capture-edit-btn').classList.remove('hidden');
    } catch (e) { showToast('Camera access denied', 'error'); }
});

document.getElementById('capture-edit-btn').addEventListener('click', () => {
    const video = document.getElementById('edit-reg-video');
    const canvas = document.getElementById('edit-reg-canvas');
    const preview = document.getElementById('edit-reg-preview');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
        state.editBlob = blob;
        preview.src = URL.createObjectURL(blob);
        preview.classList.remove('hidden');
        video.classList.add('hidden');
        document.getElementById('capture-edit-btn').classList.add('hidden');
        document.getElementById('retake-edit-btn').classList.remove('hidden');
    }, 'image/jpeg');
});

document.getElementById('retake-edit-btn').addEventListener('click', () => {
    const video = document.getElementById('edit-reg-video');
    const preview = document.getElementById('edit-reg-preview');
    preview.classList.add('hidden');
    video.classList.remove('hidden');
    document.getElementById('capture-edit-btn').classList.remove('hidden');
    document.getElementById('retake-edit-btn').classList.add('hidden');
    state.editBlob = null;
});

document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('user_id', document.getElementById('edit-user-id').value);
    formData.append('name', document.getElementById('edit-name').value);
    formData.append('enrollment_id', document.getElementById('edit-id').value);
    formData.append('roll_no', document.getElementById('edit-roll').value);
    formData.append('class_id', document.getElementById('edit-class').value);
    if (state.editBlob) formData.append('image', state.editBlob, 'update.jpg');

    try {
        const resp = await fetch(`${API_URL}/update-user`, { method: 'POST', body: formData });
        if (resp.ok) {
            showToast('User updated', 'success');
            closeEditUser();
            loadAllData();
        }
    } catch (e) { showToast('Update failed', 'error'); }
});

async function deleteUserRecord(id) {
    console.log("Attempting to delete user:", id);
    if (!confirm('Are you sure you want to delete this record permanently?')) return;

    try {
        const resp = await fetch(`${API_URL}/users/${id}`, {
            method: 'DELETE',
            headers: { 'Accept': 'application/json' }
        });
        const result = await resp.json();
        console.log("Delete response:", result);

        if (resp.ok) {
            showToast('Record deleted successfully', 'success');
            await loadAllData();
        } else {
            showToast('Server error: ' + (result.detail || 'Unknown'), 'error');
        }
    } catch (e) {
        console.error("Delete fetch error:", e);
        showToast('Connection error during delete', 'error');
    }
}

function handleEditClick(userId) {
    const user = state.users.find(u => u.id === userId);
    if (user) openEditUser(user);
}

function renderUserTable() {
    const list = document.getElementById('users-list');
    list.innerHTML = state.users.map(u => `
        <tr>
            <td><img src="${u.image}" class="user-thumb-small"></td>
            <td><strong>${u.name}</strong></td>
            <td>${u.enrollment_id}</td>
            <td>${u.class_name}</td>
            <td class="table-actions">
                <button class="action-btn edit" onclick="handleEditClick('${u.id}')"><i data-lucide="edit-3"></i></button>
                <button class="action-btn delete" onclick="deleteUserRecord('${u.id}')"><i data-lucide="trash-2"></i></button>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

// --- ATTENDANCE ENGINE ---
const videoMain = document.getElementById('cam-feed');
const camToggle = document.getElementById('cam-toggle');

camToggle.addEventListener('click', async () => {
    if (state.cameraActive) {
        stopCamera();
    } else {
        await loadModels();
        startCamera();
    }
});

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        videoMain.srcObject = stream;
        state.cameraActive = true;
        camToggle.innerHTML = '<i data-lucide="square"></i> Shutdown engine';
        lucide.createIcons();
        startEngineLoop();
    } catch (err) { showToast('Camera access required', 'error'); }
}

function stopCamera() {
    if (videoMain.srcObject) videoMain.srcObject.getTracks().forEach(t => t.stop());
    state.cameraActive = false;
    camToggle.innerHTML = '<i data-lucide="play"></i> Initialize AI Engine';
    lucide.createIcons();
    hideConfirmation();
}

async function startEngineLoop() {
    if (!state.cameraActive || !modelsLoaded || !faceMatcher) return;

    const msg = document.getElementById('detection-msg');

    const interval = setInterval(async () => {
        if (!state.cameraActive) {
            clearInterval(interval);
            return;
        }

        if (state.pendingRecognition) return;

        try {
            // High-precision scanning
            const detections = await faceapi.detectSingleFace(videoMain)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (detections) {
                const bestMatch = faceMatcher.findBestMatch(detections.descriptor);
                console.log(`AI Confidence Check: ${bestMatch.label} (Value: ${bestMatch.distance.toFixed(3)})`);

                if (bestMatch.label !== 'unknown') {
                    const user = state.users.find(u => u.id === bestMatch.label);
                    // Match found! Must pass 0.35 threshold (Strictest)
                    if (user && bestMatch.distance < 0.35) {
                        showConfirmation(user);
                    }
                } else {
                    if (msg) msg.innerText = "Analyzing... (Low Confidence)";
                }
            } else {
                if (msg) msg.innerText = "Searching for Faces...";
            }
        } catch (e) {
            console.error("Detection error:", e);
        }
    }, 1000); // Scan every second
}

function showConfirmation(user) {
    state.pendingRecognition = user;
    document.getElementById('conf-name').innerText = user.name;
    document.getElementById('conf-id').innerText = `ID: ${user.enrollment_id}`;
    document.getElementById('conf-avatar').innerText = user.name[0];
    document.getElementById('recognition-confirm-overlay').classList.remove('hidden');
}

function hideConfirmation() {
    state.pendingRecognition = null;
    document.getElementById('recognition-confirm-overlay').classList.add('hidden');
}

document.getElementById('confirm-entry-btn').addEventListener('click', async () => {
    if (state.pendingRecognition) {
        const user = state.pendingRecognition;
        const now = new Date();
        const record = {
            user_id: user.id,
            org_id: state.org.org_id,
            name: user.name,
            date: now.toISOString().split('T')[0],
            time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            status: now.getHours() >= 9 ? 'Late' : 'Present'
        };
        const resp = await fetch(`${API_URL}/mark-attendance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (resp.ok) {
            logToSession(record);
            showToast(`Verified: ${user.name}`, 'success');
        }
        hideConfirmation();
    }
});

document.getElementById('cancel-entry-btn').addEventListener('click', hideConfirmation);

function logToSession(r) {
    const log = document.getElementById('session-log');
    const div = document.createElement('div');
    div.className = `log-entry animate__animated animate__fadeInRight`;
    div.innerHTML = `<div class="avatar">${r.name[0]}</div><div class="info"><p><strong>${r.name}</strong></p><span>${r.time} • ${r.status}</span></div>`;
    log.prepend(div);
}

// --- UTILS ---
function showToast(msg, type = 'success') {
    const cont = document.getElementById('toast-container');
    const t = document.createElement('div'); t.className = `toast ${type}`; t.innerText = msg;
    cont.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function initCharts() {
    const ctx = document.getElementById('weeklyChart').getContext('2d');
    new Chart(ctx, { type: 'line', data: { labels: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], datasets: [{ label: 'Enrollments', data: [2, 5, 3, 8, 10, 5, 4], borderColor: '#6366f1', tension: 0.4 }] } });
}

if (state.org) initializeDashboard();
else if (location.hash) scrollToId(location.hash.slice(1));
