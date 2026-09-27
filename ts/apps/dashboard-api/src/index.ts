import { serve } from '@hono/node-server';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { writeStructuredLog } from '@fwlm/observability';
import { createApp } from './app.js';
import { buildAppDeps } from './composition.js';
import { loadConfig } from './config.js';
import type { TokenVerifier } from './auth.js';

// Cloud Run エントリ。必須 env を検証し、firebase-admin を初期化して合成根（composition.ts）へ渡す。
const config = loadConfig();

// 添付 SA の ADC を使用（Cloud Run）。
initializeApp();
const firebaseAuth = getAuth();

// firebase-admin の DecodedIdToken を VerifiedToken へ写像する（検証済みクレームのみ使う）。
const verifier: TokenVerifier = {
  verifyIdToken: async (token) => {
    const decoded = await firebaseAuth.verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified ?? false,
      signInProvider: decoded.firebase.sign_in_provider ?? null,
    };
  },
};

const app = createApp(buildAppDeps({ config, verifier, structuredLog: writeStructuredLog }));

serve({ fetch: app.fetch, port: config.port });
