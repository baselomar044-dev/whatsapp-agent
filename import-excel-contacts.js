#!/usr/bin/env node
require('dotenv').config();
const XLSX = require('xlsx');
const { normalizePhoneNumber } = require('./src/phone');
const { getLocalContacts, saveLocalContacts } = require('./src/local-persistence');

async function importContactsFromExcel(filePath) {
    try {
        console.log(`📂 Reading Excel file: ${filePath}`);
        const wb = XLSX.readFile(filePath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws);

        console.log(`✅ Found ${data.length} contacts in Excel`);

        const newContacts = data
            .filter(row => row['Phone Number'] && String(row['Phone Number']).trim())
            .map(row => ({
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: String(row['Company Name'] || '').trim() || 'Unknown',
                phone: normalizePhoneNumber(String(row['Phone Number']).trim()),
                is_active: true,
                created_at: new Date().toISOString()
            }))
            .filter(contact => contact.phone && contact.phone.length >= 7); // Valid phone

        console.log(`\n📋 Valid contacts after normalization: ${newContacts.length}`);

        if (newContacts.length === 0) {
            console.error('❌ No valid contacts found after normalization');
            return;
        }

        // Show sample
        console.log('\n📌 Sample contacts:');
        newContacts.slice(0, 3).forEach((c, i) => {
            console.log(`  ${i + 1}. ${c.name} | ${c.phone}`);
        });

        // Read existing contacts
        const existingContacts = getLocalContacts();
        console.log(`\n📊 Existing contacts in database: ${existingContacts.length}`);

        // Merge contacts (avoid duplicates by phone)
        const phoneSet = new Set(existingContacts.map(c => c.phone));
        const duplicateCount = newContacts.filter(c => phoneSet.has(c.phone)).length;
        const uniqueNewContacts = newContacts.filter(c => !phoneSet.has(c.phone));

        console.log(`\n🔄 Merging contacts...`);
        console.log(`   ✅ New unique contacts: ${uniqueNewContacts.length}`);
        console.log(`   ⚠️  Duplicates (already in DB): ${duplicateCount}`);

        // Combine all
        const allContacts = [...existingContacts, ...uniqueNewContacts];
        saveLocalContacts(allContacts);

        console.log(`\n🎉 Import complete!`);
        console.log(`   ✅ Total contacts in database: ${allContacts.length}`);
        console.log(`   📍 Storage: storage/local-dashboard/contacts.json`);

    } catch (error) {
        console.error('❌ Import failed:', error.message);
        process.exit(1);
    }
}

// Run importer
const filePath = process.argv[2] || 'c:/Users/basel/OneDrive/Desktop/Not_Messaged_List.xlsx';
importContactsFromExcel(filePath);

