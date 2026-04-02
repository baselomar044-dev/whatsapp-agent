require('dotenv').config();
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
    sendTime: '09:00',
    minMessages: 30,
    maxMessages: 40,
    minDelaySeconds: 15,
    maxDelaySeconds: 45,
    dashboardHost: '127.0.0.1',
    dashboardPort: 3001,
    manualTriggerPollMs: 30000,
    whatsappSessionPath: './session',
    recentLogLimit: 12,
    previewName: 'Sample Contact',
    previewPhone: '971500000000',
    headless: true,
    managerEnabled: true,
    managerName: 'WhatsApp Manager',
    managerStoragePath: './storage/manager',
    managerHistoryLimit: 12,
    managerRecentAttachmentLimit: 10,
    managerAutoSaveIncomingMedia: true,
    managerReplyPrefix: '',
    groqModel: 'llama-3.3-70b-versatile'
};

function requiredString(env, key) {
    const value = String(env[key] || '').trim();

    if (!value) {
        throw new Error(`${key} must be provided in .env`);
    }

    return value;
}

function parseIntegerSetting(value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function normalizeSendTime(value, fallback = DEFAULTS.sendTime) {
    const candidate = String(value || '').trim();

    if (!/^\d{1,2}:\d{2}$/.test(candidate)) {
        return fallback;
    }

    const [hour, minute] = candidate.split(':').map(Number);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return fallback;
    }

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeRange(minValue, maxValue) {
    return {
        min: Math.min(minValue, maxValue),
        max: Math.max(minValue, maxValue)
    };
}

function parseBooleanSetting(value, fallback) {
    if (value === undefined) {
        return fallback;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return fallback;
}

function parseStringList(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeAuthorizedNumbers(value) {
    return parseStringList(value)
        .map((item) => item.replace(/[^\d]/g, ''))
        .filter(Boolean);
}

function resolveBrowserExecutablePath(env = process.env) {
    const explicitPath = String(env.CHROME_EXECUTABLE_PATH || env.PUPPETEER_EXECUTABLE_PATH || '').trim();

    if (explicitPath) {
        return fs.existsSync(explicitPath) ? explicitPath : undefined;
    }

    if (process.platform !== 'win32') {
        return undefined;
    }

    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];

    return candidates.find((candidate) => fs.existsSync(candidate));
}

function getDashboardUrl(host, port) {
    const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    return `http://${publicHost}:${port}`;
}

function buildConfig(env = process.env) {
    const messageRange = normalizeRange(
        parseIntegerSetting(env.MIN_MESSAGES, DEFAULTS.minMessages, { min: 1, max: 100000 }),
        parseIntegerSetting(env.MAX_MESSAGES, DEFAULTS.maxMessages, { min: 1, max: 100000 })
    );
    const delayRange = normalizeRange(
        parseIntegerSetting(env.MIN_DELAY_SECONDS, DEFAULTS.minDelaySeconds, { min: 0, max: 3600 }),
        parseIntegerSetting(env.MAX_DELAY_SECONDS, DEFAULTS.maxDelaySeconds, { min: 0, max: 3600 })
    );
    const dashboardHost = String(env.DASHBOARD_HOST || DEFAULTS.dashboardHost).trim() || DEFAULTS.dashboardHost;
    const dashboardPort = parseIntegerSetting(env.DASHBOARD_PORT || env.PORT, DEFAULTS.dashboardPort, { min: 1, max: 65535 });

    return {
        supabaseUrl: requiredString(env, 'SUPABASE_URL'),
        supabaseKey: requiredString(env, 'SUPABASE_KEY'),
        whatsappSessionPath: String(env.WHATSAPP_SESSION_PATH || DEFAULTS.whatsappSessionPath).trim() || DEFAULTS.whatsappSessionPath,
        sendTime: normalizeSendTime(env.SEND_TIME, DEFAULTS.sendTime),
        minMessages: messageRange.min,
        maxMessages: messageRange.max,
        minDelaySeconds: delayRange.min,
        maxDelaySeconds: delayRange.max,
        dashboardHost,
        dashboardPort,
        dashboardUrl: getDashboardUrl(dashboardHost, dashboardPort),
        manualTriggerPollMs: parseIntegerSetting(env.MANUAL_TRIGGER_POLL_MS, DEFAULTS.manualTriggerPollMs, { min: 5000, max: 3600000 }),
        recentLogLimit: parseIntegerSetting(env.RECENT_LOG_LIMIT, DEFAULTS.recentLogLimit, { min: 1, max: 100 }),
        previewContact: {
            name: String(env.PREVIEW_CONTACT_NAME || DEFAULTS.previewName).trim() || DEFAULTS.previewName,
            phone: String(env.PREVIEW_CONTACT_PHONE || DEFAULTS.previewPhone).trim() || DEFAULTS.previewPhone
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        chromeExecutablePath: resolveBrowserExecutablePath(env),
        headless: parseBooleanSetting(env.WHATSAPP_HEADLESS, DEFAULTS.headless),
        manager: {
            enabled: parseBooleanSetting(env.MANAGER_ENABLED, DEFAULTS.managerEnabled),
            name: String(env.MANAGER_NAME || DEFAULTS.managerName).trim() || DEFAULTS.managerName,
            storagePath: String(env.MANAGER_STORAGE_PATH || DEFAULTS.managerStoragePath).trim() || DEFAULTS.managerStoragePath,
            historyLimit: parseIntegerSetting(env.MANAGER_HISTORY_LIMIT, DEFAULTS.managerHistoryLimit, { min: 4, max: 50 }),
            recentAttachmentLimit: parseIntegerSetting(env.MANAGER_RECENT_ATTACHMENT_LIMIT, DEFAULTS.managerRecentAttachmentLimit, { min: 1, max: 50 }),
            autoSaveIncomingMedia: parseBooleanSetting(env.MANAGER_AUTO_SAVE_INCOMING_MEDIA, DEFAULTS.managerAutoSaveIncomingMedia),
            replyPrefix: String(env.MANAGER_REPLY_PREFIX || DEFAULTS.managerReplyPrefix),
            authorizedNumbers: normalizeAuthorizedNumbers(env.WHATSAPP_MANAGER_NUMBERS),
            groqApiKey: String(env.GROQ_API_KEY || '').trim(),
            model: String(env.GROQ_MODEL || DEFAULTS.groqModel).trim() || DEFAULTS.groqModel,
            systemPrompt: String(env.MANAGER_SYSTEM_PROMPT || '').trim()
        },
        dashboardPassword: String(env.DASHBOARD_PASSWORD || '').trim()
    };
}

function toPublicDashboardConfig(config) {
    return {
        host: config.dashboardHost,
        port: config.dashboardPort,
        url: config.dashboardUrl,
        timezone: config.timezone,
        sendTime: config.sendTime,
        minMessages: config.minMessages,
        maxMessages: config.maxMessages,
        minDelaySeconds: config.minDelaySeconds,
        maxDelaySeconds: config.maxDelaySeconds,
        sessionPath: config.whatsappSessionPath,
        browser: config.chromeExecutablePath ? path.basename(config.chromeExecutablePath) : 'Auto-detect',
        managerEnabled: config.manager.enabled,
        managerAuthorizedCount: config.manager.authorizedNumbers.length,
        managerModel: config.manager.model,
        managerProvider: 'Groq'
    };
}

const appConfig = buildConfig();

module.exports = {
    DEFAULTS,
    appConfig,
    buildConfig,
    getDashboardUrl,
    normalizeSendTime,
    parseIntegerSetting,
    parseStringList,
    resolveBrowserExecutablePath,
    toPublicDashboardConfig
};
