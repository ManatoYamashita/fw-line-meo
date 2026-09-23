'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Field, FieldGroup, FieldLabel } from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { PageShell } from '@fwlm/ui/components/page-shell';
import { Select } from '@fwlm/ui/components/select';
import { Spinner } from '@fwlm/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableDetailRow,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@fwlm/ui/components/table';
import { AuthGuard } from '../../../components/auth-guard';
import { DashboardUserEditPanel } from '../../../components/dashboard-user-edit-panel';
import { TopNav } from '../../../components/top-nav';
import { useAuth } from '../../../lib/auth-context';
import {
  createDashboardUser,
  disableDashboardUser,
  enableDashboardUser,
  getAgencies,
  getDashboardUsers,
  type DashboardRole,
} from '../../../lib/api';
import type { AgencyItem, DashboardUserItem } from '../../../lib/types';

// 利用者一覧の取得状態（7.4: 失敗時にデータを偽装しない）。
type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; users: DashboardUserItem[] };

// ロール表示名（日本語・Req 7.3）。
function roleLabel(role: DashboardRole): string {
  return role === 'operator' ? '運営' : '代理店';
}

// 一覧の列数（ロール・表示名・メールアドレス・所属代理店・状態・操作）。編集パネルの行の colSpan は
// ここから取る。下の見出しセルの並びとは別に列数を持つ点は店舗一覧と同じで、両者が一致することは
// 画面のテストが列見出しの実数と突き合わせて固定している（dashboard-user-edit Req 6.3）。
const COLUMN_COUNT = 6;

// 編集の押しボタンから開閉先のパネルを指す id（aria-controls 用）。パネル内の入力の id
// （user-edit-role-… など）と同じ接頭辞の並びにしないため、panel の語を挟む。利用者 ID から決定的に
// 作るので、サーバ描画とクライアント描画で食い違わない。
function editPanelId(userId: string): string {
  return `user-edit-panel-${userId}`;
}

// 編集の対象を名指す語。パネルの見出し（「〇〇 の編集」）と同じ規則で引き、押しボタンの読み上げ名と
// 開いたパネルの見出しが同じ利用者を同じ語で指すようにする。
function userLabel(user: DashboardUserItem): string {
  return user.email ?? user.displayName ?? '利用者';
}

// 利用者の属性の保存が確定したときの成功通知（dashboard-user-edit Req 1.12）。
const USER_UPDATED_TEXT = '利用者情報を更新しました。';

function UsersView() {
  const { me } = useAuth();
  // operator 専用画面。agency ロールは案内のみ（クライアント側 UX ゲート。実際の認可は API 側・Req 6.5）。
  const isOperator = me?.role === 'operator';

  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [agencies, setAgencies] = useState<AgencyItem[]>([]);
  // 代理店一覧の取得に失敗したか（dashboard-user-edit Req 1.14）。登録フォームは従来どおり空の一覧の
  // まま使うが、編集パネルへは「取得できていない」ことを null で伝え、ロールと所属を固定表示にさせる。
  // 空の一覧を渡すと、現在の所属が選択肢に無い状態になり、所属を選び直せるように見えてしまう。
  const [agenciesFailed, setAgenciesFailed] = useState(false);

  // 登録フォーム状態。既定は代理店ロール（所属代理店の指定が必要な側）。
  const [role, setRole] = useState<DashboardRole>('agency');
  const [agencyId, setAgencyId] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 無効化操作のエラー（登録フォームのエラーとは別枠・Req 7.4）。
  const [actionError, setActionError] = useState<string | null>(null);
  // 編集の保存が確定したことの通知（dashboard-user-edit Req 1.12）。次の操作（編集の開始・登録・
  // 無効化・有効化）を始めた時点で消し、前の操作の結果を次の操作の結果と取り違えさせない。
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 編集パネルを開いている利用者。開閉状態は一覧が所有し、同時に開けるのは 1 つだけである
  // （dashboard-user-edit Req 6.4）。パネル自身は開閉を持たない（店舗一覧の QR パネルと同型）。
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  // openUserId の最新値。開いている行の編集がもう一度押されたことを、changeOpenUser が判別するのに使う。
  const openUserIdRef = useRef<string | null>(null);
  // 開いているパネルが替わるたびに進める番号。保存の後処理は、保存したパネルを開いた回の番号を
  // 閉包で持ち帰り、最新値（openSeqRef）と比べて「そのパネルがまだ開いているか」を判定する。
  // 利用者 ID では比べない。保存を待つ間に取りやめて同じ利用者を開き直すと、利用者は同じでも
  // 別のパネルであり、利用者で比べると先の保存の完了が開き直したパネル（とその保存の失敗の警告）を
  // 閉じてしまう。
  const [openSeq, setOpenSeq] = useState(0);
  // openSeq の最新値。保存の後処理は保存を押した時点の描画の閉包で走り、そこから state を読むと
  // 押した時点の値が見えるので、こちらを読む。開閉は必ず changeOpenUser を通し、state と同時に更新する。
  const openSeqRef = useRef(0);
  // 直近に押された編集の押しボタン。パネルを閉じると焦点の載っていた要素ごと消えるため、
  // 焦点を呼び出し元へ戻す（戻さないと body へ落ち、焦点の位置が判別できなくなる・dashboard-user-edit Req 6.5）。
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // operator のみ利用者・代理店一覧を取得する（agency では依存 API を一切呼ばない）。
  useEffect(() => {
    if (!isOperator) return;
    let active = true;
    void (async () => {
      const [usersResult, agenciesResult] = await Promise.all([getDashboardUsers(), getAgencies()]);
      if (!active) return;
      // 失敗しても登録フォームの一覧は空のまま据え置く（従来の挙動）。失敗したことだけを記録する。
      if (agenciesResult.ok) setAgencies(agenciesResult.value);
      else setAgenciesFailed(true);
      if (usersResult.ok) setList({ kind: 'ready', users: usersResult.value });
      else setList({ kind: 'error', message: usersResult.message });
    })();
    return () => {
      active = false;
    };
  }, [isOperator]);

  // 代理店 id → 代理店名の索引（一覧の所属代理店表示に使う）。
  const agencyNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agency of agencies) map.set(agency.id, agency.name);
    return map;
  }, [agencies]);

  // 非 operator には管理情報・登録手段を一切描画しない（Req 6.5）。
  if (!isOperator) {
    return (
      // 分岐ごとに版面を変えない（同じ面が分岐で別の幅に見えると、どちらが本来か読めなくなる）。
      // 主要領域はここでも 1 つである（下の return と排他）。
      <PageShell width="lg" className="flex flex-col gap-6">
        <Heading level={1}>利用者管理</Heading>
        {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねない。 */}
        <Alert variant="destructive">
          <AlertDescription>この画面は運営のみ利用できます。</AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  // 利用者一覧を取り直す（登録・無効化・有効化・編集の保存の後の反映に使う）。取り直せたかを返す。
  // 失敗すると一覧は失敗の表示に替わり、表ごと外れる（編集の保存の後に、焦点を戻せるかの判定に使う）。
  async function reloadUsers(): Promise<boolean> {
    const result = await getDashboardUsers();
    if (result.ok) setList({ kind: 'ready', users: result.value });
    else setList({ kind: 'error', message: result.message });
    return result.ok;
  }

  // 利用者登録（Req 6.2, 6.3）。role=代理店 のときのみ agencyId を必須とし送出、role=運営 では送らない。
  async function handleCreate() {
    setFormError(null);
    setSuccessMessage(null);
    const trimmedEmail = email.trim();
    if (trimmedEmail === '') {
      setFormError('メールアドレスを入力してください。');
      return;
    }
    if (role === 'agency' && agencyId === '') {
      setFormError('所属代理店を選択してください。');
      return;
    }
    const trimmedDisplayName = displayName.trim();
    setSubmitting(true);
    const result = await createDashboardUser({
      role,
      // 代理店ロールのみ agencyId を送る（運営ロールでは送らない・ck_dashboard_role_scope・Req 6.3）。
      ...(role === 'agency' ? { agencyId } : {}),
      email: trimmedEmail,
      ...(trimmedDisplayName !== '' ? { displayName: trimmedDisplayName } : {}),
    });
    setSubmitting(false);
    if (result.ok) {
      setEmail('');
      setDisplayName('');
      setAgencyId('');
      await reloadUsers();
    } else if (result.code === 'email_conflict_disabled') {
      // 自運営配下の無効化済み利用者との衝突は、新規登録ではなく有効化で復旧する（Req 3.2）。
      setFormError(
        'このメールアドレスは無効化済みの利用者です。利用者一覧から有効化してください。',
      );
    } else if (result.code === 'email_conflict') {
      setFormError('既に登録済みのメールアドレスです。');
    } else if (result.code === 'validation_failed') {
      setFormError('入力内容を確認してください（ロールと所属代理店・メールアドレスの形式）。');
    } else {
      setFormError('利用者の登録に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 無効化（Req 6.4）。成功時は一覧を取り直して当該行を無効表示にする。
  // ガード拒否（自己無効化・最後の運営）は成功と誤認させない専用文言で表示し、対象状態は変えない（Req 2.6）。
  async function handleDisable(id: string) {
    setActionError(null);
    setSuccessMessage(null);
    const result = await disableDashboardUser({ id });
    if (result.ok) {
      await reloadUsers();
    } else if (result.code === 'self_disable_forbidden') {
      setActionError('自分自身は無効化できません。');
    } else if (result.code === 'last_operator') {
      setActionError('最後の運営は無効化できません。先に別の運営を追加してください。');
    } else {
      setActionError('無効化に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 再有効化（Req 1.6）。成功時は一覧を取り直して当該行を有効表示にする。
  async function handleEnable(id: string) {
    setActionError(null);
    setSuccessMessage(null);
    const result = await enableDashboardUser({ id });
    if (result.ok) {
      await reloadUsers();
    } else {
      setActionError('有効化に失敗しました。時間をおいて再試行してください。');
    }
  }

  // 開いている利用者を差し替える（開く・閉じる・別の行へ切り替える）。番号は、開いているパネルが
  // 替わるときだけ進め、state と、非同期の後処理が読む最新値（openSeqRef）を同時に更新する。
  // 開いている行の編集をもう一度押したときは何もしない。パネルは同じ実体のまま残るので、番号を
  // 進めると、そのパネルの保存の成功が「別のパネルが開いた」と読み違えて閉じなくなる。
  function changeOpenUser(userId: string | null) {
    if (userId === openUserIdRef.current) return;
    openUserIdRef.current = userId;
    openSeqRef.current += 1;
    setOpenSeq(openSeqRef.current);
    setOpenUserId(userId);
  }

  // 編集の開始（dashboard-user-edit Req 6.3, 6.4）。別の行のパネルが開いていれば、状態を差し替える
  // ことで閉じる。押された押しボタンを控え、閉じるときの焦点の戻り先にする。
  // ページの操作エラーはここで消し、パネル内の失敗と重ねない（dashboard-user-edit Req 6.6）。登録フォームの
  // 誤り（入力の検証と登録の失敗）は、登録フォームの入力に結びついた未解決の誤りなので消さない。成功通知も
  // 消し、前の操作の成功を今の編集の結果と取り違えさせない（dashboard-user-edit Req 1.12）。
  function openEditPanel(event: MouseEvent<HTMLButtonElement>, userId: string) {
    triggerRef.current = event.currentTarget;
    setActionError(null);
    setSuccessMessage(null);
    changeOpenUser(userId);
  }

  // 編集パネルを閉じる（取りやめ・変更なしでの保存）。閉じて外れるのはパネルの行だけなので、
  // 先に焦点を移してよい（この後の再描画でパネルの行が外れる・dashboard-user-edit Req 6.5）。
  function closeEditPanel() {
    triggerRef.current?.focus();
    changeOpenUser(null);
  }

  // 保存の成功（dashboard-user-edit Req 1.12, 6.5）。一覧を取り直し、焦点を戻して閉じ、成功を通知する。
  // 取り直しの間はパネルが保存を押せないままにしている（パネルは onSaved の完了を待つ）。
  async function handleEditSaved(savedSeq: number) {
    const reloaded = await reloadUsers();
    // 送信中も取りやめや別の行の編集は押せるので、保存を待つ間に別の行を開いている（取りやめて同じ行を
    // 開き直している）ことがある。閉じる・焦点を戻すのは、保存したパネルがまだ開いているとき、つまり
    // 番号がそのパネルを開いた回のままのときに限る（今開いているパネルの入力と焦点を奪わない）。
    // 比べる相手は最新値であり、この閉包が見ている openSeq ではない。
    if (openSeqRef.current === savedSeq) {
      // 取り直しに失敗すると一覧は表ごと外れ、戻り先の押しボタンも残らない。外れる要素へ焦点を移しても
      // body へ落ちるだけなので、登録・無効化・有効化と同じく焦点は扱わない。isConnected は、別の
      // 操作の再描画で押しボタンが既に作り直されている場合に、外れた要素へ focus を呼ばないための確認である。
      const trigger = triggerRef.current;
      if (reloaded && trigger?.isConnected) trigger.focus();
      changeOpenUser(null);
    }
    // 保存そのものは確定しているので、取り直しの成否や開いているパネルによらず通知する。隠すと、
    // 利用者が同じ保存を重ねて試みる。
    setSuccessMessage(USER_UPDATED_TEXT);
  }

  return (
    // 一覧が主の面なので版面は広い側を使う。既存の main を **置換** する（入れ子にしない）。
    <PageShell width="lg" className="flex flex-col gap-6">
      <Heading level={1}>利用者管理</Heading>

      <FieldGroup>
        {/* **段落ではなく汎用の容器で包む。** 選択の部品は開閉の記号を重ねるために div を
          * 1 枚挟むので、段落の直下には置けない。置くとブラウザの構文解析が段落を早期に閉じ、
          * サーバ描画とクライアント描画の木が食い違う。
          * 幅の制約は広い版面でだけ効かせる（携帯端末幅の実測を動かさないため）。値は
          * task 2.4 が招待コード・代理店管理で採った段と同一である（Req 1.2）。 */}
        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="user-role">ロール</FieldLabel>
          {/* 標準の選択要素のラッパである。id・value・onChange はいずれも選択要素へ透過し、
            * ラベルとの関連付けもプログラムによる値の変更もそのまま働く（Req 3.4）。 */}
          <Select
            id="user-role"
            value={role}
            onChange={(event) => setRole(event.target.value as DashboardRole)}
          >
            <option value="operator">運営</option>
            <option value="agency">代理店</option>
          </Select>
        </Field>

        {/* 代理店ロールのときのみ所属代理店を必須で入力させる。運営ロールでは代理店欄を出さない（Req 6.3） */}
        {role === 'agency' && (
          <Field className="sm:max-w-xs">
            <FieldLabel htmlFor="user-agency">所属代理店</FieldLabel>
            {/* 必須属性は包む要素ではなく選択要素そのものへ載る（部品が props を透過するため）。 */}
            <Select
              id="user-agency"
              required
              value={agencyId}
              onChange={(event) => setAgencyId(event.target.value)}
            >
              <option value="">代理店を選択してください</option>
              {agencies.map((agency) => (
                <option key={agency.id} value={agency.id}>
                  {agency.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="user-email">メールアドレス</FieldLabel>
          <Input
            id="user-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="user-display-name">表示名</FieldLabel>
          <Input
            id="user-display-name"
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>

        {/* 版面は縦の flex なので、そのまま置くと押しボタンが行幅いっぱいに伸びる。
          * 主操作を全幅にするのはログイン画面の判断（正典 7.9）であってこの面の判断ではない。
          * 無効の通知手段は変えない（素の無効属性のまま。焦点の到達を要求する箇所とは別枠）。 */}
        <Button
          type="button"
          className="self-start"
          onClick={() => void handleCreate()}
          disabled={submitting}
        >
          利用者登録
        </Button>
      </FieldGroup>

      {/* 危険を伝える変種は読み上げ役割 alert を自ら持つ。文言の側へ role を重ねると
        * 領域が二重になるため、文言は説明の受け口へ置くだけにする。 */}
      {formError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      {actionError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {/* 保存の成功（dashboard-user-edit Req 1.12）。失敗ではないので、成功の変種が自ら持つ role="status"
        * （区切りのよい時点で読み上げる）で伝え、進行中の読み上げを中断させない。一時的な Toast は使わない
        * （docs/design/design-language.md §7.5）。 */}
      {successMessage !== null && (
        <Alert variant="success">
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {list.kind === 'loading' && (
        // Spinner 自身も role="status" を持つため、読み上げはこの行に一本化する。
        // 図形は装飾として扱い aria-hidden で支援技術から外す。文言は可視のテキストのまま残す
        // （Spinner の aria-label へ移すと sr-only の子要素へ落ちる・Req 4.5）。
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden />
          読み込み中...
        </p>
      )}
      {list.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{list.message}</AlertDescription>
        </Alert>
      )}

      {list.kind === 'ready' && list.users.length === 0 && (
        <EmptyState>
          <p>利用者はまだいません。登録してください。</p>
        </EmptyState>
      )}

      {list.kind === 'ready' && list.users.length > 0 && (
        // 横方向の捲りは表の **外側** が持つ。この容器は e2e（dashboard-surfaces.spec.ts）が
        // 宣言する「表の捲れる領域 1 件」である。tbody の内側へ挟むと行の隣接関係が壊れ、
        // 編集パネルを対象行の直後へ挿す構成が成立しなくなる。
        // 幅のコンテナ（編集パネルの幅の基準）も捲れる手がかりも部品が持つ（Issue #283）。
        <TableContainer label="利用者一覧">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>ロール</TableHeaderCell>
                <TableHeaderCell>表示名</TableHeaderCell>
                <TableHeaderCell>メールアドレス</TableHeaderCell>
                <TableHeaderCell>所属代理店</TableHeaderCell>
                <TableHeaderCell>状態</TableHeaderCell>
                <TableHeaderCell>操作</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {list.users.map((user) => (
                <Fragment key={user.id}>
                  <TableRow>
                    {/* 折り返しの規則は列の中身の種類で選ぶ（design-language.md 7.18）。
                      * 面の側は語彙を選ぶだけで、幅も折り返しのクラスも書かない。 */}
                    <TableCell wrap="none">{roleLabel(user.role)}</TableCell>
                    {/* 表示名が未設定の利用者は、他の不在の列と同じ「—」で未設定と分かるようにする
                      * （dashboard-user-edit Req 6.1）。 */}
                    <TableCell wrap="prose">{user.displayName ?? '—'}</TableCell>
                    {/* アドレスは区切りを持たない長い語になりうる。どこでも折り返せるようにしないと、
                      * この列だけが幅を取り、ほかの列が 1 文字まで細る（Issue #276）。 */}
                    <TableCell wrap="anywhere">{user.email ?? '—'}</TableCell>
                    {/* 運営ロールは所属代理店を持たない（agencyId=null）。 */}
                    <TableCell wrap="prose">
                      {user.agencyId === null ? '—' : agencyNameById.get(user.agencyId) ?? user.agencyId}
                    </TableCell>
                    {/* 有効/無効の状態（Req 6.4）。招待コードの同じ列と同じく素の語のまま置く。
                      * 装飾で包むと同一役割が面をまたいで 2 通りに描かれ、Req 1.2 が壊れる。 */}
                    <TableCell wrap="none">{user.disabled ? '無効' : '有効'}</TableCell>
                    <TableCell>
                      {/* 押しボタンが 2 つ並ぶ行があるので、間隔を容器が持つ（編集パネルの押しボタンの並びと
                        * 同じ段）。狭い幅では折り返し、列を押し広げない。 */}
                      <div className="flex flex-wrap items-center gap-2">
                        {/* 編集は自分・無効化済みを含むすべての行に出し、有効化・無効化より前に置く
                          * （dashboard-user-edit Req 6.2）。 */}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={(event) => openEditPanel(event, user.id)}
                          aria-expanded={openUserId === user.id}
                          // 制御先は開いているときだけ指す（閉じている間は指す先が DOM に無い）。
                          aria-controls={openUserId === user.id ? editPanelId(user.id) : undefined}
                          // 見えている文言（編集）を読み上げ名へそのまま含める。含めないと、音声入力の
                          // 利用者が見えているとおりに発話しても操作できない（WCAG 2.5.3 Label in Name）。
                          // 対象を名指すのは、同じ「編集」が行の数だけ並ぶため。
                          aria-label={`${userLabel(user)} を編集`}
                        >
                          編集
                        </Button>
                        {/* 無効化済み行には有効化ボタンを提供する（Req 1.6・API は冪等） */}
                        {user.disabled && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleEnable(user.id)}
                          >
                            有効化
                          </Button>
                        )}
                        {/* 無効化は有効な利用者にのみ提供し、自分自身の行には出さない（Req 6.4, 2.2） */}
                        {!user.disabled && user.id !== me?.id && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleDisable(user.id)}
                          >
                            無効化
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {openUserId === user.id && (
                    // 対象行の直下へ挿入し、対応関係を視覚的にも DOM 順でも読み取れるようにする
                    // （dashboard-user-edit Req 6.3）。重ね表示は使わない（docs/design/design-language.md §7.5）。
                    // 包み（捲り容器の見えている幅に留める指定）は表の部品が持つ。位置と幅は
                    // セルの左右の余白と結び付いており、3 つを 1 つのファイルに閉じてある
                    // （dashboard-user-edit Req 6.8, 6.9 / Issue #283）。
                    <TableDetailRow colSpan={COLUMN_COUNT} id={editPanelId(user.id)}>
                      {/* パネルは開いた時点の値に固定するので、利用者ごとに作り直す（key）。
                        * 自分の行、または代理店一覧を取得できていないときは、ロールと所属を固定表示にする
                        * （dashboard-user-edit Req 2.2, 1.14）。保存の後処理には、このパネルを開いた回の
                        * 開閉の番号を持ち帰らせる。 */}
                      <DashboardUserEditPanel
                        key={user.id}
                        user={user}
                        agencies={agenciesFailed ? null : agencies}
                        isSelf={user.id === me?.id}
                        onSaved={() => handleEditSaved(openSeq)}
                        onCancel={closeEditPanel}
                      />
                    </TableDetailRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </PageShell>
  );
}

// 利用者管理（運営専用）。認可ガードで囲い、共通ナビを添える。全文言日本語（Req 7.3）。
export default function AdminUsersPage() {
  return (
    <AuthGuard>
      <TopNav />
      <UsersView />
    </AuthGuard>
  );
}
