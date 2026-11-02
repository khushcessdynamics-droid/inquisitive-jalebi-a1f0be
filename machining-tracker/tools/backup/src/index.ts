export { parseConfig, loadConfig, syncedFolderReason, redact, type BackupConfig } from "./config.ts";
export { generateKey, encodeKey, keyId, loadKey, encryptToFile, decryptFile, BackupIntegrityError, BackupKeyError } from "./crypto.ts";
export { createArchiveWriter, readArchive } from "./archive.ts";
export { planRetention, type BackupInfo, type RetentionPolicy } from "./retention.ts";
export { runBackup, listBackups, applyRetention, type BackupResult } from "./backup.ts";
export { verifyArchive, type VerifyReport } from "./verify.ts";
export { restoreBackup, confirmationPhrase, type RestoreResult } from "./restore.ts";
