import { arbitrum, arbitrumSepolia, base, baseSepolia } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";

export const monadTestnet = {
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: {
        name: "MON",
        symbol: "MON",
        decimals: 18,
    },
    rpcUrls: {
        default: {
            http: ["https://testnet-rpc.monad.xyz"],
        },
    },
    blockExplorers: {
        default: {
            name: "Monad Explorer",
            url: "https://testnet.monadexplorer.com",
        },
    },
    testnet: true,
} as const satisfies AppKitNetwork;

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
    arbitrum,
    arbitrumSepolia,
    base,
    baseSepolia,
    monadTestnet,
];

export { arbitrum, arbitrumSepolia, base, baseSepolia };