# Evalora

An evals dashboard for any AI. Bring your own API key, pick any model, run test suites,
score the outputs, and compare runs over time.

## Run it

```bash
npm install
cp .env.example .env     # on Windows: copy .env.example .env
npm run gen-key          # copy the output into ENCRYPTION_KEY in .env
npm run dev
npm test                 # optional: run the tests
```

No Docker, no separate database server. Data lives in `data/evalboard.db` (SQLite).

## Design: bring your own key
The platform holds no AI key. Users add a Credential (provider + their own key, stored
encrypted with AES-256-GCM), create a Target (credential + model name), and run suites.
`ENCRYPTION_KEY` is only used to encrypt those stored user keys (and to derive the JWT secret).

## API so far

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /health | no | Server + DB check |
| POST | /auth/register | no | `{email, password}` returns a JWT |
| POST | /auth/login | no | `{email, password}` returns a JWT |
| GET | /me | yes | Current user |
| POST | /credentials | yes | `{label, provider, apiKey, baseUrl?}` |
| GET | /credentials | yes | List keys (only `••••last4` is shown) |
| DELETE | /credentials/:id | yes | Remove a key |

Send the token as `Authorization: Bearer <token>`.

## Project layout
```
src/
  server.ts            starts the server
  app.ts               builds the Fastify app, plugins, error handling
  config.ts            validates environment variables
  db.ts                opens SQLite and creates all tables
  lib/crypto.ts        AES-256-GCM encryption + scrypt password hashing
  lib/auth.ts          requireAuth hook (JWT)
  routes/auth.ts       register, login, /me
  routes/credentials.ts  add / list / delete API keys
test/                  automated tests
```

## Security notes
- Passwords hashed with scrypt; login errors do not reveal which emails exist
- API keys encrypted at rest and never returned by any endpoint
- Every query is filtered by the user's workspace (tenant isolation)
- Rate limiting on all routes, stricter on register/login

## CLI and CI gate

Run an evaluation from a terminal or a CI pipeline and fail the build when quality drops:

```bash
export EVALBOARD_EMAIL=you@example.com EVALBOARD_PASSWORD=...
npm run eval -- run --suite "Support questions" --target "Support bot" \
  --system-prompt-file prompts/support.txt \
  --baseline latest --fail-under 0.85 --max-regressions 0
```

| Option | Meaning |
|---|---|
| `--fail-under 0.85` | fail if the pass rate is below 85% |
| `--baseline <run-id\|latest>` | compare with an earlier run of the same suite |
| `--max-regressions 0` | fail if any case that passed before now fails |
| `--max-drop 0.05` | fail if the pass rate drops more than 5 points |
| `--system-prompt-file` | test a new prompt (a copy of the target is created; the original is untouched) |
| `--json` | machine-readable output |

Exit codes: `0` passed, `1` a quality gate failed, `2` something broke (bad options, server unreachable, the run failed).
In GitHub Actions the CLI also writes error annotations and a job summary. See `.github/workflows/eval.yml`.
