// 一括発信の試験の共通部品（偽の投稿先・置き場・Messenger・生成器と、DB の固定データ）。
import type { getPool } from '@fwlm/db';
type Pool = Awaited<ReturnType<typeof getPool>>;
import type { Availability, DestinationAdapter, PublishInput, PublishOutcome, ReconcileOutcome } from '../../src/crosspost/adapters/types.js';
import type { CrosspostDestination } from '../../src/crosspost/domain.js';
import type { CrosspostLogEvent, CrosspostLogger, CrosspostLogMeta } from '../../src/crosspost/logger.js';
import type { MediaStore } from '../../src/crosspost/media.js';
import type { CrosspostPrompts, GenerateCrosspostRequest } from '../../src/crosspost/prompts.js';
import type { LineMessage } from '../../src/line/client.js';

export interface FakeAdapter extends DestinationAdapter {
  calls: PublishInput[];
  availabilityResult: Availability;
  /** 次の publish の振る舞い（順に消費・尽きたら最後のものを使い続ける）。 */
  behaviors: Array<(input: PublishInput, save: (c: string) => Promise<void>) => Promise<PublishOutcome>>;
  reconcileResult: ReconcileOutcome | null;
}

export function fakeAdapter(destination: CrosspostDestination, availability: Availability = { kind: 'available' }): FakeAdapter {
  const adapter: FakeAdapter = {
    destination,
    calls: [],
    availabilityResult: availability,
    behaviors: [async () => ({ kind: 'succeeded', externalId: `${destination}-post-1`, externalUrl: null })],
    reconcileResult: null,
    async availability() {
      return adapter.availabilityResult;
    },
    async publish(input, save) {
      adapter.calls.push(input);
      const behavior = adapter.behaviors.length > 1 ? adapter.behaviors.shift()! : adapter.behaviors[0]!;
      return behavior(input, save);
    },
  };
  return adapter;
}

export function withReconcile(adapter: FakeAdapter, result: ReconcileOutcome): FakeAdapter {
  adapter.reconcileResult = result;
  adapter.reconcile = async () => result;
  return adapter;
}

export interface MemoryMediaStore extends MediaStore {
  objects: Map<string, Buffer>;
  deleted: string[];
}

export function memoryMediaStore(canIssueFetchUrl: boolean): MemoryMediaStore {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    canIssueFetchUrl,
    async put({ key, bytes }) {
      objects.set(key, bytes);
    },
    async delete(key) {
      deleted.push(key);
      objects.delete(key);
    },
    async issueFetchUrl(key) {
      return canIssueFetchUrl && objects.has(key) ? `https://media.example.test/${encodeURIComponent(key)}?t=1` : null;
    },
  };
}

export interface RecordingLogger extends CrosspostLogger {
  entries: Array<{ level: string; event: CrosspostLogEvent; meta?: CrosspostLogMeta }>;
}

export function recordingLogger(): RecordingLogger {
  const entries: RecordingLogger['entries'] = [];
  const push = (level: string) => (event: CrosspostLogEvent, meta?: CrosspostLogMeta) => {
    entries.push({ level, event, ...(meta === undefined ? {} : { meta }) });
  };
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

export interface FakeMessenger {
  replies: Array<{ token: string; messages: readonly LineMessage[] }>;
  pushes: Array<{ to: string; messages: readonly LineMessage[] }>;
  reply(token: string, messages: readonly LineMessage[]): Promise<void>;
  push(to: string, messages: readonly LineMessage[]): Promise<void>;
}

export function fakeMessenger(): FakeMessenger {
  const m: FakeMessenger = {
    replies: [],
    pushes: [],
    async reply(token, messages) {
      m.replies.push({ token, messages });
    },
    async push(to, messages) {
      m.pushes.push({ to, messages });
    },
  };
  return m;
}

export function fakePrompts(): CrosspostPrompts & { requests: GenerateCrosspostRequest[]; fail: boolean } {
  const prompts = {
    requests: [] as GenerateCrosspostRequest[],
    fail: false,
    async generate(request: GenerateCrosspostRequest) {
      prompts.requests.push(request);
      if (prompts.fail) return { ok: false as const, error: { kind: 'API_ERROR' as const } };
      const targets = request.revision ? [request.revision.destination] : request.destinations;
      const value: Partial<Record<CrosspostDestination, string>> = {};
      for (const d of targets) {
        value[d] = request.revision ? `${d}の直した文（${request.revision.instruction}）` : `${d}の文: ${request.material.materialText}`;
      }
      return { ok: true as const, value };
    },
  };
  return prompts;
}

/** 返信・プッシュの全文（Flex を含む）を 1 本の文字列にする（文言の有無の確認用）。 */
export function flatten(messages: readonly LineMessage[]): string {
  return JSON.stringify(messages);
}

export interface Fixture {
  owner: string;
  otherOwner: string;
  store: string;
  store2: string;
  otherStore: string;
}

/** 固定 UUID（プレフィックスはファイルごとに変える）で運営・代理店・オーナー・店舗を作る。 */
export async function seedFixture(pool: Pool, prefix: string): Promise<Fixture> {
  const id = (n: string): string => `${prefix}${n}`.padEnd(8, '0') + '-0000-4000-8000-000000000000';
  const f: Fixture = { owner: id('a1'), otherOwner: id('b1'), store: id('a5'), store2: id('a6'), otherStore: id('b5') };
  const op = id('01');
  const ag = id('02');
  await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [op, `op-${prefix}`]);
  await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ag, op, `ag-${prefix}`]);
  await pool.query(
    `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
     VALUES ($1, $3, $4, 'store_identified'), ($2, $3, $5, 'store_identified') ON CONFLICT DO NOTHING`,
    [f.owner, f.otherOwner, ag, `U${prefix}a`, `U${prefix}b`],
  );
  await pool.query(
    `INSERT INTO stores (id, owner_id, name, place_id, place_status, created_at)
     VALUES ($1, $4, '森のカフェ', $6, 'confirmed', now() - interval '2 day'),
            ($2, $4, '森のカフェ 2号店', $7, 'confirmed', now() - interval '1 day'),
            ($3, $5, '他店', $8, 'confirmed', now()) ON CONFLICT DO NOTHING`,
    [f.store, f.store2, f.otherStore, f.owner, f.otherOwner, `P-${prefix}-1`, `P-${prefix}-2`, `P-${prefix}-3`],
  );
  return f;
}

export async function clearCrosspost(pool: Pool, owners: readonly string[]): Promise<void> {
  await pool.query('DELETE FROM crosspost_drafts WHERE owner_id = ANY($1::uuid[])', [owners]);
}
