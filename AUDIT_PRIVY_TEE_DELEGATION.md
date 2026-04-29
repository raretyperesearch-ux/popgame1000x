# Privy TEE delegation audit (operator runbook)

## Definitive checks

1. **Key quorum exists**
   - Run `python -m backend.scripts.setup_quorum` **once** with production `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, and `PRIVY_AUTH_PRIVATE_KEY` loaded.
   - If `PRIVY_KEY_QUORUM_ID` is already set, the script exits with no-op; treat that ID as source of truth.

2. **Env consistency must be exact string-equality**
   - `PRIVY_KEY_QUORUM_ID` (Railway)
   - `PRIVY_EXPECTED_SIGNER_ID` (Railway)
   - `NEXT_PUBLIC_PRIVY_SIGNER_ID` (Vercel)
   - All three must match the same quorum ID output by setup.

3. **Delegation actually attached to wallet**
   - User clicks **Enable trading**.
   - Confirm `/wallet/status` returns:
     - `delegated: true`
     - `quorum_id == expected_signer` OR `expected_signer` is in `additional`.

## Root cause conclusion

Given the 401 (`No valid authorization keys or user signing keys available`) and the observed `additional_signers` remaining empty, the most likely missing step is **quorum/env mismatch**: the signer ID used by frontend `addSigners` is not the same key-quorum that contains the public key derived from `PRIVY_AUTH_PRIVATE_KEY`.

## One-step fix to unblock

Recreate + align once:

1. Run `python -m backend.scripts.setup_quorum` in backend with prod env.
2. Copy emitted quorum ID into all three env vars above.
3. Redeploy backend and frontend.
4. Have user click **Enable trading** again, then verify `/wallet/status` shows delegated true.

If that still fails with empty `additional_signers`, escalate to Privy support with:
- app ID
- wallet ID
- quorum ID
- timestamped `addSigners` attempt
- `/wallet/status` payload
- exact 401 response body
- request confirmation that app is in **TEE execution mode** and that `addSigners` for that wallet should be headless.
