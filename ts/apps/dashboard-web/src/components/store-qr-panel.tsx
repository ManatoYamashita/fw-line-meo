'use client';

import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@fwlm/ui/components/alert';
import { Button, buttonVariants } from '@fwlm/ui/components/button';
import { Card, CardContent, CardHeader } from '@fwlm/ui/components/card';
import { Heading } from '@fwlm/ui/components/heading';
import { Spinner } from '@fwlm/ui/components/spinner';

import { getStoreQr, type ApiResult, type BinaryPayload } from '../lib/api';
import { qrFileName } from '../lib/qr-filename';

// 1 店舗ぶんの QR を取得・表示・保存させ、表示資源（object URL）を確実に解放する部品。
// 設計: store-qr-issuance-ui「StoreQrPanel」（Requirements 2.1, 2.2, 2.3, 2.8, 3.3, 4.1-4.5,
// 5.2, 5.3, 5.4, 6.2, 6.4）。
//
// 対象は常に 1 店舗で、複数店舗の同時保持を行わない。取得結果は永続化せず、生存期間は
// この部品の生存期間に一致する。失敗の影響はパネル内に閉じ、店舗一覧を再取得しない。

export interface StoreQrPanelProps {
  readonly storeId: string;
  readonly storeName: string;
  /** 閉じる操作。開閉状態は呼び出し側（店舗一覧）が所有する。 */
  readonly onClose: () => void;
  /** 取得手続きの注入（既定は getStoreQr）。テストでネットワークを発火させないために持つ。 */
  readonly fetchQr?: (storeId: string) => Promise<ApiResult<BinaryPayload>>;
}

type QrState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly imageUrl: string }
  // サーバの message は保持しない。保持すると「描画してはならない値」を手の届く場所へ置くことに
  // なり、Requirement 4.1 の違反が「たまたま起きていないだけ」の状態になる。code だけを持つ。
  | { readonly kind: 'error'; readonly code: string };

// 取得する QR の一辺（px）。api client が size=1024 を要求するため実体もこの寸法になる。
// width/height に実寸を与えることで、読み込み完了時のレイアウトのずれを防ぐ。
const QR_PIXELS = 1024;

interface QrErrorText {
  readonly title: string;
  readonly description: string;
}

// 権限不足（403）と対象不在（404）に与える共通の文言。担当外の店舗が存在するか否かを
// 推測できる情報を与えないため、両者を同一の文言へ写す（Requirement 4.1）。
// サーバは 403 と 404 で異なる文言を返すが、その区別をそのまま画面へ流してはならない。
const ACCESS_DENIED_TEXT: QrErrorText = {
  title: 'この店舗の QR は発行できません',
  description: '店舗一覧を再読み込みして、対象の店舗をご確認ください。',
};

// サーバが返す code を利用者向けの文言へ写す対応表。api client は code を保つだけで
// 文言を決めない（責務をここに一本化する）。既知でない code は再試行可能な一般障害として扱う。
// オブジェクトリテラルではなく Map を使う。リテラルの添字参照は Object.prototype を辿るため、
// code が 'constructor' や 'toString' だと ?? が発火せず空の文言で描画されうる。
// code は封筒から取る任意の文字列なので、鎖を持たない入れ物で受ける。
const ERROR_TEXT_BY_CODE = new Map<string, QrErrorText>([
  [
    'UNAUTHENTICATED',
    {
      title: 'ログインの有効期限が切れています',
      description: '再度ログインしてから QR を発行してください。',
    },
  ],
  ['FORBIDDEN', ACCESS_DENIED_TEXT],
  ['NOT_FOUND', ACCESS_DENIED_TEXT],
  [
    'PLACE_NOT_CONFIRMED',
    {
      title: '店舗の場所が未確定です',
      description: 'QR の発行には店舗の場所の確定が先に必要です。',
    },
  ],
]);

// 通信障害・内部障害・空応答・未知の code。成功したかのような表示は行わない。
const GENERIC_ERROR_TEXT: QrErrorText = {
  title: 'QR を発行できませんでした',
  description: '通信状況を確認して再試行してください。',
};

function errorTextFor(code: string): QrErrorText {
  return ERROR_TEXT_BY_CODE.get(code) ?? GENERIC_ERROR_TEXT;
}

export function StoreQrPanel({ storeId, storeName, onClose, fetchQr }: StoreQrPanelProps) {
  const [state, setState] = useState<QrState>({ kind: 'loading' });
  // 再試行の回数。副作用の依存に含めることで、再試行を「取得をやり直す」という
  // 一つの意味に閉じる（取得・生成・解放が常に同じ経路を通る）。
  const [attempt, setAttempt] = useState(0);
  // 再試行が成功したときの焦点の受け皿。押下元（再試行）はその遷移で描画対象から外れる。
  const saveLinkRef = useRef<HTMLAnchorElement | null>(null);

  // 取得・object URL の生成・解放を単一の副作用に閉じる。生成と解放が別の場所に分かれると、
  // 解放漏れが「動くが残る」形の欠陥になり検出できない。
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setState({ kind: 'loading' });

    void (fetchQr ?? getStoreQr)(storeId).then((result) => {
      // 取得完了前にアンマウントされた場合は状態へ反映せず、資源も作らない。
      if (cancelled) return;
      if (!result.ok) {
        setState({ kind: 'error', code: result.code });
        return;
      }
      const blob = new Blob([result.value.bytes], { type: result.value.contentType });
      createdUrl = URL.createObjectURL(blob);
      setState({ kind: 'ready', imageUrl: createdUrl });
    }).catch(() => {
      // 取得そのものは api client が try/catch するため通常は到達しない。到達するのは
      // Blob 生成や object URL 生成が失敗した場合で、握り潰すと loading のまま固着し、
      // 再試行の操作も出せなくなる（脱出不能になる）。失敗として扱い再試行可能にする。
      if (cancelled) return;
      setState({ kind: 'error', code: 'unexpected' });
    });

    return () => {
      cancelled = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  }, [storeId, fetchQr, attempt]);

  // 焦点の引き取り（Requirement 6.1 後段）。このパネルが焦点を壊した場合にだけ引き取る。
  //
  // 再試行を押した要素は、取得成功時に描画対象から外れる。要素が DOM から消えるとブラウザは
  // 焦点を body へ移すが、body には焦点指標が無く「現在の焦点がどこにあるかを視覚的に判別
  // できる状態」が壊れる。行き場を失った場合にだけ、パネル内の次の操作（保存）へ移す。
  //
  // 初回取得（attempt === 0）では焦点は一覧の発行操作にあり、このパネルは何も壊していない。
  // 取得中に利用者が自分で別の要素へ焦点を移した場合も同じで、いずれも触ると横取りになる。
  // 押下元への ref は持たない。この副作用が走る時点で押下元は既にアンマウント済みであり、
  // ref は null になっていて比較対象にならない。「焦点が行き場を失ったか」を直接見る。
  useEffect(() => {
    if (state.kind !== 'ready' || attempt === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    saveLinkRef.current?.focus();
  }, [state.kind, attempt]);

  // 状態の変化を支援技術へ通知する単一のライブリージョン（Requirement 6.2）。
  // 失敗時は Alert（role="alert"）が担うため、ここは空にして二重読み上げを避ける。
  const statusText =
    state.kind === 'loading'
      ? `${storeName} の QR を生成しています`
      : state.kind === 'ready'
        ? `${storeName} の QR を表示しました`
        : '';

  return (
    <Card size="sm">
      <CardHeader>
        <Heading level={2} size="base">
          {storeName} の QR
        </Heading>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
         * 図形は装飾として扱い aria-hidden で支援技術から外す。 */}
        <p role="status" className="flex items-center gap-2">
          {state.kind === 'loading' ? <Spinner aria-hidden /> : null}
          {statusText}
        </p>

        {state.kind === 'ready' ? (
          <img
            // next/image を使わないのは意図的。最適化の実体はサーバ側でのフェッチと変換であり、
            // クライアントで生成した blob: URL は取得できない。レイアウトのずれ防止は既知の
            // 実寸を width/height に明示することで同じ効果を得る。
            src={state.imageUrl}
            alt={`${storeName} のアンケート QR コード`}
            width={QR_PIXELS}
            height={QR_PIXELS}
            className="h-auto w-64 max-w-full"
          />
        ) : null}

        {state.kind === 'error' ? (
          <Alert variant="destructive">
            <AlertTitle>{errorTextFor(state.code).title}</AlertTitle>
            <AlertDescription>{errorTextFor(state.code).description}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {state.kind === 'ready' ? (
            // 保存は実際のリンク要素として描画する。プログラムによる click 合成は行わない。
            // 表示と保存へ同一の object URL を束ねるため、保存時に再取得は発生しない。
            //
            // Button の render で <a> を描かせないのは意図的。Base UI は nativeButton={false} の
            // とき描画先へ role="button" を付けるため、支援技術にはリンクではなくボタンとして
            // 提示され、download 属性を持つ実リンクという実体と食い違う。見た目だけを
            // buttonVariants から借り、要素と役割は素の <a> のまま保つ。
            <a
              ref={saveLinkRef}
              href={state.imageUrl}
              download={qrFileName(storeName, storeId)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              aria-label={`${storeName} の QR 画像を保存`}
            >
              画像を保存
            </a>
          ) : null}
          {state.kind === 'error' || (state.kind === 'loading' && attempt > 0) ? (
            // 再試行はパネル内で完結させ、店舗一覧の再取得は伴わせない（Requirement 4.4）。
            //
            // 再取得の間もこの要素を描画し続ける。押下元が DOM から外れると焦点が body へ落ち、
            // Requirement 6.1 後段が禁じる状態になる（閉じる操作で一覧側が焦点を戻しているのと
            // 同じ形の欠陥が、再試行にだけ残っていた）。
            //
            // disabled は focusableWhenDisabled と併せて渡す。Base UI は native button に対して
            // この組み合わせのとき **native の disabled 属性を付けず** aria-disabled と
            // data-disabled だけを与え、tabIndex を保つ。押下は primitive 側の onClick が
            // preventDefault で止めるため、重複した発行要求の抑止（Requirement 2.2）は
            // ここに手書きのガードを足さなくても成立する。
            //
            // 減光は data-disabled 経由で与える。buttonVariants の減光は native の :disabled
            // 擬似クラスに掛かっており、上記のとおり属性が付かないため発火しない。
            <Button
              variant="outline"
              size="sm"
              disabled={state.kind === 'loading'}
              focusableWhenDisabled
              className="data-[disabled]:opacity-50"
              onClick={() => setAttempt((count) => count + 1)}
              aria-label={`${storeName} の QR の発行を再試行`}
            >
              再試行
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label={`${storeName} の QR を閉じる`}
          >
            閉じる
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
