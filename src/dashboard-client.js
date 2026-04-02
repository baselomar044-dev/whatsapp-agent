/* =====================================================================
   W&F Dashboard — Full Client
   Features: 20-feature contacts manager + all existing functionality
   ===================================================================== */

const REFRESH_MS = 10000;
const MAX_CONTACTS = 10000;

// ── upload / recorder state (WhatsApp agent + Freelance agent) ─────────
const uploadState = { whatsapp: null, freelance: null };
const recorderState = { whatsapp: null, freelance: null };

// ── contacts manager state ─────────────────────────────────────────────
let allContacts = [];           // last fetched list from server
let selectedContacts = new Set();
let contactGroups = {};         // { phone: groupName } stored in localStorage
let scheduledMessages = [];     // [{ id, phones, message, at }]
let pendingSendAttachment = null; // attachment for direct send modal
let editingPhone = null;        // null = adding, string = editing
let contactSentCounts = {};     // { phone: count } derived from logs
let lastAutomationData = {};    // last known automation settings from server
let lastFreelanceData = {};     // last known freelance config from server

// ── Utilities ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const when = (value) => {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
};
const ago = (value) => {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    const diff = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
};

function getAuthHeaders(extra = {}) {
    return {
        ...(window.__authHeader ? { Authorization: window.__authHeader } : {}),
        ...extra
    };
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        cache: 'no-store',
        ...options,
        headers: getAuthHeaders(options.headers || {})
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || payload.detail || `Request failed with status ${response.status}`);
    }
    return response.json().catch(() => ({}));
}

// ── Toast notifications ────────────────────────────────────────────────
function toast(message, type = 'info') {
    const container = $('toast-container');
    if (!container) return;
    const id = `toast-${Date.now()}`;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.id = id;
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-show'));
    setTimeout(() => {
        el.classList.remove('toast-show');
        setTimeout(() => el.remove(), 350);
    }, 3500);
}

// ── Dark mode ──────────────────────────────────────────────────────────
function applyTheme(dark) {
    document.body.classList.toggle('light-mode', !dark);
    const btn = $('dark-mode-toggle');
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
    localStorage.setItem('dashboard_theme', dark ? 'dark' : 'light');
}

// ── Local persistence for groups & scheduled ───────────────────────────
function loadGroups() {
    try { contactGroups = JSON.parse(localStorage.getItem('contact_groups') || '{}'); } catch (_) { contactGroups = {}; }
}
function saveGroups() {
    localStorage.setItem('contact_groups', JSON.stringify(contactGroups));
}
function loadScheduled() {
    try { scheduledMessages = JSON.parse(localStorage.getItem('scheduled_messages') || '[]'); } catch (_) { scheduledMessages = []; }
}
function saveScheduled() {
    localStorage.setItem('scheduled_messages', JSON.stringify(scheduledMessages));
}

// ── Badge ──────────────────────────────────────────────────────────────
function setBadge(id, label, status) {
    const node = $(id);
    if (!node) return;
    node.className = `badge ${String(status || 'neutral').toLowerCase().replace(/\s+/g, '_')}`;
    node.textContent = label;
}

// ── Conversation render ────────────────────────────────────────────────
function renderConversation(targetId, history) {
    const node = $(targetId);
    if (!node) return;
    node.innerHTML = history.length
        ? history.map((item) => `
            <article class="message-bubble ${esc(item.role || 'assistant')}">
                <strong>${esc((item.role || 'assistant').toUpperCase())}</strong>
                <div>${esc(item.text || '')}</div>
                <small>${esc(when(item.timestamp))}</small>
            </article>
        `).join('')
        : '<article class="message-bubble assistant"><strong>ASSISTANT</strong><div>No conversation yet.</div></article>';
    node.scrollTop = node.scrollHeight;
}

// ── QR render ─────────────────────────────────────────────────────────
let _lastQrUrl = '';
function renderQr(whatsapp) {
    const slot = $('qr-slot');
    if (!slot) return;
    const url = whatsapp.qrUrl || '';
    if (url && url !== _lastQrUrl) {
        _lastQrUrl = url;
        slot.innerHTML = `<img src="${esc(url)}" alt="WhatsApp QR" /><p style="margin:0.5rem 0 0;font-size:0.75rem;color:var(--text-secondary)">Open WhatsApp → Linked Devices → Scan this code</p>`;
    } else if (!url && _lastQrUrl) {
        _lastQrUrl = '';
        slot.textContent = 'QR will appear here when needed.';
    }
    $('wa-availability').textContent = whatsapp.status || 'unknown';
    $('wa-connection-text').textContent = (whatsapp.status || 'unknown').replace(/_/g, ' ');
    $('wa-authenticated').textContent = when(whatsapp.authenticatedAt);
    $('wa-ready').textContent = when(whatsapp.readyAt);
    $('wa-issue').textContent = whatsapp.lastError || whatsapp.lastDisconnectReason || 'None';
}

// ── Sent list render ───────────────────────────────────────────────────
function renderSent(logs) {
    $('sent-count').textContent = `${logs.length}`;
    $('sent-list').innerHTML = logs.length
        ? logs.map((log) => `
            <article class="list-card">
                <strong>${esc(log.phone || '-')}</strong>
                <div>${esc(log.message_content || 'Sent message')}</div>
                <div class="meta">${esc(when(log.sent_at))}</div>
            </article>
        `).join('')
        : '<article class="list-card"><strong><span class="t-en">No sent numbers yet</span><span class="t-ar">لم يتم إرسال أرقام بعد</span></strong></article>';

    // Build sent-counts map
    contactSentCounts = {};
    logs.forEach((log) => {
        if (log.phone && (log.status || '').toLowerCase() === 'sent') {
            contactSentCounts[log.phone] = (contactSentCounts[log.phone] || 0) + 1;
        }
    });
}

// ── Contacts: group filter dropdown ────────────────────────────────────
function refreshGroupFilterOptions() {
    const groupSet = new Set(Object.values(contactGroups).filter(Boolean));
    const sel = $('contacts-group-filter');
    if (!sel) return;
    const current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    groupSet.forEach((g) => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        sel.appendChild(opt);
    });
    if (current) sel.value = current;

    // also update modal-contact-group datalist
    const modalInput = $('modal-contact-group');
    if (modalInput) {
        let dl = document.getElementById('group-datalist');
        if (!dl) {
            dl = document.createElement('datalist');
            dl.id = 'group-datalist';
            document.body.appendChild(dl);
            modalInput.setAttribute('list', 'group-datalist');
        }
        dl.innerHTML = [...groupSet].map((g) => `<option value="${esc(g)}">`).join('');
    }

    $('cs-groups').textContent = String(groupSet.size);
}

// ── Contacts: stats bar ────────────────────────────────────────────────
function updateContactStatsBar(contacts, dailySentToday) {
    const total = contacts.length;
    const active = contacts.filter((c) => c.is_active !== false).length;
    const inactive = total - active;
    $('cs-total').textContent = String(total);
    $('cs-active').textContent = String(active);
    $('cs-inactive').textContent = String(inactive);
    $('cs-sent-today').textContent = String(dailySentToday || 0);
    $('cs-limit').textContent = `/ ${MAX_CONTACTS}`;
    refreshGroupFilterOptions();
}

// ── Contacts: render card ──────────────────────────────────────────────
function renderContactCard(contact) {
    const group = contactGroups[contact.phone] || '';
    const sentCount = contactSentCounts[contact.phone] || 0;
    const isSelected = selectedContacts.has(contact.phone);
    const isActive = contact.is_active !== false;
    return `
    <article class="contact-card ${isActive ? 'active' : 'inactive'} ${isSelected ? 'selected' : ''}" data-phone="${esc(contact.phone)}">
        <div class="contact-card-top">
            <label class="contact-checkbox-wrap" title="Select">
                <input type="checkbox" class="contact-select" data-phone="${esc(contact.phone)}" ${isSelected ? 'checked' : ''} />
            </label>
            <div class="contact-info">
                <strong class="contact-name">${esc(contact.name || 'Unknown')}</strong>
                <span class="contact-phone">${esc(contact.phone || '-')}</span>
                ${group ? `<span class="group-chip">${esc(group)}</span>` : ''}
            </div>
            <span class="badge ${isActive ? 'success' : 'warning'} contact-status-badge">
                ${isActive ? '<span class="t-en">Active</span><span class="t-ar">نشط</span>' : '<span class="t-en">Inactive</span><span class="t-ar">غير نشط</span>'}
            </span>
        </div>
        <div class="contact-meta-row">
            <span class="t-en">Last sent: ${esc(contact.last_sent_at ? ago(contact.last_sent_at) : 'Never')}</span>
            <span class="t-ar">آخر إرسال: ${esc(contact.last_sent_at ? ago(contact.last_sent_at) : 'لم يُرسل')}</span>
            ${sentCount > 0 ? `<span class="sent-count-badge">${sentCount}✉</span>` : ''}
        </div>
        <div class="contact-actions-row">
            <button type="button" class="btn-icon btn-send-direct primary-button" data-phone="${esc(contact.phone)}" data-name="${esc(contact.name || '')}" title="Send">
                <span class="t-en">✉ Send</span><span class="t-ar">✉ إرسال</span>
            </button>
            <button type="button" class="btn-icon btn-schedule-contact" data-phone="${esc(contact.phone)}" data-name="${esc(contact.name || '')}" title="Schedule">
                <span class="t-en">⏰ Schedule</span><span class="t-ar">⏰ جدولة</span>
            </button>
            <button type="button" class="btn-icon btn-toggle-active" data-phone="${esc(contact.phone)}" data-active="${isActive}" title="${isActive ? 'Deactivate' : 'Activate'}">
                ${isActive ? '<span class="t-en">⏸ Deactivate</span><span class="t-ar">⏸ تعطيل</span>' : '<span class="t-en">▶ Activate</span><span class="t-ar">▶ تفعيل</span>'}
            </button>
            <button type="button" class="btn-icon btn-edit-contact" data-phone="${esc(contact.phone)}" data-name="${esc(contact.name || '')}" title="Edit">
                <span class="t-en">✏ Edit</span><span class="t-ar">✏ تعديل</span>
            </button>
            <button type="button" class="btn-icon danger-button btn-delete-contact" data-phone="${esc(contact.phone)}" title="Delete">
                <span class="t-en">🗑 Delete</span><span class="t-ar">🗑 حذف</span>
            </button>
        </div>
    </article>`;
}

// ── Contacts: main render ──────────────────────────────────────────────
function renderContacts(contacts) {
    allContacts = contacts;
    const search = ($('contacts-search') ? $('contacts-search').value : '').toLowerCase();
    const filter = $('contacts-filter') ? $('contacts-filter').value : 'all';
    const groupFilter = $('contacts-group-filter') ? $('contacts-group-filter').value : '';

    const filtered = contacts.filter((c) => {
        const matchSearch = !search ||
            (c.name || '').toLowerCase().includes(search) ||
            (c.phone || '').includes(search);
        let matchFilter = true;
        if (filter === 'active') matchFilter = c.is_active !== false;
        else if (filter === 'inactive') matchFilter = c.is_active === false;
        else if (filter === 'sent') matchFilter = Boolean(c.last_sent_at);
        else if (filter === 'unsent') matchFilter = !c.last_sent_at;
        const matchGroup = !groupFilter || (contactGroups[c.phone] || '') === groupFilter;
        return matchSearch && matchFilter && matchGroup;
    });

    $('contacts-count').textContent = `${contacts.length}`;

    // Duplicate detection within current import context — highlight dupes
    const seenPhones = new Map();
    contacts.forEach((c) => {
        seenPhones.set(c.phone, (seenPhones.get(c.phone) || 0) + 1);
    });
    const hasDupes = [...seenPhones.values()].some((v) => v > 1);
    if (hasDupes) {
        toast('⚠ Duplicate phone numbers detected in contact list.', 'warning');
    }

    $('contacts-list').innerHTML = filtered.length
        ? filtered.map((c) => renderContactCard(c)).join('')
        : `<div class="empty-state"><span class="t-en">No contacts found.</span><span class="t-ar">لا توجد جهات اتصال.</span></div>`;

    // Update selected count
    updateSelectionUI();
}

// ── Selection helpers ──────────────────────────────────────────────────
function updateSelectionUI() {
    const count = selectedContacts.size;
    const badge = $('contacts-selected-count');
    if (badge) {
        badge.hidden = count === 0;
        badge.textContent = `${count} selected`;
    }
    const bulkDel = $('btn-bulk-delete');
    if (bulkDel) bulkDel.disabled = count === 0;
    const bulkSched = $('btn-bulk-schedule');
    if (bulkSched) bulkSched.disabled = count === 0;
    const selectAll = $('contacts-select-all');
    if (selectAll && allContacts.length > 0) {
        selectAll.indeterminate = count > 0 && count < allContacts.length;
        selectAll.checked = count === allContacts.length;
    }
}

// ── Jobs render ────────────────────────────────────────────────────────
function renderJobs(freelance) {
    const jobs = freelance.recentJobs || [];
    $('jobs-count').textContent = `${jobs.length}`;
    $('freelance-jobs').innerHTML = jobs.length
        ? jobs.map((job) => `
            <article class="list-card opportunity-card ${esc(job.actionState || 'new')}">
                <div class="opportunity-topline">
                    <strong>${esc(job.title || 'Untitled job')}</strong>
                    <span class="job-state ${esc(job.actionState || 'new')}">${esc((job.actionState || 'new').replace(/_/g, ' '))}</span>
                </div>
                <div>${esc(job.company || 'Direct')} | ${esc(job.platform || 'Unknown')}</div>
                <div class="meta">${esc(when(job.created_at))}</div>
                <div class="job-summary"><strong><span class="t-en">Summary</span><span class="t-ar">الملخص</span></strong><div>${esc(job.summary || 'No summary')}</div></div>
                <div class="job-fee"><strong><span class="t-en">Fee</span><span class="t-ar">الرسوم</span></strong><div>${esc(job.feePreview || 'Not specified')}</div></div>
                ${job.job_url ? `<div class="meta"><a href="${esc(job.job_url)}" target="_blank" rel="noreferrer"><span class="t-en">Open link</span><span class="t-ar">افتح الرابط</span></a></div>` : ''}
                ${job.suggested_proposal ? `
                    <details class="proposal-preview">
                        <summary><span class="t-en">Ready Proposal Preview</span><span class="t-ar">معاينة المقترح</span></summary>
                        <div class="meta">${esc(String(job.suggested_proposal).slice(0, 420))}</div>
                    </details>
                ` : ''}
                <div class="job-actions">
                    <button type="button" class="danger-button" data-job-action="ignored" data-job-id="${esc(job.id)}"><span class="t-en">Ignore</span><span class="t-ar">تجاهل</span></button>
                    <button type="button" class="primary-button" data-job-action="ready" data-job-id="${esc(job.id)}" ${job.proposalReady ? '' : 'disabled'}><span class="t-en">Ready Proposal</span><span class="t-ar">مقترح جاهز</span></button>
                </div>
            </article>
        `).join('')
        : '<article class="list-card"><strong><span class="t-en">No jobs yet</span><span class="t-ar">لا توجد وظائف بعد</span></strong></article>';
}

async function setJobAction(jobId, action) {
    await apiFetch('/api/freelance/jobs/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, action })
    });
    await refresh();
}

// ── Agent upload state render ──────────────────────────────────────────
function renderUploadState(kind) {
    const node = kind === 'whatsapp' ? $('wa-upload-state') : $('freelance-upload-state');
    if (!node) return;
    const value = uploadState[kind];
    if (!value) {
        node.innerHTML = '<span class="t-en">No attachment selected</span><span class="t-ar">لا يوجد مرفق</span>';
        return;
    }
    node.innerHTML = `${esc(value.filename)} &mdash; <span class="t-en">${value.category === 'voice-note' ? 'Voice note ready' : 'Attachment ready'}</span><span class="t-ar">${value.category === 'voice-note' ? 'تسجيل جاهز' : 'مرفق جاهز'}</span>`;
}

// ── Main data render ───────────────────────────────────────────────────
function renderData(data) {
    const runtime = data.runtime || {};
    const whatsapp = runtime.whatsapp || {};
    const health = data.health || {};
    const freelance = data.freelance || {};
    const automation = data.automation || {};
    lastAutomationData = automation;

    $('last-refresh').textContent = `Updated ${ago(data.generatedAt)}`;
    $('wa-summary').textContent = whatsapp.lastError || whatsapp.lastDisconnectReason || `WhatsApp is ${whatsapp.status || 'unknown'}.`;
    $('freelance-summary').textContent = freelance.note || `${freelance.stats?.unsentJobs || 0} unsent jobs, ${(freelance.searchSites || []).length || 0} target sites configured.`;

    setBadge('wa-status-pill', (whatsapp.status || 'unknown').replace(/_/g, ' '), whatsapp.status || 'neutral');
    setBadge('wa-health-pill', health.status || 'neutral', health.status || 'neutral');
    setBadge('freelance-status-pill', freelance.available ? 'available' : 'offline', freelance.available ? 'ready' : 'warning');
    setBadge('freelance-jobs-pill', `${freelance.stats?.totalJobs || 0} jobs`, freelance.stats?.unsentJobs ? 'warning' : 'neutral');

    $('run-blast').disabled = !['ready', 'authenticated'].includes(whatsapp.status);
    renderQr(whatsapp);
    renderConversation('wa-conversation', (data.conversations || {}).whatsapp || []);
    renderConversation('freelance-conversation', (data.conversations || {}).freelance || []);

    // Update sent counts first so contact cards show them
    renderSent(data.sentNumbers || []);

    // Render contacts with stats
    renderContacts(data.contactsList || []);
    updateContactStatsBar(data.contactsList || [], data.stats?.logsToday?.sent || 0);

    renderJobs(freelance);
    renderUploadState('whatsapp');
    renderUploadState('freelance');

    $('automation-status').innerHTML = automation.scheduleEnabled === false
        ? '<span class="t-en">Manual only</span><span class="t-ar">يدوي</span>'
        : '<span class="t-en">Scheduled</span><span class="t-ar">مجدول</span>';
    $('automation-message-preview').textContent = automation.messageTemplate || '-';
    $('automation-time-preview').textContent = automation.sendTime || '-';
    $('automation-range-preview').textContent = `${automation.minMessages || 0} - ${automation.maxMessages || 0}`;
    $('automation-enabled-preview').innerHTML = automation.scheduleEnabled === false
        ? '<span class="t-en">Off</span><span class="t-ar">إيقاف</span>'
        : '<span class="t-en">On</span><span class="t-ar">تشغيل</span>';

    $('freelance-total').textContent = String(freelance.stats?.totalJobs || 0);
    $('freelance-unsent').textContent = String(freelance.stats?.unsentJobs || 0);
    $('freelance-sent').textContent = String(freelance.stats?.sentJobs || 0);
    $('freelance-ready').textContent = String(freelance.stats?.readyJobs || 0);
    $('freelance-ignored').textContent = String(freelance.stats?.ignoredJobs || 0);
    $('freelance-location').textContent = freelance.location || '-';
    $('freelance-sites').textContent = (freelance.searchSites || []).join(', ') || 'default';
    $('freelance-sites-today').textContent = (freelance.searchedToday || []).join(', ') || 'none';
    $('freelance-keywords').textContent = freelance.keywords || '-';
    $('freelance-portfolio').textContent = freelance.portfolioPath || '-';
    lastFreelanceData = freelance;
    $('open-freelance-dashboard').disabled = !freelance.frontendUrl;
    $('open-freelance-dashboard').dataset.url = freelance.frontendUrl || '';

    const errors = data.dataErrors || [];
    const errorsNode = $('workspace-errors');
    if (errors.length) {
        errorsNode.hidden = false;
        errorsNode.innerHTML = errors.map((e) => `<div>${esc(e)}</div>`).join('');
    } else {
        errorsNode.hidden = true;
        errorsNode.innerHTML = '';
    }
}

// ── Refresh ────────────────────────────────────────────────────────────
async function refresh() {
    try {
        renderData(await apiFetch('/api/status'));
    } catch (error) {
        $('workspace-errors').hidden = false;
        $('workspace-errors').textContent = error.message;
        $('last-refresh').textContent = 'Refresh failed';
    }
}

// ── CSV parser ─────────────────────────────────────────────────────────
function parseCsv(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    return lines.slice(1).map((line) => {
        const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
        const row = Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
        return {
            name: row.name || row.full_name || row.contact || 'Unknown',
            phone: row.phone || row.number || row.mobile || ''
        };
    }).filter((c) => c.phone);
}

// ── File → base64 payload ──────────────────────────────────────────────
async function fileToPayload(file, category) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsDataURL(file);
    });
    return { filename: file.name, mimetype: file.type || 'application/octet-stream', data: dataUrl, category };
}

// ── Agent chat attachment ──────────────────────────────────────────────
async function storePickedFile(kind, file) {
    uploadState[kind] = await fileToPayload(file, 'dashboard-upload');
    renderUploadState(kind);
}

// ── Voice recording ────────────────────────────────────────────────────
async function toggleVoiceRecording(kind) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording is not supported in this browser.');
    }
    if (recorderState[kind]) { recorderState[kind].stop(); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const mediaRecorder = new MediaRecorder(stream);
    recorderState[kind] = mediaRecorder;
    const button = kind === 'whatsapp' ? $('wa-voice-button') : $('freelance-voice-button');
    button.innerHTML = '<span class="t-en">Stop Recording</span><span class="t-ar">أوقف التسجيل</span>';
    mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data?.size > 0) chunks.push(e.data); });
    mediaRecorder.addEventListener('stop', async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderState[kind] = null;
        button.innerHTML = '<span class="t-en">Voice</span><span class="t-ar">صوت</span>';
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], `${kind}-voice-${Date.now()}.webm`, { type: 'audio/webm' });
        uploadState[kind] = await fileToPayload(file, 'voice-note');
        renderUploadState(kind);
    });
    mediaRecorder.start();
}

function clearUpload(kind) {
    uploadState[kind] = null;
    renderUploadState(kind);
}

// ── Import preview ─────────────────────────────────────────────────────
function showImportPreview(contacts) {
    const existingPhones = new Set(allContacts.map((c) => c.phone));
    const dupes = contacts.filter((c) => existingPhones.has(c.phone));
    const newOnes = contacts.filter((c) => !existingPhones.has(c.phone));
    const invalid = contacts.filter((c) => !c.phone || !/^\d{7,15}$/.test(c.phone));

    $('modal-preview-stats').innerHTML = `
        <span class="badge success">${newOnes.length} new</span>
        <span class="badge warning">${dupes.length} duplicates</span>
        <span class="badge error">${invalid.length} invalid</span>
        <span class="badge neutral">Total: ${contacts.length}</span>
    `;

    const validForImport = contacts.filter((c) => c.phone && /^\d{7,15}$/.test(c.phone));
    $('modal-preview-list').innerHTML = validForImport.slice(0, 50).map((c) => {
        const isDupe = existingPhones.has(c.phone);
        return `<div class="preview-row ${isDupe ? 'dupe-row' : ''}">
            <span class="preview-name">${esc(c.name)}</span>
            <span class="preview-phone">${esc(c.phone)}</span>
            ${isDupe ? '<span class="badge warning">dup</span>' : ''}
        </div>`;
    }).join('') + (validForImport.length > 50 ? `<div class="preview-more">…and ${validForImport.length - 50} more</div>` : '');

    $('modal-preview-import').dataset.contacts = JSON.stringify(validForImport);
    $('modal-preview').hidden = false;
}

async function parseContactFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        return rows.map((row) => {
            // flexible column matching — find first key containing the candidate substring
            const val = (candidates) => {
                for (const c of candidates) {
                    const k = Object.keys(row).find((k) => k.toLowerCase().replace(/\s+/g, '').includes(c));
                    if (k !== undefined && String(row[k]).trim()) return String(row[k]).trim();
                }
                return '';
            };
            const rawPhone = val(['phone', 'mobile', 'number', 'رقم', 'هاتف', 'جوال', 'tel']);
            return {
                name: val(['name', 'full', 'contact', 'اسم', 'الاسم']) || 'Unknown',
                phone: rawPhone.replace(/[^\d]/g, '')
            };
        }).filter((c) => c.phone);
    }
    const text = await file.text();
    return name.endsWith('.json') ? JSON.parse(text) : parseCsv(text);
}

// ── Export ─────────────────────────────────────────────────────────────
function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function exportContacts(format) {
    const url = `/api/contacts/export?format=${format}`;
    const response = await fetch(url, {
        headers: getAuthHeaders(),
        cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Export failed: ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, `contacts.${format}`);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
}

// ── Freelance Settings modal ────────────────────────────────────────────
function openFreelanceSettings() {
    $('fset-keywords').value = lastFreelanceData.keywords || '';
    $('fset-location').value = lastFreelanceData.location || '';
    $('fset-sites').value = (lastFreelanceData.searchSites || []).join(', ');
    $('fset-profile').value = lastFreelanceData.searchProfile || '';
    $('fset-portfolio').value = lastFreelanceData.portfolioPath || '';
    $('modal-freelance-settings').hidden = false;
}

async function saveFreelanceSettings() {
    const payload = {
        search_keywords: $('fset-keywords').value.trim(),
        search_location: $('fset-location').value.trim(),
        search_sites: $('fset-sites').value.trim(),
        search_profile: $('fset-profile').value.trim(),
        portfolio_path: $('fset-portfolio').value.trim()
    };
    await apiFetch('/api/freelance/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    toast('Freelance settings saved.', 'success');
    $('modal-freelance-settings').hidden = true;
    await refresh();
}

function resetFreelanceDefaults() {
    const d = lastFreelanceData.defaults || {};
    $('fset-keywords').value = d.keywords || '';
    $('fset-location').value = d.location || '';
    $('fset-sites').value = (d.searchSites || []).join(', ');
    $('fset-profile').value = '';
    $('fset-portfolio').value = '';
    toast('Fields reset to defaults (not saved yet).', 'info');
}

// ── Settings modal ────────────────────────────────────────────────────
function openSettingsModal() {
    $('set-app-name').value = localStorage.getItem('app_name') || '';
    $('set-message').value = lastAutomationData.messageTemplate || '';
    $('set-send-time').value = lastAutomationData.sendTime || '09:00';
    $('set-min').value = lastAutomationData.minMessages != null ? lastAutomationData.minMessages : 30;
    $('set-max').value = lastAutomationData.maxMessages != null ? lastAutomationData.maxMessages : 40;
    $('set-schedule-enabled').checked = lastAutomationData.scheduleEnabled !== false;
    $('modal-settings').hidden = false;
}

async function saveSettings() {
    const appName = $('set-app-name').value.trim();
    const messageTemplate = $('set-message').value.trim();
    const sendTime = $('set-send-time').value || '09:00';
    const minMessages = Math.max(1, parseInt($('set-min').value, 10) || 30);
    const maxMessages = Math.max(minMessages, parseInt($('set-max').value, 10) || 40);
    const scheduleEnabled = $('set-schedule-enabled').checked;

    if (appName) {
        localStorage.setItem('app_name', appName);
    } else {
        localStorage.removeItem('app_name');
    }
    applyAppName();

    await apiFetch('/api/settings/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageTemplate, sendTime, minMessages, maxMessages, scheduleEnabled })
    });
    toast('Settings saved.', 'success');
    $('modal-settings').hidden = false;
    $('modal-settings').hidden = true;
    await refresh();
}

function applyAppName() {
    const name = localStorage.getItem('app_name');
    if (name) {
        const en = $('app-name-display-en');
        const ar = $('app-name-display-ar');
        if (en) en.textContent = name;
        if (ar) ar.textContent = name;
        document.title = name;
    }
}

// ── Blast / Scout ──────────────────────────────────────────────────────
async function runBlast() {
    await apiFetch('/api/blast/run', { method: 'POST' });
    await refresh();
}

async function runScout() {
    await apiFetch('/api/freelance/scout', { method: 'POST' });
    await refresh();
}

// ── Agent chat submit ──────────────────────────────────────────────────
async function submitChat(kind) {
    const input = kind === 'whatsapp' ? $('wa-chat-input') : $('freelance-chat-input');
    const endpoint = kind === 'whatsapp' ? '/api/manager/chat' : '/api/freelance/chat';
    const message = input.value.trim();
    const attachment = uploadState[kind];
    if (!message && !attachment) return;
    input.value = '';
    await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, attachment })
    });
    clearUpload(kind);
    await refresh();
}

// ── MODAL helpers ──────────────────────────────────────────────────────
function closeAllModals() {
    ['modal-contact', 'modal-send', 'modal-preview', 'modal-schedule', 'modal-settings', 'modal-freelance-settings'].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = true;
    });
}

// ── Add / Edit Contact Modal ───────────────────────────────────────────
function openAddModal() {
    editingPhone = null;
    $('modal-contact-title').innerHTML = '<span class="t-en">Add Contact</span><span class="t-ar">إضافة جهة اتصال</span>';
    $('modal-contact-name').value = '';
    $('modal-contact-phone').value = '';
    $('modal-contact-group').value = '';
    $('modal-contact-active').checked = true;
    $('modal-contact').hidden = false;
    $('modal-contact-name').focus();
}

function openEditModal(phone, name) {
    editingPhone = phone;
    $('modal-contact-title').innerHTML = '<span class="t-en">Edit Contact</span><span class="t-ar">تعديل جهة اتصال</span>';
    $('modal-contact-name').value = name || '';
    $('modal-contact-phone').value = phone || '';
    $('modal-contact-group').value = contactGroups[phone] || '';
    const contact = allContacts.find((c) => c.phone === phone);
    $('modal-contact-active').checked = contact ? contact.is_active !== false : true;
    $('modal-contact').hidden = false;
    $('modal-contact-name').focus();
}

async function saveContactModal() {
    const name = $('modal-contact-name').value.trim();
    const phone = $('modal-contact-phone').value.trim().replace(/\D/g, '');
    const group = $('modal-contact-group').value.trim();
    const isActive = $('modal-contact-active').checked;

    if (!name || !phone) { toast('Name and phone are required.', 'error'); return; }
    if (!/^\d{7,15}$/.test(phone)) { toast('Phone must be 7–15 digits.', 'error'); return; }
    if (allContacts.length >= MAX_CONTACTS && !editingPhone) {
        toast(`Contact limit of ${MAX_CONTACTS} reached.`, 'error'); return;
    }

    try {
        if (editingPhone) {
            await apiFetch('/api/contacts/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: editingPhone, updates: { name, phone, is_active: isActive } })
            });
            // update group assignment
            if (group) contactGroups[phone] = group;
            else delete contactGroups[phone];
            // remove old phone group if phone changed
            if (editingPhone !== phone) delete contactGroups[editingPhone];
            saveGroups();
            toast('Contact updated.', 'success');
        } else {
            await apiFetch('/api/contacts/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contacts: [{ name, phone, is_active: isActive }] })
            });
            if (group) contactGroups[phone] = group;
            saveGroups();
            toast('Contact added.', 'success');
        }
        closeAllModals();
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ── Delete contact ─────────────────────────────────────────────────────
async function deleteContactByPhone(phone) {
    if (!confirm(`Delete contact ${phone}?`)) return;
    try {
        await apiFetch('/api/contacts/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        delete contactGroups[phone];
        selectedContacts.delete(phone);
        saveGroups();
        toast('Contact deleted.', 'success');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function bulkDelete() {
    if (selectedContacts.size === 0) return;
    if (!confirm(`Delete ${selectedContacts.size} contact(s)?`)) return;
    try {
        await apiFetch('/api/contacts/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phones: [...selectedContacts] })
        });
        selectedContacts.forEach((p) => delete contactGroups[p]);
        selectedContacts.clear();
        saveGroups();
        toast(`Deleted contacts.`, 'success');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ── Toggle active ──────────────────────────────────────────────────────
async function toggleActive(phone, currentlyActive) {
    try {
        await apiFetch('/api/contacts/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, updates: { is_active: !currentlyActive } })
        });
        toast(`Contact ${!currentlyActive ? 'activated' : 'deactivated'}.`, 'success');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ── Direct Send Modal ──────────────────────────────────────────────────
function openSendModal(phone, name, phones = null) {
    pendingSendAttachment = null;
    const display = phones
        ? `${phones.length} contacts selected`
        : `${name || ''} (${phone || ''})`;
    $('modal-send-phone-display').textContent = display;
    $('modal-send-phone-display').dataset.phone = phone || '';
    $('modal-send-phone-display').dataset.phones = phones ? JSON.stringify(phones) : '';
    $('modal-send-message').value = '';
    $('modal-send-attach-name').textContent = '';
    $('modal-send-attach-clear').hidden = true;
    $('modal-send').hidden = false;
    $('modal-send-message').focus();
}

$('modal-send-attach-btn').addEventListener('click', () => $('modal-send-file').click());
$('modal-send-file').addEventListener('change', async () => {
    const file = $('modal-send-file').files[0];
    if (!file) return;
    pendingSendAttachment = await fileToPayload(file, 'dashboard-upload');
    $('modal-send-attach-name').textContent = file.name;
    $('modal-send-attach-clear').hidden = false;
});
$('modal-send-attach-clear').addEventListener('click', () => {
    pendingSendAttachment = null;
    $('modal-send-file').value = '';
    $('modal-send-attach-name').textContent = '';
    $('modal-send-attach-clear').hidden = true;
});

async function submitDirectSend() {
    const message = $('modal-send-message').value.trim();
    if (!message) { toast('Message cannot be empty.', 'error'); return; }
    const display = $('modal-send-phone-display');
    const phonesJson = display.dataset.phones;
    let targets = [];
    if (phonesJson) {
        try { targets = JSON.parse(phonesJson); } catch (_) { targets = []; }
    } else {
        targets = [display.dataset.phone];
    }
    targets = targets.filter(Boolean);
    if (!targets.length) { toast('No phone number selected.', 'error'); return; }

    try {
        for (const phone of targets) {
            await apiFetch('/api/send/direct', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, message, attachment: pendingSendAttachment })
            });
        }
        toast(`Message sent to ${targets.length} contact(s).`, 'success');
        closeAllModals();
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ── Schedule Modal ─────────────────────────────────────────────────────
function openScheduleModal(phone, name, phones = null) {
    const display = phones ? `${phones.length} contacts` : `${name || ''} (${phone || ''})`;
    $('modal-schedule-phones-display').textContent = display;
    $('modal-schedule-phones-display').dataset.phone = phone || '';
    $('modal-schedule-phones-display').dataset.phones = phones ? JSON.stringify(phones) : '';
    $('modal-schedule-message').value = '';
    // default: 1 hour from now
    const dt = new Date(Date.now() + 3600000);
    $('modal-schedule-time').value = dt.toISOString().slice(0, 16);
    $('modal-schedule').hidden = false;
    $('modal-schedule-message').focus();
}

function saveScheduledMessage() {
    const message = $('modal-schedule-message').value.trim();
    const at = $('modal-schedule-time').value;
    if (!message || !at) { toast('Message and time are required.', 'error'); return; }
    const display = $('modal-schedule-phones-display');
    const phonesJson = display.dataset.phones;
    let phones = [];
    if (phonesJson) {
        try { phones = JSON.parse(phonesJson); } catch (_) {}
    } else {
        phones = [display.dataset.phone];
    }
    phones = phones.filter(Boolean);
    if (!phones.length) { toast('No phone selected.', 'error'); return; }

    const entry = { id: Date.now(), phones, message, at };
    scheduledMessages.push(entry);
    saveScheduled();
    renderScheduled();
    toast(`Scheduled for ${new Date(at).toLocaleString()}.`, 'success');
    closeAllModals();
}

// ── Scheduled messages panel ───────────────────────────────────────────
function renderScheduled() {
    const panel = $('scheduled-panel');
    if (!panel) return;
    if (!scheduledMessages.length) { panel.hidden = true; return; }
    panel.hidden = false;
    $('scheduled-list').innerHTML = scheduledMessages.map((s) => `
        <div class="scheduled-item">
            <div class="scheduled-info">
                <strong>${new Date(s.at).toLocaleString()}</strong>
                <span>${s.phones.length} contact(s)</span>
                <em>${esc(s.message.slice(0, 60))}</em>
            </div>
            <button type="button" class="danger-button btn-icon btn-del-scheduled" data-id="${s.id}">✕</button>
        </div>
    `).join('');
}

// Fire scheduled messages
function tickScheduled() {
    const now = Date.now();
    const due = scheduledMessages.filter((s) => new Date(s.at).getTime() <= now);
    if (!due.length) return;
    scheduledMessages = scheduledMessages.filter((s) => new Date(s.at).getTime() > now);
    saveScheduled();
    renderScheduled();
    due.forEach(async (s) => {
        for (const phone of s.phones) {
            try {
                await apiFetch('/api/send/direct', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone, message: s.message })
                });
            } catch (_) {}
        }
        toast(`Scheduled message sent to ${s.phones.length} contact(s).`, 'success');
    });
}

// ── Contacts panel: event delegation ──────────────────────────────────
$('contacts-list').addEventListener('click', (e) => {
    const card = e.target.closest('.contact-card');

    // Checkbox toggle
    const cb = e.target.closest('.contact-select');
    if (cb) {
        const phone = cb.dataset.phone;
        if (cb.checked) selectedContacts.add(phone);
        else selectedContacts.delete(phone);
        updateSelectionUI();
        if (card) card.classList.toggle('selected', cb.checked);
        return;
    }

    if (!card) return;
    const phone = card.dataset.phone;

    if (e.target.closest('.btn-send-direct')) {
        const btn = e.target.closest('.btn-send-direct');
        openSendModal(phone, btn.dataset.name);
        return;
    }
    if (e.target.closest('.btn-schedule-contact')) {
        const btn = e.target.closest('.btn-schedule-contact');
        openScheduleModal(phone, btn.dataset.name);
        return;
    }
    if (e.target.closest('.btn-toggle-active')) {
        const btn = e.target.closest('.btn-toggle-active');
        toggleActive(phone, btn.dataset.active === 'true').catch((err) => toast(err.message, 'error'));
        return;
    }
    if (e.target.closest('.btn-edit-contact')) {
        const btn = e.target.closest('.btn-edit-contact');
        openEditModal(phone, btn.dataset.name);
        return;
    }
    if (e.target.closest('.btn-delete-contact')) {
        deleteContactByPhone(phone).catch((err) => toast(err.message, 'error'));
        return;
    }
});

// Scheduled list: delete
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-del-scheduled');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    scheduledMessages = scheduledMessages.filter((s) => s.id !== id);
    saveScheduled();
    renderScheduled();
    toast('Scheduled message removed.', 'info');
});

// ── Select-all ─────────────────────────────────────────────────────────
$('contacts-select-all').addEventListener('change', (e) => {
    if (e.target.checked) {
        const filter = $('contacts-filter').value;
        const groupFilter = $('contacts-group-filter').value;
        const search = ($('contacts-search').value || '').toLowerCase();
        allContacts.filter((c) => {
            const ms = !search || (c.name || '').toLowerCase().includes(search) || (c.phone || '').includes(search);
            let mf = true;
            if (filter === 'active') mf = c.is_active !== false;
            else if (filter === 'inactive') mf = c.is_active === false;
            else if (filter === 'sent') mf = Boolean(c.last_sent_at);
            else if (filter === 'unsent') mf = !c.last_sent_at;
            const mg = !groupFilter || (contactGroups[c.phone] || '') === groupFilter;
            return ms && mf && mg;
        }).forEach((c) => selectedContacts.add(c.phone));
    } else {
        selectedContacts.clear();
    }
    renderContacts(allContacts);
});

// ── Bulk schedule ───────────────────────────────────────────────────────
$('btn-bulk-schedule').addEventListener('click', () => {
    if (!selectedContacts.size) return;
    openScheduleModal(null, null, [...selectedContacts]);
});

// ── Bulk delete ─────────────────────────────────────────────────────────
$('btn-bulk-delete').addEventListener('click', () => {
    bulkDelete().catch((err) => toast(err.message, 'error'));
});

// ── Add contact button ─────────────────────────────────────────────────
$('btn-add-contact').addEventListener('click', openAddModal);

// ── Settings ───────────────────────────────────────────────────────────
$('settings-btn').addEventListener('click', openSettingsModal);
$('settings-save').addEventListener('click', () => saveSettings().catch((err) => toast(err.message, 'error')));
$('settings-cancel').addEventListener('click', () => { $('modal-settings').hidden = true; });

// Apply saved app name on load
applyAppName();

// ── Freelance Settings ───────────────────────────────────────────────────
$('freelance-settings-btn').addEventListener('click', openFreelanceSettings);
$('fset-save').addEventListener('click', () => saveFreelanceSettings().catch((err) => toast(err.message, 'error')));
$('fset-cancel').addEventListener('click', () => { $('modal-freelance-settings').hidden = true; });
$('fset-reset-defaults').addEventListener('click', resetFreelanceDefaults);

// ── Export ─────────────────────────────────────────────────────────────
$('btn-export-csv').addEventListener('click', () => {
    exportContacts('csv').catch((err) => toast(err.message, 'error'));
});
$('btn-export-json').addEventListener('click', () => {
    exportContacts('json').catch((err) => toast(err.message, 'error'));
});

// ── Search & filter ─────────────────────────────────────────────────────
$('contacts-search').addEventListener('input', () => renderContacts(allContacts));
$('contacts-filter').addEventListener('change', () => renderContacts(allContacts));
$('contacts-group-filter').addEventListener('change', () => renderContacts(allContacts));

// ── Drag & Drop ─────────────────────────────────────────────────────────
const dropZone = $('contacts-drop-zone');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    try {
        const contacts = await parseContactFile(file);
        showImportPreview(contacts);
    } catch (err) {
        toast('Failed to parse file: ' + err.message, 'error');
    }
});

// File input change → preview
$('contacts-file').addEventListener('change', async () => {
    const file = $('contacts-file').files[0];
    if (!file) return;
    try {
        const contacts = await parseContactFile(file);
        showImportPreview(contacts);
    } catch (err) {
        toast('Failed to parse file: ' + err.message, 'error');
    }
    $('contacts-file').value = '';
});

// ── Import preview modal ───────────────────────────────────────────────
$('modal-preview-import').addEventListener('click', async () => {
    try {
        const contacts = JSON.parse($('modal-preview-import').dataset.contacts || '[]');
        const result = await apiFetch('/api/contacts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contacts })
        });
        toast(`Imported ${result.imported} contacts.`, 'success');
        closeAllModals();
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
});
$('modal-preview-cancel').addEventListener('click', closeAllModals);

// ── Add/Edit modal actions ─────────────────────────────────────────────
$('modal-contact-save').addEventListener('click', () => {
    saveContactModal().catch((err) => toast(err.message, 'error'));
});
$('modal-contact-cancel').addEventListener('click', closeAllModals);

// ── Send modal actions ─────────────────────────────────────────────────
$('modal-send-submit').addEventListener('click', () => {
    submitDirectSend().catch((err) => toast(err.message, 'error'));
});
$('modal-send-cancel').addEventListener('click', closeAllModals);

// ── Schedule modal actions ─────────────────────────────────────────────
$('modal-schedule-save').addEventListener('click', saveScheduledMessage);
$('modal-schedule-cancel').addEventListener('click', closeAllModals);

// ── Close modal on overlay click ───────────────────────────────────────
['modal-contact', 'modal-send', 'modal-preview', 'modal-schedule'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
        if (e.target === el) closeAllModals();
    });
});

// Scheduled panel close
if ($('scheduled-panel-close')) {
    $('scheduled-panel-close').addEventListener('click', () => {
        $('scheduled-panel').hidden = true;
    });
}

// ── Existing agent controls ────────────────────────────────────────────
$('refresh-all').addEventListener('click', refresh);
$('run-blast').addEventListener('click', () => {
    runBlast().catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('run-scout').addEventListener('click', () => {
    runScout().catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('wa-attach-button').addEventListener('click', () => $('wa-file-input').click());
$('freelance-attach-button').addEventListener('click', () => $('freelance-file-input').click());
$('wa-file-input').addEventListener('change', () => {
    const file = $('wa-file-input').files[0];
    if (!file) return;
    storePickedFile('whatsapp', file).catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('freelance-file-input').addEventListener('change', () => {
    const file = $('freelance-file-input').files[0];
    if (!file) return;
    storePickedFile('freelance', file).catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('wa-voice-button').addEventListener('click', () => {
    toggleVoiceRecording('whatsapp').catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('freelance-voice-button').addEventListener('click', () => {
    toggleVoiceRecording('freelance').catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('wa-clear-upload').addEventListener('click', () => clearUpload('whatsapp'));
$('freelance-clear-upload').addEventListener('click', () => clearUpload('freelance'));

$('wa-clear-conversation').addEventListener('click', async () => {
    if (!confirm('Clear the entire WhatsApp conversation history?')) return;
    await apiFetch('/api/manager/clear', { method: 'POST' });
    $('wa-conversation').innerHTML = '<article class="message-bubble assistant"><strong>ASSISTANT</strong><div>Conversation cleared.</div></article>';
    toast('WhatsApp conversation cleared.', 'success');
});

$('freelance-clear-conversation').addEventListener('click', async () => {
    if (!confirm('Clear the entire Freelance conversation history?')) return;
    await apiFetch('/api/freelance/clear', { method: 'POST' });
    $('freelance-conversation').innerHTML = '<article class="message-bubble assistant"><strong>ASSISTANT</strong><div>Conversation cleared.</div></article>';
    toast('Freelance conversation cleared.', 'success');
});
$('wa-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitChat('whatsapp').catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('freelance-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitChat('freelance').catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});
$('open-freelance-dashboard').addEventListener('click', () => {
    const url = $('open-freelance-dashboard').dataset.url;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
});
$('freelance-jobs').addEventListener('click', (e) => {
    const button = e.target.closest('[data-job-action]');
    if (!button) return;
    setJobAction(button.dataset.jobId, button.dataset.jobAction).catch((err) => { $('workspace-errors').hidden = false; $('workspace-errors').textContent = err.message; });
});

// ── Dark mode toggle ───────────────────────────────────────────────────
if ($('dark-mode-toggle')) {
    $('dark-mode-toggle').addEventListener('click', () => {
        const isDark = !document.body.classList.contains('light-mode');
        applyTheme(!isDark);
    });
}

// ── Init ────────────────────────────────────────────────────────────────
loadGroups();
loadScheduled();
renderScheduled();

// Apply saved theme
applyTheme(localStorage.getItem('dashboard_theme') !== 'light');

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(tickScheduled, 60000); // check scheduled messages every minute
