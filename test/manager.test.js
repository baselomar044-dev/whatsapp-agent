const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.MANAGER_STORAGE_PATH = './test/.tmp-manager';
process.env.WHATSAPP_MANAGER_NUMBERS = '971500000001, +971 50 000 0002';
process.env.MANAGER_ENABLED = 'true';

const tempRoot = path.resolve(process.cwd(), process.env.MANAGER_STORAGE_PATH);

const { parseCommand, isAuthorizedManagerMessage } = require('../src/manager-agent');
const {
    appendChatHistory,
    ensureManagerStorage,
    getChatHistory,
    listRecentAttachments,
    saveAttachmentRecord
} = require('../src/manager-storage');

after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('parseCommand detects manager operations', () => {
    assert.deepEqual(parseCommand('send +971 50 123 4567 | Hello there'), {
        name: 'send',
        phone: '+971 50 123 4567',
        message: 'Hello there'
    });

    assert.deepEqual(parseCommand('/sendfile 971501234567 | Caption text'), {
        name: 'sendfile',
        phone: '971501234567',
        caption: 'Caption text'
    });

    assert.deepEqual(parseCommand('attachments 3'), {
        name: 'attachments',
        limit: 3
    });
});

test('isAuthorizedManagerMessage allows self chat and listed manager numbers', () => {
    const ownWid = '971545472423@c.us';

    assert.equal(isAuthorizedManagerMessage({
        fromMe: true,
        from: ownWid,
        to: ownWid,
        id: { _serialized: 'a' }
    }, ownWid), true);

    assert.equal(isAuthorizedManagerMessage({
        fromMe: false,
        from: '971500000001@c.us',
        to: ownWid,
        id: { _serialized: 'b' }
    }, ownWid), true);

    assert.equal(isAuthorizedManagerMessage({
        fromMe: false,
        from: '971599999999@c.us',
        to: ownWid,
        id: { _serialized: 'c' }
    }, ownWid), false);
});

test('manager storage keeps history and saves attachments to disk', () => {
    ensureManagerStorage();
    appendChatHistory('manager-chat', { role: 'user', text: 'Hello', timestamp: '2026-03-30T00:00:00.000Z' }, 5);
    appendChatHistory('manager-chat', { role: 'assistant', text: 'Hi', timestamp: '2026-03-30T00:00:01.000Z' }, 5);

    const history = getChatHistory('manager-chat', 5);
    assert.equal(history.length, 2);
    assert.equal(history[0].text, 'Hello');

    const attachment = saveAttachmentRecord({
        fromMe: false,
        from: '971500000001@c.us',
        to: '971545472423@c.us',
        body: 'See attached',
        id: { _serialized: 'attachment-1' }
    }, {
        mimetype: 'text/plain',
        data: Buffer.from('sample file').toString('base64'),
        filename: 'note.txt',
        filesize: 11
    }, {
        chatId: '971500000001@c.us',
        senderId: '971500000001@c.us',
        senderPhone: '971500000001',
        senderName: 'Manager'
    });

    assert.equal(fs.existsSync(attachment.absolutePath), true);

    const recentAttachments = listRecentAttachments(5);
    assert.equal(recentAttachments.length >= 1, true);
    assert.equal(recentAttachments[0].filename, 'note.txt');
  });
