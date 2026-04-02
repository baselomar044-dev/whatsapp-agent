/**
 * Delete Manager - Handles secure message/conversation deletion
 * with Basel-only confirmation requirement
 */

const fs = require('fs');
const path = require('path');

class DeletionRequest {
    constructor(type, target, requester, timestamp) {
        this.id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.type = type; // 'message' | 'conversation' | 'media'
        this.target = target; // phone number, message ID, etc
        this.requester = requester; // 'agent' | 'dashboard' | 'manager'
        this.timestamp = timestamp;
        this.approved = false;
        this.approvedBy = null;
        this.approvedAt = null;
        this.executedAt = null;
    }
}

const pendingDeletions = new Map();
const deletionHistoryPath = path.join(process.cwd(), 'storage', 'deletion-history.json');

function ensureDeletionHistory() {
    const dir = path.dirname(deletionHistoryPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(deletionHistoryPath)) {
        fs.writeFileSync(deletionHistoryPath, JSON.stringify([], null, 2));
    }
}

function getDeletionHistory() {
    ensureDeletionHistory();
    try {
        return JSON.parse(fs.readFileSync(deletionHistoryPath, 'utf8'));
    } catch {
        return [];
    }
}

function saveDeletionHistory(record) {
    ensureDeletionHistory();
    const history = getDeletionHistory();
    history.push(record);
    fs.writeFileSync(deletionHistoryPath, JSON.stringify(history, null, 2));
}

function requestDeletion(type, target, requester = 'agent') {
    const request = new DeletionRequest(type, target, requester, new Date().toISOString());
    pendingDeletions.set(request.id, request);
    return request;
}

function getPendingDeletions() {
    return Array.from(pendingDeletions.values()).filter(r => !r.approved);
}

function getPendingDeletionById(id) {
    return pendingDeletions.get(id);
}

function buildDeletionConfirmationPrompt(request) {
    const typeLabel = {
        'message': { ar: 'رسالة', en: 'Message' },
        'conversation': { ar: 'محادثة كاملة', en: 'Entire Conversation' },
        'media': { ar: 'ملف وسائط', en: 'Media File' }
    };

    const label = typeLabel[request.type] || { ar: 'عنصر', en: 'Item' };

    return {
        ar: `⚠️ طلب حذف:\n\nالنوع: ${label.ar}\nالهدف: ${request.target}\n\nهل تريد المتابعة؟ (yes/لا)`,
        en: `⚠️ Deletion Request:\n\nType: ${label.en}\nTarget: ${request.target}\n\nProceed? (yes/no)`
    };
}

function approveDeletion(id, approvedBy = 'Basel') {
    const request = pendingDeletions.get(id);
    if (!request) return { success: false, error: 'Request not found' };

    request.approved = true;
    request.approvedBy = approvedBy;
    request.approvedAt = new Date().toISOString();

    return { success: true, request };
}

function rejectDeletion(id) {
    const request = pendingDeletions.get(id);
    if (!request) return { success: false, error: 'Request not found' };

    pendingDeletions.delete(id);
    saveDeletionHistory({
        ...request,
        status: 'rejected'
    });

    return { success: true, message: 'Deletion request rejected' };
}

async function executeDeletion(id, client) {
    const request = pendingDeletions.get(id);
    if (!request) return { success: false, error: 'Request not found' };
    if (!request.approved) return { success: false, error: 'Deletion not approved' };

    try {
        if (request.type === 'message') {
            // Delete specific message
            const chat = await client.getChatById(request.target.split(':')[0]);
            const messages = await chat.getMessages({ limit: 1000 });
            const msgToDelete = messages.find(m => m.id._serialized === request.target.split(':')[1]);
            
            if (msgToDelete) {
                await msgToDelete.delete(true); // delete for everyone
            }
        } else if (request.type === 'conversation') {
            // Delete entire conversation
            const chat = await client.getChatById(request.target);
            await chat.delete();
        } else if (request.type === 'media') {
            // Delete local media file
            if (fs.existsSync(request.target)) {
                fs.unlinkSync(request.target);
            }
        }

        request.executedAt = new Date().toISOString();
        saveDeletionHistory({
            ...request,
            status: 'executed'
        });

        pendingDeletions.delete(id);

        return {
            success: true,
            message: `${request.type} deleted successfully`,
            request
        };
    } catch (error) {
        saveDeletionHistory({
            ...request,
            status: 'failed',
            error: error.message
        });

        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    DeletionRequest,
    requestDeletion,
    getPendingDeletions,
    getPendingDeletionById,
    approveDeletion,
    rejectDeletion,
    executeDeletion,
    buildDeletionConfirmationPrompt,
    getDeletionHistory,
    saveDeletionHistory
};
