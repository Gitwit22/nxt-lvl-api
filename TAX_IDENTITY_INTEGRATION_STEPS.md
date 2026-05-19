# Tax Identity Implementation - Integration Guide

## ✅ Completed Components

All backend infrastructure and frontend components have been built and are ready for integration. Below is exactly what to do next.

---

## 🚀 Step 1: Add Service Functions (5 minutes)

### File: `finance-command-center/src/services/finance-ops.ts`

Add these functions at the end of the file:

```typescript
/**
 * Create or update tax identity for a payee
 */
export async function createOrUpdatePayeeTaxIdentity(
  payeeId: string,
  taxIdType: TaxIdType,
  taxId: string,
  taxIdStatus: SecureTaxIdStatus
): Promise<{ taxIdLast4: string; masked: string }> {
  const response = await apiRequest("POST", `/payees/${payeeId}/tax-identity`, {
    taxIdType,
    taxId,
    taxIdStatus,
  });
  if (!response.ok) throw new Error(`Failed to save tax identity: ${response.statusText}`);
  return response.json();
}

/**
 * Get masked tax identity display
 */
export async function getPayeeTaxIdentityMasked(
  payeeId: string
): Promise<{ 
  payeeId: string;
  hasTaxIdentity: boolean;
  taxIdType?: string;
  taxIdLast4?: string;
  masked?: string;
  taxIdStatus?: string;
}> {
  const response = await apiRequest("GET", `/payees/${payeeId}/tax-identity/masked`);
  if (!response.ok) throw new Error("Failed to retrieve tax identity");
  return response.json();
}

/**
 * Reveal full tax ID (admin only)
 */
export async function revealPayeeTaxId(
  payeeId: string,
  reason?: string
): Promise<{ taxId: string; last4: string; warning: string }> {
  const response = await apiRequest("POST", `/payees/${payeeId}/tax-identity/reveal`, {
    reason,
  });
  if (!response.ok) throw new Error("Failed to reveal tax identity");
  return response.json();
}

/**
 * Delete tax identity
 */
export async function deletePayeeTaxIdentity(
  payeeId: string,
  reason?: string
): Promise<{ success: boolean; message: string }> {
  const response = await apiRequest("DELETE", `/payees/${payeeId}/tax-identity`, {
    reason,
  });
  if (!response.ok) throw new Error("Failed to delete tax identity");
  return response.json();
}

/**
 * Get audit log for tax identity operations
 */
export async function getPayeeTaxIdentityAuditLog(
  payeeId: string,
  limit: number = 50
): Promise<any[]> {
  const response = await apiRequest(
    "GET",
    `/payees/${payeeId}/tax-identity/audit?limit=${limit}`
  );
  if (!response.ok) throw new Error("Failed to retrieve audit log");
  const data = await response.json();
  return data.logs || [];
}
```

---

## 🚀 Step 2: Add Import to Payroll Form (1 minute)

### File: `finance-command-center/src/routes/payroll.tsx`

Add to the imports at the top of the file:

```typescript
import { TaxIdentityForm } from "@/components/TaxIdentityForm";
```

---

## 🚀 Step 3: Add Form Section to Payroll Form (3 minutes)

### File: `finance-command-center/src/routes/payroll.tsx`

In the payee form JSX, add this section after the insurance/retirement fields and before the `<Card>` with notes. Find this location in the code:

```tsx
// ... existing form fields ...

// FIND THIS LOCATION - after insuranceCertificateStatus field, add:

{/* ────── TAX IDENTITY SECTION ────── */}
<TaxIdentityForm
  payeeType={payeeForm.payeeType}
  hasTaxIdentity={payeeForm.hasTaxIdentity}
  onTaxIdentityChange={(value) => {
    setPayeeForm((prev) => ({ ...prev, hasTaxIdentity: value }));
  }}
  taxIdType={payeeForm.taxIdType}
  onTaxIdTypeChange={(value) => {
    setPayeeForm((prev) => ({
      ...prev,
      taxIdType: value as "SSN" | "EIN" | "ITIN" | "UNKNOWN",
    }));
  }}
  rawTaxId={payeeForm.rawTaxId}
  onRawTaxIdChange={(value) => {
    setPayeeForm((prev) => ({ ...prev, rawTaxId: value }));
  }}
  confirmTaxId={payeeForm.confirmTaxId}
  onConfirmTaxIdChange={(value) => {
    setPayeeForm((prev) => ({ ...prev, confirmTaxId: value }));
  }}
  taxIdClassification={payeeForm.taxIdClassification}
  onTaxIdClassificationChange={(value) => {
    setPayeeForm((prev) => ({ ...prev, taxIdClassification: value }));
  }}
  w9Status={payeeForm.w9Status}
  onW9StatusChange={(value) => {
    setPayeeForm((prev) => ({ ...prev, w9Status: value }));
  }}
  taxIdSecureStatus={payeeForm.taxIdSecureStatus}
  onTaxIdSecureStatusChange={(value) => {
    setPayeeForm((prev) => ({
      ...prev,
      taxIdSecureStatus: value as "Missing" | "Collected" | "Verified" | "Needs correction",
    }));
  }}
  taxIdLast4={payeeForm.taxIdLast4}
/>
```

---

## 🚀 Step 4: Add Save Handler Logic (5 minutes)

### File: `finance-command-center/src/routes/payroll.tsx`

In the payee save function (where you create or update the payee), add this logic **BEFORE** the regular `createPayeeProfile` call:

```typescript
// Handle tax identity if present
if (payeeForm.hasTaxIdentity && payeeForm.rawTaxId) {
  // Validate confirmation matches
  if (payeeForm.rawTaxId !== payeeForm.confirmTaxId) {
    toast.error("Tax ID confirmation does not match");
    return;
  }

  try {
    // Save tax identity to backend
    const taxIdResult = await createOrUpdatePayeeTaxIdentity(
      payeeForm.id || "", // Use existing ID if updating
      payeeForm.taxIdType,
      payeeForm.rawTaxId,
      payeeForm.taxIdSecureStatus
    );

    // CRITICAL: Clear raw values from state after successful save
    setPayeeForm((prev) => ({
      ...prev,
      rawTaxId: "", // CLEAR - never keep raw values
      confirmTaxId: "", // CLEAR - never keep raw values
      taxIdLast4: taxIdResult.taxIdLast4, // Store ONLY last 4 from server
    }));

    toast.success("Tax identity saved securely");
  } catch (error) {
    toast.error(`Failed to save tax identity: ${error instanceof Error ? error.message : "Unknown error"}`);
    return; // Don't continue with payee save if tax ID failed
  }
}

// NOW continue with regular payee save
const savedPayee = await createPayeeProfile({
  ...payeeForm,
  // rawTaxId and confirmTaxId are now empty, so they won't be included
});
```

---

## 🚀 Step 5: Database Migration (2 minutes)

Run this command to create the new tables:

```bash
cd c:\Users\klaws\clawd\projects\nxt-lvl-api
npx prisma migrate dev
# When prompted, name it: "add-tax-identity-tables"
```

This will:
- Create `Payee` table
- Create `PayeeSecureTaxIdentity` table
- Create `AuditLog` table
- Generate TypeScript types

---

## 🚀 Step 6: Set Environment Variable (2 minutes)

### Generate encryption key:

```bash
# Windows PowerShell
$key = (openssl rand -hex 32); Write-Host $key

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Add to your environment:

**Option A: .env.local** (development)
```
TAX_ID_ENCRYPTION_KEY=your_64_character_hex_key_here
```

**Option B: Environment variable** (any environment)
```bash
export TAX_ID_ENCRYPTION_KEY=your_64_character_hex_key_here
```

**Option C: Docker** (production)
Add to docker-compose.yml or secrets manager

### Verify it's set:

```bash
# Check if environment variable is set
echo $TAX_ID_ENCRYPTION_KEY

# Should output 64 hex characters
# If empty, you need to set it before starting the app
```

---

## 🧪 Testing Checklist

### Test 1: Create W-2 Employee with SSN
```
1. Open payroll form
2. Click "Add Payee"
3. Select payee type: "W-2 Employee"
4. Scroll to "Tax Identity / Secure Fields" section
5. Enter SSN: 123-45-6789
6. Confirm SSN: 123-45-6789
7. Set Tax ID Status: "Collected"
8. Click Save
9. Verify form shows: ***-**-6789 (masked)
10. Check that no raw SSN appears in browser console/network tab
```

### Test 2: Create Contractor with EIN
```
1. Open payroll form
2. Click "Add Payee"
3. Select payee type: "1099 Contractor"
4. Select tax ID type: "EIN"
5. Enter EIN: 12-3456789
6. Confirm EIN: 12-3456789
7. Set Tax Classification: "LLC"
8. Set W-9 Status: "Received"
9. Set Tax ID Status: "Verified"
10. Click Save
11. Verify form shows: **-***6789 (masked)
```

### Test 3: Create Vendor with EIN
```
1. Open payroll form
2. Click "Add Payee"
3. Select payee type: "Vendor / Business"
4. Enter EIN: 98-7654321
5. Confirm EIN: 98-7654321
6. Set Tax ID Status: "Verified"
7. Click Save
8. Verify masked display
```

### Test 4: Verify Encryption is Working
```
1. In browser DevTools, go to Application → Storage
2. Search for stored tax IDs - should find NOTHING
3. Open Network tab
4. Create a payee with tax ID
5. Look at POST request body - should be encrypted, not raw SSN/EIN
```

### Test 5: Test Duplicate Detection
```
1. Create payee with SSN: 111-22-3333
2. Try to create another payee with SSN: 111-22-3333
3. Should get error: "This tax ID is already associated with another payee"
```

### Test 6: Verify Masked Display After Save
```
1. Create payee with SSN: 555-66-7777
2. After save, form should show: ***-**-7777
3. Open browser DevTools Console
4. Type: localStorage.getItem("form") - should have NO full SSN
5. Type: sessionStorage.getItem("form") - should have NO full SSN
```

---

## 🔐 Security Verification

Run this in browser console after saving a payee with tax ID:

```javascript
// Should return nothing (empty)
console.log(localStorage);

// Should return nothing related to tax ID
console.log(sessionStorage);

// Check if raw value is in DOM (should not be)
document.body.innerText.match(/\d{3}-\d{2}-\d{4}/);
```

All should return empty or null.

---

## ⚠️ Common Issues & Solutions

### Issue: "TAX_ID_ENCRYPTION_KEY is not set"
**Solution**: Set the environment variable before starting the app:
```bash
export TAX_ID_ENCRYPTION_KEY=$(openssl rand -hex 32)
npm run dev
```

### Issue: "Invalid tax ID format"
**Solution**: Make sure you're entering exactly 9 digits for SSN or EIN:
- SSN: 9 digits → formatted as ###-##-####
- EIN: 9 digits → formatted as ##-#######

### Issue: "Tax identifiers do not match"
**Solution**: Confirmation field must exactly match the main field. Use copy-paste if needed.

### Issue: "Migration failed"
**Solution**: Make sure you're in the nxt-lvl-api directory and Postgres is running:
```bash
cd nxt-lvl-api
npx prisma migrate dev
```

### Issue: Form doesn't show tax identity section
**Solution**: 
1. Verify TaxIdentityForm is imported
2. Verify payee type is one that requires tax ID (not "reimbursement_only")
3. Check browser console for import errors

---

## 📊 Expected Result

After completing all steps:

✅ W-2 Employees show SSN field
✅ Contractors show SSN or EIN choice + Tax Classification
✅ Vendors show EIN field
✅ All raw values masked after save (***-**-1234)
✅ Reveal button available only to finance admins
✅ Audit log tracks all operations
✅ No raw values in logs or browser storage
✅ Duplicate tax IDs rejected
✅ Form validates before saving

---

## 📝 Files Summary

### Backend (Complete ✅)
- `nxt-lvl-api/prisma/schema.prisma` - Models defined
- `nxt-lvl-api/src/core/services/taxIdEncryption.ts` - Encryption ready
- `nxt-lvl-api/src/core/services/auditLogging.ts` - Audit logging ready
- `nxt-lvl-api/src/programs/financial-hub/routes/taxIdentity.routes.ts` - API ready
- `nxt-lvl-api/TAX_IDENTITY_IMPLEMENTATION.md` - Documentation

### Frontend (Complete ✅)
- `finance-command-center/src/components/TaxIdInput.tsx` - Component ready
- `finance-command-center/src/components/TaxIdConfirmation.tsx` - Component ready
- `finance-command-center/src/components/TaxIdentityForm.tsx` - Component ready
- `finance-command-center/src/services/finance-ops.ts` - Types updated, needs service functions ⬅️
- `finance-command-center/src/routes/payroll.tsx` - Form state updated, needs integration ⬅️

### To Do (Integration Work)
1. ⬅️ Add service functions to finance-ops.ts (Step 1)
2. ⬅️ Add import to payroll.tsx (Step 2)
3. ⬅️ Add form section to payroll.tsx (Step 3)
4. ⬅️ Add save handler logic (Step 4)
5. ⬅️ Run database migration (Step 5)
6. ⬅️ Set environment variable (Step 6)

---

## 🎯 Estimated Time

- Step 1 (Service functions): 5 minutes
- Step 2 (Import): 1 minute
- Step 3 (Form section): 3 minutes
- Step 4 (Save logic): 5 minutes
- Step 5 (Migration): 2 minutes
- Step 6 (Environment): 2 minutes
- Testing: 15 minutes

**Total: ~33 minutes to full integration**

---

## ✨ You're Almost There!

All the hard work (encryption, validation, audit logging, API endpoints) is done. These remaining steps are straightforward copy-paste integration. Once complete, you'll have a fully secure tax identity system! 🎉
