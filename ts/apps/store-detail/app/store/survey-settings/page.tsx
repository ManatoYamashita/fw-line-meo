'use client';

// アンケート設定画面（Issue #437・Issue #441 の PR2）。
//
// 店舗オーナーが LINE（LIFF）の中で、自店のアンケートに出す料理名・ドリンク名と、予約・来店の表示を設定する。
// 詳細画面（app/store/page.tsx）の「アンケート設定」から開く。
//
// 認可は詳細画面と同じ: liff.init → liff.getIDToken → API へ Authorization: Bearer。店舗はサーバーが ID トークンの
// sub から決め、複数店舗のオーナーだけが `?storeId=` のヒントで認可済み集合の中の 1 店を指す。
//
// 詳細画面（読取専用・書込の手段を描かない）とは別の面である。この面は書込の手段を持つが、書けるのは
// 自店のアンケート設定だけで、サーバー（lib/survey-settings-api.ts）と DB の権限（infra/sql/grants.sql）が強制する。
// 画面の側の入力検証（文字数・空欄）は案内のためで、受け付けるかどうかはサーバーが決める。
//
// 携帯の LIFF 幅で操作できることを優先する。並び替えはドラッグではなく「上へ」「下へ」の押しボタンで行う
// （指で確実に押せ、支援技術からも同じ操作ができる）。

import { useCallback, useEffect, useRef, useState } from 'react';
import liff from '@line/liff';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Heading } from '@fwlm/ui/components/heading';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Spinner } from '@fwlm/ui/components/spinner';

import type { StoreRef } from '../../../lib/contract';
import { callSurveySettings, type SurveySettingsCallResult } from '../../../lib/survey-settings-client';
import { SURVEY_SETTINGS_PATHS, type SurveySettingsResponse } from '../../../lib/survey-settings-contract';
import { SurveySettingsEditor, type SettingsMutation } from './survey-settings-editor';

const PAGE_TITLE = 'アンケート設定';
const LIFF_ERROR_MESSAGE = 'LINE 連携でエラーが発生しました。LINE アプリからこの画面を開き直してください。';
const NOT_FOUND_MESSAGE = '店舗情報を確認できませんでした。店舗の登録と LINE 連携が済んでいるかご確認ください。';
// 戻り先は詳細画面の素のパス（`?storeId=` を付けない）。ヒントの店が見つからなかった場合でも、詳細画面は
// ID トークンから店を決め直す（複数店舗なら店の選択を出す）。
const STORE_DETAIL_PATH = '/store';
const SELECT_STORE_HEADING = '設定する店舗を選んでください';

// 失敗の種類で次の行動が違うため、案内を分ける。
// - liff: LINE の中で開き直せば直る。戻り先のリンクも同じ LIFF を通るので出さない。
// - store-not-found: 店舗の登録・連携の確認が要る。詳細画面へ戻れるようにし、解決しない場合の問い合わせを案内する。
// - general: サーバー・通信の一時的な失敗。サーバー（またはクライアント）が返した案内とサポートコードをそのまま出す。
type ErrorView =
  | { readonly kind: 'liff' }
  | { readonly kind: 'store-not-found'; readonly supportCode?: string }
  | { readonly kind: 'general'; readonly message: string };

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ErrorView }
  | { readonly status: 'select'; readonly stores: readonly StoreRef[] }
  | { readonly status: 'ready'; readonly data: SurveySettingsResponse };

type IdTokenResolution =
  | { readonly kind: 'ok'; readonly idToken: string }
  | { readonly kind: 'redirecting' }
  | { readonly kind: 'failed' };

// 詳細画面（app/store/page.tsx）の resolveIdToken と同じ手順。getProfile の userId は使わない。
async function resolveIdToken(): Promise<IdTokenResolution> {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  if (!liffId) return { kind: 'failed' };
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return { kind: 'redirecting' };
  }
  const idToken = liff.getIDToken();
  return idToken ? { kind: 'ok', idToken } : { kind: 'failed' };
}

/** `?storeId=` のヒント。useEffect の中でだけ読む（詳細画面の readStoreIdHint と同じ理由）。 */
function readStoreIdHint(): string | null {
  const hint = new URLSearchParams(window.location.search).get('storeId');
  return hint && hint.length > 0 ? hint : null;
}

type CallError = Extract<SurveySettingsCallResult, { kind: 'error' }>;

function isStoreNotFound(result: CallError): boolean {
  return result.status === 404 && result.code === 'STORE_NOT_FOUND';
}

function withSupportCode(message: string, supportCode: string | undefined): string {
  return supportCode ? `${message}（サポートコード: ${supportCode}）` : message;
}

function toErrorView(result: CallError): ErrorView {
  if (isStoreNotFound(result)) {
    return { kind: 'store-not-found', ...(result.supportCode ? { supportCode: result.supportCode } : {}) };
  }
  return { kind: 'general', message: withSupportCode(result.message, result.supportCode) };
}

/** 編集の途中の失敗をその場に出す 1 行の文言。 */
function inlineErrorMessage(result: CallError): string {
  return withSupportCode(isStoreNotFound(result) ? NOT_FOUND_MESSAGE : result.message, result.supportCode);
}

/**
 * 問い合わせの案内。運営の問い合わせ先は LINE の案内（line-webhook の messages.ts）と同じく「運営まで」とだけ言い、
 * リポジトリに正式な問い合わせ先の URL が無いため、リンクは作らない。
 */
function contactGuidance(supportCode: string | undefined): string {
  return supportCode
    ? `解決しない場合は、サポートコード ${supportCode} を添えて運営までお問い合わせください。`
    : '解決しない場合は、運営までお問い合わせください。';
}

function ErrorBody({ error }: { readonly error: ErrorView }): React.JSX.Element {
  if (error.kind === 'liff') {
    return (
      <Alert variant="destructive">
        <AlertDescription>{LIFF_ERROR_MESSAGE}</AlertDescription>
      </Alert>
    );
  }
  if (error.kind === 'general') {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <>
      <Alert variant="destructive">
        <AlertDescription>
          <p>{NOT_FOUND_MESSAGE}</p>
          <p>{contactGuidance(error.supportCode)}</p>
        </AlertDescription>
      </Alert>
      <p>
        <a href={STORE_DETAIL_PATH}>店舗詳細へ戻る</a>
      </p>
    </>
  );
}

export default function SurveySettingsPage(): React.JSX.Element {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const session = useRef<{ idToken: string; hint: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      let token: IdTokenResolution;
      try {
        token = await resolveIdToken();
      } catch {
        token = { kind: 'failed' };
      }
      if (cancelled || token.kind === 'redirecting') return;
      if (token.kind === 'failed') {
        setState({ status: 'error', error: { kind: 'liff' } });
        return;
      }
      const hint = readStoreIdHint();
      session.current = { idToken: token.idToken, hint };
      const result = await callSurveySettings(token.idToken, hint, 'GET', SURVEY_SETTINGS_PATHS.settings);
      if (cancelled) return;
      if (result.ok) setState({ status: 'ready', data: result.data });
      else if (result.kind === 'select') setState({ status: 'select', stores: result.stores });
      else setState({ status: 'error', error: toErrorView(result) });
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // 変更を 1 つ送り、成功したら応答の設定（変更の後の全体）で置き換える。失敗は呼び手へ返して、その場に出させる。
  const mutate = useCallback<SettingsMutation>(async (method, path, body) => {
    const current = session.current;
    if (!current) return { ok: false, message: LIFF_ERROR_MESSAGE };
    const result = await callSurveySettings(current.idToken, current.hint, method, path, body);
    if (result.ok) {
      setState({ status: 'ready', data: result.data });
      return { ok: true };
    }
    if (result.kind === 'select') {
      setState({ status: 'select', stores: result.stores });
      return { ok: false, message: SELECT_STORE_HEADING };
    }
    return { ok: false, message: inlineErrorMessage(result) };
  }, []);

  if (state.status === 'loading') {
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Heading level={1}>{PAGE_TITLE}</Heading>
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden />
          読み込み中です…
        </p>
      </PageShell>
    );
  }

  if (state.status === 'error') {
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Heading level={1}>{PAGE_TITLE}</Heading>
        <ErrorBody error={state.error} />
      </PageShell>
    );
  }

  if (state.status === 'select') {
    return (
      <PageShell width="sm" className="flex flex-col gap-6">
        <Heading level={1}>{PAGE_TITLE}</Heading>
        <section className="flex flex-col gap-4">
          <Heading level={2}>{SELECT_STORE_HEADING}</Heading>
          <ul className="flex flex-col gap-2">
            {state.stores.map((store) => (
              <li key={store.storeId}>
                <a href={`/store/survey-settings?storeId=${encodeURIComponent(store.storeId)}`}>{store.name}</a>
              </li>
            ))}
          </ul>
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell width="sm" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p>
          <a href={`/store?storeId=${encodeURIComponent(state.data.storeId)}`}>店舗詳細へ戻る</a>
        </p>
        <Heading level={1}>{PAGE_TITLE}</Heading>
        <p>{state.data.storeName}</p>
      </header>
      <SurveySettingsEditor data={state.data} mutate={mutate} />
    </PageShell>
  );
}
