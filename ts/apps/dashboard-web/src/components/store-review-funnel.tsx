'use client';

import { useEffect, useId, useState } from 'react';

import { Heading } from '@fwlm/ui/components/heading';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@fwlm/ui/components/table';

import { getStoreReviewFunnel, type ApiResult, type StoreReviewFunnelMonth } from '../lib/api';

// QR パネルに出す、その店舗のアンケートの実績（Issue #401・store-qr-issuance-ui Requirement 8）。
//
// 取得は QR 画像とは別の副作用・別の状態で行う。1 つに束ねると、実績の失敗が QR の失敗として
// 描かれるか、QR の成功が実績の読み込み中を隠すかのどちらかになる（8.4）。失敗は実績の領域の
// 文言に閉じ、トーストも出さない。QR の発行という主操作の結果と取り違えないためである。
//
// 状態の変化は読み上げない（ライブリージョンを持たない）。実績は補助の情報で、パネルの状態通知
// （発行の成否・Requirement 6.2）と同じ領域で読み上げると主操作の結果を上書きする。

export interface StoreReviewFunnelProps {
  readonly storeId: string;
  readonly storeName: string;
  /** 取得手続きの注入（既定は getStoreReviewFunnel）。テストでネットワークを発火させないために持つ。 */
  readonly fetchFunnel?: (storeId: string) => Promise<ApiResult<StoreReviewFunnelMonth[]>>;
}

type FunnelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly months: readonly StoreReviewFunnelMonth[] }
  // code は持たない。どの失敗でも同じ文言を出すためである。とくに 403 と 404 を区別すると、
  // 担当外の店舗が存在するか否かを推測できる（Requirement 8.6）。
  | { readonly kind: 'error' };

// 押下の回数が投稿の件数ではないことの明示（Requirement 8.3）。表と同じ領域に置く。
// Google への投稿は客と Google の間で完結し、本システムは観測できない。
export const REVIEW_LINK_OPENS_NOTE =
  '「Google の投稿画面へ進んだ回数」は、アンケートに回答した方が下書きの画面から Google のクチコミ投稿画面を開いた回数です。実際に投稿されたかどうかは Google 側で決まるため、この画面では分かりません。';

const LOADING_TEXT = '実績を読み込んでいます';
const ERROR_TEXT = '実績を読み込めませんでした。QR の表示・保存・印刷には影響しません。';

// サーバは当月・前月を新しい順に返す。「今月」の判定はサーバ（JST）が持ち、ここでは計算しない。
const RELATIVE_MONTH_LABELS = ['今月', '先月'] as const;

/**
 * 列見出しの 2 段（「今月」と「9月」）。想定外の位置の月は上段を年にする（「2026年」「7月」）。
 *
 * 1 段の「今月（9月）」にしないのは、列見出しが折り返さないためである。幅 320 では 2 列の見出しが
 * 幅を取り、行見出しが 1 文字ぶんまで潰れて縦に並んだ（E2E の R1 で実測: 幅 12px・16 行）。
 */
function monthLabel(month: string, index: number): { readonly upper: string; readonly lower: string } {
  const [year, mm] = month.split('-');
  const lower = `${Number(mm)}月`;
  const relative = RELATIVE_MONTH_LABELS[index];
  return { upper: relative ?? `${year}年`, lower };
}

export function StoreReviewFunnel({ storeId, storeName, fetchFunnel }: StoreReviewFunnelProps) {
  const [state, setState] = useState<FunnelState>({ kind: 'loading' });
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (fetchFunnel ?? getStoreReviewFunnel)(storeId)
      .then((result) => {
        // 取得完了前にアンマウントされた（別の店舗へ切り替えた）場合は反映しない。
        if (cancelled) return;
        setState(result.ok ? { kind: 'ready', months: result.value } : { kind: 'error' });
      })
      .catch(() => {
        // api client は例外を外へ出さないので通常は到達しない。到達しても読み込み中のまま
        // 固着させず、失敗として描く。
        if (cancelled) return;
        setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, fetchFunnel]);

  return (
    // 印刷の対象から外す（Requirement 8.5・7.5）。この部品は掲示面（data-print-region）の外に置かれる
    // が、globals.css の外側を畳む指定は :has() に依存するので、素の print:hidden を直接与えて二重に守る。
    // 掲示面に件数が刷られると、客へ集計結果を見せることになる。
    <section aria-labelledby={headingId} className="flex flex-col gap-2 text-sm print:hidden">
      <Heading level={3} size="sm" id={headingId}>
        アンケートの実績
      </Heading>
      {state.kind === 'loading' ? <p className="text-muted-foreground">{LOADING_TEXT}</p> : null}
      {state.kind === 'error' ? <p className="text-muted-foreground">{ERROR_TEXT}</p> : null}
      {state.kind === 'ready' ? (
        <>
          {/* 行を指標、列を月にする。逆にすると長い指標名が列見出しになり、折り返さない列見出しが
              携帯端末の幅を押し広げる。件数は星評価その他の回答の内容で分けない（Requirement 8.2）。 */}
          {/* responsive は、捲り容器（店舗一覧の表）が狭いときだけセルの横余白を詰める。 */}
          <Table density="responsive" aria-label={`${storeName} のアンケートの実績`}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>
                  <span className="sr-only">項目</span>
                </TableHeaderCell>
                {state.months.map((m, index) => {
                  const label = monthLabel(m.month, index);
                  return (
                    <TableHeaderCell key={m.month} className="text-right">
                      <span className="block">{label.upper}</span>
                      <span className="block">{label.lower}</span>
                    </TableHeaderCell>
                  );
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow>
                <TableHeaderCell scope="row" className="whitespace-normal">
                  アンケートの回答
                </TableHeaderCell>
                {state.months.map((m) => (
                  // 0 件も空欄にせず数字で出す（Requirement 8.7）。
                  <TableCell key={m.month} numeric wrap="none">
                    {m.responses} 件
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableHeaderCell scope="row" className="whitespace-normal">
                  Google の投稿画面へ進んだ回数
                </TableHeaderCell>
                {state.months.map((m) => (
                  <TableCell key={m.month} numeric wrap="none">
                    {m.reviewLinkOpens} 回
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
          <p className="text-muted-foreground">{REVIEW_LINK_OPENS_NOTE}</p>
        </>
      ) : null}
    </section>
  );
}
