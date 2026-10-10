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
const NOT_FOUND_MESSAGE = '店舗情報を取得できませんでした。';
const SELECT_STORE_HEADING = '設定する店舗を選んでください';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
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

function errorMessage(result: Extract<SurveySettingsCallResult, { kind: 'error' }>): string {
  const base = result.status === 404 && result.code === 'STORE_NOT_FOUND' ? NOT_FOUND_MESSAGE : result.message;
  return result.supportCode ? `${base}（サポートコード: ${result.supportCode}）` : base;
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
        setState({ status: 'error', message: LIFF_ERROR_MESSAGE });
        return;
      }
      const hint = readStoreIdHint();
      session.current = { idToken: token.idToken, hint };
      const result = await callSurveySettings(token.idToken, hint, 'GET', SURVEY_SETTINGS_PATHS.settings);
      if (cancelled) return;
      if (result.ok) setState({ status: 'ready', data: result.data });
      else if (result.kind === 'select') setState({ status: 'select', stores: result.stores });
      else setState({ status: 'error', message: errorMessage(result) });
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
    return { ok: false, message: errorMessage(result) };
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
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
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
