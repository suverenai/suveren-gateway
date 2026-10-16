import { useState, useMemo, useEffect, CSSProperties } from 'react';
import parseDiff from 'parse-diff';

interface DiffViewerProps {
  patch: string;
  filename: string;
  status?: string; // 'added' | 'modified' | 'removed' | 'renamed'
}

interface SplitCell {
  ln: number;
  content: string;
  type: 'normal' | 'add' | 'del';
}

interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
}

// Monochrome (UI spec §2.1): an added line is shaded and marked "+", a
// removed line is muted and marked "-" (unified) or sits on the left (split).
const colors = {
  bg: 'var(--bg-elevated)',
  text: 'var(--text-primary)',
  lineNum: 'var(--text-muted)',
  addBg: 'var(--neutral-subtle)',
  addText: 'var(--text-primary)',
  delBg: 'transparent',
  delText: 'var(--text-muted)',
  hunkBg: 'var(--bg-main)',
  hunkText: 'var(--text-muted)',
  border: 'var(--border)',
  toolbarBg: 'var(--bg-main)',
  emptyBg: 'var(--bg-main)',
};

const lineNumStyle: CSSProperties = {
  color: colors.lineNum,
  fontSize: '0.75rem',
  userSelect: 'none',
  flexShrink: 0,
};

function stripMarker(content: string): string {
  return content.length > 0 ? content.slice(1) : '';
}

function getDefaultMode(status?: string): 'unified' | 'split' {
  if (status === 'added' || status === 'removed') return 'unified';
  return 'split';
}

function buildSplitRows(changes: parseDiff.Change[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (change.type === 'normal') {
      rows.push({
        left: { ln: change.ln1, content: change.content, type: 'normal' },
        right: { ln: change.ln2, content: change.content, type: 'normal' },
      });
      i++;
    } else {
      const dels: parseDiff.DeleteChange[] = [];
      while (i < changes.length && changes[i].type === 'del') {
        dels.push(changes[i] as parseDiff.DeleteChange);
        i++;
      }
      const adds: parseDiff.AddChange[] = [];
      while (i < changes.length && changes[i].type === 'add') {
        adds.push(changes[i] as parseDiff.AddChange);
        i++;
      }

      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < dels.length
            ? { ln: dels[j].ln, content: dels[j].content, type: 'del' }
            : null,
          right: j < adds.length
            ? { ln: adds[j].ln, content: adds[j].content, type: 'add' }
            : null,
        });
      }
    }
  }

  return rows;
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

export default function DiffViewer({ patch, filename, status }: DiffViewerProps) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<'unified' | 'split'>(() => getDefaultMode(status));
  const effectiveMode = isMobile ? 'unified' : mode;

  const chunks = useMemo(() => {
    const fullDiff = `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n${patch}`;
    const files = parseDiff(fullDiff);
    return files[0]?.chunks ?? [];
  }, [patch, filename]);

  const toggleStyle = (active: boolean): CSSProperties => ({
    padding: '0.25rem 0.6rem',
    fontSize: '0.75rem',
    border: `1px solid ${active ? colors.border : 'transparent'}`,
    borderRadius: '3px',
    cursor: 'pointer',
    backgroundColor: active ? colors.bg : 'transparent',
    color: active ? colors.text : colors.hunkText,
    fontFamily: 'inherit',
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{
      margin: '0.25rem 0 0.5rem',
      borderRadius: '4px',
      overflow: 'hidden',
      backgroundColor: colors.bg,
      border: `1px solid ${colors.border}`,
      fontSize: '0.8rem',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      lineHeight: '1.4',
    }}>
      {/* Toolbar */}
      {!isMobile && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '0.35rem 0.5rem',
          backgroundColor: colors.toolbarBg,
          borderBottom: `1px solid ${colors.border}`,
          gap: '0.2rem',
        }}>
          <button onClick={() => setMode('unified')} style={toggleStyle(mode === 'unified')}>
            Unified
          </button>
          <button onClick={() => setMode('split')} style={toggleStyle(mode === 'split')}>
            Split
          </button>
        </div>
      )}

      {/* Diff content */}
      <div style={{ maxHeight: '400px', overflowY: 'auto', overflowX: 'auto' }}>
        {effectiveMode === 'unified' ? (
          <UnifiedView chunks={chunks} />
        ) : (
          <SplitView chunks={chunks} />
        )}
      </div>
    </div>
  );
}

function HunkHeader({ content }: { content: string }) {
  return (
    <div style={{
      backgroundColor: colors.hunkBg,
      color: colors.hunkText,
      padding: '0.25rem 0.75rem',
      fontSize: '0.75rem',
      borderTop: `1px solid ${colors.border}`,
      borderBottom: `1px solid ${colors.border}`,
    }}>
      {content}
    </div>
  );
}

function UnifiedView({ chunks }: { chunks: parseDiff.Chunk[] }) {
  return (
    <div>
      {chunks.map((chunk, ci) => (
        <div key={ci}>
          <HunkHeader content={chunk.content} />
          {chunk.changes.map((change, li) => {
            let bg = 'transparent';
            let color = colors.text;
            let oldLn = '';
            let newLn = '';
            let marker = ' ';

            if (change.type === 'normal') {
              oldLn = String(change.ln1);
              newLn = String(change.ln2);
            } else if (change.type === 'add') {
              bg = colors.addBg;
              color = colors.addText;
              newLn = String(change.ln);
              marker = '+';
            } else {
              bg = colors.delBg;
              color = colors.delText;
              oldLn = String(change.ln);
              marker = '-';
            }

            return (
              <div key={li} style={{ display: 'flex', backgroundColor: bg, minWidth: 'fit-content' }}>
                <span style={{
                  ...lineNumStyle,
                  width: '3.5em',
                  textAlign: 'right',
                  paddingRight: '0.5em',
                  borderRight: `1px solid ${colors.border}`,
                }}>
                  {oldLn}
                </span>
                <span style={{
                  ...lineNumStyle,
                  width: '3.5em',
                  textAlign: 'right',
                  paddingRight: '0.5em',
                  borderRight: `1px solid ${colors.border}`,
                }}>
                  {newLn}
                </span>
                <span style={{
                  width: '1.5em',
                  textAlign: 'center',
                  color,
                  flexShrink: 0,
                }}>
                  {marker}
                </span>
                <span style={{
                  flex: 1,
                  color,
                  whiteSpace: 'pre',
                  paddingRight: '0.75rem',
                }}>
                  {stripMarker(change.content)}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SplitView({ chunks }: { chunks: parseDiff.Chunk[] }) {
  return (
    <div>
      {chunks.map((chunk, ci) => {
        const rows = buildSplitRows(chunk.changes);
        return (
          <div key={ci}>
            <HunkHeader content={chunk.content} />
            {rows.map((row, ri) => (
              <div key={ri} style={{ display: 'flex', width: '100%' }}>
                <SplitSide cell={row.left} />
                <div style={{ width: '1px', backgroundColor: colors.border, flexShrink: 0 }} />
                <SplitSide cell={row.right} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SplitSide({ cell }: { cell: SplitCell | null }) {
  if (!cell) {
    return (
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        backgroundColor: colors.emptyBg,
        minHeight: '1.4em',
      }}>
        <span style={{ ...lineNumStyle, width: '3.5em', borderRight: `1px solid ${colors.border}` }} />
        <span style={{ flex: 1 }} />
      </div>
    );
  }

  let bg = 'transparent';
  let color = colors.text;

  if (cell.type === 'del') {
    bg = colors.delBg;
    color = colors.delText;
  } else if (cell.type === 'add') {
    bg = colors.addBg;
    color = colors.addText;
  }

  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      display: 'flex',
      backgroundColor: bg,
    }}>
      <span style={{
        ...lineNumStyle,
        width: '3.5em',
        textAlign: 'right',
        paddingRight: '0.5em',
        borderRight: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}>
        {cell.ln}
      </span>
      <span style={{
        flex: 1,
        minWidth: 0,
        color,
        whiteSpace: 'pre',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        paddingLeft: '0.5em',
        paddingRight: '0.75rem',
      }}>
        {stripMarker(cell.content)}
      </span>
    </div>
  );
}
