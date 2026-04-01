require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { appConfig } = require('./config');
const { DEFAULT_MESSAGE_TEMPLATE } = require('./message-template');

const supabase = createClient(appConfig.supabaseUrl, appConfig.supabaseKey);

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
        .select('name, phone, last_sent_at')
        .eq('is_active', true)
        .order('last_sent_at', { ascending: true, nullsFirst: true });

    if (error) throw error;
    return data;
}

async function updateLastSent(phone, sentAt = new Date().toISOString()) {
    const { error } = await supabase
        .from('whatsapp_contacts')
        .update({ last_sent_at: sentAt })
        .eq('phone', phone);

    if (error) throw error;
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

    if (error) throw error;
}

async function getDailyReport(date = new Date()) {
    const { startIso, endIso } = getLocalDayBounds(date);

    const { data, error } = await supabase
        .from('whatsapp_logs')
        .select('*')
        .gte('sent_at', startIso)
        .lte('sent_at', endIso);

    if (error) throw error;
    return data;
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

    if (totalResult.error) throw totalResult.error;
    if (activeResult.error) throw activeResult.error;

    return {
        total: totalResult.count || 0,
        active: activeResult.count || 0,
        inactive: Math.max((totalResult.count || 0) - (activeResult.count || 0), 0)
    };
}

async function getRecentLogs(limit = 12) {
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100);
    const { data, error } = await supabase
        .from('whatsapp_logs')
        .select('phone, status, message_content, sent_at')
        .order('sent_at', { ascending: false })
        .limit(safeLimit);

    if (error) throw error;
    return data;
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

    if (error) throw error;
    return data?.value ?? fallbackValue;
}

async function upsertAppSetting(key, value) {
    const { error } = await supabase
        .from('app_settings')
        .upsert({ key, value }, { onConflict: 'key' });

    if (error) throw error;
}

async function getMessageTemplate() {
    return getAppSetting('blaster_message', DEFAULT_MESSAGE_TEMPLATE);
}

module.exports = {
    supabase,
    getAppSetting,
    getActiveContacts,
    getContactStats,
    getDailyLogStats,
    getLocalDayBounds,
    getMessageTemplate,
    updateLastSent,
    logMessage,
    getDailyReport,
    getRecentLogs,
    upsertAppSetting
};
