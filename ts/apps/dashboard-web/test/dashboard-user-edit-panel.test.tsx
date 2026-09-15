// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import type { ApiResult, DashboardUserChanges } from '../src/lib/api';
import type { AgencyItem, DashboardUserItem } from '../src/lib/types';
import { settleEffects } from './focus-observation';

// api.ts は './firebase' を取り込むため、モジュールごと差し替えて実 SDK を発火させない
// （store-qr-panel.test.tsx と同規約）。送信関数は原則として props で注入し、
// 既定の送信関数（updateDashboardUser を包むアダプタ）だけをこのモックで観測する。
const api = vi.hoisted(() => ({ updateDashboardUser: vi.fn() }));
vi.mock('../src/lib/api', () => api);

import {
  DashboardUserEditPanel,
  type DashboardUserEditPanelProps,
} from '../src/components/dashboard-user-edit-panel';

// ---- 固定の文言（design.md「Web: 編集パネル」の正典を一字一句そのまま写す） ----

const SELF_LOCKED_REASON = '自分自身のロールは変更できません。';
const AGENCIES_LOCKED_REASON =
  '代理店一覧を取得できないため、ロールと所属代理店は変更できません。画面を再読み込みしてください。';
const TO_OPERATOR_HINT = '運営にすると、全店舗の閲覧と利用者管理ができるようになります。';
const TO_AGENCY_HINT = '代理店にすると、所属代理店の店舗だけを閲覧できるようになります。';
const AGENCY_REQUIRED_TEXT = '所属代理店を選択してください。';
const GENERIC_ERROR_TEXT = '変更を保存できませんでした。時間をおいて再試行してください。';

// ---- 固定の入力 ----

const agencyAlpha: AgencyItem = {
  id: 'a1',
  operatorId: 'op1',
  name: '代理店アルファ',
  createdAt: '2026-01-01T00:00:00Z',
};
const agencyBeta: AgencyItem = {
  id: 'a2',
  operatorId: 'op1',
  name: '代理店ベータ',
  createdAt: '2026-01-02T00:00:00Z',
};
const AGENCIES: readonly AgencyItem[] = [agencyAlpha, agencyBeta];

const operatorUser: DashboardUserItem = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'operator',
  operatorId: 'op1',
  agencyId: null,
  email: 'op@example.com',
  displayName: '運営太郎',
  disabled: false,
  createdAt: '2026-01-01T00:00:00Z',
};
// 無効化済みの代理店ロール。編集は状態を問わず対象になる（Req 1.7）。
const agencyUser: DashboardUserItem = {
  id: '22222222-2222-4222-8222-222222222222',
  role: 'agency',
  operatorId: 'op1',
  agencyId: 'a1',
  email: 'agency@example.com',
  displayName: '代理花子',
  disabled: true,
  createdAt: '2026-01-02T00:00:00Z',
};

type UpdateUser = (
  id: string,
  changes: DashboardUserChanges,
) => Promise<ApiResult<DashboardUserItem>>;

function okResult(user: DashboardUserItem): ApiResult<DashboardUserItem> {
  return { ok: true, value: user };
}

function errorResult(code: string, message: string): ApiResult<DashboardUserItem> {
  return { ok: false, code, message };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type OnSaved = () => void | Promise<void>;

interface PanelOverrides {
  readonly user?: DashboardUserItem;
  readonly agencies?: readonly AgencyItem[] | null;
  readonly isSelf?: boolean;
  readonly onSaved?: Mock<OnSaved>;
  readonly updateUser?: Mock<UpdateUser>;
}

interface Rendered {
  readonly onSaved: Mock<OnSaved>;
  readonly onCancel: Mock<() => void>;
  readonly updateUser: Mock<UpdateUser>;
  readonly rerender: (next: Partial<DashboardUserEditPanelProps>) => void;
}

function renderPanel(overrides: PanelOverrides = {}): Rendered {
  const onSaved = overrides.onSaved ?? vi.fn<OnSaved>();
  const onCancel = vi.fn<() => void>();
  const updateUser =
    overrides.updateUser ?? vi.fn<UpdateUser>().mockResolvedValue(okResult(agencyUser));
  const base: DashboardUserEditPanelProps = {
    user: overrides.user ?? agencyUser,
    agencies: overrides.agencies === undefined ? AGENCIES : overrides.agencies,
    isSelf: overrides.isSelf ?? false,
    onSaved,
    onCancel,
    updateUser,
  };
  const view = render(<DashboardUserEditPanel {...base} />);
  return {
    onSaved,
    onCancel,
    updateUser,
    rerender: (next) => view.rerender(<DashboardUserEditPanel {...base} {...next} />),
  };
}

function roleSelect(): HTMLSelectElement {
  return screen.getByLabelText('ロール') as HTMLSelectElement;
}

function agencySelect(): HTMLSelectElement {
  return screen.getByLabelText('所属代理店') as HTMLSelectElement;
}

function displayNameInput(): HTMLInputElement {
  return screen.getByLabelText('表示名') as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
}

/**
 * 保存が押せる状態であること。focusableWhenDisabled を渡した Base UI の押しボタンは、押せるときも
 * aria-disabled="false" を描くので、属性の不在ではなく値で見る。減光の受け口（data-disabled）も
 * 外れていなければ、押せるのに押せない見た目のまま残る。
 */
function expectSaveEnabled(button: HTMLButtonElement): void {
  expect(button.getAttribute('aria-disabled')).not.toBe('true');
  expect(button.hasAttribute('data-disabled')).toBe(false);
  expect(button.disabled).toBe(false);
}

/** aria-describedby が指す要素の文字列を、指す順に返す（指していなければ空配列）。 */
function describedTexts(element: HTMLElement): string[] {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => {
    const target = document.getElementById(id);
    // 指す先が DOM に無い参照は、支援技術には何も伝わらない。存在しないまま緑にしない。
    expect(target, `aria-describedby が存在しない要素（${id}）を指しています`).not.toBeNull();
    return (target!.textContent ?? '').trim();
  });
}

beforeEach(() => {
  api.updateDashboardUser.mockReset();
});

afterEach(cleanup);

describe('DashboardUserEditPanel: 構成と初期値', () => {
  it('見出しつきのカードに、開いた時点のロール・所属代理店・表示名を初期値として出す（Req 1.1）', () => {
    renderPanel({ user: agencyUser });

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('agency@example.com の編集');
    expect(roleSelect().value).toBe('agency');
    expect(agencySelect().value).toBe('a1');
    expect(displayNameInput().value).toBe('代理花子');
  });

  it('見出しの対象名はメールアドレス → 表示名 → 「利用者」の順に引く', () => {
    renderPanel({ user: { ...agencyUser, email: null } });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('代理花子 の編集');
    cleanup();

    renderPanel({ user: { ...agencyUser, email: null, displayName: null } });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('利用者 の編集');
  });

  it('メールアドレスを編集する手段を置かない（Req 1.8）', () => {
    renderPanel({ user: agencyUser });

    // 記入欄は表示名の 1 つだけである。メールアドレスは見出しの中にしか現れない。
    expect(screen.getAllByRole('textbox')).toEqual([displayNameInput()]);
    expect(screen.queryByDisplayValue('agency@example.com')).toBeNull();
  });

  it('入力の ID は行ごとに一意で、登録フォームの ID と衝突しない（Req 6.8）', () => {
    render(
      <>
        <DashboardUserEditPanel
          user={agencyUser}
          agencies={AGENCIES}
          isSelf={false}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
          updateUser={vi.fn<UpdateUser>()}
        />
        <DashboardUserEditPanel
          user={{ ...agencyUser, id: '33333333-3333-4333-8333-333333333333' }}
          agencies={AGENCIES}
          isSelf={false}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
          updateUser={vi.fn<UpdateUser>()}
        />
      </>,
    );

    const expected = [
      `user-edit-role-${agencyUser.id}`,
      `user-edit-agency-${agencyUser.id}`,
      `user-edit-display-name-${agencyUser.id}`,
    ];
    for (const id of expected) {
      const control = document.getElementById(id);
      expect(control, id).not.toBeNull();
      // ラベルが制御へ結び付いていること（見えている名前で掴めること）まで確かめる。
      expect(document.querySelector(`label[for="${id}"]`), id).not.toBeNull();
    }

    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    expect(new Set(ids).size, `ID が重複しています: ${ids.join(', ')}`).toBe(ids.length);
    // 登録フォーム（admin/users/page.tsx）が使う ID。同じ画面に同時に並ぶので衝突させない。
    for (const registrationId of ['user-role', 'user-agency', 'user-email', 'user-display-name']) {
      expect(ids).not.toContain(registrationId);
    }
  });

  it('入力には name を付け、表示名はブラウザの自動入力を受けない', () => {
    renderPanel({ user: agencyUser });

    expect(roleSelect().getAttribute('name')).toBe('role');
    expect(agencySelect().getAttribute('name')).toBe('agencyId');
    expect(displayNameInput().getAttribute('name')).toBe('displayName');
    // 他人の表示名を編集する欄なので、操作者自身の名前が自動入力されると誤りになる。
    expect(displayNameInput().getAttribute('autocomplete')).toBe('off');
  });

  it('各項目の容器は汎用の容器で、幅の段は既存の 4 面と同一である（Req 6.9）', () => {
    renderPanel({ user: agencyUser });

    let visited = 0;
    for (const id of [
      `user-edit-role-${agencyUser.id}`,
      `user-edit-agency-${agencyUser.id}`,
      `user-edit-display-name-${agencyUser.id}`,
    ]) {
      const label = document.querySelector(`label[for="${id}"]`) as HTMLElement | null;
      expect(label, id).not.toBeNull();
      expect(label!.closest('p'), id).toBeNull();
      const field = label!.parentElement!;
      expect(field.tagName, id).toBe('DIV');
      const tokens = field.className.split(/\s+/).filter((token) => token.length > 0);
      // 包含では足りない。幅を与えるクラスの集合を完全一致で見る（admin-users-page.test.tsx と同じ式）。
      expect(
        tokens.filter((token) => /(^|:)(?:max-|min-)?w-/.test(token)),
        id,
      ).toEqual(['sm:max-w-xs']);
      visited += 1;
    }
    expect(visited).toBe(3);
  });

  it('保存と取りやめは押しボタンの部品で、送信の型を持たない', () => {
    renderPanel({ user: agencyUser });

    for (const name of ['保存', 'キャンセル']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('data-slot'), name).toBe('button');
      // 押しボタンの既定の型は submit である。フォームに置かれても暗黙の送信を起こさない。
      expect(button.getAttribute('type'), name).toBe('button');
    }
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('取りやめは送らずに呼び出し側へ通知する', async () => {
    const { onCancel, onSaved, updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(displayNameInput(), { target: { value: '書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await settleEffects();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('DashboardUserEditPanel: 所属代理店の欄の出し分け', () => {
  it('代理店ロールの利用者では所属代理店を選択肢つきで出し、未選択の選択肢を先頭に置く', () => {
    renderPanel({ user: agencyUser });

    const select = agencySelect();
    expect(select.required).toBe(true);
    expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
      ['', '代理店を選択してください'],
      ['a1', '代理店アルファ'],
      ['a2', '代理店ベータ'],
    ]);
  });

  it('運営ロールの利用者では所属代理店を出さず、代理店を選ぶと未選択の状態で現れ、戻すと消える', () => {
    renderPanel({ user: operatorUser });

    expect(screen.queryByLabelText('所属代理店')).toBeNull();

    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    expect(agencySelect().value).toBe('');
    expect(agencySelect().selectedOptions[0]?.text).toBe('代理店を選択してください');

    fireEvent.change(roleSelect(), { target: { value: 'operator' } });
    expect(screen.queryByLabelText('所属代理店')).toBeNull();
  });

  it('現在の所属が選択肢に無くても未選択に見せず、id を名前の代わりに出す（Req 1.1, 1.14）', () => {
    // 一覧を読み込んだ後に作られた代理店など、手元の一覧に無い所属を持つ利用者。
    renderPanel({ user: { ...agencyUser, agencyId: 'a9' } });

    const select = agencySelect();
    expect(select.value).toBe('a9');
    expect(select.selectedOptions[0]?.text).toBe('a9');
    expect(select.selectedOptions[0]?.text).not.toBe('代理店を選択してください');
  });
});

describe('DashboardUserEditPanel: ロール変更の案内（Req 2.7）', () => {
  it('開いた直後（ロールが現在と同じ）はどちらの案内も出さない（既定側の固定）', () => {
    renderPanel({ user: agencyUser });

    expect(screen.queryByText(TO_OPERATOR_HINT)).toBeNull();
    expect(screen.queryByText(TO_AGENCY_HINT)).toBeNull();
    expect(roleSelect().hasAttribute('aria-describedby')).toBe(false);
  });

  it('代理店を運営へ選ぶと運営の範囲を案内し、選択へ結び付ける。戻すと消える', () => {
    renderPanel({ user: agencyUser });

    fireEvent.change(roleSelect(), { target: { value: 'operator' } });
    expect(screen.getByText(TO_OPERATOR_HINT)).toBeTruthy();
    expect(screen.queryByText(TO_AGENCY_HINT)).toBeNull();
    expect(describedTexts(roleSelect())).toEqual([TO_OPERATOR_HINT]);

    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    expect(screen.queryByText(TO_OPERATOR_HINT)).toBeNull();
    expect(roleSelect().hasAttribute('aria-describedby')).toBe(false);
  });

  it('運営を代理店へ選ぶと代理店の範囲を案内する', () => {
    renderPanel({ user: operatorUser });

    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    expect(screen.getByText(TO_AGENCY_HINT)).toBeTruthy();
    expect(screen.queryByText(TO_OPERATOR_HINT)).toBeNull();
    expect(describedTexts(roleSelect())).toEqual([TO_AGENCY_HINT]);
  });
});

describe('DashboardUserEditPanel: ロールと所属の固定表示', () => {
  function terms(): string[] {
    return screen.getAllByRole('term').map((element) => (element.textContent ?? '').trim());
  }
  function definitions(): string[] {
    return screen.getAllByRole('definition').map((element) => (element.textContent ?? '').trim());
  }

  it('自分の行ではロールと所属を文字で出し、理由を添え、表示名だけを受け付ける（Req 2.2）', async () => {
    const { updateUser } = renderPanel({ user: operatorUser, isSelf: true });

    // 選択の部品を 1 つも出さない（出すと、固定のはずの値を操作できるように見える）。
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(terms()).toEqual(['ロール', '所属代理店']);
    // 所属の表示は一覧と同じ規則（運営は所属を持たない）。
    expect(definitions()).toEqual(['運営', '—']);
    expect(screen.getByText(SELF_LOCKED_REASON)).toBeTruthy();
    // 理由は、焦点が最初に届く記入欄（表示名）へ結び付ける。
    expect(describedTexts(displayNameInput())).toEqual([SELF_LOCKED_REASON]);

    fireEvent.change(displayNameInput(), { target: { value: '運営次郎' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls).toStrictEqual([[operatorUser.id, { displayName: '運営次郎' }]]);
  });

  it('自分の行の所属は一覧と同じ規則で名前を引く', () => {
    renderPanel({ user: agencyUser, isSelf: true });

    expect(definitions()).toEqual(['代理店', '代理店アルファ']);
  });

  it('代理店一覧を取得できていないときは、所属を id で出し、理由を添え、表示名だけを受け付ける（Req 1.14）', async () => {
    const { updateUser } = renderPanel({ user: agencyUser, agencies: null });

    expect(screen.queryAllByRole('combobox')).toEqual([]);
    // 名前を引けないので id を出す（一覧と同じ規則）。未選択の文言で置き換えない。
    expect(definitions()).toEqual(['代理店', 'a1']);
    expect(screen.queryByText('代理店を選択してください')).toBeNull();
    expect(screen.getByText(AGENCIES_LOCKED_REASON)).toBeTruthy();
    expect(screen.queryByText(SELF_LOCKED_REASON)).toBeNull();
    expect(describedTexts(displayNameInput())).toEqual([AGENCIES_LOCKED_REASON]);

    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls).toStrictEqual([[agencyUser.id, { displayName: '代理次子' }]]);
  });

  it('自分の行かつ一覧の取得失敗では、自分の行の理由を優先する', () => {
    renderPanel({ user: operatorUser, isSelf: true, agencies: null });

    expect(screen.getByText(SELF_LOCKED_REASON)).toBeTruthy();
    expect(screen.queryByText(AGENCIES_LOCKED_REASON)).toBeNull();
    expect(describedTexts(displayNameInput())).toEqual([SELF_LOCKED_REASON]);
  });

  it('固定表示でないときは理由も固定表示も出さない（既定側の固定）', () => {
    renderPanel({ user: agencyUser });

    expect(screen.queryByText(SELF_LOCKED_REASON)).toBeNull();
    expect(screen.queryByText(AGENCIES_LOCKED_REASON)).toBeNull();
    expect(screen.queryAllByRole('term')).toEqual([]);
    expect(displayNameInput().hasAttribute('aria-describedby')).toBe(false);
  });

  it('固定表示では変更が無ければ送らずに閉じる（Req 1.13）', async () => {
    const { updateUser, onCancel } = renderPanel({ user: agencyUser, agencies: null });

    fireEvent.click(saveButton());
    await settleEffects();
    expect(updateUser).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardUserEditPanel: 所属代理店の未選択（Req 1.6）', () => {
  it('開いた直後は案内も誤りの印も出さない（既定側の固定）', () => {
    renderPanel({ user: operatorUser });
    fireEvent.change(roleSelect(), { target: { value: 'agency' } });

    // 未選択でも、保存を試みるまでは誤りとして扱わない。
    expect(screen.queryByRole('alert')).toBeNull();
    expect(agencySelect().hasAttribute('aria-invalid')).toBe(false);
  });

  it('代理店ロールで所属が空なら送らず、案内を出して選択へ結び付ける', async () => {
    const { updateUser, onSaved, onCancel } = renderPanel({ user: operatorUser });

    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    fireEvent.click(saveButton());
    await settleEffects();

    expect(updateUser).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe(AGENCY_REQUIRED_TEXT);
    expect(agencySelect().getAttribute('aria-invalid')).toBe('true');
    // ロールの案内と未選択の案内を、それぞれの入力へ結ぶ（混ぜない）。
    expect(describedTexts(agencySelect())).toEqual([AGENCY_REQUIRED_TEXT]);
    expect(describedTexts(roleSelect())).toEqual([TO_AGENCY_HINT]);
  });

  it('所属を選ぶと案内と誤りの印が消え、選んだ代理店で送れる', async () => {
    const { updateUser } = renderPanel({ user: operatorUser });

    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(agencySelect().hasAttribute('aria-invalid')).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls).toStrictEqual([
      [operatorUser.id, { assignment: { kind: 'scope', role: 'agency', agencyId: 'a2' } }],
    ]);
  });

  it('代理店ロールのまま所属を空へ戻して保存しても送らない', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(agencySelect(), { target: { value: '' } });
    fireEvent.click(saveButton());
    await settleEffects();

    expect(updateUser).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(AGENCY_REQUIRED_TEXT);
  });
});

describe('DashboardUserEditPanel: 送る項目（Req 3.1, 3.4）', () => {
  async function saveAndCollect(updateUser: Rendered['updateUser']): Promise<unknown[][]> {
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    return updateUser.mock.calls;
  }

  it('代理店ロールのまま所属だけを変えると、ロールを含めずに所属の移動を送る（Req 3.4）', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    // キーの有無まで固定する。ロールを載せると「代理店にする」と同じ意味になり、他の操作で運営に
    // なっていた対象を降格させてしまう。
    expect(await saveAndCollect(updateUser)).toStrictEqual([
      [agencyUser.id, { assignment: { kind: 'agency', agencyId: 'a2' } }],
    ]);
  });

  it('運営を代理店にするときは、ロールの変更に選んだ代理店を添える', async () => {
    const { updateUser } = renderPanel({ user: operatorUser });

    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    fireEvent.change(agencySelect(), { target: { value: 'a1' } });
    expect(await saveAndCollect(updateUser)).toStrictEqual([
      [operatorUser.id, { assignment: { kind: 'scope', role: 'agency', agencyId: 'a1' } }],
    ]);
  });

  it('代理店を運営にするときは、所属を含めずにロールの変更だけを送る', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(roleSelect(), { target: { value: 'operator' } });
    expect(await saveAndCollect(updateUser)).toStrictEqual([
      [agencyUser.id, { assignment: { kind: 'scope', role: 'operator' } }],
    ]);
  });

  it('表示名だけを変えると、表示名だけを送る', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    expect(await saveAndCollect(updateUser)).toStrictEqual([
      [agencyUser.id, { displayName: '代理次子' }],
    ]);
  });

  it('ロールと表示名を変えると、両方を送る', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(roleSelect(), { target: { value: 'operator' } });
    fireEvent.change(displayNameInput(), { target: { value: '運営花子' } });
    expect(await saveAndCollect(updateUser)).toStrictEqual([
      [
        agencyUser.id,
        { assignment: { kind: 'scope', role: 'operator' }, displayName: '運営花子' },
      ],
    ]);
  });

  it('比べる相手は開いた時点の値である（開いている間に一覧が取り直されても変わらない）', async () => {
    const { updateUser, rerender } = renderPanel({ user: agencyUser });

    // 開いている間に、他の運営がこの利用者を運営へ昇格させ、一覧が取り直された。
    rerender({ user: { ...agencyUser, role: 'operator', agencyId: null } });
    fireEvent.change(agencySelect(), { target: { value: 'a2' } });

    // 所属の移動として送る。ロールを載せないので、サーバが 409 role_changed で止められる。
    // 取り直した値と比べると「代理店にする」になり、昇格を黙って巻き戻してしまう。
    expect(await saveAndCollect(updateUser)).toStrictEqual([
      [agencyUser.id, { assignment: { kind: 'agency', agencyId: 'a2' } }],
    ]);
  });
});

describe('DashboardUserEditPanel: 表示名の正規化（Req 1.5）', () => {
  it('前後の空白を取り除いて送る', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(displayNameInput(), { target: { value: '  代理 次子  ' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls).toStrictEqual([[agencyUser.id, { displayName: '代理 次子' }]]);
  });

  it('空白だけにすると未設定（null）を送る', async () => {
    const { updateUser } = renderPanel({ user: agencyUser });

    fireEvent.change(displayNameInput(), { target: { value: '   ' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser.mock.calls).toStrictEqual([[agencyUser.id, { displayName: null }]]);
  });

  it('未設定の表示名へ空白だけを入れても、変更として送らない', async () => {
    const { updateUser, onCancel } = renderPanel({
      user: { ...agencyUser, displayName: null },
    });

    fireEvent.change(displayNameInput(), { target: { value: '   ' } });
    fireEvent.click(saveButton());
    await settleEffects();
    expect(updateUser).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('前後の空白を持つ保存済みの表示名は、触れなければ送らない（Req 3.1）', async () => {
    const { updateUser, onCancel } = renderPanel({
      user: { ...agencyUser, displayName: ' 代理花子 ' },
    });

    expect(displayNameInput().value).toBe(' 代理花子 ');
    fireEvent.click(saveButton());
    await settleEffects();
    expect(updateUser).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardUserEditPanel: 変更が無いとき（Req 1.13）', () => {
  it('何も変えずに保存すると、送らずに取りやめと同じく閉じる', async () => {
    const { updateUser, onCancel, onSaved } = renderPanel({ user: agencyUser });

    fireEvent.click(saveButton());
    await settleEffects();
    expect(updateUser).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('ロールを変えて元へ戻し、同じ所属のままなら送らない', async () => {
    const { updateUser, onCancel } = renderPanel({ user: agencyUser });

    fireEvent.change(roleSelect(), { target: { value: 'operator' } });
    fireEvent.change(roleSelect(), { target: { value: 'agency' } });
    expect(agencySelect().value).toBe('a1');
    fireEvent.change(displayNameInput(), { target: { value: '代理花子' } });
    fireEvent.click(saveButton());
    await settleEffects();
    expect(updateUser).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardUserEditPanel: 送信と結果', () => {
  it('成功すると呼び出し側へ通知し、警告を出さない', async () => {
    const { updateUser, onSaved, onCancel } = renderPanel({ user: agencyUser });

    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('既定の送信は updateDashboardUser を { id, changes } の形で呼ぶ', async () => {
    api.updateDashboardUser.mockResolvedValue(okResult(agencyUser));
    const onSaved = vi.fn();
    render(
      <DashboardUserEditPanel
        user={agencyUser}
        agencies={AGENCIES}
        isSelf={false}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.updateDashboardUser.mock.calls).toStrictEqual([
      [{ id: agencyUser.id, changes: { assignment: { kind: 'agency', agencyId: 'a2' } } }],
    ]);
  });

  it('送信中は保存を押せない状態にしつつ焦点を残し、重ねて押しても送らない（Req 6.7）', async () => {
    const pending = deferred<ApiResult<DashboardUserItem>>();
    const updateUser = vi.fn<UpdateUser>().mockReturnValue(pending.promise);
    const { onSaved } = renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    const save = saveButton();
    // 送信前は押せる（押せない状態は、正しい送信が始まってから終わるまでだけ）。
    expectSaveEnabled(save);
    save.focus();
    fireEvent.click(save);

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    // 焦点を残すため native の disabled 属性は付かない。減光は data-disabled 側でしか届かない。
    expect(save.hasAttribute('data-disabled')).toBe(true);
    expect(save.disabled).toBe(false);
    expect(document.activeElement).toBe(save);

    fireEvent.click(save);
    fireEvent.click(save);
    expect(updateUser).toHaveBeenCalledTimes(1);

    pending.resolve(okResult(agencyUser));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  it('呼び出し側の後処理が終わるまで保存は押せないままである', async () => {
    const afterSave = deferred<void>();
    const onSaved = vi.fn<OnSaved>(() => afterSave.promise);
    const { updateUser } = renderPanel({ user: agencyUser, onSaved });

    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    // 一覧の取り直しの間に、同じ変更をもう一度送らせない。
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(saveButton());
    expect(updateUser).toHaveBeenCalledTimes(1);

    afterSave.resolve();
    await waitFor(() => expectSaveEnabled(saveButton()));
  });

  it('失敗すると入力を保持し、警告を 1 件だけ出し、もう一度押せるようにする（Req 6.6）', async () => {
    const updateUser = vi
      .fn<UpdateUser>()
      .mockResolvedValue(errorResult('role_changed', 'サーバが返した文言'));
    const { onSaved, onCancel } = renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    fireEvent.click(saveButton());

    await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(roleSelect().value).toBe('agency');
    expect(agencySelect().value).toBe('a2');
    expect(displayNameInput().value).toBe('代理次子');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expectSaveEnabled(saveButton());
  });

  it('失敗の後にもう一度失敗しても、警告は 1 件のまま最新の理由に替わる', async () => {
    const updateUser = vi
      .fn<UpdateUser>()
      .mockResolvedValueOnce(errorResult('agency_not_found', '1 回目'))
      .mockResolvedValueOnce(errorResult('not_found', '2 回目'));
    renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        '選択した代理店が見つかりません。画面を再読み込みしてください。',
      ),
    );

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        '利用者が見つかりません。画面を再読み込みしてください。',
      ),
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  // 上のテストは 2 回目の結果が出た後だけを見ている。保存の開始で前の警告を消さない実装でも、
  // 結果が出れば新しい理由へ置き換わるので緑のまま通る。送信の間を観測点にして塞ぐ。
  it('失敗の後にもう一度保存すると、送信の間は前の警告を消す（古い理由を読ませ続けない・Req 6.6）', async () => {
    const pending = deferred<ApiResult<DashboardUserItem>>();
    const updateUser = vi
      .fn<UpdateUser>()
      .mockResolvedValueOnce(errorResult('agency_not_found', 'サーバが返した文言'))
      .mockReturnValueOnce(pending.promise);
    const { onSaved } = renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    fireEvent.click(saveButton());
    // 前提: 1 回目の失敗の警告が出ている（出ていない状態から 0 件を見ても何も確かめない）。
    await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    fireEvent.click(saveButton());
    // 2 回目の送信が始まっている（所属の未選択などの検証で止まったのではない）ことを先に確かめる。
    expect(updateUser).toHaveBeenCalledTimes(2);
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    // 「出さない」向きの比較なので、観測点を確定させてから比べる（Issue #166）。
    await settleEffects();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);

    pending.resolve(okResult(agencyUser));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('送信の失敗の後に所属の未選択で止めても、警告は 1 件である', async () => {
    const updateUser = vi
      .fn<UpdateUser>()
      .mockResolvedValue(errorResult('agency_not_found', 'サーバが返した文言'));
    renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(agencySelect(), { target: { value: 'a2' } });
    fireEvent.click(saveButton());
    await screen.findByRole('alert');

    fireEvent.change(agencySelect(), { target: { value: '' } });
    fireEvent.click(saveButton());
    await settleEffects();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe(AGENCY_REQUIRED_TEXT);
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  it('送信関数が例外を投げても押せないまま固着せず、汎用の文言を出す', async () => {
    const updateUser = vi.fn<UpdateUser>().mockRejectedValue(new Error('boom'));
    const { onSaved } = renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(displayNameInput(), { target: { value: '代理次子' } });
    fireEvent.click(saveButton());

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe(GENERIC_ERROR_TEXT);
    expectSaveEnabled(saveButton());
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('DashboardUserEditPanel: 拒否の文言（Req 2.6, 3.4, 4.7, 6.10）', () => {
  it.each([
    ['self_role_change_forbidden', '自分自身のロールは変更できません。'],
    ['last_operator', '最後の運営は代理店に変更できません。先に別の運営を追加してください。'],
    [
      'role_changed',
      '他の操作でこの利用者のロールが変わりました。画面を再読み込みしてから、もう一度操作してください。',
    ],
    ['agency_not_found', '選択した代理店が見つかりません。画面を再読み込みしてください。'],
    ['not_found', '利用者が見つかりません。画面を再読み込みしてください。'],
    ['validation_failed', '入力内容を確認してください（ロールと所属代理店）。'],
  ])('%s はパネル自身の固定の文言へ写す', async (code, text) => {
    const updateUser = vi
      .fn<UpdateUser>()
      .mockResolvedValue(errorResult(code, 'サーバが返した文言'));
    renderPanel({ user: agencyUser, updateUser });

    fireEvent.change(roleSelect(), { target: { value: 'operator' } });
    fireEvent.click(saveButton());

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe(text);
    // サーバの message は描かない（内部の詳細を画面へ流さない）。
    expect(document.body.textContent).not.toContain('サーバが返した文言');
  });

  it.each([['network'], ['http_500'], ['SOMETHING_UNKNOWN'], ['constructor'], ['toString']])(
    '未知のコード（%s）は汎用の文言にする',
    async (code) => {
      const updateUser = vi
        .fn<UpdateUser>()
        .mockResolvedValue(errorResult(code, 'サーバが返した文言'));
      renderPanel({ user: agencyUser, updateUser });

      fireEvent.change(roleSelect(), { target: { value: 'operator' } });
      fireEvent.click(saveButton());

      await screen.findByRole('alert');
      // Object.prototype 由来の名前でも空の文言にならないこと（対応表は鎖を持たない入れ物で引く）。
      expect(screen.getByRole('alert').textContent).toBe(GENERIC_ERROR_TEXT);
      expect(document.body.textContent).not.toContain('サーバが返した文言');
    },
  );
});
