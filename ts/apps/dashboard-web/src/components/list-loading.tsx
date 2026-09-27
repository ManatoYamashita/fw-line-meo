import { TableSkeleton } from '@fwlm/ui/components/skeleton';

// 一覧の取得中の表示。表の形（TableSkeleton）は aria-hidden で支援技術から外れるので、
// 読み上げは role="status" の文言 1 つに一本化する。
//
// 文言は可視のまま残す。動き低減設定下では明滅が止まり、形だけでは「読み込み中」と
// 「空」を見分けられないためである（Req 4.5）。三点リーダは ASCII の 3 点で、振り分けの面の
// U+2026 とは別物である（各面のテストが完全一致で固定している）。
//
// columns と actions は、その面の表の列の数と行の操作（押しボタン）の数に合わせて渡す。
export function ListLoading({ columns, actions = 0 }: { columns: number; actions?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm text-muted-foreground">
        読み込み中...
      </p>
      <TableSkeleton columns={columns} actions={actions} />
    </div>
  );
}
