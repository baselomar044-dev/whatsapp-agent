# 🗑️ Deletion Manager - Secure Message & Conversation Deletion

## **Feature Overview:**

The agent can delete messages and conversations **ONLY WITH YOUR APPROVAL**.

---

## **How It Works:**

### **Step 1: Request Deletion**
```
You: /delete conversation 971509787728
Agent: ⚠️ Deletion Request:
       Type: Entire Conversation
       Target: 971509787728
       
       Proceed? (yes/لا)
       [ID: 1234567890abc]
```

### **Step 2: Bilingual Confirmation**
```
Arabic:
⚠️ طلب حذف:
النوع: محادثة كاملة
الهدف: 971509787728
هل تريد المتابعة؟ (yes/لا)

English:
⚠️ Deletion Request:
Type: Entire Conversation
Target: 971509787728
Proceed? (yes/no)
```

### **Step 3: Your Approval**
```
You: approve 1234567890abc
Agent: ✅ Deletion approved: conversation (971509787728)
       ⚠️ Will be executed shortly.
```

### **Step 4: Execution**
```
Conversation deleted from WhatsApp
Logs saved to: storage/deletion-history.json
```

---

## **Commands:**

### **Request Deletions:**

```bash
# Delete entire conversation
/delete conversation 971509787728
/delete chat 971509787728
/del chat 971509787728

# Delete specific message (advanced)
/delete message 971509787728:a1b2c3d4

# Delete media file
/delete media /path/to/file
```

### **Manage Pending Deletions:**

```bash
# List all pending deletions
pending
/pending
deletions
/deletions

# Approve deletion
approve 1234567890abc
yes 1234567890abc
confirm 1234567890abc

# Reject/Cancel deletion
reject 1234567890abc
no 1234567890abc
cancel 1234567890abc
```

---

## **Deletion Types:**

| Type | Command | Effect |
|---|---|---|
| **Conversation** | `/delete chat PHONE` | Deletes entire chat with phone |
| **Message** | `/delete message ID` | Deletes specific message |
| **Media** | `/delete media PATH` | Deletes local media file |

---

## **Safety Features:**

✅ **Dual Authorization:**
- Agent requests deletion
- You must explicitly approve
- Bilingual confirmation (Arabic + English)

✅ **Audit Trail:**
```json
// storage/deletion-history.json
{
  "id": "1234567890abc",
  "type": "conversation",
  "target": "971509787728",
  "requester": "agent",
  "timestamp": "2026-04-02T14:30:00Z",
  "approved": true,
  "approvedBy": "Basel",
  "approvedAt": "2026-04-02T14:31:00Z",
  "executedAt": "2026-04-02T14:31:30Z",
  "status": "executed"
}
```

✅ **No Accidental Deletions:**
- Every deletion requires explicit confirmation
- Request ID must match approval ID
- Auto-reject invalid IDs

---

## **Example Workflow:**

### **Scenario 1: Delete Old Conversation**

```
You (Dashboard):
> delete conversation 971509787728

Agent (Response):
⚠️ Deletion Request:
Type: Entire Conversation
Target: 971509787728

Arabic: هل تريد المتابعة؟ (yes/لا)
English: Proceed? (yes/no)

[ID: a1b2c3d4e5f6]

You (5 minutes later):
> approve a1b2c3d4e5f6

Agent:
✅ Deletion approved: conversation (971509787728)
⚠️ Will be executed shortly.

[Conversation deleted]
```

### **Scenario 2: Change Your Mind**

```
You (Dashboard):
> delete conversation 971509787728

[Agent asks for confirmation...]

You (Dashboard):
> reject thisdeletionid

Agent:
❌ Deletion rejected and cancelled.

[Nothing deleted]
```

---

## **Storage:**

### **Deletion Requests:**
```
In Memory (until approved/rejected)
```

### **Deletion History:**
```
storage/deletion-history.json
- Request created
- Approval details
- Execution details
- Error logs
```

---

## **Security Notes:**

⚠️ **Important:**

1. **Only Manager/Admin Can Delete**
   - Unauthorized users cannot request deletions
   - Only you (Basel) can approve

2. **No Auto-Delete**
   - Every deletion requires explicit approval
   - 100% under your control

3. **Logged Access**
   - All deletion attempts are logged
   - See who, what, when in deletion-history.json

4. **WhatsApp Integration**
   - Deletes from WhatsApp servers (for everyone)
   - Cannot be undone
   - Recommended to backup before deleting

---

## **Usage Tips:**

✅ **Before Deleting:**
1. List pending: `pending`
2. Review carefully
3. Approve only if sure

✅ **Common Mistakes to Avoid:**
- ❌ Typo in phone number - double-check!
- ❌ Wrong ID - always copy-paste the ID
- ❌ Approve without thinking - take your time

✅ **Best Practices:**
- Review deletions before approving
- Keep deletion history for audit trail
- Backup important conversations first

---

## **Troubleshooting:**

| Problem | Solution |
|---|---|
| **"Request not found"** | ID might be wrong or already expired |
| **"Deletion not approved"** | Use correct approval ID |
| **"Target not found"** | Phone number format might be wrong |
| **"No pending deletions"** | All pending have been resolved |

---

**Status: ✅ READY TO USE**

All deletions are under your complete control! 🔐
