const fs = require('fs');
const path = require('path');

const storageRoot = path.resolve(process.cwd(), 'storage', 'local-dashboard');
const contactsPath = path.join(storageRoot, 'contacts.json');
const logsPath = path.join(storageRoot, 'logs.json');
const settingsPath = path.join(storageRoot, 'settings.json');

function ensureStorage() {
    fs.mkdirSync(storageRoot, { recursive: true });
}

function readJson(filePath, fallback) {
    ensureStorage();

    try {
        if (!fs.existsSync(filePath)) {
            return fallback;
        }

        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return fallback;
    }
}

function writeJson(filePath, value) {
    ensureStorage();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getLocalContacts() {
    return readJson(contactsPath, []);
}

function saveLocalContacts(contacts) {
    writeJson(contactsPath, contacts);
}

function getLocalLogs() {
    return readJson(logsPath, []);
}

function saveLocalLogs(logs) {
    writeJson(logsPath, logs);
}

function getLocalSettings() {
    return readJson(settingsPath, {});
}

function saveLocalSettings(settings) {
    writeJson(settingsPath, settings);
}

module.exports = {
    getLocalContacts,
    getLocalLogs,
    getLocalSettings,
    saveLocalContacts,
    saveLocalLogs,
    saveLocalSettings,
    storageRoot
};
