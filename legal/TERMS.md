# Terms of Service — DRAFT / NOT LEGAL ADVICE

> **DRAFT.** Reviewed by no attorney. Do NOT publish without legal review.
> The bullet structure is intended to surface the topics a leveraged
> perps product must cover; the language is placeholder.

_Last updated: [DATE]_

## 1. Acceptance

By accessing or using [Service Name] (the "Service"), you agree to these
Terms. If you do not agree, do not use the Service.

## 2. Description

The Service is an interface to perpetual futures contracts on Avantis
(deployed on Base). When you "jump", you open a leveraged long position
on ETH/USD. When you "pull chute" or are liquidated, the position
closes. The Service does not custody your funds — your embedded wallet
(provisioned via Privy) holds USDC and signs transactions through a
delegated signer the operator controls only for the purpose of executing
trades you initiate.

## 3. Eligibility

You represent that:
- You are at least 18 (or the age of majority in your jurisdiction).
- You are not a resident or citizen of, or located in, [LIST RESTRICTED
  JURISDICTIONS — typically includes US, UK, sanctioned countries; consult
  counsel].
- You are not a Specially Designated National or otherwise on a sanctions
  list.
- You are not using the Service on behalf of any person who fails any of
  the above.

## 4. Risks (READ CAREFULLY)

- **Leverage amplifies losses.** At 500× leverage, a 0.2% adverse move
  in the ETH price liquidates your position and you lose your entire
  wager.
- **You may lose all funds wagered.** This is not a savings product, an
  investment, or a yield product.
- **Smart contract risk.** Avantis, Base, USDC, and all underlying
  protocols carry smart contract risk. Bugs, exploits, or governance
  actions can result in partial or total loss.
- **Oracle risk.** Prices are sourced from Pyth/Avantis. Oracle outages
  or manipulation can cause unexpected liquidations or PnL swings.
- **No advice.** Nothing on the Service is investment, financial, legal,
  or tax advice. Decisions to wager are solely yours.

## 5. Fees

- **House fee:** 0.8% of each wager, deducted at open and transferred to
  the operator's treasury wallet.
- **Avantis fee:** 2.5% of profits on closed-in-profit positions, paid
  to Avantis.
- **Gas:** You pay gas in ETH on Base for every transaction.

Fees may change with notice.

## 6. No Custody

The operator does not custody your funds. Your USDC and ETH live in your
embedded wallet (provisioned by Privy). The operator has limited
delegated signing authority that you grant when you first connect; that
authority is scoped to executing trades on Avantis and collecting the
house fee. You can revoke it via Privy at any time.

## 7. Operator Discretion

The operator may:
- Restrict access from certain jurisdictions or addresses.
- Pause the Service for maintenance, security, or compliance.
- Update these Terms; continued use after an update is acceptance.

## 8. Disclaimers

The Service is provided "AS IS" without warranties of any kind. The
operator does not warrant uptime, accuracy of price feeds, or the
performance of any underlying protocol.

## 9. Limitation of Liability

To the fullest extent permitted by law, the operator's aggregate
liability is limited to fees actually collected from you in the 30 days
preceding the claim.

## 10. Indemnification

You agree to indemnify the operator for any third-party claim arising
from your use of the Service or violation of these Terms.

## 11. Dispute Resolution

[ARBITRATION CLAUSE / GOVERNING LAW — get this drafted by counsel.
Common: binding arbitration, class action waiver, governing law of
operator's jurisdiction.]

## 12. Contact

[contact@yourdomain]
