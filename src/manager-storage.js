const fs = require('fs');
const path = require('path');

const { appConfig } = require('./config');

const storageRoot = path.resolve(process.cwd(), appConfig.manager.storagePath);
const chatsRoot = path.join(storageRoot, 'chats');
const attachmentsRoot = path.join(storageRoot, 'attachments');
const attachmentsIndexPath = path.join(storageRoot, 'attachments.json');

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function ensureManagerStorage() {
    ensureDirectory(storageRoot);
    ensureDirectory(chatsRoot);
    ensureDirectory(attachmentsRoot);
}

function readJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallbackValue;
        }

        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return fallbackValue;
    }
}

function writeJsonFile(filePath, value) {
    ensureDirectory(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sanitizeSegment(value) {
    return String(value || '')
        .replace(/[^\w.-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

function getChatHistoryPath(chatId) {
    return path.join(chatsRoot, `${sanitizeSegment(chatId)}.json`);
}

function getChatHistory(chatId, limit = appConfig.manager.historyLimit) {
    ensureManagerStorage();
    const history = readJsonFile(getChatHistoryPath(chatId), []);
    return history.slice(-limit);
}

function appendChatHistory(chatId, entry, limit = appConfig.manager.historyLimit) {
    ensureManagerStorage();
    const historyPath = getChatHistoryPath(chatId);
    const history = readJsonFile(historyPath, []);

    history.push(entry);

    while (history.length > limit) {
        history.shift();
    }

    writeJsonFile(historyPath, history);
    return history;
}

function getAttachmentsIndex() {
    ensureManagerStorage();
    return readJsonFile(attachmentsIndexPath, []);
}

function writeAttachmentsIndex(items) {
    writeJsonFile(attachmentsIndexPath, items);
}

function getFileExtension(filename, mimetype) {
    const extFromName = path.extname(String(filename || '')).trim();

    if (extFromName) {
        return extFromName;
    }

    const mapping = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'application/pdf': '.pdf',
        'text/plain': '.txt'
    };

    return mapping[String(mimetype || '').toLowerCase()] || '';
}

function saveAttachmentRecord(message, media, options = {}) {
    ensureManagerStorage();

    const timestamp = new Date().toISOString();
    const senderId = String(options.senderId || message.author || message.from || message.to || '');
    const senderPhone = String(options.senderPhone || '').trim();
    const originalName = media.filename || options.originalName || 'attachment';
    const extension = getFileExtension(originalName, media.mimetype);
    const dayFolder = timestamp.slice(0, 10);
    const attachmentDir = path.join(attachmentsRoot, dayFolder);
    const baseName = sanitizeSegment(path.basename(originalName, extension));
    const uniqueName = `${Date.now()}-${baseName || 'attachment'}${extension}`;
    const absolutePath = path.join(attachmentDir, uniqueName);
    const relativePath = path.relative(process.cwd(), absolutePath);

    ensureDirectory(attachmentDir);
    fs.writeFileSync(absolutePath, Buffer.from(media.data, 'base64'));

    const record = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        timestamp,
        messageId: message.id?._serialized || null,
        chatId: options.chatId || message.from || message.to || null,
        senderId,
        senderPhone,
        senderName: String(options.senderName || '').trim() || null,
        fromMe: Boolean(message.fromMe),
        isManagerMessage: Boolean(options.isManagerMessage),
        caption: String(message.body || '').trim(),
        mimetype: media.mimetype,
        filename: originalName,
        filesize: media.filesize || null,
        absolutePath,
        relativePath,
        category: options.category || 'incoming'
    };

    const index = getAttachmentsIndex();
    index.unshift(record);
    writeAttachmentsIndex(index.slice(0, 250));

    return record;
}

function listRecentAttachments(limit = appConfig.manager.recentAttachmentLimit) {
    return getAttachmentsIndex().slice(0, limit);
}

function getAttachmentStats() {
    const attachments = getAttachmentsIndex();

    return {
        total: attachments.length,
        latest: attachments[0] || null
    };
}

module.exports = {
    appendChatHistory,
    ensureManagerStorage,
    getAttachmentStats,
    getChatHistory,
    listRecentAttachments,
    saveAttachmentRecord,
    storageRoot
};
