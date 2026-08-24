import { describe, it, expect, afterEach, vi } from 'vitest';
import { closePool, getPool } from '../src/pool.js';

// Issue #151 の回帰ガード。
//
// 本番経路（cloud-sql-iam）の Cloud SQL Connector はインスタンス証明書のリフレッシュを
// setTimeout で予約し、close() でそれを解除する（実装は
// @google-cloud/cloud-sql-connector/dist/mjs/cloud-sql-instance.js の
// scheduledRefreshID / cancelRefresh）。閉じなければ ref 付きタイマーが残り、イベントループが
// 空にならない。長命な Cloud Run サービスでは顕在化しないが、短命な Cloud Run Job
// （summary-delivery）は業務処理を完走した後もプロセスが終了できず、600 秒のタイムアウトで
// キルされる。
//
// このフェイクは「構築でタイマーを張り、close() で解除する」というその性質だけを再現する。
// 実 Cloud SQL へは到達できないため、検証対象は「閉じたか」ではなく
// 「プロセスが終われる状態へ戻ったか」に置く。
const connectorState = vi.hoisted(() => ({
  constructed: 0,
  closed: 0,
  getOptionsRejection: null as Error | null,
  timers: [] as ReturnType<typeof setTimeout>[],
}));

vi.mock('@google-cloud/cloud-sql-connector', () => {
  class FakeConnector {
    constructor() {
      connectorState.constructed += 1;
      // unref しないことが本質（実物も unref していない）。これがイベントループを掴む。
      connectorState.timers.push(setTimeout(() => undefined, 3_600_000));
    }

    getOptions(): Promise<{ stream: () => never }> {
      if (connectorState.getOptionsRejection) {
        return Promise.reject(connectorState.getOptionsRejection);
      }
      // pg は stream を渡されても接続を確立しない（実クエリまで遅延する）。
      return Promise.resolve({
        stream: (): never => {
          throw new Error('テストでは実接続を張らない');
        },
      });
    }

    close(): void {
      connectorState.closed += 1;
      for (const timer of connectorState.timers.splice(0)) clearTimeout(timer);
    }
  }

  return {
    Connector: FakeConnector,
    IpAddressTypes: { PUBLIC: 'PUBLIC', PRIVATE: 'PRIVATE', PSC: 'PSC' },
    AuthTypes: { PASSWORD: 'PASSWORD', IAM: 'IAM' },
  };
});

/** イベントループを掴んでいるタイマーの数。setTimeout / setInterval はいずれも 'Timeout'。 */
function activeTimeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

/** cloud-sql-iam 経路の必須 env を組み立てる（DATABASE_URL の不在がモードを決める）。 */
function useCloudSqlIamEnv(): void {
  delete process.env.DATABASE_URL;
  process.env.CLOUDSQL_CONNECTION_NAME = 'test-project:asia-northeast1:test-instance';
  process.env.DB_IAM_USER = 'test-iam-user';
  process.env.DB_NAME = 'test-db';
}

describe('pool — Connector のライフサイクル（Issue #151）', () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    // singleton を跨ぐため必ず破棄する。閉じ忘れが残っている場合はここで掃除して
    // 後続のケースへ漏らさない（漏らすと基準値がずれて診断を取り違える）。
    await closePool();
    for (const timer of connectorState.timers.splice(0)) clearTimeout(timer);
    connectorState.constructed = 0;
    connectorState.closed = 0;
    connectorState.getOptionsRejection = null;
    process.env = { ...originalEnv };
  });

  // 対照（空振り防止）。この 1 件が緑でなければ、以降の検証はすべて
  // 「cloud-sql-iam 分岐へ入っていないだけ」の空振りである。
  it('対照: cloud-sql-iam 経路で Connector をちょうど 1 回構築する', async () => {
    useCloudSqlIamEnv();

    await getPool();

    expect(connectorState.constructed).toBe(1);
  });

  it('契約: closePool() が Connector.close() をちょうど 1 回呼ぶ', async () => {
    useCloudSqlIamEnv();
    await getPool();
    expect(connectorState.closed).toBe(0); // 閉じる前

    await closePool();

    expect(connectorState.closed).toBe(1);
  });

  it('帰結: closePool() 後にタイマーが基準値へ戻り、プロセスが終われる状態になる', async () => {
    useCloudSqlIamEnv();
    const baseline = activeTimeoutCount();

    await getPool();
    // 掴んだこと自体の確認。ここが baseline のままなら「解放できた」は空振りである。
    expect(activeTimeoutCount()).toBe(baseline + 1);

    await closePool();

    expect(activeTimeoutCount()).toBe(baseline);
  });

  it('エラー経路: getOptions() が失敗しても Connector を取り残さず、例外は伝播する', async () => {
    useCloudSqlIamEnv();
    connectorState.getOptionsRejection = new Error('simulated getOptions failure');
    const baseline = activeTimeoutCount();

    await expect(getPool()).rejects.toThrow('simulated getOptions failure');

    expect(connectorState.constructed).toBe(1);
    expect(connectorState.closed).toBe(1);
    expect(activeTimeoutCount()).toBe(baseline);
  });

  // 逆方向。テスト・ローカルの経路で誤検知しないことを固定する（この経路は Connector を
  // 一度も作らないので、閉じる対象も存在しない）。
  it('逆方向: database-url 経路では Connector を構築せず closePool() も例外を投げない', async () => {
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:1/does-not-matter';

    await getPool();
    expect(connectorState.constructed).toBe(0);

    await expect(closePool()).resolves.toBeUndefined();
    expect(connectorState.closed).toBe(0);
  });
});
