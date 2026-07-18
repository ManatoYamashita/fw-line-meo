'use client';

import { useEffect, useState } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { TopNav } from '../../components/top-nav';
import { useAuth } from '../../lib/auth-context';
import { disableInviteCode, getAgencies, getInviteCodes, issueInviteCode } from '../../lib/api';
import type { AgencyItem, InviteCodeItem } from '../../lib/types';

// 招待コード一覧の取得状態（7.4: 失敗時にデータを偽装しない）。
//   idle    … operator が代理店未選択（一覧を出さず選択を促す）
//   loading … 取得中
//   error   … 取得失敗（案内のみ）
//   ready   … 取得済み
type ListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; codes: InviteCodeItem[] };

function InviteCodesView() {
  const { me } = useAuth();
  const isOperator = me?.role === 'operator';

  // operator のみ代理店セレクタを持つ。agency は自代理店固定。
  const [agencies, setAgencies] = useState<AgencyItem[] | null>(null);
  const [selectedAgencyId, setSelectedAgencyId] = useState('');
  const [list, setList] = useState<ListState>(isOperator ? { kind: 'idle' } : { kind: 'loading' });

  // 発行された新規コード。オーナーに案内するため強調表示する（Req 5.2）。
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  // 発行・無効化の操作エラー（一覧の取得エラーとは別枠で提示。Req 7.4）。
  const [actionError, setActionError] = useState<string | null>(null);

  // 現在のスコープ agencyId。operator は選択値（未選択は undefined）、agency は常に undefined（=自代理店）。
  const scopeAgencyId = isOperator && selectedAgencyId !== '' ? selectedAgencyId : undefined;
  // 発行・無効化の操作を提示してよいか（agency は常に可、operator は代理店選択後のみ）。
  const canOperate = !isOperator || selectedAgencyId !== '';

  // operator: 代理店一覧を読み込む（agency は不要）。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const result = await getAgencies();
      if (!active) return;
      if (result.ok) setAgencies(result.value);
      else setList({ kind: 'error', message: result.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // agency: 初期ロードで自代理店の招待コードを取得する。
  useEffect(() => {
    if (isOperator) return;
    let active = true;
    void (async () => {
      const result = await getInviteCodes({});
      if (!active) return;
      if (result.ok) setList({ kind: 'ready', codes: result.value });
      else setList({ kind: 'error', message: result.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // スコープの招待コードを取り直す（発行・無効化後の再取得にも使う）。
  async function reload(agencyId: string | undefined) {
    setList({ kind: 'loading' });
    const result = await getInviteCodes(agencyId === undefined ? {} : { agencyId });
    if (result.ok) setList({ kind: 'ready', codes: result.value });
    else setList({ kind: 'error', message: result.message });
  }

  // operator: 代理店を選び直したら、その代理店のコード一覧を取得する（Req 5.4）。
  function handleSelectAgency(agencyId: string) {
    setSelectedAgencyId(agencyId);
    setIssuedCode(null);
    setActionError(null);
    if (agencyId === '') {
      setList({ kind: 'idle' });
      return;
    }
    void reload(agencyId);
  }

  // 発行（Req 5.2）。成功時は新コードを案内表示し一覧を取り直す。
  async function handleIssue() {
    setActionError(null);
    setIssuedCode(null);
    const result = await issueInviteCode(scopeAgencyId === undefined ? {} : { agencyId: scopeAgencyId });
    if (result.ok) {
      setIssuedCode(result.value.code);
      await reload(scopeAgencyId);
    } else {
      setActionError('発行に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 無効化（Req 5.3）。成功時は一覧を取り直して当該行を無効表示にする。
  async function handleDisable(id: string) {
    setActionError(null);
    const result = await disableInviteCode(scopeAgencyId === undefined ? { id } : { id, agencyId: scopeAgencyId });
    if (result.ok) {
      await reload(scopeAgencyId);
    } else {
      setActionError('無効化に失敗しました。時間をおいて再試行してください。');
    }
  }

  return (
    <main>
      <h1>招待コード</h1>

      {isOperator && (
        <p>
          <label htmlFor="agency-select">代理店</label>
          <select
            id="agency-select"
            value={selectedAgencyId}
            onChange={(event) => handleSelectAgency(event.target.value)}
          >
            <option value="">代理店を選択してください</option>
            {(agencies ?? []).map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.name}
              </option>
            ))}
          </select>
        </p>
      )}

      {/* operator が代理店未選択のときは一覧を出さず、選択を促す（Req 5.4） */}
      {list.kind === 'idle' && <p>代理店を選択すると招待コードを表示します。</p>}

      {canOperate && (
        <>
          <button type="button" onClick={() => void handleIssue()}>
            発行
          </button>

          {/* 発行した新コードをオーナー案内用に強調表示する（Req 5.2） */}
          {issuedCode !== null && (
            <p>
              新しい招待コードを発行しました: <strong>{issuedCode}</strong>（このコードをオーナーにご案内ください）
            </p>
          )}

          {actionError !== null && <p role="alert">{actionError}</p>}

          {list.kind === 'loading' && <p>読み込み中...</p>}
          {list.kind === 'error' && <p role="alert">{list.message}</p>}

          {list.kind === 'ready' && list.codes.length === 0 && (
            <p>招待コードはまだありません。発行してオーナーにご案内ください。</p>
          )}

          {list.kind === 'ready' && list.codes.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>コード</th>
                  <th>状態</th>
                  <th>作成日時</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.codes.map((code) => (
                  <tr key={code.id}>
                    <td>{code.code}</td>
                    {/* 有効/無効バッジ（Req 5.1） */}
                    <td>{code.disabled ? '無効' : '有効'}</td>
                    <td>{code.createdAt}</td>
                    <td>
                      {/* 無効化は有効な行にのみ提供する（Req 5.3。API は冪等） */}
                      {!code.disabled && (
                        <button type="button" onClick={() => void handleDisable(code.id)}>
                          無効化
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}

// 招待コード管理。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function InviteCodesPage() {
  return (
    <AuthGuard>
      <TopNav />
      <InviteCodesView />
    </AuthGuard>
  );
}
