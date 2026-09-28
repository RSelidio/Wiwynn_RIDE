/**
 * Request validation. Zod schemas parse and coerce; a failure throws a ZodError
 * that the terminal error handler renders as a field-keyed 400.
 *
 * Parsing rather than merely checking matters here: query strings arrive as
 * strings, so `limit=25` becomes the number 25 before any handler sees it.
 */

import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from './errors';

export function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.body);
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.query);
}

/** Read a route parameter that must be a UUID. */
export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw badRequest(`${name} must be a UUID`, { [name]: ['Expected a UUID'] });
  }
  return parsed.data;
}

/** Read a route parameter that may be a UUID or a human code (REQ-1042). */
export function idOrCodeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw badRequest(`${name} is required`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable field schemas
// ─────────────────────────────────────────────────────────────────────────────

export const uuid = z.string().uuid();

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const latitude = z.coerce.number().min(-90).max(90);
export const longitude = z.coerce.number().min(-180).max(180);

/** An ISO-8601 instant. Rejects "2026-13-45" that `new Date` would accept as Invalid. */
export const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Expected an ISO-8601 date-time' });

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Not a real date' });

/**
 * Accept a single value or a repeated query parameter, always yielding an array.
 * `?status=pending` and `?status=pending&status=accepted` both work.
 */
export function arrayOf<S extends z.ZodTypeAny>(schema: S) {
  // The return type is annotated rather than inferred: without it TypeScript
  // widens the union branches into a nested array type that no longer matches
  // the `T | T[]` shape the DTOs declare.
  return z
    .union([schema, z.array(schema)])
    .transform((v): z.infer<S>[] => (Array.isArray(v) ? (v as z.infer<S>[]) : [v as z.infer<S>]));
}
