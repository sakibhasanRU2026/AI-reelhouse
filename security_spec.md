# REELHOUSE CRM Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Identity & Role Integrity**: Users cannot self-assign `role: "admin"` when creating or updating `/users/{userId}` or `/admins/{adminId}`. Only verified bootstrap admin (`sakibhasan.ru18@gmail.com` with `email_verified == true`) or an existing `/admins/{uid}` document grants admin privileges.
2. **Ownership & Client Isolation**: Every CRM document (`clients`, `workspaces`, `contentIdeas`, `scripts`, `projects`, `assets`, `renderJobs`, `videoVersions`, `feedback`, `approvals`, `publishingRecords`, `activityLogs`) carries `ownerUid` matching `request.auth.uid` on create and immutable thereafter. Assigned clients (`clientUid` or verified `clientEmail`) may only read their own assigned records and submit client feedback/approvals for those records.
3. **Version Immutability & Fresh Approval**: A `videoVersions` document's `versionNumber`, `jobId`, `projectId`, and `createdAt` cannot be overwritten after creation. Approving an older version cannot automatically approve a newer version.
4. **No Raw Video Bytes in Firestore**: Only metadata (`assetId`, `filename`, `storageProvider`, `expiresAt`, probe metrics) is persisted in `/assets/{assetId}`.
5. **Temporal Integrity & Path Hardening**: All document IDs match `^[a-zA-Z0-9_-]+$` (`<= 128` chars); all string fields enforce bounded lengths; `createdAt == request.time` on create and `updatedAt == request.time` on update.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Self-Admin Escalation**: `create /users/{uid}` with `{ uid, email, role: "admin" }` from non-admin UID.
2. **Ghost Field Shadow Write**: `create /clients/{cid}` with extra undeclared field `isVerified: true`.
3. **Spoofed Owner Creation**: `create /projects/{pid}` with `ownerUid: "victim_uid"` != `request.auth.uid`.
4. **Email Spoofing Without Verification**: Client read/approve attempt where `token.email == clientEmail` but `token.email_verified == false`.
5. **Cross-Tenant Read/List Scrape**: `list /projects` without scoping to `ownerUid` or `clientUid`/`clientEmail` (non-admin).
6. **Version Overwrite Attack**: `update /videoVersions/{vid}` attempting to mutate `jobId`, `versionNumber`, or `instructions`.
7. **Unauthorized Client Edit of Project Instructions**: Assigned client attempting to overwrite `editingInstructions` or `ownerUid` on `/projects/{pid}` directly instead of submitting feedback/approval.
8. **ID Poisoning**: Document ID longer than 128 chars or containing slashes/special characters (`../evil`).
9. **Approval Spoofing**: `create /approvals/{aid}` with `decidedByUid != request.auth.uid` or referencing an unassigned client project.
10. **Fake Published State Without Integration**: Direct `create /publishingRecords/{rid}` with `readiness: "published"` when `integrationStatus: "not_connected"`.
11. **Timestamp Backdating**: `create` or `update` supplying a client timestamp instead of `request.time`.
12. **PII Leak on `/users/{otherUid}`**: Signed-in non-admin user attempting `get /users/{otherUid}` or `list /users`.
