# EvalBoard

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
