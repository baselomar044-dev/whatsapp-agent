const path = require('path');

const Groq = require('groq-sdk');

const { appConfig } = require('./config');
const { getAutomationSettings, getContactStats, getDailyLogStats, upsertAppSetting } = require('./database');
const { listRecentAttachments, getAttachmentStats, getLatestAttachmentForChat, saveAttachmentRecord, getChatHistory, appendChatHistory, ensureManagerStorage } = require('./manager-storage');
const { normalizePhoneNumber } = require('./phone');
const {
    getRuntimeSnapshot,
    pushEvent,
    recordRuntimeError,
    recordManagerAttachment,
    recordManagerInbound,
    recordManagerReply,
    setManagerStatus
} = require('./runtime-state');
const { isBlastRunning, reconfigureScheduler, runDailyBlast } = require('./scheduler');

const groqClient = appConfig.manager.groqApiKey
    ? new Groq({ apiKey: appConfig.manager.groqApiKey })
    : null;

const ignoredOutgoingIds = new Set();

function rememberOutgoingMessage(message) {
    const messageId = message?.id?._serialized;

    if (!messageId) {
        return;
    }

    ignoredOutgoingIds.add(messageId);
    setTimeout(() => ignoredOutgoingIds.delete(messageId), 10 * 60 * 1000);
}

function isIgnoredOutgoingMessage(message) {
    const messageId = message?.id?._serialized;
    return Boolean(messageId && ignoredOutgoingIds.has(messageId));
}

function getChatId(message) {
    return message.fromMe ? message.to : message.from;
}

function getSenderId(message) {
    return message.author || message.from || message.to || '';
}

function isGroupChatId(chatId) {
    return String(chatId || '').endsWith('@g.us');
}

function isSelfManagerMessage(message, ownWid) {
    if (!message.fromMe || !ownWid) {
        return false;
    }

    const chatId = getChatId(message);
    return normalizePhoneNumber(chatId) === normalizePhoneNumber(ownWid);
}

function isAuthorizedManagerMessage(message, ownWid) {
    if (isIgnoredOutgoingMessage(message)) {
        return false;
    }

    if (isSelfManagerMessage(message, ownWid)) {
        return true;
    }

    if (message.fromMe) {
        return false;
    }

    const senderPhone = normalizePhoneNumber(getSenderId(message));
    return appConfig.manager.authorizedNumbers.includes(senderPhone);
}

function buildHelpText() {
    return [
        `${appConfig.manager.name} | أوامر وكيل الواتساب:`,
        '- status | الحالة',
        '- help | مساعدة',
        '- contacts | جهات الاتصال',
        '- attachments | المرفقات',
        '- blast now | ابدأ الإرسال',
        '- automation | إعدادات الأتمتة',
        '- set message | ضع الرسالة',
        '- set time 09:00',
        '- set range 20 40',
        '- schedule on | schedule off',
        '- send 9715XXXXXXXX | your message',
        '- send to 9715XXXXXXXX | your message',
        '- sendfile 9715XXXXXXXX | optional caption',
        '- file to 9715XXXXXXXX | optional caption',
        '- voice 9715XXXXXXXX | optional caption  (uses uploaded voice/file)',
        '',
        'Attach a file or record a voice note in the chat box, then use sendfile/file/voice to deliver it.',
        'ارفع ملفاً أو سجل voice note من صندوق المحادثة ثم استخدم أوامر file أو voice لإرسالها.',
        '',
        'You can also chat normally. I will answer with AI when configured.'
    ].join('\n');
}

function parseCommand(text) {
    const value = String(text || '').trim();

    if (!value) {
        return { name: 'empty' };
    }

    const sendMatch = value.match(/^\/?send(?:\s+to)?\s+([+\d][\d\s()-]+)\s*(?:\||:|\n)\s*([\s\S]+)$/i);
    if (sendMatch) {
        return {
            name: 'send',
            phone: sendMatch[1].trim(),
            message: sendMatch[2].trim()
        };
    }

    const sendFileMatch = value.match(/^\/?(?:sendfile|file(?:\s+to)?|voice)\s+([+\d][\d\s()-]+)(?:\s*(?:\||:|\n)\s*([\s\S]*))?$/i);
    if (sendFileMatch) {
        return {
            name: 'sendfile',
            phone: sendFileMatch[1].trim(),
            caption: String(sendFileMatch[2] || '').trim()
        };
    }

    if (/^\/?help$/i.test(value)) {
        return { name: 'help' };
    }

    if (/^\/?status$/i.test(value)) {
        return { name: 'status' };
    }

    if (/^\/?contacts$/i.test(value)) {
        return { name: 'contacts' };
    }

    if (/^\/?automation$/i.test(value)) {
        return { name: 'automation' };
    }

    const setMessageMatch = value.match(/^\/?set\s+message\s*(?:\||:|\n)\s*([\s\S]+)$/i);
    if (setMessageMatch) {
        return {
            name: 'set_message',
            message: setMessageMatch[1].trim()
        };
    }

    const setTimeMatch = value.match(/^\/?set\s+time\s+(\d{1,2}:\d{2})$/i);
    if (setTimeMatch) {
        return {
            name: 'set_time',
            sendTime: setTimeMatch[1].trim()
        };
    }

    const setRangeMatch = value.match(/^\/?set\s+range\s+(\d+)\s+(\d+)$/i);
    if (setRangeMatch) {
        return {
            name: 'set_range',
            minMessages: Number.parseInt(setRangeMatch[1], 10),
            maxMessages: Number.parseInt(setRangeMatch[2], 10)
        };
    }

    const scheduleMatch = value.match(/^\/?schedule\s+(on|off)$/i);
    if (scheduleMatch) {
        return {
            name: 'set_schedule',
            enabled: scheduleMatch[1].toLowerCase() === 'on'
        };
    }

    const attachmentsMatch = value.match(/^\/?(attachments|files)(?:\s+(\d+))?$/i);
    if (attachmentsMatch) {
        return {
            name: 'attachments',
            limit: Number(attachmentsMatch[2] || appConfig.manager.recentAttachmentLimit)
        };
    }

    if (/^\/?blast(?:\s+now)?$/i.test(value)) {
        return { name: 'blast_now' };
    }

    return { name: 'chat', message: value };
}

async function buildStatusSummary() {
    const runtime = getRuntimeSnapshot();
    const [contactStatsResult, logStatsResult] = await Promise.allSettled([
        getContactStats(),
        getDailyLogStats()
    ]);
    const contacts = contactStatsResult.status === 'fulfilled'
        ? contactStatsResult.value
        : { total: 0, active: 0, inactive: 0 };
    const logs = logStatsResult.status === 'fulfilled'
        ? logStatsResult.value
        : { total: 0, sent: 0, failed: 0, other: 0 };
    const attachmentStats = getAttachmentStats();

    return [
        `App | التطبيق: ${runtime.appStatus}`,
        `WhatsApp | الواتساب: ${runtime.whatsapp.status}`,
        `Scheduler | الجدولة: ${runtime.scheduler.cronSchedule || 'not configured'}`,
        `Blast | الإرسال: ${runtime.blast.status}`,
        `Contacts | جهات الاتصال: ${contacts.active} active / ${contacts.total} total`,
        `Logs today | سجلات اليوم: ${logs.sent} sent, ${logs.failed} failed, ${logs.total} total`,
        `Manager agent | الوكيل: ${runtime.manager.status}`,
        `Saved attachments | المرفقات المحفوظة: ${attachmentStats.total}`,
        `Last attachment | آخر مرفق: ${attachmentStats.latest ? attachmentStats.latest.relativePath : 'none'}`
    ].join('\n');
}

async function buildAutomationSummary() {
    const automation = await getAutomationSettings();

    return [
        `Message | الرسالة: ${automation.messageTemplate}`,
        `Time | الوقت: ${automation.sendTime}`,
        `Range | العدد: ${automation.minMessages} to ${automation.maxMessages}`,
        `Scheduled | الجدولة: ${automation.scheduleEnabled ? 'on' : 'off'}`
    ].join('\n');
}

function formatAttachmentList(limit) {
    const attachments = listRecentAttachments(limit);

    if (!attachments.length) {
        return 'No saved attachments yet.';
    }

    return attachments.map((item, index) => (
        `${index + 1}. ${item.filename || path.basename(item.absolutePath)}\n` +
        `   from ${item.senderPhone || item.senderId || 'unknown'} at ${item.timestamp}\n` +
        `   saved to ${item.relativePath}`
    )).join('\n');
}

async function buildAiReply(chatId, messageText, attachmentRecord) {
    if (!groqClient) {
        return [
            'AI chat is not active yet because GROQ_API_KEY is missing.',
            'Manager commands still work:',
            buildHelpText()
        ].join('\n\n');
    }

    const history = getChatHistory(chatId);
    const runtime = getRuntimeSnapshot();
    const recentAttachments = listRecentAttachments(5);
    const systemPrompt = appConfig.manager.systemPrompt || [
        `You are ${appConfig.manager.name}, a professional WhatsApp operations manager for the owner of this account.`,
        'You are fluent in both Arabic and English. Match the language the user writes in — if they write Arabic, respond in Arabic; if English, respond in English. If mixed, prefer the dominant language.',
        'CRITICAL: Keep responses SHORT and DIRECT. Maximum 2-3 sentences or one short bullet list.',
        'Write clearly with proper punctuation (، and ؟ for Arabic). No filler or repetition.',
        'You do not claim that messages were sent unless the runtime context explicitly confirms it.',
        'For operational actions, guide to the correct command: status, contacts, blast now, send PHONE | MESSAGE, sendfile PHONE | CAPTION.',
        'Never expose internal system details, API keys, or technical errors.'
    ].join(' ');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: [
            'Current runtime snapshot:',
            JSON.stringify({
                appStatus: runtime.appStatus,
                whatsapp: runtime.whatsapp.status,
                scheduler: runtime.scheduler.cronSchedule,
                blast: runtime.blast.status,
                manager: runtime.manager.status
            }, null, 2),
            'Recent saved attachments:',
            recentAttachments.length
                ? recentAttachments.map((item) => `${item.filename || path.basename(item.absolutePath)} | ${item.mimetype} | ${item.relativePath}`).join('\n')
                : 'None',
            attachmentRecord
                ? `Latest attachment from the user: ${JSON.stringify({
                    filename: attachmentRecord.filename,
                    mimetype: attachmentRecord.mimetype,
                    path: attachmentRecord.relativePath,
                    caption: attachmentRecord.caption
                }, null, 2)}`
                : 'No new attachment in the latest message.'
        ].join('\n\n') }
    ];

    for (const entry of history) {
        messages.push({
            role: entry.role === 'user' ? 'user' : 'assistant',
            content: entry.text
        });
    }

    messages.push({ role: 'user', content: messageText });

    const response = await groqClient.chat.completions.create({
        model: appConfig.manager.model,
        messages,
        max_tokens: 450,
        temperature: 0.6
    });

    const text = String(response.choices?.[0]?.message?.content || '').trim();

    if (!text) {
        throw new Error('AI returned an empty manager response.');
    }

    return text;
}

async function captureAttachment(message, { isManagerMessage }) {
    if (!appConfig.manager.autoSaveIncomingMedia || !message.hasMedia) {
        return null;
    }

    const media = await message.downloadMedia();

    if (!media || !media.data) {
        return null;
    }

    let senderName = '';

    try {
        const contact = await message.getContact();
        senderName = contact?.pushname || contact?.name || contact?.shortName || '';
    } catch (error) {
        senderName = '';
    }

    const record = saveAttachmentRecord(message, media, {
        chatId: getChatId(message),
        senderId: getSenderId(message),
        senderPhone: normalizePhoneNumber(getSenderId(message)),
        senderName,
        isManagerMessage
    });

    recordManagerAttachment();
    pushEvent('manager', `Saved attachment ${record.filename || path.basename(record.absolutePath)}.`);
    return record;
}

function normalizeReplyText(text) {
    const prefix = String(appConfig.manager.replyPrefix || '');
    return `${prefix}${text}`.trim();
}

async function runLocalManagerCommand({
    chatId = 'dashboard-local',
    text,
    attachmentRecord = null,
    sendManagedMessage,
    sendManagedMedia,
    client
}) {
    const command = parseCommand(text);
    const latestAttachment = attachmentRecord || getLatestAttachmentForChat(chatId);

    if (command.name === 'empty' && attachmentRecord) {
        const reply = [
            'Attachment/voice received and saved. | تم حفظ المرفق أو الرسالة الصوتية.',
            `Path: ${attachmentRecord.relativePath}`,
            'Use sendfile/file/voice with a phone number to deliver it.'
        ].join('\n');

        appendChatHistory(chatId, {
            role: 'assistant',
            text: reply,
            timestamp: new Date().toISOString()
        });

        recordManagerReply(reply.slice(0, 120));
        return { reply };
    }

    if (command.name !== 'empty') {
        appendChatHistory(chatId, {
            role: 'user',
            text: text || (attachmentRecord ? `[attachment] ${attachmentRecord.filename}` : ''),
            timestamp: new Date().toISOString()
        });
    }

    let reply = '';

    switch (command.name) {
    case 'help':
        reply = buildHelpText();
        break;
    case 'status':
        reply = await buildStatusSummary();
        break;
    case 'contacts': {
        const stats = await getContactStats();
        reply = `Contacts | جهات الاتصال: ${stats.active} active, ${stats.inactive} inactive, ${stats.total} total.`;
        break;
    }
    case 'automation':
        reply = await buildAutomationSummary();
        break;
    case 'set_message':
        await upsertAppSetting('blaster_message', command.message);
        reply = 'Automation message updated. | تم تحديث رسالة الأتمتة.';
        break;
    case 'set_time':
        await upsertAppSetting('automation_send_time', command.sendTime);
        await reconfigureScheduler();
        reply = `Automation time updated to ${command.sendTime}. | تم تحديث وقت الأتمتة إلى ${command.sendTime}.`;
        break;
    case 'set_range':
        await Promise.all([
            upsertAppSetting('automation_min_messages', String(command.minMessages)),
            upsertAppSetting('automation_max_messages', String(command.maxMessages))
        ]);
        reply = `Automation range updated to ${command.minMessages} - ${command.maxMessages}. | تم تحديث العدد إلى ${command.minMessages} - ${command.maxMessages}.`;
        break;
    case 'set_schedule':
        await upsertAppSetting('automation_schedule_enabled', command.enabled ? 'true' : 'false');
        await reconfigureScheduler();
        reply = `Schedule turned ${command.enabled ? 'on' : 'off'}. | تم ${command.enabled ? 'تشغيل' : 'إيقاف'} الجدولة.`;
        break;
    case 'attachments':
        reply = formatAttachmentList(command.limit);
        break;
    case 'blast_now':
        if (isBlastRunning()) {
            reply = 'A blast is already running.';
            break;
        }

        runDailyBlast('dashboard-agent').catch((error) => {
            recordRuntimeError('manager', error);
        });
        reply = 'Blast started in the background.';
        break;
    case 'send':
        await sendManagedMessage(command.phone, command.message);
        reply = `Message sent to ${normalizePhoneNumber(command.phone)}.`;
        break;
    case 'sendfile':
        if (!latestAttachment) {
            reply = 'Attach or record a file first, then use sendfile/file/voice. | ارفع أو سجل ملفاً أولاً ثم استخدم sendfile أو voice.';
            break;
        }

        await sendManagedMedia(command.phone, latestAttachment.absolutePath, command.caption || latestAttachment.caption);
        reply = `File or voice sent to ${normalizePhoneNumber(command.phone)} from ${latestAttachment.relativePath}.`;
        break;
    case 'chat':
        reply = await buildAiReply(chatId, command.message, attachmentRecord);
        break;
    case 'empty':
    default:
        reply = 'Type a command or ask the manager agent something.';
        break;
    }

    if (client && command.name === 'chat' && client.info?.wid?._serialized) {
        recordManagerInbound({
            chatId,
            fromManager: true,
            command: command.name
        });
    }

    appendChatHistory(chatId, {
        role: 'assistant',
        text: reply,
        timestamp: new Date().toISOString()
    });
    recordManagerReply(reply.slice(0, 120));

    return { reply };
}

function createManagerAgent({ client, sendManagedMessage, sendManagedMedia }) {
    if (!appConfig.manager.enabled) {
        setManagerStatus('disabled', 'Manager agent is disabled in configuration.');
        return {
            isEnabled: false
        };
    }

    ensureManagerStorage();
    setManagerStatus('starting', 'Manager agent listeners are being attached.');

    async function sendChatReply(chatId, text) {
        const sentMessage = await client.sendMessage(chatId, normalizeReplyText(text));
        rememberOutgoingMessage(sentMessage);
        recordManagerReply(text.slice(0, 120));
        appendChatHistory(chatId, {
            role: 'assistant',
            text,
            timestamp: new Date().toISOString()
        });
        return sentMessage;
    }

    async function handleAuthorizedManagerMessage(message, preCapturedAttachment = null) {
        const chatId = getChatId(message);
        const command = parseCommand(message.body);
        const attachmentRecord = preCapturedAttachment || await captureAttachment(message, { isManagerMessage: true });

        recordManagerInbound({
            chatId,
            fromManager: true,
            command: command.name
        });

        if (command.name === 'empty' && attachmentRecord) {
            await sendChatReply(chatId, [
                'Attachment received and saved.',
                `Path: ${attachmentRecord.relativePath}`,
                'Add a caption or send "attachments" to review saved files.'
            ].join('\n'));
            return;
        }

        appendChatHistory(chatId, {
            role: 'user',
            text: message.body || (attachmentRecord ? `[attachment] ${attachmentRecord.filename}` : ''),
            timestamp: new Date().toISOString()
        });

        switch (command.name) {
        case 'help':
            await sendChatReply(chatId, buildHelpText());
            return;
        case 'status':
            await sendChatReply(chatId, await buildStatusSummary());
            return;
        case 'contacts': {
            const stats = await getContactStats();
            await sendChatReply(chatId, `Contacts: ${stats.active} active, ${stats.inactive} inactive, ${stats.total} total.`);
            return;
        }
        case 'attachments':
            await sendChatReply(chatId, formatAttachmentList(command.limit));
            return;
        case 'blast_now':
            if (isBlastRunning()) {
                await sendChatReply(chatId, 'A blast is already running.');
                return;
            }

            runDailyBlast('manager').catch((error) => {
                recordRuntimeError('manager', error);
            });
            await sendChatReply(chatId, 'Blast started in the background.');
            return;
        case 'send': {
            const sentMessage = await sendManagedMessage(command.phone, command.message);
            rememberOutgoingMessage(sentMessage);
            await sendChatReply(chatId, `Message sent to ${normalizePhoneNumber(command.phone)}.`);
            return;
        }
        case 'sendfile': {
            if (!attachmentRecord) {
                await sendChatReply(chatId, 'Attach a file to the same message when using sendfile.');
                return;
            }

            const sentMessage = await sendManagedMedia(command.phone, attachmentRecord.absolutePath, command.caption || attachmentRecord.caption);
            rememberOutgoingMessage(sentMessage);
            await sendChatReply(chatId, `File sent to ${normalizePhoneNumber(command.phone)} from ${attachmentRecord.relativePath}.`);
            return;
        }
        case 'chat':
        default: {
            const aiReply = await buildAiReply(chatId, command.message, attachmentRecord);
            await sendChatReply(chatId, aiReply);
        }
        }
    }

    async function handleExternalIncomingMessage(message) {
        try {
            if (message.isStatus || isGroupChatId(getChatId(message))) {
                return;
            }

            const ownWid = client.info?.wid?._serialized || '';
            const isManagerMessage = isAuthorizedManagerMessage(message, ownWid);
            const attachmentRecord = message.hasMedia
                ? await captureAttachment(message, { isManagerMessage })
                : null;

            if (!isManagerMessage) {
                return;
            }

            await handleAuthorizedManagerMessage(message, attachmentRecord);
        } catch (error) {
            recordRuntimeError('manager', error);
            setManagerStatus('error', `Manager agent error: ${error.message}`);
        }
    }

    async function handleCreatedMessage(message) {
        try {
            if (!message.fromMe || message.isStatus || isGroupChatId(getChatId(message))) {
                return;
            }

            const ownWid = client.info?.wid?._serialized || '';

            if (!isAuthorizedManagerMessage(message, ownWid)) {
                return;
            }

            await handleAuthorizedManagerMessage(message);
        } catch (error) {
            recordRuntimeError('manager', error);
            setManagerStatus('error', `Manager agent error: ${error.message}`);
        }
    }

    client.on('ready', () => {
        const authorizationHint = appConfig.manager.authorizedNumbers.length
            ? `${appConfig.manager.authorizedNumbers.length} external manager number(s) allowed.`
            : 'Self-chat control is available. Add WHATSAPP_MANAGER_NUMBERS for remote control.';
        setManagerStatus('ready', `Manager agent is ready. ${authorizationHint}`);
    });

    client.on('message', handleExternalIncomingMessage);
    client.on('message_create', handleCreatedMessage);

    return {
        isEnabled: true
    };
}

module.exports = {
    buildHelpText,
    createManagerAgent,
    isAuthorizedManagerMessage,
    parseCommand,
    runLocalManagerCommand
};
