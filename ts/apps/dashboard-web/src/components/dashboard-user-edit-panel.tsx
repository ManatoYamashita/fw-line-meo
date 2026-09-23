'use client';

import { useState } from 'react';

import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Card, CardContent, CardHeader } from '@fwlm/ui/components/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { Select } from '@fwlm/ui/components/select';

import {
  updateDashboardUser,
  type ApiResult,
  type DashboardRole,
  type DashboardUserChanges,
} from '../lib/api';
import type { AgencyItem, DashboardUserItem } from '../lib/types';

// 利用者 1 人ぶんのロール・所属代理店・表示名を、一覧の行の直下で編集させる部品。
// 設計: dashboard-user-edit「Web: 編集パネル」（Requirements 1.1, 1.5, 1.6, 1.8, 1.13, 1.14,
// 2.2, 2.7, 3.1, 3.2, 3.4, 4.7, 6.6, 6.7, 6.8, 6.10）。
//
// 入力状態と送信状態はこの部品が持ち、一覧からは切り離す（store-qr-panel と同型）。
// 開閉・焦点の返却・一覧の取り直し・成功通知は呼び出し側（利用者一覧）の責務である。
// 重ね表示は使わない（docs/design/design-language.md §7.5）。メールアドレスの入力は置かない（1.8）。

export interface DashboardUserEditPanelProps {
  readonly user: DashboardUserItem;
  /** 所属の選択肢。null は取得に失敗したことを表し、ロールと所属を固定表示にする（1.14）。 */
  readonly agencies: readonly AgencyItem[] | null;
  /** 操作者自身の行か。true ならロールと所属は固定表示にし、表示名だけを編集させる（2.2）。 */
  readonly isSelf: boolean;
  /** 保存が確定したとき。一覧の取り直し・閉じる・焦点・成功通知は呼び出し側が行う。 */
  readonly onSaved: () => void | Promise<void>;
  /** 取りやめ（変更なしでの保存も含む）。 */
  readonly onCancel: () => void;
  /** 送信の注入（既定は updateDashboardUser）。テストでネットワークを発火させないために持つ。 */
  readonly updateUser?: (
    id: string,
    changes: DashboardUserChanges,
  ) => Promise<ApiResult<DashboardUserItem>>;
}

type UpdateUser = NonNullable<DashboardUserEditPanelProps['updateUser']>;

// 既定の送信。api client の形は `({ id, changes }, options)` で、この部品の注入口の形
// `(id, changes)` と異なるため包む（tasks.md の 3.1 の Implementation Notes）。
const defaultUpdateUser: UpdateUser = (id, changes) => updateDashboardUser({ id, changes });

// ロールと所属を固定表示にするときの理由。両方に当たるときは自分の行を優先する。
const SELF_LOCKED_REASON = '自分自身のロールは変更できません。';
const AGENCIES_LOCKED_REASON =
  '代理店一覧を取得できないため、ロールと所属代理店は変更できません。画面を再読み込みしてください。';

// 選んだロールが開いた時点と異なるときだけ出す、変更後に利用できる範囲の案内（2.7）。
const ROLE_CHANGE_HINT: Readonly<Record<DashboardRole, string>> = {
  operator: '運営にすると、全店舗の閲覧と利用者管理ができるようになります。',
  agency: '代理店にすると、所属代理店の店舗だけを閲覧できるようになります。',
};

// 代理店ロールで所属が空のまま保存したときの案内（1.6）。送らずにパネル内で止める。
const AGENCY_REQUIRED_TEXT = '所属代理店を選択してください。';

// サーバが返す code を利用者向けの文言へ写す対応表（4.7）。サーバの message は描かない。
// オブジェクトリテラルではなく Map を使う。リテラルの添字参照は Object.prototype を辿るため、
// code が 'constructor' や 'toString' だと ?? が発火せず、文言ではない値が描画されうる。
// last_operator は無効化と同じ code だが、文言はこのパネルのもの（降格の文脈）を使う。
const ERROR_TEXT_BY_CODE = new Map<string, string>([
  ['self_role_change_forbidden', '自分自身のロールは変更できません。'],
  ['last_operator', '最後の運営は代理店に変更できません。先に別の運営を追加してください。'],
  [
    'role_changed',
    '他の操作でこの利用者のロールが変わりました。画面を再読み込みしてから、もう一度操作してください。',
  ],
  ['agency_not_found', '選択した代理店が見つかりません。画面を再読み込みしてください。'],
  ['not_found', '利用者が見つかりません。画面を再読み込みしてください。'],
  ['validation_failed', '入力内容を確認してください（ロールと所属代理店）。'],
]);

// 通信障害・内部障害・未知の code。成功したかのような表示は行わない。
const GENERIC_ERROR_TEXT = '変更を保存できませんでした。時間をおいて再試行してください。';

function errorTextFor(code: string): string {
  return ERROR_TEXT_BY_CODE.get(code) ?? GENERIC_ERROR_TEXT;
}

// パネル内の警告は常に 1 枠だけ持つ（6.6）。未選択の案内と送信の拒否は同時に出さない。
// サーバの message は保持しない。保持すると「描画してはならない値」を手の届く場所へ置くことになる。
type PanelError =
  | { readonly kind: 'agency_required' }
  | { readonly kind: 'rejected'; readonly code: string };

interface Draft {
  readonly role: DashboardRole;
  /** 所属代理店の選択。空文字は未選択。 */
  readonly agencyId: string;
  /** 表示名の入力値そのもの（trim する前）。 */
  readonly displayName: string;
}

function roleLabel(role: DashboardRole): string {
  return role === 'operator' ? '運営' : '代理店';
}

// 所属の表示は一覧と同じ規則にする（所属なしは「—」、名前を引けなければ id）。
function agencyLabel(agencyId: string | null, agencies: readonly AgencyItem[] | null): string {
  if (agencyId === null) return '—';
  return agencies?.find((agency) => agency.id === agencyId)?.name ?? agencyId;
}

// 表示名は前後の空白を取り除き、空なら未設定（null）にする（1.5）。
function normalizeDisplayName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// 開いた時点の値と比べ、変更した項目だけを組み立てる（3.1, 3.4）。
//
// ロールが違えば「ロールの変更」を送る。ロールが同じ代理店のまま所属だけが違えば「所属の移動」を
// 送り、ロールは載せない。載せると「代理店にする」と同じ意味になり、開いている間に他の運営が
// 昇格させていた対象を黙って降格させる。載せなければサーバが role_changed で止める。
function changesFrom(
  opened: DashboardUserItem,
  draft: Draft,
  assignmentLocked: boolean,
): DashboardUserChanges {
  const changes: DashboardUserChanges = {};
  if (!assignmentLocked) {
    if (draft.role !== opened.role) {
      changes.assignment =
        draft.role === 'operator'
          ? { kind: 'scope', role: 'operator' }
          : { kind: 'scope', role: 'agency', agencyId: draft.agencyId };
    } else if (draft.role === 'agency' && draft.agencyId !== opened.agencyId) {
      changes.assignment = { kind: 'agency', agencyId: draft.agencyId };
    }
  }
  // 触れていない欄は変更として扱わない。保存済みの表示名が前後に空白を持っていても（作成の API は
  // trim しない）、開いただけで「空白を取る変更」を送らないため、入力値そのものを先に比べる。
  if (draft.displayName !== (opened.displayName ?? '')) {
    const normalized = normalizeDisplayName(draft.displayName);
    if (normalized !== opened.displayName) changes.displayName = normalized;
  }
  return changes;
}

export function DashboardUserEditPanel({
  user,
  agencies,
  isSelf,
  onSaved,
  onCancel,
  updateUser,
}: DashboardUserEditPanelProps) {
  // 比べる相手は開いた時点の値である（design「変更の算出」）。開いている間に一覧が取り直されて
  // user が新しい値に替わっても、比べる相手は動かさない。動かすと、他の運営が昇格させた対象への
  // 「所属の移動」が「代理店にする」に化け、昇格を黙って巻き戻す。
  // 別の利用者のパネルは別の行に別の実体として描かれる（呼び出し側が key を利用者 ID にする）。
  const [opened] = useState(user);
  const [role, setRole] = useState<DashboardRole>(opened.role);
  const [agencyId, setAgencyId] = useState(opened.agencyId ?? '');
  const [displayName, setDisplayName] = useState(opened.displayName ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);

  // ロールと所属の選択肢。null はロールと所属を固定表示にすることを表す（2.2, 1.14）。
  const assignmentOptions = isSelf ? null : agencies;
  const lockedReason = isSelf
    ? SELF_LOCKED_REASON
    : agencies === null
      ? AGENCIES_LOCKED_REASON
      : null;

  // 入力の ID は行ごとに一意にし、登録フォーム（user-role など）と衝突させない（6.8）。
  // 利用者 ID から決定的に作るので、サーバ描画とクライアント描画で食い違わない。
  const ids = {
    role: `user-edit-role-${opened.id}`,
    roleHint: `user-edit-role-hint-${opened.id}`,
    agency: `user-edit-agency-${opened.id}`,
    displayName: `user-edit-display-name-${opened.id}`,
    lockedReason: `user-edit-locked-reason-${opened.id}`,
    error: `user-edit-error-${opened.id}`,
  };

  const roleHint =
    assignmentOptions !== null && role !== opened.role ? ROLE_CHANGE_HINT[role] : null;

  // 現在の所属が手元の選択肢に無い（一覧の読み込み後に作られた代理店など）。選択肢に無い値を
  // 選択へ与えると、先頭の「代理店を選択してください」が選ばれて見え、所属が未選択に見える。
  // 一覧と同じ規則で id を名前の代わりにした選択肢を足す。
  const currentAgencyId =
    assignmentOptions !== null &&
    opened.agencyId !== null &&
    !assignmentOptions.some((agency) => agency.id === opened.agencyId)
      ? opened.agencyId
      : null;

  // 未選択の案内は、保存を試みた後で、なお未選択である間だけ出す。開いた直後や選ぶ前は
  // 誤りとして扱わず、選び直せば案内と誤りの印が同時に消える（両者を同じ判定から出す）。
  const agencyInvalid =
    error?.kind === 'agency_required' &&
    assignmentOptions !== null &&
    role === 'agency' &&
    agencyId === '';
  const errorText =
    error === null
      ? null
      : error.kind === 'agency_required'
        ? agencyInvalid
          ? AGENCY_REQUIRED_TEXT
          : null
        : errorTextFor(error.code);

  async function handleSave() {
    setError(null);
    const assignmentLocked = assignmentOptions === null;
    if (!assignmentLocked && role === 'agency' && agencyId === '') {
      setError({ kind: 'agency_required' });
      return;
    }
    const changes = changesFrom(opened, { role, agencyId, displayName }, assignmentLocked);
    // 変更が 1 つも無ければ送らない（空の変更はサーバが 400 にする）。取りやめと同じく閉じる（1.13）。
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }

    setSubmitting(true);
    let result: ApiResult<DashboardUserItem>;
    try {
      result = await (updateUser ?? defaultUpdateUser)(opened.id, changes);
    } catch {
      // api client は失敗を封筒で返すので通常は到達しない。注入された送信関数が投げた場合も、
      // 押せないまま固着させず、再試行できる一般障害として扱う。
      setSubmitting(false);
      setError({ kind: 'rejected', code: 'unexpected' });
      return;
    }
    if (!result.ok) {
      // 入力はそのまま保持する（6.6）。code だけを持ち、文言は対応表から引く。
      setSubmitting(false);
      setError({ kind: 'rejected', code: result.code });
      return;
    }
    // 呼び出し側の後処理（一覧の取り直し → 焦点 → 閉じる）が終わるまで保存を押せないままにし、
    // 取り直しの間に同じ変更を重ねて送らせない。閉じた後の状態更新は React が捨てる。
    try {
      await onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <Heading level={2} size="base">
          {opened.email ?? opened.displayName ?? '利用者'} の編集
        </Heading>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {assignmentOptions === null ? (
            // 固定表示。選択の部品は出さない。選択肢に無い値を選択へ与えると「未選択」に見え、
            // 現在の所属を未所属のように見せてしまう（1.14）。
            <div className="flex flex-col gap-2">
              <dl className="flex flex-col gap-1">
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">ロール</dt>
                  <dd>{roleLabel(opened.role)}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted-foreground">所属代理店</dt>
                  <dd>{agencyLabel(opened.agencyId, agencies)}</dd>
                </div>
              </dl>
              <FieldDescription id={ids.lockedReason}>{lockedReason}</FieldDescription>
            </div>
          ) : (
            <>
              {/* 容器と幅の段は登録フォームと同じにする（段落ではなく汎用の容器・広い版面でだけ
                * 幅を絞る）。値は既存の 4 面が採った段と同一である。 */}
              <Field className="sm:max-w-xs">
                <FieldLabel htmlFor={ids.role}>ロール</FieldLabel>
                <Select
                  id={ids.role}
                  name="role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as DashboardRole)}
                  aria-describedby={roleHint === null ? undefined : ids.roleHint}
                >
                  <option value="operator">運営</option>
                  <option value="agency">代理店</option>
                </Select>
                {roleHint !== null && (
                  <FieldDescription id={ids.roleHint}>{roleHint}</FieldDescription>
                )}
              </Field>

              {/* 代理店ロールを選んでいるときだけ所属を必須で選ばせる（運営は所属を持たない）。 */}
              {role === 'agency' && (
                <Field className="sm:max-w-xs">
                  <FieldLabel htmlFor={ids.agency}>所属代理店</FieldLabel>
                  <Select
                    id={ids.agency}
                    name="agencyId"
                    required
                    value={agencyId}
                    onChange={(event) => setAgencyId(event.target.value)}
                    aria-invalid={agencyInvalid ? true : undefined}
                    aria-describedby={agencyInvalid ? ids.error : undefined}
                  >
                    <option value="">代理店を選択してください</option>
                    {currentAgencyId !== null && (
                      <option value={currentAgencyId}>{currentAgencyId}</option>
                    )}
                    {assignmentOptions.map((agency) => (
                      <option key={agency.id} value={agency.id}>
                        {agency.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </>
          )}

          <Field className="sm:max-w-xs">
            <FieldLabel htmlFor={ids.displayName}>表示名</FieldLabel>
            {/* 他人の表示名を編集する欄なので、ブラウザに操作者自身の名前を自動入力させない。
              * 固定表示の理由は、焦点が最初に届くこの欄へ結び付ける（固定の値は焦点を受けない）。 */}
            <Input
              id={ids.displayName}
              name="displayName"
              type="text"
              autoComplete="off"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-describedby={lockedReason === null ? undefined : ids.lockedReason}
            />
          </Field>

          {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
          {errorText !== null && (
            <Alert variant="destructive">
              <AlertDescription id={ids.error}>{errorText}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* 送信中は disabled と focusableWhenDisabled を併せて渡す。Base UI はこの組み合わせのとき
              * native の disabled 属性を付けず aria-disabled と data-disabled だけを与えるので、
              * 焦点を失わせずに押下を止められる（6.7）。減光は data-disabled 経由で与える。
              * buttonVariants の減光は native の :disabled に掛かっており、ここでは発火しない。 */}
            <Button
              type="button"
              size="sm"
              disabled={submitting}
              focusableWhenDisabled
              className="data-[disabled]:opacity-50"
              onClick={() => void handleSave()}
            >
              保存
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              キャンセル
            </Button>
          </div>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
