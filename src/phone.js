function normalizePhoneNumber(phoneNumber) {
    const rawValue = String(phoneNumber || '').trim();

    if (!rawValue) {
        return '';
    }

    return rawValue
        .replace(/@c\.us$/i, '')
        .replace(/[^\d]/g, '');
}

function toWhatsAppId(phoneNumber) {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!normalizedPhone) {
        throw new Error('A valid phone number is required before sending a message.');
    }

    return `${normalizedPhone}@c.us`;
}

module.exports = {
    normalizePhoneNumber,
    toWhatsAppId
};
