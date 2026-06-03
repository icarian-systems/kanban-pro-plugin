/**
 * RecoveryDiffView — inline unified diff between the local in-memory board
 * and the remote on-disk file, surfaced when the Self-Write detector classes
 * a vault `modify` event as foreign.
 *
 * The architecture's Sync risks row asks for a "recovery diff view": local
 * removed lines tinted red, remote added lines tinted green, three primary
 * actions (apply local, apply remote, open as plain text).
 *
 * We vendor the diff algorithm inline (~30 LOC) rather than pulling in a
 * dep. This is a Hunt-Szymanski LCS line-diff variant — O(n*m) memory; for
 * a single board file (~hundreds of lines) that's fine. If a future use
 * case demands bigger inputs we can swap for Myers without changing the
 * surface.
 */
import * as React from 'react';

export interface RecoveryDiffViewProps {
  local: string;
  remote: string;
  onApplyLocal: () => void;
  onApplyRemote: () => void;
  onOpenAsText: () => void;
  onCancel: () => void;
}

type DiffOp =
  | { kind: 'equal'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; text: string };

// LCS table → diff ops. Treats every newline-separated line as a token.
// `a` is local (its omissions become 'remove'); `b` is remote ('add').
function lineDiff(a: string, b: string): DiffOp[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const m = A.length;
  const n = B.length;

  // dp[i][j] = LCS length of A[0..i) vs B[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (A[i - 1] === B[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
      ops.push({ kind: 'equal', text: A[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ kind: 'add', text: B[j - 1] });
      j--;
    } else {
      ops.push({ kind: 'remove', text: A[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

/** Compress runs of equal lines longer than `context*2` into a fold marker. */
interface DiffSlice {
  ops: DiffOp[];
  hidden?: number;
}
function compress(ops: DiffOp[], context = 3): DiffSlice[] {
  const slices: DiffSlice[] = [];
  // Walk and emit hunks: each hunk surrounded by up to `context` equal lines.
  let i = 0;
  while (i < ops.length) {
    // Find next change.
    let nextChange = i;
    while (nextChange < ops.length && ops[nextChange].kind === 'equal') nextChange++;
    if (nextChange >= ops.length) {
      // Tail of equal lines; emit a fold if it's long.
      const tailEqual = ops.slice(i);
      if (tailEqual.length > context) {
        slices.push({
          ops: tailEqual.slice(0, context),
        });
        if (tailEqual.length > context * 2) {
          slices.push({ ops: [], hidden: tailEqual.length - context });
        } else {
          slices.push({ ops: tailEqual.slice(context) });
        }
      } else if (tailEqual.length > 0) {
        slices.push({ ops: tailEqual });
      }
      break;
    }

    // Pre-context.
    const preStart = Math.max(i, nextChange - context);
    if (preStart > i) {
      const hidden = preStart - i;
      slices.push({ ops: [], hidden });
    }
    // The hunk: from preStart through the end of the change run + context.
    let end = nextChange;
    while (end < ops.length && (ops[end].kind !== 'equal' || end - nextChange < context * 2)) {
      // Track the most-recent change index; expand the trailing context.
      if (ops[end].kind !== 'equal') nextChange = end;
      end++;
    }
    const trailEnd = Math.min(ops.length, nextChange + context + 1);
    slices.push({ ops: ops.slice(preStart, trailEnd) });
    i = trailEnd;
  }
  return slices;
}

const Hunk: React.FC<{ slices: DiffSlice[] }> = ({ slices }) => (
  <pre className="kp-recovery-diff__hunk" aria-label="Diff">
    {slices.map((slice, i) => {
      if (slice.hidden) {
        return (
          <div key={i} className="kp-recovery-diff__fold">
            … {slice.hidden} unchanged line{slice.hidden === 1 ? '' : 's'} …
          </div>
        );
      }
      return slice.ops.map((op, j) => (
        <div key={`${i}:${j}`} className={`kp-recovery-diff__line kp-recovery-diff__line--${op.kind}`}>
          <span className="kp-recovery-diff__sigil">
            {op.kind === 'add' ? '+' : op.kind === 'remove' ? '−' : ' '}
          </span>
          <span className="kp-recovery-diff__text">{op.text || ' '}</span>
        </div>
      ));
    })}
  </pre>
);

export const RecoveryDiffView: React.FC<RecoveryDiffViewProps> = ({
  local,
  remote,
  onApplyLocal,
  onApplyRemote,
  onOpenAsText,
  onCancel,
}) => {
  const slices = React.useMemo(() => compress(lineDiff(local, remote)), [local, remote]);
  const summary = React.useMemo(() => {
    const allOps = slices.flatMap((s) => s.ops);
    const added = allOps.filter((o) => o.kind === 'add').length;
    const removed = allOps.filter((o) => o.kind === 'remove').length;
    return { added, removed };
  }, [slices]);

  return (
    <div className="kp-recovery-diff" role="dialog" aria-modal="true" aria-label="Sync recovery diff">
      <header className="kp-recovery-diff__head">
        <h2 className="kp-recovery-diff__title">Sync conflict — review changes</h2>
        <p className="kp-recovery-diff__summary">
          <span className="kp-recovery-diff__count kp-recovery-diff__count--remove">−{summary.removed}</span>
          <span className="kp-recovery-diff__count kp-recovery-diff__count--add">+{summary.added}</span>
          <span className="kp-recovery-diff__hint">
            Red lines exist only in this device's copy. Green lines exist only in the on-disk file.
          </span>
        </p>
      </header>

      <div className="kp-recovery-diff__body">
        <Hunk slices={slices} />
      </div>

      <footer className="kp-recovery-diff__foot">
        <button type="button" className="kp-recovery-diff__action" onClick={onApplyLocal}>
          Keep local (overwrite disk)
        </button>
        <button type="button" className="kp-recovery-diff__action" onClick={onApplyRemote}>
          Keep remote (overwrite memory)
        </button>
        <button type="button" className="kp-recovery-diff__action kp-recovery-diff__action--ghost" onClick={onOpenAsText}>
          Open as text
        </button>
        <button type="button" className="kp-recovery-diff__action kp-recovery-diff__action--ghost" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </div>
  );
};
