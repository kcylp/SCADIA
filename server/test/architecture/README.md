# The architecture guard (D1) and the storage contract suite (D6/D8)

Machine checks that keep the storage plane swappable.

* **D1** - six classes of architecture guard, 46 checks, about 2 seconds.
* **D2** - the storage capability matrix, 10 checks: one machine source, one human rendering.
* **D4** - the frozen five-domain contract, 11 checks: four domains plus the realtime boundary.
* **D6** - the storage contract suite, one backend-agnostic case set under `test/contract/`.
  It caught two real adapter defects the day it landed (a closed SQL interval, a rejecting lookup).
* **D8** - the suite became multi-backend: the exercised set is DERIVED from the fixture files,
  backend identity comes from the registry instead of a second copy, and an `unproven` adapter
  is still checked structurally and is NOT selectable while it has never run.

Adding a backend therefore means: write its adapter, add one registry entry, add one row of
capability evidence, add one fixture. Enabling it in the field is one settings value.

Together they are 84 checks, and `npm run test:gate` runs them alongside the reporting, i18n,
jobs and branding gates (169 checks in total). `npm run test:architecture:reverse` then injects
21 deliberate violations and demands that each one turns the check that owns it red.

> The consolidated state of the whole storage-plane pass - what is done, what is proven, what is
> pinned, what is decided and what is still open - lives in `21_存储平面状态汇总.md` at the
> project root. Read that first; this file is the detail behind it.

    cd server          # the server/ directory of this checkout
    npx mocha "test/architecture/*.test.js" --timeout 90000      # or: npm run test:architecture
    node test/architecture/_support/reverse-verify.js            # or: npm run test:architecture:reverse

## The six classes

| # | Class | File | What it holds down |
|---|---|---|---|
| 1 | Dependency direction | `dependencyDirection.test.js` | The arrows that must never reverse: runtime never requires api, the storage plane requires nothing but utils, reporting contracts are dependency-free leaves, nothing outside the storage plane opens sqlite3. |
| 2 | Reverse dependency | `reverseDependency.test.js` | The structure that makes class 1 enforceable: no require cycles, the runtime assembler is a root and never a dependency, a domain reaches its own store only from inside itself, and no module is reachable only from a test. |
| 3 | Interface method-set snapshot | `interfaceSnapshot.test.js` + `_support/storage-interface.snapshot.json` | The exact public surface of the storage plane, frozen as data. Three future backends (D8-D10) get written against this shape, so a signature cannot drift while they are being built. Also: no module may export a binding that can only be undefined. |
| 4 | Error semantics | `errorSemantics.test.js` | `querySeries` answers with a status per tag instead of throwing; a limit breach is an explicit status, never a silent truncation; the storage plane never calls `process.exit` and never swallows an error without saying so. |
| 5 | Registry completeness | `registryCompleteness.test.js` | Client and server describe the same set of backends with the same spellings; every backend is named by the routing code or is the one documented default; every backend directory is loaded by the facade; no adapter depends on another. |
| 6 | Cross-domain isolation | `crossDomainIsolation.test.js` | The set of cross-domain dependencies is frozen; no domain reaches into another domain private store; only the facade may name a specific DAQ backend; the server never requires the client. |

## Pinned debt

A guard that is red the day it lands is not a gate, and a guard that ignores what it found is a
lie. So every rule that does NOT hold yet is written down in `_support/known-debt.js` with its
evidence and the deliverable that closes it, and the tests assert the pin itself:

* a NEW violation fails immediately - a pin is an exact set, never a count;
* RETIRING a pin also fails, so a pin cannot quietly outlive the defect it describes.

| ID | Finding | Closes at |
|---|---|---|
| A-01 | `calculator.getSum` exported `this.getSum`, which is `undefined` at module scope. **Fixed in this pass**; the regression is pinned as injection 7. | done |
| A-02 | Client sends `influxDB 1.8`, server knows `influxDB18`, so choosing InfluxDB 1.8 in the UI silently stores to SQLite. | D4 |
| A-03 | An unknown `settings.daqstore.type` degrades to SQLite with no warn, no error, no throw. | D5 |
| A-04 | D7 names six domains; there are eight live direct sqlite3 connections (`apikeys` is not named) plus one dead file. | D7 |
| A-05 | Backend `create()` signatures disagree: 4 arguments for sqlite, 3 for the others. | D5 |
| A-06 | Dead paths: the `QuestDB` branch can never match, and `notifystorage.js` is required by nothing live. | D5 |
| A-07 | `TDengine.create()` reports success for a configuration it cannot use, then fails as an **unhandled rejection** the caller cannot catch. | D5/D9 |
| A-08 | The legacy DAQ read path turns a backend failure into data (`reject([ERR, ...])`), drops the cause and logs nothing. | D5/D7 |

## Reverse verification

`_support/reverse-verify.js` injects one deliberate violation per rule, and demands three things
of each: the class goes red, it goes red on the SPECIFIC check that owns the rule, and after the
source is restored it is green again - proven by re-running the suite, not by assuming.

It also snapshots the whole source tree and heals any drift, because an injection must never be
able to destroy what it is verifying. That is not theoretical: the first version of the scanner
case used `if (true)`, which made a probe write its output to `process.argv[2]` - under mocha that
is the spec path, so the injection overwrote a test file.

## Scanner contract

`scannerContract.test.js` tests the guard own scanner, and enforces the convention that made
this suite safe to ship: **every `.js` under `test/` that is not a `*.test.js` must do nothing
when it is loaded.** The documented full-suite command is

    npx mocha --recursive --timeout 60000 --reporter dot --exit

and `--recursive` loads EVERY `.js` under `test/`, not only `*.test.js`. Helpers that run on
require corrupt that command; one of them once called `process.exit` and silently truncated the
entire repository test run.

## Regenerating the snapshot

    ARCH_SNAPSHOT_UPDATE=1 npx mocha test/architecture/interfaceSnapshot.test.js

It fails on purpose after writing, so the diff has to be looked at before it is committed.
---

# D2 · Storage capability matrix

    cd server          # the server/ directory of this checkout
    npx mocha test/architecture/capabilityMatrix.test.js --timeout 90000

## One source, two renderings

| File | Read by |
|---|---|
| `19_能力矩阵_存储后端.json` (project root) | the machine - it is the single source of truth |
| `19_能力矩阵_存储后端.md` (project root) | the human - a pure function of the JSON, never edited |
| `test/architecture/_support/capability-matrix.js` | the loader and the renderer |
| `test/architecture/_support/capability-probe.js` | the live measurement of the default backend |

The matrix decides what the domain contracts are allowed to require, so it is the one
document that must not contain a guess dressed as a fact. The guard enforces that
structurally:

* **no cell without a verdict** from the closed vocabulary `yes / no / partial / unverified`;
* **no verdict other than `unverified` without evidence** - and the evidence must resolve to a
  file in this repo or to a document on the web, or it is rejected;
* **the driver column is measured** from `package.json` and `node_modules`, never typed;
* **every adapter on disk has a row**, and every row naming an adapter names a file that exists;
* **the default backend is re-probed live** on every run, so its measured cells cannot drift
  away from reality;
* **the human document is regenerated and compared byte for byte** - editing it by hand fails;
* **every open scope question is registered** with an owner, and is never decided here.

## What the matrix already settled

SQLite is the only backend that can be measured on this machine, so it is the only one whose
cells are not `unverified`. Measured against the product own schema, it answers:

| Axis | Verdict |
|---|---|
| durability, atomic-batch, ts-range, ts-aggregate, schema-evolution, embedded-zero-ops, binary-object | `yes` |
| retention | `no` - no TTL construct; the product deletes whole archive files instead |
| concurrent-writers | `no` - a second concurrent writer gets `SQLITE_BUSY` |
| auth-tls | `no` - a local file has no accounts and no transport; access is filesystem permissions |

Those three `no` values are constraints on the contract, not defects: D4 must not require
server-side TTL, multi-process writers, or transport security from the default backend.

Everything else is `unverified` **on purpose**, and closes at **D3**, which reads the real
documentation. Filling those cells before D3 would be inventing facts.

## Raising the matrix to a red state on purpose

Three injections give D2 its own reverse verification: a claim with no evidence, a measured
cell edited to disagree with the live probe, and a hand-edited human document. See
`npm run test:architecture:reverse`.

## Regenerating

    ARCH_MATRIX_UPDATE=1 npx mocha test/architecture/capabilityMatrix.test.js

It writes the document and then fails on purpose, so the diff is reviewed before it is committed.

