// @fwlm/ui の対話的部品を実描画する E2E 専用の検証面（Issue #49）。
//
// なぜこのページが要るか:
// フォーカス可視性の欠陥（Issue #49）が CI 全緑のまま main に入った構造的な原因は、
// 既存の E2E（e2e/ui-foundation.spec.ts）が走査する回答画面が **素の <button> / <textarea> /
// <input>** で構成されており、@fwlm/ui の部品を一度も通っていなかったことにある。
// 手法（getComputedStyle による実描画判定）は正しかったが、検証対象が本番の部品経路ではなかった。
//
// このページは部品を実際に描画してキーボード操作の的にすることで、その穴を塞ぐ。
// 副次的に、@fwlm/ui の全13部品を import する唯一の面として、`next build` が部品の .tsx を
// コンパイルする恒久経路にもなる（Issue #51。それ以前は一度もコンパイルされていなかった）。
// 部品を追加した際は、このページにも必ず追加してコンパイル経路に乗せること。
//
// 利用者向けの導線からは一切リンクせず、検索エンジンにも登録させない（下の metadata）。
import type { Metadata } from 'next';

import { Alert, AlertDescription, AlertTitle } from '@fwlm/ui/components/alert';
import { Badge } from '@fwlm/ui/components/badge';
import { Button } from '@fwlm/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@fwlm/ui/components/card';
import { Checkbox } from '@fwlm/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from '@fwlm/ui/components/field';
import { Heading } from '@fwlm/ui/components/heading';
import { Input } from '@fwlm/ui/components/input';
import { Label } from '@fwlm/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@fwlm/ui/components/radio-group';
import { Separator } from '@fwlm/ui/components/separator';
import { Spinner } from '@fwlm/ui/components/spinner';
import { Textarea } from '@fwlm/ui/components/textarea';

export const metadata: Metadata = {
  title: 'UI 基盤の検証面',
  robots: { index: false, follow: false },
};

export default function UiCheckPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-4">
      <h1>UI 基盤の検証面</h1>
      <p>
        自動検証（E2E）専用のページです。利用者向けの機能はありません。
      </p>

      <Button>既定のボタン</Button>
      <Button variant="destructive">破壊的なボタン</Button>
      <Button variant="outline">枠線のボタン</Button>
      <Button variant="secondary">副次のボタン</Button>
      <Button variant="ghost">背景なしのボタン</Button>
      <Button variant="link">リンク風のボタン</Button>

      <Input aria-label="一行入力" placeholder="一行入力" />
      <Textarea aria-label="複数行入力" placeholder="複数行入力" />
      <Checkbox aria-label="チェックボックス" />

      <RadioGroup aria-label="ラジオグループ" defaultValue="first">
        <RadioGroupItem value="first" aria-label="ラジオ1" />
        <RadioGroupItem value="second" aria-label="ラジオ2" />
      </RadioGroup>

      {/*
        Alert は非対話要素なので上の Tab 巡回には乗らない。ここでは「変種の状態色が
        説明文まで実描画で届いているか」を測るための的として置く（PR #56 レビュー指摘1）。
        既定の変種を基準色として並べ、success / destructive の説明文がそれと異なる色で
        描かれることを E2E が実測する。Tab 巡回の起点（既定のボタン）を変えないよう末尾に置く。
      */}
      <Alert>
        <AlertTitle>お知らせ</AlertTitle>
        <AlertDescription>既定の説明文です</AlertDescription>
      </Alert>
      <Alert variant="success">
        <AlertTitle>成功の通知</AlertTitle>
        <AlertDescription>成功の説明文です</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>エラーの通知</AlertTitle>
        <AlertDescription>エラーの説明文です</AlertDescription>
      </Alert>

      {/*
        以下は残りの非対話部品（Issue #51）。全13部品を next build のコンパイル経路に
        乗せるための恒久配置。tabbable を増やさず（Tab 巡回の起点と MAX_TAB_STEPS を
        崩さない）、既存 E2E の locator（「〜のボタン」「〜の通知」等）と衝突する
        role・テキストも持たせないこと。
      */}
      <Heading level={2}>非対話部品の検証</Heading>
      <Badge>バッジ</Badge>
      <Separator />
      <Card>
        <CardHeader>
          <CardTitle>カードの題</CardTitle>
          <CardDescription>カードの補足です</CardDescription>
        </CardHeader>
        <CardContent>カードの本文です</CardContent>
      </Card>
      <Field>
        <FieldLabel>フィールドのラベル</FieldLabel>
        <FieldDescription>フィールドの補足です</FieldDescription>
      </Field>
      <Label>単独のラベル</Label>
      <Spinner />

      {/*
        以下は状態バリエーション（Issue #57 / spec form-non-text-contrast タスク 4.1）。
        エラー・チェック済み・エラー×チェック済み・無効化の 4 状態を実描画し、E2E が
        「クラス名の集合では証明できない実際の枠色」を測るための的にする。

        配置の規律: ここから下は **操作可能要素を増やす**。既存のキーボード巡回テスト
        （e2e/ui-foundation.spec.ts）は「最初の Tab で『既定のボタン』へ入る」ことと
        「『破壊的なボタン』『複数行入力』へ到達する」ことを前提にしているため、
        追加は必ずそれらより後方（＝このファイルの末尾）に置く。追加後の操作可能要素は
        16 個で巡回上限（MAX_TAB_STEPS = 24）に収まる。

        命名の規律: Playwright の getByRole({ name }) は**部分一致**で照合する。
        既存 locator（「〜のボタン」「〜の通知」「一行入力」「複数行入力」「チェックボックス」）
        と衝突しないことに加え、ここで追加する名前どうしも互いの部分文字列にならないようにしてある。
        FieldError は role="alert" を持つため getByRole('alert') の集合に加わる。既存の Alert
        テストは「お知らせ」「成功の通知」「エラーの通知」で絞り込むので、その文言を含めない。
      */}
      <Heading level={2}>状態バリエーションの検証</Heading>

      {/* エラー（未選択）。色以外の手段として FieldError が可視の文言を伴う（要件 3.5）。
          Field の data-invalid は領域の文字色をエラー色へ切り替える。 */}
      <Field orientation="horizontal" data-invalid="true">
        <Checkbox aria-label="エラーの確認欄" aria-invalid="true" />
        <FieldError>この項目の入力が必要です</FieldError>
      </Field>

      {/* チェック済み（正常）。枠・面ともに選択色になる。 */}
      <Field orientation="horizontal">
        <Checkbox aria-label="チェック済みの確認欄" defaultChecked />
      </Field>

      {/* エラー × チェック済み。本仕様が是正した詳細度（aria-invalid:aria-checked:）の実証対象。
          枠はエラー色を保ち、選択済みであることは面塗りとチェック印が担う（要件 3.1〜3.3）。 */}
      <Field orientation="horizontal" data-invalid="true">
        <Checkbox aria-label="エラー重畳の確認欄" aria-invalid="true" defaultChecked />
        <FieldError>選んだ内容を見直してください</FieldError>
      </Field>

      {/* エラー状態の一行入力。エラー枠の実描画色を入力部品でも測れるようにする（要件 3.4）。 */}
      <Field orientation="horizontal" data-invalid="true">
        <Input aria-label="エラーの記入欄" aria-invalid="true" />
        <FieldError>書式が正しくありません</FieldError>
      </Field>

      {/* 無効化。design.md D8 が記録した枠・面の実効色（要素の不透明度まで含めた合成後の色）の
          測定対象。値そのものは design.md 側にあり、ここへは書き写さない（直書き色の検出ガードに
          掛かるうえ、二重に持つと drift の発生源になる）。
          disabled な要素は Tab 巡回に乗らないため巡回テストへの影響はない。 */}
      <Input aria-label="無効化の記入欄" disabled />

      {/*
        ラベル領域が選択肢を包む構成（選択済み・未選択の対）。

        なぜこの入れ子が要るか: FieldLabel の枠は `has-[>[data-slot=field]]:border` で
        **直下に Field を持つときだけ**描かれ、選択色は `has-data-checked:border-primary` で
        **内部に data-checked を持つ要素があるときだけ**適用される。上の既存の描画は
        FieldLabel が入れ子を持たないため、この指定は一度も発火しない。対で並べることで
        「選択枠が 3:1 以上」かつ「未選択とは別色」であることを実測できる。

        アクセシブル名の注意: Base UI は <label> に内包された制御へ aria-labelledby を
        ラベル本文へ向けて張るため、内側の Checkbox に aria-label を足しても効かない
        （aria-labelledby が aria-label に優先する）。内側の Checkbox の名前は FieldTitle の
        文言そのものになる。ラベル領域自身は role を持たない <label> なので role では
        特定できず、測定は data-testid で行う。
      */}
      <FieldLabel data-testid="wrapped-choice-checked">
        <Field orientation="horizontal">
          <Checkbox defaultChecked />
          <FieldTitle>囲み枠の選択済み</FieldTitle>
        </Field>
      </FieldLabel>
      <FieldLabel data-testid="wrapped-choice-unchecked">
        <Field orientation="horizontal">
          <Checkbox />
          <FieldTitle>囲み枠の未選択</FieldTitle>
        </Field>
      </FieldLabel>
    </main>
  );
}
