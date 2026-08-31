#!/usr/bin/env node
/**
 * Spec 250, criterion 8b — the child that gets killed.
 *
 * Applies the FIRST Codev column to a file-backed database, announces it, then
 * blocks forever waiting to be SIGKILLed. The parent kills it here, which leaves
 * exactly one of the two columns on disk: the state a server dying between the
 * guard's two `ALTER TABLE` statements really produces.
 *
 * The statements are the guard's, byte for byte. What this file stands in for is
 * the process dying, not the SQL.
 *
 * Usage: node crash-apply-child.mjs <path-to-sqlite-file>
 */

import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: crash-apply-child.mjs <db>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
db.exec('ALTER TABLE projection_threads ADD COLUMN codev_role TEXT');
db.close();

// Announce, then hang. The parent is waiting for this line before it kills.
console.log('APPLIED_FIRST_COLUMN');

// No exit path. Being killed here is the point; exiting cleanly would make the
// half-applied state a thing this script chose rather than a thing a crash left.
setInterval(() => {}, 1 << 30);
