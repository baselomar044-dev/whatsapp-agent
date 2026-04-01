require('dotenv').config();
const { supabase } = require('./src/database');
const fs = require('fs');
const { normalizePhoneNumber } = require('./src/phone');

async function importFromJSON(filePath) {
    const rawContacts = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (!Array.isArray(rawContacts)) {
        throw new Error('Contact import file must contain a JSON array.');
    }

    const data = rawContacts
        .map((contact) => ({
            name: String(contact.name || '').trim(),
            phone: normalizePhoneNumber(contact.phone)
        }))
        .filter((contact) => contact.name && contact.phone);
    
    const { error } = await supabase
        .from('whatsapp_contacts')
        .upsert(data, { onConflict: 'phone' });

    if (error) {
        console.error('Error importing contacts:', error);
    } else {
        console.log(`Successfully imported ${data.length} contacts.`);
    }
}

// Example usage: node import_contacts.js contacts.json
const file = process.argv[2];
if (file) {
    importFromJSON(file).catch(console.error);
} else {
    console.log('Please provide a JSON file path: node import_contacts.js <file.json>');
    console.log('Format: [{"name": "John Doe", "phone": "1234567890"}, ...]');
}
