/**
 * One-time interactive bootstrap for the first real administrator.
 *
 * Run after `npm run db:migrate`. Refuses to run when an admin already exists.
 * The password is entered with terminal echo disabled and is never logged.
 */

import { createInterface } from 'node:readline';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { closePool, withTransaction } from './pool';

function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal.'));
  }

  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') {
          finish(new Error('Setup cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ' && char !== '\u007f') {
          value += char;
          process.stdout.write('*');
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

async function promptLine(label: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => input.question(label, resolve));
    return answer.trim();
  } finally {
    input.close();
  }
}

async function main(): Promise<void> {
  const email = (await promptLine('Administrator email: ')).toLowerCase();
  const displayName = await promptLine('Administrator name: ');
  const password = await readHidden('Password (12+ chars, upper/lowercase and a number): ');
  const confirmation = await readHidden('Confirm password: ');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  if (displayName.length < 1 || displayName.length > 120) {
    throw new Error('Administrator name must be between 1 and 120 characters.');
  }
  if (password.length < 12 || password.length > 200
    || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Password does not meet the required length and character rules.');
  }
  if (password !== confirmation) {
    throw new Error('Passwords do not match.');
  }

  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
  const userId = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shuttle.bootstrap-admin'))");

    const admins = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    );
    if (admins.rowCount) throw new Error('An administrator already exists; refusing bootstrap.');

    const existing = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    );
    if (existing.rowCount) throw new Error('That email already belongs to an account.');

    const result = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role, provider)
       VALUES ($1, $2, $3, 'admin', 'local')
       RETURNING id`,
      [email, passwordHash, displayName],
    );
    return result.rows[0]!.id;
  });

  console.log(`Initial administrator created (${email}, id ${userId}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Administrator bootstrap failed.');
    process.exitCode = 1;
  })
  .finally(() => closePool());
