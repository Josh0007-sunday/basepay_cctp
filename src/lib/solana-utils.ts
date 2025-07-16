import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Provider } from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { Transaction, type VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Buffer } from "buffer";

// Import IDL files for CCTP programs
import MessageTransmitterIDL from "../solana/idl/message_transmitter.json";
import TokenMessengerMinterIDL from "../solana/idl/token_messenger.json";
import type { Idl } from "@coral-xyz/anchor";

export const hexToBytes = (hex: string, Buffer: typeof global.Buffer) => {
  console.log("Buffer available in hexToBytes:", typeof Buffer !== 'undefined');
  return Buffer.from(hex.replace("0x", ""), "hex");
};

export const evmAddressToBytes32 = (address: string): string => {
  return `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
};

export const findProgramAddress = (
  seeds: Buffer[],
  programId: PublicKey,
): { publicKey: PublicKey; bump: number } => {
  const [publicKey, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { publicKey, bump };
};

export const getPrograms = (provider: AnchorProvider) => {
  const messageTransmitterProgram = new Program(
    MessageTransmitterIDL as Idl,
        new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"),
    provider
  );
  const tokenMessengerMinterProgram = new Program(
    TokenMessengerMinterIDL as Idl,
    new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"),
    provider
  );
  return { messageTransmitterProgram, tokenMessengerMinterProgram };
};

export const getDepositForBurnPdas = (
  { messageTransmitterProgram, tokenMessengerMinterProgram }: ReturnType<typeof getPrograms>,
  burnTokenMint: PublicKey,
  destinationDomain: number,
) => {
  const authorityPda = findProgramAddress(
    [
      Buffer.from("message_transmitter_authority"),
      tokenMessengerMinterProgram.programId.toBuffer(),
    ],
    messageTransmitterProgram.programId,
  ).publicKey;

  const messageTransmitterAccount = findProgramAddress(
    [Buffer.from("message_transmitter")],
    messageTransmitterProgram.programId,
  ).publicKey;

  const tokenMessengerAccount = findProgramAddress(
    [Buffer.from("token_messenger")],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const remoteTokenMessengerKey = findProgramAddress(
    [
      Buffer.from("remote_token_messenger"),
      Buffer.from(destinationDomain.toString(), "utf-8"),
    ],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const tokenMinterAccount = findProgramAddress(
    [Buffer.from("token_minter")],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const localToken = findProgramAddress(
    [Buffer.from("local_token"), burnTokenMint.toBuffer()],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  return {
    authorityPda,
    messageTransmitterAccount,
    tokenMessengerAccount,
    remoteTokenMessengerKey,
    tokenMinterAccount,
    localToken,
  };
};

export const getReceiveMessagePdas = async (
  {
    messageTransmitterProgram,
    tokenMessengerMinterProgram,
  }: ReturnType<typeof getPrograms>,
  solUsdcAddress: PublicKey,
  remoteUsdcAddressHex: string,
  remoteDomain: string,
  nonce: Buffer,
  Buffer: typeof global.Buffer
) => {
  const authorityPda = findProgramAddress(
    [
      Buffer.from("message_transmitter_authority"),
      tokenMessengerMinterProgram.programId.toBuffer(),
    ],
    messageTransmitterProgram.programId,
  ).publicKey;

  const messageTransmitterAccount = findProgramAddress(
    [Buffer.from("message_transmitter")],
    messageTransmitterProgram.programId,
  ).publicKey;

  const usedNonce = findProgramAddress(
    [
      Buffer.from("used_nonce"),
      nonce,
      Buffer.from(remoteDomain, "utf-8"),
    ],
    messageTransmitterProgram.programId,
  ).publicKey;

  const tokenMessengerAccount = findProgramAddress(
    [Buffer.from("token_messenger")],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const remoteTokenMessengerKey = findProgramAddress(
    [
      Buffer.from("remote_token_messenger"),
      Buffer.from(remoteDomain, "utf-8"),
    ],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const tokenMinterAccount = findProgramAddress(
    [Buffer.from("token_minter")],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const localToken = findProgramAddress(
    [Buffer.from("local_token"), solUsdcAddress.toBuffer()],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const remoteTokenKey = new PublicKey(hexToBytes(remoteUsdcAddressHex, Buffer));

  const tokenPair = findProgramAddress(
    [
      Buffer.from("token_pair"),
      Buffer.from(remoteDomain, "utf-8"),
      remoteTokenKey.toBuffer(),
    ],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  const custodyTokenAccount = await getAssociatedTokenAddress(
    solUsdcAddress,
    tokenMessengerMinterProgram.programId,
    true,
  );

  const feeRecipient = new PublicKey(
    "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  );

  const feeRecipientTokenAccount = await getAssociatedTokenAddress(
    solUsdcAddress,
    feeRecipient,
    true,
  );

  const tokenMessengerEventAuthority = findProgramAddress(
    [Buffer.from("__event_authority")],
    tokenMessengerMinterProgram.programId,
  ).publicKey;

  return {
    authorityPda,
    messageTransmitterAccount,
    usedNonce,
    tokenMessengerAccount,
    remoteTokenMessengerKey,
    tokenMinterAccount,
    localToken,
    remoteTokenKey,
    tokenPair,
    custodyTokenAccount,
    feeRecipient,
    feeRecipientTokenAccount,
    tokenMessengerEventAuthority,
  };
};

export const decodeNonceFromMessage = (messageHex: string, Buffer: typeof global.Buffer): Buffer => {
  try {
    if (!messageHex || typeof messageHex !== 'string') {
      throw new Error("Invalid message format: messageHex is undefined or not a string");
    }
    console.log("Decoding messageHex:", messageHex);
    console.log("Buffer available in decodeNonceFromMessage:", typeof Buffer !== 'undefined');
    const messageBytes = hexToBytes(messageHex, Buffer);
    if (messageBytes.length < 44) {
      throw new Error(`Message too short (${messageBytes.length} bytes), need at least 44 bytes`);
    }
    const nonceBytes = messageBytes.subarray(12, 44); // Extract 32 bytes for nonce
    console.log("Extracted nonce bytes:", nonceBytes.toString('hex'));
    return nonceBytes;
  } catch (error) {
    console.error("Failed to decode nonce from message:", messageHex);
    throw new Error(`Failed to decode nonce: ${error instanceof Error ? error.message : error}`);
  }
};

export const getAnchorConnection = (
  keypair: Keypair,
  solanaRpcEndpoint: string,
): AnchorProvider => {
  const connection = new Connection(solanaRpcEndpoint, "confirmed");
  return new AnchorProvider(
    connection,
    {
      publicKey: keypair.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        if (tx instanceof Transaction) {
          tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          tx.sign(keypair);
          return tx as T;
        }
        throw new Error("VersionedTransaction not supported in this wallet implementation.");
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
        const blockhash = (await connection.getLatestBlockhash()).blockhash;
        for (const tx of txs) {
          if (tx instanceof Transaction) {
            tx.recentBlockhash = blockhash;
            tx.sign(keypair);
          } else {
            throw new Error("VersionedTransaction not supported in this wallet implementation.");
          }
        }
        return txs;
      },
    },
    { commitment: "confirmed" },
  );
};