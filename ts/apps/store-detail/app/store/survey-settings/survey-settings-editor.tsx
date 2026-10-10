'use client';

// アンケート設定画面の編集部分（Issue #437）。通信と認可は page.tsx が持ち、ここは `mutate` を呼ぶだけである。
//
// 料理・ドリンクの節ごとに、表示中の一覧（名前の変更・上へ・下へ・非表示）、追加の欄、非表示にした一覧（再表示）を
// 並べる。予約・来店は「表示する / 表示しない」の 2 択にする。
// 規則の値（40 文字・10 件）は @fwlm/db/survey-settings-rules の 1 箇所から読み、画面に数値を書かない。

import { useId, useState } from 'react';
import { Alert, AlertDescription } from '@fwlm/ui/components/alert';
import { Button } from '@fwlm/ui/components/button';
import { Card, CardContent } from '@fwlm/ui/components/card';
import { EmptyState } from '@fwlm/ui/components/empty-state';
import { Field, FieldDescription, FieldError, FieldLabel } from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@fwlm/ui/components/radio-group';
import type { SurveySettingsCategory, SurveySettingsTarget } from '@fwlm/db';
import {
  TARGET_LABEL_ERROR_MESSAGES,
  TARGET_LABEL_MAX_LENGTH,
  normalizeTargetLabel,
  targetLimitMessage,
} from '@fwlm/db/survey-settings-rules';

import { SURVEY_SETTINGS_PATHS, type SurveySettingsResponse } from '../../../lib/survey-settings-contract';

export type SettingsMutation = (
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

/** 1 つの操作を流し、成功なら案内を、失敗なら誤りの文言を返す（null は成功）。 */
type Run = (method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, success: string) => Promise<string | null>;

const PENDING_NOTICE =
  'ここで登録した料理名・ドリンク名は、新しいアンケートの準備ができしだいお客様の画面に表示されます。今お客様が使っているアンケートは変わりません。';

/** 画面上で文字数を数える（サーバーと同じく Unicode のコードポイントで数える）。 */
function lengthOf(value: string): number {
  return [...value.trim()].length;
}

/** 送る前に画面で確かめる。サーバーも同じ規則で確かめるので、ここは案内のため。 */
function checkLabel(value: string): string | null {
  const result = normalizeTargetLabel(value);
  return result.ok ? null : TARGET_LABEL_ERROR_MESSAGES[result.error];
}

export function SurveySettingsEditor({
  data,
  mutate,
}: {
  readonly data: SurveySettingsResponse;
  readonly mutate: SettingsMutation;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const run: Run = async (method, path, body, success) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await mutate(method, path, body);
      if (result.ok) {
        setNotice(success);
        return null;
      }
      return result.message;
    } finally {
      setBusy(false);
    }
  };

  const targetCategories = data.categories.filter((c) => c.ownerTargets);
  const toggleable = data.categories.filter((c) => c.toggleable);

  return (
    <div className="flex flex-col gap-8">
      {/* 案内と、操作の結果を読み上げへ届ける行（成功の案内）を 1 つの束にする。行は空のときも置いたままにし
          （書き換えとして読み上げさせるため）、束の内側の狭い間隔だけを取らせる。誤りは操作した場所の近くに出す。 */}
      <div className="flex flex-col gap-2">
        {data.structuredEnabled ? null : (
          <Alert>
            <AlertDescription>{PENDING_NOTICE}</AlertDescription>
          </Alert>
        )}
        <p role="status">{notice}</p>
      </div>
      {targetCategories.map((category) => (
        <TargetSection
          key={category.code}
          category={category}
          targets={data.targets.filter((t) => t.categoryCode === category.code)}
          busy={busy}
          run={run}
        />
      ))}
      {toggleable.map((category) => (
        <CategoryVisibility key={category.code} category={category} busy={busy} run={run} />
      ))}
    </div>
  );
}

// --- 料理・ドリンクの節 ------------------------------------------------------------------

function TargetSection({
  category,
  targets,
  busy,
  run,
}: {
  readonly category: SurveySettingsCategory;
  readonly targets: readonly SurveySettingsTarget[];
  readonly busy: boolean;
  readonly run: Run;
}): React.JSX.Element {
  const active = targets.filter((t) => t.active);
  const hidden = targets.filter((t) => !t.active);
  const limit = category.targetLimit ?? 0;
  const atLimit = active.length >= limit;
  const noun = `${category.label}名`;
  const [error, setError] = useState<string | null>(null);

  const move = async (index: number, delta: -1 | 1): Promise<void> => {
    const ids = active.map((t) => t.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    setError(
      await run('PUT', SURVEY_SETTINGS_PATHS.order, { categoryCode: category.code, targetIds: ids }, '並び順を保存しました。'),
    );
  };

  const headingId = useId();
  return (
    <section className="flex flex-col gap-4" aria-labelledby={headingId}>
      <div className="flex items-baseline justify-between gap-4">
        <Heading level={2} id={headingId}>
          {category.label}
        </Heading>
        <span className="text-sm tabular-nums">
          表示中 {active.length} / {limit} 件
        </span>
      </div>
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {active.length === 0 ? (
        <EmptyState>
          <p>{`お客様に表示する${noun}はまだありません。下の欄から追加してください。`}</p>
        </EmptyState>
      ) : (
        <Card>
          <CardContent>
            <ol className="divide-y">
              {active.map((target, index) => (
                <TargetRow
                  key={target.id}
                  target={target}
                  noun={noun}
                  first={index === 0}
                  last={index === active.length - 1}
                  busy={busy}
                  run={run}
                  onMove={(delta) => move(index, delta)}
                  onError={setError}
                />
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
      <AddTargetForm
        category={category}
        noun={noun}
        atLimit={atLimit}
        limit={limit}
        hidden={hidden}
        busy={busy}
        run={run}
      />
      {hidden.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Heading level={3}>{`非表示にした${noun}`}</Heading>
          <ul className="flex flex-col gap-2">
            {hidden.map((target) => (
              <li key={target.id} className="flex items-center justify-between gap-4">
                <span className="min-w-0 break-words">{target.label}</span>
                <Button
                  variant="outline"
                  disabled={busy || atLimit}
                  aria-label={`「${target.label}」を再表示する`}
                  onClick={async () =>
                    setError(
                      await run(
                        'PATCH',
                        SURVEY_SETTINGS_PATHS.target(target.id),
                        { active: true },
                        `「${target.label}」を再表示しました。`,
                      ),
                    )
                  }
                >
                  再表示
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function TargetRow({
  target,
  noun,
  first,
  last,
  busy,
  run,
  onMove,
  onError,
}: {
  readonly target: SurveySettingsTarget;
  readonly noun: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onMove: (delta: -1 | 1) => Promise<void>;
  readonly onError: (message: string | null) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(target.label);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  if (editing) {
    const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      const invalid = checkLabel(value);
      if (invalid) {
        setFieldError(invalid);
        return;
      }
      const error = await run('PATCH', SURVEY_SETTINGS_PATHS.target(target.id), { label: value }, '名前を変更しました。');
      if (error) setFieldError(error);
      else setEditing(false);
    };
    return (
      <li className="py-4 first:pt-0 last:pb-0">
        <form className="flex flex-col gap-3" onSubmit={save} noValidate>
          <Field data-invalid={fieldError !== null}>
            <FieldLabel htmlFor={inputId}>{`${noun}を変更`}</FieldLabel>
            <Input
              id={inputId}
              value={value}
              autoComplete="off"
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError ? errorId : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setFieldError(null);
              }}
            />
            <FieldDescription>
              {lengthOf(value)} / {TARGET_LABEL_MAX_LENGTH} 文字
            </FieldDescription>
            {fieldError === null ? null : <FieldError id={errorId}>{fieldError}</FieldError>}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              保存する
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setValue(target.label);
                setFieldError(null);
              }}
            >
              やめる
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <span className="break-words font-medium">{target.label}</span>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          aria-label={`「${target.label}」の名前を変更する`}
          onClick={() => {
            onError(null);
            setValue(target.label);
            setEditing(true);
          }}
        >
          編集
        </Button>
        <Button variant="outline" disabled={busy || first} aria-label={`「${target.label}」を上へ移動する`} onClick={() => onMove(-1)}>
          ↑ 上へ
        </Button>
        <Button variant="outline" disabled={busy || last} aria-label={`「${target.label}」を下へ移動する`} onClick={() => onMove(1)}>
          ↓ 下へ
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          aria-label={`「${target.label}」を非表示にする`}
          onClick={async () =>
            onError(
              await run(
                'POST',
                SURVEY_SETTINGS_PATHS.disableTarget(target.id),
                undefined,
                `「${target.label}」を非表示にしました。`,
              ),
            )
          }
        >
          非表示
        </Button>
      </div>
    </li>
  );
}

function AddTargetForm({
  category,
  noun,
  atLimit,
  limit,
  hidden,
  busy,
  run,
}: {
  readonly category: SurveySettingsCategory;
  readonly noun: string;
  readonly atLimit: boolean;
  readonly limit: number;
  readonly hidden: readonly SurveySettingsTarget[];
  readonly busy: boolean;
  readonly run: Run;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputId = useId();
  const descriptionId = useId();
  const errorId = useId();

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const invalid = checkLabel(value);
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    const normalized = normalizeTargetLabel(value);
    const label = normalized.ok ? normalized.value : value;
    // 非表示にしていた同名を追加すると、サーバーはその行を再表示する（同じ項目として扱う）。
    const reshown = hidden.some((t) => t.label === label);
    const error = await run(
      'POST',
      SURVEY_SETTINGS_PATHS.targets,
      { categoryCode: category.code, label: value },
      reshown ? `非表示にしていた「${label}」を再表示しました。` : `「${label}」を追加しました。`,
    );
    if (error) {
      setFieldError(error);
    } else {
      setValue('');
      setFieldError(null);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <Field data-invalid={fieldError !== null}>
        <FieldLabel htmlFor={inputId}>{`${noun}を追加`}</FieldLabel>
        <Input
          id={inputId}
          value={value}
          autoComplete="off"
          placeholder={category.code === 'food' ? '例: 刺身盛り合わせ' : '例: 自家製レモンサワー'}
          aria-invalid={fieldError !== null}
          aria-describedby={[descriptionId, fieldError ? errorId : null].filter(Boolean).join(' ')}
          disabled={atLimit}
          onChange={(event) => {
            setValue(event.target.value);
            setFieldError(null);
          }}
        />
        <FieldDescription id={descriptionId}>
          {atLimit
            ? targetLimitMessage(category.label, limit)
            : `この名前がお客様のアンケートに表示されます（${lengthOf(value)} / ${TARGET_LABEL_MAX_LENGTH} 文字）`}
        </FieldDescription>
        {fieldError === null ? null : <FieldError id={errorId}>{fieldError}</FieldError>}
      </Field>
      <div>
        <Button type="submit" disabled={busy || atLimit}>
          追加する
        </Button>
      </div>
    </form>
  );
}

// --- カテゴリの表示 ----------------------------------------------------------------------

function CategoryVisibility({
  category,
  busy,
  run,
}: {
  readonly category: SurveySettingsCategory;
  readonly busy: boolean;
  readonly run: Run;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const onId = useId();
  const offId = useId();

  const change = async (value: unknown): Promise<void> => {
    const enabled = value === 'on';
    if (enabled === category.enabled) return;
    setError(
      await run(
        'PATCH',
        SURVEY_SETTINGS_PATHS.category(category.code),
        { enabled },
        enabled ? `${category.label}をアンケートに表示します。` : `${category.label}をアンケートに表示しません。`,
      ),
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby={headingId}>
      <Heading level={2} id={headingId}>
        {category.label}
      </Heading>
      <p className="text-sm">予約を受けていないお店は「表示しない」を選ぶと、この質問がアンケートから外れます。</p>
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <RadioGroup
        aria-labelledby={headingId}
        value={category.enabled ? 'on' : 'off'}
        disabled={busy}
        onValueChange={(value) => void change(value)}
      >
        <Field orientation="horizontal">
          <RadioGroupItem id={onId} value="on" />
          <FieldLabel htmlFor={onId}>表示する</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem id={offId} value="off" />
          <FieldLabel htmlFor={offId}>表示しない</FieldLabel>
        </Field>
      </RadioGroup>
    </section>
  );
}
