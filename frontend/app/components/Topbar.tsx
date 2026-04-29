"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import {
  usePrivy,
  useSigners,
  useFundWallet,
  useSendTransaction,
} from "@privy-io/react-auth";
import { encodeFunctionData, isAddress, parseEther, parseUnits } from "viem";
import { base } from "viem/chains";
import { sounds } from "@/lib/sounds";
import { getEmbeddedEthereumAddress } from "@/lib/embedded-wallet";

type WithdrawAsset = "USDC" | "ETH";

interface TopbarProps {
  balance: number;
  ethBalance: number | null;
  balanceLoading?: boolean;
  onHelpClick: () => void;
  onError?: (msg: string) => void;
}

/* The Privy signerId is generated when the authorization key's public PEM
   is registered in the Privy dashboard. It pairs requests from the
   frontend's addSigners() call with the matching backend's
   PRIVY_AUTH_PRIVATE_KEY so server-side trade execution is authorized. */
const PRIVY_SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID || "";
const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export default function Topbar({ balance, ethBalance, balanceLoading = false, onHelpClick, onError }: TopbarProps) {
  const { login, logout, authenticated, user, ready } = usePrivy();
  const { addSigners } = useSigners();
  const { fundWallet } = useFundWallet();
  const { sendTransaction } = useSendTransaction();
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAsset, setWithdrawAsset] = useState<WithdrawAsset>("USDC");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawPending, setWithdrawPending] = useState(false);
  // Set to true after addSigners returns ok in the same session, in
  // case Privy's user.linkedAccounts hasn't refreshed yet — the
  // wallet's `delegated: boolean` field is the OLD delegateAction
  // signal and may not flip for the new useSigners flow.
  const [locallyDelegated, setLocallyDelegated] = useState(false);
  const walletWrapRef = useRef<HTMLDivElement>(null);
  const profileWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMuted(sounds.isMuted()); }, []);
  const onMuteClick = () => {
    const m = sounds.toggleMute();
    setMuted(m);
    if (!m) sounds.play("ui-click");
  };

  /* This is the in-game wallet — always the Privy embedded one, never
     a connected external wallet (Rabby/MetaMask/etc). The embedded
     wallet is what addSigners delegates to, so it's the only wallet
     the backend can sign trades on behalf of. The avatar, balance,
     funding flow, and X-Wallet-Address header all key off this. The
     external login wallet (if any) is just for auth identity. */
  const walletAddress = getEmbeddedEthereumAddress(user);
  const truncated = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;
  const initials = walletAddress
    ? walletAddress.slice(2, 4).toUpperCase()
    : "•";

  useEffect(() => {
    setLocallyDelegated(false);
  }, [walletAddress]);

  /* `delegated: true` is the LEGACY delegateAction flag — it's not set
     by the new useSigners session-signer flow on TEE wallets. We treat
     it as one signal among others: a true value here means definitively
     delegated; a false value is inconclusive, so we fall back to the
     locallyDelegated flag set in onDelegate after a successful
     addSigners call. */
  const linkedSaysDelegated = Boolean(
    user?.linkedAccounts?.some(
      (a) =>
        a.type === "wallet" &&
        "address" in a &&
        a.address === walletAddress &&
        "delegated" in a &&
        (a as unknown as { delegated?: boolean }).delegated === true,
    ),
  );
  const isDelegated = linkedSaysDelegated || locallyDelegated;
  const hasGas = ethBalance === null || ethBalance >= 0.0005;
  const withdrawAmountNumber = Number(withdrawAmount);
  const withdrawAddressValid = withdrawAddress === "" || isAddress(withdrawAddress.trim());
  const withdrawAvailable = withdrawAsset === "USDC" ? balance : ethBalance;
  const withdrawNeedsGas = withdrawAsset === "USDC" && !hasGas;
  const withdrawAmountValid =
    Number.isFinite(withdrawAmountNumber) &&
    withdrawAmountNumber > 0 &&
    (withdrawAvailable === null || withdrawAmountNumber <= withdrawAvailable);
  const withdrawLeavesGas =
    withdrawAsset === "USDC" ||
    ethBalance === null ||
    withdrawAmountNumber < Math.max(0, ethBalance - 0.0002);
  const withdrawReady =
    Boolean(walletAddress) &&
    isAddress(withdrawAddress.trim()) &&
    withdrawAmountValid &&
    withdrawLeavesGas &&
    !withdrawNeedsGas &&
    !withdrawPending;

  /* One-time delegation prompt after login. Fires only when:
     - user is authenticated
     - they have an embedded Ethereum wallet
     - delegation hasn't been granted yet
     - a NEXT_PUBLIC_PRIVY_SIGNER_ID is configured (matches a registered
       authorization key in the Privy dashboard)
     The Privy modal handles consent UX; the user can decline and
     try again later via the menu. */
  useEffect(() => {
    if (!ready || !authenticated || !walletAddress) return;
    if (isDelegated) return;
    if (delegating) return;
    if (!PRIVY_SIGNER_ID) {
      console.warn(
        "[delegate] NEXT_PUBLIC_PRIVY_SIGNER_ID not set — backend cannot sign trades on the user's behalf until this is configured",
      );
      return;
    }
    let cancelled = false;
    setDelegating(true);
    addSigners({
      address: walletAddress,
      signers: [{ signerId: PRIVY_SIGNER_ID, policyIds: [] }],
    })
      .then((result) => {
        console.log("[delegate] addSigners ok. signerId we sent:", PRIVY_SIGNER_ID, "result:", result);
        setLocallyDelegated(true);
      })
      .catch((e) => console.warn("[delegate] declined or failed:", e))
      .finally(() => {
        if (!cancelled) setDelegating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, walletAddress, isDelegated, addSigners, delegating]);

  useEffect(() => {
    if (!walletMenuOpen && !profileMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (walletWrapRef.current && !walletWrapRef.current.contains(target)) {
        setWalletMenuOpen(false);
      }
      if (profileWrapRef.current && !profileWrapRef.current.contains(target)) {
        setProfileMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWalletMenuOpen(false);
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [walletMenuOpen, profileMenuOpen]);

  const onDelegate = async () => {
    if (!walletAddress) {
      onError?.("Embedded wallet hasn't loaded yet. Wait a sec and retry.");
      return;
    }
    if (!PRIVY_SIGNER_ID) {
      onError?.(
        "Server signer ID not configured. NEXT_PUBLIC_PRIVY_SIGNER_ID is missing on Vercel.",
      );
      return;
    }
    setProfileMenuOpen(false);
    setDelegating(true);
    try {
      // addSigners is headless for TEE wallets — it shouldn't open a
      // popup. If it hangs past 15s, something's wrong (signerId not
      // recognized server-side, wallet proxy not initialized, etc.) —
      // race against a timeout so the UI can't get stuck on "waiting".
      const result = await Promise.race([
        addSigners({
          address: walletAddress,
          // policyIds: [] is explicit per Privy docs — opts out of any
          // mandatory policy enforcement that might otherwise reject
          // the call when the dashboard quorum has none configured.
          signers: [{ signerId: PRIVY_SIGNER_ID, policyIds: [] }],
        }),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error("addSigners timed out after 15s — Privy didn't respond. If your app isn't on TEE execution mode, addSigners needs UI it never opens. Migrate to TEE in Privy dashboard -> Wallets -> Advanced.")),
            15000,
          ),
        ),
      ]);
      // Dump the result so we can verify in DevTools console exactly
      // which signer Privy registered. Pinpoints SIGNER_ID env mismatch
      // vs other failure modes from one click.
      console.log("[delegate] addSigners ok. signerId we sent:", PRIVY_SIGNER_ID, "result:", result);
      setLocallyDelegated(true);
      onError?.(`Trading delegated. Signer: ${PRIVY_SIGNER_ID.slice(0, 8)}…`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[delegate] failed:", e);
      onError?.(`Couldn't enable trading: ${msg}`);
    } finally {
      setDelegating(false);
    }
  };

  const copyAddress = async () => {
    if (!walletAddress) return;
    try { await navigator.clipboard.writeText(walletAddress); } catch { /* noop */ }
    setProfileMenuOpen(false);
  };

  const onFundUSDC = () => {
    if (!walletAddress) return;
    setWalletMenuOpen(false);
    fundWallet({
      address: walletAddress,
      options: {
        chain: base,
        asset: "USDC",
        amount: "5",
        card: { preferredProvider: "coinbase" },
      },
    }).catch((e) => console.warn("[fund] USDC fund flow declined:", e));
  };

  const onFundETH = () => {
    if (!walletAddress) return;
    setWalletMenuOpen(false);
    fundWallet({
      address: walletAddress,
      options: {
        chain: base,
        asset: "native-currency",
        amount: "0.001",
        card: { preferredProvider: "coinbase" },
      },
    }).catch((e) => console.warn("[fund] ETH fund flow declined:", e));
  };

  const openWithdraw = (asset: WithdrawAsset) => {
    setWithdrawAsset(asset);
    setWithdrawOpen(true);
  };

  const setMaxWithdraw = () => {
    if (withdrawAsset === "USDC") {
      setWithdrawAmount(Math.max(0, balance).toFixed(2));
      return;
    }
    if (ethBalance === null) return;
    const maxEth = Math.max(0, ethBalance - 0.0002);
    setWithdrawAmount(maxEth.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
  };

  const submitWithdraw = async () => {
    if (!withdrawReady || !walletAddress) return;
    const recipient = withdrawAddress.trim();
    const recipientAddress = recipient as `0x${string}`;
    const amount = withdrawAmount.trim();
    setWithdrawPending(true);
    try {
      const tx =
        withdrawAsset === "USDC"
          ? {
              to: USDC_BASE_ADDRESS,
              chainId: base.id,
              data: encodeFunctionData({
                abi: USDC_TRANSFER_ABI,
                functionName: "transfer",
                args: [recipientAddress, parseUnits(amount, 6)],
              }),
              value: "0",
            }
          : {
              to: recipientAddress,
              chainId: base.id,
              value: parseEther(amount),
            };
      const hash = await sendTransaction(tx, {
        address: walletAddress,
        uiOptions: {
          description: `Withdraw ${amount} ${withdrawAsset} to ${recipient.slice(0, 6)}...${recipient.slice(-4)}.`,
          buttonText: `Withdraw ${withdrawAsset}`,
          successHeader: "Withdrawal sent",
          successDescription: `Your ${withdrawAsset} transfer was submitted on Base.`,
        },
      });
      onError?.(`${withdrawAsset} withdrawal sent: ${hash.hash.slice(0, 10)}...`);
      setWithdrawOpen(false);
      setWithdrawAmount("");
      setWithdrawAddress("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[withdraw] ${withdrawAsset} failed:`, e);
      onError?.(`${withdrawAsset} withdrawal failed: ${msg.slice(0, 180)}`);
    } finally {
      setWithdrawPending(false);
    }
  };

  const withdrawHint = (() => {
    if (withdrawNeedsGas) return "Add a little ETH first so the USDC transfer can pay Base gas.";
    if (withdrawAddress && !withdrawAddressValid) return "Enter a valid Base / EVM wallet address.";
    if (withdrawAmount && !withdrawAmountValid) return `Amount must be between 0 and ${withdrawAvailable ?? 0} ${withdrawAsset}.`;
    if (!withdrawLeavesGas) return "Leave at least 0.0002 ETH for future gas.";
    return withdrawAsset === "USDC"
      ? "USDC withdraws need ETH gas in this same wallet."
      : "ETH withdraws are native Base transfers.";
  })();

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand" aria-label="Scalprunner">
          <Image
            src="/assets/scalprunner-logo.png"
            alt="Scalprunner"
            width={900}
            height={409}
            priority
          />
        </div>
        <button className="help-btn" onClick={() => { sounds.play("ui-click"); onHelpClick(); }} aria-label="Help">?</button>
        <button className="mute-btn" onClick={onMuteClick} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
          {muted ? "🔇" : "🔊"}
        </button>
      </div>
      <div className="topbar-right">
        {!authenticated ? (
          <button className="deposit-btn" onClick={() => { sounds.play("ui-click"); login(); }}>
            <span>deposit to play</span>
            <span className="deposit-arrow" aria-hidden="true">›</span>
          </button>
        ) : (
          <>
            <div className="wallet-wrap" ref={walletWrapRef}>
              <button
                className="balance-pill wallet-trigger"
                title="Wallet balance"
                aria-label="Wallet actions"
                aria-expanded={walletMenuOpen}
                onClick={() => {
                  sounds.play("ui-click");
                  setWalletMenuOpen((v) => !v);
                  setProfileMenuOpen(false);
                }}
              >
                <span className="balance-icon" aria-hidden="true" />
                <span>{balanceLoading ? "syncing…" : `$${balance.toFixed(2)}`}</span>
              </button>
              {walletMenuOpen && (
                <div className="user-menu wallet-menu" role="menu">
                  <div className="user-menu-header">
                    <div className="user-menu-label">wallet balance</div>
                    <div className="wallet-menu-balances">
                      <span>{balanceLoading ? "syncing USDC" : `${balance.toFixed(2)} USDC`}</span>
                      <span>{ethBalance === null ? "gas checking..." : `${ethBalance.toFixed(5)} ETH`}</span>
                    </div>
                    <div className={`user-menu-tag ${hasGas ? "ok" : "warn"}`}>
                      {hasGas ? "gas ready" : "needs ETH gas"}
                    </div>
                  </div>
                  <div className="user-menu-section">
                    <div className="user-menu-section-title">
                      <span className="section-arrow" aria-hidden="true">↓</span>
                      deposit
                    </div>
                    <button
                      className="wallet-action"
                      role="menuitem"
                      onClick={() => { sounds.play("ui-click"); onFundUSDC(); }}
                    >
                      <span className="wallet-action-arrow" aria-hidden="true">↓</span>
                      <span className="wallet-action-text">
                        <span className="wallet-action-title">fund USDC</span>
                        <span className="wallet-action-sub">collateral</span>
                      </span>
                    </button>
                    <button
                      className="wallet-action"
                      role="menuitem"
                      onClick={() => { sounds.play("ui-click"); onFundETH(); }}
                    >
                      <span className="wallet-action-arrow" aria-hidden="true">↓</span>
                      <span className="wallet-action-text">
                        <span className="wallet-action-title">fund ETH</span>
                        <span className="wallet-action-sub">gas</span>
                      </span>
                    </button>
                  </div>
                  <div className="user-menu-section">
                    <div className="user-menu-section-title">
                      <span className="section-arrow" aria-hidden="true">↑</span>
                      withdraw
                    </div>
                    <div className="withdraw-tabs" role="group" aria-label="Withdraw asset">
                      {(["USDC", "ETH"] as const).map((asset) => (
                        <button
                          key={asset}
                          type="button"
                          className={`withdraw-tab ${withdrawAsset === asset ? "active" : ""}`}
                          onClick={() => { sounds.play("ui-click"); openWithdraw(asset); }}
                        >
                          {asset}
                        </button>
                      ))}
                    </div>
                    {withdrawOpen && (
                      <div className="withdraw-panel">
                        <label className="withdraw-field">
                          <span>send to</span>
                          <input
                            value={withdrawAddress}
                            onChange={(e) => setWithdrawAddress(e.target.value)}
                            placeholder="0x..."
                            spellCheck={false}
                          />
                        </label>
                        <label className="withdraw-field">
                          <span>amount</span>
                          <div className="withdraw-amount-row">
                            <input
                              value={withdrawAmount}
                              onChange={(e) => setWithdrawAmount(e.target.value)}
                              placeholder="0.00"
                              inputMode="decimal"
                            />
                            <button type="button" onClick={setMaxWithdraw}>max</button>
                          </div>
                        </label>
                        <div className={`withdraw-hint ${withdrawReady ? "ok" : "warn"}`}>{withdrawHint}</div>
                        <button
                          type="button"
                          className="user-menu-item primary withdraw-submit"
                          disabled={!withdrawReady}
                          onClick={() => { sounds.play("ui-click"); submitWithdraw(); }}
                        >
                          {withdrawPending ? "confirming..." : `withdraw ${withdrawAsset}`}
                        </button>
                      </div>
                    )}
                    {!withdrawOpen && (
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { sounds.play("ui-click"); openWithdraw("USDC"); }}
                      >
                        open withdraw panel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div
              className={`gas-pill ${hasGas ? "ok" : "warn"}`}
              title={ethBalance === null ? "ETH gas balance loading" : `${ethBalance.toFixed(6)} ETH on Base for gas`}
            >
              <span className="gas-dot" aria-hidden="true" />
              <span>{ethBalance === null ? "gas…" : hasGas ? "gas ok" : "needs gas"}</span>
            </div>
            <div className="user-wrap" ref={profileWrapRef}>
              <button
                className="avatar-btn"
                onClick={() => {
                  sounds.play("ui-click");
                  setProfileMenuOpen((v) => !v);
                  setWalletMenuOpen(false);
                }}
                aria-label="Account"
                aria-expanded={profileMenuOpen}
              >
                {initials}
              </button>
              {profileMenuOpen && (
                <div className="user-menu" role="menu">
                  <div className="user-menu-header">
                    <div className="user-menu-label">wallet</div>
                    <div className="user-menu-addr">{truncated}</div>
                    <div className={`user-menu-tag ${hasGas ? "ok" : "warn"}`}>
                      {ethBalance === null
                        ? "gas checking…"
                        : hasGas
                          ? `${ethBalance.toFixed(5)} ETH gas`
                          : "needs ETH gas"}
                    </div>
                    <div className={`user-menu-tag ${isDelegated ? "ok" : "warn"}`}>
                      {isDelegated ? "trading delegated ✓" : "delegation pending"}
                    </div>
                  </div>
                  {!isDelegated && (
                    <button
                      className="user-menu-item primary"
                      role="menuitem"
                      onClick={() => { sounds.play("ui-click"); onDelegate(); }}
                      disabled={delegating}
                    >
                      {delegating ? "waiting for popup…" : "enable trading"}
                    </button>
                  )}
                  <button className="user-menu-item" role="menuitem" onClick={() => { sounds.play("ui-click"); copyAddress(); }}>
                    copy address
                  </button>
                  <button
                    className="user-menu-item danger"
                    role="menuitem"
                    onClick={() => { sounds.play("ui-click"); setProfileMenuOpen(false); logout(); }}
                  >
                    disconnect
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
