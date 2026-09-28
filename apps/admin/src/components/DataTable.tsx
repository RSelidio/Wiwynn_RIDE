'use client';

import React from 'react';
import { EmptyState, Mono, StatusPill, fontSize, useTheme, weight, type ToneName } from '@shuttle/ui';

/** One rendered cell. A pill carries a tone; text can be monospaced. */
export type Cell =
  | { kind: 'text'; value: string; mono?: boolean; color?: string; bold?: boolean }
  | { kind: 'pill'; value: string; tone: ToneName }
  | { kind: 'node'; node: React.ReactNode };

export const cell = {
  text: (value: string | number, options: { mono?: boolean; color?: string; bold?: boolean } = {}): Cell => ({
    kind: 'text',
    value: String(value),
    ...options,
  }),
  pill: (value: string, tone: ToneName): Cell => ({ kind: 'pill', value, tone }),
  node: (node: React.ReactNode): Cell => ({ kind: 'node', node }),
};

export interface Column {
  header: string;
  /** CSS grid track, e.g. '100px' or '1.2fr'. */
  width: string;
  align?: 'left' | 'right';
}

export interface Row {
  id: string;
  cells: Cell[];
  onClick?: () => void;
  selected?: boolean;
}

/**
 * The dense operational table used by every management view.
 *
 * CSS grid rather than a `<table>`: the column widths in the design are a
 * mixture of fixed pixels and fractions, the header is sticky, and the body
 * scrolls independently — all of which grid does without layout hacks. Roles
 * are set explicitly so it is still announced as a table.
 */
export function DataTable({
  columns,
  rows,
  footer,
  emptyMessage = 'Nothing to show.',
}: {
  columns: Column[];
  rows: Row[];
  footer?: string;
  emptyMessage?: string;
}) {
  const { theme } = useTheme();
  const template = columns.map((c) => c.width).join(' ');

  return (
    <div
      role="table"
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 10,
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        role="row"
        className="admin-thead"
        style={{
          display: 'grid',
          gridTemplateColumns: template,
          fontSize: fontSize.xs,
          fontWeight: weight.semibold,
          color: theme.fg3,
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        {columns.map((column) => (
          <div
            key={column.header}
            role="columnheader"
            style={{ padding: '10px 14px', textAlign: column.align ?? 'left' }}
          >
            {column.header}
          </div>
        ))}
      </div>

      <div className="sh-scroll" style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        {rows.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              role="row"
              className="admin-row"
              data-selected={row.selected === true}
              onClick={row.onClick}
              tabIndex={row.onClick == null ? undefined : 0}
              onKeyDown={
                row.onClick == null
                  ? undefined
                  : (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        row.onClick?.();
                      }
                    }
              }
              style={{
                display: 'grid',
                gridTemplateColumns: template,
                fontSize: fontSize.base,
                alignItems: 'center',
                minHeight: 40,
                cursor: row.onClick == null ? 'default' : 'pointer',
              }}
            >
              {row.cells.map((item, index) => (
                <div
                  key={index}
                  role="cell"
                  style={{
                    padding: '9px 14px',
                    textAlign: columns[index]?.align ?? 'left',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <CellView cell={item} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {footer != null && (
        <div
          style={{
            padding: '10px 14px',
            borderTop: `1px solid ${theme.border}`,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: fontSize.xs,
            fontWeight: weight.medium,
            color: theme.fg3,
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

function CellView({ cell: item }: { cell: Cell }) {
  const { theme } = useTheme();

  if (item.kind === 'pill') return <StatusPill label={item.value} tone={item.tone} />;
  if (item.kind === 'node') return <>{item.node}</>;

  if (item.mono === true) {
    return (
      <Mono size={fontSize.base} bold={item.bold} color={item.color ?? theme.fg}>
        {item.value}
      </Mono>
    );
  }

  return (
    <span
      style={{
        color: item.color ?? theme.fg,
        fontWeight: item.bold === true ? weight.semibold : weight.regular,
      }}
    >
      {item.value}
    </span>
  );
}
