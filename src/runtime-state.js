const { appConfig } = require('./config');
const QRCode = require('qrcode');

const MAX_EVENTS = 60;

const state = {
    startedAt: new Date().toISOString(),
    appStatus: 'starting',
    whatsapp: {
        status: 'initializing',
        qrUrl: null,
        qrUpdatedAt: null,
        authenticatedAt: null,
        readyAt: null,
        lastError: null,
        lastDisconnectReason: null
    },
    scheduler: {
        sendTime: process.env.SEND_TIME || '09:00',
        cronSchedule: null,
        nextRunAt: null,
        lastRunAt: null
    },
    blast: {
        status: 'idle',
        trigger: null,
        targetedContacts: 0,
        processedContacts: 0,
        successCount: 0,
        failureCount: 0,
        startedAt: null,
        finishedAt: null,
        lastMessageAt: null,
        note: null
    },
    manager: {
        enabled: appConfig.manager.enabled,
        status: appConfig.manager.enabled ? 'idle' : 'disabled',
        authorizedNumbers: appConfig.manager.authorizedNumbers.length,
        provider: 'Groq',
        model: appConfig.manager.model,
        aiConfigured: Boolean(appConfig.manager.groqApiKey),
        conversationsHandled: 0,
        savedAttachments: 0,
        lastInboundAt: null,
        lastReplyAt: null,
        lastAttachmentAt: null,
        lastManagerChat: null,
        lastCommand: null,
        note: appConfig.manager.enabled
            ? 'Manager agent is waiting for WhatsApp to become ready.'
            : 'Manager agent is disabled.'
    },
    events: []
};

function nowIso() {
    return new Date().toISOString();
}

function computeNextRunAt(sendTime) {
    if (!sendTime || !sendTime.includes(':')) {
        return null;
    }

    const [hour, minute] = sendTime.split(':').map(Number);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        return null;
    }

    const nextRun = new Date();
    nextRun.setSeconds(0, 0);
    nextRun.setHours(hour, minute, 0, 0);

    if (nextRun <= new Date()) {
        nextRun.setDate(nextRun.getDate() + 1);
    }

    return nextRun.toISOString();
}

function pushEvent(source, message, level = 'info', meta = {}) {
    state.events.unshift({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: nowIso(),
        source,
        level,
        message,
        meta
    });
    state.events = state.events.slice(0, MAX_EVENTS);
}

function setAppStatus(status, message) {
    state.appStatus = status;

    if (message) {
        const level = status === 'error' ? 'error' : 'info';
        pushEvent('app', message, level);
    }
}

function setWhatsAppQr(qr) {
    // Generate QR as base64 data URI (fast, no external API)
    QRCode.toDataURL(qr, { width: 400, margin: 2 })
        .then(dataUrl => {
            state.whatsapp.qrUrl = dataUrl;
        })
        .catch(() => {
            // Fallback to external API if local generation fails
            state.whatsapp.qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
        });
    // Set status immediately, URL arrives async but nearly instant
    state.whatsapp.status = 'qr_required';
    state.whatsapp.qrUpdatedAt = nowIso();
    state.whatsapp.lastError = null;
    pushEvent('whatsapp', 'QR code generated. Scan it to connect the bot.');
    return 'generating...';
}

function markWhatsAppAuthenticated() {
    state.whatsapp.status = 'authenticated';
    state.whatsapp.qrUrl = null;
    state.whatsapp.qrUpdatedAt = null;
    state.whatsapp.authenticatedAt = nowIso();
    state.whatsapp.lastError = null;
    pushEvent('whatsapp', 'WhatsApp session authenticated.');
}

function markWhatsAppReady() {
    state.whatsapp.status = 'ready';
    state.whatsapp.qrUrl = null;
    state.whatsapp.qrUpdatedAt = null;
    state.whatsapp.readyAt = nowIso();
    state.whatsapp.lastError = null;
    pushEvent('whatsapp', 'WhatsApp client is ready.');
}

function markWhatsAppAuthFailure(message) {
    state.whatsapp.status = 'auth_failure';
    state.whatsapp.lastError = message;
    pushEvent('whatsapp', `Authentication failed: ${message}`, 'error');
}

function markWhatsAppDisconnected(reason) {
    state.whatsapp.status = 'disconnected';
    state.whatsapp.lastDisconnectReason = reason || 'Unknown reason';
    pushEvent('whatsapp', `WhatsApp disconnected: ${state.whatsapp.lastDisconnectReason}`, 'warn');
}

function setSchedulerState(sendTime, cronSchedule) {
    state.scheduler.sendTime = sendTime;
    state.scheduler.cronSchedule = cronSchedule;
    state.scheduler.nextRunAt = computeNextRunAt(sendTime);
    pushEvent('scheduler', `Daily blast scheduled for ${sendTime} (${cronSchedule}).`);
}

function markSchedulerTrigger(trigger) {
    state.scheduler.lastRunAt = nowIso();

    if (trigger === 'scheduled') {
        state.scheduler.nextRunAt = computeNextRunAt(state.scheduler.sendTime);
    }

    pushEvent('scheduler', `Blast trigger received from ${trigger}.`);
}

function startBlast(targetedContacts, trigger = 'manual') {
    state.blast = {
        status: 'running',
        trigger,
        targetedContacts,
        processedContacts: 0,
        successCount: 0,
        failureCount: 0,
        startedAt: nowIso(),
        finishedAt: null,
        lastMessageAt: null,
        note: null
    };

    pushEvent('blast', `Starting ${trigger} blast for ${targetedContacts} contacts.`);
}

function recordMessageResult(phoneNumber, status, detail = '') {
    state.blast.lastMessageAt = nowIso();

    if (state.blast.status === 'running') {
        state.blast.processedContacts += 1;

        if (status === 'sent') {
            state.blast.successCount += 1;
        } else if (status === 'failed') {
            state.blast.failureCount += 1;
        }
    }

    const level = status === 'failed' ? 'warn' : 'info';
    const suffix = detail ? ` (${detail})` : '';
    pushEvent('message', `${status.toUpperCase()} ${phoneNumber}${suffix}`, level);
}

function finishBlast({ targetedContacts, successCount, failureCount, note }) {
    state.blast.status = 'completed';
    state.blast.targetedContacts = targetedContacts;
    state.blast.processedContacts = successCount + failureCount;
    state.blast.successCount = successCount;
    state.blast.failureCount = failureCount;
    state.blast.finishedAt = nowIso();
    state.blast.note = note || null;

    const summary = note || `Blast finished with ${successCount}/${targetedContacts} successful sends.`;
    const level = failureCount > 0 ? 'warn' : 'info';
    pushEvent('blast', summary, level);
}

function recordRuntimeError(source, error) {
    const message = error instanceof Error ? error.message : String(error);
    pushEvent(source, message, 'error');
}

function setManagerStatus(status, note) {
    state.manager.status = status;

    if (note) {
        state.manager.note = note;
        pushEvent('manager', note, status === 'error' ? 'error' : 'info');
    }
}

function recordManagerInbound({ chatId = null, fromManager = false, command = null }) {
    state.manager.lastInboundAt = nowIso();
    state.manager.lastManagerChat = chatId;

    if (fromManager) {
        state.manager.conversationsHandled += 1;
    }

    if (command) {
        state.manager.lastCommand = command;
    }
}

function recordManagerReply(note) {
    state.manager.lastReplyAt = nowIso();

    if (note) {
        state.manager.note = note;
    }
}

function recordManagerAttachment() {
    state.manager.savedAttachments += 1;
    state.manager.lastAttachmentAt = nowIso();
}

function getRuntimeSnapshot() {
    return {
        startedAt: state.startedAt,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000)),
        appStatus: state.appStatus,
        whatsapp: { ...state.whatsapp },
        scheduler: { ...state.scheduler },
        blast: { ...state.blast },
        manager: { ...state.manager },
        events: state.events.map((event) => ({ ...event }))
    };
}

module.exports = {
    getRuntimeSnapshot,
    markSchedulerTrigger,
    markWhatsAppAuthenticated,
    markWhatsAppAuthFailure,
    markWhatsAppDisconnected,
    markWhatsAppReady,
    pushEvent,
    recordMessageResult,
    recordRuntimeError,
    recordManagerAttachment,
    recordManagerInbound,
    recordManagerReply,
    setAppStatus,
    setManagerStatus,
    setSchedulerState,
    setWhatsAppQr,
    startBlast,
    finishBlast,
    computeNextRunAt
};
