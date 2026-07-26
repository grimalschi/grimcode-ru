# app

The interface behind sign-in, served under `/app/`.

It has **no database**. Identity and sessions come from Auth, the product profile from Users. Its
server does one thing — serve the built SPA — because every protected call the application makes is
checked by the service that owns the data, not here.

## What is public and what is not

Reachable without a session:

| | |
| --- | --- |
| `/app/register` | Create an account |
| `/app/login` | Sign in |
| `/app/reset-password` | Ask for a recovery link |
| `/app/reset-password/confirm` | Choose a new password from that link |
| `/app/verify-email` | Confirm an address from its link |

Everything else — the dashboard, onboarding and settings — needs one.

## The guard

Before a protected screen renders, the application asks Auth who the caller is. Until that answer
arrives, nothing protected is drawn: an anonymous deep link never flashes the interface it is not
allowed to see, it goes to the sign-in page.

This is for the flow, not for safety. Auth, Users and every other service check the session again on
each protected endpoint, so a revoked session fails there regardless of what the browser still
believes.

## The return path

The page someone was trying to open is remembered so they land on it after signing in — but only if
it is an internal route of this application. An absolute URL, a protocol-relative one (`//host`), a
backslash trick, anything outside `/app/`, and the auth screens themselves are all dropped.

A sign-in page that accepted an arbitrary redirect would be an open redirect wearing this
product's name. See [`return-path.ts`](web/src/return-path.ts).

## One settings screen

There is no separate Profile, Settings and Account. Three top-level destinations only make a person
guess which of them holds what they came for. There is one screen with sections, split by who owns
the data:

- **Profile** — display name, language, email preferences. Owned by Users.
- **Account** — the sign-in address, its confirmation, changing it. Owned by Auth.
- **Security** — password, and every browser holding a session. Owned by Auth.

Onboarding stays a separate flow, because it has its own completion state that the rest of the
product reads.

## Signing out

A server operation: Auth invalidates the session, then the server clears the cookie. Deleting the
cookie in the browser alone would leave a usable session behind.

## Surfaces

| Mount | Reachable as |
| --- | --- |
| `/app/**` | public — the built application; the screens inside it guard themselves |

The application calls `/service/auth` and `/service/users` through Gateway, with the session cookie
the browser attaches. It never sees the cookie's contents and does not know its format.

## Commands

```bash
pnpm --filter @template/app dev:web
```
