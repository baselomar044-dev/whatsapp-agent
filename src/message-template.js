const DEFAULT_MESSAGE_TEMPLATE = 'Hello ${name}! This is my senior QS service update.';

function getFirstName(name) {
    const trimmed = String(name || '').trim();

    if (!trimmed) {
        return 'Friend';
    }

    return trimmed.split(/\s+/)[0] || 'Friend';
}

function buildTemplateVariables(contact = {}) {
    const name = String(contact.name || '').trim() || 'Friend';
    const phone = String(contact.phone || '').trim();

    return {
        name,
        firstName: getFirstName(name),
        phone
    };
}

function normalizeTemplate(template) {
    const candidate = String(template || '').trim();
    return candidate || DEFAULT_MESSAGE_TEMPLATE;
}

function renderMessageTemplate(template, contact = {}) {
    const source = normalizeTemplate(template);
    const variables = buildTemplateVariables(contact);

    return source.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (match, dollarKey, braceKey) => {
        const key = dollarKey || braceKey;
        return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
    });
}

function buildMessagePreview(template, contact = {}) {
    const normalizedTemplate = normalizeTemplate(template);
    const variables = buildTemplateVariables(contact);

    return {
        template: normalizedTemplate,
        variables,
        rendered: renderMessageTemplate(normalizedTemplate, contact)
    };
}

module.exports = {
    DEFAULT_MESSAGE_TEMPLATE,
    buildMessagePreview,
    buildTemplateVariables,
    normalizeTemplate,
    renderMessageTemplate
};
