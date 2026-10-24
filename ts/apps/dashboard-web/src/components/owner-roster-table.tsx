import type { ReactNode } from 'react';
import { Badge } from '@fwlm/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@fwlm/ui/components/table';
import { storesOfOwner, type OwnerStoresLoad } from '../lib/agency-roster';
import { formatJstDate } from '../lib/jst-date';
import {
  ONBOARDING_STATUS_LABEL,
  PLACE_STATUS_LABEL,
  STORE_SUSPENSION_LABEL,
} from '../lib/status-labels';
import type { OwnerListItem } from '../lib/types';

// 1 代理店ぶんのオーナーと登録済み店舗の表（Issue #485）。店舗登録のオーナー選択と代理店詳細（Issue #486）で使う。
//
// 表は表のまま描く（正典 §7.2・カードの並びにしない）。**行そのものは押せるようにしない。**
// 行を押せる形にすると、押せない一覧の行と見分けが付かず、誤った可動感を与える（§7.2）。
// 選択のような行の操作は、呼び出し側が `renderAction` で末尾の列に押しボタンとして置く。
//
// 状態は文字のラベルで出し、色だけで伝えない。停止中は異常ではなく状態なので危険の色を使わず、
// ブランド色（Badge の既定の変種）は 1 画面 1〜2 箇所までなので各行には使わない（§7.4）。

const NO_DISPLAY_NAME = '（表示名なし）';
const UNKNOWN_DATE = '不明';

/** 表に出すオーナーの名前。表示名が無ければ「（表示名なし）」（id は利用者に意味が無いので出さない）。 */
export function ownerDisplayLabel(owner: OwnerListItem): string {
  return owner.displayName ?? NO_DISPLAY_NAME;
}

/**
 * 行ごとに区別できるオーナーの名前（読み上げ名・登録先の表示に使う）。
 *
 * 表示名が無いオーナー同士は「（表示名なし）」だけでは区別できないので、作成日を添える。
 */
export function ownerDistinctLabel(owner: OwnerListItem): string {
  if (owner.displayName !== null) return owner.displayName;
  return `（表示名なし・${formatJstDate(owner.createdAt) ?? UNKNOWN_DATE} 作成）`;
}

function OwnerStoresCell({ owner, stores }: { owner: OwnerListItem; stores: OwnerStoresLoad }) {
  // 店舗だけの取得に失敗したときは件数を出さない。「登録済みの店舗はありません」と出すと
  // 失敗を 0 件に化けさせる（Req 7.4）。失敗そのものは表の上の通知が伝える。
  if (stores.kind === 'error') {
    return <span className="text-muted-foreground">読み込めませんでした</span>;
  }
  const owned = storesOfOwner(stores.byOwner, owner.id);
  if (owned.length === 0) {
    return <span className="text-muted-foreground">登録済みの店舗はありません</span>;
  }
  return (
    // Preflight が `list-style: none` を与えるため、一部のブラウザは一覧の意味論を落とす。明示する。
    <ul role="list" className="flex flex-col gap-1.5">
      {owned.map((store) => (
        <li key={store.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* 横並びの子なので、長い店名がセルを押し広げないよう縮められるようにする（正典 §6）。 */}
          <span className="min-w-0">{store.name}</span>
          <Badge variant="outline">{PLACE_STATUS_LABEL[store.placeStatus]}</Badge>
          {store.suspendedAt !== null && (
            <Badge variant="secondary">{STORE_SUSPENSION_LABEL.suspended}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

export function OwnerRosterTable({
  label,
  owners,
  stores,
  renderAction,
}: {
  /** 表の捲れる領域の名前（支援技術へ領域として公開する）。 */
  label: string;
  owners: readonly OwnerListItem[];
  stores: OwnerStoresLoad;
  /** 行の末尾に置く操作。渡したときだけ「操作」の列を描く。 */
  renderAction?: (owner: OwnerListItem) => ReactNode;
}) {
  return (
    // 横方向の捲りは表の外側（容器）が持つ。狭い幅では容器の中で横に捲れ、ページは溢れない（§7.18）。
    <TableContainer label={label}>
      <Table density="responsive">
        <TableHead>
          <TableRow>
            <TableHeaderCell>表示名</TableHeaderCell>
            <TableHeaderCell>状態</TableHeaderCell>
            <TableHeaderCell>登録済みの店舗</TableHeaderCell>
            <TableHeaderCell>作成日</TableHeaderCell>
            {renderAction !== undefined && <TableHeaderCell>操作</TableHeaderCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {owners.map((owner) => (
            <TableRow key={owner.id}>
              <TableCell wrap="prose">{ownerDisplayLabel(owner)}</TableCell>
              <TableCell wrap="none">
                <Badge variant="secondary">{ONBOARDING_STATUS_LABEL[owner.onboardingStatus]}</Badge>
              </TableCell>
              <TableCell wrap="prose">
                <OwnerStoresCell owner={owner} stores={stores} />
              </TableCell>
              <TableCell wrap="none">{formatJstDate(owner.createdAt) ?? UNKNOWN_DATE}</TableCell>
              {renderAction !== undefined && (
                <TableCell wrap="none">{renderAction(owner)}</TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
