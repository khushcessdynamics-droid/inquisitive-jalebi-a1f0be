# User permission matrix

Generated from the database by `scripts/security-docs.mjs` on 2026-11-03 (migrations up to 20261103000800). These are the **default**
role permissions. An Admin can change a role's permissions or give one person an exception (Users → Permissions), and every change
is recorded in the activity history.

Rules enforced by the database for every request, including direct API calls:
- **Admin** always has every permission. Permissions marked *Admin only* can never be given to another role or person.
- A person's exception (granted or removed) overrides their role. Deactivated accounts have no permissions at all.
- **Admin and Manager must use their authenticator app (MFA)**: without a verified MFA sign-in they get no access.
- **Staff** see only jobs assigned to them or created by them, and payments not at all.

## Jobs

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| View all jobs <br><sub>`jobs.view_all`</sub> | Yes | Yes | — |
| View jobs assigned to me or created by me <br><sub>`jobs.view_assigned`</sub> | Yes | — | Yes |
| Create jobs <br><sub>`jobs.create`</sub> | Yes | Yes | Yes |
| Edit jobs (all fields) <br><sub>`jobs.edit`</sub> | Yes | Yes | — |
| Edit operational fields on my jobs <br><sub>`jobs.edit_assigned`</sub> | Yes | — | Yes |
| Archive jobs <br><sub>`jobs.archive`</sub> | Yes | — | — |
| Cancel jobs <br><sub>`jobs.cancel`</sub> | Yes | Yes | — |
| Change or forward vendor assignment <br><sub>`assignments.change`</sub> | Yes | Yes | — |
| Revise vendor commitment dates <br><sub>`commitments.change`</sub> | Yes | Yes | — |

## Vendors

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| View vendor master <br><sub>`vendors.view`</sub> | Yes | Yes | Yes |
| Add and edit vendors <br><sub>`vendors.manage`</sub> | Yes | Yes | — |
| View vendor reliability scores <br><sub>`reliability.view`</sub> | Yes | Yes | — |
| View vendor cost comparison <br><sub>`costcompare.view`</sub> | Yes | Yes | — |
| Add and edit vendor quotations <br><sub>`quotations.manage`</sub> | Yes | Yes | — |

## Quality

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| Record material returns <br><sub>`returns.record`</sub> | Yes | Yes | — |
| Record quality inspections <br><sub>`quality.manage`</sub> | Yes | Yes | — |

## Payments

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| View payments <br><sub>`payments.view`</sub> | Yes | Yes | — |
| Add payments <br><sub>`payments.add`</sub> | Yes | — | — |
| Adjust, reverse and correct payments <br><sub>`payments.manage`</sub> | Yes | — | — |

## Communication

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| Open WhatsApp messages to vendors <br><sub>`whatsapp.send`</sub> | Yes | Yes | — |

## Attachments

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| Upload attachments <br><sub>`attachments.upload`</sub> | Yes | Yes | Yes |
| Download attachments <br><sub>`attachments.download`</sub> | Yes | Yes | Yes |
| Archive attachments <br><sub>`attachments.archive`</sub> | Yes | — | — |

## Reports

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| View reports and dashboard analytics <br><sub>`reports.view`</sub> | Yes | Yes | — |
| Export reports and data to Excel/PDF <br><sub>`reports.export`</sub> | Yes | Yes | — |

## Admin

| Permission | Admin | Manager | Staff / Operator |
|---|:-:|:-:|:-:|
| View activity and change history <br><sub>`activity.view`</sub> | Yes | — | — |
| Change settings and master lists <br><sub>`settings.change`</sub> | Yes | — | — |
| View system health and backups <br><sub>`system.view`</sub> | Yes | — | — |
| Import data from Excel <br><sub>`data.import`</sub> | Yes | — | — |
| Manage users, roles and permissions *(Admin only)* <br><sub>`users.manage`</sub> | Yes | — | — |
| Run and restore backups *(Admin only)* <br><sub>`backups.manage`</sub> | Yes | — | — |
