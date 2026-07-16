// ルートの最小プレースホルダ。認証状態に応じた振り分け（未認証→/login・認証済→/stores）は
// Task 4.2 以降で実装する。現状は雛形として案内のみ表示する。
export default function Home() {
  return (
    <main>
      <p>fw-line-meo ダッシュボード</p>
    </main>
  );
}
