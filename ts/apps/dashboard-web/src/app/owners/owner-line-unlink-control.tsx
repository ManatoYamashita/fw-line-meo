'use client';

// 1 オーナー分の LINE の解除・メニューの外し直しの操作部品（owner-line-unlink tasks 5.2 /
// Requirements 1.4, 1.7, 2.2, 2.3, 3.2, 3.3 / design.md「OwnersPage・OwnerLineUnlinkControl」）。
// 型紙は stores/store-suspension-control.tsx で、焦点・ライブリージョン・二重送信の扱いを揃えている。
//
// 連携中は「LINE の連携を解除」、解除済みでメニューを外せていなければ「メニューを外し直す」を出し、
// どちらでもない解除済みには操作を出さない（2.2, 2.3, 3.3）。解除は確認ダイアログで 3 点を示してから
// 送り（1.4）、外し直しは紐づけの状態を変えないので確認なしで送る。どちらも同じ POST /owners/:id/unlink
// へ送る（解除済みへ送るとサーバーはメニューだけを外し直す）。
//
// **押しボタンは解除と外し直しで同じ 1 つの要素にする。** メニューを外せずに解除が終わると、
// 読み直した一覧でこの行の操作は外し直しへ変わる。別の要素で描くと押した要素が消え、焦点が文書の
// 先頭へ落ちる。文言だけを差し替えれば焦点は押した位置に留まる。
//
// **操作そのものが消えるときは、焦点を結果の文言へ移す。** 解除に成功して読み直すと、解除済みの
// 行には操作が無くなる（2.3）。押した要素の行き先が無いので、結果を告げる領域へ焦点を移して
// 文書の先頭へ落とさない。領域は tabIndex=-1 で、Tab の順には入れない。
//
// **実行中は無効を aria-disabled で示し、焦点を奪わない。** 二重送信は押下の処理の側でも弾く。
//
// **結果はダイアログの外で告げる。** 成功は常に置いてあるライブリージョン（role="status"）の文言を
// 差し替えて告げ、失敗とメニューを外せなかったことは Alert の destructive 変種（role="alert"）で示す。
// メニューを外せなかったときは解除自体は完了しているが（3.2）、利用者に次の操作（外し直し）が要るので
// 見落とされにくい側で示し、解除の成功だけを告げる文言は出さない。
//
// 一覧の読み直し（onChanged）は結果によらず呼ぶ。画面は推測で行を書き換えず、読み直した一覧に
// 実際の状態を示させる。要求が失敗したときサーバーは解除前のまま保つので（1.7）、行は連携中のまま残る。

import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@fwlm/ui/components/alert-dialog';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Spinner } from '@fwlm/ui/components/spinner';
import { SuccessIcon } from '@fwlm/ui/components/success-icon';
import { ownerDistinctLabel } from '../../components/owner-roster-table';
import {
  notifyActionError,
  notifyActionSuccess,
  notifyActionWarning,
} from '../../lib/action-feedback';
import { unlinkOwnerLine, type ApiResult } from '../../lib/api';
import type { OwnerLineUnlinkResult, OwnerListItem } from '../../lib/types';

export interface OwnerLineUnlinkControlProps {
  owner: OwnerListItem;
  // 一覧を読み直す。成功・失敗のどちらでも呼ぶ。
  onChanged: () => Promise<void>;
}

type Action = 'unlink' | 'retry';

const ACTION_LABEL: Record<Action, string> = {
  unlink: 'LINE の連携を解除',
  retry: 'メニューを外し直す',
};

/** 押しボタンの読み上げ名。英字の前には空きを置く（「の QR 発行」と同じ表記）。 */
function actionName(ownerName: string, action: Action): string {
  return action === 'unlink' ? `${ownerName} の ${ACTION_LABEL.unlink}` : `${ownerName} の${ACTION_LABEL.retry}`;
}

/** この行に出す操作。解除済みでメニューも外し終えていれば null（操作を出さない・2.3）。 */
function actionOf(owner: OwnerListItem): Action | null {
  if (owner.lineLink === 'linked') return 'unlink';
  return owner.menuUnlinkPending ? 'retry' : null;
}

const MENU_FAILED_AFTER_UNLINK =
  '連携は解除しました。LINE のメニューは外せませんでした。「メニューを外し直す」から再試行してください。';
const MENU_FAILED_AFTER_RETRY =
  'LINE のメニューを外せませんでした。時間をおいて「メニューを外し直す」から再試行してください。';

// 要求の失敗の文言（design.md「Error Categories and Responses」）。
// 不存在・範囲外は同じ 404 に写されるので、どちらの場合も「見つからない」とだけ伝える（Req 1.3）。
// 認証・権限の失敗も固定の利用者向け文言へ写し、サーバの内部文言は表示しない。
// 応答が返った失敗（500 など）はサーバーが解除前のまま保っているので、できなかったと言い切る（1.7）。
// 通信できなかったときだけは要求が届いたかを判別できないので、一覧を確かめるよう促す。
function failureMessage(action: Action, result: { code: string }): string {
  if (result.code === 'not_found') return 'オーナーが見つかりません。一覧を更新しました。';
  if (result.code === 'unauthenticated') return 'ログインの有効期限が切れています。再度ログインしてください。';
  if (result.code === 'forbidden') return 'このオーナーを変更する権限がありません。';
  if (result.code === 'network') {
    return action === 'unlink'
      ? '解除できたか確認できませんでした。一覧の表示を確認してください。'
      : 'メニューを外し直せたか確認できませんでした。一覧の表示を確認してください。';
  }
  return action === 'unlink'
    ? 'LINE の連携を解除できませんでした。時間をおいてもう一度お試しください。'
    : 'LINE のメニューを外し直せませんでした。時間をおいてもう一度お試しください。';
}

export function OwnerLineUnlinkControl({ owner, onChanged }: OwnerLineUnlinkControlProps) {
  const action = actionOf(owner);
  const name = ownerDistinctLabel(owner);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 描画を待たずに二重送信を弾くための印（state は次の描画まで古い値のまま）。
  const inFlight = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // 操作の後、押しボタンが消えていたら焦点を結果の文言へ移すための印。
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    if (settled === 0) return;
    // 押しボタンが残っていれば焦点はそこに留まっている。消えていて、焦点が文書の先頭へ落ちた
    // ときだけ移す（利用者がすでに別の場所へ移っていれば動かさない）。
    if (buttonRef.current !== null) return;
    const active = document.activeElement;
    if (active === null || active === document.body) statusRef.current?.focus();
  }, [settled]);

  async function run(target: Action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setSuccessMessage('');
    setErrorMessage(null);

    let result: ApiResult<OwnerLineUnlinkResult>;
    try {
      result = await unlinkOwnerLine({ id: owner.id });
    } catch {
      // API 層は例外を投げない約束だが、万一のときも「確認できなかった」側へ倒す。
      result = { ok: false, code: 'network', message: '' };
    }

    try {
      await onChanged();
    } catch {
      // swallowed-exception: intentional — 読み直しの失敗は一覧の側が示す。この部品は要求の結果だけを告げる。
    }

    // 読み直しの後に告げる。表示が新しい状態へ変わってから結果を読み上げ、両者を食い違わせない。
    if (!result.ok) {
      const message = failureMessage(target, result);
      setErrorMessage(message);
      notifyActionError({
        title:
          target === 'unlink'
            ? `${name} の LINE の連携を解除できませんでした`
            : `${name} の LINE のメニューを外し直せませんでした`,
        description: message,
      });
    } else if (result.value.menu === 'failed') {
      const message = target === 'unlink' ? MENU_FAILED_AFTER_UNLINK : MENU_FAILED_AFTER_RETRY;
      setErrorMessage(message);
      notifyActionWarning({ title: `${name} の LINE のメニューを外せませんでした`, description: message });
    } else {
      const message =
        target === 'unlink'
          ? `${name} の LINE の連携を解除しました。`
          : `${name} の LINE のメニューを外しました。`;
      setSuccessMessage(message);
      notifyActionSuccess({ title: message });
    }
    inFlight.current = false;
    setPending(false);
    setSettled((count) => count + 1);
  }

  function handlePress() {
    if (inFlight.current || action === null) return;
    if (action === 'unlink') {
      setConfirmOpen(true);
    } else {
      void run('retry');
    }
  }

  return (
    <div className="flex flex-col items-start">
      {action !== null && (
        <Button
          ref={buttonRef}
          variant="outline"
          size="sm"
          // 無効でも焦点を保つ（先頭の注記）。見た目の減光は aria-disabled に合わせて付ける。
          disabled={pending}
          focusableWhenDisabled
          className="aria-disabled:opacity-50"
          onClick={handlePress}
          // 見えている文言を読み上げ名へそのまま含める（WCAG 2.5.3 Label in Name）。
          aria-label={actionName(name, action)}
          aria-haspopup={action === 'unlink' ? 'dialog' : undefined}
        >
          {pending && <Spinner aria-hidden />}
          {ACTION_LABEL[action]}
        </Button>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent finalFocus={buttonRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{name} の LINE の連携を解除しますか？</AlertDialogTitle>
            {/* 3 点は箇条で示し、まとめてダイアログの説明として支援技術へ結び付ける（1.4）。
              * 説明の部品は既定で段落を描くので、箇条を入れられる要素へ差し替える。 */}
            <AlertDialogDescription render={<div />}>
              {/* Preflight が list-style を消すため、一部のブラウザは一覧の意味論を落とす。明示する。 */}
              <ul role="list" className="flex list-disc flex-col gap-1 pl-5">
                <li>元の LINE アカウントには日次の変化通知が届かなくなり、店舗の情報も見られなくなります。</li>
                <li>店舗とその履歴は消えずに残ります。</li>
                <li>同じ店舗を LINE で確定し直すと、店舗を引き継げます。</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* キャンセルを先に並べる。開いた直後の焦点がキャンセルに置かれる（部品の前提）。 */}
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void run('unlink')}>
              解除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 成功の通知。領域は常に置き、文言だけを差し替える。空のときは余白を持たせない。
        * 成功色はアクション色と色だけでは見分けられないので、文言には必ず印を添える。
        * 操作が消えたときの焦点の受け口を兼ねる（先頭の注記）。 */}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="flex items-start gap-1 text-xs text-success [&:not(:empty)]:mt-2"
      >
        {successMessage !== '' && (
          <>
            <SuccessIcon className="mt-px size-3.5" />
            {successMessage}
          </>
        )}
      </p>
      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
      {errorMessage !== null && (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
