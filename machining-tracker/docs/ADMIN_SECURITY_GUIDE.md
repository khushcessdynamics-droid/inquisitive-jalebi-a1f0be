# Admin security guide

For the people with the **Admin** role. Who may do what: `docs/PERMISSION_MATRIX.md`. What to do in an emergency: `docs/DISASTER_RECOVERY.md`.

## Your own accounts

- Use a long, unique password (at least 12 characters with upper and lower case letters and digits; the app enforces this) and an
  authenticator app on your phone (Google Authenticator, Microsoft Authenticator or similar). Admin and Manager cannot work without it.
- **Keep two Admins.** The app never lets the last active Admin be deactivated or demoted, but if the only Admin loses their phone,
  recovery needs the Supabase dashboard.
- Protect the accounts behind the app with two-step sign-in as well: **Supabase** (owns the database), **Cloudflare** (the website),
  **GitHub** (the code). Whoever controls the Supabase account controls all data.
- Never send the database password, the Supabase secret key or access tokens to anyone. They belong only in the backup tool's
  `backup.json` on the backup PC and, if you use it, in GitHub's encrypted Actions secrets. The website needs only the public URL and
  the publishable key.

## Managing people

| Task | Where | Notes |
|---|---|---|
| Add a person | **Users → Invite user** → choose the role → **Copy link** | Send the link yourself (WhatsApp or email). It works once. The person sets their own password; Admin and Manager then set up an authenticator |
| Change a role | Users → the person → **Edit name / role** | Takes effect on their next action. Recorded in the activity history |
| Give or remove one permission for one person | Users → the person → **Permission exceptions** | Needs a reason. Admin-only permissions cannot be given to anyone else |
| Someone leaves or must stop at once | Users → the person → **Deactivate** | Works immediately, even if they are signed in at that moment. Their records and history stay |
| Sign someone out everywhere (e.g. a shared computer) | Users → the person → **End all sessions** | They can sign in again normally |
| Forgotten password | Users → the person → **Password reset link** → **Copy link** | Or they use "Forgot password" on the sign-in page |
| Lost or replaced phone (authenticator) | Users → the person → **Reset authenticator** → reason → confirm | First confirm who is asking (call them). Their authenticator is removed and they are signed out everywhere; at their next sign-in they set up a new one (mandatory for Admin and Manager). Recorded in the activity history. An Admin cannot reset their own: another Admin does it |

**The last Admin lost their own phone** (no other Admin to press the button): Supabase dashboard → **SQL Editor**, run this with
your email, then sign in and set up the new authenticator. Afterwards, invite a second Admin.

```sql
delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'your.name@cess.co.in');
```

## Settings that protect the system (Settings page)

| Setting | Default | Meaning |
|---|---|---|
| Idle timeout | 30 minutes | A signed-in person who does nothing for this long must sign in again |
| Longest session | 12 hours | Everyone signs in again at least twice a day |
| Reminders, WhatsApp templates, weekly report | — | Business settings; every change is recorded |

## What to check regularly

| How often | What |
|---|---|
| Weekly | **Activity History**: payment reversals, deactivations, permission changes and settings changes. Each shows who, when and why |
| Weekly | **System Health**: the date of the last **verified** backup (should be yesterday or today) |
| Monthly | **Users**: everyone listed still works at CESS and has the right role; Admin and Manager show MFA **On** |
| Monthly | The USB backup copy is current; the backup key has a second copy in a safe place |
| Quarterly | Restore drill (`docs/DISASTER_RECOVERY.md`, "Practising") |
| When GitHub shows a security alert or CI fails on `npm audit` | Read `docs/DEPENDENCY_VULNERABILITIES.md` and update the affected package |

## Rules the system enforces for you

- Payments, adjustments, commitment revisions and the activity history **cannot be edited or deleted** by anyone through the app or
  the API. Mistakes are corrected with a **reversal** or **void** that needs a reason, so the original and the correction both stay.
- Two people editing the same record at the same time cannot overwrite each other. The second person sees "Changed by someone
  else" in the edit window as soon as the first one saves, keeps what they typed, and their save is refused, so they reopen the
  window to see the latest version (tested in the browser with two tabs).
- Staff see only jobs assigned to them or created by them, never payments, and cannot open Admin pages or call Admin functions
  directly.
- Error messages never show internal database details; they show a short message and an error code you can pass on.
- Uploaded files are private. Download links are created for one signed-in person and expire after 60 seconds.

## If something looks wrong

1. **Deactivate** the account involved (if it is a person's account).
2. Look at **Activity History** for that person and time.
3. If a secret may have leaked or data was damaged, follow `docs/DISASTER_RECOVERY.md` (scenarios 2, 8 and 9).
4. Keep a note of what happened and what you did.
