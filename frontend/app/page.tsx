"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";

export default function Home() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold mb-8">template-evm</h1>
      <button
        onClick={() => open()}
        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
      >
        {isConnected ? `${address?.slice(0, 6)}...${address?.slice(-4)}` : "Connect Wallet"}
      </button>
    </main>
  );
}