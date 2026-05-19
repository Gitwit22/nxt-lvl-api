  # Secure Tax Identity Implementation Guide

## Overview

This implementation adds secure storage and management of tax identifiers (SSN, EIN, ITIN) to the Finance Hub People & Payees intake form. The implementation follows strict security practices:

- **Encryption**: All tax IDs are encrypted server-side using AES-256-GCM before storage
- **Masking**: Only last 4 digits displayed by default (e.g., `***-**-1234`)
- **Restricted Access**: Only `finance_admin` or `org_owner` can reveal full values
- **Audit Logging**: All reveal, creation, update, and deletion events are logged
- **No Frontend Storage**: Raw values are never stored in browser state, localStorage, or logs
- **Duplicate Detection**: Using one-way hash to detect duplicate tax IDs without exposing values

## Database Schema

### New Models

#### `Payee`
General payee/vendor information with tax identity references.

```prisma
model Payee {
  id                    String   @id @default(cuid())
  organizationId        String
  payeeType             String   // w2_employee | contractor_1099 | vendor_business | etc.
  
  // ... other fields ...
  
  hasTaxIdentity        Boolean  @default(false)
  taxIdStatus           String?  // Collected | Verified | Needs correction | Missing
  
  secureTaxIdentity     PayeeSecureTaxIdentity?
  auditLogs             AuditLog[]
}
```

#### `PayeeSecureTaxIdentity`
Encrypted tax identifier storage.

```prisma
model PayeeSecureTaxIdentity {
  id                    String   @id @default(cuid())
  organizationId        String
  payeeId               String   @unique
  
  taxIdType             String   // SSN | EIN | ITIN | UNKNOWN
  encryptedTaxId        String   // AES-256-GCM encrypted
  taxIdLast4            String   // Last 4 digits for display only
  taxIdHash             String   // SHA-256 hash for duplicate detection
  
  taxIdStatus           String   // Missing | Collected | Verified | Needs correction
  taxIdVerifiedAt       DateTime?
  
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  createdByUserId       String
  updatedByUserId       String
  
  payee                 Payee    @relation(fields: [payeeId], references: [id], onDelete: Cascade)
}
```

#### `AuditLog`
Audit trail for all tax identity operations.

```prisma
model AuditLog {
  id                    String   @id @default(cuid())
  organizationId        String
  payeeId               String
  
  action                String   // tax_id_created | tax_id_updated | tax_id_revealed | tax_id_deleted | etc.
  actionType            String   // CREATE | UPDATE | READ | DELETE
  
  userId                String   // Who performed the action
  userEmail             String?
  
  details               Json?    // Context about the action
  ipAddress             String?
  userAgent             String?
  
  createdAt             DateTime @default(now())
  
  payee                 Payee    @relation(fields: [payeeId], references: [id], onDelete: Cascade)
}
```

## Environment Variables

### Required

```bash
# Encryption key for tax IDs (must be 64 hex characters = 32 bytes for AES-256)
# Generate with: openssl rand -hex 32
TAX_ID_ENCRYPTION_KEY=your_64_character_hex_key_here

# Example (DO NOT USE IN PRODUCTION):
# TAX_ID_ENCRYPTION_KEY=0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
```

### Generation

Generate a secure encryption key:

```bash
# Using OpenSSL
openssl rand -hex 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Validation

The application will:
1. **Fail on startup** if `TAX_ID_ENCRYPTION_KEY` is not set
2. **Fail on startup** in production if the key matches a known demo/default value
3. **Validate key format** (must be exactly 64 hex characters)

## Database Migration

Run the Prisma migration to create the new tables:

```bash
cd nxt-lvl-api
npx prisma migrate deploy
```

Or for development:

```bash
npx prisma migrate dev --name add-tax-identity-tables
```

## Frontend: Payroll Form Integration

### Components

#### `TaxIdInput`
Masked input component for SSN/EIN entry with real-time formatting.

Features:
- Auto-formatting as user types
- Support for both SSN (###-##-####) and EIN (##-#######) formats
- Accepts digits and auto-formats
- No storage of raw values

Usage:
```tsx
<TaxIdInput
  value={rawTaxId}
  onChange={(value) => setRawTaxId(value)}
  taxIdType="SSN"
  placeholder="###-##-####"
/>
```

#### `TaxIdConfirmation`
Confirmation input that must match the main tax ID entry.

Usage:
```tsx
<TaxIdConfirmation
  mainValue={rawTaxId}
  confirmValue={confirmTaxId}
  onConfirmChange={(value) => setConfirmTaxId(value)}
  taxIdType="SSN"
/>
```

#### `TaxIdDisplay`
Read-only display of masked tax ID (after save).

Usage:
```tsx
<TaxIdDisplay last4="1234" taxIdType="SSN" />
// Shows: ***-**-1234
```

#### `TaxIdentityForm`
Complete conditional form section that shows different fields based on payee type.

**Conditionally displayed fields:**

| Payee Type | Fields |
|-----------|--------|
| W-2 Employee | SSN, Confirm SSN, Tax ID Status |
| Contractor/1099 | SSN or EIN, Confirm, Tax Classification, W-9 Status, Tax ID Status |
| Vendor | EIN/Tax ID, Confirm, W-9 Status, Tax ID Status |
| Volunteer/Stipend | Only if taxable/reportable |

Usage in payroll.tsx:
```tsx
<TaxIdentityForm
  payeeType={formState.payeeType}
  hasTaxIdentity={formState.hasTaxIdentity}
  onTaxIdentityChange={(v) => setFormState(prev => ({ ...prev, hasTaxIdentity: v }))}
  taxIdType={formState.taxIdType}
  onTaxIdTypeChange={(v) => setFormState(prev => ({ ...prev, taxIdType: v }))}
  rawTaxId={formState.rawTaxId}
  onRawTaxIdChange={(v) => setFormState(prev => ({ ...prev, rawTaxId: v }))}
  confirmTaxId={formState.confirmTaxId}
  onConfirmTaxIdChange={(v) => setFormState(prev => ({ ...prev, confirmTaxId: v }))}
  w9Status={formState.w9Status}
  onW9StatusChange={(v) => setFormState(prev => ({ ...prev, w9Status: v }))}
  taxIdSecureStatus={formState.taxIdSecureStatus}
  onTaxIdSecureStatusChange={(v) => setFormState(prev => ({ ...prev, taxIdSecureStatus: v }))}
  taxIdLast4={formState.taxIdLast4}
/>
```

### Form State Management

The form stores:
- **rawTaxId**: Raw user input (NEVER persisted)
- **confirmTaxId**: Confirmation input (NEVER persisted)
- **taxIdType**: Type selected (SSN, EIN, ITIN)
- **taxIdSecureStatus**: Status (Missing, Collected, Verified, Needs correction)
- **taxIdLast4**: Only populated after successful save (from server response)

**Critical**: After saving, clear raw values from state:

```tsx
// After successful save from server
setFormState(prev => ({
  ...prev,
  rawTaxId: "", // Clear raw value
  confirmTaxId: "", // Clear confirmation
  taxIdLast4: response.taxIdLast4, // Store only last 4 from server
}));
```

## Backend API

### Endpoints

All endpoints are under `/api/...` and require proper authentication.

#### Create/Update Tax Identity
```
POST /api/payees/:payeeId/tax-identity
```

**Required Role**: `finance_admin` or `org_owner`

**Request Body**:
```json
{
  "taxIdType": "SSN|EIN|ITIN",
  "taxId": "123-45-6789",
  "taxIdStatus": "Collected|Verified|Needs correction"
}
```

**Response**:
```json
{
  "success": true,
  "payeeId": "...",
  "taxIdType": "SSN",
  "taxIdLast4": "6789",
  "taxIdStatus": "Collected",
  "masked": "***-**-6789"
}
```

#### Get Masked Display
```
GET /api/payees/:payeeId/tax-identity/masked
```

**Role**: Any authenticated user (basic payee access)

**Response**:
```json
{
  "payeeId": "...",
  "hasTaxIdentity": true,
  "taxIdType": "SSN",
  "taxIdLast4": "6789",
  "taxIdStatus": "Verified",
  "masked": "***-**-6789",
  "taxIdVerifiedAt": "2026-05-19T..."
}
```

#### Reveal Full Tax ID
```
POST /api/payees/:payeeId/tax-identity/reveal
```

**Required Role**: `finance_admin` or `org_owner`

**Request Body** (optional):
```json
{
  "reason": "Exporting 1099 forms for tax season"
}
```

**Response**:
```json
{
  "payeeId": "...",
  "taxIdType": "SSN",
  "taxId": "123-45-6789",
  "last4": "6789",
  "status": "Verified",
  "warning": "This decrypted value is only valid for this request. Do not share or store it. Revelation logged for audit."
}
```

**Important Notes**:
- Reveal is **rate-limited** (10 reveals per hour per user by default)
- Every reveal is **logged with user ID, timestamp, IP, user-agent**
- Response is **not cached** on frontend
- Raw value **never returned** in other endpoints

#### Delete Tax Identity
```
DELETE /api/payees/:payeeId/tax-identity
```

**Required Role**: `finance_admin` or `org_owner`

**Request Body** (optional):
```json
{
  "reason": "Deleting payee record per request"
}
```

**Response**:
```json
{
  "success": true,
  "payeeId": "...",
  "message": "Tax identity deleted"
}
```

#### Get Audit Log
```
GET /api/payees/:payeeId/tax-identity/audit?limit=50
```

**Required Role**: `finance_admin` or `org_owner`

**Query Parameters**:
- `limit`: Max results (default 50, max 200)

**Response**:
```json
{
  "payeeId": "...",
  "count": 5,
  "logs": [
    {
      "id": "...",
      "organizationId": "...",
      "payeeId": "...",
      "action": "tax_id_revealed",
      "actionType": "READ",
      "userId": "...",
      "userEmail": "admin@example.com",
      "details": {
        "reason": "1099 export",
        "last4": "6789"
      },
      "ipAddress": "192.168.1.100",
      "userAgent": "Mozilla/5.0...",
      "createdAt": "2026-05-19T14:30:00Z"
    }
  ]
}
```

## Encryption/Decryption

### Server-Side Only

All encryption and decryption happens on the backend:

```typescript
import {
  encryptTaxId,
  decryptTaxId,
  formatTaxId,
  extractLast4Digits,
  hashTaxId,
  maskTaxId,
  validateEncryptionConfiguration,
} from "@/core/services/taxIdEncryption";

// Encrypt on save
const formatted = formatTaxId("123-45-6789"); // Normalizes format
const encrypted = encryptTaxId(formatted); // Returns encrypted + IV + auth tag
const hash = hashTaxId(formatted); // For duplicate detection
const last4 = extractLast4Digits(formatted); // Display

// Decrypt on reveal
const decrypted = decryptTaxId(encrypted); // Returns original value

// Masking for display
const masked = maskTaxId(last4, "SSN"); // "***-**-6789"
```

### Validation

```typescript
// Check on app startup
const config = validateEncryptionConfiguration();
if (!config.valid) {
  throw new Error(`Encryption misconfigured: ${config.error}`);
}
```

## Audit Logging

### Actions Logged

Every action includes:
- User ID and email
- IP address and user-agent
- Timestamp
- Action type and payee ID
- Context/reason (when applicable)
- **NOT** raw tax ID values (only last 4 digits in safe contexts)

### Log Actions

| Action | Trigger | Logged Info |
|--------|---------|-------------|
| `tax_id_created` | First save | Tax ID type, last 4, status |
| `tax_id_updated` | Re-save existing | Tax ID type, last 4, status |
| `tax_id_revealed` | Admin reveal | Reason, last 4, IP, user-agent |
| `tax_id_deleted` | Admin delete | Reason, last 4 |
| `tax_id_verification_status_changed` | Status change | Old/new status |

### Querying Audit Logs

```typescript
import { getPayeeAuditLog } from "@/core/services/auditLogging";

const logs = await getPayeeAuditLog(organizationId, payeeId, limit);
// Logs show who accessed, when, from where, and why
```

## Frontend Security Practices

### DO ✅

- ✅ Clear raw values from state after successful save
- ✅ Use input components with masking
- ✅ Only show masked display after save
- ✅ Log actions server-side with full context
- ✅ Require confirmation input matching
- ✅ Validate format before submission

### DON'T ❌

- ❌ Store raw tax IDs in component state permanently
- ❌ Persist raw values to localStorage, sessionStorage
- ❌ Include raw values in URL parameters
- ❌ Log raw values to console (especially in production)
- ❌ Cache decrypted values from reveal endpoint
- ❌ Pass raw values between components
- ❌ Render raw values to DOM

## Testing Acceptance Criteria

- ✅ W-2 employee can be saved with SSN and value is masked afterward
- ✅ Contractor can be saved with SSN or EIN and value is masked afterward
- ✅ Vendor can be saved with EIN and value is masked afterward
- ✅ Raw tax IDs do not appear in:
  - Frontend logs
  - Backend logs (except as encrypted values)
  - Audit logs (only last 4 digits shown)
  - Network error responses
  - Normal payee GET responses
- ✅ Users without permission cannot reveal or update tax IDs
- ✅ Reveal actions are audited with full context
- ✅ Duplicate tax IDs can be detected using hash
- ✅ Existing payee records continue working without tax ID data
- ✅ Database migration doesn't break current functionality

## Configuration Examples

### Development Environment

```bash
# Generate key for dev
TAX_ID_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Add to .env.local or similar
echo "TAX_ID_ENCRYPTION_KEY=$TAX_ID_ENCRYPTION_KEY" >> .env.local
```

### Production Environment

```bash
# Generate and store securely
openssl rand -hex 32 > /secure/location/tax-id-key

# Set in production secrets management (e.g., AWS Secrets Manager, HashiCorp Vault)
# OR set as environment variable with appropriate access controls
export TAX_ID_ENCRYPTION_KEY=$(cat /secure/location/tax-id-key)

# NEVER commit to git
# NEVER log the value
# NEVER share in error messages
```

### Docker

```dockerfile
# In Dockerfile - DO NOT include key
ENV NODE_ENV=production

# In docker-compose.yml or similar - reference external secret
services:
  api:
    environment:
      TAX_ID_ENCRYPTION_KEY: ${TAX_ID_ENCRYPTION_KEY}
    secrets:
      - tax_id_key

secrets:
  tax_id_key:
    external: true
```

## Troubleshooting

### "TAX_ID_ENCRYPTION_KEY is not set"

**Solution**: Set the environment variable before starting the application
```bash
export TAX_ID_ENCRYPTION_KEY=$(openssl rand -hex 32)
npm start
```

### "TAX_ID_ENCRYPTION_KEY must be 64 hex characters"

**Solution**: The key must be exactly 32 bytes (64 hex characters)
```bash
# This should output exactly 64 characters
openssl rand -hex 32 | wc -c
```

### "Decryption failed" errors

**Possible causes**:
1. Different encryption key being used than when value was encrypted
2. Encrypted data corruption
3. Database corruption

**Recovery**: 
- Verify encryption key matches
- If data is corrupted, delete the tax ID and re-collect from payee
- Review audit logs to identify when change occurred

### "This tax ID is already associated with another payee"

**Meaning**: Duplicate detected via hash (without exposing raw value)

**Solution**:
- Verify the payee information is correct
- If duplicate, check if the other payee entry should be merged or deleted
- Review audit log to see who created the other entry

## Compliance Notes

### GDPR/Data Protection

- Tax identifiers are treated as sensitive personal data
- Encryption ensures confidentiality
- Audit logging provides accountability
- Data can be deleted via API with audit trail
- Hash-based duplicate detection avoids exposing values

### SOC 2 / Financial Compliance

- All operations are logged with user attribution
- Access is restricted by role
- Encryption uses industry-standard AES-256
- No plaintext tax IDs in logs or error messages
- Rate limiting on sensitive operations

### IRS Compliance (1099 Forms)

- Tax IDs collected with proper authorization
- Secure storage per IRS Publication 1075 guidelines
- Audit trail for compliance inquiries
- Can be retrieved securely for 1099 reporting

## Support & Monitoring

### Key Metrics to Monitor

1. **Reveal Operations**: Track frequency and patterns
2. **Encryption Errors**: Any failures should trigger alerts
3. **Audit Log Growth**: Monitor storage usage
4. **Permission Denials**: Track attempted unauthorized access

### Monitoring Example

```typescript
// Alert if too many reveal attempts
const hourlyReveals = await getPayeeAuditLog(org, payee, 1000)
  .then(logs => logs.filter(l => 
    l.action === 'tax_id_revealed' && 
    l.createdAt > oneHourAgo
  ).length);

if (hourlyReveals > 100) {
  alertOps("Unusual tax ID reveal activity detected");
}
```

## FAQ

**Q: Can I export decrypted tax IDs?**
A: Yes, via the reveal endpoint, but the value is only valid for that request and the action is fully audited.

**Q: What happens if I lose the encryption key?**
A: All encrypted tax IDs become unrecoverable. Store the key securely (Vault, Secrets Manager, etc.) with proper backup.

**Q: Can users see their own tax IDs?**
A: No. Only `finance_admin` or `org_owner` can reveal full values. This is intentional for security.

**Q: How often should I rotate the encryption key?**
A: Industry best practice is annually, but it requires re-encryption of all stored values.

**Q: Are confirm fields required?**
A: Yes, to prevent typos that could cause incorrect tax ID collection.
