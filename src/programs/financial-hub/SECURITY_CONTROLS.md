# Financial Hub Security Controls

Last Updated: 2026-05-18

## Data Classification

Financial Hub uses four labels:

- public
- internal
- confidential
- restricted

### How classification is applied

- Intake records store classification in `metadata.classification`.
- Uploaded documents include classification in the object key path:
  - `finance-hub/documents/{folder}/{classification}/{timestamp}-{filename}`
- For older document keys that do not contain a classification segment, default classification is `confidential`.

### Restricted controls

Restricted data has stronger controls:

- Limited role access
- MFA requirement hook (enabled by default)
- Short-lived download links (5 minutes)
- Export requires explicit approval ticket + business justification
- Audit logging on key read/export/write actions

Set `FINANCE_HUB_REQUIRE_MFA_FOR_RESTRICTED=false` to disable MFA enforcement for restricted operations (not recommended outside local development).

## RBAC Model (Normalized)

The backend normalizes incoming role strings to one of:

- owner_admin
- finance_manager
- bookkeeper_data_entry
- reviewer_auditor
- staff_uploader
- external_accountant

### Permissions summary

- `owner_admin`: full financial-hub access, including settings/security and exports
- `finance_manager`: operational review/approval/report access, document management
- `bookkeeper_data_entry`: create intake + upload/view docs (no approvals/exports)
- `reviewer_auditor`: read/review access for reports, queue, and documents
- `staff_uploader`: upload/receipt analysis only
- `external_accountant`: reports + exports + document read access

## Endpoint Guardrails Implemented

- Auth-only is no longer sufficient for sensitive Financial Hub routes.
- Route-level permission checks now enforce least-privilege.
- Restricted reads and exports are role + MFA gated.
- Exports default to non-restricted records unless `includeRestricted=true` with approval fields.

## Audit Logging

Route actions emit structured security logs via `logger` with the prefix:

- `[finance-hub-audit]`

Examples include:

- documents.upload
- documents.get
- documents.url
- documents.delete
- intake.create
- intake.status.update
- exports.view
