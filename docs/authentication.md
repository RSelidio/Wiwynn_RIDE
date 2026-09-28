# Authentication and access control

Written for the engineers who will wire up SSO and review the access rules.

## Where it stands

Local email-and-password authentication is implemented and in use. Microsoft
Entra ID single sign-on is **designed for but not switched on** — `spec §12`
asks for the MVP to use local auth and for production to be *able* to use
company identity, subject to IT approval.

## Token model

| Token | Lifetime | Stored | Purpose |
| --- | --- | --- | --- |
| Access | 15 min (`JWT_ACCESS_TTL`) | In memory only | Every API call and the socket handshake |
| Refresh | 30 days (`JWT_REFRESH_TTL`) | httpOnly cookie (web), platform keystore (driver) | Obtaining a new access token |

The access token is a HS256 JWT carrying `sub`, `role`, `employeeId` and
`driverId`. Because the role and profile ids travel in the token, an
authenticated request costs **no database round trip** to authorise.

### Three deliberate choices

**The access token is never persisted.** Not `localStorage`, not a cookie. It
lives in a module variable and is re-acquired by a silent refresh on page load.
An XSS bug can read `localStorage`; it cannot read a closure across a reload.

**Refresh tokens are stored hashed.** `refresh_tokens.token_hash` holds a
SHA-256 of an opaque random value. A database dump cannot be replayed as a live
session.

**Refresh tokens rotate on every use.** `rotateRefreshToken` revokes the
presented token and issues a new one. A stolen refresh token works at most once,
and the legitimate client's next refresh fails loudly rather than the two
silently sharing a session.

### The algorithm is pinned

```ts
jwt.verify(token, secret, { algorithms: ['HS256'] })
```

Without `algorithms`, a token presenting `alg: none` is accepted by some
verifier configurations. This is not theoretical; it is one of the most
commonly exploited JWT mistakes.

### Login timing

`authenticateLocal` runs a bcrypt comparison **even when the account does not
exist**, against a throwaway hash:

```ts
const hash = row?.password_hash ?? DUMMY_HASH;
const matches = await bcrypt.compare(password, hash);
```

Returning early for an unknown email would make "no such user" measurably faster
than "wrong password", handing out a list of valid company emails.

Login is additionally rate limited to 20 attempts per 15 minutes per IP. Behind
IIS this depends on `app.set('trust proxy', 1)` being in place so the real
client address is used rather than the proxy's.

## Roles

| Role | Can do |
| --- | --- |
| `employee` | Raise, view and cancel **their own** requests; read stops and the shuttle board; their own trips and notifications |
| `driver` | Manage their own shift; push GPS; accept, reject and advance requests **assigned to them**; read the fleet |
| `admin` | Everything: dispatch, assignment, management, reports, settings, audit |
| `guard` | Gate log at their gate: check in, check out, correct, remove. Nothing else. |

`guard` is our addition. `spec §12` names three roles; the security team on the
gate tablet needs to stamp shuttles without reaching dispatch, employee records
or settings, and giving them `admin` would have over-granted badly for the sake
of one screen. See `ROLES` in `packages/shared-types/src/domain.ts`.

### How it is enforced

Three layers, and the first two are the ones that matter:

1. **Route guards.** `requireAuth` establishes who is calling; `requireRole(...)`
   narrows to who may. Applied per router in `apps/backend/src/routes/`.
2. **Ownership checks inside handlers.** A role check alone would let any
   employee read any request. `GET /requests/:id` additionally verifies the
   employee owns it, and `employeeId(req)` / `driverId(req)` take the profile id
   from the **token**, never from a query parameter — so there is no shape of
   request that reads someone else's data.
3. **Socket rooms.** An employee joins `employee:<id>` and never `dispatch`, so
   fleet-wide traffic is not merely hidden in their UI — it is never sent.

Transition authority is separate again: `roleCanTransition` (shared-utils) says
which role may move a request from one status to which other. Request expiry has
an empty role list, meaning system-only — no human triggers it.

## Enabling Entra ID

The seam already exists. What is missing is one route.

### 1. Register the application

In the Entra admin centre, register a web application with a redirect URI of
`https://shuttle.company.com/api/auth/sso/callback`. Grant delegated
`openid`, `profile`, `email`. Note the tenant id, client id and a client secret.

### 2. Configure

```ini
ENTRA_TENANT_ID=...
ENTRA_CLIENT_ID=...
ENTRA_CLIENT_SECRET=...
ENTRA_REDIRECT_URI=https://shuttle.company.com/api/auth/sso/callback
```

`config.auth.ssoConfigured` flips to true once all four are present, and
`GET /api/auth/providers` starts reporting `entra: true`. Both sign-in screens
already read that endpoint and will show the SSO button without a code change.

### 3. Add the two routes

In `apps/backend/src/routes/auth.routes.ts`:

- `GET /auth/sso` — redirect to the Entra authorize endpoint with a signed
  `state` parameter.
- `GET /auth/sso/callback` — verify `state`, exchange the code for an ID token,
  **validate the token's signature against the tenant's JWKS**, then:

```ts
const session = await upsertEntraUser({
  externalId: claims.oid,
  email: claims.preferred_username,
  displayName: claims.name,
});
```

`upsertEntraUser` already exists in `auth.service.ts`. It creates or updates the
user row and returns a normal session — everything downstream is unchanged,
because nothing downstream cares how the user proved who they were.

Validating the ID token signature is the step to not skip. An unverified ID
token is an attacker-supplied JSON document.

### 4. Role assignment

Entra will not know about `driver` and `guard`. `upsertEntraUser` defaults new
users to `employee`. Pick one:

- **Manual promotion.** An admin changes the role. Fine for a handful of drivers.
- **Entra group mapping.** Read group claims and map a company group to a role.
  Preferable at scale; needs the `groups` claim configured on the app
  registration.

Drivers and guards also need an `employees`/`drivers` profile row, which is what
carries the badge number and the shuttle assignment. Creating a user does not
create one.

### 5. Keep local auth for the driver tablets

Consider leaving local auth enabled for `driver` accounts even after SSO lands.
A browser-based OAuth redirect on a vehicle-mounted tablet with intermittent
wifi is a materially worse experience than an email and a password, and the
tablets are physically controlled by the company.

The `users.provider` column already supports both concurrently — the constraint
is that a `local` user has a password hash and an `entra` user has an external
id, so mixing them per account is impossible but mixing them per estate is fine.

## Password rules

Enforced on `POST /auth/password`:

- at least 12 characters
- an upper-case letter, a lower-case letter and a digit

Changing a password revokes every refresh token for that user, so other devices
are signed out. That is the point of changing it.

bcrypt cost is `BCRYPT_ROUNDS`, default 12. Raise it as hardware improves;
existing hashes carry their own cost and keep verifying.

## Audit

Every state change writes to `audit_logs` with the actor, the action, the entity
and a shallow before/after diff. Notably audited: sign-in, password change,
request transitions, assignment, settings changes, and every gate-log
correction or removal — a guard editing a stamped time is exactly the kind of
thing someone may later be asked to account for.

Audit writes never propagate failures. An audit row must not be the reason a
driver cannot complete a trip.

## If you are reviewing this

The things most worth a second look:

- `verifyAccessToken` — algorithm pinning (`services/auth.service.ts`)
- `assertOwnerOrAdmin`, `employeeId`, `driverId` — ownership derived from the
  token (`middleware/auth.ts`)
- `roomsFor` — what each role is allowed to receive (`realtime/io.ts`)
- `transition` — the expected-status guard on the UPDATE
  (`services/requests.service.ts`)
- The partial unique indexes in `database/migrations/001_initial_schema.sql`
