require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { appConfig } = require('./config');
const {
    getLocalContacts,
    getLocalLogs,
    getLocalSettings,
    saveLocalContacts,
    saveLocalLogs,
    saveLocalSettings
} = require('./local-persistence');
const { DEFAULT_MESSAGE_TEMPLATE } = require('./message-template');

const supabase = createClient(appConfig.supabaseUrl, appConfig.supabaseKey);

function isMissingTableError(error) {
    return Boolean(error && /could not find the table|relation .* does not exist/i.test(String(error.message || error)));
}

function logSupabaseFallback(operation, error) {
    const message = String(error?.message || error || 'unknown error');
    console.warn(`[database] Supabase ${operation} failed. Falling back to local storage. Reason: ${message}`);
}

function sortContactsByLastSent(items) {
    return [...items].sort((left, right) => {
        if (!left.last_sent_at && right.last_sent_at) {
            return -1;
        }

        if (left.last_sent_at && !right.last_sent_at) {
            return 1;
        }

        const leftTime = left.last_sent_at ? new Date(left.last_sent_at).getTime() : 0;
        const rightTime = right.last_sent_at ? new Date(right.last_sent_at).getTime() : 0;
        return leftTime - rightTime;
    });
}

function getLocalLogsInRange(startIso, endIso) {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();

    return getLocalLogs().filter((log) => {
        const timestamp = new Date(log.sent_at || 0).getTime();
        return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
    });
}

function getLocalDayBounds(dateInput = new Date()) {
    const date = typeof dateInput === 'string'
        ? new Date(`${dateInput}T00:00:00`)
        : new Date(dateInput);

    if (Number.isNaN(date.getTime())) {
        throw new Error('A valid date is required to calculate daily report bounds.');
    }

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);

    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    return {
        startIso: start.toISOString(),
        endIso: end.toISOString()
    };
}

async function getActiveContacts() {
    const { data, error } = await supabase
        .from('whatsapp_contacts')
        .select('name, phone, last_sent_at, is_active')
        .eq('is_active', true)
        .order('last_sent_at', { ascending: true, nullsFirst: true });

    if (!error) {
        return data;
    }

    logSupabaseFallback('getActiveContacts', error);

    return sortContactsByLastSent(getLocalContacts().filter((contact) => contact.is_active !== false));
}

async function updateLastSent(phone, sentAt = new Date().toISOString()) {
    const { error } = await supabase
        .from('whatsapp_contacts')
        .update({ last_sent_at: sentAt })
        .eq('phone', phone);

    if (!error) {
        return;
    }

    logSupabaseFallback('updateLastSent', error);

    const contacts = getLocalContacts();
    const nextContacts = contacts.map((contact) => (
        contact.phone === phone
            ? { ...contact, last_sent_at: sentAt }
            : contact
    ));
    saveLocalContacts(nextContacts);
}

async function logMessage(phone, status, content = '', sentAt = new Date().toISOString()) {
    const { error } = await supabase
        .from('whatsapp_logs')
        .insert([{
            phone,
            status,
            message_content: content,
            sent_at: sentAt
        }]);

    if (!error) {
        return;
    }

    logSupabaseFallback('logMessage', error);

    const logs = getLocalLogs();
    logs.unshift({
        phone,
        status,
        message_content: content,
        sent_at: sentAt
    });
    saveLocalLogs(logs.slice(0, 1000));
}

async function getDailyReport(date = new Date()) {
    const { startIso, endIso } = getLocalDayBounds(date);

    const { data, error } = await supabase
        .from('whatsapp_logs')
        .select('*')
        .gte('sent_at', startIso)
        .lte('sent_at', endIso);

    if (!error) {
        return data;
    }

    logSupabaseFallback('getDailyReport', error);

    return getLocalLogsInRange(startIso, endIso);
}

async function getContactStats() {
    const [totalResult, activeResult] = await Promise.all([
        supabase
            .from('whatsapp_contacts')
            .select('*', { count: 'exact', head: true }),
        supabase
            .from('whatsapp_contacts')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
    ]);

    if (!totalResult.error && !activeResult.error) {
        return {
            total: totalResult.count || 0,
            active: activeResult.count || 0,
            inactive: Math.max((totalResult.count || 0) - (activeResult.count || 0), 0)
        };
    }

    if (totalResult.error) logSupabaseFallback('getContactStats(total)', totalResult.error);
    if (activeResult.error) logSupabaseFallback('getContactStats(active)', activeResult.error);

    const contacts = getLocalContacts();
    const active = contacts.filter((contact) => contact.is_active !== false).length;

    return {
        total: contacts.length,
        active,
        inactive: Math.max(contacts.length - active, 0)
    };
}

async function getContacts(limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 5000);
    const { data, error } = await supabase
        .from('whatsapp_contacts')
        .select('name, phone, is_active, last_sent_at')
        .order('name', { ascending: true })
        .limit(safeLimit);

    if (!error) {
        return data;
    }

    logSupabaseFallback('getContacts', error);

    return getLocalContacts()
        .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
        .slice(0, safeLimit);
}

const MAX_CONTACTS = 10000;

async function upsertContacts(contacts) {
    if (!Array.isArray(contacts) || contacts.length === 0) {
        return 0;
    }

    let payload = contacts
        .map((contact) => ({
            name: String(contact.name || '').trim(),
            phone: String(contact.phone || '').trim(),
            is_active: contact.is_active !== false
        }))
        .filter((contact) => contact.name && contact.phone);

    if (!payload.length) {
        return 0;
    }

    // Enforce 10000 contact limit — allow updates to existing, limit new entries
    try {
        const stats = await getContactStats();
        const existingLocal = getLocalContacts();
        const existingPhones = new Set([
            ...existingLocal.map((c) => c.phone)
        ]);
        const newOnes = payload.filter((c) => !existingPhones.has(c.phone));
        const updates = payload.filter((c) => existingPhones.has(c.phone));
        const available = Math.max(0, MAX_CONTACTS - (stats.total || existingPhones.size));
        payload = [...updates, ...newOnes.slice(0, available)];
    } catch (_err) {
        // if stats fail, just clamp total payload
        payload = payload.slice(0, MAX_CONTACTS);
    }

    if (!payload.length) {
        return 0;
    }

    const { error } = await supabase
        .from('whatsapp_contacts')
        .upsert(payload, { onConflict: 'phone' });

    if (!error) {
        return payload.length;
    }

    logSupabaseFallback('upsertContacts', error);

    const existing = getLocalContacts();
    const byPhone = new Map(existing.map((contact) => [contact.phone, contact]));

    for (const contact of payload) {
        byPhone.set(contact.phone, {
            ...byPhone.get(contact.phone),
            ...contact,
            last_sent_at: byPhone.get(contact.phone)?.last_sent_at || null
        });
    }

    saveLocalContacts([...byPhone.values()]);
    return payload.length;
}

async function deleteContact(phone) {
    const phoneStr = String(phone || '').trim();
    if (!phoneStr) return;

    const { error } = await supabase
        .from('whatsapp_contacts')
        .delete()
        .eq('phone', phoneStr);

    if (!error) return;

    logSupabaseFallback('deleteContact', error);

    saveLocalContacts(getLocalContacts().filter((c) => c.phone !== phoneStr));
}

async function deleteContacts(phones) {
    const phoneList = (phones || []).map((p) => String(p || '').trim()).filter(Boolean);
    if (!phoneList.length) return 0;

    const { error } = await supabase
        .from('whatsapp_contacts')
        .delete()
        .in('phone', phoneList);

    if (!error) return phoneList.length;

    logSupabaseFallback('deleteContacts', error);

    const phoneSet = new Set(phoneList);
    saveLocalContacts(getLocalContacts().filter((c) => !phoneSet.has(c.phone)));
    return phoneList.length;
}

async function updateContact(phone, updates) {
    const phoneStr = String(phone || '').trim();
    if (!phoneStr) return;

    const patch = {};
    if (updates.name !== undefined) patch.name = String(updates.name || '').trim();
    if (updates.phone !== undefined && updates.phone !== phoneStr) patch.phone = String(updates.phone || '').trim();
    if (updates.is_active !== undefined) patch.is_active = Boolean(updates.is_active);
    if (!Object.keys(patch).length) return;

    const { error } = await supabase
        .from('whatsapp_contacts')
        .update(patch)
        .eq('phone', phoneStr);

    if (!error) return;

    logSupabaseFallback('updateContact', error);

    saveLocalContacts(getLocalContacts().map((c) => (c.phone === phoneStr ? { ...c, ...patch } : c)));
}

async function getRecentLogs(limit = 12) {
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100);
    const { data, error } = await supabase
        .from('whatsapp_logs')
        .select('phone, status, message_content, sent_at')
        .order('sent_at', { ascending: false })
        .limit(safeLimit);

    if (!error) {
        return data;
    }

    logSupabaseFallback('getRecentLogs', error);

    return getLocalLogs().slice(0, safeLimit);
}

async function getDailyLogStats(date = new Date()) {
    const logs = await getDailyReport(date);

    return logs.reduce((stats, log) => {
        const status = (log.status || '').toLowerCase();

        stats.total += 1;

        if (status === 'sent' || status === 'success') {
            stats.sent += 1;
        } else if (status === 'failed') {
            stats.failed += 1;
        } else {
            stats.other += 1;
        }

        return stats;
    }, {
        total: 0,
        sent: 0,
        failed: 0,
        other: 0
    });
}

async function getAppSetting(key, fallbackValue = null) {
    const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();

    if (!error) {
        return data?.value ?? fallbackValue;
    }

    logSupabaseFallback('getAppSetting', error);

    const settings = getLocalSettings();
    return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallbackValue;
}

async function upsertAppSetting(key, value) {
    const { error } = await supabase
        .from('app_settings')
        .upsert({ key, value }, { onConflict: 'key' });

    if (!error) {
        return;
    }

    logSupabaseFallback('upsertAppSetting', error);

    const settings = getLocalSettings();
    settings[key] = value;
    saveLocalSettings(settings);
}

async function getMessageTemplate() {
    return getAppSetting('blaster_message', DEFAULT_MESSAGE_TEMPLATE);
}

async function getAutomationSettings() {
    const [messageTemplate, sendTime, minMessages, maxMessages, scheduleEnabled] = await Promise.all([
        getMessageTemplate(),
        getAppSetting('automation_send_time', appConfig.sendTime),
        getAppSetting('automation_min_messages', String(appConfig.minMessages)),
        getAppSetting('automation_max_messages', String(appConfig.maxMessages)),
        getAppSetting('automation_schedule_enabled', 'true')
    ]);

    return {
        messageTemplate,
        sendTime: String(sendTime || appConfig.sendTime),
        minMessages: Number.parseInt(minMessages, 10) || appConfig.minMessages,
        maxMessages: Number.parseInt(maxMessages, 10) || appConfig.maxMessages,
        scheduleEnabled: String(scheduleEnabled).toLowerCase() !== 'false'
    };
}

module.exports = {
    supabase,
    getAppSetting,
    getAutomationSettings,
    getContacts,
    getActiveContacts,
    getContactStats,
    getDailyLogStats,
    getLocalDayBounds,
    getMessageTemplate,
    updateLastSent,
    logMessage,
    getDailyReport,
    getRecentLogs,
    upsertAppSetting,
    upsertContacts,
    deleteContact,
    deleteContacts,
    updateContact,
    MAX_CONTACTS
};
