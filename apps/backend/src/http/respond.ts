/**
 * Response helpers. Every successful route answers through `ok`, so the
 * envelope is identical across the API and clients need one unwrap path.
 */

import type { Response } from 'express';
import type { ApiSuccess, Paginated } from '@shuttle/shared-types';

export function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccess<T> = { ok: true, data };
  res.status(status).json(body);
}

export function created<T>(res: Response, data: T): void {
  ok(res, data, 201);
}

export function noContent(res: Response): void {
  res.status(204).end();
}

export function paginated<T>(
  res: Response,
  items: T[],
  total: number,
  limit: number,
  offset: number,
): void {
  const data: Paginated<T> = { items, total, limit, offset };
  ok(res, data);
}

/** Send a CSV file as a download (gate log and report exports). */
export function csv(res: Response, filename: string, body: string): void {
  // A BOM makes Excel on Windows open UTF-8 correctly instead of mangling
  // non-ASCII names — the company runs Excel, so this matters.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${body}`);
}
