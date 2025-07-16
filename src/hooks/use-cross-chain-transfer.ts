import { useState } from "react";
import {
  createWalletClient,
  http,
  encodeFunctionData,
  type Chain,
  type Account,
  type WalletClient,
  type Hex,
  TransactionExecutionError,
  parseUnits,
  createPublicClient,
  formatUnits,
  parseEther,
  type HttpTransport,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import axios from "axios";
import {
  sepolia,
  avalancheFuji,
  baseSepolia,
  sonicBlazeTestnet,
  lineaSepolia,
  arbitrumSepolia,
  worldchainSepolia,
  optimismSepolia,
  unichainSepolia,
  polygonAmoy,
} from "viem/chains";
import { defineChain } from "viem";
// Solana imports
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import bs58 from "bs58";
import { hexlify } from "ethers";
// Import BN at top level like Circle's examples
import { BN } from "@coral-xyz/anchor";
import * as buffer from 'buffer';
const Buffer = buffer.Buffer;
// @ts-ignore
import {
  SupportedChainId,
  CHAIN_IDS_TO_USDC_ADDRESSES,
  CHAIN_IDS_TO_TOKEN_MESSENGER,
  CHAIN_IDS_TO_MESSAGE_TRANSMITTER,
  DESTINATION_DOMAINS,
  CHAIN_TO_CHAIN_NAME,
  SOLANA_RPC_ENDPOINT,
  IRIS_API_URL,
} from "../lib/chains";
import { getBytes } from "ethers";
import { SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Custom Codex chain definition with Thirdweb RPC
const codexTestnet = defineChain({
  id: 812242,
  name: "Codex Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "Codex",
    symbol: "CDX",
  },
  rpcUrls: {
    default: {
      http: ["https://812242.rpc.thirdweb.com"],
    },
  },
  blockExplorers: {
    default: {
      name: "Codex Explorer",
      url: "https://explorer.codex-stg.xyz/",
    },
  },
  testnet: true,
});

export type TransferStep =
  | "idle"
  | "approving"
  | "burning"
  | "waiting-attestation"
  | "minting"
  | "completed"
  | "error";

const chains = {
  [SupportedChainId.ETH_SEPOLIA]: sepolia,
  [SupportedChainId.AVAX_FUJI]: avalancheFuji,
  [SupportedChainId.BASE_SEPOLIA]: baseSepolia,
  [SupportedChainId.SONIC_BLAZE]: sonicBlazeTestnet,
  [SupportedChainId.LINEA_SEPOLIA]: lineaSepolia,
  [SupportedChainId.ARBITRUM_SEPOLIA]: arbitrumSepolia,
  [SupportedChainId.WORLDCHAIN_SEPOLIA]: worldchainSepolia,
  [SupportedChainId.OPTIMISM_SEPOLIA]: optimismSepolia,
  [SupportedChainId.CODEX_TESTNET]: codexTestnet,
  [SupportedChainId.UNICHAIN_SEPOLIA]: unichainSepolia,
  [SupportedChainId.POLYGON_AMOY]: polygonAmoy,
};

// Solana RPC endpoint imported from chains.ts

export function useCrossChainTransfer() {
  const [currentStep, setCurrentStep] = useState<TransferStep>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const DEFAULT_DECIMALS = 6;

  const addLog = (message: string) =>
    setLogs((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] ${message}`,
    ]);

  // Utility function to check if a chain is Solana
  const isSolanaChain = (chainId: number): boolean => {
    return chainId === SupportedChainId.SOLANA_DEVNET;
  };

  // Utility function to create Solana keypair from private key
  const getSolanaKeypair = (privateKey: string): Keypair => {
    try {
      // Try to decode as base58 first (standard Solana format)
      const privateKeyBytes = bs58.decode(privateKey);
      if (privateKeyBytes.length === 64) {
        // This is a 64-byte secret key (32 bytes seed + 32 bytes public key)
        return Keypair.fromSecretKey(privateKeyBytes);
      } else if (privateKeyBytes.length === 32) {
        // This is a 32-byte seed
        return Keypair.fromSeed(privateKeyBytes);
      }
    } catch (error) {
      // If base58 decode fails, try hex format (fallback)
      const cleanPrivateKey = privateKey.replace(/^0x/, "");
      if (cleanPrivateKey.length === 64) {
        // Convert hex to Uint8Array (32 bytes for ed25519 seed)
        const privateKeyBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          privateKeyBytes[i] = parseInt(cleanPrivateKey.substr(i * 2, 2), 16);
        }
        return Keypair.fromSeed(privateKeyBytes);
      }
    }

    throw new Error(
      "Invalid Solana private key format. Expected base58 encoded key or 32-byte hex string.",
    );
  };

  // Utility function to get the appropriate private key for a chain
  const getPrivateKeyForChain = (chainId: number): string => {
    if (isSolanaChain(chainId)) {
      const solanaKey = import.meta.env.VITE_PUBLIC_SOLANA_PRIVATE_KEY;
      if (!solanaKey) {
        throw new Error(
          "Solana private key not found. Please set VITE_PUBLIC_SOLANA_PRIVATE_KEY in your environment.",
        );
      }
      return solanaKey;
    } else {
      const evmKey =
        import.meta.env.VITE_PUBLIC_EVM_PRIVATE_KEY ||
        import.meta.env.VITE_PUBLIC_PRIVATE_KEY;
      if (!evmKey) {
        throw new Error(
          "EVM private key not found. Please set VITE_PUBLIC_EVM_PRIVATE_KEY in your environment.",
        );
      }
      return evmKey;
    }
  };

  // Solana connection
  const getSolanaConnection = (): Connection => {
    return new Connection(SOLANA_RPC_ENDPOINT, "confirmed");
  };

  const getPublicClient = (chainId: SupportedChainId) => {
    if (isSolanaChain(chainId)) {
      return getSolanaConnection();
    }
    return createPublicClient({
      chain: chains[chainId as keyof typeof chains],
      transport: http(),
    });
  };

  const getClients = (chainId: SupportedChainId) => {
    const privateKey = getPrivateKeyForChain(chainId);

    if (isSolanaChain(chainId)) {
      return getSolanaKeypair(privateKey);
    }
    const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`, {
      nonceManager,
    });
    return createWalletClient({
      chain: chains[chainId as keyof typeof chains],
      transport: http(),
      account,
    });
  };

  const getBalance = async (chainId: SupportedChainId) => {
    if (isSolanaChain(chainId)) {
      return getSolanaBalance(chainId);
    }
    return getEVMBalance(chainId);
  };

  const getSolanaBalance = async (chainId: SupportedChainId) => {
    const connection = getSolanaConnection();
    const privateKey = getPrivateKeyForChain(chainId);
    const keypair = getSolanaKeypair(privateKey);
    const usdcMint = new PublicKey(
      CHAIN_IDS_TO_USDC_ADDRESSES[chainId] as string,
    );

    try {
      const associatedTokenAddress = await getAssociatedTokenAddress(
        usdcMint,
        keypair.publicKey,
      );

      const tokenAccount = await getAccount(connection, associatedTokenAddress);
      const balance =
        Number(tokenAccount.amount) / Math.pow(10, DEFAULT_DECIMALS);
      return balance.toString();
    } catch (error) {
      if (
        error instanceof TokenAccountNotFoundError ||
        error instanceof TokenInvalidAccountOwnerError
      ) {
        return "0";
      }
      throw error;
    }
  };

  const getEVMBalance = async (chainId: SupportedChainId) => {
    const publicClient = createPublicClient({
      chain: chains[chainId as keyof typeof chains],
      transport: http(),
    });
    const privateKey = getPrivateKeyForChain(chainId);
    const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`, {
      nonceManager,
    });

    const balance = await publicClient.readContract({
      address: CHAIN_IDS_TO_USDC_ADDRESSES[chainId] as `0x${string}`,
      abi: [
        {
          constant: true,
          inputs: [{ name: "_owner", type: "address" }],
          name: "balanceOf",
          outputs: [{ name: "balance", type: "uint256" }],
          payable: false,
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "balanceOf",
      args: [account.address],
    });

    const formattedBalance = formatUnits(balance, DEFAULT_DECIMALS);
    return formattedBalance;
  };

  // EVM functions (existing)
  const approveUSDC = async (
    client: WalletClient<HttpTransport, Chain, Account>,
    sourceChainId: number,
  ) => {
    setCurrentStep("approving");
    addLog("Approving USDC transfer...");

    try {
      const tx = await client.sendTransaction({
        to: CHAIN_IDS_TO_USDC_ADDRESSES[sourceChainId] as `0x${string}`,
        data: encodeFunctionData({
          abi: [
            {
              type: "function",
              name: "approve",
              stateMutability: "nonpayable",
              inputs: [
                { name: "spender", type: "address" },
                { name: "amount", type: "uint256" },
              ],
              outputs: [{ name: "", type: "bool" }],
            },
          ],
          functionName: "approve",
          args: [
            CHAIN_IDS_TO_TOKEN_MESSENGER[sourceChainId] as `0x${string}`,
            10000000000n,
          ],
        }),
        account: client.account,
      });

      addLog(`USDC Approval Tx: ${tx}`);
      return tx;
    } catch (err) {
      setError("Approval failed");
      throw err;
    }
  };

  // Solana approve function (Note: SPL tokens don't require explicit approval like ERC20)
  const approveSolanaUSDC = async (keypair: Keypair, sourceChainId: number) => {
    setCurrentStep("approving");
    // For SPL tokens, we don't need explicit approval like ERC20
    // The burn transaction will handle the token transfer authorization
    return "solana-approve-placeholder";
  };

  const burnUSDC = async (
    client: WalletClient<HttpTransport, Chain, Account>,
    sourceChainId: number,
    amount: bigint,
    destinationChainId: number,
    destinationAddress: string,
    transferType: "fast" | "standard",
  ) => {
    setCurrentStep("burning");
    addLog("Burning USDC...");

    try {
      const finalityThreshold = transferType === "fast" ? 1000 : 2000;
      const maxFee = transferType === "fast" 
        ? amount / 10n // 10% of amount as max fee
        : 0n;

      // Handle Solana destination addresses differently
      let mintRecipient: string;
      if (isSolanaChain(destinationChainId)) {
        // For Solana destinations, use the Solana token account as mintRecipient
        // Get the associated token account for the destination wallet
        const usdcMint = new PublicKey(
          CHAIN_IDS_TO_USDC_ADDRESSES[SupportedChainId.SOLANA_DEVNET] as string,
        );
        const destinationWallet = new PublicKey(destinationAddress);
        const tokenAccount = await getAssociatedTokenAddress(
          usdcMint,
          destinationWallet,
        );
        mintRecipient = hexlify(bs58.decode(tokenAccount.toBase58()));
      } else {
        // For EVM destinations, pad the hex address
        mintRecipient = `0x${destinationAddress
          .replace(/^0x/, "")
          .padStart(64, "0")}`;
      }

      const tx = await client.sendTransaction({
        to: CHAIN_IDS_TO_TOKEN_MESSENGER[sourceChainId] as `0x${string}`,
        data: encodeFunctionData({
          abi: [
            {
              type: "function",
              name: "depositForBurn",
              stateMutability: "nonpayable",
              inputs: [
                { name: "amount", type: "uint256" },
                { name: "destinationDomain", type: "uint32" },
                { name: "mintRecipient", type: "bytes32" },
                { name: "burnToken", type: "address" },
                { name: "hookData", type: "bytes32" },
                { name: "maxFee", type: "uint256" },
                { name: "finalityThreshold", type: "uint32" },
              ],
              outputs: [],
            },
          ],
          functionName: "depositForBurn",
          args: [
            amount,
            DESTINATION_DOMAINS[destinationChainId],
            mintRecipient as Hex,
            CHAIN_IDS_TO_USDC_ADDRESSES[sourceChainId] as `0x${string}`,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            maxFee,
            finalityThreshold,
          ],
        }),
        account: client.account,
      });

      addLog(`Burn Tx: ${tx}`);
      return tx;
    } catch (err) {
      setError("Burn failed");
      throw err;
    }
  };

  // Solana burn function
  const burnSolanaUSDC = async (
    keypair: Keypair,
    sourceChainId: number,
    amount: bigint,
    destinationChainId: number,
    destinationAddress: string,
    transferType: "fast" | "standard",
  ) => {
    setCurrentStep("burning");
    addLog("Burning Solana USDC...");

    try {
      const {
        getAnchorConnection,
        getPrograms,
        getDepositForBurnPdas,
        evmAddressToBytes32,
        findProgramAddress,
      } = await import("../lib/solana-utils");
      const {
        getAssociatedTokenAddress,
        createAssociatedTokenAccountInstruction,
        getAccount,
      } = await import("@solana/spl-token");

      const connection = getSolanaConnection();
      const provider = getAnchorConnection(keypair, SOLANA_RPC_ENDPOINT);
      const { messageTransmitterProgram, tokenMessengerMinterProgram } =
        getPrograms(provider);

      const usdcMint = new PublicKey(
        CHAIN_IDS_TO_USDC_ADDRESSES[SupportedChainId.SOLANA_DEVNET] as string,
      );

      const pdas = getDepositForBurnPdas(
        { messageTransmitterProgram, tokenMessengerMinterProgram },
        usdcMint,
        DESTINATION_DOMAINS[destinationChainId],
      );

      // Generate event account keypair
      const messageSentEventAccountKeypair = Keypair.generate();

      // Get user's token account
      const userTokenAccount = await getAssociatedTokenAddress(
        usdcMint,
        keypair.publicKey,
      );

      // Convert destination address based on chain type
      let mintRecipient: PublicKey;

      if (isSolanaChain(destinationChainId)) {
        // For Solana destinations, use the Solana public key directly
        mintRecipient = new PublicKey(destinationAddress);
      } else {
        // For EVM chains, ensure address is properly formatted
        const cleanAddress = destinationAddress
          .replace(/^0x/, "")
          .toLowerCase();
        if (cleanAddress.length !== 40) {
          throw new Error(
            `Invalid EVM address length: ${cleanAddress.length}, expected 40`,
          );
        }
        const formattedAddress = `0x${cleanAddress}`;
        // Convert address to bytes32 format then to PublicKey
        const bytes32Address = evmAddressToBytes32(formattedAddress);
        mintRecipient = new PublicKey(getBytes(bytes32Address));
      }

      // Get the EVM address that will call receiveMessage
      const evmAccount = privateKeyToAccount(
        `0x${import.meta.env.VITE_PUBLIC_EVM_PRIVATE_KEY}`,
      );
      const evmAddress = evmAccount.address;
      const destinationCaller = new PublicKey(
        getBytes(evmAddressToBytes32(evmAddress)),
      );

      // Call depositForBurn using Circle's exact approach
      const depositForBurnTx = await (
        tokenMessengerMinterProgram as any
      ).methods
        .depositForBurn({
          amount: new BN(amount.toString()),
          destinationDomain: DESTINATION_DOMAINS[destinationChainId],
          mintRecipient,
          maxFee: new BN((amount - 1n).toString()),
          minFinalityThreshold: transferType === "fast" ? 1000 : 2000,
          destinationCaller,
        })
        .accounts({
          owner: keypair.publicKey,
          eventRentPayer: keypair.publicKey,
          senderAuthorityPda: pdas.authorityPda,
          burnTokenAccount: userTokenAccount,
          messageTransmitter: pdas.messageTransmitterAccount,
          tokenMessenger: pdas.tokenMessengerAccount,
          remoteTokenMessenger: pdas.remoteTokenMessengerKey,
          tokenMinter: pdas.tokenMinterAccount,
          localToken: pdas.localToken,
          burnTokenMint: usdcMint,
          messageSentEventData: messageSentEventAccountKeypair.publicKey,
          messageTransmitterProgram: messageTransmitterProgram.programId,
          tokenMessengerMinterProgram: tokenMessengerMinterProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([messageSentEventAccountKeypair])
        .rpc();

      addLog(`Solana burn transaction: ${depositForBurnTx}`);
      return depositForBurnTx;
    } catch (err) {
      setError("Solana burn failed");
      addLog(
        `Solana burn error: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      throw err;
    }
  };

  const retrieveAttestation = async (
    transactionHash: string,
    sourceChainId: number,
  ) => {
    setCurrentStep("waiting-attestation");
    addLog("Retrieving attestation...");

    const domain = DESTINATION_DOMAINS[sourceChainId];
    const v2Url = `${IRIS_API_URL}/v2/messages/${domain}?transactionHash=${transactionHash}`;
    const v1Url = `${IRIS_API_URL}/messages/${domain}/${transactionHash}`;

    let lastError = null;

    for (let attempt = 0; attempt < 60; attempt++) { // up to 5 minutes
      // Try v2 endpoint
      try {
        let response = await axios.get(v2Url);
        if (response.data?.messages?.[0]?.status === "complete") {
          addLog("Attestation retrieved from v2 endpoint!");
          return response.data.messages[0];
        }
        addLog("Waiting for attestation on v2 endpoint...");
      } catch (error) {
        lastError = error;
        addLog(`v2 endpoint error: ${error instanceof Error ? error.message : error}`);
      }

      // Try v1 endpoint
      try {
        let response = await axios.get(v1Url);
        // v1 may return { attestation, message } directly, or { messages: [...] }
        if (response.data?.attestation && response.data?.message) {
          addLog("Attestation retrieved from v1 endpoint!");
          return {
            attestation: response.data.attestation,
            message: response.data.message,
            status: "complete"
          };
        }
        if (response.data?.messages?.[0]?.attestation && response.data?.messages?.[0]?.message) {
          addLog("Attestation retrieved from v1 endpoint (messages array)!");
          return {
            attestation: response.data.messages[0].attestation,
            message: response.data.messages[0].message,
            status: "complete"
          };
        }
        addLog("Waiting for attestation on v1 endpoint...");
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        setError("Attestation retrieval failed");
        addLog(
          `Attestation error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        throw error;
      }
    }
  };

  // Enhanced EVM USDC minting with comprehensive debugging
  const mintUSDC = async (
    client: WalletClient<HttpTransport, Chain, Account>,
    destinationChainId: number,
    attestation: any,
  ) => {
    const MAX_RETRIES = 3;
    let retries = 0;
    setCurrentStep("minting");
    addLog("=== EVM USDC Minting Debug ===");

    // Debug attestation data
    addLog(`Attestation Object: ${JSON.stringify(attestation, null, 2)}`);
    addLog(`Message: ${attestation.message}`);
    addLog(`Attestation: ${attestation.attestation}`);
    addLog(`Destination Chain ID: ${destinationChainId}`);
    addLog(`Message Transmitter Address: ${CHAIN_IDS_TO_MESSAGE_TRANSMITTER[destinationChainId]}`);

    // Validate attestation data
    if (!attestation.message || !attestation.attestation) {
      const error = "Invalid attestation data - missing message or attestation";
      addLog(`ERROR: ${error}`);
      setError(error);
      throw new Error(error);
    }

    if (!attestation.message.startsWith('0x') || !attestation.attestation.startsWith('0x')) {
      const error = "Invalid attestation format - must be hex strings starting with 0x";
      addLog(`ERROR: ${error}`);
      setError(error);
      throw new Error(error);
    }

    addLog(`Client Account: ${client.account.address}`);
    addLog(`Chain: ${chains[destinationChainId as keyof typeof chains]?.name}`);

    while (retries < MAX_RETRIES) {
      try {
        addLog(`Attempt ${retries + 1}/${MAX_RETRIES}`);
        
        const publicClient = createPublicClient({
          chain: chains[destinationChainId as keyof typeof chains],
          transport: http(),
        });

        // Check account balance
        const balance = await publicClient.getBalance({
          address: client.account.address,
        });
        addLog(`Account Balance: ${formatUnits(balance, 18)} ETH`);

        // Get fee data
        const feeData = await publicClient.estimateFeesPerGas();
        addLog(`Max Fee Per Gas: ${formatUnits(feeData.maxFeePerGas || 0n, 9)} Gwei`);
        addLog(`Max Priority Fee Per Gas: ${formatUnits(feeData.maxPriorityFeePerGas || 0n, 9)} Gwei`);

        const contractConfig = {
          address: CHAIN_IDS_TO_MESSAGE_TRANSMITTER[destinationChainId] as `0x${string}`,
          abi: [
            {
              type: "function",
              name: "receiveMessage",
              stateMutability: "nonpayable",
              inputs: [
                { name: "message", type: "bytes" },
                { name: "attestation", type: "bytes" },
              ],
              outputs: [],
            },
          ] as const,
        };

        // Check if message has already been processed
        try {
          const messageHash = await publicClient.readContract({
            address: contractConfig.address,
            abi: [
              {
                type: "function",
                name: "usedNonces",
                stateMutability: "view",
                inputs: [{ name: "nonce", type: "bytes32" }],
                outputs: [{ name: "", type: "uint256" }],
              },
            ],
            functionName: "usedNonces",
            args: [attestation.message.slice(0, 66) as `0x${string}`], // First 32 bytes as nonce
          });
          addLog(`Message already used: ${messageHash > 0n}`);
        } catch (nonceError) {
          addLog(`Could not check nonce status: ${nonceError instanceof Error ? nonceError.message : 'Unknown error'}`);
        }

        // Estimate gas with detailed logging
        addLog("Estimating gas...");
        const gasEstimate = await publicClient.estimateContractGas({
          ...contractConfig,
          functionName: "receiveMessage",
          args: [attestation.message, attestation.attestation],
          account: client.account.address,
        });

        // Add 20% buffer to gas estimate
        const gasWithBuffer = (gasEstimate * 120n) / 100n;
        addLog(`Gas Estimate: ${gasEstimate.toString()}`);
        addLog(`Gas with Buffer: ${gasWithBuffer.toString()}`);
        addLog(`Estimated Gas Cost: ${formatUnits(gasWithBuffer * (feeData.maxFeePerGas || 0n), 18)} ETH`);

        // Check if account has enough balance for gas
        const estimatedCost = gasWithBuffer * (feeData.maxFeePerGas || 0n);
        if (balance < estimatedCost) {
          const error = `Insufficient balance for gas. Required: ${formatUnits(estimatedCost, 18)} ETH, Available: ${formatUnits(balance, 18)} ETH`;
          addLog(`ERROR: ${error}`);
          setError(error);
          throw new Error(error);
        }

        // Send transaction
        addLog("Sending transaction...");
        const tx = await client.sendTransaction({
          to: contractConfig.address,
          data: encodeFunctionData({
            ...contractConfig,
            functionName: "receiveMessage",
            args: [attestation.message, attestation.attestation],
          }),
          gas: gasWithBuffer,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          account: client.account,
        });

        addLog(`✅ EVM Mint Transaction Hash: ${tx}`);
        addLog(`Explorer: ${chains[destinationChainId as keyof typeof chains]?.blockExplorers?.default?.url}/tx/${tx}`);
        
        // Wait for transaction receipt
        addLog("Waiting for transaction confirmation...");
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: tx,
          timeout: 60000, // 60 seconds
        });
        
        addLog(`Transaction Status: ${receipt.status}`);
        addLog(`Gas Used: ${receipt.gasUsed.toString()}`);
        addLog(`Block Number: ${receipt.blockNumber.toString()}`);

        if (receipt.status === 'success') {
          addLog("✅ EVM USDC Minting Completed Successfully!");
          setCurrentStep("completed");
          break;
        } else {
          throw new Error("Transaction failed");
        }

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        addLog(`❌ EVM Mint Error (Attempt ${retries + 1}): ${errorMessage}`);
        
        if (err instanceof TransactionExecutionError) {
          addLog(`Transaction Execution Error Details: ${JSON.stringify((err as any).details, null, 2)}`);
          addLog(`Error Name: ${err.name}`);
          addLog(`Error Cause: ${JSON.stringify(err.cause, null, 2)}`);
        }

        if (retries < MAX_RETRIES - 1) {
          retries++;
          const delay = 2000 * retries;
          addLog(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        
        setError(`EVM Mint failed after ${MAX_RETRIES} attempts: ${errorMessage}`);
        setCurrentStep("error");
        throw err;
      }
    }
  };

  // Enhanced Solana USDC minting with comprehensive debugging
  const mintSolanaUSDC = async (
    keypair: Keypair,
    destinationChainId: number,
    attestation: any,
  ) => {
    setCurrentStep("minting");
    addLog("=== Solana USDC Minting Debug ===");
    addLog(`Buffer available in mintSolanaUSDC: ${typeof Buffer !== 'undefined'}`);

    // Debug attestation data
    addLog(`Attestation Object: ${JSON.stringify(attestation, null, 2)}`);
    addLog(`Message: ${attestation.message}`);
    addLog(`Attestation: ${attestation.attestation}`);
    addLog(`Destination Chain ID: ${destinationChainId}`);
    addLog(`Keypair Public Key: ${keypair.publicKey.toString()}`);

    // Validate attestation data
    if (!attestation.message || !attestation.attestation) {
      const error = "Invalid attestation data - missing message or attestation";
      addLog(`ERROR: ${error}`);
      setError(error);
      throw new Error(error);
    }

    try {
      const {
        getAnchorConnection,
        getPrograms,
        getReceiveMessagePdas,
        decodeNonceFromMessage,
        evmAddressToBytes32,
      } = await import("../lib/solana-utils");
      
      const connection = getSolanaConnection();
      addLog(`Solana RPC Endpoint: ${SOLANA_RPC_ENDPOINT}`);

      // Check SOL balance
      const solBalance = await connection.getBalance(keypair.publicKey);
      addLog(`SOL Balance: ${solBalance / LAMPORTS_PER_SOL} SOL`);
      
      if (solBalance < 0.01 * LAMPORTS_PER_SOL) {
        const error = `Insufficient SOL balance. Required: 0.01 SOL, Available: ${solBalance / LAMPORTS_PER_SOL} SOL`;
        addLog(`ERROR: ${error}`);
        setError(error);
        throw new Error(error);
      }

      const provider = getAnchorConnection(keypair, SOLANA_RPC_ENDPOINT);
      const { messageTransmitterProgram, tokenMessengerMinterProgram } = getPrograms(provider);
      
      addLog(`Message Transmitter Program: ${messageTransmitterProgram.programId.toString()}`);
      addLog(`Token Messenger Minter Program: ${tokenMessengerMinterProgram.programId.toString()}`);

      const usdcMint = new PublicKey(
        CHAIN_IDS_TO_USDC_ADDRESSES[SupportedChainId.SOLANA_DEVNET] as string,
      );
      addLog(`USDC Mint: ${usdcMint.toString()}`);

      const messageHex = attestation.message;
      const attestationHex = attestation.attestation;

      // Validate hex format
      if (!messageHex.startsWith('0x') || !attestationHex.startsWith('0x')) {
        const error = "Invalid hex format - must start with 0x";
        addLog(`ERROR: ${error}`);
        setError(error);
        throw new Error(error);
      }

      // Extract the nonce and source domain from the message
      addLog("Decoding message...");
      addLog(`Passing Buffer to decodeNonceFromMessage: ${typeof Buffer !== 'undefined'}`);
      const nonce = decodeNonceFromMessage(messageHex, Buffer);
      addLog(`Expected nonce: ${attestation.eventNonce.replace("0x", "")}`);
      addLog(`Extracted nonce: ${nonce.toString('hex')}`);
      const decodedMessageBuffer = Buffer.from(messageHex.replace("0x", ""), "hex");
      const sourceDomain = decodedMessageBuffer.readUInt32BE(4);
      
      addLog(`Nonce: ${nonce.toString('hex')}`);
      addLog(`Source Domain: ${sourceDomain}`);
      addLog(`Message Buffer Length: ${decodedMessageBuffer.length}`);

      // Find the source chain USDC address
      let remoteTokenAddressHex = "";
      let sourceChainName = "";
      
      for (const [chainId, usdcAddress] of Object.entries(CHAIN_IDS_TO_USDC_ADDRESSES)) {
        if (DESTINATION_DOMAINS[parseInt(chainId)] === sourceDomain && !isSolanaChain(parseInt(chainId))) {
          remoteTokenAddressHex = evmAddressToBytes32(usdcAddress as string);
          sourceChainName = CHAIN_TO_CHAIN_NAME[parseInt(chainId)] || `Chain ${chainId}`;
          addLog(`Found source chain: ${sourceChainName} (${chainId})`);
          addLog(`Remote Token Address: ${usdcAddress}`);
          addLog(`Remote Token Address Hex: ${remoteTokenAddressHex}`);
          break;
        }
      }

      if (!remoteTokenAddressHex) {
        const error = `Could not find source chain USDC address for domain ${sourceDomain}`;
        addLog(`ERROR: ${error}`);
        setError(error);
        throw new Error(error);
      }

      // Get PDAs for receive message
      addLog("Getting PDAs...");
      const pdas = await getReceiveMessagePdas(
        { messageTransmitterProgram, tokenMessengerMinterProgram },
        usdcMint,
        remoteTokenAddressHex,
        sourceDomain.toString(),
        nonce,
        Buffer
      );

      addLog(`Authority PDA: ${pdas.authorityPda.toString()}`);
      addLog(`Message Transmitter Account: ${pdas.messageTransmitterAccount.toString()}`);
      addLog(`Used Nonce: ${pdas.usedNonce.toString()}`);

      // Get user's token account
      const userTokenAccount = await getAssociatedTokenAddress(
        usdcMint,
        keypair.publicKey,
      );
      addLog(`User Token Account: ${userTokenAccount.toString()}`);

      // Check if user token account exists
      try {
        const tokenAccountInfo = await getAccount(connection, userTokenAccount);
        addLog(`Token Account Balance: ${Number(tokenAccountInfo.amount) / Math.pow(10, DEFAULT_DECIMALS)} USDC`);
      } catch (error) {
        if (error instanceof TokenAccountNotFoundError) {
          addLog("Token account not found - will be created during minting");
        } else {
          addLog(`Token account check error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Build account metas array for remaining accounts
      const accountMetas = [
        {
          isSigner: false,
          isWritable: false,
          pubkey: pdas.tokenMessengerAccount,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: pdas.remoteTokenMessengerKey,
        },
        {
          isSigner: false,
          isWritable: true,
          pubkey: pdas.tokenMinterAccount,
        },
        {
          isSigner: false,
          isWritable: true,
          pubkey: pdas.localToken,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: pdas.tokenPair,
        },
        {
          isSigner: false,
          isWritable: true,
          pubkey: pdas.feeRecipientTokenAccount,
        },
        { isSigner: false, isWritable: true, pubkey: userTokenAccount },
        {
          isSigner: false,
          isWritable: true,
          pubkey: pdas.custodyTokenAccount,
        },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
        {
          isSigner: false,
          isWritable: false,
          pubkey: pdas.tokenMessengerEventAuthority,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: tokenMessengerMinterProgram.programId,
        },
      ];

      addLog(`Account Metas Count: ${accountMetas.length}`);
      accountMetas.forEach((meta, index) => {
        addLog(`Account ${index}: ${meta.pubkey.toString()} (signer: ${meta.isSigner}, writable: ${meta.isWritable})`);
      });

      // Prepare message and attestation buffers
      const finalMessageBuffer = Buffer.from(messageHex.replace("0x", ""), "hex");
      const attestationBuffer = Buffer.from(attestationHex.replace("0x", ""), "hex");
      
      addLog(`Message Buffer Length: ${finalMessageBuffer.length}`);
      addLog(`Attestation Buffer Length: ${attestationBuffer.length}`);

      // Call receiveMessage using Circle's official structure
      addLog("Calling receiveMessage...");
      const receiveMessageTx = await (messageTransmitterProgram as any).methods
        .receiveMessage({
          message: finalMessageBuffer,
          attestation: attestationBuffer,
        })
        .accounts({
          payer: keypair.publicKey,
          caller: keypair.publicKey,
          authorityPda: pdas.authorityPda,
          messageTransmitter: pdas.messageTransmitterAccount,
          usedNonce: pdas.usedNonce,
          receiver: tokenMessengerMinterProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(accountMetas)
        .signers([keypair])
        .rpc();

      addLog(`✅ Solana Mint Transaction Hash: ${receiveMessageTx}`);
      addLog(`Explorer: https://explorer.solana.com/tx/${receiveMessageTx}?cluster=devnet`);
      
      // Wait for confirmation
      addLog("Waiting for transaction confirmation...");
      const confirmation = await connection.confirmTransaction(receiveMessageTx, 'confirmed');
      
      if (confirmation.value.err) {
        const error = `Transaction failed: ${JSON.stringify(confirmation.value.err)}`;
        addLog(`ERROR: ${error}`);
        setError(error);
        throw new Error(error);
      }

      // Check final token balance
      try {
        const finalTokenAccount = await getAccount(connection, userTokenAccount);
        const finalBalance = Number(finalTokenAccount.amount) / Math.pow(10, DEFAULT_DECIMALS);
        addLog(`✅ Final USDC Balance: ${finalBalance} USDC`);
      } catch (error) {
        addLog(`Could not check final balance: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      addLog("✅ Solana USDC Minting Completed Successfully!");
      setCurrentStep("completed");
      return receiveMessageTx;
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
      addLog(`❌ Solana Mint Error: ${errorMessage}`);
      
      if (err instanceof Error && err.stack) {
        addLog(`Stack Trace: ${err.stack}`);
      }
      
      // Log additional error details if available
      if (typeof err === 'object' && err !== null) {
        addLog(`Error Details: ${JSON.stringify(err, null, 2)}`);
      }
      
      setError(`Solana mint failed: ${errorMessage}`);
      setCurrentStep("error");
      throw err;
    }
  };

  const executeTransfer = async (
    sourceChainId: number,
    destinationChainId: number,
    amount: string,
    transferType: "fast" | "standard",
  ) => {
    try {
      const numericAmount = parseUnits(amount, DEFAULT_DECIMALS);

      // Handle different chain types
      const isSourceSolana = isSolanaChain(sourceChainId);
      const isDestinationSolana = isSolanaChain(destinationChainId);

      let sourceClient: any, destinationClient: any, defaultDestination: string;

      // Get source client
      sourceClient = getClients(sourceChainId);

      // Get destination client
      destinationClient = getClients(destinationChainId);

      // For cross-chain transfers, destination address should be derived from destination chain's private key
      if (isDestinationSolana) {
        // Destination is Solana, so get Solana public key
        const destinationPrivateKey = getPrivateKeyForChain(destinationChainId);
        const destinationKeypair = getSolanaKeypair(destinationPrivateKey);
        defaultDestination = destinationKeypair.publicKey.toString();
      } else {
        // Destination is EVM, so get EVM address
        const destinationPrivateKey = getPrivateKeyForChain(destinationChainId);
        const account = privateKeyToAccount(
          `0x${destinationPrivateKey.replace(/^0x/, "")}`,
        );
        defaultDestination = account.address;
      }

      // Check native balance for destination chain
      const checkNativeBalance = async (chainId: SupportedChainId) => {
        if (isSolanaChain(chainId)) {
          const connection = getSolanaConnection();
          const privateKey = getPrivateKeyForChain(chainId);
          const keypair = getSolanaKeypair(privateKey);
          const balance = await connection.getBalance(keypair.publicKey);
          return BigInt(balance);
        } else {
          const publicClient = createPublicClient({
            chain: chains[chainId as keyof typeof chains],
            transport: http(),
          });
          const privateKey = getPrivateKeyForChain(chainId);
          const account = privateKeyToAccount(
            `0x${privateKey.replace(/^0x/, "")}`,
          );
          const balance = await publicClient.getBalance({
            address: account.address,
          });
          return balance;
        }
      };

      // Execute approve step
      if (isSourceSolana) {
        await approveSolanaUSDC(sourceClient, sourceChainId);
      } else {
        await approveUSDC(sourceClient, sourceChainId);
      }

      // Execute burn step
      let burnTx: string;
      if (isSourceSolana) {
        burnTx = await burnSolanaUSDC(
          sourceClient,
          sourceChainId,
          numericAmount,
          destinationChainId,
          defaultDestination,
          transferType,
        );
      } else {
        burnTx = await burnUSDC(
          sourceClient,
          sourceChainId,
          numericAmount,
          destinationChainId,
          defaultDestination,
          transferType,
        );
      }

      // Retrieve attestation
      const attestation = await retrieveAttestation(burnTx, sourceChainId);

      // Check destination chain balance
      const minBalance = isSolanaChain(destinationChainId)
        ? BigInt(0.01 * LAMPORTS_PER_SOL) // 0.01 SOL
        : parseEther("0.01"); // 0.01 native token

      const balance = await checkNativeBalance(destinationChainId);
      if (balance < minBalance) {
        throw new Error("Insufficient native token for gas fees");
      }

      // Execute mint step
      if (isDestinationSolana) {
        await mintSolanaUSDC(
          destinationClient,
          destinationChainId,
          attestation,
        );
      } else {
        await mintUSDC(destinationClient, destinationChainId, attestation);
      }
    } catch (error) {
      setCurrentStep("error");
      addLog(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  const reset = () => {
    setCurrentStep("idle");
    setLogs([]);
    setError(null);
  };

  return {
    currentStep,
    logs,
    error,
    executeTransfer,
    getBalance,
    reset,
  };
}