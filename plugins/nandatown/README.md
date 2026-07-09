# NANDA Town plugin: `auth: delegatable`

The same bounded-authorization protocol as the HTTP service, implemented
in Python as an auth-layer plugin for
[NANDA Town](https://github.com/projnanda/nandatown) — a test rig that
plugs agent protocols into a 12-layer stack and runs them against
adversarial scenarios with deterministic traces.

Contents (mirrored here for reading; the canonical upstream home is the
NANDA Town repository once merged):

- `auth/delegatable.py` — macaroon-style HMAC-chained tokens:
  `issue / delegate / verify / verify_presented / revoke`, with typed
  exceptions and an injectable logical clock for determinism.
- `validators/delegation_validators.py` — adversarial validators for
  three attacks (scope escalation, verification under a revoked
  ancestor, presentation by a non-audience agent). Against the default
  `jwt` plugin all three fail; against `delegatable` all three pass.
- `scenario/` — the `delegated_auth` scenario (1 coordinator,
  3 intermediaries, 12 leaves) with the three attacks baked in
  deterministically, plus its YAML.
- `tests/` — 14 unit tests, 3 Hypothesis property tests (monotone
  attenuation, cascade-under-random-revocation, byte-determinism), and
  6 validator tests including an end-to-end run of the real scenario
  agents under both auth plugins.

To run inside a NANDA Town checkout, place the files in their package
paths (`nest_plugins_reference/auth/`, `nest_plugins_reference/validators/`,
`nest_core/scenarios_builtin/`, `scenarios/`), register
`("auth", "delegatable")` in `nest_core/plugins.py` and the
`delegated_auth` factory in `nest_core/scenarios.py`, then:

```bash
uv sync && uv run ruff check . && uv run ruff format --check . \
  && uv run pyright && uv run pytest -v
```
