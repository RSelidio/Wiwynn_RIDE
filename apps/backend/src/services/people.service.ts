/**
 * Employee and driver directory reads for the admin management pages.
 *
 * Both lists carry the activity figures the dashboard shows beside each person,
 * computed in the same query rather than fetched per row.
 */

import type { CreateDriverBody, CreateEmployeeBody, Driver, Employee, UpdateDriverBody, UpdateEmployeeBody } from '@shuttle/shared-types';
import { query, queryOne, withTransaction } from '../db/pool';
import { rowToDriver, rowToEmployee } from '../db/rows';
import { notFound } from '../http/errors';
import { hashPassword } from './auth.service';

export interface EmployeeListItem extends Employee {
  email: string;
  lastRequestAt: string | null;
  tripsLast30d: number;
}

export interface DriverListItem extends Driver {
  email: string;
  /** The shuttle they are signed out to right now, if any. */
  currentShuttleName: string | null;
  currentShiftStartedAt: string | null;
  isOnShift: boolean;
  tripsLast30d: number;
}

export async function listEmployees(
  q: string | undefined,
  limit = 50,
  offset = 0,
): Promise<{ items: EmployeeListItem[]; total: number }> {
  const search = q ? `%${q.toLowerCase()}%` : null;

  const countRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM employees e
     JOIN users u ON u.id = e.user_id
     WHERE $1::text IS NULL
        OR lower(e.display_name) LIKE $1
        OR lower(e.badge_no) LIKE $1
        OR lower(COALESCE(e.rfid_tag, '')) LIKE $1
        OR lower(COALESCE(e.department, '')) LIKE $1
        OR lower(u.email) LIKE $1`,
    [search],
  );

  const rows = await query(
    `SELECT e.*, u.email,
            (SELECT max(r.requested_at) FROM pickup_requests r WHERE r.employee_id = e.id)
              AS last_request_at,
            (SELECT count(*)::int FROM trip_passengers tp
             JOIN trips t ON t.id = tp.trip_id
             WHERE tp.employee_id = e.id AND t.departed_at > now() - interval '30 days')
              AS trips_last30d
     FROM employees e
     JOIN users u ON u.id = e.user_id
     WHERE $1::text IS NULL
        OR lower(e.display_name) LIKE $1
        OR lower(e.badge_no) LIKE $1
        OR lower(COALESCE(e.rfid_tag, '')) LIKE $1
        OR lower(COALESCE(e.department, '')) LIKE $1
        OR lower(u.email) LIKE $1
     ORDER BY e.display_name
     LIMIT $2 OFFSET $3`,
    [search, limit, offset],
  );

  return {
    items: rows.map((r) => rowToEmployee.one(r) as EmployeeListItem),
    total: countRow?.total ?? 0,
  };
}

export async function getEmployee(id: string): Promise<Employee> {
  const employee = rowToEmployee.one(await queryOne(`SELECT * FROM employees WHERE id = $1`, [id]));
  if (employee == null) throw notFound('Employee');
  return employee;
}

export async function listDrivers(
  q: string | undefined,
  limit = 50,
  offset = 0,
): Promise<{ items: DriverListItem[]; total: number }> {
  const search = q ? `%${q.toLowerCase()}%` : null;

  const countRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     WHERE $1::text IS NULL
        OR lower(d.display_name) LIKE $1
        OR lower(d.driver_no) LIKE $1
        OR lower(u.email) LIKE $1`,
    [search],
  );

  const rows = await query(
    `SELECT d.*, u.email,
            sh.name AS current_shuttle_name,
            ds.started_at AS current_shift_started_at,
            (ds.id IS NOT NULL) AS is_on_shift,
            (SELECT count(*)::int FROM trips t
             WHERE t.driver_id = d.id AND t.departed_at > now() - interval '30 days')
              AS trips_last30d
     FROM drivers d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN driver_shifts ds ON ds.driver_id = d.id AND ds.ended_at IS NULL
     LEFT JOIN shuttles sh      ON sh.id = ds.shuttle_id
     WHERE $1::text IS NULL
        OR lower(d.display_name) LIKE $1
        OR lower(d.driver_no) LIKE $1
        OR lower(u.email) LIKE $1
     ORDER BY d.display_name
     LIMIT $2 OFFSET $3`,
    [search, limit, offset],
  );

  return {
    items: rows.map((r) => rowToDriver.one(r) as DriverListItem),
    total: countRow?.total ?? 0,
  };
}

export async function getDriver(id: string): Promise<Driver> {
  const driver = rowToDriver.one(await queryOne(`SELECT * FROM drivers WHERE id = $1`, [id]));
  if (driver == null) throw notFound('Driver');
  return driver;
}

/** Create a local login and its employee profile atomically. */
export async function createEmployee(input: CreateEmployeeBody): Promise<Employee> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role, provider)
       VALUES ($1, $2, $3, 'employee', 'local') RETURNING id`,
      [input.email.trim().toLowerCase(), passwordHash, input.displayName.trim()],
    );
    const employee = await client.query(
      `INSERT INTO employees (user_id, badge_no, rfid_tag, display_name, department, default_stop_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.rows[0]!.id, input.badgeNo.trim(), input.rfidTag?.trim() || null, input.displayName.trim(), input.department?.trim() || null, input.defaultStopId ?? null],
    );
    return rowToEmployee.one(employee.rows[0])!;
  });
}

/** Create a local login and its driver profile atomically. */
export async function createDriver(input: CreateDriverBody): Promise<Driver> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role, provider)
       VALUES ($1, $2, $3, 'driver', 'local') RETURNING id`,
      [input.email.trim().toLowerCase(), passwordHash, input.displayName.trim()],
    );
    const driver = await client.query(
      `INSERT INTO drivers (user_id, driver_no, display_name, license_no, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [user.rows[0]!.id, input.driverNo.trim(), input.displayName.trim(), input.licenseNo?.trim() || null, input.phone?.trim() || null],
    );
    return rowToDriver.one(driver.rows[0])!;
  });
}

/** Update the employee profile and corresponding local login atomically. */
export async function updateEmployee(id: string, input: UpdateEmployeeBody): Promise<Employee> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return withTransaction(async (client) => {
    const found = await client.query<{ user_id: string }>('SELECT user_id FROM employees WHERE id = $1', [id]);
    const userId = found.rows[0]?.user_id;
    if (!userId) throw notFound('Employee');

    const displayName = input.displayName?.trim();
    await client.query(
      `UPDATE users SET
         email = COALESCE($2, email),
         display_name = COALESCE($3, display_name),
        password_hash = COALESCE($4, password_hash),
        is_active = COALESCE($5, is_active)
       WHERE id = $1`,
      [userId, input.email?.trim().toLowerCase() ?? null, displayName ?? null, passwordHash, input.isActive ?? null],
    );
    const result = await client.query(
      `UPDATE employees SET
         badge_no = COALESCE($2, badge_no),
         rfid_tag = CASE WHEN $3::boolean THEN $4 ELSE rfid_tag END,
         display_name = COALESCE($5, display_name),
         department = CASE WHEN $6::boolean THEN $7 ELSE department END,
         default_stop_id = CASE WHEN $8::boolean THEN $9::uuid ELSE default_stop_id END,
         is_active = COALESCE($10, is_active)
       WHERE id = $1 RETURNING *`,
      [id, input.badgeNo?.trim() ?? null, input.rfidTag !== undefined, input.rfidTag?.trim() || null, displayName ?? null,
        input.department !== undefined, input.department?.trim() || null,
        input.defaultStopId !== undefined, input.defaultStopId ?? null, input.isActive ?? null],
    );
    if (passwordHash) await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    return rowToEmployee.one(result.rows[0])!;
  });
}

/** Update the driver profile and corresponding local login atomically. */
export async function updateDriver(id: string, input: UpdateDriverBody): Promise<Driver> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return withTransaction(async (client) => {
    const found = await client.query<{ user_id: string }>('SELECT user_id FROM drivers WHERE id = $1', [id]);
    const userId = found.rows[0]?.user_id;
    if (!userId) throw notFound('Driver');

    const displayName = input.displayName?.trim();
    await client.query(
      `UPDATE users SET
         email = COALESCE($2, email),
         display_name = COALESCE($3, display_name),
        password_hash = COALESCE($4, password_hash),
        is_active = COALESCE($5, is_active)
       WHERE id = $1`,
      [userId, input.email?.trim().toLowerCase() ?? null, displayName ?? null, passwordHash, input.isActive ?? null],
    );
    const result = await client.query(
      `UPDATE drivers SET
         driver_no = COALESCE($2, driver_no),
         display_name = COALESCE($3, display_name),
         license_no = CASE WHEN $4::boolean THEN $5 ELSE license_no END,
         phone = CASE WHEN $6::boolean THEN $7 ELSE phone END,
         is_active = COALESCE($8, is_active)
       WHERE id = $1 RETURNING *`,
      [id, input.driverNo?.trim() ?? null, displayName ?? null,
        input.licenseNo !== undefined, input.licenseNo?.trim() || null,
        input.phone !== undefined, input.phone?.trim() || null, input.isActive ?? null],
    );
    if (passwordHash) await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    return rowToDriver.one(result.rows[0])!;
  });
}

/** Look up the socket/notification target behind an employee or driver id. */
export async function userIdForEmployee(employeeId: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM employees WHERE id = $1`,
    [employeeId],
  );
  return row?.user_id ?? null;
}

export async function userIdForDriver(driverId: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM drivers WHERE id = $1`,
    [driverId],
  );
  return row?.user_id ?? null;
}
