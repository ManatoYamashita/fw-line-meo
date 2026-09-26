'use client';

// 1 店舗分の停止・再開の操作部品（store-suspension tasks 5.2 / Requirements 1.6, 1.8, 2.2, 2.3 /
// design.md「StoreSuspensionControl」）。
//
// 利用中は「利用中」と停止の押しボタン、停止中は「停止中」と再開の押しボタンを出す（2.2, 2.3）。
// 停止は確認ダイアログで止まるものを示してから実行し、再開は確認なしで実行する（Req 1.6 は停止だけを
// 確認の対象にしている）。
//
// **押しボタンは状態によらず同じ 1 つの要素にする。** 停止が成功して一覧を読み直すと、この部品は
// 停止中の表示へ切り替わる。停止と再開を別の要素で描くと、押した要素が消えて焦点が文書の先頭へ
// 落ちる。同じ要素の文言だけを差し替えれば、焦点は押した位置に留まる。確認ダイアログは起点の
// Trigger を持たずに開閉を自前で持ち、閉じたときの焦点の戻り先（finalFocus）をこの要素に向ける。
//
// **実行中は無効を aria-disabled で示し、焦点を奪わない。** 素の disabled 属性は要素を焦点の順から外す
// ため、確認ダイアログが閉じて焦点が戻った直後に無効化されると、焦点が文書の先頭へ落ちる。
// 二重送信は押下の処理の側でも弾く（見た目の無効だけに頼らない）。
//
// **結果はダイアログの外で告げる。** 確定するとダイアログは閉じ、中の文言は支援技術から見えなくなる。
// 成功は常に置いてあるライブリージョン（role="status"）の文言を差し替えて告げる。文言と同時に
// 領域を挿入すると読み上げられないことがあるためである。失敗は Alert の destructive 変種
// （role="alert"）で示す（1.8）。処理中の「実行中…」は読み上げない（情報を持たない中間状態のため）。
//
// 一覧の読み直し（onChanged）は結果によらず呼ぶ。監査の書込が失敗して 500 になっても停止は成立して
// いるので、画面は推測で状態を書き換えず、読み直した一覧に実際の状態を示させる（design「停止の操作」）。

import { useRef, useState } from 'react';
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
import { Badge } from '@fwlm/ui/components/badge';
import { Button } from '@fwlm/ui/components/button';
import { Spinner } from '@fwlm/ui/components/spinner';
import { notifyActionError, notifyActionSuccess } from '../../lib/action-feedback';
import { resumeStore, suspendStore, type ApiResult } from '../../lib/api';
import type { StoreSuspensionState } from '../../lib/types';

export interface StoreSuspensionControlProps {
  store: { id: string; name: string; suspendedAt: string | null };
  // 一覧を読み直す。成功・失敗のどちらでも呼ぶ。
  onChanged: () => Promise<void>;
}

type Action = 'suspend' | 'resume';

const ACTION_LABEL: Record<Action, string> = { suspend: '停止', resume: '再開' };

// 失敗の文言（design.md「Error Categories and Responses」）。
// 不存在・範囲外は同じ 404 に写されるので、どちらの場合も「見つからない」とだけ伝える（Req 1.4）。
// 認証・権限の失敗も固定の利用者向け文言へ写し、サーバの内部文言は表示しない。
// それ以外（監査の失敗・DB 障害・通信不能）は、要求が届いて成立したかどうかを画面から判別できない。
// 成功したかのようにも失敗したかのようにも言い切らず、読み直した一覧を確かめるよう促す（1.8）。
function failureMessage(action: Action, result: { code: string }): string {
  if (result.code === 'not_found') return '店舗が見つかりません。一覧を更新しました。';
  if (result.code === 'unauthenticated') return 'ログインの有効期限が切れています。再度ログインしてください。';
  if (result.code === 'forbidden') return 'この店舗を変更する権限がありません。';
  return `${ACTION_LABEL[action]}できたか確認できませんでした。一覧の表示を確認してください。`;
}

export function StoreSuspensionControl({ store, onChanged }: StoreSuspensionControlProps) {
  const suspended = store.suspendedAt !== null;
  const action: Action = suspended ? 'resume' : 'suspend';

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 描画を待たずに二重送信を弾くための印。state は次の描画まで古い値のままなので、同じ処理の
  // 中で続けて押されたときに素通りする。
  const inFlight = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  async function run(target: Action) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setSuccessMessage('');
    setErrorMessage(null);

    let result: ApiResult<StoreSuspensionState>;
    try {
      result =
        target === 'suspend'
          ? await suspendStore({ id: store.id })
          : await resumeStore({ id: store.id });
    } catch {
      // API 層は例外を投げない約束だが、万一のときも「確認できなかった」側へ倒す。
      result = { ok: false, code: 'unexpected', message: '' };
    }

    try {
      await onChanged();
    } catch {
      // swallowed-exception: intentional — 読み直しの失敗は一覧の側が示す。この部品は要求の結果だけを告げる。
    }

    // 読み直しの後に告げる。表示が新しい状態へ変わってから結果を読み上げ、両者を食い違わせない。
    if (result.ok) {
      const message = `${store.name} を${ACTION_LABEL[target]}しました。`;
      setSuccessMessage(message);
      notifyActionSuccess({ title: message });
    } else {
      const message = failureMessage(target, result);
      setErrorMessage(message);
      notifyActionError({
        title: `${store.name} を${ACTION_LABEL[target]}できませんでした`,
        description: message,
      });
    }
    inFlight.current = false;
    setPending(false);
  }

  function handlePress() {
    if (inFlight.current) return;
    if (action === 'suspend') {
      setConfirmOpen(true);
    } else {
      void run('resume');
    }
  }

  return (
    <div className="flex flex-col items-start">
      <div className="flex items-center gap-2">
        <Badge variant={suspended ? 'destructive' : 'secondary'}>
          {suspended ? '停止中' : '利用中'}
        </Badge>
        <Button
          ref={buttonRef}
          variant="outline"
          size="sm"
          // 無効でも焦点を保つ（先頭の注記）。見た目の減光は aria-disabled に合わせて付ける。
          disabled={pending}
          focusableWhenDisabled
          className="aria-disabled:opacity-50"
          onClick={handlePress}
          // 見えている文言（停止・再開）を読み上げ名へそのまま含める（WCAG 2.5.3 Label in Name）。
          aria-label={`${store.name} を${ACTION_LABEL[action]}`}
          aria-haspopup={action === 'suspend' ? 'dialog' : undefined}
        >
          {pending && <Spinner aria-hidden />}
          {ACTION_LABEL[action]}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent finalFocus={buttonRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{store.name} を停止しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              停止すると、日次の取得・変化通知・アンケート・QR の発行・詳細画面が止まります。
              店舗の登録と蓄積済みのデータはそのまま残り、あとから再開できます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* キャンセルを先に並べる。開いた直後の焦点がキャンセルに置かれる（部品の前提）。 */}
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void run('suspend')}>
              停止する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 成功の通知。領域は常に置き、文言だけを差し替える（先頭の注記）。display: none にすると
        * 支援技術から領域ごと外れるので隠さない。空のときは余白を持たせず、行の高さを変えない。 */}
      <p role="status" className="text-xs text-success [&:not(:empty)]:mt-2">
        {successMessage}
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
