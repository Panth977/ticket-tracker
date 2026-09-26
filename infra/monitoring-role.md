# The one grant the cost panel needs

`Account › Usage` (agents.html §X) reads this project's own usage from the
**Cloud Monitoring API** with the functions' own service account. That account
can write metrics by default; it **cannot read them**. Until this grant exists
the panel answers, politely, "not granted yet" and shows the command below —
it never errors, and nothing else in the app is affected.

## The command

```sh
PROJECT=<your-project-id>

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$PROJECT@appspot.gserviceaccount.com" \
  --role="roles/monitoring.viewer"
```

`roles/monitoring.viewer` is **read-only** — it grants `monitoring.timeSeries.list`
and nothing that can change, delete or spend anything.

### If the functions run as a different service account

2nd-gen functions use the App Engine default service account
(`PROJECT@appspot.gserviceaccount.com`) unless `serviceAccount` was set at
deploy time. Check what is actually running, then grant to that:

```sh
gcloud run services describe api --region=asia-south1 \
  --format='value(spec.template.spec.serviceAccountName)'
```

### From the console instead

IAM & Admin → IAM → find the service account → Edit → Add another role →
**Monitoring Viewer** → Save. It takes a minute or two to propagate; the panel
picks it up on its next refresh (`?refresh=1` on the usage route, or the
"Refresh" button, forces one).

## Why it costs nothing

- Reading time series is **free** at this volume: nine `timeSeries.list` calls,
  at most once an hour, well inside the free tier of the Monitoring API.
- The answer is cached in Firestore (`_config/usage`) for an hour, so opening
  the panel costs **one document read**.
- No billing export, no BigQuery dataset, no log sink, no alerting policy —
  all of those cost money to keep, and none is needed to answer "what am I
  spending this month?".

## What is read

Nine counters, hour by hour, for the current billing month:

| Counter | Metric type |
| --- | --- |
| Firestore reads | `firestore.googleapis.com/document/read_count` |
| Firestore writes | `firestore.googleapis.com/document/write_count` |
| Firestore deletes | `firestore.googleapis.com/document/delete_count` |
| Function invocations | `run.googleapis.com/request_count` |
| vCPU-seconds | `run.googleapis.com/container/cpu/allocation_time` |
| Memory GiB-seconds | `run.googleapis.com/container/memory/allocation_time` |
| RTDB bandwidth out | `firebasedatabase.googleapis.com/network/sent_bytes_count` |
| Storage downloads | `storage.googleapis.com/network/sent_bytes_count` |
| Hosting transfer | `firebasehosting.googleapis.com/network/sent_bytes_count` |

A 2nd-gen Cloud Function **is** a Cloud Run service, which is why the function
metrics live under `run.*`. A metric with no time series (a service nobody has
used, or a name Google has moved) contributes zeros: the row shows nothing
rather than the panel failing.

Stored bytes — Firestore, RTDB, Storage, Hosting — are deliberately **not**
read. At this app's size they sit inside the free tier, and their metric names
are the least stable part of this surface; a wrong number would be worse than
an absent one. The panel says so.

## It is an estimate

Prices are typed by hand into `shared/src/api/usage.ts` (`PRICES_USD`, dated by
`PRICES_ASOF`) with a fixed ₹/$ rate. Taxes, credits, committed spend and
stored data are not modelled. Use the panel to notice a change of *shape* —
"something started doing 300k reads a day" — and the Firebase console when you
want the number you will actually pay.
