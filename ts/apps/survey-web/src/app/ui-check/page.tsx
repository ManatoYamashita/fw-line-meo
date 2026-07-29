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
import { Field, FieldDescription, FieldLabel } from '@fwlm/ui/components/field';
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
    </main>
  );
}
