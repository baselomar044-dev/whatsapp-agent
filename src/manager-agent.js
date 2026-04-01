const path = require('path');

const { GoogleGenAI } = require('@google/genai');

const { appConfig } = require('./config');
const { getContactStats, getDailyLogStats } = require('./database');
const { listRecentAttachments, getAttachmentStats, saveAttachmentRecord, getChatHistory, appendChatHistory, ensureManagerStorage } = require('./manager-storage');
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
const { isBlastRunning, runDailyBlast } = require('./scheduler');

const geminiClient = appConfig.manager.geminiApiKey
    ? new GoogleGenAI({ apiKey: appConfig.manager.geminiApiKey })
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
        `${appConfig.manager.name} commands:`,
        '- status',
        '- help',
        '- contacts',
        '- attachments',
        '- blast now',
        '- send 9715XXXXXXXX | your message',
        '- sendfile 9715XXXXXXXX | optional caption  (send this with an attached file)',
        '',
        'You can also chat normally. I will answer with Gemini when GEMINI_API_KEY is configured.'
    ].join('\n');
}

function parseCommand(text) {
    const value = String(text || '').trim();

    if (!value) {
        return { name: 'empty' };
    }

    const sendMatch = value.match(/^\/?send\s+([+\d][\d\s()-]+)\s*(?:\||:|\n)\s*([\s\S]+)$/i);
    if (sendMatch) {
        return {
            name: 'send',
            phone: sendMatch[1].trim(),
            message: sendMatch[2].trim()
        };
    }

    const sendFileMatch = value.match(/^\/?sendfile\s+([+\d][\d\s()-]+)(?:\s*(?:\||:|\n)\s*([\s\S]*))?$/i);
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
        `App: ${runtime.appStatus}`,
        `WhatsApp: ${runtime.whatsapp.status}`,
        `Scheduler: ${runtime.scheduler.cronSchedule || 'not configured'}`,
        `Blast: ${runtime.blast.status}`,
        `Contacts: ${contacts.active} active / ${contacts.total} total`,
        `Logs today: ${logs.sent} sent, ${logs.failed} failed, ${logs.total} total`,
        `Manager agent: ${runtime.manager.status}`,
        `Saved attachments: ${attachmentStats.total}`,
        `Last attachment: ${attachmentStats.latest ? attachmentStats.latest.relativePath : 'none'}`
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
    if (!geminiClient) {
        return [
            'Gemini chat is not active yet because GEMINI_API_KEY is missing.',
            'Manager commands still work:',
            buildHelpText()
        ].join('\n\n');
    }

    const history = getChatHistory(chatId);
    const runtime = getRuntimeSnapshot();
    const recentAttachments = listRecentAttachments(5);
    const systemPrompt = appConfig.manager.systemPrompt || [
        `You are ${appConfig.manager.name}, a WhatsApp operations manager for the owner of this account.`,
        'You answer clearly and concisely.',
        'You do not claim that messages were sent or actions were executed unless the runtime context explicitly says so.',
        'If the user wants an operational action, guide them to these commands:',
        'status, contacts, attachments, blast now, send PHONE | MESSAGE, sendfile PHONE | CAPTION',
        'You may discuss strategy, drafts, wording, priorities, and summaries in natural language.'
    ].join(' ');

    const prompt = [
        systemPrompt,
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
            : 'No new attachment in the latest message.',
        'Conversation history:',
        history.length
            ? history.map((item) => `${item.role.toUpperCase()}: ${item.text}`).join('\n')
            : 'No previous history.',
        `Latest user message:\n${messageText}`
    ].join('\n\n');

    const response = await geminiClient.models.generateContent({
        model: appConfig.manager.model,
        contents: prompt
    });

    const text = String(response.text || '').trim();

    if (!text) {
        throw new Error('Gemini returned an empty manager response.');
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
    createManagerAgent,
    isAuthorizedManagerMessage,
    parseCommand
};
